// Targeted HTML editing: apply a model's find/replace edits instead of asking
// it to rewrite the whole document.
//
// WHY. The repair loop currently says "keep everything that already works and
// return the COMPLETE HTML document again" at temperature 0.5. That instruction
// is unenforceable, and it is how a page scored 82, went through a repair for
// three cosmetic nits, and came back at 72. Everything the model did not
// consciously preserve drifted, and nothing could tell that it had.
//
// A patch cannot do that. It changes only what it names, so untouched content is
// preserved *by construction* rather than by request — and what changed is
// visible, which means a repair can finally be reviewed instead of trusted.
//
// The design follows what code-assist tools learned the hard way:
//
//   - No line numbers. Models get them wrong constantly, and a wrong line number
//     silently edits the wrong place. Anchors are content, always.
//   - Whitespace is the number one cause of a failed match, so matching walks a
//     ladder from exact to whitespace-insensitive — but a replacement is always
//     spliced into the ORIGINAL bytes, so nothing outside the match is reformatted.
//   - A match must be unique. Two candidates is an error, never a coin flip:
//     picking one at random edits the wrong nav link half the time.
//   - Elision ("...", "rest unchanged") must be rejected, not applied. A model
//     abbreviating the middle of a section would otherwise delete it.
//   - Failure must be specific enough to retry on. "No match" teaches nothing;
//     "found 3 times, add surrounding context" gets a usable second attempt.

const ELISION_PATTERNS = [
  /^\s*(?:\/\/|<!--)?\s*\.\.\.\s*(?:-->)?\s*$/m,
  /\.\.\.\s*(?:rest|remainder|unchanged|existing|previous|other)\b/i,
  /\b(?:rest|remainder) of (?:the )?(?:file|document|page|code|content|html)\b[^\n]*unchanged/i,
  /<!--\s*(?:\.\.\.|snip|truncated|unchanged|no changes)[^>]*-->/i,
  /\[\s*(?:\.\.\.|snip|truncated|unchanged)\s*\]/i
];

export class PatchError extends Error {
  constructor(message, { code, edit } = {}) {
    super(message);
    this.name = "PatchError";
    if (code) this.code = code;
    if (edit) this.edit = edit;
  }
}

/**
 * Builds a normalized view of `text` plus a map from each normalized character
 * index back to its index in the original.
 *
 * The map is the whole point: we match loosely but splice precisely, so a
 * whitespace-insensitive match still replaces exactly the original bytes it
 * covered and leaves every other byte untouched.
 */
function normalizedView(text, level) {
  if (level === 0) return { text, map: null };

  let out = "";
  const map = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (level >= 1 && /[ \t]/.test(char)) {
      // Trailing whitespace: everything from here to the newline is blank.
      let lookahead = index;
      while (lookahead < text.length && /[ \t]/.test(text[lookahead])) lookahead += 1;
      if (lookahead >= text.length || text[lookahead] === "\n" || text[lookahead] === "\r") {
        index = lookahead;
        continue;
      }
    }

    if (level >= 2 && /\s/.test(char)) {
      // Collapse any run of whitespace to a single space, anchored at the run's
      // first character so the map points somewhere meaningful.
      let lookahead = index;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      out += " ";
      map.push(index);
      index = lookahead;
      continue;
    }

    out += char;
    map.push(index);
    index += 1;
  }

  return { text: out, map };
}

// Where a normalized match [start, end) lands in the original text.
function originalSpan(view, start, length) {
  if (!view.map) return { start, end: start + length };
  const from = view.map[start];
  const lastIndex = start + length - 1;
  const lastOriginal = view.map[lastIndex];
  // Include the full run the final normalized character stood for.
  let to = lastOriginal + 1;
  if (lastIndex + 1 < view.map.length) to = view.map[lastIndex + 1];
  return { start: from, end: to };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + 1; // overlapping counts, so "aa" in "aaa" reports 2 and is ambiguous
  }
}

export function looksElided(value) {
  const text = String(value ?? "");
  return ELISION_PATTERNS.some((pattern) => pattern.test(text));
}

const MATCH_LEVELS = [
  { level: 0, how: "exact" },
  { level: 1, how: "ignoring trailing whitespace" },
  { level: 2, how: "ignoring all whitespace differences" }
];

/**
 * Locates `find` in `html`, walking from strict to lenient.
 *
 * @returns {{ start, end, how } | { error, code, occurrences }}
 */
export function locate(html, find) {
  if (typeof find !== "string" || !find.length) {
    return { error: "The text to find is empty.", code: "empty_find" };
  }

  for (const { level, how } of MATCH_LEVELS) {
    const haystack = normalizedView(html, level);
    const needleView = normalizedView(find, level);
    const needle = needleView.text.trim().length ? needleView.text : find;
    const occurrences = countOccurrences(haystack.text, needle);

    if (occurrences === 1) {
      const at = haystack.text.indexOf(needle);
      const span = originalSpan(haystack, at, needle.length);
      return { start: span.start, end: span.end, how };
    }
    if (occurrences > 1) {
      // Ambiguity is fatal and worth saying loudly: this is the failure that
      // silently edits the wrong one of five identical nav links.
      return {
        error: `Found ${occurrences} places matching that text (${how}). Include more surrounding context so it identifies exactly one.`,
        code: "ambiguous",
        occurrences
      };
    }
  }

  return {
    error: "Could not find that text in the page. Copy it exactly as it appears, including tags and attributes.",
    code: "not_found",
    occurrences: 0
  };
}

/**
 * Applies edits in order, each against the document produced by the previous.
 *
 * Never throws for a bad edit: returns what applied and what didn't, with a
 * message specific enough to hand straight back to the model for a retry.
 *
 * @param {string} html
 * @param {{find: string, replace: string}[]} edits
 * @param {object} [options]
 * @param {number} [options.maxShrinkRatio=0.35] reject edits that delete more
 *   than this fraction of the document in total
 * @returns {{ html, applied, failed, changed, bytesBefore, bytesAfter }}
 */
export function applyEdits(html, edits, { maxShrinkRatio = 0.35 } = {}) {
  const before = String(html ?? "");
  let current = before;
  const applied = [];
  const failed = [];

  for (const [index, edit] of (edits || []).entries()) {
    const find = typeof edit?.find === "string" ? edit.find : "";
    const replace = typeof edit?.replace === "string" ? edit.replace : "";

    // An elided anchor would match the wrong span; an elided replacement would
    // delete real content and look deliberate.
    if (looksElided(find) || looksElided(replace)) {
      failed.push({ index, find, reason: "Edits must contain the literal text, never '...' or 'unchanged'.", code: "elided" });
      continue;
    }
    if (find === replace) {
      failed.push({ index, find, reason: "The replacement is identical to the text it replaces.", code: "no_op" });
      continue;
    }

    const hit = locate(current, find);
    if (hit.error) {
      failed.push({ index, find, reason: hit.error, code: hit.code });
      continue;
    }

    current = current.slice(0, hit.start) + replace + current.slice(hit.end);
    applied.push({
      index,
      how: hit.how,
      removed: hit.end - hit.start,
      added: replace.length,
      preview: find.replace(/\s+/g, " ").trim().slice(0, 80)
    });
  }

  // A patch that deletes a third of the page is not a patch. This is the
  // backstop against a model "fixing" a section by removing it.
  if (before.length && (before.length - current.length) / before.length > maxShrinkRatio) {
    return {
      html: before,
      applied: [],
      changed: false,
      bytesBefore: before.length,
      bytesAfter: before.length,
      failed: [
        ...failed,
        {
          index: -1,
          reason: `Applying these edits would remove ${Math.round(((before.length - current.length) / before.length) * 100)}% of the page. Rejected as a whole.`,
          code: "excessive_deletion"
        }
      ]
    };
  }

  return {
    html: current,
    applied,
    failed,
    changed: current !== before,
    bytesBefore: before.length,
    bytesAfter: current.length
  };
}

/**
 * Reads edits out of a model reply. Accepts the JSON envelope this codebase
 * already uses, and the SEARCH/REPLACE fenced form, because models reach for
 * that shape unprompted and rejecting it wastes a whole call.
 */
export function parseEdits(reply) {
  const text = String(reply ?? "");
  const edits = [];

  const normalize = (item) => {
    if (!item || typeof item !== "object") return null;
    // Different coding models use different, equally unambiguous names for
    // this tiny protocol. Accept the common shapes here and keep the safety in
    // applyEdits (unique match, no elision, deletion guard), instead of paying
    // for a whole-document rewrite because a model wrote `search` rather than
    // `find`.
    const find = item.find ?? item.search ?? item.old ?? item.before ?? item.original;
    const replace = item.replace ?? item.replacement ?? item.new ?? item.after ?? item.updated;
    return typeof find === "string" && typeof replace === "string" ? { find, replace } : null;
  };

  const jsonMatch = text.match(/(?:\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const list = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.edits) ? parsed.edits
          : Array.isArray(parsed?.changes) ? parsed.changes
            : [];
      for (const item of list) {
        const edit = normalize(item);
        if (edit) edits.push(edit);
      }
      if (edits.length) return edits;
    } catch {
      // fall through to the fenced form
    }
  }

  // <<<<<<< SEARCH … ======= … >>>>>>> REPLACE
  const blocks = text.matchAll(
    /<{3,}\s*SEARCH\s*\n([\s\S]*?)\n={3,}\s*\n([\s\S]*?)\n>{3,}\s*REPLACE/gi
  );
  for (const block of blocks) edits.push({ find: block[1], replace: block[2] });
  return edits;
}

/**
 * A human-readable account of what a patch did, for the build log and the
 * customer's report. A repair nobody can see is a repair nobody can review.
 */
export function describeResult(result) {
  const lines = [];
  for (const item of result.applied) {
    const delta = item.added - item.removed;
    const sign = delta > 0 ? `+${delta}` : String(delta);
    lines.push(`  applied (${item.how}, ${sign} chars): ${item.preview}`);
  }
  for (const item of result.failed) {
    lines.push(`  FAILED [${item.code}]: ${item.reason}`);
  }
  return lines.join("\n");
}

// The instruction block for the model. Kept here beside the parser so the format
// we ask for and the format we accept cannot drift apart.
export const PATCH_INSTRUCTIONS = `Return ONLY a JSON object of targeted edits:

{"edits":[{"find":"<exact text from the page>","replace":"<what it becomes>"}]}

Rules, each of which will cause the edit to be rejected if broken:
- "find" must be copied EXACTLY from the page, character for character, including
  tags, attributes and quotes. Do not retype it from memory.
- "find" must appear exactly ONCE in the page. If the text you want appears more
  than once, include more surrounding markup until it is unique.
- Never write "...", "rest unchanged", or any abbreviation inside find or replace.
  Write the literal text.
- Change only what is needed to fix the issues listed. Do not restyle, reorder or
  rewrite anything you were not asked about.
- Prefer several small edits over one large one.
- Do not return the whole document.`;
