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

import { load } from "cheerio";
import { access } from "node:fs/promises";
import path from "node:path";
import { faqUnreadableIssues } from "./faq-marks-lib.mjs";

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

// An external stylesheet a managed page is allowed to load.
//
// Web fonts, and nothing else. The generator asks the framework model for a
// Google Fonts <link> by name and puts whatever it returns into every page's
// <head>, and sanitizeManagedHtml has always let those through - so this is
// the site standard, written down once instead of as a regex inside one
// function. pageStyleContractIssues in the generator had its own stricter rule
// ("/styles.css or nothing"), which meant the pipeline forbade on the assembled
// page the exact thing it had asked the model to produce, and every
// site.consistency run failed on it.
const STYLESHEET_HOSTS = /^(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com\//i;

export function isAllowedExternalStylesheet(href) {
  return STYLESHEET_HOSTS.test(String(href || "").trim());
}

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
      return isAllowedExternalStylesheet(href) ? tag : " ";
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

// PARSE THE PAGE, DO NOT PATTERN-MATCH IT.
//
// These checks decide whether a build ships and whether an edit is refused, so
// being approximately right is not good enough. Measured across the 23 pages of
// the three real managed sites, the regex versions disagreed with a parser on
// three checks, and every single time the regex was the one that was wrong:
//
//   styleIssues counted `style="..."` inside a JavaScript string - a page that
//   builds markup with innerHTML was reported as having five inline styles it
//   does not have, and styleIssues is a BLOCKING failure.
//
//   the stylesheet check counted `<link rel="preload" as="style"
//   onload="this.rel='stylesheet'">` as a stylesheet link, because the regex
//   accepted rel='stylesheet' out of the onload attribute. That is the ordinary
//   async-CSS pattern, so a correct page was told it had three stylesheets.
//
// A tolerant parser also matches what a browser does, which is the only opinion
// that counts: it ignores markup inside <script>, closes what the author left
// open, and reads attributes rather than the bytes around them.
export function parseHtml(html) {
  return load(String(html ?? ""));
}

export function attributeValues(html, tagName, attribute) {
  const $ = parseHtml(html);
  return $(tagName)
    .toArray()
    .map((element) => $(element).attr(attribute))
    .filter((value) => typeof value === "string")
    .map((value) => value.trim());
}

// An in-page link that lands nowhere.
//
// localLinkIssues deliberately skips anything starting with "#" - it resolves
// files, and a fragment is not a file. Nothing else looked at them, so on a
// single-page site, which is ENTIRELY navigated by fragments, the whole
// navigation bar was unverified. A customer's "About" button did nothing, and
// every gate passed: verify-generation-output checks that each planned anchor
// id exists in the document, but never that the links point at those ids. So
// id="about-us" with href="#about" satisfied everything and worked for nobody.
//
// Self-contained, like the rest of this module: it ships into customer repos.
export function fragmentLinkIssues(html) {
  const $ = parseHtml(html);
  const ids = new Set();
  // Real ids on real elements. The pattern version also collected an id out of
  // any string that happened to contain id="...", including inside a script.
  $("[id]").each((index, element) => ids.add(String($(element).attr("id"))));
  // <a name="..."> is the older spelling of the same thing and still works.
  $("a[name]").each((index, element) => ids.add(String($(element).attr("name"))));

  const issues = [];
  const seen = new Set();
  const hrefs = $("a[href]").toArray().map((element) => String($(element).attr("href")).trim());
  for (const href of hrefs) {
    if (!href.startsWith("#")) continue;
    const target = href.slice(1);
    // "#" and "#top" both mean the top of the document to a browser, with or
    // without an element to match. Everything else has to resolve.
    if (target === "" ) {
      if (seen.has(href)) continue;
      seen.add(href);
      issues.push('a link to "#", which goes nowhere');
      continue;
    }
    if (target.toLowerCase() === "top") continue;
    const decoded = (() => { try { return decodeURIComponent(target); } catch { return target; } })();
    if (ids.has(target) || ids.has(decoded)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    issues.push(`link to ${href}, which matches no id on the page`);
  }
  return issues;
}

export async function localLinkIssues(html, route, siteRoot = null, fileOverrides = null) {
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
    } else if (!(await Promise.all(resolved.map((file) => fileOverrides?.has(file)
      ? Promise.resolve(fileOverrides.get(file))
      : access(file).then(() => true).catch(() => false)))).some(Boolean)) {
      issues.push(`missing local link ${href}`);
    }
  }
  return issues;
}

export function formIssues(html) {
  const issues = [];
  const $ = load(String(html || ""));
  $("form").each((_, node) => {
    const form = $(node);
    const action = String(form.attr("action") || "").trim();
    const method = String(form.attr("method") || "get").trim().toLowerCase();
    const path = action.split(/[?#]/)[0];
    if (!action || action === "#" || /^mailto:/i.test(action)) {
      issues.push("form has no deliverable action");
      return;
    }
    if (path === "/api/contact") {
      if (method !== "post") issues.push("managed contact form must use POST");
      return;
    }
    if (method !== "post") return;
    if (/^https:\/\//i.test(action)) {
      issues.push("external POST form cannot use the managed verified form check; use a managed form or link to the provider");
      return;
    }
    if (path === "/api/subscribe") {
      const behaviors = String(form.attr("data-ww-behavior") || "").split(/\s+/);
      const hasEmail = form.find('input[type="email"][name="email"][required]').length > 0;
      const hasConsent = form.find('input[type="checkbox"][name="consent"][value="true"][required]').length > 0;
      if (behaviors.includes("subscription-form") && hasEmail && hasConsent) return;
      issues.push("managed subscription form needs its declared behavior, required email and explicit consent");
      return;
    }
    issues.push("form has no deliverable action");
  });
  return issues;
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
// ---- Video -------------------------------------------------------------------
//
// A VIDEO IS STREAMED, NEVER DOWNLOADED. The page names a stored file and the player asks the site for
// it a piece at a time, so a visitor who watches ten seconds fetches ten seconds (the site's own Worker
// answers those ranged requests; see serveMedia in the scaffold). Two things a page can do defeat that
// and make every visitor fetch the whole file: carrying the media inside the page itself, and telling
// the player to fetch all of it before anyone presses play.
const STREAMS_ON_DEMAND = new Set(["metadata", "none"]);
const tagHas = (tag, name) => new RegExp(`\\s${name}(?=[\\s=/>])`, "i").test(tag);
const tagValue = (tag, name) => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : "";
};

export function videoIssues(html) {
  const issues = [];
  for (const match of String(html).matchAll(/<(video|audio|source)\b[^>]*>/gi)) {
    if (/^data:/i.test(tagValue(match[0], "src"))) {
      issues.push(`<${match[1].toLowerCase()}> carries its media inside the page; link the stored file so it is streamed`);
    }
  }
  for (const match of String(html).matchAll(/<video\b[^>]*>/gi)) {
    // One that starts by itself is fetched as it plays.
    if (tagHas(match[0], "autoplay")) continue;
    if (!STREAMS_ON_DEMAND.has(tagValue(match[0], "preload").toLowerCase())) {
      issues.push('<video> without preload="metadata", so a browser may download all of it before anyone plays it');
    }
  }
  return issues;
}

// The same rule, applied. Deterministic like the copyright year, so a page whose author forgot the
// attribute is put right on the way out instead of costing a build.
export function streamVideoOnDemand(html) {
  return String(html).replace(/<video\b[^>]*>/gi, (tag) => {
    if (tagHas(tag, "autoplay") || STREAMS_ON_DEMAND.has(tagValue(tag, "preload").toLowerCase())) return tag;
    const bare = tag.replace(/\spreload(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=[\s/>])/i, "");
    return bare.replace(/^<video\b/i, '<video preload="metadata"');
  });
}

// ---- Frequently asked questions ----------------------------------------------
//
// The rule that marks a page's FAQ so the website's FAQ module can find it is in faq-marks-lib.mjs, which has no
// dependencies of its own beyond cheerio so that the Worker can read it too (src/site-rules.js). It is re-exported here
// because this is the module every stage that writes a page already imports, and managed repositories receive both files.
// Only what the author can act on is a standards finding: a FAQ the list cannot keep (faqUnreadableIssues). A FAQ the
// platform will mark is not, because every stage that writes a page marks it on the way out.
export {
  FAQ_LIMITS, faqListKey, faqMarkIssues, faqRouteForFile, faqUnreadableIssues, markFaqAccordions, markFaqLists, markFaqPage, planFaqLists
} from "./faq-marks-lib.mjs";

export function missingAltIssues(html) {
  const $ = parseHtml(html);
  // :not([alt]) rather than testing the tag text, so an <img> written inside a
  // script string is not counted and an alt spread across a line break is.
  return $("img:not([alt])").toArray().map(() => "<img> without alt attribute");
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
  const $ = parseHtml(html);
  const issues = [];

  // role="main" counts: it is the same landmark to a screen reader, and a page
  // that declares one is not missing one.
  const mains = $("main, [role=main]").length;
  if (mains !== 1) issues.push(mains ? `${mains} <main> landmarks, expected exactly 1` : "no <main> landmark");

  const h1s = $("h1").length;
  if (h1s !== 1) issues.push(h1s ? `${h1s} <h1> headings, expected exactly 1` : "no <h1>");

  // In document order, which is what a screen reader follows - and headings
  // written inside a script string are not headings at all. The page's own
  // outline and the shared chrome around it are checked separately: a footer
  // that opens at h4 is the layout's choice, not a gap in a short page's content.
  const outlines = { content: [], chrome: [] };
  for (const element of $("h1, h2, h3, h4, h5, h6").toArray()) {
    const level = Number(String(element.tagName || element.name).slice(1));
    outlines[$(element).closest("main, [role=main]").length ? "content" : "chrome"].push(level);
  }
  for (const levels of [outlines.content, outlines.chrome]) {
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
  const $ = parseHtml(html);
  const issues = [];

  const blocks = $("style").length;
  if (blocks) issues.push(`${blocks} inline <style> block(s); styles belong in ${STYLESHEET_PATH}`);

  // Elements carrying the attribute, not occurrences of the text. A page that
  // assembles markup in JavaScript contains `style="..."` inside a string, and
  // counting those refused pages that were perfectly correct.
  const attributes = $("[style]").length;
  if (attributes) issues.push(`${attributes} style="" attribute(s); styles belong in ${STYLESHEET_PATH}`);

  // rel is read as an attribute, so the async-CSS preload pattern - which
  // mentions rel='stylesheet' inside its onload handler - is counted once, when
  // it is really a stylesheet, rather than three times.
  const sheets = $("link[rel~=stylesheet]")
    .toArray()
    .map((element) => String($(element).attr("href") || "").trim())
    .filter(Boolean);
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

// The block the accessibility repair writes at the end of a stylesheet (accessibility-fast-agent.mjs): one
// measured fix per line, most of them colours forced with !important. Not authored style, so not counted as it.
const A11Y_OVERRIDES = /\/\* ww-a11y-overrides:(?!end)[^*]*\*\/([\s\S]*?)\/\* ww-a11y-overrides:end \*\//g;
// What a line in that block may be: the repair rewrites the block from lines of exactly this shape, and
// anything else in it is dropped the next time it runs.
const OVERRIDE_LINE = /^[^{}]+ \{ (?:background-color|border-color|color|outline(?:-[a-z]+)?|text-decoration(?:-[a-z]+)?): [^;{}]{1,80}; \}$/;

// A line added to that block styles a state of something the repair forced, which is what its forced colour
// would otherwise swallow. Any other selector would make the block a place to force a colour anywhere, uncounted.
const STATE_SELECTOR = /:(?:hover|focus|focus-visible|focus-within|active|visited)(?![\w-])/;
const stylesStatesOnly = (line) => line.slice(0, line.indexOf("{")).split(",").every((selector) => STATE_SELECTOR.test(selector));
// ...and a state of something the block already forces. ".unrelated:hover" is a state too, and with nothing
// tying it to a forced line the block was still a place to force a colour anywhere. The element is the same one
// when, with its state taken off, the selector is a forced selector, or that selector less specific: without
// its attribute or further class (".footer-link" for ".footer-link[href$='about/']") or without the context in
// front of it (".footer-link" for ".site-footer .footer-link").
const lineSelectors = (line) => line.slice(0, Math.max(0, line.indexOf("{"))).split(",").map((selector) => selector.replace(/\s+/g, " ").trim()).filter(Boolean);
const withoutStates = (selector) => selector.replace(new RegExp(STATE_SELECTOR.source, "g"), "").replace(/\s+/g, " ").trim();
const sameElement = (base, forced) => Boolean(base) && (forced === base
  || (forced.startsWith(base) && /^[[:.#]/.test(forced.slice(base.length)))
  || (forced.endsWith(base) && /[\s>+~]$/.test(forced.slice(0, forced.length - base.length))));

// Each forced declaration by where it is, "selector { property }", with how many times it appears: the same pair
// can sit both inside and outside a media query.
function forcedDeclarations(css) {
  const found = new Map();
  const source = String(css || "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, prelude, body] of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = prelude.replace(/\s+/g, " ").trim();
    for (const declaration of body.split(";")) {
      if (!/!\s*important/i.test(declaration)) continue;
      const key = `${selector} { ${declaration.slice(0, Math.max(0, declaration.indexOf(":"))).trim().toLowerCase()} }`;
      found.set(key, (found.get(key) || 0) + 1);
    }
  }
  return found;
}

export function accessibilityOverrides(css) {
  const lines = [];
  const authored = String(css || "").replace(A11Y_OVERRIDES, (_block, inner) => {
    lines.push(...inner.split("\n").map((line) => line.trim()).filter(Boolean));
    return "";
  });
  return { authored, lines };
}

const IMPORTANT_HELP = "Write the rule without it. If the colour you need to change is being forced by the accessibility block at the end of the "
  + "stylesheet (between the ww-a11y-overrides comments), read that block: delete the line that forces it and give the normal rule a colour with "
  + "enough contrast, or add the state you need (hover, focus) inside the block as one line in the same form.";

// What an edit made worse in a stylesheet, compared with how it was.
//
// This used to compare the two files' issue lists as text, and the !important issue carries its count. Any
// change in the count read as a new issue, a decrease included: an editor could not remove a forced colour,
// and could not style over one without !important either. A planned footer restyle ended there, with the
// editor reporting that only someone able to change this check could finish it. The measure is now what was
// added, and the accessibility block is the repair's own: its forced colours may be removed, or given the
// hover and focus states they would otherwise swallow.
//
// "Added" is each forced declaration that was not there, by selector and property. The net count let an edit drop
// one it inherited and force something else somewhere else, and read as no change.
export function stylesheetRegressions(before, after) {
  const was = accessibilityOverrides(before);
  const now = accessibilityOverrides(after);
  const tokens = (text) => /:root\s*\{[^}]*--/.test(String(text || ""));
  const issues = [];
  const forcedBefore = forcedDeclarations(was.authored);
  const added = [...forcedDeclarations(now.authored)].flatMap(([key, count]) => Array(Math.max(0, count - (forcedBefore.get(key) || 0))).fill(key));
  if (added.length) issues.push(`${added.length} new use(s) of !important. The first is ${added[0].slice(0, 160)}. ${IMPORTANT_HELP}`);
  const known = new Set(was.lines);
  const fresh = now.lines.filter((line) => !known.has(line));
  const malformed = fresh.find((line) => !OVERRIDE_LINE.test(line));
  if (malformed) {
    issues.push("the accessibility block takes one rule per line, written exactly as \"selector { color: #rrggbb !important; }\" "
      + `(colour, background colour, border colour, outline or text decoration only); this line is not: ${malformed.slice(0, 160)}`);
  }
  // The same selector with another value is still the repair's rule; a selector the block did not have is new.
  const selectorOf = (line) => line.slice(0, Math.max(0, line.indexOf("{"))).replace(/\s+/g, " ").trim();
  const forced = new Set(was.lines.map(selectorOf));
  const stateless = fresh.find((line) => OVERRIDE_LINE.test(line) && !forced.has(selectorOf(line)) && !stylesStatesOnly(line));
  if (stateless) {
    issues.push("a line added to the accessibility block may only style a state (hover, focus, focus-visible, focus-within, active or visited) "
      + `of what the block already forces; this one styles something else: ${stateless.slice(0, 160)}. Give that element its colour in a normal rule, without !important`);
  }
  const forcedElements = was.lines.flatMap(lineSelectors).map(withoutStates);
  const unrelated = fresh.find((line) => OVERRIDE_LINE.test(line) && !forced.has(selectorOf(line)) && stylesStatesOnly(line)
    && !lineSelectors(line).every((selector) => forcedElements.some((element) => sameElement(withoutStates(selector), element))));
  if (unrelated) {
    issues.push("a state added to the accessibility block must be a state of something the block already forces; "
      + `nothing in the block forces what this one styles: ${unrelated.slice(0, 160)}. Give that element's state its colour in a normal rule, without !important`);
  }
  if (tokens(before) && !tokens(after)) issues.push("no design tokens in :root, so colours and spacing cannot be changed in one place");
  return issues;
}

// ---- Copyright ---------------------------------------------------------------

// © and a year, in any of the shapes a footer uses:
//   © 2024 Best Picture      &copy; 2024      Copyright © 2020-2024
// The year captured is the LAST one, because a range ends at the current year.
// What separates the two years of a range. Entities are here because a real
// footer is authored HTML: "&copy; 2019&ndash;2023" is the common spelling and
// a literal en-dash is the rare one. Getting this wrong is worse than not
// matching at all - an unrecognised separator makes the FIRST year look like
// the only year, so the repair rewrites the start of the range and leaves the
// end stale, turning "2019&ndash;2023" into "2026&ndash;2023". Backwards, and
// on every page.
const RANGE = String.raw`\s*(?:[-–—]|to|&[a-z]+;|&#x?[0-9a-f]+;)\s*`;

// Deliberately shared by the check and the repair below. Symmetry is the point:
// whatever is reported as a finding must be exactly what gets rewritten, or a
// page fails the standard with no automated pass able to clear it.
const COPYRIGHT = new RegExp(
  String.raw`(©|&copy;|&#169;|\bcopyright\b)([^0-9<]{0,20})((?:\d{4}${RANGE})?)(\d{4})`,
  "gi"
);

// A stale copyright year is the most visible way a generated site announces it
// was made by something with no idea what day it is. One shipped reading
// "© 2024 Best Picture. All rights reserved." in 2026 - not wrong by accident,
// because nothing had ever told the generator what year it was.
export function copyrightIssues(html, { year = new Date().getUTCFullYear() } = {}) {
  const issues = [];
  for (const match of String(html || "").matchAll(COPYRIGHT)) {
    const found = Number(match[4]);
    if (found === year) continue;
    issues.push(found > year
      ? `copyright year ${found} is in the future; this year is ${year}`
      : `copyright year ${found} is stale; this year is ${year}`);
  }
  return issues;
}

// Rewrites the year rather than asking a model to get it right.
//
// The prompts carry the date now, which should be enough - but "should be
// enough" is how the wrong year shipped in the first place. This runs over the
// finished page, so the outcome does not depend on the model having listened.
// A range keeps its start: "© 2020-2024" becomes "© 2020-2026", which is what
// a business trading since 2020 actually wants.
export function freshenCopyrightYear(html, { year = new Date().getUTCFullYear() } = {}) {
  return String(html || "").replace(COPYRIGHT, (whole, mark, gap, range, found) =>
    (Number(found) === year ? whole : `${mark}${gap}${range}${year}`));
}

// ---- Images ----------------------------------------------------------------

// An image with no intrinsic size makes the page jump as it loads, which is a
// Core Web Vitals failure (cumulative layout shift) and the most common reason
// a generated site feels cheap on a phone.
export function imageDimensionIssues(html) {
  const $ = parseHtml(html);
  const issues = [];
  $("img").each((index, element) => {
    const image = $(element);
    const sized = (image.attr("width") && image.attr("height"))
      || /aspect-ratio/i.test(String(image.attr("style") || ""))
      || /aspect-ratio/i.test(String(image.attr("class") || ""));
    if (!sized) issues.push("<img> without width/height or aspect-ratio, which will shift the layout as it loads");
  });
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
// `fileContents` is a change's own files that are not written yet (relative path -> contents, null for a
// deletion): a page created together with its manifest entry is composed from the change, not from a disk
// that does not know the page. Older site copies of the compiler have no readSharedSources; they read the disk.
export async function pageStandardsFindings(html, { route = "/", origin = "", allowedImageNames = null, siteRoot = null, fileOverrides = null, fileContents = null, now = new Date() } = {}) {
  if(siteRoot && !/<html\b|<!doctype/i.test(html)){
    const pendingManifest=fileContents?.has('layout/pages.json')?fileContents.get('layout/pages.json')!==null:null;
    const shared=pendingManifest??await access(path.join(siteRoot,'layout/pages.json')).then(()=>true).catch(()=>false);
    if(shared){const compose=await import('./compose-site-chrome.mjs');
      const sources=fileContents&&typeof compose.readSharedSources==='function'?await compose.readSharedSources(siteRoot,fileContents):null;
      html=await compose.renderSharedSource(siteRoot,route==='/'?'index.html':route.replace(/^\//,'')+'index.html',html,sources);}
  }
  const failures = [
    // Inline rather than imported: this module is installed into customer
    // repositories byte-for-byte, where ../src/ does not exist.
    ...copyrightIssues(html, { year: now.getUTCFullYear() }),
    ...managedHtmlStructureIssues(html),
    ...landmarkIssues(html),
    ...styleIssues(html),
    ...documentIssues(html, { route, origin }),
    ...await localLinkIssues(html, route, siteRoot, fileOverrides),
    ...fragmentLinkIssues(html),
    ...formIssues(html),
    ...unlabelledControlIssues(html),
    ...placeholderCopyIssues(html),
    ...forbiddenIntegrationIssues(html),
    ...mobileOverflowIssues(html),
    ...videoIssues(html),
    ...(allowedImageNames ? managedImageSourcesOutsideAllowlist(html, allowedImageNames) : [])
  ];
  if (sanitizeManagedHtml(html) !== html) failures.push("contains active content forbidden in a managed static site");

  const warnings = [
    ...imageDimensionIssues(html),
    ...linkQualityIssues(html),
    ...socialMetaIssues(html),
    ...structuredDataIssues(html),
    ...faqUnreadableIssues(html, { route })
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
  const { beforeFileOverrides = null, afterFileOverrides = null, beforeFileContents = null, afterFileContents = null, ...pageOptions } = options;
  // A page that did not exist before is judged against the bare layout around an empty page, read from the
  // change's own files: on a layout site that is what its shared head, chrome and scripts bring, which is not
  // the change under review; elsewhere it is an empty document. (Composing an empty string threw on a layout
  // site, which refused every page created in a change.)
  const created = !String(before).trim();
  const [was, now] = await Promise.all([
    created
      ? pageStandardsFindings("<main></main>", { ...pageOptions, fileOverrides: afterFileOverrides, fileContents: afterFileContents })
      : pageStandardsFindings(before, { ...pageOptions, fileOverrides: beforeFileOverrides, fileContents: beforeFileContents }),
    pageStandardsFindings(after, { ...pageOptions, fileOverrides: afterFileOverrides, fileContents: afterFileContents })
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
