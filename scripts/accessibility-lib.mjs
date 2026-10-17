// Accessibility scanning and remediation, shared by the pre-deploy repair loop
// (remediate-accessibility.mjs) and the post-deploy gate (verify-site-build.mjs).
//
// Why this is a hard gate rather than advice: every customer here is a
// nonprofit. Many take federal funding, which pulls them under Section 508, and
// ADA Title III web claims target exactly the small orgs that can least afford
// to defend one. Shipping an inaccessible site is a liability we'd be creating
// for them. Until now accessibility was only a line in the generator prompt and
// a soft judge criterion — nothing measured it and nothing enforced it.
//
// The bar is WCAG 2.1 AA: the level cited in ADA settlements, Section 508, and
// most state and foundation grant conditions.

import { createRequire } from "node:module";
import { applyEdits, parseEdits, PATCH_INSTRUCTIONS } from "./html-patch-lib.mjs";

const require = createRequire(import.meta.url);

// axe rule tags for WCAG 2.1 AA. Level A is included because AA is cumulative:
// an A failure is also an AA failure.
export const WCAG_21_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// WCAG conformance is pass/fail per success criterion; axe impact is useful for
// triage, but it is not permission to ship a known failure. Every violation
// returned by the WCAG A/AA rules blocks publication, including moderate/minor.
export const BLOCKING_IMPACTS = new Set(["critical", "serious", "moderate", "minor", null]);

export const ACCESSIBILITY_VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 }
];

export function axeScriptPath() {
  return require.resolve("axe-core/axe.min.js");
}

// Runs axe against an already-loaded Playwright page. Kept dependency-free of
// @axe-core/playwright so the same code works in both scripts.
// scriptPath is injectable so this can be unit-tested without axe-core on disk;
// resolution stays lazy so merely importing this module never requires it.
export async function scanPage(page, { tags = WCAG_21_AA_TAGS, scriptPath } = {}) {
  await page.addScriptTag({ path: scriptPath || axeScriptPath() });
  return page.evaluate(
    async (runTags) => {
      // Contrast is judged at rest: a card still fading in measures a blend that no rule can be repaired against.
      for (const animation of document.getAnimations?.() || []) {
        try { if (Number.isFinite(animation.effect?.getComputedTiming?.().endTime)) animation.finish(); } catch { /* keeps running */ }
      }
      const result = await window.axe.run(document, {
        runOnly: { type: "tag", values: runTags },
        resultTypes: ["violations"]
      });
      // axe's shortest unique selector can be a bare element or one class; anchor it to the nearest identified ancestor.
      const scoped = (target) => {
        if (/#/.test(target) || (/[.[]/.test(target) && /[\s>+~]/.test(target))) return "";
        try {
          const anchor = document.querySelector(target)?.parentElement?.closest("[id],[data-ww-block]");
          if (!anchor) return "";
          const block = anchor.getAttribute("data-ww-block");
          return `${block ? `[data-ww-block="${CSS.escape(block)}"]` : `#${CSS.escape(anchor.id)}`} ${target}`;
        } catch {
          return "";
        }
      };
      // A migrated inline colour is set once on a generated class and inherited by every descendant;
      // fixing that class fixes them all, where a rule per descendant would take a round per structure.
      const GENERATED = /^ww-source-inline-[0-9a-f]{8,}$/;
      const colourHolder = (target) => {
        try {
          let node = document.querySelector(target);
          if (!node) return null;
          const colour = getComputedStyle(node).color;
          while (node.parentElement && getComputedStyle(node.parentElement).color === colour) node = node.parentElement;
          return node;
        } catch {
          return null;
        }
      };
      // Every element that holds the colour a failing node inherits. The generated class is also carried by all
      // text that had the same inline style, on other pages and over photos axe cannot measure, so a rule on it
      // is only offered where each carrier in its place is one of these.
      let failingHolders = null;
      const holdersOfFailures = () => {
        if (failingHolders) return failingHolders;
        failingHolders = new Set();
        for (const violation of judged) {
          if (violation.id !== "color-contrast") continue;
          for (const node of violation.nodes) {
            const holder = colourHolder(Array.isArray(node.target) ? node.target.join(" ") : String(node.target || ""));
            if (holder) failingHolders.add(holder);
          }
        }
        return failingHolders;
      };
      const colourSource = (target) => {
        try {
          const holder = colourHolder(target);
          const generated = holder && [...holder.classList].find((name) => GENERATED.test(name));
          if (!generated) return { selector: "", shared: false };
          const anchor = holder.closest("[id],[data-ww-block]");
          if (!anchor) return { selector: "", shared: true };
          const carriers = [...anchor.querySelectorAll(`.${CSS.escape(generated)}`), ...(anchor.classList.contains(generated) ? [anchor] : [])];
          const measured = holdersOfFailures();
          if (carriers.some((carrier) => !measured.has(carrier))) return { selector: "", shared: true };
          const block = anchor.getAttribute("data-ww-block");
          const place = block ? `[data-ww-block="${CSS.escape(block)}"]` : `#${CSS.escape(anchor.id)}`;
          return { selector: `${place}${anchor === holder ? "" : " "}.${generated}`, shared: false };
        } catch {
          return { selector: "", shared: false };
        }
      };
      // A source colour token (Webflow's `.text { color: var(--grey-600) }`) colours text on every page; fixing
      // the rule that sets it fixes them all in one round, where a rule per element never converged. The
      // selector is only returned when re-declaring it after the stylesheets demonstrably recolours this text.
      const colourRules = [];
      const backgroundRules = [];
      const collect = (rules) => {
        for (const rule of rules || []) {
          try {
            if (rule.cssRules && !rule.selectorText) collect(rule.cssRules);
            else if (rule.styleSheet) collect(rule.styleSheet.cssRules);
            else if (rule.selectorText) {
              if (rule.style?.getPropertyValue("color")) colourRules.push(rule.selectorText);
              if (rule.style?.getPropertyValue("background-color")) backgroundRules.push(rule.selectorText);
            }
          } catch { /* a cross-origin sheet cannot be read */ }
        }
      };
      for (const sheet of Array.from(document.styleSheets || [])) { try { collect(sheet.cssRules); } catch { /* cross-origin */ } }
      let probe = null;
      const selectorParts = (selectorText) => {
        const list = [];
        let depth = 0, start = 0;
        for (let index = 0; index < selectorText.length; index += 1) {
          const char = selectorText[index];
          if (char === "(" || char === "[") depth += 1;
          else if (char === ")" || char === "]") depth -= 1;
          else if (char === "," && depth === 0) { list.push(selectorText.slice(start, index).trim()); start = index + 1; }
        }
        return [...list, selectorText.slice(start).trim()];
      };
      // The last rule whose re-declaration after every stylesheet visibly changes `property` on `observed`.
      const provedRule = (rules, node, observed, property) => {
        for (const selectorText of [...rules].reverse()) {
          for (const part of selectorParts(selectorText)) {
            if (!part || part.length > 600 || /[{}]/.test(part) || /^(?:html|body|:root|\*)$/.test(part) || !node.matches(part)) continue;
            // A class generated from one inline style is carried by every element that had it; it is not a source token.
            if (/\.ww-source-inline-[0-9a-f]{8,}/.test(part) && !/[#[]/.test(part)) continue;
            probe = probe || document.createElement("style");
            // A transition (Webflow buttons ease colour over 0.2s) would report the old value and hide the rule.
            probe.textContent = `${part}{${property}:rgb(1, 2, 3)}`;
            document.head.appendChild(probe);
            const moved = getComputedStyle(observed).getPropertyValue(property) === "rgb(1, 2, 3)";
            probe.remove();
            if (moved) return part;
          }
        }
        return "";
      };
      const colourRule = (target) => {
        try {
          const failing = document.querySelector(target);
          let node = failing;
          if (!node) return "";
          const colour = getComputedStyle(node).color;
          while (node.parentElement && getComputedStyle(node.parentElement).color === colour) node = node.parentElement;
          return provedRule(colourRules, node, failing, "color");
        } catch {
          probe?.remove();
          return "";
        }
      };
      // Light text on a brand-coloured button cannot be fixed by its text colour; the button's own fill can be.
      const backgroundRule = (target) => {
        try {
          let node = document.querySelector(target);
          for (let depth = 0; node && node !== document.body && depth < 8; depth += 1, node = node.parentElement) {
            const fill = getComputedStyle(node).backgroundColor;
            if (fill === "transparent" || /rgba\([^)]*,\s*0\)$/.test(fill)) continue;
            if (/rgba/.test(fill) || getComputedStyle(node).backgroundImage !== "none") return "";
            return provedRule(backgroundRules, node, node, "background-color");
          }
          return "";
        } catch {
          probe?.remove();
          return "";
        }
      };
      // A transparent header over a photo cannot be judged against the page colour, and axe only marks such
      // text "needs review". The header's runtime measured the photo, so that measurement decides: enough
      // contrast settles the text, too little is reported, and an unreadable photo is left to the deployed scan.
      const header = (() => {
        try {
          return document.querySelector(".site-header[data-ww-header-tone]");
        } catch {
          return null;
        }
      })();
      const tone = header?.getAttribute("data-ww-header-tone") || "";
      const measured = Number(header?.getAttribute("data-ww-header-contrast"));
      let verifiedByRuntime = 0;
      let unverifiedBackdrop = 0;
      const inHeader = (node) => {
        try {
          return Boolean(header && document.querySelector(Array.isArray(node.target) ? node.target.join(" ") : String(node.target || ""))?.closest(".site-header"));
        } catch {
          return false;
        }
      };
      const judged = result.violations.map((violation) => {
        if (violation.id !== "color-contrast" || !header) return violation;
        const nodes = [];
        for (const node of violation.nodes) {
          if (!inHeader(node)) nodes.push(node);
          else if (tone === "unverified") unverifiedBackdrop += 1;
          else if (measured >= 4.5) verifiedByRuntime += 1;
          else nodes.push({ ...node, adaptiveHeader: true });
        }
        return { ...violation, nodes };
      }).filter((violation) => violation.nodes.length);
      if (header && tone !== "unverified" && measured < 4.5 && !judged.some((violation) => violation.id === "color-contrast")) {
        const brand = header.querySelector(".brand-title") || header;
        judged.push({
          id: "color-contrast", impact: "serious", help: "Elements must meet minimum color contrast ratio thresholds",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.10/color-contrast",
          description: "Header text over the hero image measures below the minimum contrast",
          nodes: [{ target: ".site-header .brand-title", adaptiveHeader: true, html: brand.outerHTML,
            failureSummary: `Header text over the hero image has a measured contrast of ${measured}:1. Expected contrast ratio of 4.5:1` }]
        });
      }
      return {
        verifiedByRuntime,
        unverifiedBackdrop,
        violations: (() => {
          // Probes read the declared colour at once and leave nothing animating back for the screenshot that follows.
          const still = document.createElement?.("style");
          if (still) {
            still.textContent = "*,*::before,*::after{transition:none!important}";
            document.head?.appendChild(still);
          }
          try {
            return judged.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          helpUrl: violation.helpUrl,
          description: violation.description,
          // Repairs need every failing element, not a sample; reports cap what they print in formatViolations.
          nodes: violation.nodes.slice(0, 100).map((node) => {
            const target = Array.isArray(node.target) ? node.target.join(" ") : String(node.target || "");
            const scopedTarget = scoped(target);
            const { selector: colourTarget, shared: colourShared } = violation.id === "color-contrast" ? colourSource(target) : { selector: "", shared: false };
            const sourceRule = violation.id === "color-contrast" && !colourTarget ? colourRule(target) : "";
            const fillRule = violation.id === "color-contrast" ? backgroundRule(target) : "";
            return {
              target,
              ...(node.adaptiveHeader ? { adaptiveHeader: true } : {}),
              ...(scopedTarget ? { scopedTarget } : {}),
              ...(colourTarget ? { colourTarget } : {}),
              ...(colourShared ? { colourShared: true } : {}),
              ...(sourceRule ? { colourRule: sourceRule } : {}),
              ...(fillRule ? { backgroundRule: fillRule } : {}),
              html: String(node.html || "").slice(0, 400),
              failureSummary: String(node.failureSummary || "").slice(0, 600)
            };
          })
            }));
          } finally {
            if (document.body) getComputedStyle(document.body).color;
            still?.remove();
          }
        })()
      };
    },
    tags
  );
}

export function blockingViolations(violations) {
  return (violations || []).filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? null));
}

// A rule can fail at both responsive widths. Keep one rule entry while
// retaining distinct affected elements, so reports and repair prompts stay
// compact without hiding mobile-only defects.
export function mergeViolations(scans) {
  const merged = new Map();
  for (const scan of scans || []) {
    for (const violation of scan?.violations || []) {
      const current = merged.get(violation.id) || { ...violation, nodes: [] };
      const seen = new Set(current.nodes.map((node) => `${node.target}\u0000${node.failureSummary}`));
      for (const node of violation.nodes || []) {
        const key = `${node.target}\u0000${node.failureSummary}`;
        if (!seen.has(key) && current.nodes.length < 16) {
          current.nodes.push(node);
          seen.add(key);
        }
      }
      merged.set(violation.id, current);
    }
  }
  return [...merged.values()];
}

export function countNodes(violations) {
  return (violations || []).reduce((total, violation) => total + (violation.nodes?.length || 0), 0);
}

// A compact, deterministic summary suitable for logs, stored evidence, and the
// remediation prompt.
// WHOSE DEFECT IS IT.
//
// The site header and footer come from the framework and are identical on every
// page. One insufficient-contrast footer paragraph therefore failed all eight
// pages of a migration - eight blocking violations, one defect - and not one of
// those pages could have fixed it, because a page does not own the chrome.
//
// Split by where the failing element actually sits, so a page is judged on the
// page. The caller decides chrome membership from the live DOM (an element
// inside <header>/<footer> or the banner/contentinfo landmarks), which is exact
// and costs one query - far better than reasoning about the CSS cascade, where
// the colour is set on a descendant and the background on an ancestor.
export const CHROME_LANDMARK_SELECTOR =
  "header, footer, [role=\"banner\"], [role=\"contentinfo\"], .site-header, .site-footer";

export function splitChromeViolations(violations, isChromeNode) {
  const page = [];
  const chrome = [];
  for (const violation of violations || []) {
    const nodes = violation.nodes || [];
    const chromeNodes = nodes.filter((node) => isChromeNode(node));
    const pageNodes = nodes.filter((node) => !isChromeNode(node));
    // A rule can fail in both places at once - the same contrast rule against a
    // footer paragraph and a page one. Each keeps only its own elements, so
    // neither report claims the other's.
    if (chromeNodes.length) chrome.push({ ...violation, nodes: chromeNodes });
    if (pageNodes.length) page.push({ ...violation, nodes: pageNodes });
  }
  return { page, chrome };
}

export function formatViolations(violations) {
  return (violations || [])
    .map((violation) => {
      const all = violation.nodes || [];
      const nodes = all.slice(0, 8)
        .map((node) => `    - ${node.target}\n      ${node.html}\n      ${node.failureSummary.replace(/\n+/g, " ")}`)
        .join("\n");
      const more = all.length > 8 ? `\n    ... and ${all.length - 8} more element(s)` : "";
      return `  [${violation.impact}] ${violation.id}: ${violation.help}\n${nodes}${more}`;
    })
    .join("\n");
}

// Groups a scan across viewports/routes into one reportable record.
export function summarize(pageScans) {
  const all = pageScans.flatMap((scan) => scan.violations || []);
  const blocking = blockingViolations(all);
  const byImpact = {};
  for (const violation of all) {
    byImpact[violation.impact || "unknown"] = (byImpact[violation.impact || "unknown"] || 0) + 1;
  }
  return {
    standard: "WCAG 2.1 AA",
    pagesScanned: pageScans.length,
    violationCount: all.length,
    blockingCount: blocking.length,
    nodeCount: countNodes(all),
    byImpact,
    blockingRuleIds: [...new Set(blocking.map((violation) => violation.id))].sort(),
    pages: pageScans.map((scan) => ({
      path: scan.path,
      violationCount: (scan.violations || []).length,
      blockingCount: blockingViolations(scan.violations).length,
      ruleIds: [...new Set((scan.violations || []).map((violation) => violation.id))].sort()
    }))
  };
}

const REMEDIATION_RULES = `You repair accessibility and document-integrity defects in HTML. You are given an
HTML document and a list of automated failures, including axe-core WCAG 2.1 AA findings and possibly a truncated or
unbalanced source document.

Fix every violation listed. Rules:
- Preserve the existing design, copy, layout, classes and structure. You are repairing accessibility, not redesigning.
- Never remove content. Never replace an image with nothing.
- For colour-contrast failures, adjust only the colour values involved, keeping the palette's character. Darken or
  lighten the smallest amount that clears 4.5:1 for normal text and 3:1 for large text (>=24px, or >=19px bold).
- CONTRAST FIX ORDER, when text sits on or over another surface: (1) first try adjusting the TEXT colour alone;
  (2) if the text sits over a background IMAGE or a translucent scrim is already present, add or strengthen a
  translucent scrim (rgba black at .55-.85 works over any photo) instead of an opaque panel; (3) NEVER paint an
  opaque solid block behind text to fix contrast — a dark page section over a light page reads as a huge foreign
  box. If the background is already dark enough for light text after a scrim, leave it alone.
- If the failing element is an ICON rendered by an <img> (social icons, glyphs), changing CSS colour values does
  nothing — the icon IS the image. Fix it by choosing a background/circle colour that contrasts with the icon
  image's own pixels (source icons from dark sites are usually WHITE), or by removing the decorative circle.
- Write real alt text that describes the image's purpose in context. Use alt="" only for genuinely decorative images.
- Give form controls real associated labels; a placeholder is not a label.
- Keep heading levels in order and never skip a level.
- Preserve any existing lang, landmarks and skip links; add them if they are missing.`;

export const REMEDIATION_SYSTEM = `${REMEDIATION_RULES}
- Return the COMPLETE corrected HTML document, starting with <!DOCTYPE html>. No commentary, no code fences.`;

export const REMEDIATION_PATCH_SYSTEM = `${REMEDIATION_RULES}

Apply the fixes as targeted edits instead of rewriting the document.

${PATCH_INSTRUCTIONS}`;

// Kept here rather than imported from the generator so this module is portable:
// every managed site repository gets a copy, and none of them carry the build
// pipeline. Behaviour matches generate-site-build.mjs.
export function clampInt(value, fallback, lo, hi) {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback;
}

export function salvageHtml(text) {
  let body = String(text || "");
  const fence = body.match(/```[a-z]*\s*\n?([\s\S]*?)```/i);
  if (fence) body = fence[1];
  body = body.trim();
  if (!/<(!doctype|html|body|section|div|main|header|footer|article|nav|h[1-6]|p|ul|ol|form|img|figure)\b/i.test(body)) return "";
  return body;
}

// Accessibility repair is also model output. It needs the same static-site
// boundary as initial generation before it can be written back to disk.
export function sanitizeHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<script[^>]*>/gi, " ")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

export function isCompleteDocument(html) {
  const source = String(html || "");
  if (!/<!doctype\s+html/i.test(source) || !/<\/body\s*>/i.test(source) || !/<\/html\s*>\s*$/i.test(source)) return false;
  for (const name of ["html", "head", "body", "style", "main", "section", "form"]) {
    const opens = source.match(new RegExp(`<${name}\\b`, "gi"))?.length || 0;
    const closes = source.match(new RegExp(`</${name}\\s*>`, "gi"))?.length || 0;
    if (opens !== closes) return false;
  }
  return true;
}

export function documentCompletenessViolation(html) {
  if (isCompleteDocument(html)) return null;
  return {
    id: "document-completeness",
    impact: "critical",
    help: "HTML document must be complete and balanced",
    helpUrl: "",
    description: "The source document is truncated, missing closing document tags, or has unbalanced structural elements.",
    nodes: [{
      target: "html",
      html: String(html || "").slice(-400),
      failureSummary: "Preserve the page and close every html, head, body, style, main, section, and form element."
    }]
  };
}

export function remediationPrompt({ routePath, html, violations }) {
  return `Route: ${routePath}

Automated WCAG 2.1 AA and document-integrity checks found these failures:

${formatViolations(violations)}

Current HTML document:

${html}

Return the complete corrected HTML document.`;
}

export function remediationPatchPrompt({ routePath, html, violations }) {
  return `Route: ${routePath}

Automated WCAG 2.1 AA and document-integrity checks found these failures:

${formatViolations(violations)}

Current HTML document:

${html}

Return targeted edits only.`;
}

/**
 * Applies an accessibility model's anchored edits without allowing unrelated
 * markup to drift. The caller may use a guarded whole-document fallback when a
 * structural repair cannot be expressed as a safe patch.
 */
export function applyAccessibilityPatch(html, reply) {
  const edits = parseEdits(reply);
  if (!edits.length) return { html: "", edits, result: null, reason: "no usable edits" };
  const result = applyEdits(html, edits);
  if (!result.changed) {
    return {
      html: "", edits, result,
      reason: result.failed.map((failure) => failure.code).filter(Boolean).join(", ") || "no change"
    };
  }
  const repaired = sanitizeHtml(result.html);
  if (!isCompleteDocument(repaired)) {
    return { html: "", edits, result, reason: "patch damaged the document structure" };
  }
  return { html: repaired, edits, result, reason: "" };
}

// ── Scan scope ───────────────────────────────────────────────────────────────

// What a page is made of: its tags, plain-word classes and data attributes. Generated hash classes are
// per-page noise and are left out, so two pages built from the same parts look alike.
export function pageVocabulary(html) {
  const body = /<main\b[\s\S]*<\/main>/i.exec(html)?.[0] || String(html || "");
  const tokens = new Set();
  for (const tag of body.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    tokens.add(`<${tag[1].toLowerCase()}`);
    const classes = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[2]);
    for (const name of (classes?.[1] ?? classes?.[2] ?? "").split(/\s+/)) {
      if (name && name.length <= 40 && /^[a-z][a-z-]*$/.test(name)) tokens.add(`.${name}`);
    }
    for (const attribute of tag[2].matchAll(/\s(data-[a-z0-9-]+)/gi)) tokens.add(attribute[1].toLowerCase());
  }
  return tokens;
}

// The fewest pages that between them use every tag, class and data attribute found anywhere on the site,
// so a change to shared styling is tried against each kind of page rather than all of them.
export function representativePages(pages, limit = 30) {
  const vocabulary = new Map(pages.map((page) => [page.route, pageVocabulary(page.html)]));
  const covered = new Set();
  const chosen = [];
  const remaining = [...pages];
  const home = remaining.find((page) => page.route === "/");
  const take = (page) => {
    chosen.push(page.route);
    for (const token of vocabulary.get(page.route)) covered.add(token);
    remaining.splice(remaining.indexOf(page), 1);
  };
  if (home) take(home);
  while (chosen.length < limit && remaining.length) {
    let best = null;
    let bestGain = 0;
    for (const page of remaining) {
      let gain = 0;
      for (const token of vocabulary.get(page.route)) if (!covered.has(token)) gain += 1;
      if (gain > bestGain) { best = page; bestGain = gain; }
    }
    if (!best) break;
    take(best);
  }
  return chosen;
}

// A change here can alter how any page looks or behaves.
const SHARED_FILE = /^(?:layout\/|scripts\/(?!.*\.test\.mjs$)|src\/|public\/(?!.*\.html$)(?:.*\.(?:css|js|mjs|json)$)|wrangler[^/]*\.jsonc?$|package\.json$)/;

export function isSharedSource(file) {
  return SHARED_FILE.test(String(file || "").replace(/^\.\//, ""));
}

// pages: [{ rel, route, html }] with rel relative to the site root. changed: paths changed since the last
// scanned state, or null when that is not known - which always means every page.
export function selectScanScope({ pages, changed, limit = 30 }) {
  if (!Array.isArray(changed)) return { mode: "full", routes: pages.map((page) => page.route), changedPages: [], sample: [] };
  const changedSet = new Set(changed.map((file) => String(file).replace(/^\.\//, "")));
  const changedPages = pages.filter((page) => changedSet.has(page.rel)).map((page) => page.route);
  const shared = changed.some(isSharedSource);
  const sample = shared ? representativePages(pages, limit) : [];
  const routes = [...new Set([...changedPages, ...sample])];
  // Nothing that affects a page changed; still look at one page so a broken deploy is noticed.
  if (!routes.length && pages.length) routes.push(pages.find((page) => page.route === "/")?.route || pages[0].route);
  return { mode: shared ? "changed+sample" : "changed", routes, changedPages, sample };
}
