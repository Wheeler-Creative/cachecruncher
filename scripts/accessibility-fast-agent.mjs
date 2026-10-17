// Hyper-fast deterministic and targeted accessibility resolution agent.
//
// Solves blocking WCAG 2.1 AA violations in milliseconds without costly full-page
// LLM rewrite loops:
//   1. Color contrast: automatically optimizes CSS variables and rules to satisfy >= 4.5:1
//   2. Missing alt text: derives contextual alt text from filenames, labels or context
//   3. Missing lang attributes: ensures valid <html lang="en">
//   4. Missing landmarks: wraps main content in <main>
//   5. Empty link/button names: adds aria-label from href or icon context
//
// If any complex defect remains, falls back to a fast targeted patch model.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { load } from "cheerio";

// ── Color and Contrast Mathematics ──────────────────────────────────────────

export function parseColor(colorStr) {
  if (!colorStr || typeof colorStr !== "string") return null;
  const str = colorStr.trim().toLowerCase();

  // 3 or 6 hex digits
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(str);
  if (hex3) {
    return {
      r: parseInt(hex3[1] + hex3[1], 16),
      g: parseInt(hex3[2] + hex3[2], 16),
      b: parseInt(hex3[3] + hex3[3], 16),
      hex: `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`
    };
  }

  const hex6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(str);
  if (hex6) {
    return {
      r: parseInt(hex6[1], 16),
      g: parseInt(hex6[2], 16),
      b: parseInt(hex6[3], 16),
      hex: str
    };
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgb = /^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(str);
  if (rgb) {
    const r = Math.min(255, Math.max(0, parseInt(rgb[1], 10)));
    const g = Math.min(255, Math.max(0, parseInt(rgb[2], 10)));
    const b = Math.min(255, Math.max(0, parseInt(rgb[3], 10)));
    const toHex = (n) => n.toString(16).padStart(2, "0");
    return { r, g, b, hex: `#${toHex(r)}${toHex(g)}${toHex(b)}` };
  }

  return null;
}

export function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export function contrastRatio(colorA, colorB) {
  const cA = typeof colorA === "string" ? parseColor(colorA) : colorA;
  const cB = typeof colorB === "string" ? parseColor(colorB) : colorB;
  if (!cA || !cB) return 1.0;
  const l1 = relativeLuminance(cA);
  const l2 = relativeLuminance(cB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function adjustColorForContrast(fgStr, bgStr, minRatio = 4.54) {
  const fg = parseColor(fgStr);
  const bg = parseColor(bgStr);
  if (!fg || !bg) return fgStr;

  const initialRatio = contrastRatio(fg, bg);
  if (initialRatio >= minRatio) return fg.hex;

  const bgLum = relativeLuminance(bg);
  const shouldDarken = bgLum >= 0.45; // Darken if background is light, lighten if background is dark

  let r = fg.r;
  let g = fg.g;
  let b = fg.b;

  // Step towards black or white until contrast requirement is satisfied
  for (let step = 0; step < 255; step += 1) {
    if (shouldDarken) {
      r = Math.max(0, Math.floor(r * 0.96));
      g = Math.max(0, Math.floor(g * 0.96));
      b = Math.max(0, Math.floor(b * 0.96));
    } else {
      r = Math.min(255, Math.ceil(r + (255 - r) * 0.06));
      g = Math.min(255, Math.ceil(g + (255 - g) * 0.06));
      b = Math.min(255, Math.ceil(b + (255 - b) * 0.06));
    }

    const current = { r, g, b };
    if (contrastRatio(current, bg) >= minRatio) {
      const toHex = (n) => n.toString(16).padStart(2, "0");
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
  }

  return shouldDarken ? "#000000" : "#ffffff";
}

// ── Extracting Color Information from axe-core Violations ────────────────────

export function extractContrastFailures(violations = []) {
  const failures = [];
  for (const v of violations || []) {
    if (v.id !== "color-contrast") continue;
    for (const node of v.nodes || []) {
      const summary = node.failureSummary || "";
      // axe format: "Element has insufficient color contrast of X (foreground color: #XXXXXX, background color: #YYYYYY, ...)"
      const fgMatch = /foreground color:\s*([#a-z0-9(),\s]+?)(?:,|$)/i.exec(summary);
      const bgMatch = /background color:\s*([#a-z0-9(),\s]+?)(?:,|$)/i.exec(summary);
      if (fgMatch && bgMatch) {
        failures.push({
          target: node.target,
          fg: fgMatch[1].trim(),
          bg: bgMatch[1].trim(),
          html: node.html || ""
        });
      }
    }
  }
  return failures;
}

// ── Deterministic CSS Resolver ──────────────────────────────────────────────

// Light text that is almost the colour of a light background was designed for something this scan cannot
// see (a hero image or gradient). Darkening it would break the page where it is read, so it is left to the deployed scan.
function hiddenBackground(fg, bg) {
  const front = parseColor(fg);
  const back = parseColor(bg);
  return Boolean(front && back && relativeLuminance(front) > 0.5 && contrastRatio(front, back) < 1.5);
}

const OVERRIDES_START = "/* ww-a11y-overrides: generated from measured accessibility failures */";
const OVERRIDES_END = "/* ww-a11y-overrides:end */";
const POSITIONAL = /:nth-(?:child|of-type|last-child|last-of-type)\([^)]*\)/g;
// A rule's own selector re-declared later in the cascade carries no !important: text the source styled more
// specifically (white over a photo) keeps its colour.
const ALLOWED_DECLARATION = /^(?:(?:background-)?color: #[0-9a-f]{6}(?: !important)?|text-decoration: underline !important)$/;

function targetText(target) {
  return (Array.isArray(target) ? target.join(" ") : String(target || "")).replace(/\s+/g, " ").trim();
}

export function isSafeOverrideSelector(selector) {
  return typeof selector === "string" && selector.length > 0 && selector.length <= 600
    && !/[{};<\\]|\/\*|\*\//.test(selector);
}

// A colour override must name a place, not a kind of element: an id, an attribute, a class with context,
// or a class generated from one source element's inline style. Editor labels ("Link text 2") and link kinds
// (rel, target) repeat across unrelated elements, so they single nothing out.
function specificEnough(selector) {
  const placed = String(selector || "").replace(/\[(?:data-ww-(?:label|kind|group)|rel|target|type)=(?:"[^"]*"|'[^']*')\]/g, "");
  return /[#[]/.test(placed) || (!sharedClassSubject(placed) && /\./.test(placed) && /[\s>+~]/.test(placed.trim()));
}

// A migrated inline style becomes a generated class, carried by every element that had the same style, on every
// page. A rule whose subject is only that class recolours all of them, including white text over a photo the scan
// cannot measure, so it names no place however many combinators lead to it. The scan anchors a class to a block
// or id and proves every carrier there failed (colourTarget); anything else is left to the page's own repair.
const GENERATED_CLASS = /\.ww-source-inline-[0-9a-f]{8,}\b/;
function sharedClassSubject(selector) {
  const subject = String(selector || "").trim().split(/[\s>+~]+/).pop() || "";
  return GENERATED_CLASS.test(subject) && !/[.#[]/.test(subject.replace(new RegExp(GENERATED_CLASS.source, "g"), ""));
}
const anchored = (selector) => /[#[]/.test(String(selector || ""));
// Only a colour or fill declared on the class itself is the problem; a path below it names its own elements.
const reachesWholeClass = (selector) => sharedClassSubject(selector) && !anchored(selector);

// A link inside a paragraph must differ from the text around it by more than colour.
function linkSelector(target) {
  // Positional and href pseudo-uniqueness pin the rule to one paragraph or link; dropping them fixes every sibling too.
  const positionless = targetText(target).replace(POSITIONAL, "");
  const generalised = positionless.replace(/\[href[*^$~|]?=(?:"[^"]*"|'[^']*')\]/g, "").replace(/\s+/g, " ").trim();
  // A bare `a` would underline every link on the site, so keep the href that singles the link out.
  const selector = generalised === "a" ? positionless.replace(/\s+/g, " ").trim() : generalised;
  // Only a plain selector ending in the link itself (<a> or a class/id on it) is safe to write into a stylesheet.
  if (!selector || /[{};<\\]/.test(selector) || !/(?:^|[\s>+~])(?:a|[.#][\w-]+)(?:[.#[:][^\s>+~]*)?$/.test(selector)) return null;
  return selector;
}

// Rules are written against the colour the browser measured, so they work when
// a theme computes its colours (rgba(var(--color-foreground), .75)) and no
// literal value exists in any stylesheet to replace.
function contrastRules(violations) {
  const rules = [];
  for (const violation of violations || []) {
    if (violation.id !== "color-contrast") continue;
    for (const node of violation.nodes || []) {
      if (node.adaptiveHeader) continue;
      const summary = String(node.failureSummary || "");
      const fg = /foreground color:\s*(#[0-9a-f]{3,6})\b/i.exec(summary)?.[1];
      const bg = /background color:\s*(#[0-9a-f]{3,6})\b/i.exec(summary)?.[1];
      // A proved solid fill is not a hidden photo: near-white text on it is simply unreadable.
      if (!fg || !bg || (hiddenBackground(fg, bg) && !node.backgroundRule)) continue;
      const expected = Number(/Expected contrast ratio of ([\d.]+):1/i.exec(summary)?.[1]) || 4.5;
      const color = adjustColorForContrast(fg, bg, expected + 0.04).toLowerCase();
      if (contrastRatio(color, bg) < expected) {
        // The text is already as far from its fill as it goes; the fill moves instead, everywhere it is used.
        const fill = adjustColorForContrast(bg, fg, expected + 0.04).toLowerCase();
        if (node.backgroundRule && !reachesWholeClass(node.backgroundRule) && contrastRatio(fill, fg) >= expected) {
          rules.push({ selector: node.backgroundRule, exact: node.backgroundRule, declaration: `background-color: ${fill}`, sourceRule: true });
        }
        continue;
      }
      const exact = targetText(node.colourTarget || node.scopedTarget || node.target);
      if (node.colourRule && !node.colourTarget) {
        if (reachesWholeClass(node.colourRule)) continue;
        rules.push({ selector: node.colourRule, exact: node.colourRule, declaration: `color: ${color}`, sourceRule: true });
        continue;
      }
      // The colour sits on a class that other elements carry. Only the scan's colourTarget proves each carrier in
      // its place failed; a bare class (an older scan, or axe's own selector) would recolour text that passes
      // where this one fails, so the page's own repair handles it instead.
      if (sharedClassSubject(exact) && !(node.colourTarget && anchored(exact))) continue;
      rules.push({ selector: exact.replace(POSITIONAL, "").replace(/\s+/g, " ").trim(), exact, declaration: `color: ${color} !important` });
    }
  }
  return rules;
}

function linkRules(violations) {
  const rules = [];
  for (const violation of violations || []) {
    if (violation.id !== "link-in-text-block") continue;
    for (const node of violation.nodes || []) {
      const selector = linkSelector(node.target);
      if (selector) rules.push({ selector, exact: selector, declaration: "text-decoration: underline !important" });
    }
  }
  return rules;
}

// One generalised rule fixes every match only when every match needs the same
// value; when they disagree, each keeps its exact position instead.
export function consolidateOverrideRules(rules = []) {
  const groups = new Map();
  for (const rule of rules || []) {
    if (!rule || !ALLOWED_DECLARATION.test(String(rule.declaration || ""))) continue;
    const key = `${rule.selector}\u0000${rule.declaration.split(":")[0]}`;
    groups.set(key, [...(groups.get(key) || []), rule]);
  }
  const out = new Map();
  for (const list of groups.values()) {
    // One source colour rule failing against different backgrounds needs the colour that passes on all of them.
    if (list[0].sourceRule) {
      const lightness = (rule) => relativeLuminance(parseColor(/#[0-9a-f]{6}/i.exec(rule.declaration)[0]));
      const ordered = [...list].sort((a, b) => lightness(a) - lightness(b));
      // Dark text was darkened and light text lightened; the furthest move passes everywhere the others did.
      const darkest = lightness(ordered[0]) < 0.5 ? ordered[0].declaration : ordered.at(-1).declaration;
      if (isSafeOverrideSelector(list[0].selector) && !reachesWholeClass(list[0].selector)) {
        const property = list[0].declaration.split(":")[0];
        out.set(`${list[0].selector}\u0000${property}`, { selector: list[0].selector, exact: list[0].selector, declaration: darkest, sourceRule: true });
      }
      continue;
    }
    const agreed = new Set(list.map((rule) => rule.declaration)).size === 1;
    const chosen = agreed ? [list[0]] : list.map((rule) => ({ ...rule, selector: rule.exact || rule.selector }));
    for (const candidate of chosen) {
      // A colour on a bare element selector would recolour that element everywhere, including where it already passes.
      const rule = candidate.declaration.startsWith("color") && !specificEnough(candidate.selector)
        ? { ...candidate, selector: specificEnough(candidate.exact || "") ? candidate.exact : "" }
        : candidate;
      if (!isSafeOverrideSelector(rule.selector)) continue;
      out.set(`${rule.selector}\u0000${rule.declaration.split(":")[0]}`, {
        selector: rule.selector, exact: rule.exact || rule.selector, declaration: rule.declaration
      });
    }
  }
  return [...out.values()];
}

export function accessibilityOverrideRules(violations = []) {
  return consolidateOverrideRules([...contrastRules(violations), ...linkRules(violations)]);
}

// Merges rules into one marked block at the end of a stylesheet. A selector
// already there is updated rather than repeated, so a second round converges.
export function mergeOverrideRules(css, rules = []) {
  const source = String(css || "");
  const start = source.indexOf(OVERRIDES_START);
  const end = start >= 0 ? source.indexOf(OVERRIDES_END, start) : -1;
  const block = start >= 0 && end > start;
  const existing = new Map();
  if (block) {
    for (const line of source.slice(start + OVERRIDES_START.length, end).split("\n")) {
      const match = /^(.+?) \{ (.+?); \}$/.exec(line.trim());
      if (match) existing.set(`${match[1]}\u0000${match[2].split(":")[0]}`, { selector: match[1], declaration: match[2] });
    }
  }
  const changed = [];
  for (const rule of rules || []) {
    if (!isSafeOverrideSelector(rule?.selector) || !ALLOWED_DECLARATION.test(String(rule?.declaration || ""))) continue;
    // Rules from an earlier builder may still name a whole generated class; they are not written.
    if (/^(?:background-)?color:/.test(rule.declaration) && reachesWholeClass(rule.selector)) continue;
    const key = `${rule.selector}\u0000${rule.declaration.split(":")[0]}`;
    if (existing.get(key)?.declaration === rule.declaration) continue;
    existing.set(key, { selector: rule.selector, declaration: rule.declaration });
    changed.push(rule);
  }
  if (!changed.length) return { css: source, changed };
  // Forced colours on selectors that turned out to reach unrelated elements (a breadcrumb colour on buttons
  // sharing an editor label) stopped repairs converging; the failures they fixed are repaired at their source.
  for (const [key, rule] of existing) {
    if (/^color: #[0-9a-f]{6} !important$/.test(rule.declaration) && !specificEnough(rule.selector)) existing.delete(key);
    // A colour or fill an earlier round put on a whole generated class reached text nobody measured.
    else if (/^(?:background-)?color:/.test(rule.declaration) && reachesWholeClass(rule.selector)) existing.delete(key);
  }
  const lines = [OVERRIDES_START, ...[...existing.values()].map((rule) => `${rule.selector} { ${rule.declaration}; }`), OVERRIDES_END];
  const before = block ? source.slice(0, start) : `${source.replace(/\s*$/, "")}\n\n`;
  const after = block ? source.slice(end + OVERRIDES_END.length) : "\n";
  return { css: `${before}${lines.join("\n")}${after}`, changed };
}

async function primaryStylesheet(publicDir) {
  const cssFiles = [];
  for (const entry of await readdir(publicDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith(".css")) cssFiles.push(path.join(publicDir, entry.name));
  }
  return cssFiles.find((file) => path.basename(file) === "styles.css") || cssFiles[0] || null;
}

export async function resolveCssContrastIssues(publicDir, violations = []) {
  const contrastFailures = extractContrastFailures(violations);
  const changes = [];
  const cssFiles = [];

  async function collectCss(dir) {
    if (!existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await collectCss(full);
      else if (entry.isFile() && entry.name.endsWith(".css")) cssFiles.push(full);
    }
  }

  await collectCss(publicDir);
  if (!cssFiles.length) return { changes, resolvedCount: 0 };

  for (const cssPath of cssFiles) {
    let css = await readFile(cssPath, "utf8");
    let modified = false;

    // 1. Check known color variables in :root or stylesheets (--muted, --text-secondary, etc.)
    const varRegex = /(--[a-z0-9-_]*muted[a-z0-9-_]*|--[a-z0-9-_]*secondary[a-z0-9-_]*)\s*:\s*([^;}\n]+)/gi;
    let varMatch;
    while ((varMatch = varRegex.exec(css)) !== null) {
      const varName = varMatch[1];
      const rawVal = varMatch[2].trim();
      const parsed = parseColor(rawVal);
      // A light value (e.g. rgba(255,255,255,.75)) is meant for dark backgrounds; darkening it for white would break them.
      if (parsed && relativeLuminance(parsed) <= 0.5) {
        // Assume default background is white/light unless specified
        const currentRatio = contrastRatio(parsed, "#ffffff");
        if (currentRatio < 4.54) {
          const better = adjustColorForContrast(parsed.hex, "#ffffff", 4.54);
          const oldDeclaration = `${varName}:${rawVal}`;
          const newDeclaration = `${varName}: ${better}`;
          css = css.replace(new RegExp(`${escapeRegExp(varName)}\\s*:\\s*${escapeRegExp(rawVal)}`, "g"), newDeclaration);
          modified = true;
          changes.push({
            file: path.relative(publicDir, cssPath),
            type: "css_variable_contrast",
            variable: varName,
            before: rawVal,
            after: better,
            contrastBefore: currentRatio.toFixed(2),
            contrastAfter: contrastRatio(better, "#ffffff").toFixed(2)
          });
        }
      }
    }

    // 2. Cross-reference exact foreground colors flagged by axe-core
    for (const fail of contrastFailures) {
      const parsedFg = parseColor(fail.fg);
      const parsedBg = parseColor(fail.bg);
      if (!parsedFg || !parsedBg || hiddenBackground(fail.fg, fail.bg)) continue;

      if (contrastRatio(parsedFg, parsedBg) < 4.54) {
        const better = adjustColorForContrast(parsedFg.hex, parsedBg.hex, 4.54);

        // Light text on a mid-tone fill cannot get lighter, so the fill is darkened where it is written.
        if (contrastRatio(better, parsedBg) < 4.5) {
          const darker = adjustColorForContrast(parsedBg.hex, parsedFg.hex, 4.54);
          if (contrastRatio(parsedFg, darker) >= 4.5) {
            const fillRegex = new RegExp(
              `((?:background(?:-color)?|--[\\w-]*(?:bg|background)[\\w-]*)\\s*:\\s*)${escapeRegExp(parsedBg.hex)}(?![0-9a-f])`, "gi"
            );
            if (fillRegex.test(css)) {
              css = css.replace(fillRegex, `$1${darker}`);
              modified = true;
              changes.push({
                file: path.relative(publicDir, cssPath),
                type: "css_fill_contrast",
                selector: fail.target,
                before: parsedBg.hex,
                after: darker,
                contrastAfter: contrastRatio(parsedFg, darker).toFixed(2)
              });
            }
          }
          continue;
        }

        // Search for matches in CSS for the hex or 3-digit shorthand
        const candidates = [
          parsedFg.hex,
          `#${parsedFg.hex[1]}${parsedFg.hex[3]}${parsedFg.hex[5]}`.toLowerCase() === parsedFg.hex ? `#${parsedFg.hex[1]}${parsedFg.hex[3]}${parsedFg.hex[5]}` : null,
          `rgb(${parsedFg.r}, ${parsedFg.g}, ${parsedFg.b})`,
          `rgb(${parsedFg.r},${parsedFg.g},${parsedFg.b})`
        ].filter(Boolean);

        for (const candidate of candidates) {
          const colorPropRegex = new RegExp(`(color\\s*:\\s*)${escapeRegExp(candidate)}([;}\\s])`, "gi");
          if (colorPropRegex.test(css)) {
            css = css.replace(colorPropRegex, `$1${better}$2`);
            modified = true;
            changes.push({
              file: path.relative(publicDir, cssPath),
              type: "css_rule_contrast",
              selector: fail.target,
              before: candidate,
              after: better,
              contrastAfter: contrastRatio(better, parsedBg).toFixed(2)
            });
          }
        }

        // A theme token that holds the text colour is fixed once, where every page reads it, instead of
        // one rule per element that would also pin the colour on pages where the header adapts to its backdrop.
        const tokenRegex = new RegExp(
          `(--[\\w-]*(?:ink|title|text|colou?r|muted|fg|foreground|heading|label)[\\w-]*\\s*:\\s*)(?:${candidates.map(escapeRegExp).join("|")})(?![0-9a-f])`, "gi"
        );
        if (tokenRegex.test(css)) {
          css = css.replace(tokenRegex, `$1${better}`);
          modified = true;
          changes.push({
            file: path.relative(publicDir, cssPath),
            type: "css_rule_contrast",
            selector: fail.target,
            before: parsedFg.hex,
            after: better,
            contrastAfter: contrastRatio(better, parsedBg).toFixed(2)
          });
        }
      }
    }

    if (modified) {
      await writeFile(cssPath, css, "utf8");
    }
  }

  // Colours the theme computes are not written anywhere to replace; override what was measured instead.
  const replaced = new Set(changes.filter((change) => change.type === "css_rule_contrast").map((change) => parseColor(change.before)?.hex));
  const unmatched = (violations || []).map((violation) => (violation.id !== "color-contrast" ? violation : {
    ...violation,
    nodes: (violation.nodes || []).filter((node) => !replaced.has(parseColor(/foreground color:\s*(#[0-9a-f]{3,6})\b/i.exec(String(node.failureSummary || ""))?.[1] || "")?.hex))
  }));
  const overrides = consolidateOverrideRules(contrastRules(unmatched));
  const stylesheet = overrides.length ? await primaryStylesheet(publicDir) : null;
  if (stylesheet) {
    const merged = mergeOverrideRules(await readFile(stylesheet, "utf8"), overrides);
    if (merged.changed.length) {
      await writeFile(stylesheet, merged.css, "utf8");
      for (const rule of merged.changed) {
        changes.push({ file: path.relative(publicDir, stylesheet), type: "css_override_contrast", selector: rule.selector, after: rule.declaration });
      }
    }
  }

  return { changes, resolvedCount: changes.length };
}

// ── Deterministic link-in-text-block resolver ───────────────────────────────

const LINK_RULE_MARKER = "/* a11y: links inside running text are underlined so they never rely on colour alone (WCAG 1.4.1) */";

// A link inside a paragraph must differ from the text around it by more than
// colour. Underlining it is always sufficient, so no model call is needed.
export async function resolveLinkInTextBlockIssues(publicDir, violations = []) {
  const selectors = new Set();
  for (const violation of violations || []) {
    if (violation.id !== "link-in-text-block") continue;
    for (const node of violation.nodes || []) {
      const selector = linkSelector(node.target);
      if (selector) selectors.add(selector);
    }
  }
  if (!selectors.size) return { changes: [], resolvedCount: 0 };

  const cssPath = await primaryStylesheet(publicDir);
  if (!cssPath) return { changes: [], resolvedCount: 0 };

  let css = await readFile(cssPath, "utf8");
  const added = [...selectors].filter((selector) => !css.includes(`${selector} { text-decoration: underline !important; }`));
  if (!added.length) return { changes: [], resolvedCount: 0 };

  const rules = added.map((selector) => `${selector} { text-decoration: underline !important; }`).join("\n");
  css = `${css.replace(/\s*$/, "\n")}${css.includes(LINK_RULE_MARKER) ? "" : `\n${LINK_RULE_MARKER}\n`}${rules}\n`;
  await writeFile(cssPath, css, "utf8");
  return {
    changes: added.map((selector) => ({ file: path.relative(publicDir, cssPath), type: "link_in_text_block", selector })),
    resolvedCount: added.length
  };
}

// ── Deterministic HTML Resolver ─────────────────────────────────────────────

export function resolveHtmlA11yIssues(html, violations = [], { titles = null, fragment = false, language: fragmentLanguage = "" } = {}) {
  if (!html || typeof html !== "string") return { html, changes: [] };
  const $ = load(html, { decodeEntities: false }, !fragment);
  const changes = [];

  // 1. html-has-lang
  if (!fragment && !$("html").attr("lang")) {
    $("html").attr("lang", "en");
    changes.push({ type: "html_lang", message: "Added lang=\"en\" to <html>" });
  }

  // 2. image-alt
  $("img").each((_, el) => {
    const $img = $(el);
    const alt = $img.attr("alt");
    if (alt === undefined) {
      // Derive alt text from data-ww-help, data-ww-label, or filename
      const help = $img.attr("data-ww-help") || $img.attr("data-ww-label");
      let generatedAlt = "";
      if (help) {
        generatedAlt = help.trim();
      } else {
        const src = $img.attr("src") || "";
        const basename = path.basename(src.split("?")[0], path.extname(src.split("?")[0]));
        if (basename && !/^(img|image|photo|pic|screenshot|dsc|asset|placeholder)[-_0-9]*$/i.test(basename)) {
          generatedAlt = basename.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        } else {
          // If purely decorative, explicit alt=""
          generatedAlt = "";
        }
      }
      $img.attr("alt", generatedAlt);
      changes.push({ type: "image_alt", src: $img.attr("src") || "", alt: generatedAlt });
    }
  });

  // 3. landmark-one-main
  if (!fragment && $("main").length === 0) {
    const $siteWrap = $(".site-wrap");
    const $sections = ($siteWrap.length ? $siteWrap : $("body")).children("section");
    if ($sections.length > 0) {
      // Wrap content sections (excluding header/footer) in <main>
      $sections.wrapAll("<main></main>");
      changes.push({ type: "landmark_main", message: "Wrapped content sections in <main> landmark" });
    }
  }

  // 4. link-name and button-name (icon-only links/buttons without accessible text)
  const language = String(fragmentLanguage || $("html").attr("lang") || "en").toLowerCase().split("-")[0];
  $("a[href], button").each((_, el) => {
    const $el = $(el);
    if ($el.closest("[aria-hidden='true']").length) return;
    const text = $el.text().trim();
    const ariaLabel = $el.attr("aria-label");
    const ariaLabelledBy = $el.attr("aria-labelledby");
    const title = $el.attr("title");

    if (!text && !ariaLabel && !ariaLabelledBy && !title) {
      // Check for image inside with alt
      const imgAlt = $el.find("img[alt]").attr("alt");
      if (!imgAlt) {
        const label = el.tagName.toLowerCase() === "button"
          ? buttonLabel($, $el, language)
          : linkLabel($el.attr("href") || "", titles);
        $el.attr("aria-label", label);
        changes.push({ type: "link_button_name", target: el.tagName.toLowerCase(), label });
      }
    }
  });

  // 5. label: a form control with no accessible name is named from its placeholder, name or type
  $("input, select, textarea").each((_, el) => {
    const $el = $(el);
    const type = ($el.attr("type") || "text").toLowerCase();
    if (/^(hidden|submit|button|reset|image)$/.test(type) || $el.attr("hidden") !== undefined) return;
    if ($el.closest("[aria-hidden='true']").length) return;
    if ($el.attr("aria-label")?.trim() || $el.attr("aria-labelledby")?.trim() || $el.attr("title")?.trim()) return;
    if ($el.closest("label").text().trim()) return;
    const id = $el.attr("id");
    if (id && $("label").toArray().some((label) => $(label).attr("for") === id && $(label).text().trim())) return;
    const source = $el.attr("placeholder")?.trim()
      || ($el.attr("name") || id || "").replace(/\[\]$/, "").replace(/[-_]?input$/i, "").replace(/[-_[\]]+/g, " ").trim()
      || type;
    const label = source.charAt(0).toUpperCase() + source.slice(1);
    $el.attr("aria-label", label);
    changes.push({ type: "form_label", target: el.tagName.toLowerCase(), label });
  });

  // 6. scrollable-region-focusable: a region that scrolls must be reachable by keyboard
  for (const violation of violations || []) {
    if (violation.id !== "scrollable-region-focusable") continue;
    for (const node of violation.nodes || []) {
      const target = Array.isArray(node.target) ? node.target.join(" ") : String(node.target || "");
      let matches;
      try { matches = target ? $(target) : []; } catch { continue; }
      matches.each?.((_, el) => {
        if ($(el).attr("tabindex") !== undefined) return;
        $(el).attr("tabindex", "0");
        changes.push({ type: "scrollable_focusable", target: el.tagName.toLowerCase() });
      });
    }
  }

  return { html: $.html(), changes };
}

// An icon-only control is named for what its icon means, in the page's language.
const CONTROL_LABELS = [
  [/(?:^|[-_ ])(?:up|top|scroll-?top|back-?to-?top|scroll-to-target)(?:$|[-_ ])/i,
    { en: "Back to top", tr: "Başa dön", de: "Nach oben", fr: "Haut de page", es: "Volver arriba", it: "Torna su", nl: "Naar boven" }],
  [/(?:^|[-_ ])(?:close|times|cross|dismiss)(?:$|[-_ ])/i,
    { en: "Close", tr: "Kapat", de: "Schließen", fr: "Fermer", es: "Cerrar", it: "Chiudi", nl: "Sluiten" }],
  [/(?:^|[-_ ])(?:menu|bars|hamburger|nav-?toggle)(?:$|[-_ ])/i,
    { en: "Menu", tr: "Menü", de: "Menü", fr: "Menu", es: "Menú", it: "Menu", nl: "Menu" }],
  [/(?:^|[-_ ])(?:search|magnifier)(?:$|[-_ ])/i,
    { en: "Search", tr: "Ara", de: "Suchen", fr: "Rechercher", es: "Buscar", it: "Cerca", nl: "Zoeken" }],
  [/(?:^|[-_ ])(?:next|right|forward)(?:$|[-_ ])/i,
    { en: "Next", tr: "Sonraki", de: "Weiter", fr: "Suivant", es: "Siguiente", it: "Avanti", nl: "Volgende" }],
  [/(?:^|[-_ ])(?:prev|previous|left|back)(?:$|[-_ ])/i,
    { en: "Previous", tr: "Önceki", de: "Zurück", fr: "Précédent", es: "Anterior", it: "Indietro", nl: "Vorige" }],
  [/(?:^|[-_ ])(?:play)(?:$|[-_ ])/i,
    { en: "Play", tr: "Oynat", de: "Abspielen", fr: "Lire", es: "Reproducir", it: "Riproduci", nl: "Afspelen" }]
];
const BUTTON_FALLBACK = { en: "Button", tr: "Düğme", de: "Schaltfläche", fr: "Bouton", es: "Botón", it: "Pulsante", nl: "Knop" };

function buttonLabel($, $el, language) {
  const hints = [$el, ...$el.find("*").toArray().map((node) => $(node))]
    .map((node) => `${node.attr("class") || ""} ${node.attr("id") || ""} ${node.attr("data-target") || ""}`).join(" ");
  const tokens = hints.split(/\s+/).filter(Boolean);
  for (const [pattern, labels] of CONTROL_LABELS) {
    if (tokens.some((token) => pattern.test(token))) return labels[language] || labels.en;
  }
  return BUTTON_FALLBACK[language] || BUTTON_FALLBACK.en;
}

function linkLabel(href, titles) {
  if (/instagram\.com/i.test(href)) return "Instagram";
  if (/facebook\.com/i.test(href)) return "Facebook";
  if (/twitter\.com|x\.com/i.test(href)) return "Twitter";
  if (/linkedin\.com/i.test(href)) return "LinkedIn";
  if (/youtube\.com|youtu\.be/i.test(href)) return "YouTube";
  if (/^tel:/i.test(href)) return "Call";
  if (/^mailto:/i.test(href)) return "Email";
  const route = href.replace(/[#?].*$/, "");
  const known = titles?.get?.(route) || titles?.get?.(`${route.replace(/\/$/, "")}/`);
  if (known) return known;
  if (route === "/" || route === "./") return "Home";
  const segment = route.split("/").filter(Boolean).pop();
  return segment ? decodeURIComponentSafe(segment).replace(/[-_]+/g, " ") : "Link";
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

// Browserless repair for a whole site, run before it is committed: the names a
// scan would ask for, with each link named by the heading of the page it opens.
// layout/ is repaired too, because every deploy recomposes page chrome from it.
export async function repairStaticAccessibility(siteDir) {
  const publicDir = path.join(siteDir, "public");
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".html")) files.push(full);
    }
  };
  await walk(publicDir);
  const routeOf = (file) => `/${path.relative(publicDir, file).split(path.sep).join("/")}`.replace(/index\.html$/, "");
  const titles = new Map();
  const sources = new Map();
  for (const file of files) {
    const html = await readFile(file, "utf8");
    sources.set(file, html);
    const $ = load(html);
    const heading = $("main h1").first().text().replace(/\s+/g, " ").trim()
      || $("title").first().text().split(/\s+[|–—-]\s+/)[0].trim();
    if (heading) titles.set(routeOf(file), heading.slice(0, 120));
  }
  const repaired = [];
  const home = sources.get(path.join(publicDir, "index.html")) || "";
  const layout = JSON.parse(await readFile(path.join(siteDir, "layout", "pages.json"), "utf8").catch(() => "null"));
  const primaryLanguage = load(home)("html").attr("lang") || layout?.defaults?.htmlAttributes?.lang || "en";
  for (const fragmentFile of ["layout/header.html", "layout/footer.html"]) {
    const file = path.join(siteDir, fragmentFile);
    const source = await readFile(file, "utf8").catch(() => null);
    if (source === null) continue;
    const { html, changes } = resolveHtmlA11yIssues(source, [], { titles, fragment: true, language: primaryLanguage });
    if (!changes.length) continue;
    await writeFile(file, html);
    repaired.push({ route: fragmentFile, changes: changes.length });
  }
  for (const file of files) {
    const source = sources.get(file);
    // A shared-layout page is its <main> only; parsed as a document it would
    // gain a bare <html lang><body> that re-adoption then records as the page's
    // root attributes, losing the source page's classes and its title.
    const fragment = !/<html\b|<!doctype/i.test(source);
    const { html, changes } = resolveHtmlA11yIssues(source, [], { titles, fragment, language: fragment ? primaryLanguage : "" });
    if (!changes.length) continue;
    await writeFile(file, html);
    repaired.push({ route: routeOf(file), changes: changes.length });
  }
  return repaired;
}

// ── Orchestrated Fast Resolution Sub-Agent ──────────────────────────────────

export async function resolveSiteAccessibilityDefects(siteDir, { violationsByRoute = new Map(), log = () => {} } = {}) {
  const publicDir = path.join(siteDir, "public");
  if (!existsSync(publicDir)) return { ok: false, error: "public directory not found" };

  const allViolations = [];
  for (const violations of violationsByRoute.values()) {
    allViolations.push(...(violations || []));
  }

  // Phase 1: CSS-level fixes (clears site-wide color-contrast issues instantly)
  const cssResolution = await resolveCssContrastIssues(publicDir, allViolations);
  if (cssResolution.changes.length) {
    log(`[a11y-agent] Resolved ${cssResolution.changes.length} CSS contrast issue(s)`);
    for (const change of cssResolution.changes) {
      log(`  ${change.file}: ${change.variable || change.selector} ${change.before} -> ${change.after} (ratio: ${change.contrastAfter}:1)`);
    }
  }

  // Phase 2: HTML-level deterministic fixes (alt text, lang, landmarks, link names)
  const htmlEntries = await readdir(publicDir);
  const htmlFiles = htmlEntries.filter((f) => f.endsWith(".html")).map((f) => path.join(publicDir, f));
  let htmlFixedCount = 0;

  for (const file of htmlFiles) {
    const route = "/" + path.relative(publicDir, file).replace(/index\.html$/, "");
    const violations = violationsByRoute.get(route) || allViolations;
    const content = await readFile(file, "utf8");
    const { html, changes } = resolveHtmlA11yIssues(content, violations, { fragment: !/<html\b|<!doctype/i.test(content) });
    if (changes.length) {
      await writeFile(file, html, "utf8");
      htmlFixedCount += changes.length;
      log(`[a11y-agent] Fixed ${changes.length} issue(s) in ${path.relative(siteDir, file)}:`);
      for (const c of changes) log(`  - ${c.type}: ${c.message || c.alt || c.label}`);
    }
  }

  return {
    ok: true,
    cssChanges: cssResolution.changes,
    htmlChangesCount: htmlFixedCount,
    totalFixes: cssResolution.changes.length + htmlFixedCount
  };
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
