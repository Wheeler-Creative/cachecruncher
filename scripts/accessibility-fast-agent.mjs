// Hyper-fast deterministic and targeted accessibility resolution agent.
//
// Solves blocking WCAG 2.1 AA violations in milliseconds without costly full-page
// LLM rewrite loops:
//   1. Color contrast: automatically optimizes CSS variables and rules to satisfy >= 4.5:1
//   2. Missing alt text: derives contextual alt text from filenames, labels or context
//   3. Missing lang attributes: ensures valid <html lang="en">
//   4. Missing landmarks: wraps main content in <main>
//   5. Empty link/button names: adds aria-label from href or icon context
//   6. Unlabelled form controls: aria-label from placeholder, name or type
//   7. Scrollable regions: a tab stop for a scroll container with nothing focusable in it,
//      from a scan or, before the page is drawn, from the site's own stylesheet
//   8. Links in running text: underlined (link-in-text-block)
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

// One shade at a time towards black (darken) or white, until the colour reads on bg at minRatio; null if it never does.
// `shown` is what a colour looks like once drawn (faded text, readableTextColour); the colour returned is the one to write.
function stepTowards(fg, bg, minRatio, darken, shown = (colour) => colour) {
  let { r, g, b } = fg;
  for (let step = 0; step < 255; step += 1) {
    if (darken) {
      r = Math.max(0, Math.floor(r * 0.96));
      g = Math.max(0, Math.floor(g * 0.96));
      b = Math.max(0, Math.floor(b * 0.96));
    } else {
      r = Math.min(255, Math.ceil(r + (255 - r) * 0.06));
      g = Math.min(255, Math.ceil(g + (255 - g) * 0.06));
      b = Math.min(255, Math.ceil(b + (255 - b) * 0.06));
    }
    if (contrastRatio(shown({ r, g, b }), bg) >= minRatio) return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

// FADED TEXT IS REPAIRED AS IT IS DRAWN (staging rehearsal, Nov 25 2026, about 9:55 PM Central). Larkfield Plumbing &
// Drain's call-to-action band (#e8660d) carries `.cta-band .cta-details { color: var(--color-on-accent); opacity: 0.9 }`.
// axe blends the opacity in: it measured #29272b, the 0.9 blend of #14202e over the orange, at 4.46:1. The repair
// darkened that blend one shade to #272529, which passes only when drawn solid; drawn at 0.9 it was lighter again and
// still failed. Each round then darkened the next blend, and since every blend pulls towards the orange the colours
// drifted brown (#332115, then #2f241e at 3.97:1): two repair builds, $11.33 and 29 minutes, ended `exhausted`.
//
// So the colour is chosen for after the fade. Text whose element and ancestors multiply to opacity A over a fill B is
// drawn, channel by channel as axe and the browser blend it, as behind + A x (colour - B), where `behind` is the measured
// background (B itself unless the fill is faded too). The design's fade is kept: a colour that reads at 0.9 is written
// and the 0.9 stays, which is the look closest to the design. Only when no colour can read through the fade (black and
// white both fail at that opacity) does the text's own opacity go to 1 as well (`opaque`); the colour is then chosen
// for the opacity its ancestors leave. An ancestor's fade is never lifted: it fades a whole section, the design's look.
// `opacity` and `fill` come from the scan (accessibility-lib.mjs scanPage: node.opacity, node.ownOpacity, node.fill).
export function drawnColour(colour, behind, { opacity = 1, fill = null } = {}) {
  const front = typeof colour === "string" ? parseColor(colour) : colour;
  const back = typeof behind === "string" ? parseColor(behind) : behind;
  const base = (typeof fill === "string" ? parseColor(fill) : fill) || back;
  const alpha = Number.isFinite(Number(opacity)) ? Math.min(1, Math.max(0, Number(opacity))) : 1;
  if (!front || !back || alpha >= 1) return front;
  const channel = (key) => Math.min(255, Math.max(0, back[key] + alpha * (front[key] - base[key])));
  return { r: channel("r"), g: channel("g"), b: channel("b") };
}

// The colour written for text axe measured as `measured` through that fade: the measurement undone, to the nearest whole shade.
function undrawnColour(measured, behind, { opacity = 1, fill = null } = {}) {
  const front = parseColor(measured);
  const back = parseColor(behind);
  const base = parseColor(fill || "") || back;
  const alpha = Number(opacity);
  if (!front || !back || !(alpha > 0 && alpha < 1)) return front;
  const channel = (key) => Math.round(Math.min(255, Math.max(0, base[key] + (front[key] - back[key]) / alpha)));
  const r = channel("r");
  const g = channel("g");
  const b = channel("b");
  return { r, g, b, hex: `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}` };
}

// THE TEXT MOVES, NEVER ITS BACKGROUND (owner, Nov 24 2026). The nearest shade of the text's own colour that reads on
// the background it was measured on: darker text gets darker and lighter text lighter, and only when that cannot reach
// the ratio does it turn the other way (white words on a mid pink become dark). Black or white always reaches WCAG
// AA's 4.5:1 on any fill, so text can always be repaired without touching the site's colours.
//
// The fill used to move instead: TheGlamourAddict's copy (Nov 24 2026) turned every product and blog card from her
// #ff8091 to a pale #ffd5dc, and her testimonial band to #b55965, to fix a grey maker line, grey prices and white
// quotes. `reversed` says the text had to turn: such a colour suits only the place it was measured in.
export function readableTextColour(fgStr, bgStr, minRatio = 4.54, { opacity = 1, ownOpacity = 1, fill = null } = {}) {
  const bg = parseColor(bgStr);
  if (!parseColor(fgStr) || !bg) return null;
  const faded = Number(opacity) > 0 && Number(opacity) < 1;
  const fg = faded ? undrawnColour(fgStr, bgStr, { opacity, fill }) : parseColor(fgStr);
  const at = (alpha) => {
    const shown = (colour) => drawnColour(colour, bg, { opacity: alpha, fill });
    const ratio = (colour) => contrastRatio(shown(parseColor(colour)), bg);
    if (contrastRatio(shown(fg), bg) >= minRatio) return { colour: fg.hex, reversed: false, ratio: ratio(fg.hex) };
    const darker = relativeLuminance(shown(fg)) <= relativeLuminance(bg);
    const own = stepTowards(fg, bg, minRatio, darker, shown);
    if (own) return { colour: own, reversed: false, ratio: ratio(own) };
    const other = stepTowards(fg, bg, minRatio, !darker, shown);
    return other ? { colour: other, reversed: true, ratio: ratio(other) } : null;
  };
  const kept = at(faded ? Number(opacity) : 1);
  if (kept || !faded) return kept;
  // No colour reads through the fade: the text's own fade is lifted, its ancestors' kept.
  const own = Number(ownOpacity);
  if (!(own > 0 && own < 1)) return null;
  const lifted = at(Math.min(1, Number(opacity) / own));
  return lifted ? { ...lifted, opaque: true } : null;
}

// ── Never worse ─────────────────────────────────────────────────────────────

// NO COLOUR REPAIR MAY LEAVE TEXT HARDER TO READ THAN IT WAS (Hale & Okafor Family Law rehearsal, Nov 25 2026). A rule
// chosen on one page's /contact/ button made the same button on four other pages 1.14:1 (pageState above). Whatever
// chose a colour, it is re-checked against every backdrop the text was measured on before it is written: text that
// failed must read better than it did, and text that passed must still pass. A colour that cannot do both for every
// measurement is not written; the failure stays reported and goes to the review repair.
//
// A measurement is what axe saw: { fg, bg, ratio, expected } plus the fade (opacity, ownOpacity, fill) when the text is
// faded. `fg` is then axe's blend, and the new colour is drawn through the same fade (drawnColour).
export function contrastAfter(colour, measurement, { opaque = false } = {}) {
  const front = parseColor(colour);
  const back = parseColor(measurement?.bg);
  if (!front || !back) return null;
  const alpha = Number(measurement.opacity);
  const faded = alpha > 0 && alpha < 1;
  const own = Number(measurement.ownOpacity) > 0 ? Number(measurement.ownOpacity) : 1;
  const fade = faded ? { opacity: opaque ? Math.min(1, alpha / own) : alpha, fill: measurement.fill || null } : {};
  return contrastRatio(drawnColour(front, back, fade), back);
}

// The contrast the measurement had: its own colours when both are known, else the ratio axe printed.
function contrastBefore(measurement) {
  const front = parseColor(measurement?.fg);
  const back = parseColor(measurement?.bg);
  if (front && back) return contrastRatio(front, back);
  const printed = Number(measurement?.ratio);
  return Number.isFinite(printed) && printed > 0 ? printed : null;
}

// True when `colour` leaves every measured text no worse: failing text reads better, passing text still passes.
// A measurement that cannot be read proves nothing either way and is passed over.
export function neverWorse(colour, measurements = [], { opaque = false } = {}) {
  if (!parseColor(colour)) return false;
  for (const measurement of measurements || []) {
    const before = contrastBefore(measurement);
    const after = contrastAfter(colour, measurement, { opaque });
    if (before === null || after === null) continue;
    const expected = Number(measurement.expected) > 0 ? Number(measurement.expected) : 4.5;
    if (before < expected ? after <= before + 0.005 : after < expected) return false;
  }
  return true;
}

// A rule's measurements in one list, each backdrop once, capped so it can travel with the rule in a job result.
const MEASUREMENTS_PER_RULE = 6;
function measurementsOf(rules) {
  const seen = new Map();
  for (const rule of rules || []) {
    for (const measurement of Array.isArray(rule?.measured) ? rule.measured : []) {
      if (!parseColor(measurement?.bg)) continue;
      const key = `${parseColor(measurement.fg)?.hex || measurement.ratio}|${parseColor(measurement.bg).hex}|${measurement.opacity || 1}`;
      if (!seen.has(key)) seen.set(key, measurement);
    }
  }
  // The failing ones first: they are the ones a cap must never drop.
  return [...seen.values()].sort((a, b) => (contrastBefore(a) || 0) - (contrastBefore(b) || 0)).slice(0, MEASUREMENTS_PER_RULE);
}

const declaredColour = (declaration) => (/^color:/.test(String(declaration || "")) ? /#[0-9a-f]{6}\b/i.exec(declaration)?.[0] || null : null);

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
          html: node.html || "",
          // What the scan saw fading the text (scanPage): axe's foreground is then a blend, not a colour any rule wrote.
          ...(fadedText(node) ? { opacity: Number(node.opacity) } : {})
        });
      }
    }
  }
  return failures;
}

// Text drawn at an opacity below 1 by itself or an ancestor, as the scan measured it.
const fadedText = (node) => Number(node?.opacity) > 0 && Number(node.opacity) < 1;
// The fade the scan measured for a node, in the shape readableTextColour takes.
const fadeOf = (node) => (fadedText(node) ? { opacity: Number(node.opacity), ownOpacity: Number(node.ownOpacity) || 1, fill: node.fill || null } : {});

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
// Faded text no colour can make readable has its own fade lifted (readableTextColour), always with !important: an
// opacity that stays below 1 would leave the repair writing the same rule every round.
const ALLOWED_DECLARATION = /^(?:(?:background-)?color: #[0-9a-f]{6}(?: !important)?|opacity: 1 !important|text-decoration: underline !important)$/;
// A declaration that changes how one place's text looks, and so must name that place (specificEnough, reachesWholeClass).
const PLACED_DECLARATION = /^(?:(?:background-)?color|opacity):/;

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
// A rule held to one place on the page: an element's id or a block. Text that had to turn from light to dark (or back)
// may take its colour from such a rule; a rule for a kind of text anywhere also colours it where the old colour read.
const namesPlace = (selector) => /#[A-Za-z_-]|\[data-ww-block=/.test(String(selector || ""));
// A source rule held to the fill it was measured on: what it colours on that fill (or the fill itself), nowhere else.
// TheGlamourAddict's grey dates (.article__date) failed on her pink cards (.card__info); on her cream article pages the
// same rule's grey reads, and keeps her colour. Its specificity is the source rule's own. A rule already held to one
// place (her testimonial band's #QuotesSection) needs no more.
const onFill = (selector, fill) => {
  if (!fill || fill === selector || namesPlace(selector)) return selector;
  const held = `${selector}:where(${fill}, ${fill} *)`;
  return isSafeOverrideSelector(held) ? held : selector;
};

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

// axe names some elements only by their editor label (a[data-ww-label="Menu button: Send an enquiry"]), which
// repeats across unrelated elements, so specificEnough drops the rule and the failure is never repaired. The
// element's own edit id (data-ww-edit) is unique to it, the shared header and footer included: name that instead.
// Larkfield Bike Repair, Nov 11 2026: the header button's dark-on-blue text was left failing on every page.
function placedTarget(selector, html) {
  if (specificEnough(selector)) return selector;
  return ownTarget(html) || selector;
}

// The failing element's own edit id, from its opening tag only (a child's id is not the element's), held to the state
// it was measured in (pageState), or null.
export function ownTarget(html) {
  const source = String(html || "").trim();
  const edit = /^<[^>]*\bdata-ww-edit="([\w:.-]{1,120})"/i.exec(source)?.[1];
  if (!edit) return null;
  const tag = /^<([a-z][a-z0-9-]*)/i.exec(source)?.[1]?.toLowerCase() || "";
  return `${tag}[data-ww-edit="${edit}"]${pageState(source)}`;
}

// ONE ELEMENT, A DIFFERENT FILL ON ONE PAGE (staging rehearsal, Nov 25 2026, about 11 PM Central). Hale & Okafor Family
// Law's header button "Book Consultation" links to /contact/. On that page the framework marks it aria-current="page",
// and the site's `.nav-list li a[aria-current="page"]` gives it the pale #e5edf8 fill; on the other four pages it is the
// blue #2c5cab button. Its edit id is the same everywhere, so a rule chosen on one page reached it on all of them: the
// first round made it #d6d9df for the blue (and 1.19:1 on /contact/), the next chose #646769 on /contact/, which left
// the four blue buttons at 1.14:1, and the next went back to #d8d9d9. A link to one of the site's pages is the current
// link on exactly one page, so a rule measured on it says which: [aria-current] where it is current, :not([aria-current])
// where it is not. The colour then reaches only the button with the fill it was chosen on.
function pageState(html) {
  const open = /^<[^>]*(?:>|$)/.exec(String(html || "").trim())?.[0] || "";
  if (/\saria-current(?:\s*=\s*"(?!false")[^"]*"|(?=[\s/>]|$))/i.test(open)) return "[aria-current]";
  const tag = /^<([a-z][a-z0-9-]*)/i.exec(open)?.[1]?.toLowerCase();
  const href = /\shref\s*=\s*"([^"]*)"/i.exec(open)?.[1];
  return tag === "a" && typeof href === "string" && /^\/(?!\/)/.test(href) ? ":not([aria-current])" : "";
}

// The measured element's selector held to its page state, unless the selector already says it.
function inPageState(selector, html) {
  const state = pageState(html);
  return !state || !selector || /\[aria-current\b/.test(selector) ? selector : `${selector}${state}`;
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
      // The failing text takes the nearest shade that reads; the background is the site's own and is never written
      // (a card's or a band's fill is shared by everything on it, and is the site's look).
      // Faded text is given the colour that reads once faded (readableTextColour); its own fade is lifted only when no
      // colour can (`opaque`), and that opacity rule goes wherever its colour rule goes.
      const readable = readableTextColour(fg, bg, expected + 0.04, fadeOf(node));
      if (!readable || readable.ratio < expected) continue;
      const color = readable.colour.toLowerCase();
      // What was measured travels with the rule, so every later step can prove it never worse (neverWorse).
      const printed = Number(/contrast of ([\d.]+)/i.exec(summary)?.[1]);
      const seen = { fg: parseColor(fg).hex, bg: parseColor(bg).hex, ratio: printed > 0 ? printed : Math.round(contrastRatio(fg, bg) * 100) / 100, expected, ...fadeOf(node) };
      if (!seen.fill) delete seen.fill;
      const lift = (rule) => {
        const proved = { ...rule, measured: [seen], ...(readable.opaque ? { opaque: true } : {}) };
        return readable.opaque ? [proved, { ...proved, declaration: "opacity: 1 !important" }] : [proved];
      };
      const measured = targetText(node.colourTarget || node.scopedTarget || node.target);
      // The measured element only in the page state it was measured in (pageState); a class carrier is not the element.
      const exact = node.colourTarget ? measured : inPageState(node.scopedTarget ? measured : placedTarget(measured, node.html), node.html);
      // EVERY FAILING ELEMENT GETS ITS FIX (owner, Nov 11 2026: "Dont let things fail but force it to be fixed"). Where
      // the colour comes from a class other elements share, the class is never recoloured; the element's own edit id,
      // which nothing else carries, takes the colour instead, so white text over a photo elsewhere keeps its colour.
      const own = ownTarget(node.html);
      const onOwn = () => { if (own) rules.push(...lift({ selector: own, exact: own, declaration: `color: ${color} !important` })); };
      // A source rule fixes every element it colours in one round. A colour that had to turn (white words made dark)
      // goes on it only when the rule is held to the measured place; otherwise the measured element takes it below.
      if (node.colourRule && !node.colourTarget && (!readable.reversed || namesPlace(node.colourRule))) {
        if (reachesWholeClass(node.colourRule)) { onOwn(); continue; }
        const held = onFill(node.colourRule, node.backgroundRule);
        rules.push(...lift({ selector: held, exact: held, declaration: `color: ${color}`, sourceRule: true }));
        continue;
      }
      // The colour sits on a class that other elements carry. Only the scan's colourTarget proves each carrier in
      // its place failed; a bare class (an older scan, or axe's own selector) would recolour text that passes
      // where this one fails, so the page's own repair handles it instead.
      if (sharedClassSubject(exact) && !(node.colourTarget && anchored(exact))) { onOwn(); continue; }
      rules.push(...lift({ selector: exact.replace(POSITIONAL, "").replace(/\s+/g, " ").trim(), exact, declaration: `color: ${color} !important` }));
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
// Every colour written is then held to the floor (neverWorse) against what all the rules asking for it measured: the
// first colour they asked for that leaves none of that text worse is written, and none is written when no colour can.
export function consolidateOverrideRules(rules = []) {
  const groups = new Map();
  for (const rule of rules || []) {
    if (!rule || !ALLOWED_DECLARATION.test(String(rule.declaration || ""))) continue;
    const key = `${rule.selector}\u0000${rule.declaration.split(":")[0]}`;
    groups.set(key, [...(groups.get(key) || []), rule]);
  }
  // What each written rule will be, every rule that asked for it, and the declarations to try, best first. A later
  // rule for the same place used to replace an earlier one outright; its declaration is now tried first instead.
  const out = new Map();
  const place = (rule, from, options) => {
    const key = `${rule.selector}\u0000${rule.declaration.split(":")[0]}`;
    const entry = out.get(key);
    if (!entry) { out.set(key, { rule, from: [...from], options: [...new Set(options)] }); return; }
    entry.rule = rule;
    entry.from.push(...from);
    entry.options = [...new Set([...options, ...entry.options])];
  };
  for (const list of groups.values()) {
    // One source colour rule failing against different backgrounds needs the colour that passes on all of them.
    if (list[0].sourceRule) {
      if (!isSafeOverrideSelector(list[0].selector) || reachesWholeClass(list[0].selector)) continue;
      const property = list[0].declaration.split(":")[0];
      const rule = { selector: list[0].selector, exact: list[0].selector, declaration: list[0].declaration, sourceRule: true };
      if (property === "opacity") { place(rule, list, [rule.declaration]); continue; }
      const lightness = (each) => relativeLuminance(parseColor(/#[0-9a-f]{6}/i.exec(each.declaration)[0]));
      const ordered = [...list].sort((a, b) => lightness(a) - lightness(b));
      // Dark text was darkened and light text lightened; the furthest move passes everywhere the others did.
      const furthest = lightness(ordered[0]) < 0.5 ? ordered : [...ordered].reverse();
      place({ ...rule, declaration: furthest[0].declaration }, list, furthest.map((each) => each.declaration));
      continue;
    }
    const agreed = new Set(list.map((rule) => rule.declaration)).size === 1;
    const chosen = agreed ? [list[0]] : list.map((rule) => ({ ...rule, selector: rule.exact || rule.selector }));
    for (const candidate of chosen) {
      // A colour on a bare element selector would recolour that element everywhere, including where it already passes;
      // an opacity there would un-fade it everywhere.
      const rule = /^(?:color|opacity):/.test(candidate.declaration) && !specificEnough(candidate.selector)
        ? { ...candidate, selector: specificEnough(candidate.exact || "") ? candidate.exact : "" }
        : candidate;
      if (!isSafeOverrideSelector(rule.selector)) continue;
      place({ selector: rule.selector, exact: rule.exact || rule.selector, declaration: rule.declaration }, agreed ? list : [candidate], [rule.declaration]);
    }
  }
  const written = [];
  for (const { rule, from, options } of out.values()) {
    const measured = measurementsOf(from);
    const opaque = from.some((each) => each.opaque);
    const declaration = declaredColour(rule.declaration) && measured.length
      ? options.find((option) => neverWorse(declaredColour(option), measured, { opaque }))
      : rule.declaration;
    if (!declaration) continue;
    written.push({ ...rule, declaration, ...(measured.length ? { measured } : {}), ...(opaque ? { opaque: true } : {}) });
  }
  // A lifted fade belongs to the colour chosen with it: where the floor wrote no colour, the opacity is not written either.
  const coloured = new Set(written.filter((rule) => declaredColour(rule.declaration)).map((rule) => rule.selector));
  return written.filter((rule) => !/^opacity:/.test(rule.declaration) || !rule.measured || coloured.has(rule.selector));
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
  // The edit-time repair applies rules a scan measured some time before: a colour that would leave any text it was
  // measured on worse is refused here as well (neverWorse), and the fade lifted with it stays.
  const refused = new Set((rules || []).filter((rule) => declaredColour(rule?.declaration) && Array.isArray(rule.measured) && rule.measured.length
    && !neverWorse(declaredColour(rule.declaration), rule.measured, { opaque: Boolean(rule.opaque) })).map((rule) => rule.selector));
  for (const rule of rules || []) {
    if (!isSafeOverrideSelector(rule?.selector) || !ALLOWED_DECLARATION.test(String(rule?.declaration || ""))) continue;
    // Rules from an earlier builder may still name a whole generated class; they are not written.
    if (PLACED_DECLARATION.test(rule.declaration) && reachesWholeClass(rule.selector)) continue;
    if (refused.has(rule.selector) && (declaredColour(rule.declaration) || (/^opacity:/.test(rule.declaration) && rule.measured))) continue;
    const key = `${rule.selector}\u0000${rule.declaration.split(":")[0]}`;
    if (existing.get(key)?.declaration === rule.declaration) continue;
    existing.set(key, { selector: rule.selector, declaration: rule.declaration });
    changed.push(rule);
  }
  if (!changed.length) return { css: source, changed };
  // Forced colours on selectors that turned out to reach unrelated elements (a breadcrumb colour on buttons
  // sharing an editor label) stopped repairs converging; the failures they fixed are repaired at their source.
  for (const [key, rule] of existing) {
    if (/^(?:color: #[0-9a-f]{6}|opacity: 1) !important$/.test(rule.declaration) && !specificEnough(rule.selector)) existing.delete(key);
    // A colour or fill an earlier round put on a whole generated class reached text nobody measured.
    else if (PLACED_DECLARATION.test(rule.declaration) && reachesWholeClass(rule.selector)) existing.delete(key);
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

// The page's own background: the :root canvas/page/background token, else the body's fill, else white.
function pageBackground(css) {
  const roots = [...String(css).matchAll(/:root\s*\{([^}]*)\}/gi)].map((match) => match[1]).join(";");
  const token = /--[\w-]*(?:canvas|page|paper|bg|background)[\w-]*\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))/i.exec(roots);
  const body = /(?:^|[}\s,])(?:html|body)\s*\{[^}]*?background(?:-color)?\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))/i.exec(String(css));
  return parseColor(token?.[1] || "") || parseColor(body?.[1] || "") || parseColor("#ffffff");
}

// A text colour written once and used everywhere (a theme token or a literal) may only be changed where it is
// written when the new colour still reads on the page itself. Ink that failed on a dark band is otherwise
// lightened for every page (Nov 11: Larkfield Bike Repair's --color-ink went #172338 -> #d9dce1 on #f7f9fc).
function readsOnPage(colour, css) {
  return contrastRatio(colour, pageBackground(css)) >= 4.5;
}

// A contrast failure is about text, so only a text colour is changed for it. A token named for a border, a fill, a
// ring or a shadow holds a colour that is not text even when the value is the same (Flyloop, Nov 25 2026: the
// literal replacement below also rewrote .trip-opt-stopover { border-left-color: #c4764f }).
const NON_TEXT_WORDS = new Set(["border", "outline", "shadow", "ring", "divider", "stroke", "bg", "background", "surface",
  "fill", "canvas", "page", "paper", "caret", "decoration", "underline", "scrollbar"]);
const namesNonText = (name) => String(name).toLowerCase().split(/[-_]+/).some((word) => NON_TEXT_WORDS.has(word));

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
      if (namesNonText(varName)) continue;
      const parsed = parseColor(rawVal);
      // A light value (e.g. rgba(255,255,255,.75)) is meant for dark backgrounds; darkening it for white would break them.
      if (parsed && relativeLuminance(parsed) <= 0.5) {
        // Assume default background is white/light unless specified
        const currentRatio = contrastRatio(parsed, "#ffffff");
        if (currentRatio < 4.54) {
          const better = adjustColorForContrast(parsed.hex, "#ffffff", 4.54);
          // Never worse where it is read: on a page that is not white, darker may be harder to read (neverWorse).
          if (!neverWorse(better, [{ fg: parsed.hex, bg: pageBackground(css).hex }])) continue;
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
      // Faded text's measured colour is a blend no stylesheet wrote, and a shade replaced here would be faded again
      // (Larkfield Plumbing & Drain, Nov 25 2026): the measured element takes the colour that reads once faded instead.
      if (fail.opacity) continue;

      if (contrastRatio(parsedFg, parsedBg) < 4.54) {
        const better = adjustColorForContrast(parsedFg.hex, parsedBg.hex, 4.54);

        // Text that cannot reach the ratio by moving further the way it is going (light text on a mid-tone fill) is
        // never fixed here by moving the fill, which is the site's own colour everywhere it is written: the measured
        // element's text takes the nearest readable shade instead (contrastRules, below).
        if (contrastRatio(better, parsedBg) < 4.5) continue;

        // Not readable on the page itself: leave the shared value and override the measured element below.
        if (!readsOnPage(better, css)) continue;

        // Every text measured in this colour is recoloured by the replacement, whatever it was measured on: the new
        // colour must leave each of them no worse (neverWorse), or the measured elements are repaired one by one below.
        const sameColour = contrastFailures.filter((other) => !other.opacity && parseColor(other.fg)?.hex === parsedFg.hex);
        if (!neverWorse(better, sameColour.map((other) => ({ fg: other.fg, bg: other.bg })))) continue;

        // Search for matches in CSS for the hex or 3-digit shorthand
        const candidates = [
          parsedFg.hex,
          `#${parsedFg.hex[1]}${parsedFg.hex[3]}${parsedFg.hex[5]}`.toLowerCase() === parsedFg.hex ? `#${parsedFg.hex[1]}${parsedFg.hex[3]}${parsedFg.hex[5]}` : null,
          `rgb(${parsedFg.r}, ${parsedFg.g}, ${parsedFg.b})`,
          `rgb(${parsedFg.r},${parsedFg.g},${parsedFg.b})`
        ].filter(Boolean);

        for (const candidate of candidates) {
          // The color property itself: never border-left-color, background-color, outline-color or another colour
          // whose name ends the same way.
          const colorPropRegex = new RegExp(`(?<![\\w-])(color\\s*:\\s*)${escapeRegExp(candidate)}([;}\\s])`, "gi");
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
          `(--([\\w-]*(?:ink|title|text|colou?r|muted|fg|foreground|heading|label)[\\w-]*)\\s*:\\s*)(?:${candidates.map(escapeRegExp).join("|")})(?![0-9a-f])`, "gi"
        );
        let tokenChanged = false;
        css = css.replace(tokenRegex, (whole, declaration, name) => {
          if (namesNonText(name)) return whole;
          tokenChanged = true;
          return `${declaration}${better}`;
        });
        if (tokenChanged) {
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
    nodes: (violation.nodes || []).filter((node) => fadedText(node)
      || !replaced.has(parseColor(/foreground color:\s*(#[0-9a-f]{3,6})\b/i.exec(String(node.failureSummary || ""))?.[1] || "")?.hex))
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

// scrollContainers: selectors the site's styles make scroll (scrollContainerSelectors), for a pass with no scan.
export function resolveHtmlA11yIssues(html, violations = [], { titles = null, fragment = false, language: fragmentLanguage = "", scrollContainers = null } = {}) {
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
      matches.each?.((_, el) => focusScrollRegion($, el, changes));
    }
  }
  // ...and, with no scan to name them, every element the page's own styles make a scroll container (see
  // scrollContainerSelectors for why this is decided from the stylesheet before the page is ever drawn).
  if (scrollContainers) {
    for (const selector of scrollContainers) {
      let matches;
      try { matches = $(selector); } catch { continue; }
      matches.each((_, el) => focusScrollRegion($, el, changes, { measured: false }));
    }
    $("[style]").each((_, el) => {
      if (SCROLLING_DECLARATION.test(`;${$(el).attr("style")}`)) focusScrollRegion($, el, changes, { measured: false });
    });
  }

  return { html: $.html(), changes };
}

// ── Scroll containers, before the page is drawn ─────────────────────────────
//
// A SCROLL STRIP THE PAGE WRITER MADE WAS UNREACHABLE BY KEYBOARD (staging rehearsal, Nov 25 2026, about 7 PM Central).
// Stillwater Yoga Studio's home page (build a4004fd1) had a "week at a glance" strip, `.week-glance { overflow-x: auto }`
// holding fourteen classes of plain text. axe failed it as scrollable-region-focusable (serious), the only blocker on the
// page; this file already knew the fix, but only from a scan in the website's own repository after deploy, so the
// preview ended with "/" failed and no repair of any kind.
//
// Decided here, from the stylesheet, rather than in page.qa's browser. page.qa scans the deployed preview and has no
// way to write markup back: its accessibilityRules are stylesheet rules, and tabindex is not one. Assembly is the last
// point every new website and every migration passes before its commit, and it already names controls here
// (repairStaticAccessibility). What it cannot know is whether the content overflows at some width; a container the
// site's own styles declare as scrolling, with nothing focusable inside, is given the tab stop anyway. A tab stop on a
// strip that happens to fit is harmless; a strip that scrolls and cannot be reached fails WCAG 2.1.1. Whatever this
// misses (a container scrolled by a script, a stylesheet it could not read) is still measured by page.qa and handed to
// the review repair with its rule, element and help text (build-handler-finalize.mjs summariseAccessibilityFindings).
// generate-site-build.mjs withGalleryAccessibility did this for one class, .gallery-track; this is the general case.
const SCROLLING_DECLARATION = /[;{\s]overflow(?:-x|-y|-inline|-block)?\s*:\s*[^;}]*\b(?:auto|scroll|overlay)\b/i;
// The element at rest: a state (hover, focus) or a part (a scrollbar) is not where the content scrolls from.
const NOT_AT_REST = /::|:(?:hover|focus|focus-within|focus-visible|active|visited|target|checked)\b/i;
// Anything a keyboard already reaches. axe passes a scroll container holding one of these, so it gets no tab stop.
const KEYBOARD_REACHABLE = "a[href], area[href], button, input:not([type='hidden']), select, textarea, iframe, summary, "
  + "audio[controls], video[controls], [contenteditable]:not([contenteditable='false']), [tabindex]:not([tabindex^='-'])";

// A selector list split at its top-level commas (a comma inside :is() or :not() belongs to the selector).
function selectorList(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of String(text)) {
    if (char === "(" || char === "[") depth += 1;
    else if ((char === ")" || char === "]") && depth) depth -= 1;
    if (char === "," && !depth) { parts.push(current); current = ""; } else current += char;
  }
  return [...parts, current].map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// The selectors of every rule in `css` that makes its element scroll (overflow, overflow-x or overflow-y auto or scroll),
// inside a media query or not: a strip that scrolls only on a phone must be reachable there too.
export function scrollContainerSelectors(css) {
  const selectors = new Set();
  const source = String(css || "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    if (!SCROLLING_DECLARATION.test(`;${match[2]}`)) continue;
    for (const selector of selectorList(match[1])) {
      if (!NOT_AT_REST.test(selector)) selectors.add(selector);
    }
  }
  return [...selectors];
}

// Gives a scroll container a tab stop, unless it needs none or must not have one. `measured` is false for a container
// found from the stylesheet rather than by a scan: then an empty one (a cart drawer a script fills) is left alone too.
function focusScrollRegion($, el, changes, { measured = true } = {}) {
  const $el = $(el);
  const tag = String(el.tagName || "").toLowerCase();
  // The document scrolls by keyboard already, and a table box ignores overflow.
  if (!tag || ["html", "body", "table"].includes(tag)) return;
  if ($el.attr("tabindex") !== undefined || $el.is(KEYBOARD_REACHABLE) || $el.find(KEYBOARD_REACHABLE).length) return;
  // A tab stop inside content hidden from assistive technology is itself a failure (aria-hidden-focus).
  if ($el.closest("[aria-hidden='true'], [inert]").length) return;
  if (!measured && !$el.text().trim() && !$el.find("img, picture, svg, video, canvas").length) return;
  $el.attr("tabindex", "0");
  changes.push({ type: "scrollable_focusable", target: tag });
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
  const stylesheets = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".html")) files.push(full);
      else if (entry.name.endsWith(".css")) stylesheets.push(full);
    }
  };
  await walk(publicDir);
  // What the site's stylesheets make scroll; each page adds its own <style> blocks (pageScrollContainers).
  const siteScrolling = scrollContainerSelectors((await Promise.all(stylesheets.map((file) => readFile(file, "utf8").catch(() => "")))).join("\n"));
  const pageScrollContainers = (html) => {
    const $ = load(html);
    return [...new Set([...siteScrolling, ...scrollContainerSelectors($("style").map((_, style) => $(style).text()).get().join("\n"))])];
  };
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
    const { html, changes } = resolveHtmlA11yIssues(source, [], { titles, fragment: true, language: primaryLanguage, scrollContainers: pageScrollContainers(source) });
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
    const { html, changes } = resolveHtmlA11yIssues(source, [], { titles, fragment, language: fragment ? primaryLanguage : "",
      scrollContainers: pageScrollContainers(source) });
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
