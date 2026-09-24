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

import { contentTransforms } from "./site-content-rules.js";

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
    if (!document && !options.highlight) return response;
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
    const zoom = Number.isFinite(rawZoom) && rawZoom >= 100 && rawZoom <= 250 ? Math.round(rawZoom) : 100;
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

export function withSiteContent(handler, options = {}) {
  const read = siteContentReader(options);
  return {
    // Everything else the Worker exports - scheduled, queue, email - is kept
    // as it was. Only fetch is wrapped.
    ...handler,
    async fetch(request, env, ctx) {
      const response = await handler.fetch(request, env, ctx);
      if (!resolvable(response)) return response;
      const preview = previewFrom(request);
      const resolved = resolveContent(response, await read(env), preview);
      if (!preview.highlight) return resolved;
      // A page with an outline drawn on it is not the page: never index it,
      // and never let a cache serve it to somebody who did not ask for it.
      return markPreviewResponse(resolved);
    }
  };
}
