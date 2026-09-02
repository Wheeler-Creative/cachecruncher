// The standard every managed site is held to, wherever the page came from.
//
// WHY IT IS HERE AND NOT IN THE BUILD. These checks lived inside
// verify-generation-output.mjs, which runs only from generate-site-build.mjs -
// the path that creates a site. So every standard below was enforced when a
// site was born and never again: an edit's only gate was page.qa, which asks
// whether the route returns a non-error status at each viewport. Liveness, not
// structure. A year of edits could drift a site arbitrarily far from the
// contract it was built against and nothing would say so.
//
// One module, imported by the builder, the editor and the migrator, so the
// three of them cannot disagree about what a good page is - and so none of them
// has to carry the rules in a prompt and hope.
//
// Everything here is a pure function of one page's HTML, or of the site's own
// files. No model, no network, no browser: these are the deterministic cases
// that should never need a judgement call. The axe WCAG gate still runs in the
// browser for the rest.

import { access } from "node:fs/promises";
import path from "node:path";

// These primitives deliberately live in this module instead of importing the
// generator or migration parser. Managed repositories receive this exact file
// for their GitHub fallback gate; pulling in either heavy build-time module
// would make the fallback fail before it could inspect an edit.
function tagAttr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))
    || tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  return match ? match[1] : "";
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&colon;/gi, ":")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function labelPlaceholders(html) {
  return html.replace(/<div\b[^>]*\bclass\s*=\s*("|')[^"']*\bimage-placeholder\b[^"']*\1[^>]*>/gi, (tag) =>
    /\brole\s*=/i.test(tag) || !/\baria-label\s*=/i.test(tag) ? tag : tag.replace(/^<div\b/i, '<div role="img"'));
}

const LD_JSON = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi;

export function sanitizeManagedHtml(html) {
  const kept = [];
  const withoutStructuredData = String(html || "").replace(LD_JSON, (block) => {
    kept.push(block);
    return `\u0000ld${kept.length - 1}\u0000`;
  });
  const restore = (text) => text.replace(/\u0000ld(\d+)\u0000/g, (_, index) => kept[Number(index)]);

  return restore(labelPlaceholders(withoutStructuredData
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<script[^>]*>/gi, " ")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
    .replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/rel\s*=\s*["']stylesheet["']/i.test(tag)) return tag;
      const href = tagAttr(tag, "href");
      if (!/^(https?:)?\/\//i.test(href)) return tag;
      return /fonts\.(?:googleapis|gstatic)\.com/i.test(href) ? tag : " ";
    })
    .replace(/(href|src)\s*=\s*("|')([^"']*)\2/gi, (match, attribute, quote, value) =>
      /javascript:/i.test(decodeHtmlEntities(value)) ? `${attribute}=${quote}#${quote}` : match)
    .replace(/url\(\s*["']?\s*(?:https?:)?\/\/[^)"']*["']?\s*\)/gi, "none")));
}

export function managedHtmlStructureIssues(html) {
  const source = String(html || "").trim();
  const issues = [];
  const counts = (name) => ({
    open: (source.match(new RegExp(`<${name}\\b`, "gi")) || []).length,
    close: (source.match(new RegExp(`</${name}>`, "gi")) || []).length
  });
  if (!/^<!doctype\s+html/i.test(source)) issues.push("missing HTML5 doctype");
  if (!/<html[\s>]/i.test(source) || !/<\/html>\s*$/i.test(source)) issues.push("document does not end with </html>");
  for (const name of ["html", "head", "body", "style", "main", "section", "form"]) {
    const total = counts(name);
    if (total.open !== total.close) issues.push(`unbalanced <${name}> tags (${total.open} open, ${total.close} close)`);
  }
  return issues;
}

export function managedImageSourcesOutsideAllowlist(html, allowed) {
  const names = allowed instanceof Set ? allowed : new Set(allowed || []);
  const issues = [];
  const inspect = (source, label) => {
    if (!source || /^data:/i.test(source)) return;
    const match = String(source).match(/^\/images\/([^?#]+)/i);
    let name = match?.[1] || "";
    try { name = decodeURIComponent(name); } catch { /* retain exact name */ }
    if (!name || !names.has(name)) issues.push(`${label} ${source}`);
  };
  for (const tag of String(html || "").match(/<(?:img|source)\b[^>]*>/gi) || []) {
    if (/^<img\b/i.test(tag)) inspect(tagAttr(tag, "src"), "img src");
    const srcset = tagAttr(tag, "srcset");
    for (const candidate of srcset.split(",").map((item) => item.trim().split(/\s+/)[0]).filter(Boolean)) {
      inspect(candidate, "srcset");
    }
  }
  return [...new Set(issues)];
}

function classifyIntegration(raw) {
  let host = "";
  try { host = new URL(raw, "https://managed.invalid").hostname.toLowerCase(); } catch { return { type: "", provider: "invalid" }; }
  const result = (type) => ({ type, provider: host });
  if (/(?:googletagmanager\.com|google-analytics\.com|cdn\.amplitude\.com)$/i.test(host)) return result("analytics");
  if (/(?:hs-scripts\.com|hs-analytics\.net|hsadspixel\.net)$/i.test(host)) return result("crm_analytics");
  if (["static.cloudflareinsights.com", "www.clarity.ms", "scripts.clarity.ms", "js-agent.newrelic.com", "bam.nr-data.net"].includes(host)) return result("analytics");
  if (host === "snap.licdn.com" || /(?:statcounter\.com|doubleclick\.net)$/i.test(host)) return result("tracking");
  if (host === "cdn.poynt.net") return result("commerce_tracking");
  return result("");
}

// The one place a managed site keeps its styles, and the one path it is linked
// from. Four existing sites link it four different ways - "./styles.css",
// "./styles.css?v=20260620", "/styles.css", and one that does not link it at
// all while carrying 15kB of inline <style> - which is precisely the drift this
// exists to stop.
export const STYLESHEET_PATH = "/styles.css";

// Google truncates a title around 60 characters and a description around 160.
// Longer is not broken, but it is not what was written either.
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

// Link text that describes nothing. A screen reader user tabbing through links
// hears these with no context, and they are equally useless to a crawler.
const VAGUE_LINK_TEXT = new Set([
  "click here", "here", "read more", "more", "learn more", "this link", "link", "this"
]);

export function attributeValues(html, tagName, attribute) {
  const expression = new RegExp(`<${tagName}\\b[^>]*\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, "gis");
  return [...String(html).matchAll(expression)].map((match) => match[2].trim());
}

export async function localLinkIssues(html, route, siteRoot = null) {
  // Without a site root there is no tree to resolve against, so link
  // existence cannot be judged - the other checks still can.
  if (!siteRoot) return [];
  const issues = [];
  for (const href of attributeValues(html, "a", "href")) {
    // Anything with a URI scheme is not a file in this site, so it is not ours
    // to resolve. This was an allowlist of mailto/tel/https, which meant a
    // perfectly good link failed the build for using a scheme nobody had
    // thought of - and the one that found it was sms:741741, the Crisis Text
    // Line, on a nonprofit's "Links for Help" page. Enumerating schemes is the
    // wrong shape: sms, geo, whatsapp, facetime, callto and skype all belong to
    // sites like these. Detect a scheme generically instead.
    //
    // javascript: is deliberately NOT special-cased here; sanitizeHtml already
    // rejects it above, and duplicating that check would only let the two drift.
    if (!href || href.startsWith("#") || href.startsWith("//")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    let pathname;
    try { pathname = new URL(href, `https://generated.invalid${route}`).pathname; } catch { issues.push(`invalid link ${href}`); continue; }
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    const candidates = relative === ""
      ? ["index.html"]
      : [relative, path.join(relative, "index.html"), `${relative.replace(/\/$/, "")}.html`];
    const resolved = candidates.map((candidate) => path.resolve(siteRoot, "public", candidate));
    if (resolved.some((candidate) => !candidate.startsWith(path.resolve(siteRoot, "public") + path.sep))) {
      issues.push(`unsafe local link ${href}`);
    } else if (!(await Promise.all(resolved.map((file) => access(file).then(() => true).catch(() => false)))).some(Boolean)) {
      issues.push(`missing local link ${href}`);
    }
  }
  return issues;
}

export function formIssues(html) {
  return [...String(html).matchAll(/<form\b[^>]*>/gi)]
    .filter((match) => {
      const action = match[0].match(/\baction\s*=\s*(["'])(.*?)\1/i)?.[2].trim();
      const method = match[0].match(/\bmethod\s*=\s*(["'])(.*?)\1/i)?.[2].trim().toLowerCase() || "get";
      if (!action || action === "#" || /^mailto:/i.test(action)) return true;
      // Generated POST forms may use our Worker endpoint or an explicit HTTPS
      // provider integration. Posting to any other local static route silently
      // reloads a page and loses the visitor's submission.
      return method === "post" && !/^https:\/\//i.test(action) && action.split(/[?#]/)[0] !== "/api/contact";
    })
    .map(() => "form has no deliverable action");
}

// Deliberately does NOT include business_name absence: a page can legitimately
// omit the exact name string (it may live in a logo, an abbreviation, or be
// irrelevant to a legal/privacy page). That signal is reported separately as a
// warning (see below), never as a hard failure.
const PLACEHOLDER_PATTERNS = [
  { pattern: /lorem ipsum/i, label: "lorem ipsum" },
  { pattern: /\bTODO\b/, label: "TODO" },
  { pattern: /your text here/i, label: '"your text here"' },
  { pattern: /\[insert[^\]]*\]/i, label: "bracketed [insert …] copy" },
  { pattern: /\bcompany name\b/i, label: 'unreplaced "Company Name"' }
];

export function placeholderCopyIssues(html) {
  return PLACEHOLDER_PATTERNS
    .filter(({ pattern }) => pattern.test(html))
    .map(({ label }) => `placeholder copy: ${label}`);
}

// Analytics/tracking providers are a policy violation on generated sites: the
// repo deliberately ships no analytics (Cloudflare auto-installs RUM), so a GA
// tag, Meta pixel, Clarity or New Relic beacon that survived sanitisation is a
// defect, not a choice (docs/build-quality-gaps.md defect 8). This runs over the
// ON-DISK file, so a repair pass that reintroduced a tracker is caught here even
// though sanitizeHtml only runs on model output.
export function forbiddenIntegrationIssues(html) {
  const forbiddenTypes = new Set(["analytics", "tracking", "crm_analytics", "commerce_tracking"]);
  const urls = new Set();
  // Every attribute that can carry a third-party URL: scripts, images, links,
  // iframes, forms, and CSS url() references.
  for (const match of String(html).matchAll(/(?:src|href|action|data|poster)\s*=\s*["']([^"']+)["']/gi)) {
    if (/^(?:https?:)?\/\//i.test(match[1])) urls.add(match[1]);
  }
  for (const match of String(html).matchAll(/url\(\s*["']?\s*(?:https?:)?\/\/([^)"']+)/gi)) urls.add(`https://${match[1]}`);
  const issues = [];
  for (const raw of urls) {
    const classified = classifyIntegration(raw);
    if (forbiddenTypes.has(classified.type)) issues.push(`${classified.type} ${classified.provider}: ${raw}`);
  }
  return issues;
}

// A fixed width far beyond a phone viewport, declared OUTSIDE any @media query,
// will overflow on mobile. Threshold is 800px so legitimate 640px asset widths
// and the responsive max-width:100% reset do not trigger. min-width over the
// threshold is likewise a hard overflow on a 390px screen. @media blocks are
// stripped first so a desktop-only width inside a breakpoint is not a defect.
export function mobileOverflowIssues(html) {
  const withoutMedia = String(html).replace(/@media\b[\s\S]*?\{[^}]*\}/gi, "");
  const hits = [...withoutMedia.matchAll(/(?:^|[\s;{])(min-)?width\s*:\s*(\d{3,})px/gi)]
    .map((match) => ({ min: Boolean(match[1]), value: Number(match[2]) }))
    .filter(({ value }) => value > 800)
    .map(({ min, value }) => `${min ? "min-" : ""}width:${value}px`);
  return hits;
}

// An <img> with NO alt attribute at all is a deterministic missing-alt defect
// (an empty alt="" is valid and deliberately allowed for decorative images).
export function missingAltIssues(html) {
  const issues = [];
  for (const match of String(html).matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt\s*=/i.test(match[0])) issues.push(`<img> without alt attribute`);
  }
  return issues;
}

// A form control with no accessible name: no aria-label/aria-labelledby, no
// <label for="id">, and not wrapped in a <label>. Hidden and button-like inputs
// (submit/button/reset/hidden/image) are exempt — they carry no user-supplied
// value to describe. A placeholder does NOT count (docs: a placeholder is not a
// label), so a placeholder-only control is still flagged.
export function unlabelledControlIssues(html) {
  const source = String(html);
  const issues = [];
  const labelForIds = new Set([...source.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  // Positions of <label ...> and </label> to detect wrapping labels.
  const labelStarts = [...source.matchAll(/<label\b/gi)].map((m) => m.index);
  const labelEnds = [...source.matchAll(/<\/label\s*>/gi)].map((m) => m.index);
  const wrapped = (index) => {
    const open = labelStarts.filter((i) => i < index).length;
    const close = labelEnds.filter((i) => i < index).length;
    return open > close;
  };
  const exemptTypes = /^(hidden|submit|button|reset|image)$/i;
  for (const match of source.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = match[0];
    if (/type\s*=\s*["']?(hidden|submit|button|reset|image)/i.test(tag)) continue;
    if (/\baria-label\s*=/i.test(tag) || /\baria-labelledby\s*=/i.test(tag)) continue;
    const id = (tag.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (id && labelForIds.has(id)) continue;
    if (wrapped(match.index)) continue;
    issues.push(`<${match[1]}> without an accessible name`);
  }
  return issues;
}

// ---- Landmarks and headings ------------------------------------------------

// One main landmark, one h1, and no skipped heading levels. All three are
// WCAG-adjacent and all three are what makes a page editable: an edit that
// targets "the main content" needs exactly one place that means.
export function landmarkIssues(html) {
  const source = String(html);
  const issues = [];

  const mains = (source.match(/<main\b/gi) || []).length;
  if (mains !== 1) issues.push(mains ? `${mains} <main> landmarks, expected exactly 1` : "no <main> landmark");

  const h1s = (source.match(/<h1\b/gi) || []).length;
  if (h1s !== 1) issues.push(h1s ? `${h1s} <h1> headings, expected exactly 1` : "no <h1>");

  const levels = [...source.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]));
  let previous = 0;
  for (const level of levels) {
    // Going deeper by more than one step leaves a gap a screen reader reads as
    // a missing section.
    if (previous && level > previous + 1) {
      issues.push(`heading level jumps from h${previous} to h${level}`);
      break;
    }
    previous = level;
  }
  return issues;
}

// ---- The document itself ---------------------------------------------------

function firstMatch(html, pattern) {
  const match = String(html).match(pattern);
  return match ? match[1].trim() : "";
}

// What every page owes a browser and a crawler. Absent is a defect; overlong is
// reported because the tail will be truncated in results, so the words after
// the limit were written for nobody.
export function documentIssues(html, { route = "/", origin = "" } = {}) {
  const source = String(html);
  const issues = [];

  if (!/<html\b[^>]*\blang\s*=\s*["'][a-z]{2}/i.test(source)) issues.push("<html> has no lang attribute");
  if (!/<meta\b[^>]*\bname\s*=\s*["']viewport["']/i.test(source)) issues.push("no viewport meta, so the page is not mobile-friendly");

  const title = firstMatch(source, /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!title) issues.push("no <title>");
  else if (title.length > TITLE_MAX) issues.push(`<title> is ${title.length} characters; over ${TITLE_MAX} is truncated in search results`);

  const description = firstMatch(source, /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i);
  if (!description) issues.push("no meta description");
  else if (description.length > DESCRIPTION_MAX) issues.push(`meta description is ${description.length} characters; over ${DESCRIPTION_MAX} is truncated`);

  // A canonical in the markup is optional, and for a managed site it is the
  // wrong place: the generator cannot know whether this site will be reached on
  // its *.workers.dev preview or a custom domain, and a canonical naming the
  // preview would tell Google to deindex the real domain the day it is
  // attached. The worker sends Link: rel="canonical" per request instead, which
  // Google reads identically. So a canonical here is checked if present and
  // never required.
  const canonical = firstMatch(source, /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*\bhref\s*=\s*["']([^"']*)["']/i);
  if (canonical) {
    if (!/^https:\/\//i.test(canonical)) issues.push(`canonical "${canonical}" is not an absolute https URL`);
    else if (origin && canonical !== `${origin.replace(/\/+$/, "")}${route}`) {
      issues.push(`canonical "${canonical}" does not point at this page`);
    }
  }
  return issues;
}

// What a page's response has to carry, checked where the origin is known. The
// canonical lives here rather than in the markup, so this is where its absence
// is a defect.
export function servedPageIssues(headers, { url = "" } = {}) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]) || "";
  const link = get("link");
  const issues = [];
  const canonical = /<([^>]+)>\s*;\s*rel\s*=\s*"?canonical"?/i.exec(link);
  if (!canonical) issues.push('no Link: rel="canonical" header');
  else if (url && canonical[1] !== url) issues.push(`canonical header "${canonical[1]}" does not point at ${url}`);
  return issues;
}

// Open Graph, so a link shared to a phone renders as something other than a
// bare URL. Every managed site is a small business whose customers share links.
export function socialMetaIssues(html) {
  const source = String(html);
  return ["og:title", "og:description", "og:image"]
    .filter((property) => !new RegExp(`property\\s*=\\s*["']${property}["']`, "i").test(source))
    .map((property) => `no ${property} meta`);
}

// One JSON-LD block describing the business. This is the single highest-value
// thing a small business site can carry for Google: it is what puts a name,
// address and phone number into a knowledge panel rather than leaving Google to
// guess them out of the copy.
export function structuredDataIssues(html) {
  const blocks = [...String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  if (!blocks.length) return ["no JSON-LD structured data describing the business"];

  const issues = [];
  let describesBusiness = false;
  for (const [, body] of blocks) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { issues.push("JSON-LD block is not valid JSON"); continue; }
    for (const entry of [].concat(parsed["@graph"] || parsed)) {
      const type = String(entry?.["@type"] || "");
      if (/Organization|LocalBusiness|ProfessionalService|Person/i.test(type)) describesBusiness = true;
    }
  }
  if (!describesBusiness) issues.push("JSON-LD does not describe an Organization or LocalBusiness");
  return issues;
}

// ---- Styles ----------------------------------------------------------------

// One stylesheet, at one path, and nothing styling the page from inside it.
//
// Inline styles are what make an edit unpredictable: the same visual change can
// land in a class, an attribute or a <style> block, so nothing can reason about
// where a site's appearance comes from. They are also how one real site ended
// up with 15kB of CSS in its head and a pinned, checksummed styles.css that the
// page never loads.
export function styleIssues(html) {
  const source = String(html);
  const issues = [];

  const blocks = (source.match(/<style\b/gi) || []).length;
  if (blocks) issues.push(`${blocks} inline <style> block(s); styles belong in ${STYLESHEET_PATH}`);

  const attributes = (source.match(/\sstyle\s*=\s*["']/gi) || []).length;
  if (attributes) issues.push(`${attributes} style="" attribute(s); styles belong in ${STYLESHEET_PATH}`);

  const sheets = attributeValues(source, "link", "href")
    .filter((href) => /\.css(\?|$)/i.test(href));
  const own = sheets.filter((href) => !/^https?:\/\//i.test(href));
  if (!own.length) issues.push(`the page does not link ${STYLESHEET_PATH}`);
  else {
    const wrong = own.filter((href) => href.split("?")[0] !== STYLESHEET_PATH);
    if (wrong.length) issues.push(`stylesheet linked as ${wrong.join(", ")}; the canonical path is ${STYLESHEET_PATH}`);
    if (own.length > 1) issues.push(`${own.length} local stylesheets; a managed site has one`);
  }
  return issues;
}

// The stylesheet itself. !important is the reliable signal that the cascade has
// been fought rather than used, and it makes every later edit harder.
export function stylesheetIssues(css) {
  const source = String(css || "");
  const issues = [];
  const bangs = (source.match(/!\s*important/gi) || []).length;
  if (bangs) issues.push(`${bangs} use(s) of !important`);
  if (!/:root\s*\{[^}]*--/.test(source)) {
    issues.push("no design tokens in :root, so colours and spacing cannot be changed in one place");
  }
  return issues;
}

// ---- Images ----------------------------------------------------------------

// An image with no intrinsic size makes the page jump as it loads, which is a
// Core Web Vitals failure (cumulative layout shift) and the most common reason
// a generated site feels cheap on a phone.
export function imageDimensionIssues(html) {
  const issues = [];
  for (const match of String(html).matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const sized = (/\bwidth\s*=/i.test(tag) && /\bheight\s*=/i.test(tag)) || /aspect-ratio/i.test(tag);
    if (!sized) issues.push("<img> without width/height or aspect-ratio, which will shift the layout as it loads");
  }
  return issues;
}

// ---- Links -----------------------------------------------------------------

// Two things a link owes: somewhere safe to open, and text that says where it
// goes. "Click here" is read aloud with no context by a screen reader and
// carries nothing to a crawler.
export function linkQualityIssues(html) {
  const source = String(html);
  const issues = [];

  for (const match of source.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/target\s*=\s*["']_blank["']/i.test(tag)) continue;
    if (!/\brel\s*=\s*["'][^"']*noopener/i.test(tag)) {
      issues.push('a target="_blank" link without rel="noopener"');
      break;
    }
  }
  for (const match of source.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const text = match[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (text && VAGUE_LINK_TEXT.has(text)) {
      issues.push(`link text "${text}" does not say where it goes`);
      break;
    }
  }
  return issues;
}

// ---- The site's own files --------------------------------------------------

// A sitemap must list every route, or the pages missing from it are the pages
// Google does not know exist.
//
// It deliberately does NOT require absolute <loc> values on disk. The protocol
// does require them, but a managed site is served on both a *.workers.dev
// preview and a custom domain, so no single origin can be baked into the file
// at build time. The generated worker rewrites each <loc> against the request
// origin instead, which is the correct answer and better than guessing - so
// this checks coverage here and absoluteness in what is actually served.
export function sitemapFileIssues(xml, { routes = [] } = {}) {
  const source = String(xml || "");
  if (!source.trim()) return ["no sitemap.xml"];

  const locations = [...source.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => match[1]);
  const paths = new Set(locations.map((location) => {
    try { return new URL(location, "https://generated.invalid").pathname; } catch { return location; }
  }));
  const missing = routes.filter((route) => !paths.has(route));
  return missing.length ? [`sitemap is missing ${missing.join(", ")}`] : [];
}

// What a crawler actually receives. Here absoluteness is required, because by
// this point the origin is known.
export function servedSitemapIssues(xml, { origin = "" } = {}) {
  const source = String(xml || "");
  if (!source.trim()) return ["the sitemap served nothing"];
  const locations = [...source.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => match[1]);
  const issues = [];
  const relative = locations.filter((location) => !/^https?:\/\//i.test(location));
  if (relative.length) {
    issues.push(`the served sitemap has relative <loc> entries (${relative.slice(0, 3).join(", ")}); the protocol requires absolute URLs`);
  }
  if (origin) {
    const base = origin.replace(/\/+$/, "");
    const foreign = locations.filter((location) => /^https?:\/\//i.test(location) && !location.startsWith(base));
    if (foreign.length) issues.push(`the served sitemap points off-site (${foreign.slice(0, 3).join(", ")})`);
  }
  return issues;
}

// robots.txt exists to point a crawler at the sitemap. Without the directive
// the sitemap is only found by guessing.
export function robotsIssues(txt, { origin = "" } = {}) {
  const source = String(txt || "");
  if (!source.trim()) return ["no robots.txt"];
  const issues = [];
  if (!/^\s*sitemap\s*:/im.test(source)) issues.push("robots.txt does not point at the sitemap");
  else if (origin) {
    const declared = firstMatch(source, /^\s*sitemap\s*:\s*(\S+)/im);
    if (declared && !declared.startsWith(origin.replace(/\/+$/, ""))) {
      issues.push(`robots.txt sitemap "${declared}" is not on this site`);
    }
  }
  if (/^\s*disallow\s*:\s*\/\s*$/im.test(source)) issues.push("robots.txt disallows the whole site");
  return issues;
}

// ---- One page, every rule --------------------------------------------------

// What the builder, the editor and the migrator all call. Split into hard
// failures and warnings so a standard can be introduced without every existing
// site failing on the day it lands.
export async function pageStandardsFindings(html, { route = "/", origin = "", allowedImageNames = null, siteRoot = null } = {}) {
  const failures = [
    ...managedHtmlStructureIssues(html),
    ...landmarkIssues(html),
    ...styleIssues(html),
    ...documentIssues(html, { route, origin }),
    ...await localLinkIssues(html, route, siteRoot),
    ...formIssues(html),
    ...missingAltIssues(html),
    ...unlabelledControlIssues(html),
    ...placeholderCopyIssues(html),
    ...forbiddenIntegrationIssues(html),
    ...mobileOverflowIssues(html),
    ...(allowedImageNames ? managedImageSourcesOutsideAllowlist(html, allowedImageNames) : [])
  ];
  if (sanitizeManagedHtml(html) !== html) failures.push("contains active content forbidden in a managed static site");

  const warnings = [
    ...imageDimensionIssues(html),
    ...linkQualityIssues(html),
    ...socialMetaIssues(html),
    ...structuredDataIssues(html)
  ];
  return { failures, warnings };
}

// ---- Introducing a standard to sites that predate it -----------------------

// An edit may not make a page worse. It does not have to fix what was already
// wrong.
//
// WHY IT IS A COMPARISON AND NOT A THRESHOLD. Every existing managed site fails
// something here on the day this lands: one carries 15kB of inline <style> and
// never links its stylesheet, another links it as "./styles.css?v=20260620",
// a third has a target="_blank" with no rel="noopener", none of them size their
// images, and only one carries any JSON-LD at all. Held to the full standard as
// a gate, every edit to every site would fail immediately and the standard
// would be switched off within the day.
//
// So the gate is the delta. A site is brought up to the standard when it is
// rebuilt - which is when the generator can do it properly - and in the
// meantime no edit is allowed to add a new violation. The same principle the
// page-addition rules use for moved content: what was already there is not the
// change under review.
export async function standardsRegressions(before, after, options = {}) {
  const [was, now] = await Promise.all([
    pageStandardsFindings(before, options),
    pageStandardsFindings(after, options)
  ]);

  // Compared as multisets, not sets: a page that had one unsized image and now
  // has four has regressed, even though the wording of the finding is identical.
  const introduced = (previous, current) => {
    const counts = new Map();
    for (const finding of previous) counts.set(finding, (counts.get(finding) || 0) + 1);
    const added = [];
    for (const finding of current) {
      const remaining = counts.get(finding) || 0;
      if (remaining) counts.set(finding, remaining - 1);
      else added.push(finding);
    }
    return added;
  };

  return {
    failures: introduced(was.failures, now.failures),
    warnings: introduced(was.warnings, now.warnings),
    // What the page was already carrying, so it can be reported without being
    // charged to this edit.
    preexisting: { failures: was.failures, warnings: was.warnings }
  };
}
