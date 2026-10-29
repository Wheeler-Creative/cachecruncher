// Resolving the owner's content while a page is served, for any site's Worker.
//
// This ships into a generated site alongside site-content-rules.js and is the
// ONE implementation of the serving path. It used to be written inline into
// the scaffold's Worker template, which meant a site retrofitted by hand and a
// site built by the pipeline resolved content through two copies of the same
// code - and the whole reason site-content-rules.js has no imports is that two
// copies of this logic drift.
//
// It wraps a Worker's default export rather than editing its routing:
//
//   const siteHandler = { async fetch(request, env, ctx) { ... } };
//   export default withSiteContent(siteHandler, { key: "site-content/<id>.json" });
//
// which is what makes it retrofittable. The four sites already in production
// have four differently shaped fetch handlers - one returns assets from three
// places, one is 588 lines with an email path - and none of them has to be
// understood for this to work. Whatever HTML the site produces, this resolves;
// everything else passes straight through untouched.
//
// The page already contains working values, because the tagging pass wrote the
// tag beside the value and never instead of it. So this only ever OVERRIDES: a
// missing document, an unreadable bucket, a binding that is not there, or a
// throw anywhere in here all serve exactly the page in the repository. That is
// what makes it safe to run on every request.

import { CONTENT_RULES_VERSION, I18N_ATTRIBUTES, contentTransforms, creditShown, imageContent, languageContent, parseContent, parseImageIndex, seoVerificationFile } from "./site-content-rules.js";
import { NEWSLETTER_RENDER_VERSION, newsletterPath, publishedNewsletters, replaceNewsletterPdfs, serveNewsletter } from "./newsletter-site.js";
import { COLLECTIONS_RENDER_VERSION, addCollectionNav, addSitemapPages, collectionSitemap, fillCollectionPlaces, parseCollectionsIndex, serveCollection } from "./collection-pages-site.js";
import { DATED_RENDER_VERSION, addModuleNav, moduleNavLinks, newsletterSnapshot, parseEventsSnapshot, serveDatedPage } from "./dated-page-site.js";
import { POPUPS_RENDER_VERSION, activePopup, addPopup, parsePopups, popupAsset } from "./popup-site.js";
import { FAQ_PAGE_PATH, FAQ_RENDER_VERSION, addFaqs, parseFaqs, serveFaqPage } from "./faq-site.js";
import { SIGNUPS_RENDER_VERSION, addSignupForm, parseSignups, signupAsset } from "./signups-site.js";
import { CUSTOMER_RUNTIME_VERSION, addCustomerAccountNav, customerAccountRoute, customerAccountSnapshot, partnerApiRoute, webAppRoute, webAppSnapshot, addWebAppEntry } from './site-customer-runtime.js';

// Long enough that a page view does not usually pay for a bucket read, short
// enough that an owner who saves a phone number sees it almost at once.
export const CONTENT_TTL_MS = 20_000;

// One reader per Worker instance, holding the document between requests.
export function siteContentReader({ key, binding = "MEDIA", ttlMs = CONTENT_TTL_MS } = {}) {
  let cache = { at: 0, document: null };
  return async function read(env) {
    const bucket = env?.[binding];
    if (!bucket || !key) return "";
    const now = Date.now();
    if (cache.document !== null && now - cache.at < ttlMs) return cache.document;
    try {
      const object = await bucket.get(key);
      // R2 answers with an object to read; KV answers with the string itself.
      // Both are bindings an operator can reasonably point this at, and the
      // difference is otherwise a silent no-op.
      const document = typeof object === "string" ? object : object ? await object.text() : "";
      cache = { at: now, document };
      return document;
    } catch {
      // A bucket that will not answer is not a reason to serve a broken page.
      // Cached as empty so one outage is not one bucket read per request.
      cache = { at: now, document: "" };
      return "";
    }
  };
}

// HTMLRewriter because it streams: no DOM is built, nothing is buffered, and a
// page with nothing to resolve costs one cached bucket read.
export function resolveContent(response, document, options = {}) {
  try {
    // A preview still has work to do on a site whose owner has saved nothing:
    // the point of it is to show them where a photograph would go.
    if (!document && !options.highlight && !options.origin) return response;
    const transforms = contentTransforms(document, options);
    if (!transforms.length) return response;
    let rewriter = new HTMLRewriter();
    for (const transform of transforms) {
      rewriter = rewriter.on(transform.selector, {
        element(element) {
          // One element failing to resolve must not fail the page.
          try { transform.apply(element); } catch { /* leave it as written */ }
        }
      });
    }
    return rewriter.transform(response);
  } catch {
    return response;
  }
}

// True only for a page. A stylesheet, a photograph or a JSON endpoint has
// nothing to resolve, and an error page is not the owner's content.
export function resolvable(response) {
  if (!response || !response.ok || !response.body) return false;
  return String(response.headers?.get?.("content-type") || "").includes("text/html");
}

// What the console asked to be shown, if anything. Read from the query string
// because an iframe is the only thing that has to produce it.
export function previewFrom(request) {
  try {
    const params = new URL(request.url).searchParams;
    const highlight = String(params.get("ww-slot") || "").slice(0, 80);
    if (!highlight) return {};
    const trying = params.get("ww-try");
    const cropPoint = (name) => {
      const value = Number(params.get(name));
      return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
    };
    const x = cropPoint("ww-crop-x");
    const y = cropPoint("ww-crop-y");
    const rawZoom = Number(params.get("ww-crop-zoom"));
    const zoom = Number.isFinite(rawZoom) && rawZoom >= 10 && rawZoom <= 250 ? Math.round(rawZoom) : 100;
    const crop = x === null || y === null ? null : { x, y, zoom };
    return {
      highlight,
      // One value, for one response, for the slot being looked at. It cannot
      // name a different field, and the kind still comes from the page.
      preview: trying === null ? null : {
        id: highlight,
        value: String(trying).slice(0, 200),
        ...(crop ? { crop } : {})
      }
    };
  } catch {
    return {};
  }
}

// The owner portal is a different, trusted origin from every managed site.
// Most sites deliberately send X-Frame-Options: SAMEORIGIN, which is exactly
// what a public page should do, but it also makes the portal's read-only
// `?ww-slot=` frame blank. Relax framing *only* for that no-store preview
// response; it has no authenticated controls or mutations and is explicitly
// excluded from search. `frame-ancestors` is the modern, origin-specific
// control; X-Frame-Options cannot name an allowlisted origin, so it must be
// removed for this one response.
export const PORTAL_FRAME_ANCESTORS = "https://jaybirddigital.com https://www.jaybirddigital.com https://wheelerswebsites.com https://www.wheelerswebsites.com";

export function previewContentSecurityPolicy(existing = "") {
  const directives = String(existing || "")
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors(?:\s|$)/i.test(directive));
  directives.push(`frame-ancestors ${PORTAL_FRAME_ANCESTORS}`);
  return directives.join("; ");
}

export function markPreviewResponse(response) {
  const marked = new Response(response.body, response);
  marked.headers.set("x-robots-tag", "noindex, nofollow");
  marked.headers.set("cache-control", "no-store");
  marked.headers.delete("x-frame-options");
  marked.headers.set("content-security-policy", previewContentSecurityPolicy(marked.headers.get("content-security-policy")));
  return marked;
}

// The dated items table's published snapshot, for a hand-written Worker that
// does not serve it itself. Generated Workers route these before this wrapper.
async function serveDatedItems(request, env, { eventsKey, binding = "MEDIA" }) {
  const url = new URL(request.url);
  const calendar = url.pathname === "/events.ics";
  if (request.method !== "GET" || (!calendar && url.pathname !== "/api/events")) return null;
  const key = calendar ? eventsKey.replace(/events\.json$/, "feed.ics") : eventsKey;
  const object = await env?.[binding]?.get(key).catch(() => null);
  if (!object) return calendar ? new Response("Not found", { status: 404 }) : Response.json({ enabled: false, events: [] });
  return new Response(object.body, { headers: {
    "content-type": calendar ? "text/calendar; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "public, max-age=60, stale-while-revalidate=3600"
  } });
}

// Public booking entry points carry only a portal URL; profiles and availability stay behind the platform API.
export function schedulerSnapshot(text, siteId, portalOrigin = "https://jaybirddigital.com") {
  try {
    const value = JSON.parse(text || "{}");
    const url = new URL(value.bookingUrl);
    if (value.enabled !== true || !["https://jaybirddigital.com", "https://dev.jaybirddigital.com", "https://wheelerswebsites-staging.jaybirddigital.workers.dev"].includes(portalOrigin)
      || url.origin !== portalOrigin || url.pathname !== "/booking"
      || url.searchParams.get("id") !== siteId || [...url.searchParams.keys()].some(key => key !== "id")) return null;
    return { bookingUrl: url.href };
  } catch { return null; }
}
export function schedulerEntry(request, snapshot) {
  if (!snapshot || !["GET", "HEAD"].includes(request.method)
    || !["/_booking", "/_booking/", "/_guest-account", "/_guest-account/"].includes(new URL(request.url).pathname)) return null;
  return new Response(null, { status: 302, headers: { location: snapshot.bookingUrl, "cache-control": "no-store" } });
}
export function addSchedulerNav(response, snapshot) {
  if (!snapshot || typeof HTMLRewriter === "undefined") return response;
  let header = "pending", content = false, menu = false, linked = false, itemClass = "", linkClass = "";
  const cleanClass = value => String(value || "").split(/\s+/).filter(token => /^[a-zA-Z0-9_-]+$/.test(token)
    && !["active", "current", "selected", "is-active", "is-current"].includes(token)).join(" ");
  const link = () => `<a${linkClass ? ` class="${linkClass}"` : ""} href="/_booking/" data-ww-booking-link>Book now</a>`;
  return new HTMLRewriter().on("main, article", { element() { content = true; } })
    .on("header", { element(element) {
      if (header !== "pending" || content) return;
      header = "open";
      element.onEndTag(end => { if (!linked && !menu) end.before(link(), { html: true }); header = "closed"; });
    } })
    .on("header nav ul, header ul.nav-list, header ul#primary-nav", { element(element) {
      if (header !== "open" || menu) return;
      menu = true;
      element.onEndTag(end => { if (!linked) end.before(`<li${itemClass ? ` class="${itemClass}"` : ""}>${link()}</li>`, { html: true }); });
    } })
    .on("header nav ul > li, header ul.nav-list > li, header ul#primary-nav > li", { element(element) {
      if (header === "open" && !itemClass) itemClass = cleanClass(element.getAttribute("class"));
    } })
    .on("header a[href]", { element(element) {
      if (header !== "open") return;
      const href = String(element.getAttribute("href") || "");
      if (/^\/_booking\/?$/.test(href) || href === snapshot.bookingUrl) linked = true;
      if (!linkClass) linkClass = cleanClass(element.getAttribute("class"));
    } }).transform(response);
}

// THE PLATFORM'S CREDIT. "Website by Jaybird Digital", one quiet line at the end of the site's footer, drawn while the
// page is served so an owner who hides it (`credit: false` in their content document) sees it go at once, with no build.
// The words are the brand and nothing else; the address is the same on every site. It is a paragraph of the footer, so
// it takes the footer's own text colour (which the site's checks already hold to AA), and its link is underlined with a
// 44px target. It goes in the first footer outside the page's content (an article's or a quotation's footer is not the
// site's), at the end of the page in a footer of its own when there is none, and nowhere when the footer already links to us.
// It speaks the page's language (its <html lang>, which a Turkish-first site's Worker is not told), else the one given.
export const CREDIT_RENDER_VERSION = 1;
export const SITE_CREDIT_URL = "https://jaybirddigital.com/?ref=site";
const CREDIT_WORDS = { en: "Website by Jaybird Digital", tr: "Jaybird Digital tarafından hazırlandı", de: "Website von Jaybird Digital",
  es: "Sitio web creado por Jaybird Digital", fr: "Site réalisé par Jaybird Digital" };
const creditLanguage = (language) => String(language || "").slice(0, 2).toLowerCase();
export const creditWords = (language) => CREDIT_WORDS[creditLanguage(language)] || CREDIT_WORDS.en;
const CREDIT_STYLE = "<style>.ww-credit{display:block;box-sizing:border-box;width:100%;max-width:none;grid-column:1/-1;clear:both;float:none;margin:0;"
  + "padding:.25rem 1rem;text-align:center;font-size:clamp(.8125rem,.875em,1rem);line-height:1.5}"
  + ".ww-credit a{display:inline-flex;align-items:center;min-height:44px;padding:0 .25rem;color:inherit;"
  + "text-decoration:underline;text-underline-offset:.2em}</style>";
export function renderSiteCredit(language = "en") {
  return `${CREDIT_STYLE}<p class="ww-credit" data-ww-credit><a href="${SITE_CREDIT_URL}">${creditWords(language)}</a></p>`;
}
const OURS = /^https?:\/\/(?:www\.)?jaybirddigital\.com(?:[/?#]|$)/i;
export function addSiteCredit(response, { shown = true, language = "en" } = {}) {
  if (!shown || typeof HTMLRewriter === "undefined") return response;
  if (!response?.ok || !String(response.headers?.get?.("content-type") || "").includes("text/html")) return response;
  let inside = 0, footer = 0, placed = false, linked = false, spoken = language;
  const credit = () => renderSiteCredit(spoken);
  return new HTMLRewriter()
    .on("html", { element(element) {
      const lang = creditLanguage(element.getAttribute("lang"));
      if (CREDIT_WORDS[lang]) spoken = lang;
    } })
    .on("main, article, section, aside, blockquote, figure, dialog, template", { element(element) {
      if (footer) return;
      inside += 1;
      element.onEndTag(() => { inside -= 1; });
    } })
    .on("footer, [role=contentinfo]", { element(element) {
      if (placed || inside > 0 || footer) return;
      footer += 1;
      element.onEndTag((end) => {
        footer -= 1;
        placed = true;
        if (!linked) end.before(credit(), { html: true });
      });
    } })
    .on("a[href]", { element(element) {
      if (footer && OURS.test(String(element.getAttribute("href") || "").trim())) linked = true;
    } })
    .on("body", { element(element) {
      element.onEndTag((end) => {
        if (placed) return;
        placed = true;
        end.before(`<footer class="ww-credit-footer">${credit()}</footer>`, { html: true });
      });
    } })
    .transform(response);
}

// Which content rules this Worker runs, for the console to read off any page (see CONTENT_RULES_VERSION).
export function advertiseRules(response, env) {
  try {
    const marked = new Response(response.body, response);
    marked.headers.set("x-ww-content", String(CONTENT_RULES_VERSION));
    marked.headers.set("x-ww-newsletter", String(NEWSLETTER_RENDER_VERSION));
    marked.headers.set("x-ww-collections", String(COLLECTIONS_RENDER_VERSION));
    marked.headers.set("x-ww-scheduler", "1");
    marked.headers.set("x-ww-popups", String(POPUPS_RENDER_VERSION));
    marked.headers.set("x-ww-faq", String(FAQ_RENDER_VERSION));
    marked.headers.set("x-ww-dated", String(DATED_RENDER_VERSION));
    marked.headers.set("x-ww-signups", String(SIGNUPS_RENDER_VERSION));
    marked.headers.set("x-ww-credit", String(CREDIT_RENDER_VERSION));
    if (env?.CUSTOMER_ACCOUNT_ACTOR_RATE && env?.CUSTOMER_ACCOUNT_SITE_RATE) marked.headers.set("x-ww-customer-accounts", String(CUSTOMER_RUNTIME_VERSION));
    return marked;
  } catch {
    return response;
  }
}

// SECURITY HEADERS ON EVERY ANSWER THE RUNTIME SERVES. The portal sends them (src/security-headers.js); a site's Worker
// did not, and fleet health measured eight sites without them (2026-10-17); a live check on 2026-10-25 found the
// sites still without HSTS, a permissions policy or any policy beyond framing. Set only where the site has not set its
// own (a _headers file or its own routes win). Transport headers go on everything; the rest belongs to a page.
// Framing is limited to the site itself and the portal, which shows the site in its preview frame.
export const SITE_FRAME_ANCESTORS = "frame-ancestors 'self' https://jaybirddigital.com https://*.jaybirddigital.com";
// Six months of HTTPS for the host that answered, and no more: a customer's other subdomains (webmail, an old shop)
// may not speak HTTPS, so includeSubDomains and preload are not this runtime's to promise.
export const SITE_HSTS = "max-age=15552000";
// Features no customer website asks for are off for the page and everything it frames; payment stays for the site
// itself and Stripe's frames.
export const SITE_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(self), payment=(self "https://js.stripe.com" "https://checkout.stripe.com")';

// THE POLICY A WEBSITE WOULD RUN UNDER once its pages are known to fit it: its own files and the services the platform
// wires in (Stripe, the form check, Cloudflare's analytics), any https picture, font, style or frame, no plugins and no
// eval. Inline styles stay allowed (every site has them); inline scripts do not, and that is what most migrated sites
// still carry, so enforcing blind would break them. It is therefore sent as Content-Security-Policy-Report-Only on a
// sample of page views, reporting to the platform (/api/csp-report?site=<id>), and enforced per website once its
// reports are clean: site-integrations/<id>/security.json with { "version": 1, "siteId": "<id>", "csp": "enforce" }
// (or "off" to send nothing). Without that file a website is in "report".
export const POLICY_REPORT_SAMPLE = 0.1;
export function sitePolicy({ siteId, platformOrigin = "https://jaybirddigital.com" } = {}) {
  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://www.recaptcha.net https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "media-src 'self' data: blob: https:",
    `connect-src 'self' ${platformOrigin} https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://cloudflareinsights.com`,
    "frame-src 'self' https:",
    "object-src 'self'",
    "base-uri 'self'",
    `form-action 'self' ${platformOrigin} https://checkout.stripe.com`,
    SITE_FRAME_ANCESTORS,
    `report-uri ${platformOrigin}/api/csp-report?site=${encodeURIComponent(siteId || "")}`
  ].join("; ");
}
export function securitySettings(text, siteId) {
  try {
    const value = JSON.parse(text || "{}");
    if (value.version === 1 && value.siteId === siteId && ["enforce", "report", "off"].includes(value.csp)) return { csp: value.csp };
  } catch { /* no file, or not ours: the default */ }
  return { csp: "report" };
}

// `context`: siteId and platformOrigin for the policy, security (securitySettings) for its mode, and sample (a number
// in [0, 1), Math.random() by default) deciding whether this page view carries the report-only policy.
export function withSiteSecurityHeaders(response, context = {}) {
  if (!response) return response;
  const page = /html/i.test(response.headers?.get?.("content-type") || "");
  const csp = response.headers.get("content-security-policy") || "";
  const mode = context.security?.csp || "report";
  const policy = context.siteId ? sitePolicy(context) : null;
  const missing = {
    "strict-transport-security": response.headers.has("strict-transport-security") ? null : SITE_HSTS,
    "x-content-type-options": response.headers.has("x-content-type-options") ? null : "nosniff",
    ...(page ? {
      "referrer-policy": response.headers.has("referrer-policy") ? null : "strict-origin-when-cross-origin",
      "permissions-policy": response.headers.has("permissions-policy") ? null : SITE_PERMISSIONS_POLICY,
      // A site's own policy is kept (with framing control added when it has none); ours is enforced only where the
      // site set nothing and its file says so.
      "content-security-policy": policy && mode === "enforce" && !csp && !response.headers.has("x-frame-options") ? policy
        : response.headers.has("x-frame-options") || /frame-ancestors/i.test(csp) ? null
          : (csp ? `${csp.replace(/;\s*$/, "")}; ${SITE_FRAME_ANCESTORS}` : SITE_FRAME_ANCESTORS),
      "content-security-policy-report-only": policy && mode === "report" && !csp && !response.headers.has("content-security-policy-report-only")
        && (context.sample ?? Math.random()) < POLICY_REPORT_SAMPLE ? policy : null
    } : {})
  };
  if (!Object.values(missing).some(Boolean)) return response;
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(missing)) if (value) out.headers.set(name, value);
  return out;
}

// /images/<key> is a site's picture folder; the platform's own records sit beside the pictures. The folders are
// INTERNAL_MEDIA_FOLDERS in src/media-layout.js, written out here because this module is mounted on its own (by the
// runtime tests and by hand-written Workers) and must not import; scripts/site-security-headers.test.mjs keeps the
// two the same.
export const INTERNAL_MEDIA_FOLDER = /^(?:meta|snapshots|blueprints|source|pages|sitemaps)\//i;
export function internalMediaRequest(request) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/images/")) return false;
  try {
    const key = decodeURIComponent(path.slice("/images/".length)).replace(/^\/+/, "");
    return INTERNAL_MEDIA_FOLDER.test(key) || /(?:^|\/)\.\.(?:\/|$)/.test(key);
  } catch { return true; }
}

export function withSiteContent(handler, options = {}) {
  const read = siteContentReader(options);
  const siteId = /^site-content\/([^/]+)\.json$/.exec(options.key || "")?.[1];
  const readScheduler = siteContentReader({ ...options, key: siteId ? `site-integrations/${siteId}/scheduler.json` : "" });
  const readAccounts = siteContentReader({ ...options, key: siteId ? `site-integrations/${siteId}/customer-accounts.json` : "" });
  const readWebApp = siteContentReader({ ...options, key: siteId ? `site-integrations/${siteId}/web-app.json` : "" });
  const readNewsletter = siteContentReader({ ...options, key: siteId ? `site-integrations/${siteId}/newsletter.json` : "" });
  const readSecurity = siteContentReader({ ...options, key: siteId ? `site-integrations/${siteId}/security.json` : "" });
  const pdfMatches = new Map();
  // The blog and repeating pages: a small index read on every page (for the menu), each list's own file on its pages.
  const readCollections = siteContentReader({ ...options, key: siteId ? `site-integrations/${siteId}/collections.json` : "" });
  let collectionsMemo = { text: null, index: parseCollectionsIndex("") };
  const collectionsFor = async (env) => {
    const text = siteId ? await readCollections(env) : "";
    if (text !== collectionsMemo.text) collectionsMemo = { text, index: parseCollectionsIndex(text) };
    return collectionsMemo.index;
  };
  const listReaders = new Map();
  // The dated items (events, concerts, classes): their page is drawn at the address the owner chose, and their
  // menu button added, from the snapshot the platform publishes. Generated Workers serve /api/events from it too.
  const readEvents = siteContentReader({ ...options, key: siteId ? (options.eventsKey || `site-integrations/${siteId}/events/events.json`) : "" });
  let eventsMemo = { text: null, snapshot: parseEventsSnapshot("") };
  const eventsFor = async (env) => {
    const text = siteId ? await readEvents(env) : "";
    if (text !== eventsMemo.text) eventsMemo = { text, snapshot: parseEventsSnapshot(text) };
    return eventsMemo.snapshot;
  };
  const readPopups = siteContentReader({ ...options, key: siteId ? `site-integrations/${siteId}/popups.json` : "" });
  let popupsMemo = { text: null, index: parsePopups("") };
  const popupsFor = async (env) => {
    const text = siteId ? await readPopups(env) : "";
    if (text !== popupsMemo.text) popupsMemo = { text, index: parsePopups(text) };
    return popupsMemo.index;
  };
  // The owner's frequently asked questions, drawn into the pages that hold them.
  const readFaqs = siteContentReader({ ...options, key: siteId ? `site-integrations/${siteId}/faq.json` : "" });
  let faqsMemo = { text: null, index: parseFaqs("") };
  const faqsFor = async (env) => {
    const text = siteId ? await readFaqs(env) : "";
    if (text !== faqsMemo.text) faqsMemo = { text, index: parseFaqs(text) };
    return faqsMemo.index;
  };
  // Email signups: the form drawn above the footer when the owner turned signups on and no page has its own.
  const readSignups = siteContentReader({ ...options, key: siteId ? `site-integrations/${siteId}/signups.json` : "" });
  let signupsMemo = { text: null, settings: parseSignups("") };
  const signupsFor = async (env) => {
    const text = siteId ? await readSignups(env) : "";
    if (text !== signupsMemo.text) signupsMemo = { text, settings: parseSignups(text) };
    return signupsMemo.settings;
  };
  const readList = (env, list) => {
    if (!listReaders.has(list)) listReaders.set(list, siteContentReader({ ...options, key: `site-integrations/${siteId}/collections/${list}.json` }));
    return listReaders.get(list)(env);
  };
  // The owner's choice about the credit, read from the content document every page already reads.
  let creditMemo = { text: null, shown: creditShown(null) };
  const creditFor = (text) => {
    if (text !== creditMemo.text) creditMemo = { text, shown: creditShown(parseContent(text)) };
    return creditMemo.shown;
  };
  // The photograph index sits beside the content document; a site without one serves as it always did.
  const readImages = siteContentReader({ ...options, key: options.imagesKey || String(options.key || "").replace(/\.json$/, ".images.json") });
  let imageMemo = { text: null, images: null };
  const imagesFor = async (env) => {
    const text = await readImages(env);
    if (text !== imageMemo.text) imageMemo = { text, images: parseImageIndex(text) };
    return imageMemo.images;
  };
  return {
    // Everything else the Worker exports - scheduled, queue, email - is kept
    // as it was. Only fetch is wrapped.
    ...handler,
    async fetch(request, env, ctx) {
      const response = await serve(request, env, ctx);
      const security = siteId ? securitySettings(await readSecurity(env).catch(() => null), siteId) : { csp: "off" };
      return withSiteSecurityHeaders(response, { siteId, platformOrigin: env?.PORTAL_ORIGIN || "https://jaybirddigital.com", security });
    }
  };
  async function serve(request, env, ctx) {
      let response = null;
      // A request reads up to a dozen small snapshots below, each one when its turn comes. On a quiet website, where the
      // 20-second cache has run out, that was 1-2 seconds before the first byte of every page (Career Hunter,
      // 2026-10-23). They are read together first, so the turns below find them cached: one read's wait, not twelve.
      if (siteId) await Promise.all([read, readAccounts, readScheduler, readNewsletter, readWebApp, readPopups, readFaqs, readSignups, readCollections, readEvents, readImages, readSecurity]
        .map((reader) => reader(env).catch(() => null)));
      // The platform's records beside a site's pictures (meta/media-usage.json and the build's folders) are not served.
      if (internalMediaRequest(request)) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      // Booking channels call the property at its own address; the platform answers (src/site-customer-runtime.js).
      if (siteId) {
        const partner = await partnerApiRoute(request, env, { siteId, platformOrigin: env.PORTAL_ORIGIN || 'https://jaybirddigital.com' });
        if (partner) return partner;
      }
      // The website's own web app, on the Web App tier (src/site-customer-runtime.js webAppRoute).
      if (siteId && /^\/(?:[a-z]{2}\/)?_app(?:\/|$)/.test(new URL(request.url).pathname)) {
        const app = await webAppRoute(request, env, { siteId, snapshot: webAppSnapshot(await readWebApp(env).catch(() => null), siteId), platformOrigin: env.PORTAL_ORIGIN || 'https://jaybirddigital.com',
          shell: (path) => handler.fetch(new Request(new URL(path, request.url)), env, ctx) });
        if (app) return app;
      }
      const accounts = siteId ? customerAccountSnapshot(await readAccounts(env).catch(() => null), siteId) : null;
      response = await customerAccountRoute(request, env, { siteId, snapshot: accounts, platformOrigin: env.PORTAL_ORIGIN || 'https://jaybirddigital.com',
        shell: () => handler.fetch(new Request(new URL('/', request.url)), env, ctx) });
      if (response && !resolvable(response)) return response;
      const scheduler = siteId ? schedulerSnapshot(await readScheduler(env).catch(() => null), siteId, env.PORTAL_ORIGIN || "https://jaybirddigital.com") : null;
      const booking = !response && schedulerEntry(request, scheduler);
      if (booking) return booking;
      if (siteId && new URL(request.url).pathname.startsWith("/_ww/popups.")) {
        const asset = popupAsset(request, await popupsFor(env).catch(() => parsePopups("")));
        if (asset) return asset;
      }
      if (siteId) {
        const asset = signupAsset(request);
        if (asset) return asset;
      }
      const newsletterRoute = new URL(request.url).pathname.startsWith("/newsletter/");
      if (newsletterRoute && siteId) {
        response = await serveNewsletter(request, env?.[options.binding || "MEDIA"], siteId, publishedNewsletters(await readNewsletter(env)), {
          shell: () => handler.fetch(new Request(new URL("/", request.url), { headers: request.headers }), env, ctx)
        });
        if (response && !resolvable(response)) return response;
      }
      // The platform reads a page as the website wrote it: no list drawn at its address, in its menu or in its cards.
      const asWritten = request.headers.get("x-ww-as-written") === "1";
      const collections = asWritten ? parseCollectionsIndex("") : await collectionsFor(env).catch(() => parseCollectionsIndex(""));
      if (!response && collections.collections.length) {
        try {
          response = await serveCollection(request, collections, {
            readList: (list) => readList(env, list),
            shell: (path = "/") => handler.fetch(new Request(new URL(path, request.url), { headers: request.headers }), env, ctx)
          });
        } catch { response = null; }
        if (response && !resolvable(response)) return response;
      }
      if (options.eventsKey) {
        const dated = await serveDatedItems(request, env, options);
        if (dated) return dated;
      }
      // The dated items page, where the owner put it. A page the website wrote at that address stays its own.
      const events = asWritten ? parseEventsSnapshot("") : await eventsFor(env).catch(() => parseEventsSnapshot(""));
      if (!response && events.page) {
        const pageLanguage = (options.languagePrefixes || []).find((code) => new URL(request.url).pathname.startsWith(`/${code}/`)) || options.language || "en";
        try {
          response = await serveDatedPage(request, events, { language: pageLanguage,
            shell: (path = "/") => handler.fetch(new Request(new URL(path, request.url), { headers: request.headers }), env, ctx) });
        } catch { response = null; }
        if (response && !resolvable(response)) return response;
      }
      // The FAQ page, when the owner asked the website to draw one. A page the website wrote at /faq/ stays its own.
      const faqs = asWritten ? parseFaqs("") : await faqsFor(env).catch(() => parseFaqs(""));
      if (!response && faqs.page) {
        const pageLanguage = (options.languagePrefixes || []).find((code) => new URL(request.url).pathname.startsWith(`/${code}/`)) || options.language || "en";
        try {
          response = await serveFaqPage(request, faqs, { language: pageLanguage,
            shell: (path = "/") => handler.fetch(new Request(new URL(path, request.url), { headers: request.headers }), env, ctx) });
        } catch { response = null; }
        if (response && !resolvable(response)) return response;
      }
      // Ahead of the site's own routing, which would answer this path with a 404.
      if (request.method === "GET" && /^\/google[0-9a-f]{16}\.html$/.test(new URL(request.url).pathname)) {
        try {
          const body = seoVerificationFile(parseContent(await read(env)).seo, new URL(request.url).pathname);
          if (body) return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
        } catch { /* fall through to the site */ }
      }
      response ||= await handler.fetch(request, env, ctx);
      // The site's own Worker makes <loc> absolute; the image entries added beside them need the same.
      if (request.method === "GET" && response.ok && new URL(request.url).pathname === "/sitemap.xml") {
        try {
          const origin = new URL(request.url).origin;
          const text = await response.clone().text();
          // The pages this runtime serves with no file behind them, so the sitemap lists what the website serves.
          const issues = siteId ? publishedNewsletters(await readNewsletter(env).catch(() => "")) : [];
          const served = [
            ...(events.page?.path ? [events.page.path] : []),
            ...(faqs.page ? [FAQ_PAGE_PATH] : []),
            ...(issues.length ? ["/newsletter/", ...issues.map((issue) => newsletterPath(issue.id))] : [])
          ];
          const listed = addSitemapPages(collectionSitemap(text, collections, origin), served, origin);
          if (/<image:loc>\s*\/(?!\/)/.test(listed) || listed !== text) {
            const headers = new Headers(response.headers);
            headers.delete("content-length");
            headers.delete("etag");
            return new Response(listed.replace(/<image:loc>\s*(\/(?!\/)[^<]*?)\s*<\/image:loc>/g, (_, image) => `<image:loc>${origin}${image}</image:loc>`),
              { status: response.status, headers });
          }
        } catch { /* serve the sitemap as it was */ }
        return response;
      }
      if (!resolvable(response)) return response;
      try {
        response = addSchedulerNav(response, scheduler);
        response = addCustomerAccountNav(response, accounts, siteId);
        // The web app on the website's pages: its components, its sign-in button and its lists (webAppPagePlan).
        if (siteId) response = addWebAppEntry(response, webAppSnapshot(await readWebApp(env).catch(() => null), siteId), siteId, new URL(request.url).pathname);
        response = addCollectionNav(response, collections, { pathname: new URL(request.url).pathname, languagePrefixes: options.languagePrefixes || [] });
        // Buttons a module asked for (the dated items page, the newsletter), under the owner's names for them. Not on
        // a page in another language: its menu is that language's, and these names are the main language's.
        const navPath = new URL(request.url).pathname;
        if (siteId && !asWritten && !(options.languagePrefixes || []).some((code) => navPath.startsWith(`/${code}/`) || navPath === `/${code}`)) {
          response = addModuleNav(response, moduleNavLinks({ events, newsletter: newsletterSnapshot(await readNewsletter(env)), faq: faqs }), { pathname: navPath });
        }
      } catch { /* the menu as the website wrote it */ }
      // A page showing a few of a list's pages (its latest posts) shows the list's newest, in the cards it has.
      if (request.method === "GET") {
        try {
          response = await fillCollectionPlaces(response, collections, { pathname: new URL(request.url).pathname, origin: new URL(request.url).origin });
        } catch { /* the page as the website wrote it */ }
      }
      if (siteId) response = replaceNewsletterPdfs(response, new URL(request.url).origin, publishedNewsletters(await readNewsletter(env)), {
        bucket: env?.[options.binding || "MEDIA"], siteId, matches: pdfMatches
      });
      const preview = previewFrom(request);
      // A pop-up never covers the page the owner is editing in the portal.
      if (siteId && !preview.highlight) {
        try {
          response = addPopup(response, activePopup(await popupsFor(env), { pathname: new URL(request.url).pathname }));
        } catch { /* the page without its pop-up */ }
      }
      // Ahead of the owner's wording: a drawn question carries no editing mark, so nothing below rewrites it. Not on a
      // page in another language: its questions are that language's translation, and the list is the main language's.
      const faqPath = new URL(request.url).pathname;
      if (siteId && !(options.languagePrefixes || []).some((code) => faqPath.startsWith(`/${code}/`) || faqPath === `/${code}`)) {
        try {
          response = addFaqs(response, await faqsFor(env));
        } catch { /* the questions as the page wrote them */ }
      }
      // The signup form above the footer, in the page's language; the owner's own heading only on main-language pages.
      // Not on a page the platform reads as written, nor in the editor's view of a page.
      if (siteId && !asWritten && !preview.highlight) {
        try {
          const signupLanguage = (options.languagePrefixes || []).find((code) => faqPath.startsWith(`/${code}/`) || faqPath === `/${code}`);
          response = addSignupForm(response, await signupsFor(env), {
            language: signupLanguage || options.language || "en", mainLanguage: !signupLanguage, pathname: faqPath,
            // The band's own bot check, from the site's Worker (scripts/form-check-rewriter.js): the band is drawn after the
            // page's forms were given theirs. A Worker that passes none draws the band without one.
            formCheck: typeof options.formCheck === "function" ? String(options.formCheck(env || {}, signupLanguage || options.language || "en") || "") : ""
          });
        } catch { /* the page without the drawn form */ }
      }
      let content = await read(env);
      const pathname = new URL(request.url).pathname;
      const language = (options.languagePrefixes || []).find(code => pathname.startsWith(`/${code}/`) || pathname === `/${code}`);
      // Not on a page the platform reads as written: what it reads there is the website's own markup.
      if (!asWritten) {
        try {
          response = addSiteCredit(response, { shown: creditFor(content), language: language || options.language || "en" });
        } catch { /* the footer as the website wrote it */ }
      }
      if (language) {
        // Photographs are the same in every language. The owner's wording is not: a translated
        // page shows what that text was translated to, never the source-language words.
        const own = languageContent(content, language);
        content = JSON.stringify(imageContent(content));
        const images = await imagesFor(env).catch(() => null);
        const base = resolveContent(response, content, { ...preview, origin: new URL(request.url).origin, images });
        const resolved = Object.keys(own.values).length
          ? resolveContent(base, JSON.stringify(own), { attributes: I18N_ATTRIBUTES })
          : base;
        return preview.highlight ? markPreviewResponse(resolved) : advertiseRules(resolved, env);
      }
      const resolved = resolveContent(response, content, {
        ...preview, origin: new URL(request.url).origin, images: await imagesFor(env).catch(() => null)
      });
      if (!preview.highlight) return advertiseRules(resolved, env);
      // A page with an outline drawn on it is not the page: never index it,
      // and never let a cache serve it to somebody who did not ask for it.
      return markPreviewResponse(resolved);
  }
}
