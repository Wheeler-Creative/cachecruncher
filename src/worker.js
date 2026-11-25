import { evaluateSubmission, MAX_PAYLOAD_BYTES } from "../scripts/contact-form-lib.mjs";
import { withSiteContent } from "../scripts/site-content-worker.js";
import { formCheckCapabilities, formCheckFields, formCheckLoader, formCheckSettings, takeFormCheckToken, verifyFormCheck, withManagedFormCheck } from "../scripts/form-check-rewriter.js";
import { siteRoutes } from "./site-routes.js";
import { SITE_API_PREFIX, siteApiEgress, siteApiResponse } from "../scripts/site-api-runtime.js";
// Text, not code: wrangler.jsonc carries this file in as a string, and it runs in an isolate of its own.
import SITE_API_SOURCE from "./site-api.js";

// Every request the website's own API makes goes out through this. The base class exists only on
// Cloudflare; anywhere else (the test suite) there is no loader either, so a stand-in is enough.
const { WorkerEntrypoint: SiteApiEntrypoint } = await import("cloudflare:workers").catch(() => ({ WorkerEntrypoint: class {} }));
export class SiteApiEgress extends SiteApiEntrypoint {
  fetch(request) { return siteApiEgress(request, this.env); }
}

const MEDIA_PREFIX = "sites/b97ce281-ffaf-4808-b4d6-9778c1d2d95e/";
const VIDEO_TYPES = {"m4v":"video/mp4","mov":"video/quicktime","mp4":"video/mp4","ogv":"video/ogg","webm":"video/webm"};
const INSTAGRAM_FEED_KEY = "site-integrations/b97ce281-ffaf-4808-b4d6-9778c1d2d95e/instagram/feed.json";
const FACEBOOK_FEED_KEY = "site-integrations/b97ce281-ffaf-4808-b4d6-9778c1d2d95e/facebook/feed.json";
const EVENTS_JSON_KEY = "site-integrations/b97ce281-ffaf-4808-b4d6-9778c1d2d95e/events/events.json";
const EVENTS_ICS_KEY = "site-integrations/b97ce281-ffaf-4808-b4d6-9778c1d2d95e/events/feed.ics";
const UPDATES_JSON_KEY = "site-integrations/b97ce281-ffaf-4808-b4d6-9778c1d2d95e/updates/updates.json";
const PRODUCTS_JSON_KEY = "site-integrations/b97ce281-ffaf-4808-b4d6-9778c1d2d95e/products/products.json";
const STORE_FILES_PREFIX = "site-integrations/b97ce281-ffaf-4808-b4d6-9778c1d2d95e/products/";
const STORE_NO_IMAGE = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><circle cx=\"9\" cy=\"10\" r=\"2\"/><path d=\"m21 16-5-5-9 9\"/></svg><span>No image</span>";
const COMMERCE_PRODUCT_PATHS = [];
// The source shop's own product page, which the store fills (product-template-runtime.mjs); null draws the store's own.
const STORE_PRODUCT_TEMPLATE = null;
// The source shop's own product cards, cart page and where it linked its policies (source-product-card-lib.mjs); null
// draws the store's own.
const STORE_SHOP_THEME = null;
const PENDING_COLLECTION_SOURCES = {};
const SUBSCRIBERS_CONFIGURED = false;
const SHOP_PAGE_DESIGNED = false;
const SUBSCRIBER_CAPTURE_TOKEN = "";
const SUBSCRIBER_PLATFORM_ORIGIN = "https://jaybirddigital.com";
const COMMERCE_PLATFORM_ORIGIN = "https://jaybirddigital.com";
const STORE_SITE_NAME = "CacheCruncher";
const CONTACT_CONFIGURED = false;
const CONTACT_RECIPIENT = "";
const CONTACT_SENDER = "";
const CONTACT_FALLBACK_SENDER = "";
// A migrated site's icon kept in media, served when the site has no /favicon.ico of its own.
const FAVICON_MEDIA_PATH = "";
const CONTACT_SITE_ID = "b97ce281-ffaf-4808-b4d6-9778c1d2d95e";
// IndexNow: the search engines fetch this file to confirm the submitter controls the host (src/get-found/indexnow.js).
const INDEXNOW_KEY = "4191c1807a314d0eb0f11091ad2ac0c4";
const CONTACT_SITE_LABEL = "CacheCruncher";
const CONTACT_RATE_SALT = "3ede3976d99d2c3df76ceecec0b06ffa78073b193cb19f77bcd6ddc2869bd370";
// Permanent redirects from the URLs this site used before it was rebuilt. These
// are donor bookmarks, links in grant applications and search rankings; cleaning
// a URL without redirecting the old one is a 404 with better spelling.
const REDIRECTS = {};
const MAX_WIDTH = 2000;
// The width of a picture whose address does not say.
const SCREEN_WIDTH = 1600;
// The most a phone is sent. Its screen is about this many pixels across, so anything wider is weight it throws away.
// The exception is a picture the visitor opened large (MAX_WIDTH, a gallery's lightbox), which they can zoom into.
const PHONE_WIDTH = 1080;
// Left to itself the resizer is close to lossless: a 960 KB photograph resized to 1600 wide came out at 2 MB. At 80 it
// is 270 KB and looks the same beside the original. A picture that can afford less asks with ?q=.
const IMAGE_QUALITY = 80;
// Up to this weight a bare address serves the stored bytes. They are already light enough, and it spends no resize.
const LIGHT_IMAGE_BYTES = 150 * 1024;
const RESIZABLE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/avif"]);
// Bump to abandon everything cached under the old behaviour.
//
// Responses here are cached "immutable" for a year, so a fix to how an image
// is produced does not reach anyone already holding the old one - a photo that
// was being re-encoded to 3.4MB kept being served at 3.4MB from whichever edge
// had it. The version is part of the cache key, not the URL the page asks for,
// so nothing in the site's markup has to change.
const CACHE_VERSION = "4";
const FORMATS = { webp: "image/webp", avif: "image/avif", jpeg: "image/jpeg", png: "image/png" };

// The managed forms' bot check (scripts/form-check-rewriter.js): reCAPTCHA, Turnstile or none, read from secrets.
async function managedFormCheck(body, env, request, action) {
  const check = await verifyFormCheck(takeFormCheckToken(body), env, request, action);
  return check?.status ? check : null;
}

// The footer signup band and the sign-up forms are drawn by the content layer after the page's forms were given their
// check, so they ask here: "subscribe" for the band, "join" for the forms (handleSignupJoin checks that action).
function signupFormCheck(env, language, action = "subscribe") {
  const settings = formCheckSettings(env);
  return settings && !settings.incomplete ? formCheckFields(settings, action, language) + formCheckLoader(settings) : "";
}

// What the address does not say and the answer depends on. An iPad's screen is not a phone's, though an older one says
// Mobile. WebP is sent only to a reader that asks for it: a crawler or a mail proxy gets the stored picture as it was.
function imageVariant(request) {
  const agent = request.headers.get("user-agent") || "";
  return {
    phone: /Mobi/i.test(agent) && !/iPad/i.test(agent),
    webp: (request.headers.get("accept") || "").includes("image/webp")
  };
}

// Not a vector, an animation, or a video left beside the images, and heavy enough to be worth the resize.
function worthResizing(object, key) {
  const type = (object.httpMetadata && object.httpMetadata.contentType || "").toLowerCase();
  return object.size > LIGHT_IMAGE_BYTES && (RESIZABLE_TYPES.has(type) || /\.(?:jpe?g|png|webp|avif)$/i.test(key));
}

function imageCacheKey(request, url, variant) {
  const key = new URL(url.toString());
  key.searchParams.set("__v", CACHE_VERSION);
  key.searchParams.set("__d", (variant.phone ? "phone" : "wide") + (variant.webp ? "-webp" : ""));
  return new Request(key.toString(), { method: "GET", headers: request.headers });
}

async function serveImage(request, env, ctx, url) {
  const variant = imageVariant(request);
  const cache = caches.default;
  const cacheKey = imageCacheKey(request, url, variant);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.MEDIA) return new Response("Not found", { status: 404 });
  const relative = decodeURIComponent(url.pathname.slice("/images/".length));
  // The platform's records sit beside the pictures (meta/, snapshots/, blueprints/, source/, pages/, sitemaps/): never served.
  if (/^(?:meta|snapshots|blueprints|source|pages|sitemaps)\//i.test(relative) || /(?:^|\/)\.\.(?:\/|$)/.test(relative)) return new Response("Not found", { status: 404 });
  const key = MEDIA_PREFIX + relative;
  const object = await env.MEDIA.get(key);
  // Not in media: a photo committed under public/images/ is still this site's to serve.
  if (!object) return url.pathname === new URL(request.url).pathname ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });

  const askedWidth = Math.max(parseInt(url.searchParams.get("w") || "0", 10) || 0, 0);
  // Asked for by a picture that can afford it, such as a page backdrop. Out of range is the ordinary quality.
  const asked = parseInt(url.searchParams.get("q") || "0", 10) || 0;
  const quality = asked >= 40 && asked <= 90 ? asked : IMAGE_QUALITY;
  const requestedFormat = (url.searchParams.get("format") || "").toLowerCase();
  const format = FORMATS[requestedFormat] || "image/webp";
  // No size or format in the address. Pictures reach a site by several doors and only one of them makes them web-ready,
  // and a stylesheet, a store card or a popup can name one directly, so this is the one place all of them pass through.
  const bare = !askedWidth && !requestedFormat;
  const width = askedWidth >= MAX_WIDTH ? MAX_WIDTH
    : Math.min(askedWidth || (bare ? SCREEN_WIDTH : 0), variant.phone ? PHONE_WIDTH : MAX_WIDTH);

  let response;
  try {
    // A light picture is served as it is stored, so Images runs only where it
    // saves something, avoiding a transformation and decode on every photo.
    if (bare && !(variant.webp && worthResizing(object, key))) {
      const headers = new Headers({ "cache-control": "public, max-age=31536000, immutable" });
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      response = new Response(object.body, { headers });
    } else {
      if (!env.IMAGES) throw new Error("no images binding");
      let pipeline = env.IMAGES.input(object.body);
      // scale-down: a picture narrower than the screen is never blown up to fit the number.
      if (width) pipeline = pipeline.transform({ width, fit: "scale-down" });
      const result = await pipeline.output(format === "image/png" ? { format } : { format, quality });
      const resized = result.response();
      const bytes = await resized.arrayBuffer();
      // A picture already squeezed harder than this comes out heavier than it went in (175 KB became 300). Sizing it
      // must never cost weight, so the stored one is the answer, unless the address asked for a format it is not in.
      if (!requestedFormat && bytes.byteLength >= object.size) throw new Error("the stored picture is lighter");
      response = new Response(bytes, { headers: resized.headers });
      response.headers.set("cache-control", "public, max-age=31536000, immutable");
    }
  } catch {
    // Images may consume the stream before rejecting an unsupported source.
    // Fetch the object again: reusing the disturbed body throws error 1101 and
    // turns a perfectly good original into a broken image.
    const original = await env.MEDIA.get(key);
    if (!original) return new Response("Not found", { status: 404 });
    const headers = new Headers({ "cache-control": "public, max-age=86400" });
    if (original.httpMetadata && original.httpMetadata.contentType) {
      headers.set("content-type", original.httpMetadata.contentType);
    }
    response = new Response(original.body, { headers });
  }

  response.headers.set("vary", "Accept, User-Agent");
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// VIDEO IS STREAMED, NEVER DOWNLOADED. A player asks for a video a piece at a time; answering with the
// whole file makes a visitor fetch all of it before they can seek, and some browsers will not play it at
// all. So a ranged request is answered with that range, read from storage as a range.
async function serveMedia(request, env, url) {
  if (!env.MEDIA) return new Response("Not found", { status: 404 });
  const key = MEDIA_PREFIX + decodeURIComponent(url.pathname.slice("/media/".length));
  // One range, as a player sends it. Anything else is answered with the whole file, which every client accepts.
  const asked = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get("range") || "").trim());
  let object = null;
  let span = null;
  if (asked && (asked[1] || asked[2])) {
    try { object = await env.MEDIA.get(key, { range: request.headers }); } catch { object = null; }
    // A range past the end of the file is refused with the file's size. Storage itself refuses to read one,
    // so the size is asked for separately when it gave nothing back.
    const stored = object || await env.MEDIA.head(key);
    if (!stored) return new Response("Not found", { status: 404 });
    if (asked[1] ? Number(asked[1]) >= stored.size : Number(asked[2]) === 0) {
      if (object && object.body) await object.body.cancel();
      return new Response(null, { status: 416, headers: { "content-range": "bytes */" + stored.size, "accept-ranges": "bytes" } });
    }
    if (object && object.body) {
      const size = object.size;
      const offset = asked[1] ? Number(asked[1]) : Math.max(0, size - Number(asked[2]));
      const end = asked[1] && asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1;
      // Only what storage says it read is announced: a reply that names one range and carries another cannot be played.
      const read = object.range || {};
      const readOffset = read.suffix !== undefined ? Math.max(0, size - read.suffix) : read.offset;
      const readLength = read.suffix !== undefined ? size - readOffset : read.length === undefined ? size - readOffset : read.length;
      if (end >= offset && readOffset === offset && readLength === end - offset + 1) span = { offset, length: readLength };
      else await object.body.cancel();
    }
  }
  if (!span) object = await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes" });
  object.writeHttpMetadata(headers);
  // A copied video can be stored as plain bytes. A player needs its real type, so the name supplies it,
  // as the portal's preview does; a file stored with a type keeps it.
  const storedType = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!storedType || storedType === "application/octet-stream" || storedType === "binary/octet-stream") {
    const videoType = VIDEO_TYPES[key.slice(key.lastIndexOf(".") + 1).toLowerCase()];
    if (videoType) headers.set("content-type", videoType);
  }
  if (/^font\//i.test(headers.get("content-type") || "")) {
    headers.set("access-control-allow-origin", "*");
    headers.set("cross-origin-resource-policy", "cross-origin");
  }
  if (/^application\/pdf(?:$|;)/i.test(headers.get("content-type") || "")) {
    headers.set("content-disposition", "inline");
  }
  headers.set("etag", object.httpEtag);
  if (span) {
    headers.set("content-range", "bytes " + span.offset + "-" + (span.offset + span.length - 1) + "/" + object.size);
    headers.set("content-length", String(span.length));
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}

async function serveInstagramFeed(env) {
  if (!env.MEDIA) return Response.json({ connected: false, items: [] }, { headers: { "cache-control": "public, max-age=60" } });
  const object = await env.MEDIA.get(INSTAGRAM_FEED_KEY);
  if (!object) return Response.json({ connected: false, items: [] }, { headers: { "cache-control": "public, max-age=60" } });
  return new Response(object.body, { headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300, stale-while-revalidate=86400"
  } });
}

async function serveFacebookFeed(env) {
  if (!env.MEDIA) return Response.json({ connected: false, items: [] }, { headers: { "cache-control": "public, max-age=60" } });
  const object = await env.MEDIA.get(FACEBOOK_FEED_KEY);
  if (!object) return Response.json({ connected: false, items: [] }, { headers: { "cache-control": "public, max-age=60" } });
  return new Response(object.body, { headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300, stale-while-revalidate=86400"
  } });
}

async function serveEventSnapshot(request, env, calendar = false) {
  if (!env.MEDIA) return new Response("Not found", { status: 404 });
  const object = await env.MEDIA.get(calendar ? EVENTS_ICS_KEY : EVENTS_JSON_KEY);
  if (!object) return new Response("Not found", { status: 404 });
  const etag = object.customMetadata?.etag || object.httpEtag;
  if (etag && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  const headers = new Headers({
    "content-type": calendar ? "text/calendar; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": calendar ? "public, max-age=300, stale-while-revalidate=86400" : "public, max-age=60, stale-while-revalidate=3600"
  });
  if (etag) headers.set("etag", etag);
  if (calendar) headers.set("content-disposition", 'inline; filename="events.ics"');
  return new Response(object.body, { headers });
}

let eventSnapshotCache = { checkedAt: 0, value: null };
async function readEventSnapshot(env) {
  if (eventSnapshotCache.checkedAt > Date.now() - 5000) return eventSnapshotCache.value;
  const object = env.MEDIA ? await env.MEDIA.get(EVENTS_JSON_KEY) : null;
  let value = null;
  if (object) {
    try { value = JSON.parse(await object.text()); } catch { /* an incomplete snapshot cannot become a page */ }
  }
  eventSnapshotCache = { checkedAt: Date.now(), value };
  return value;
}

function eventDetailRoutes(snapshot) {
  if (!snapshot?.enabled) return [];
  const routes = new Map();
  for (const event of snapshot.events || []) {
    const raw = String(event.url || "");
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("?") || raw.includes("#")) continue;
    const route = raw.endsWith("/") ? raw : raw + "/";
    if (route === "/" || route.startsWith("/api/")) continue;
    routes.set(route, { path: route, name: String(event.title || "Event").slice(0, 200), event });
  }
  return [...routes.values()];
}

async function serveUpdateSnapshot(request, env) {
  if (!env.MEDIA) return new Response("Not found", { status: 404 });
  const object = await env.MEDIA.get(UPDATES_JSON_KEY);
  if (!object) return new Response("Not found", { status: 404 });
  const etag = object.customMetadata?.etag || object.httpEtag;
  if (etag && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=60, stale-while-revalidate=3600"
  });
  if (etag) headers.set("etag", etag);
  return new Response(object.body, { headers });
}

// The shop as published for this website (src/commerce/store-layout.js). A shop on the split layout is its settings
// (store.json, read again every second) and its list (list.json, parsed once per version); an older shop is one file
// (products.json). The same version is the same object, so the projection over every product is worked out once per
// version for a few seconds, not on every call.
let commerceSnapshotCache = { checkedAt: 0, key: "", raw: null };
let storeListCache = { version: "", rows: null };
let storeProjectionCache = { raw: null, at: 0, value: null };
async function readStoreState(env) {
  if (commerceSnapshotCache.checkedAt > Date.now() - 1000) return commerceSnapshotCache;
  const previous = commerceSnapshotCache;
  let key = "", raw = null;
  const settings = env.MEDIA ? await env.MEDIA.get(STORE_FILES_PREFIX + "store.json").catch(() => null) : null;
  if (settings) {
    try {
      const store = JSON.parse(await settings.text());
      if (store.listVersion && storeListCache.version !== store.listVersion) {
        const object = await env.MEDIA.get(STORE_FILES_PREFIX + "list.json").catch(() => null);
        const list = object ? JSON.parse(await object.text()) : null;
        // A list newer than the settings is used, and read again until the settings catch up.
        if (list) storeListCache = { version: list.version === store.listVersion ? list.version : "", rows: Array.isArray(list.products) ? list.products : [] };
      }
      key = "store " + (settings.etag || settings.httpEtag || "") + " " + store.listVersion + " " + storeListCache.version;
      raw = { ...store, products: storeListCache.rows || [], sourceProducts: [], storeLayout: Number(store.layout) || 3 };
    } catch { raw = null; key = ""; }
  }
  if (!raw && env.MEDIA) {
    const object = await env.MEDIA.get(PRODUCTS_JSON_KEY).catch(() => null);
    if (object) {
      try { raw = JSON.parse(await object.text()); key = "file " + (object.etag || object.httpEtag || ""); } catch { raw = null; key = ""; }
    }
  }
  if (key && key.trim() !== "file" && previous.key === key && previous.raw) raw = previous.raw;
  commerceSnapshotCache = { checkedAt: Date.now(), key, raw };
  return commerceSnapshotCache;
}

async function readCommerceSnapshot(env) {
  const { raw } = await readStoreState(env);
  if (!raw) return null;
  if (storeProjectionCache.raw !== raw || storeProjectionCache.at < Date.now() - 15000) {
    storeProjectionCache = { raw, at: Date.now(), value: projectShopCatalog(raw, new URLSearchParams()) };
  }
  return storeProjectionCache.value;
}

// One product page, with everything its page shows. On the split layout its rows come from its product file, with the
// list's price, stock and availability over them: the list is always current, a product file can be a minute behind it.
async function readStoreDetail(env, pathname) {
  const snapshot = await readCommerceSnapshot(env);
  if (!snapshot) return null;
  const params = new URLSearchParams([["view", "detail"], ["path", pathname]]);
  const { raw } = commerceSnapshotCache;
  if (!raw?.storeLayout) return projectShopCatalog(snapshot, params);
  const route = (value) => { let text = String(value || "/"); while (text.length > 1 && text.endsWith("/")) text = text.slice(0, -1); return text; };
  const listed = (raw.products || []).filter((row) => route(row.sourcePath) === route(pathname));
  const full = new Map();
  for (const name of [...new Set(listed.map((row) => row.chunk).filter(Boolean))]) {
    const object = await env.MEDIA.get(STORE_FILES_PREFIX + "p/" + name + ".json").catch(() => null);
    try { for (const row of (object ? JSON.parse(await object.text()).rows : null) || []) full.set(row.id, row); } catch { /* the list row alone */ }
  }
  const rows = listed.map((row) => {
    const stored = full.get(row.id);
    if (!stored) return row;
    const current = { ...row };
    delete current.description;
    return { ...stored, ...current, catalog: { ...stored.catalog, ...current.catalog } };
  });
  return projectShopCatalog({ ...raw, products: rows, sourceProducts: [] }, params);
}

// How the owner set the store up in the menu (shop console, Settings); the platform defaults otherwise.
function storeNavigationSettings(snapshot) {
  const saved = snapshot?.storeNavigation || {};
  let today = new Date().toISOString().slice(0, 10);
  try { today = new Intl.DateTimeFormat("en-CA", { timeZone: snapshot?.collectionTimeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); } catch {}
  const groups = (Array.isArray(saved.groups) ? saved.groups : []).map((group) => ({
    title: String(group.title || ""),
    items: (Array.isArray(group.items) ? group.items : []).filter((item) => String(item.href || "").startsWith("/")
      && !String(item.href).startsWith("//") && (!item.until || String(item.until) >= today))
  })).filter((group) => group.items.length);
  return {
    showStore: saved.showStore !== false, label: String(saved.label || "Store"), allLabel: String(saved.allLabel || "All products"),
    // A gallery or catalog sells nothing, so it has no cart (storeMode in shop-policy.js).
    selling: storeMode(snapshot?.storeDisplay) === "shop",
    showCart: saved.showCart !== false && storeMode(snapshot?.storeDisplay) === "shop", cartLabel: String(saved.cartLabel || "Cart"), groups,
    // A link of the website's own menu the store's drop-down hangs under, instead of a Store button (storeMenuAt in shop-policy.js).
    menuAt: typeof saved.menuAt === "string" && saved.menuAt.startsWith("/") && !saved.menuAt.startsWith("//") ? saved.menuAt : "",
    // Snapshots from before order history was opt-in say enabled without the owner choosing it.
    orderHistory: snapshot?.customerOrderHistory?.optIn === true && snapshot.customerOrderHistory.enabled === true
  };
}

function cartLinkContent(label) {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle>'
    + '<path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"></path></svg><span>' + escapeStoreHtml(label) + '</span>';
}

// The Store item: a link to the store, plus (with lists) a button opening a drop-down. It stays a real
// link so the site's own menu-link styles apply to it, and the store opens even without JavaScript.
function storeLinkMarkup(settings, classes) {
  return '<a class="' + classes + '" href="/shop/">' + escapeStoreHtml(settings.label) + '</a>' + storeSubmenuMarkup(settings);
}

// attached: under a page of the website's own menu, which is itself the way into the store, so no all-products link.
function storeSubmenuMarkup(settings, attached) {
  if (!settings.groups.length && !settings.orderHistory) return "";
  const lists = settings.groups.map((group) => '<li class="ww-store-submenu-group">'
    + (group.title ? '<span class="ww-store-submenu-title">' + escapeStoreHtml(group.title) + '</span>' : "")
    + '<ul>' + group.items.map((item) => '<li><a href="' + escapeStoreHtml(item.href) + '">' + escapeStoreHtml(item.label) + '</a></li>').join("") + '</ul></li>').join("");
  const history = settings.orderHistory ? '<li><a class="ww-store-submenu-orders" href="/orders/" data-ww-order-history-link>Order history</a></li>' : "";
  return '<button type="button" class="ww-store-toggle" aria-expanded="false" aria-label="' + escapeStoreHtml("More in " + settings.label) + '"><span aria-hidden="true"></span></button>'
    + '<ul class="ww-store-submenu">' + (attached ? "" : '<li><a class="ww-store-submenu-all" href="/shop/">' + escapeStoreHtml(settings.allLabel) + '</a></li>') + lists + history + '</ul>';
}

// Store and Cart as items of the site's own menu: wrapped like its other items and carrying their link class.
function commerceNavigationMarkup({ itemClass = "", linkClass = "", wrap = false, store = true, cart = true, settings = storeNavigationSettings(null) } = {}) {
  const classes = (extra) => [linkClass, extra].filter(Boolean).join(" ");
  const links = [];
  if (store && settings.showStore) links.push(storeLinkMarkup(settings, classes("ww-commerce-nav-link")));
  if (cart && settings.showCart) links.push('<a class="' + classes("ww-commerce-nav-link ww-cart-nav") + '" href="/cart/" aria-label="View shopping cart" title="Shopping cart">'
    + cartLinkContent(settings.cartLabel) + '</a>');
  if (!wrap) return links.join("");
  return links.map((link) => {
    const itemClasses = [itemClass, link.includes("ww-store-submenu") ? "ww-store-menu" : ""].filter(Boolean).join(" ");
    return '<li' + (itemClasses ? ' class="' + itemClasses + '"' : "") + ' data-ww-store-nav>' + link + '</li>';
  }).join("");
}

// Class tokens safe to copy into markup; state classes belong to the item they were on.
function navigationClass(value) {
  return String(value || "").split(" ").filter((token) => /^[A-Za-z0-9_-]+$/.test(token)
    && !["active", "current", "is-active", "is-current", "selected"].includes(token)).join(" ");
}

async function legacyaddCommerceNavigation(response, env) {
  if (!response.ok || !String(response.headers.get("content-type") || "").includes("text/html")
    || typeof HTMLRewriter === "undefined") return response;
  const snapshot = await readCommerceSnapshot(env);
  if (!snapshot?.enabled) return response;
  // Only the site header takes store links; a <header> inside page content
  // (product summaries, articles) is content and must stay untouched.
  const settings = storeNavigationSettings(snapshot);
  const configured = snapshot.storeNavigation?.configured === true;
  let menuFound = false, siteHeader = "pending", contentStarted = false, listClaimed = false;
  let storeLinked = !settings.showStore, cartLinked = !settings.showCart;
  // Under a link of the site's own menu, the store needs no button of its own once that link is found.
  const menuAt = settings.showStore ? settings.menuAt : "";
  const atMenuLink = (path) => Boolean(menuAt) && (path.endsWith("/") ? path : path + "/") === menuAt;
  // Order history goes in the first store menu of the header: the platform Store drop-down or the site's own (renamed) store folder.
  let historyPlaced = !settings.orderHistory;
  const withHistory = () => { const current = historyPlaced ? { ...settings, orderHistory: false } : settings; historyPlaced = true; return current; };
  const folders = [];
  const itemClasses = new Map(), linkClasses = new Map();
  const tally = (counts, value) => counts.set(value, (counts.get(value) || 0) + 1);
  // The most common item and link class is an ordinary menu item; a call-to-action button is the exception.
  const common = (counts) => [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
  const missing = (wrap) => commerceNavigationMarkup({ itemClass: common(itemClasses), linkClass: common(linkClasses), wrap,
    store: !storeLinked, cart: !cartLinked, settings: !storeLinked && settings.showStore ? withHistory() : settings });
  const MENU = "header nav ul, header ul.nav-list, header ul#primary-nav";
  // Store styles load first, so the site's own stylesheet can restyle the store.
  return new HTMLRewriter().on("head", { element(element) { element.prepend('<link rel="stylesheet" href="/shop.css">', { html: true }); } }).on("main, article", {
    element() { contentStarted = true; }
  }).on("header", {
    element(element) {
      if (siteHeader !== "pending" || contentStarted) return;
      siteHeader = "open";
      menuFound = element.getAttribute("data-ww-commerce-nav") === "true";
      element.onEndTag((endTag) => {
        siteHeader = "closed";
        if (!menuFound && (!storeLinked || !cartLinked)) endTag.before('<nav aria-label="Store" class="ww-commerce-navigation">' + missing(false) + '</nav>', { html: true });
      });
    }
  }).on("header a[href]", {
    element(element) {
      if (siteHeader !== "open") return;
      const folder = folders[folders.length - 1];
      if (folder && element.getAttribute("data-ww-store-entry") === "true" && !folder.store) {
        folder.store = true;
        folder.linkClass = navigationClass(element.getAttribute("class"));
      }
      const href = String(element.getAttribute("href") || "");
      if (!href.startsWith("/") || href.startsWith("//")) return;
      const path = href.split("?")[0].split("#")[0];
      const store = path === "/shop" || path.startsWith("/shop/"), cart = path === "/cart" || path.startsWith("/cart/");
      if (store) storeLinked = true;
      if (cart) cartLinked = true;
      // Links the platform put in the menu at build time follow the owner's menu settings too.
      const classes = " " + String(element.getAttribute("class") || "") + " ";
      if (!classes.includes(" ww-commerce-nav-link ")) return;
      if (store && (path === "/shop" || path === "/shop/")) {
        if (configured && !settings.showStore) element.replace('<span hidden data-ww-store-hidden></span>', { html: true });
        else if (configured || settings.orderHistory) {
          if (configured) element.setInnerContent(settings.label);
          element.after(storeSubmenuMarkup(withHistory()), { html: true });
        }
      } else if (cart && (configured || !settings.selling)) {
        if (!settings.showCart) element.replace('<span hidden data-ww-store-hidden></span>', { html: true });
        else if (classes.includes(" ww-cart-nav ") && !classes.includes(" ww-sh-icon ")) element.setInnerContent(cartLinkContent(settings.cartLabel), { html: true });
      }
    }
  }).on("header nav a[href], header ul.nav-list a[href], header ul#primary-nav a[href]", {
    element(element) {
      if (siteHeader !== "open" || !menuAt) return;
      const href = String(element.getAttribute("href") || "");
      if (!href.startsWith("/") || href.startsWith("//") || !atMenuLink(href.split("?")[0].split("#")[0])) return;
      // Every copy of the link (a phone menu repeats the header's) carries the drop-down; Order history goes in the first.
      storeLinked = true;
      element.after(storeSubmenuMarkup(withHistory(), true), { html: true });
    }
  }).on("header ul.nav-submenu", {
    element(element) {
      if (siteHeader !== "open") return;
      const folder = { store: false, linkClass: "" };
      folders.push(folder);
      element.onEndTag((endTag) => {
        folders.pop();
        if (!folder.store || historyPlaced) return;
        historyPlaced = true;
        endTag.before('<li><a' + (folder.linkClass ? ' class="' + folder.linkClass + '"' : "") + ' href="/orders/" data-ww-order-history-link>Order history</a></li>', { html: true });
      });
    }
  }).on(MENU, {
    element(element) {
      if (siteHeader !== "open" || menuFound || listClaimed) return;
      // The first list is the menu; a nested list is a dropdown inside it.
      listClaimed = true;
      if (element.getAttribute("data-ww-commerce-nav") === "true") { menuFound = true; return; }
      element.onEndTag((endTag) => {
        if (menuFound) return;
        menuFound = true;
        if (!storeLinked || !cartLinked) endTag.before(missing(true), { html: true });
      });
    }
  }).on("header nav li, header ul.nav-list li, header ul#primary-nav li", {
    element(element) { if (siteHeader === "open" && !menuFound) tally(itemClasses, navigationClass(element.getAttribute("class"))); }
  }).on("header nav a[href], header ul.nav-list a[href], header ul#primary-nav a[href]", {
    element(element) { if (siteHeader === "open" && !menuFound) tally(linkClasses, navigationClass(element.getAttribute("class"))); }
  }).on("header nav", {
    element(element) {
      if (siteHeader !== "open") return;
      // An element can only be read inside its own handler; reading it at the end tag throws and cuts the page off.
      const declared = element.getAttribute("data-ww-commerce-nav") === "true";
      element.onEndTag((endTag) => {
        if (menuFound || declared) return;
        menuFound = true;
        if (!storeLinked || !cartLinked) endTag.before(missing(false), { html: true });
      });
    }
  }).transform(response);
}

async function legacycommerceRoutes(env) {
  const snapshot = await readCommerceSnapshot(env);
  if (!snapshot?.enabled) return [];
  // A gallery has no product pages and a catalog nothing to check out (storeMode in shop-policy.js).
  const mode = storeMode(snapshot.storeDisplay);
  const routes = new Map([["/shop/", { path: "/shop/", name: "Store" }],
    ...(mode === "shop" ? [["/checkout/", { path: "/checkout/", name: "Checkout" }]] : [])]);
  for (const product of mode === "gallery" ? [] : [...(snapshot?.sourceProducts || []), ...(snapshot?.products || [])]) {
    const rawPath = String(product.sourcePath || "");
    if (!rawPath.startsWith("/") || rawPath.startsWith("//")) continue;
    try {
      const parsed = new URL(rawPath, "https://store.invalid");
      if (parsed.origin !== "https://store.invalid" || parsed.search || parsed.hash) continue;
      const route = parsed.pathname.endsWith("/") ? parsed.pathname : parsed.pathname + "/";
      routes.set(route, { path: route, name: String(product.title || "Product").slice(0, 200) });
    } catch { /* invalid owner/source paths do not become public routes */ }
  }
  return [...routes.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function legacyaddCommerceRoutesToManifest(response, env) {
  if (!response.ok) return response;
  let manifest;
  try { manifest = await response.json(); } catch { return response; }
  const hidden = new Set((await readCommerceSnapshot(env))?.hiddenProductPaths || []);
  const routes = new Map((manifest.routes || []).filter((route) => !hidden.has(route.path)).map((route) => [route.path, route]));
  const storeRoutes = await commerceRoutes(env);
  for (const route of storeRoutes) {
    if (!routes.has(route.path)) routes.set(route.path, { ...route, purpose: "Managed product detail" });
  }
  if (storeRoutes.some((route) => route.path === "/checkout/") && !routes.has("/cart/")) {
    routes.set("/cart/", { path: "/cart/", name: "Cart", purpose: "Review your selected products" });
  }
  for (const route of eventDetailRoutes(await readEventSnapshot(env))) {
    routes.set(route.path, { path: route.path, name: route.name, purpose: "Managed event detail" });
  }
  return Response.json({ ...manifest, routes: [...routes.values()] }, {
    headers: { "cache-control": "public, max-age=60, stale-while-revalidate=3600" }
  });
}

async function legacyaddCommerceRoutesToSitemap(body, env, origin) {
  const hidden = new Set((await readCommerceSnapshot(env))?.hiddenProductPaths || []);
  body = String(body).replace(/<url>\s*<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/g, (entry, loc) => {
    try { return hidden.has(new URL(loc, origin).pathname) ? "" : entry; } catch { return entry; }
  });
  const known = new Set([...String(body).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => {
    try { return new URL(match[1], origin).pathname; } catch { return ""; }
  }));
  const storeRoutes = await commerceRoutes(env);
  const routes = [...storeRoutes, ...(storeRoutes.some((route) => route.path === "/checkout/") ? [{ path: "/cart/", name: "Cart" }] : []),
    ...eventDetailRoutes(await readEventSnapshot(env))];
  if (!routes.length) return String(body);
  const additions = routes.filter((route) => !known.has(route.path)).map((route) => {
    const loc = escapeStoreHtml(new URL(route.path, origin).href);
    return "<url><loc>" + loc + "</loc></url>";
  }).join("");
  return additions ? String(body).replace(/<\/urlset>\s*$/i, additions + "</urlset>") : String(body);
}

function projectShopCatalog(snapshot, params) {
  snapshot = { ...snapshot, collectionTimeZone: SHOP_COLLECTION_CONFIG.timeZone || snapshot.collectionTimeZone || "UTC" };
  const route = (value) => String(value || "/").replace(/\/+$/, "") || "/";
  const byId = new Map();
  for (const row of [...snapshot.sourceProducts || [], ...snapshot.products || []]) byId.set(row.id, row);
  const expired = [...byId.values()].filter(row => productExpired(row, snapshot.retentionPolicy));
  const expiredIds = new Set(expired.map(row => row.id));
  let rows = [...byId.values()].filter((row) => row.catalog?.visible !== false && !expiredIds.has(row.id)).map((row) => {
    const closed = row.catalog?.saleType === "preorder" && row.catalog?.orderCutoffAt
      && Date.parse(row.catalog.orderCutoffAt) <= Date.now();
    return { ...productSalePrice(row), purchasable: row.purchasable && !closed, orderingClosed: Boolean(closed) };
  });
  const view = params.get("view");
  const visiblePaths = new Set(rows.map(row => row.sourcePath));
  const base = { ...snapshot, hiddenProductPaths: [...new Set([...(snapshot.hiddenProductPaths || []), ...expired.filter(row => !visiblePaths.has(row.sourcePath)).map(row => row.sourcePath)])], products: [], sourceProducts: [] };
  const result = (selected) => ({ ...base, sourceProducts: selected.filter((row) => !row.active), products: selected.filter((row) => row.active) });
  if (view === "detail") return result(rows.filter((row) => route(row.sourcePath) === route(params.get("path"))));
  if (view === "cart") {
    const ids = new Set(String(params.get("ids") || "").split(",").slice(0, 100));
    return result(rows.filter((row) => ids.has(row.id)));
  }
  if (view !== "list") return result(rows);
  const category = params.get("category") || "*";
  const categoriesOf = (row) => [row.categoryPath, ...(row.catalog?.categories || []).map((item) => item.path || item.label)].filter(Boolean);
  const attributesOf = (row) => ({ ...(row.catalog?.attributes || {}), ...(row.variantOptions || {}) });
  const categories = new Map();
  const attributes = new Map();
  for (const row of rows) {
    for (const value of categoriesOf(row)) categories.set(value, { value, label: row.catalog?.categories?.find((item) => (item.path || item.label) === value)?.label || value });
  }
  const layout = storeCardLayout(snapshot.storeDisplay);
  const gallery = storeMode(snapshot.storeDisplay) === "gallery";
  // Cards that show pre-order dates let shoppers pick one of the order-by days still to come.
  const today = new Date().toISOString().slice(0, 10);
  const cutoffDates = layout.parts.includes("dates") ? [...new Set(rows.map(row => productCutoffDay(row, snapshot.collectionTimeZone || "UTC")).filter(day => day && day >= today))].sort().slice(0, 30) : [];
  if (params.get("cutoffDate")) rows = rows.filter(row => productCutoffDay(row, snapshot.collectionTimeZone || "UTC") === params.get("cutoffDate"));
  if (category !== "*") rows = rows.filter((row) => categoriesOf(row).some((value) => route(value) === route(category)));
  // A rolling window: only products whose order cutoff is the next one still open.
  let cutoffWindow = null;
  if (params.get("window") === "next-cutoff") {
    const day = (row) => { const at = Date.parse(row.catalog?.orderCutoffAt || ""); return at > Date.now() ? new Date(at).toISOString().slice(0, 10) : ""; };
    const next = rows.map(day).filter(Boolean).sort()[0] || "";
    rows = next ? rows.filter((row) => day(row) === next) : [];
    const first = rows[0]?.catalog?.orderCutoffAt || null;
    cutoffWindow = { name: "next-cutoff", cutoffAt: first };
  }
  const query = String(params.get("q") || "").trim().toLowerCase().slice(0, 200);
  if (query) rows = rows.filter((row) => [row.title, row.description, row.sku, row.catalog?.brand, ...(row.catalog?.tags || [])].join(" ").toLowerCase().includes(query));
  // Cross-category variant choices (meal preparation, clothing size, etc.)
  // are not useful together. Collect relevant facets before attribute filters.
  for (const row of rows) {
    const valuesByName = category !== "*" || categories.size <= 1 ? attributesOf(row)
      : Object.fromEntries(Object.entries(row.catalog?.attributes || {}).filter(([name]) => !Object.hasOwn(row.variantOptions || {}, name)));
    for (const [name, values] of Object.entries(valuesByName)) {
      const facet = attributes.get(name) || new Set();
      for (const value of [].concat(values || [])) facet.add(String(value));
      attributes.set(name, facet);
    }
  }
  // One attr.<Detail> parameter: a value, A|B for any of several, !A|B for none of them (a store menu's limited list).
  // Written inline: this function is copied into every site's server, so nothing outside it travels with it.
  // A value some product really has, exactly as written (a detail called "!Hot" or "Fast|Loud"), is that value and nothing else.
  for (const [key, value] of params) if (key.startsWith("attr.")) {
    const exact = Boolean(attributes.get(key.slice(5))?.has(value));
    const none = !exact && value.startsWith("!"), wanted = exact ? [value] : (none ? value.slice(1) : value).split("|");
    rows = rows.filter((row) => {
      const have = [].concat(attributesOf(row)[key.slice(5)] || []).map(String);
      return none ? !wanted.some((item) => have.includes(item)) : wanted.some((item) => have.includes(item));
    });
  }
  const groups = new Map();
  for (const row of rows) {
    const key = row.sourceKey || row.id;
    const group = groups.get(key) || []; group.push(row); groups.set(key, group);
  }
  let entries = [...groups.values()];
  const amount = (group) => Math.min(...group.filter((row) => row.priceAmount != null && Number.isFinite(Number(row.priceAmount))).map((row) => Number(row.priceAmount)));
  // The shopper's choice, else the first order the owner chose for the filter bar (storeDisplay.defaultSort), else the
  // list's own: a list copied from another site asks for that site's order (order=source), any other is by name.
  const sort = params.get("sort") || snapshot.storeDisplay?.defaultSort || (params.get("order") === "source" ? "source" : "") || "name";
  const byTitle = (a, b) => String(a[0].title).localeCompare(String(b[0].title));
  // The source's order: each product's place in this list's collection on the site it was copied from, or in its list of
  // all products for a list of everything (TheGlamourAddict's hand-ordered /collections/frontpage/, Nov 23 2026). What
  // the source did not list (added since, or never seen) follows, by name.
  const places = sort === "source" ? new Map(entries.map((group) => [group, Math.min(...group.map((row) => {
    const at = category === "*" ? row.catalog?.position
      : (row.catalog?.categories || []).find((item) => route(item.path || item.label) === route(category))?.position;
    return Number.isSafeInteger(at) ? at : Infinity;
  }))])) : null;
  // Newest: when the product was added. Order-by date: the next cutoff still open first; closed or undated ones last.
  const when = (group) => sort === "newest"
    ? Math.max(...group.map((row) => Date.parse(row.createdAt || "") || -Infinity))
    : Math.min(...group.map((row) => { const at = Date.parse(row.catalog?.orderCutoffAt || ""); return at > Date.now() ? at : Infinity; }));
  entries.sort((a, b) => {
    if (places) { const left = places.get(a), right = places.get(b); return left === right ? byTitle(a, b) : left < right ? -1 : 1; }
    if (sort === "name-desc") return byTitle(b, a);
    if (sort === "newest" || sort === "cutoff") {
      const left = when(a), right = when(b);
      if (left === right) return byTitle(a, b);
      return Math.sign(sort === "newest" ? right - left : left - right);
    }
    if (!["price-asc", "price-desc"].includes(sort)) return byTitle(a, b);
    const left = amount(a), right = amount(b);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.isFinite(left) ? -1 : Number.isFinite(right) ? 1 : 0;
    // Different currencies are grouped, never presented as converted prices.
    return String(a[0].currency).localeCompare(String(b[0].currency)) || (sort === "price-desc" ? right - left : left - right);
  });
  const pageSize = Math.min(48, Math.max(1, Math.floor(Number(params.get("pageSize")) || 24)));
  const total = entries.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(params.get("page")) || 1)));
  // Lists use only a thumbnail and the data needed to summarize the real variants.
  const selected = entries.slice((page - 1) * pageSize, page * pageSize).map((group) => {
    const active = group.filter((variant) => variant.active);
    const displayed = active.length ? active : group;
    const row = displayed[0];
    const amounts = displayed.filter((variant) => variant.priceAmount != null && Number.isFinite(Number(variant.priceAmount))).map((variant) => Number(variant.priceAmount));
    const currencies = new Map();
    for (const variant of displayed) {
      if (variant.priceAmount == null || !Number.isFinite(Number(variant.priceAmount))) continue;
      const values = currencies.get(variant.currency) || []; values.push(Number(variant.priceAmount)); currencies.set(variant.currency, values);
    }
    return { priceRanges: [...currencies].map(([currency, values]) => ({ currency, low: Math.min(...values), high: Math.max(...values) })),
      id: row.id, sourceKey: row.sourceKey, sourcePath: row.sourcePath, categoryPath: row.categoryPath,
      // The product's own picture where it keeps one apart from its options' (catalog.productImage), else its first row's.
      title: row.title, imageUrl: row.catalog?.productImage || row.imageUrl || row.catalog?.images?.[0]?.url,
      // Its published reviews' average and count (docs/commerce/product-reviews.md), for the card's stars.
      ...(row.rating?.count > 0 ? { rating: { average: row.rating.average, count: row.rating.count } } : {}),
      // A gallery has no product pages, so its cards carry the whole description, not the first few words.
      ...((gallery || layout.parts.includes("summary")) && row.description ? { summary: (() => {
        const text = String(row.description).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        const most = gallery ? 1200 : 160;
        return text.length > most ? text.slice(0, most).replace(/\s+\S*$/, "") + "…" : text;
      })() } : {}),
      priceAmount: amounts.length ? Math.min(...amounts) : null,
      ...(layout.details.length ? { details: Object.fromEntries(layout.details.map((name) => [name, [].concat(attributesOf(row)[name] ?? []).map(String).filter(Boolean)]).filter(([, values]) => values.length)) } : {}),
      priceHighAmount: amounts.length ? Math.max(...amounts) : null,
      regularPriceAmount: row.regularPriceAmount, onSale: displayed.some(variant => variant.onSale),
      // Every option on sale from one regular price (a Shopify product's sizes, each with the same compare-at
      // price): the card can show that price crossed out. Options at different regular prices, or only some on
      // sale, never are.
      ...(displayed.length > 1 && displayed.every((variant) => variant.onSale && variant.regularPriceAmount != null
        && variant.currency === row.currency && Number(variant.regularPriceAmount) === Number(row.regularPriceAmount)) ? { regularShared: true } : {}),
      catalog: { saleType: row.catalog?.saleType, orderCutoffAt: row.catalog?.orderCutoffAt, orderCutoffTimeZone: row.catalog?.orderCutoffTimeZone,
        releaseAt: row.catalog?.releaseAt, releaseDate: row.catalog?.releaseDate, ...(row.catalog?.inStoreOnly === true ? { inStoreOnly: true } : {}),
        // Its maker, for a card that shows it (a copied Shopify theme's vendor line, product-card-runtime.mjs).
        ...(row.catalog?.brand ? { brand: row.catalog.brand } : {}) },
      orderingClosed: group.every((variant) => variant.orderingClosed),
      currency: row.currency, active: group.some((variant) => variant.active),
      purchasable: group.some((variant) => variant.active && variant.purchasable), variantCount: group.length
    };
  });
  return { ...result(selected), pagination: { page, pageSize, pages, total }, ...(cutoffWindow ? { cutoffWindow } : {}), facets: {
    categories: [...categories.values()].sort((a, b) => a.label.localeCompare(b.label)),
    ...(cutoffDates.length ? { cutoffDates } : {}),
    attributes: Object.fromEntries([...attributes].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, [...values].sort()]))
  } };
}


function productTemplateMoney(amount, currency, format) {
  if (amount === null || amount === undefined || amount === "" || !Number.isFinite(Number(amount)) || !currency) return "";
  const code = String(currency).toUpperCase();
  let digits = 2;
  try { digits = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits; }
  catch { return ""; }
  const major = Number(amount) / Math.pow(10, digits);
  if (!format || String(format.currency || "").toUpperCase() !== code) {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(major); } catch { return ""; }
  }
  const fraction = format.fraction === 0 && Math.round(major * 100) % 100 !== 0 ? 2 : Number.isInteger(format.fraction) ? format.fraction : digits;
  const parts = major.toFixed(fraction).split(".");
  const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, typeof format.thousands === "string" ? format.thousands : ",");
  return String(format.prefix || "") + whole + (parts[1] ? String(format.decimal || ".") + parts[1] : "") + String(format.suffix || "");
}
function descriptionFrameSource(value) {
  const src = String(value ?? "").trim();
  return /^https:\/\/(?:(?:www\.)?giphy\.com\/embed\/[A-Za-z0-9]+(?:\/video)?|(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[A-Za-z0-9_-]{6,20}|player\.vimeo\.com\/video\/\d{4,12})(?:\?[^\s"'<>\\#]*)?$/.test(src) ? src : "";
}
function productDescriptionHtml(description, rich) {
  if (!rich || typeof rich !== "object" || typeof rich.html !== "string" || typeof rich.text !== "string") return "";
  const plain = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim();
  const html = rich.html;
  if (!html.trim() || html.length > 60000 || !plain(rich.text) || plain(rich.text) !== plain(description)) return "";
  const shapes = { p: "", div: "", br: "", hr: "", h1: "", h2: "", h3: "", h4: "", h5: "", h6: "", ul: "", ol: "start type", li: "",
    strong: "", b: "", em: "", i: "", u: "", s: "", sub: "", sup: "", small: "", blockquote: "", table: "", caption: "", thead: "",
    tbody: "", tfoot: "", tr: "", th: "colspan rowspan", td: "colspan rowspan", a: "href", img: "src alt width height loading decoding",
    iframe: "src width height title allowfullscreen frameborder loading style" };
  const empty = { br: true, hr: true, img: true };
  // The markup as the migration wrote it: an attribute's value escapes only & and ", as &amp; and &quot;.
  const decoded = (value) => value.replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  const fits = {
    href: (value) => /^(?:\/(?![/\\])|https?:\/\/[^/\\]|mailto:|tel:)[^\s\\]*$/i.test(value),
    src: (value) => /^\/images\/[^\s\\]+$/.test(value),
    "iframe src": (value) => descriptionFrameSource(value) === value,
    alt: () => true,
    title: (value) => /\S/.test(value),
    width: (value) => /^\d{1,5}$/.test(value), height: (value) => /^\d{1,5}$/.test(value),
    colspan: (value) => /^\d{1,3}$/.test(value), rowspan: (value) => /^\d{1,3}$/.test(value), start: (value) => /^\d{1,6}$/.test(value),
    type: (value) => /^[1aAiI]$/.test(value), loading: (value) => value === "lazy" || value === "eager",
    decoding: (value) => value === "async" || value === "sync" || value === "auto",
    allowfullscreen: (value) => value === "", frameborder: (value) => value === "0" || value === "1",
    // An embed's size as its owner set it, scaled down to a narrower screen (written by the migration, never copied).
    style: (value) => /^width:100%;max-width:\d{1,5}px;height:auto;aspect-ratio:\d{1,5}\/\d{1,5}$/.test(value)
  };
  const open = [];
  let fine = true;
  // An embed holds nothing: its closing tag follows its opening tag at once.
  let frameEnd = -1;
  const rest = html.replace(/<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+="[^"<>]*")*)\s*(\/?)>/g, (match, closing, name, attributes, selfClosing, offset) => {
    if (frameEnd >= 0 && (!closing || name !== "iframe" || offset !== frameEnd)) fine = false;
    frameEnd = -1;
    if (!Object.prototype.hasOwnProperty.call(shapes, name)) { fine = false; return ""; }
    if (closing) {
      if (attributes || selfClosing || empty[name] || open.pop() !== name) fine = false;
      return "";
    }
    if (selfClosing && !empty[name]) fine = false;
    if (!empty[name]) open.push(name);
    if (name === "iframe") frameEnd = offset + match.length;
    const allowed = shapes[name].split(" ");
    const seen = {};
    for (const found of attributes.matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
      const attribute = found[1];
      const check = fits[name + " " + attribute] || fits[attribute];
      if (!allowed.includes(attribute) || seen[attribute] || /&(?!amp;|quot;)/.test(found[2]) || !check(decoded(found[2]))) fine = false;
      seen[attribute] = true;
    }
    if (name === "iframe" && (!seen.src || !seen.title)) fine = false;
    return "";
  });
  return fine && frameEnd < 0 && !open.length && !/[<>]/.test(rest) ? html : "";
}
function productTemplateDescription(text, rich) {
  const formatted = productDescriptionHtml(text, rich);
  if (formatted) return formatted;
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
  // A bullet alone on its line belongs to the words under it (a description kept before Nov 24 2026 has them so).
  return String(text || "").replace(/\r\n?/g, "\n").replace(/^([ \t]*•)[ \t]*\n(?=[ \t]*[^\s•])/gm, "$1 ").trim().split(/\n{2,}/).map((block) => {
    let html = "";
    let list = [];
    let lines = [];
    const flushList = () => { if (list.length) html += "<ul>" + list.map((item) => "<li>" + escape(item) + "</li>").join("") + "</ul>"; list = []; };
    const flushLines = () => { if (lines.length) html += "<p>" + lines.map(escape).join("<br>") + "</p>"; lines = []; };
    for (const line of block.split("\n")) {
      const item = line.match(/^\s*•\s?(.*)$/);
      if (item) { flushLines(); list.push(item[1].trim()); } else if (line.trim()) { flushList(); lines.push(line.trim()); }
    }
    flushLines();
    flushList();
    return html;
  }).join("");
}
function renderProductTemplate(template, rows, context) {
  const options = context || {};
  if (!template || template.version !== 1 || typeof template.html !== "string" || !template.html.includes("{{ww:title}}")) return "";
  // A row the store lists twice (a source row and the live one) is one row: the later one is current.
  const byId = new Map();
  (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === "object").forEach((row, index) => byId.set(row.id ?? "row-" + index, row));
  const all = Array.from(byId.values());
  if (!all.length) return "";
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
  const activeRows = all.filter((row) => row.active);
  const variants = activeRows.length ? activeRows : all;
  const product = variants[0];
  // The option chosen as the page opens: as Shopify's selected_or_first_available_variant, the first one that can be
  // bought, else the first. While none is on sale here (a copied shop not yet selling), the first its old shop had
  // in stock; else the first. The rows come in the shop's order (orderProductOptions), so its picture is the one
  // the page shows.
  const selected = variants.find((row) => row.active && row.purchasable)
    || (activeRows.length ? null : variants.find((row) => row.sourceAvailability === "available")) || product;
  const selling = options.mode === "shop";
  const money = (amount) => productTemplateMoney(amount, product.currency, template.money);
  const local = (url) => (url.startsWith("/") && !url.startsWith("//")) || url.startsWith("https://");
  const sized = (url, width) => url.startsWith("/images/") ? url + (url.includes("?") ? "&" : "?") + "w=" + width : url;

  // The product's pictures, in the store's order; an option's own picture first when it is the one chosen.
  const pictures = [];
  const addPicture = (url, alt) => {
    const value = String(url || "");
    if (!value || !local(value) || pictures.some((entry) => entry.url === value)) return;
    pictures.push({ url: value, alt: String(alt || "") });
  };
  for (const image of product.catalog?.images || []) addPicture(image?.url, image?.alt);
  addPicture(product.imageUrl, "");
  // An option's own picture: its row's, or the one its catalog keeps apart (optionImage: a product that is its one
  // option, whose own picture is the product's first, as lists show it, and its option's another - TheGlamourAddict's
  // satin bonnet, Nov 24 2026), while that is one of the product's pictures.
  const optionPicture = (row) => {
    const kept = String(row.catalog?.optionImage || "");
    return kept && pictures.some((entry) => entry.url === kept) ? kept : String(row.imageUrl || "");
  };
  // The options' own pictures (catalog images marked variant). A theme that shows them only as the chosen option's
  // picture lists the others apart (Narrative's pictures under the product: TheGlamourAddict, Nov 24 2026): its
  // template's list repeats otherImages. A picture that no option shows is never left out.
  const optionPictures = new Set();
  for (const row of all) {
    for (const image of row.catalog?.images || []) {
      if (image?.variant === true && all.some((other) => optionPicture(other) === String(image.url || ""))) optionPictures.add(String(image.url));
    }
  }
  const otherPictures = pictures.filter((entry) => !optionPictures.has(entry.url));
  const lists = Array.isArray(template.lists) ? template.lists : [];
  const picture = (entry, index) => {
    const view = { src: sized(entry.url, 1200), thumb: sized(entry.url, 600), full: entry.url,
      alt: entry.alt || product.title || "", position: String(index + 1) };
    lists.forEach((list, number) => { view["listClass-" + number] = index === 0 ? String(list.first || "") : String(list.rest || ""); });
    return view;
  };
  // A list whose class names how many pictures it holds (Narrative's product__subimage-list--r1: four pictures, one
  // past a row of three) names it for the pictures it holds here.
  const counts = {};
  lists.forEach((list, number) => {
    const modulo = Number(list?.count?.modulo);
    if (Number.isInteger(modulo) && modulo >= 2) counts["listCount-" + number] = String((list.pictures === "others" ? otherPictures : pictures).length % modulo);
  });
  const chosen = optionPicture(selected);
  const chosenPicture = chosen && local(chosen) ? { url: chosen, alt: pictures.find((entry) => entry.url === chosen)?.alt || "" } : pictures[0];

  // Choices: one per option name, its values in the store's order; a product whose options have no names (an older
  // import) chooses among its rows.
  const names = [];
  for (const row of variants) for (const name of Object.keys(row.variantOptions || {})) if (name && !names.includes(name)) names.push(name);
  let choices = [];
  if (variants.length > 1 && names.length) {
    choices = names.map((name, index) => {
      const values = [];
      for (const row of variants) {
        const value = row.variantOptions?.[name];
        if (value !== undefined && value !== null && String(value) !== "" && !values.includes(String(value))) values.push(String(value));
      }
      const current = String(selected.variantOptions?.[name] ?? values[0] ?? "");
      return { name, id: "ww-option-" + (index + 1),
        values: values.map((value) => '<option value="' + escape(value) + '"' + (value === current ? " selected" : "") + ">" + escape(value) + "</option>").join(""),
        choices: values.map((value, number) => ({ value, choiceId: "ww-option-" + (index + 1) + "-" + (number + 1), "flag-checked": value === current ? " checked" : "" })) };
    }).filter((choice) => choice.choices.length);
  } else if (variants.length > 1) {
    choices = [{ name: "", id: "ww-option-1",
      values: variants.map((row) => '<option value="' + escape(row.id) + '"' + (row === selected ? " selected" : "") + ">" + escape(row.variantLabel || row.variantKey || "Standard") + "</option>").join(""),
      choices: variants.map((row, number) => ({ value: String(row.id), choiceId: "ww-option-1-" + (number + 1), "flag-checked": row === selected ? " checked" : "" })) }];
  }
  // A template captured from a product with no choices has nowhere to put them: the platform's own picker stands in
  // before the add to cart button.
  const fallback = choices.length && !template.html.includes("{{#ww:options}}")
    ? choices.map((choice) => '<label class="ww-store-variant-label">' + escape(choice.name || "Choose an option")
      + ' <select class="ww-store-variant-select" data-ww-product-part="option" data-ww-product-option="' + escape(choice.name) + '">' + choice.values + "</select></label>").join("")
    : "";

  const orderable = selling && selected.active && selected.purchasable && !selected.orderingClosed && selected.catalog?.inStoreOnly !== true;
  const addLabel = !selling || orderable
    ? (selected.catalog?.saleType === "preorder" ? "Pre-order" : String(template.addLabel || "Add to cart"))
    : selected.catalog?.inStoreOnly === true ? "Available in our shop" : !selected.active ? "Unavailable" : "Sold out";
  const onSale = Boolean(selected.onSale) && selected.regularPriceAmount !== null && selected.regularPriceAmount !== undefined;
  const price = money(selected.priceAmount);
  const vendor = String(product.catalog?.brand || "");
  const page = String(options.origin || "") + String(options.path || "");
  const firstPicture = pictures[0] ? (local(pictures[0].url) && pictures[0].url.startsWith("/") ? String(options.origin || "") + pictures[0].url : pictures[0].url) : "";
  const title = String(product.title || "");
  const encode = encodeURIComponent;
  const view = {
    path: String(options.path || ""),
    title,
    vendor,
    price,
    compare: onSale ? money(selected.regularPriceAmount) : "",
    saleClass: onSale && template.sale?.className ? " " + template.sale.className : "",
    description: productTemplateDescription(product.description, product.catalog?.richDescription),
    images: pictures.map(picture),
    otherImages: otherPictures.map(picture),
    ...counts,
    image: chosenPicture ? picture(chosenPicture, 0) : null,
    options: choices,
    optionsFallback: fallback,
    variants: variants.map((row) => '<option value="' + escape(row.id) + '"' + (row === selected ? ' selected="selected"' : "")
      + ">" + escape((row.variantLabel || row.variantKey || "Default") + (money(row.priceAmount) ? " - " + money(row.priceAmount) : "")) + "</option>").join(""),
    variantId: String(selected.id || ""),
    addLabel,
    selling,
    "flag-disabled": orderable ? "" : " disabled",
    "flag-compare": onSale ? "" : " hidden",
    "flag-vendor": vendor ? "" : " hidden",
    "flag-mode": selling ? "" : ' data-ww-store-mode="' + (options.mode === "catalog" ? "catalog" : "gallery") + '"',
    "share-facebook": "https://www.facebook.com/sharer.php?u=" + encode(page),
    "share-twitter": "https://twitter.com/share?text=" + encode(title) + "&url=" + encode(page),
    "share-pinterest": "https://pinterest.com/pin/create/button/?url=" + encode(page) + (firstPicture ? "&media=" + encode(firstPicture) : "") + "&description=" + encode(title),
    "share-linkedin": "https://www.linkedin.com/sharing/share-offsite/?url=" + encode(page),
    "share-email": "mailto:?subject=" + encode(title) + "&body=" + encode(page),
    "share-whatsapp": "https://wa.me/?text=" + encode(title + " " + page)
  };

  // A small part of Mustache: {{#ww:name}}…{{/ww:name}} repeats for a list, shows once for a value and not at all
  // for none; {{ww:name}} is escaped text; {{{ww:name}}} is markup made above. One pass over the template, so a
  // product's own words are never read as a mark.
  const TOKEN = /\{\{#ww:([\w-]+)\}\}([\s\S]*?)\{\{\/ww:\1\}\}|\{\{\{ww:([\w-]+)\}\}\}|\{\{ww:([\w-]+)\}\}/g;
  const lookup = (stack, name) => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index] && typeof stack[index] === "object" && Object.prototype.hasOwnProperty.call(stack[index], name)) return stack[index][name];
    }
    return undefined;
  };
  const fill = (text, stack, depth) => text.replace(TOKEN, (_, section, inner, raw, plain) => {
    if (section) {
      const value = lookup(stack, section);
      if (depth > 6) return "";
      if (Array.isArray(value)) return value.map((item) => fill(inner, stack.concat([item]), depth + 1)).join("");
      if (value && typeof value === "object") return fill(inner, stack.concat([value]), depth + 1);
      return value ? fill(inner, stack, depth + 1) : "";
    }
    if (raw) { const value = lookup(stack, raw); return value === undefined || value === null ? "" : String(value); }
    const value = lookup(stack, plain);
    return value === undefined || value === null || typeof value === "object" ? "" : escape(value);
  });
  return fill(template.html, [view], 0);
}
function renderProductCardList(template, groups, context) {
  const options = context || {};
  if (!template || template.version !== 1 || !template.card || typeof template.container !== "string" || !template.container.includes("{{{ww:cards}}}")) return "";
  const regular = typeof template.card.regular === "string" ? template.card.regular : "";
  const sale = typeof template.card.sale === "string" ? template.card.sale : "";
  if (!regular && !sale) return "";
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
  const local = (url) => (url.startsWith("/") && !url.startsWith("//")) || url.startsWith("https://");
  const sized = (url, width) => url.startsWith("/images/") ? url + (url.includes("?") ? "&" : "?") + "w=" + width : url;
  // The same small part of Mustache the product page uses (renderProductTemplate): {{#ww:name}}…{{/ww:name}} shows for a
  // value, {{ww:name}} is escaped text, {{{ww:name}}} markup made here. One pass, so a product's own words are never a mark.
  const TOKEN = /\{\{#ww:([\w-]+)\}\}([\s\S]*?)\{\{\/ww:\1\}\}|\{\{\{ww:([\w-]+)\}\}\}|\{\{ww:([\w-]+)\}\}/g;
  const fill = (text, view) => text.replace(TOKEN, (_, section, inner, raw, plain) => {
    if (section) return view[section] ? fill(inner, view) : "";
    if (raw) return view[raw] === undefined || view[raw] === null ? "" : String(view[raw]);
    const value = view[plain];
    return value === undefined || value === null || typeof value === "object" ? "" : escape(value);
  });

  const cards = (Array.isArray(groups) ? groups : []).map((group) => (Array.isArray(group) ? group : [group]).filter((row) => row && typeof row === "object"))
    .filter((rows) => rows.length).map((rows, index) => {
      const product = rows[0];
      const amounts = rows.flatMap((row) => [row.priceAmount, row.priceHighAmount]).filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
      const low = amounts.length ? Math.min(...amounts) : null;
      const high = amounts.length ? Math.max(...amounts) : null;
      const money = (amount) => productTemplateMoney(amount, product.currency, template.money);
      // The regular price crossed out only where it is the product's own: one option, or every option on sale from it.
      const regularAmount = product.regularPriceAmount;
      const crossed = Boolean(product.onSale) && regularAmount !== null && regularAmount !== undefined && Number(regularAmount) > Number(low)
        && (!(product.variantCount > 1) || product.regularShared === true);
      const picture = String(product.imageUrl || product.catalog?.images?.[0]?.url || "");
      const price = low === null ? "" : (high !== null && high > low ? String(template.fromLabel || "From ") : "") + money(low);
      const view = {
        index: String(index),
        key: String(product.id || product.sourceKey || index).replace(/[^\w-]/g, ""),
        href: /^\/[^/\\]/.test(String(product.sourcePath || "")) ? String(product.sourcePath) : "/shop/",
        title: String(product.title || ""),
        alt: String(product.title || ""),
        vendor: String(product.catalog?.brand || ""),
        price,
        compare: crossed ? money(regularAmount) : "",
        onSale: crossed,
        image: Boolean(picture && local(picture)),
        src: picture && local(picture) ? sized(picture, 720) : ""
      };
      return fill(crossed && sale ? sale : regular || sale, view);
    });
  if (!cards.length) return "";
  // A theme that deals its cards into columns (Narrative's masonry) gets them dealt the same way: the first card in the
  // first column, the second in the second, and so on along each row. One product has the source's own column for one.
  const column = template.column && typeof template.column.html === "string" && template.column.html.includes("{{{ww:cards}}}") ? template.column : null;
  let inner = cards.join("");
  if (column) {
    const one = cards.length === 1 && typeof column.single === "string" && column.single.includes("{{{ww:cards}}}");
    const most = Math.max(1, Math.min(8, Number(column.count) || 1));
    const count = one ? 1 : Math.max(1, Math.min(most, Number(options.columns) || most));
    const dealt = Array.from({ length: count }, () => []);
    cards.forEach((card, index) => dealt[index % count].push(card));
    inner = dealt.map((list) => (one ? column.single : column.html).split("{{{ww:cards}}}").join(list.join(""))).join("");
  }
  return template.container.split("{{{ww:cards}}}").join(inner);
}
function renderProductCardPager(template, pagination, href) {
  const pager = template && template.pager;
  const page = Math.floor(Number(pagination && pagination.page)), pages = Math.floor(Number(pagination && pagination.pages));
  if (!pager || pager.version !== 1 || typeof pager.html !== "string" || !pager.html.includes("{{{ww:pages}}}") || typeof pager.page !== "string"
    || typeof pager.current !== "string" || typeof href !== "function" || !(pages > 1) || !(page >= 1) || page > pages) return "";
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
  const fill = (text, number) => text.replace(/\{\{ww:(href|number)\}\}/g, (_, name) => escape(name === "number" ? number : href(number)));
  const items = [];
  let last = 0;
  for (let number = 1; number <= pages; number++) {
    if (pages > 7 && number !== 1 && number !== pages && Math.abs(number - page) > 2) continue;
    if (number - last > 1 && typeof pager.ellipsis === "string") items.push(pager.ellipsis);
    items.push(fill(number === page ? pager.current : pager.page, number));
    last = number;
  }
  const control = (forms, number) => {
    if (!forms) return "";
    const live = number >= 1 && number <= pages;
    const form = live ? forms.live : forms.disabled;
    return typeof form === "string" ? (live ? fill(form, number) : form) : "";
  };
  const parts = { previous: control(pager.previous, page - 1), next: control(pager.next, page + 1), pages: items.join(typeof pager.gap === "string" ? pager.gap : "") };
  return pager.html.replace(/\{\{\{ww:(previous|next|pages)\}\}\}/g, (_, name) => parts[name]);
}

function productImageLayout(catalog, display) {
  if (['single','carousel','lux'].includes(catalog?.imageLayout)) return catalog.imageLayout;
  if (catalog?.imageLayout === undefined && catalog?.imagePresentation === 'single') return 'single';
  if (catalog?.imageLayout === undefined && catalog?.imagePresentation === 'luxury') return 'lux';
  return ['single','carousel','lux'].includes(display?.productPhotos) ? display.productPhotos : 'carousel';
}
function productOrderDates(catalog, timeZone, locale) {
  const day = (at, zone) => {
    if (!at || !Number.isFinite(Date.parse(at))) return '';
    try { return new Intl.DateTimeFormat(locale, { timeZone: zone, month: 'numeric', day: 'numeric', year: '2-digit' }).format(new Date(at)); } catch { return ''; }
  };
  return {
    cutoff: day(catalog?.orderCutoffAt, catalog?.orderCutoffTimeZone || timeZone || 'UTC'),
    release: /^\d{4}-\d{2}-\d{2}$/.test(String(catalog?.releaseDate || '')) ? day(catalog.releaseDate + 'T12:00:00Z', 'UTC') : day(catalog?.releaseAt, timeZone || 'UTC')
  };
}

const STORE_PHOTO_RATIOS = {"square":1,"portrait":0.75,"landscape":1.333};

// x-ww-store says which store layout this server reads (src/commerce/store-layout.js), so the platform knows when a shop
// too big for the one-file layout can be published for this website.
async function serveCommerceSnapshot(request, env) {
  const params = new URL(request.url).searchParams;
  const headers = { "cache-control": "no-store", "x-ww-store": "3" };
  const snapshot = params.get("view") === "detail" ? await readStoreDetail(env, params.get("path") || "/") : await readCommerceSnapshot(env);
  const catalog = projectShopCatalog(snapshot || { enabled: false, siteId: CONTACT_SITE_ID }, params);
  // A list the source shop's cards draw (data-ww-product-cards) is filled by the store's script from this template.
  if (params.get("view") === "list" && STORE_SHOP_THEME?.cards) catalog.cardTemplate = STORE_SHOP_THEME.cards;
  return Response.json(catalog, { headers });
}

function escapeStoreHtml(value) {
  const entities = { 34: "&quot;", 39: "&#39;", 38: "&amp;", 60: "&lt;", 62: "&gt;" };
  return String(value || "").replace(/[&<>"']/g, (character) => entities[character.charCodeAt(0)]);
}

async function commercePage(title, main, env, url, description = "", pageTitle = "", options = {}) {
  const ownTitle = String(pageTitle || title || "").trim();
  const siteName = String(STORE_SITE_NAME || "").trim();
  const fullTitle = !siteName || ownTitle.toLowerCase().includes(siteName.toLowerCase()) ? ownTitle || siteName : ownTitle + " | " + siteName;
  if (env.ASSETS) {
    const homepage = await env.ASSETS.fetch(new Request(new URL("/", url.origin)));
    if (homepage.ok && String(homepage.headers.get("content-type") || "").includes("text/html")) {
      if (typeof HTMLRewriter === "undefined") {
        const html = (await homepage.text())
          .replace(/\s+aria-current="page"/g, "")
          .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, "<title>" + escapeStoreHtml(fullTitle) + "</title>")
          .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, '<meta name="description" content="' + escapeStoreHtml(String(description || title).slice(0, 300)) + '">')
          .replace(/<main\b([^>]*)>[\s\S]*?<\/main>/i, (_, attributes) => "<main" + attributes + ">" + main + "</main>")
          .replace(/(<body\b[^>]*\bclass=")([^"]*)"/i, (_, start, names) => start + names.split(/\s+/).filter((name) => name && name !== "ww-header-overlay").join(" ") + '"');
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "Link": "<" + url.origin + url.pathname + ">; rel=canonical" } });
      }
      // Store pages are run by the shared behaviour runtime, whether or not the site's other pages load it.
      let sharedRuntime = false;
      const composed = new HTMLRewriter()
        // The shell is the home page's, and this is not the home page.
        .on('[aria-current="page"]', { element(element) { element.removeAttribute("aria-current"); } })
        .on("title", { element(element) { element.setInnerContent(fullTitle); } })
        .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", url.origin + url.pathname); } })
        .on('meta[name="description"]', { element(element) { element.setAttribute("content", String(description || title).slice(0, 300)); } })
        .on("main", { element(element) { element.setAttribute("class", (element.getAttribute("class") || "") + (options.themed ? " ww-commerce-themed" : " ww-commerce-main")); element.setInnerContent(main, { html: true }); } })
        .on('script[src="/app.js"]', { element() { sharedRuntime = true; } })
        .on("body", { element(element) {
          const pageClasses = (options.bodyClasses || []).filter((name) => /^template-[\w-]+$/.test(name));
          const homeClasses = String(element.getAttribute("class") || "").split(/\s+/).filter((name) => name && name !== "ww-header-overlay");
          const classes = pageClasses.length ? homeClasses.filter((name) => !/^template-/.test(name)).concat(pageClasses) : homeClasses;
          if (classes.join(" ") !== String(element.getAttribute("class") || "").trim()) element.setAttribute("class", classes.join(" "));
          element.onEndTag((end) => { if (!sharedRuntime) end.before('<script src="/app.js" defer></script>', { html: true }); });
        } })
        .transform(homepage);
      return finishCommercePage(composed, env, url);
    }
  }
  return new Response("The shared site layout is temporarily unavailable.", { status: 503, headers: { "retry-after": "5" } });
}

// What every store page gets on its way out, whichever page it was made from.
async function finishCommercePage(composed, env, url) {
  const commerceNavigation = await addCommerceNavigation(composed, env);
  const ordered = typeof addOrderHistoryNavigation === "function" ? await addOrderHistoryNavigation(commerceNavigation, env) : commerceNavigation;
  // After the store's own links are added: the page's own menu link is marked as the current one.
  const navigated = /^[\w/.-]+$/.test(url.pathname)
    ? new HTMLRewriter().on('a[href="' + url.pathname + '"]', { element(element) { element.setAttribute("aria-current", "page"); } }).transform(ordered) : ordered;
  const response = new Response(navigated.body, navigated);
  response.headers.set("cache-control", "no-store");
  response.headers.append("Link", "<" + url.origin + url.pathname + ">; rel=canonical");
  return withManagedFormCheck(response, env);
}

async function serveManagedEventPage(env, url, route) {
  const event = route.event;
  const title = escapeStoreHtml(event.title || "Event");
  const location = escapeStoreHtml(event.location || "");
  const description = escapeStoreHtml(event.description || "").replace(/\n/g, "<br>");
  const date = String(event.startAt || "");
  let displayDate = date;
  try {
    displayDate = new Intl.DateTimeFormat("en", {
      dateStyle: "long", ...(event.allDay ? {} : { timeStyle: "short" }),
      timeZone: event.timeZone || "UTC"
    }).format(new Date(date));
  } catch { /* keep the recorded date when its zone is unknown */ }
  const image = String(event.imageUrl || "");
  const imageMarkup = (image.startsWith("/images/") || image.startsWith("https://"))
    ? '<img src="' + escapeStoreHtml(image) + '" alt="' + title + '" loading="lazy">' : "";
  const main = '<article class="ww-event-detail" data-ww-behavior="dated-events" data-ww-event-id="'
    + escapeStoreHtml(event.id || "") + '"><h1>' + title + '</h1>'
    + '<p><time datetime="' + escapeStoreHtml(date) + '">' + escapeStoreHtml(displayDate) + '</time></p>'
    + (location ? '<p>' + location + '</p>' : "") + imageMarkup
    + (description ? '<div class="ww-event-description"><p>' + description + '</p></div>' : "")
    + (event.status === "cancelled" ? '<p role="status">This event has been cancelled.</p>' : "")
    + '</article>';
  return commercePage(event.title || "Event", main, env, url);
}

async function serveCommerceProductPage(request, env, pathname) {
  const snapshot = await readStoreDetail(env, pathname);
  const route = pathname.endsWith("/") ? pathname : pathname + "/";
  const products = [...(snapshot?.sourceProducts || []), ...(snapshot?.products || [])];
  const onPage = (entry) => {
    const sourcePath = String(entry.sourcePath || "");
    return sourcePath && (sourcePath.endsWith("/") ? sourcePath : sourcePath + "/") === route;
  };
  const product = products.find(onPage);
  if (!product) return new Response("Product not found", { status: 404 });
  // A gallery's products have no pages; a catalog's pages describe the product and sell nothing.
  const mode = storeMode(snapshot.storeDisplay);
  if (mode === "gallery") return notFoundPage(env, new URL(request.url), new Response("Product not found", { status: 404 }));
  const image = product.imageUrl || product.catalog?.images?.[0]?.url || "";
  const available = product.active && product.purchasable;
  // Sold in the shop only (catalog.inStoreOnly): never on sale online. Said with where to find the shop before any
  // script runs, and told to search engines as in store only, not out of stock.
  const inStore = product.catalog?.inStoreOnly === true;
  const status = inStore ? "Available in our shop. Not sold online." + (snapshot.inStoreNote ? " " + escapeStoreHtml(snapshot.inStoreNote) : "")
    : product.orderingClosed ? "Pre-orders closed" : available
    ? product.catalog?.saleType === "preorder" ? "Available to pre-order" : "Available"
    : "Not currently available to order";
  // Its customers' reviews (shop-reviews.js on the platform writes them; the list row names their file), drawn into the
  // page and given to search engines with the stars they add up to.
  const reviews = await readProductReviews(env, product);
  const schema = { "@context": "https://schema.org", "@type": "Product", name: product.title,
    description: product.description || "", sku: product.sku || undefined,
    ...(product.catalog?.brand ? { brand: { "@type": "Brand", name: product.catalog.brand } } : {}),
    ...productReviewSchema(reviews),
    image: [...new Set([product.imageIsDefault ? "" : image, ...(product.catalog?.images || []).map((entry) => entry.url)].filter(Boolean))].map((value) => new URL(value, request.url).href),
    ...(product.priceAmount != null ? { offers: { "@type": "Offer", url: new URL(request.url).origin + route,
      priceCurrency: product.currency,
      price: product.priceAmount / (10 ** new Intl.NumberFormat("en", { style: "currency", currency: product.currency }).resolvedOptions().maximumFractionDigits),
      ...(mode === "shop" ? { availability: "https://schema.org/" + (inStore ? "InStoreOnly" : available ? product.catalog?.saleType === "preorder" ? "PreOrder" : "InStock" : "OutOfStock") } : {}) } } : {}) };
  const publicationLabels = { publisher: "Publisher", format: "Format", writer: "Writer", artist: "Artist", coverArtist: "Cover artist", series: "Series", issueNumber: "Issue / volume", rating: "Rating", variantDescription: "Cover variant", numberOfPages: "Pages" };
  const specs = product.catalog?.specs || [];
  const publicationMarkup = specs.length ? '<dl class="ww-store-publication ww-store-specs">' + specs.map((spec) => '<dt>' + escapeStoreHtml(spec.label) + '</dt><dd>' + escapeStoreHtml(spec.value) + '</dd>').join("") + '</dl>'
    : product.catalog?.showPublicationFacts ? '<dl class="ww-store-publication">' + Object.entries(publicationLabels)
    .filter(([key]) => product.catalog.publication?.[key]).map(([key, label]) => '<dt>' + label + '</dt><dd>' + escapeStoreHtml(product.catalog.publication[key]) + '</dd>').join("") + '</dl>' : "";
  // The source shop's own product page, filled from the store, unless the owner chose a photo layout of the store's.
  const layoutChosen = ["single", "carousel", "lux"].includes(product.catalog?.imageLayout) || ["single", "carousel", "lux"].includes(snapshot.storeDisplay?.productPhotos)
    || (product.catalog?.imageLayout === undefined && ["single", "luxury"].includes(product.catalog?.imagePresentation));
  const themed = STORE_PRODUCT_TEMPLATE && !layoutChosen ? renderProductTemplate(STORE_PRODUCT_TEMPLATE, products.filter(onPage),
    { mode, origin: new URL(request.url).origin, path: route }) : "";
  // What the store says beyond the theme's section (where the shop is, the product's facts, reviews, policies) follows
  // it, in one box at the store's width.
  const after = themed ? (inStore && snapshot.inStoreNote ? '<p class="ww-store-status" role="status">' + status + '</p>' : "")
    + publicationMarkup + storeReviewsMarkup(reviews) + storePolicyLinks(snapshot, "product") : "";
  // A copied product's description as its owner formatted it, while its words are the ones it came with.
  const formattedDescription = themed ? "" : productDescriptionHtml(product.description, product.catalog?.richDescription);
  const main = themed ? themed + (after ? '<div class="ww-store-after">' + after + '</div>' : "")
    + '<script type="application/ld+json">' + JSON.stringify(schema).replace(/</g, "\\u003c") + '</script>'
    : '<article class="ww-product-detail" data-ww-behavior="commerce-store" data-ww-product-detail data-ww-detail-layout="' + productImageLayout(product.catalog, snapshot.storeDisplay) + '"'
    + (mode === "shop" ? "" : ' data-ww-store-mode="' + mode + '"') + '>'
    + '<h1>' + escapeStoreHtml(product.title) + '</h1>' + storePriceMarkup([product]) + (formattedDescription
      ? '<div class="ww-store-description ww-store-description--formatted">' + formattedDescription + '</div>'
      : '<p class="ww-store-description">' + escapeStoreHtml(product.description) + '</p>')
    + (image ? '<img class="ww-store-image" src="' + escapeStoreHtml(image) + '" alt="' + escapeStoreHtml(product.title) + '" loading="eager">' : '')
    + (product.catalog?.releaseAt ? '<p>Expected release: <time datetime="' + escapeStoreHtml(product.catalog.releaseAt) + '">' + escapeStoreHtml(product.catalog.releaseDate || product.catalog.releaseAt.slice(0, 10)) + '</time></p>' : '')
    + publicationMarkup + (mode === "shop" ? '<p role="status" aria-live="polite">' + status + '</p>' : '') + '</article>' + storeReviewsMarkup(reviews) + storePolicyLinks(snapshot, "product")
    + '<script type="application/ld+json">' + JSON.stringify(schema).replace(/</g, "\\u003c") + '</script>';
  // The owner's search title and description (catalog.search) when set, from whichever option of the product has them
  // (Shopify's export gives them on its first row only); the website's name follows a search title that does not already
  // say it, as Shopify's themes do, so a moved shop's search results read the same.
  const search = products.find((entry) => onPage(entry) && entry.catalog?.search)?.catalog.search || {};
  const siteName = String(STORE_SITE_NAME || "");
  const searchTitle = !search.title ? "" : !siteName || search.title.toLowerCase().includes(siteName.toLowerCase()) ? search.title : search.title + " | " + siteName;
  return commercePage(product.title || "Product", main, env, new URL(request.url), search.description || product.description, searchTitle,
    themed ? { themed: true, bodyClasses: STORE_PRODUCT_TEMPLATE.bodyClasses || [] } : {});
}

// A product's reviews file, reviews/<file>.json beside the shop's other files: its newest published reviews (up to 100),
// their count and average. Read only for a product whose list row says it has reviews.
async function readProductReviews(env, product) {
  const rating = product && product.rating;
  if (!rating || !(Number(rating.count) > 0) || !/^[0-9a-f]{1,16}$/.test(String(rating.file || "")) || !env.MEDIA) return null;
  const object = await env.MEDIA.get(STORE_FILES_PREFIX + "reviews/" + rating.file + ".json").catch(() => null);
  if (!object) return null;
  try {
    const file = JSON.parse(await object.text());
    return Array.isArray(file.reviews) && file.reviews.length ? file : null;
  } catch { return null; }
}

function reviewDay(value) {
  try { return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(value)); }
  catch { return String(value || "").slice(0, 10); }
}

const REVIEWS_SHOWN_FIRST = 10;
// The reviews section after the product: the average, then each review newest first (the first ten open, the rest a
// click away). A reviewer rewarded for the review is said to be, and the shop's reply follows the review it answers.
function storeReviewsMarkup(file) {
  if (!file) return "";
  const count = Number(file.count) || file.reviews.length;
  const average = Math.round((Number(file.average) || 0) * 10) / 10;
  const paragraphs = (text) => escapeStoreHtml(text).split(/\n{2,}/).map((part) => '<p>' + part.replace(/\n/g, "<br>") + '</p>').join("");
  const one = (review) => {
    const name = String(review.name || "").trim() || "A customer";
    const photos = (Array.isArray(review.photos) ? review.photos : []).filter((url) => typeof url === "string" && url.startsWith("/") && !url.startsWith("//"));
    // A thumbnail is asked for small (the image route sizes it); the link opens the whole photo.
    const thumb = (url) => url.startsWith("/images/") ? url + (url.includes("?") ? "&" : "?") + "w=192" : url;
    return '<li class="ww-store-review"><p>' + storeStars(review.rating, "Rated " + review.rating + " out of 5") + '</p>'
      + (review.title ? '<h3>' + escapeStoreHtml(review.title) + '</h3>' : '')
      + (review.body ? paragraphs(review.body) : '')
      + (photos.length ? '<div class="ww-store-review-photos">' + photos.map((url, index) => '<a href="' + escapeStoreHtml(url) + '"><img src="' + escapeStoreHtml(thumb(url))
        + '" alt="Photo ' + (index + 1) + ' from ' + escapeStoreHtml(name) + '’s review" loading="lazy" width="96" height="96"></a>').join("") + '</div>' : '')
      + '<p class="ww-store-review-meta">' + escapeStoreHtml(name) + (review.location ? ', ' + escapeStoreHtml(review.location) : '')
      + ' · <time datetime="' + escapeStoreHtml(String(review.date || "").slice(0, 10)) + '">' + escapeStoreHtml(reviewDay(review.date)) + '</time>'
      + (review.verified ? ' · Verified buyer' : '') + '</p>'
      + (review.rewarded ? '<p class="ww-store-review-badge">Received a reward for this review</p>' : '')
      + (review.reply ? '<div class="ww-store-review-reply"><p><strong>Reply from ' + escapeStoreHtml(STORE_SITE_NAME || "the shop") + '</strong></p>' + paragraphs(review.reply) + '</div>' : '')
      + '</li>';
  };
  const first = file.reviews.slice(0, REVIEWS_SHOWN_FIRST), rest = file.reviews.slice(REVIEWS_SHOWN_FIRST);
  return '<section class="ww-store-reviews" id="reviews" aria-labelledby="ww-store-reviews-title"><h2 id="ww-store-reviews-title">Customer reviews</h2>'
    + '<p class="ww-store-review-summary">' + storeStars(average) + '<span>' + average.toFixed(1) + ' out of 5</span><span>' + count + (count === 1 ? ' review' : ' reviews') + '</span></p>'
    + '<ol class="ww-store-review-list">' + first.map(one).join("") + '</ol>'
    + (rest.length ? '<details class="ww-store-reviews-more"><summary>Show ' + rest.length + ' more ' + (rest.length === 1 ? 'review' : 'reviews') + '</summary><ol class="ww-store-review-list">' + rest.map(one).join("") + '</ol></details>' : '')
    + (count > file.reviews.length ? '<p>Showing the ' + file.reviews.length + ' most recent of ' + count + ' reviews.</p>' : '')
    + '</section>';
}

// The reviews in the Product's structured data: the average of all of them, and the newest ten that name their writer
// (Google asks for a reviewer's real name).
function productReviewSchema(file) {
  if (!file) return {};
  const count = Number(file.count) || file.reviews.length;
  const ratingOf = (value) => ({ "@type": "Rating", ratingValue: value, bestRating: 5, worstRating: 1 });
  const named = file.reviews.filter((review) => String(review.name || "").trim()).slice(0, REVIEWS_SHOWN_FIRST);
  return {
    aggregateRating: { "@type": "AggregateRating", ratingValue: Math.round((Number(file.average) || 0) * 10) / 10, reviewCount: count, bestRating: 5, worstRating: 1 },
    ...(named.length ? { review: named.map((review) => ({ "@type": "Review", author: { "@type": "Person", name: String(review.name).trim().slice(0, 100) },
      datePublished: String(review.date || "").slice(0, 10), reviewRating: ratingOf(review.rating),
      ...(review.title ? { name: review.title } : {}), ...(review.body ? { reviewBody: review.body } : {}) })) } : {})
  };
}


// Links to the shop's written policies, drawn into the page itself so they show before any script runs. A copied shop
// whose own product pages or cart page had none there (STORE_SHOP_THEME.policyLinks) has none there now: her menu
// still leads to them (TheGlamourAddict, Nov 24 2026).
function storePolicyLinks(snapshot, place = "") {
  const pages = Array.isArray(snapshot?.storePolicies) ? snapshot.storePolicies : [];
  if (!pages.length || (place && STORE_SHOP_THEME?.policyLinks?.[place] === false)) return "";
  return '<nav class="ww-store-policies" aria-label="Store policies">' + pages.map((page) => '<a href="' + escapeStoreHtml(page.path) + '">' + escapeStoreHtml(page.title) + '</a>').join(" ") + '</nav>';
}

// /policies/ and /policies/<name>/ are the shop's own pages. A file the site already has at that address is left alone.
async function serveStorePolicy(request, env, url, snapshot) {
  const pages = Array.isArray(snapshot?.storePolicies) ? snapshot.storePolicies : [];
  if (!pages.length) return null;
  const route = url.pathname.endsWith("/") ? url.pathname : url.pathname + "/";
  const page = pages.find((entry) => entry.path === route);
  if (!page && route !== "/policies/") return null;
  const existing = await env.ASSETS.fetch(request);
  if (existing.status < 400) return existing;
  if (!page) {
    const main = '<section class="ww-store-policy"><h1>Store policies</h1><ul>' + pages.map((entry) => '<li><a href="' + escapeStoreHtml(entry.path) + '">' + escapeStoreHtml(entry.title) + '</a></li>').join("") + '</ul></section>';
    return commercePage("Store policies", main, env, url);
  }
  if (route !== url.pathname) return Response.redirect(new URL(route + url.search, url).toString(), 301);
  const main = '<article class="ww-store-policy"><h1>' + escapeStoreHtml(page.title) + '</h1>' + page.html + '</article>' + storePolicyLinks(snapshot);
  return commercePage(page.title, main, env, url);
}

async function serveCommerceCart(env, url) {
  const snapshot = await readCommerceSnapshot(env);
  if (!snapshot?.enabled) return new Response("Store not found", { status: 404 });
  if (storeMode(snapshot.storeDisplay) !== "shop") return notFoundPage(env, url, new Response("Page not found", { status: 404 }));
  // With signups on, the cart carries the name the shop's news comes from, and the store script draws the box above Check out.
  const signups = await siteSignupsSettings(env);
  const newsFrom = signups && signups.enabled === true ? String(signups.name || CONTACT_SITE_LABEL || "").slice(0, 80) : null;
  const news = newsFrom === null ? '' : ' data-ww-news-from="' + escapeStoreHtml(newsFrom) + '"';
  // The source shop's own cart page (her "Shopping Cart" with its empty state), the store's cart where its lines were.
  const page = STORE_SHOP_THEME?.cartPage;
  if (page?.version === 1 && typeof page.html === "string" && page.html.includes("{{{ww:lines}}}")) {
    const lines = '<div class="ww-cart" data-ww-behavior="commerce-store" data-ww-cart data-ww-cart-page' + news + '>'
      + '<p role="status" aria-live="polite">Loading cart…</p></div>';
    return commercePage(page.title || "Your cart", page.html.split("{{{ww:lines}}}").join(lines) + storePolicyLinks(snapshot, "cart"), env, url, "", page.pageTitle || "",
      { themed: true, bodyClasses: page.bodyClasses || [] });
  }
  const main = '<section class="ww-cart" data-ww-behavior="commerce-store" data-ww-cart' + news + '>'
    + '<h1>Your cart</h1><p role="status" aria-live="polite">Loading cart…</p></section>' + storePolicyLinks(snapshot, "cart");
  return commercePage("Your cart", main, env, url);
}

async function serveCommerceShop(env, url) {
  const snapshot = await readCommerceSnapshot(env);
  if (!snapshot?.enabled) return new Response("Store not found", { status: 404 });
  const params = new URLSearchParams(url.search); params.set("view", "list");
  // The source shop's own cards (product-card-runtime.mjs), unless the owner chose a card of the store's: her list and
  // her columns, with the store's search and sort only where her lists had their own (a copied page says so itself),
  // and as many products a page as her pages showed (TheGlamourAddict's 18, Nov 24 2026), so her page links match.
  const display = snapshot.storeDisplay || {};
  const cardStyle = storeCardLayout(display).cards;
  const mode = storeMode(display);
  const theme = STORE_SHOP_THEME?.cards && !cardStyle && mode !== "gallery" ? STORE_SHOP_THEME.cards : null;
  const themePageSize = Math.floor(Number(theme?.pageSize)) > 0 ? Math.min(Math.floor(Number(theme.pageSize)), 48) : 0;
  if (themePageSize && !params.has("pageSize")) params.set("pageSize", String(themePageSize));
  const page = projectShopCatalog(snapshot, params);
  // One card per product; its options (sizes, colours) share the card and its price range.
  const groups = new Map();
  for (const row of [...page.sourceProducts, ...page.products]) {
    const key = row.sourceKey || row.id;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const cards = [...groups.values()].map((rows) => storeCardMarkup(rows, snapshot.storeDisplay, snapshot.collectionTimeZone)).join("");
  // Menu links open filtered views; paging keeps the filter, and the page says which one it is.
  const pageLink = (number) => { const next = new URLSearchParams(url.search); next.delete("view"); next.set("page", String(number)); return '?' + escapeStoreHtml(next.toString()); };
  const pagination = page.pagination?.pages > 1 ? '<nav class="ww-store-pagination" aria-label="Product pages">'
    + (page.pagination.page > 1 ? '<a href="' + pageLink(page.pagination.page - 1) + '">Previous</a>' : "")
    + '<span>Page ' + page.pagination.page + ' of ' + page.pagination.pages + '</span>'
    + (page.pagination.page < page.pagination.pages ? '<a href="' + pageLink(page.pagination.page + 1) + '">Next</a>' : "") + '</nav>' : "";
  const settings = storeNavigationSettings(snapshot);
  const filtered = [...url.searchParams.keys()].some((key) => key === "category" || key === "cutoffDate" || key.startsWith("attr."));
  const filterLabel = filtered ? settings.groups.flatMap((group) => group.items).find((item) => {
    const target = new URL(item.href, url.origin);
    return target.pathname === url.pathname && [...target.searchParams].every(([key, value]) => url.searchParams.get(key) === value);
  })?.label || "" : "";
  const filterNote = filtered ? '<p class="ww-store-filter">' + (filterLabel ? 'Showing ' + escapeStoreHtml(filterLabel) + '. ' : 'Showing a filtered selection. ')
    + '<a href="/shop/">' + escapeStoreHtml(settings.allLabel) + '</a></p>' : "";
  const ratio = STORE_PHOTO_RATIOS[display.photoShape];
  const columns = [2, 3, 4, 5, 6].includes(display.columns) ? display.columns : 0;
  const style = (columns ? '--ww-store-columns:' + columns + ';--ww-store-columns-md:' + Math.min(columns, 3) + ';' : "")
    + (ratio ? '--ww-store-ratio:' + ratio + ';' : "") + '--ww-store-fit:' + (display.photoFit === "fill" ? "cover" : "contain");
  const attributes = { "data-ww-store-display": "", "data-ww-store-fit": "", ...(display.photoShape === "natural" ? { "data-ww-store-natural": "" } : {}),
    // Gallery or catalog, said where the store's stylesheet, its script and the platform's runtime check read it.
    ...(mode === "shop" ? {} : { "data-ww-store-mode": mode }),
    ...(cardStyle ? { "data-ww-store-cards": cardStyle } : {}), ...(columns ? { "data-ww-product-columns": String(columns) } : {}),
    ...(ratio ? { "data-ww-product-image-ratio": ratio } : {}),
    // The owner's filter bar layout and look, read by the store's stylesheet before the bar is drawn.
    ...(["row", "side", "menu"].includes(display.filterLayout) ? { "data-ww-store-filter-layout": display.filterLayout } : {}),
    ...(display.filterLook === "quiet" ? { "data-ww-store-filter-look": "quiet" } : {}), style };
  if (theme) attributes["data-ww-product-cards"] = "";
  if (themePageSize) attributes["data-ww-product-page-size"] = String(themePageSize);
  const look = (theme?.controls ? " data-ww-product-controls" : "") + Object.entries(attributes).map(([name, value]) => ' ' + name + (value === "" ? "" : '="' + value + '"')).join("");
  const category = url.searchParams.get("category") || "*";
  const cutoff = url.searchParams.get("cutoffDate") || "";
  const themed = theme && groups.size ? renderProductCardList(theme, [...groups.values()], { mode }) : "";
  // Her own page links where her theme kept them (renderProductCardPager), the store's where it kept none.
  const themedPager = themed ? renderProductCardPager(theme, page.pagination, (number) => {
    const next = new URLSearchParams(url.search); next.delete("view"); next.set("page", String(number)); return url.pathname + "?" + next.toString();
  }) : "";
  const products = filterNote + (themed ? themed + (themedPager || pagination) : cards ? '<div class="ww-store-grid">' + cards + '</div>' + pagination
    : '<p class="ww-store-empty">Products will appear here when they are available.</p>');
  const designed = await designedShopPage(env, url, products, { ...attributes, "data-ww-product-category": category, ...(cutoff ? { "data-ww-product-cutoff": cutoff } : {}) });
  if (designed) return designed;
  const main = '<section class="ww-shop" data-ww-behavior="commerce-store" data-ww-product-list data-ww-product-category="' + escapeStoreHtml(category) + '"' + look
    + (cutoff ? ' data-ww-product-cutoff="' + escapeStoreHtml(cutoff) + '"' : "") + '>'
    + '<h1>' + escapeStoreHtml(settings.label) + '</h1>' + products + '</section>';
  return commercePage(settings.label, main, env, url);
}

// The store page a new website was written with keeps its design: the products go where the page marks them. A
// migration's copied all-products page (SHOP_PAGE_DESIGNED names it) is worn the same way, at the store's address.
async function designedShopPage(env, url, products, attributes) {
  if (!SHOP_PAGE_DESIGNED || !env.ASSETS || typeof HTMLRewriter === "undefined") return null;
  const asset = await env.ASSETS.fetch(new Request(new URL(SHOP_PAGE_DESIGNED === true ? "/shop/" : SHOP_PAGE_DESIGNED, url.origin)));
  if (!asset.ok || !String(asset.headers.get("content-type") || "").includes("text/html")) return null;
  const page = await asset.text();
  if (!/\bdata-ww-product-list\b/.test(page)) return null;
  let sharedRuntime = false;
  let placed = false;
  const filled = new HTMLRewriter()
    .on("[data-ww-product-list]", { element(element) {
      if (placed) return;
      placed = true;
      element.setAttribute("data-ww-shop-designed", "");
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      element.setInnerContent(products, { html: true });
    } })
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", url.origin + url.pathname); } })
    .on('script[src="/app.js"]', { element() { sharedRuntime = true; } })
    .on("body", { element(element) { element.onEndTag((end) => { if (!sharedRuntime) end.before('<script src="/app.js" defer></script>', { html: true }); }); } })
    .transform(new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }));
  return finishCommercePage(filled, env, url);
}

// An address with no page says so on the website's own layout, not as a blank tab.
async function notFoundPage(env, url, missing) {
  const page = await commercePage("Page not found", '<section class="ww-not-found"><h1>We can’t find that page</h1><p><a href="/">Go to the home page</a></p></section>', env, url);
  return page.ok ? new Response(page.body, { status: 404, headers: page.headers }) : missing;
}

// A product with no picture yet: the same "No image" panel the store's own script draws.
function storeBlankPicture() {
  return '<div class="ww-store-image-placeholder" aria-hidden="true">' + STORE_NO_IMAGE + '</div>';
}

// Five stars to the nearest half: filled and empty stars are the characters themselves, so a rating reads right with no
// stylesheet at all; only a half star is drawn by the shop stylesheet (.ww-star-half). Said in words beside it, or by
// its own label where nothing beside it does.
function storeStars(value, label) {
  const halves = Math.min(10, Math.max(0, Math.round(Number(value) * 2)));
  const whole = Math.floor(halves / 2), part = halves % 2;
  return '<span class="ww-stars"' + (label ? ' role="img" aria-label="' + escapeStoreHtml(label) + '"' : ' aria-hidden="true"') + '>'
    + "★".repeat(whole) + (part ? '<span class="ww-star-half">★</span>' : '') + "☆".repeat(5 - whole - part) + '</span>';
}

// A product's stars on its card: its published reviews' average and count (rating, from the shop's list).
function storeRatingMarkup(product) {
  const rating = product && product.rating;
  if (!rating || !(Number(rating.count) > 0)) return "";
  const average = Math.round(Number(rating.average) * 10) / 10, count = Number(rating.count);
  return '<p class="ww-store-rating">' + storeStars(average) + '<span><span class="ww-store-visually-hidden">Rated </span>' + average.toFixed(1)
    + '<span class="ww-store-visually-hidden"> out of 5</span> (' + count + (count === 1 ? ' review' : ' reviews') + ')</span></p>';
}

// Prices are stored in minor units; the currency says how many digits that is.
function storeMoneyText(amount, currency) {
  if (amount === null || amount === undefined || !currency) return "";
  try {
    const format = new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency).toUpperCase() });
    return format.format(Number(amount) / (10 ** format.resolvedOptions().maximumFractionDigits));
  } catch { return ""; }
}

function storePriceMarkup(rows) {
  const product = rows[0];
  const amounts = rows.map((row) => row.priceAmount).filter((value) => value !== null && value !== undefined).map(Number).filter(Number.isFinite);
  if (!amounts.length) return "";
  const low = Math.min(...amounts), high = Math.max(...amounts);
  const price = low === high ? storeMoneyText(low, product.currency) : storeMoneyText(low, product.currency) + " – " + storeMoneyText(high, product.currency);
  if (!price) return "";
  const regular = rows.length === 1 && product.onSale && product.regularPriceAmount != null
    ? '<del>' + escapeStoreHtml(storeMoneyText(product.regularPriceAmount, product.currency)) + '</del> <span class="ww-store-sale-label">Sale · </span>' : "";
  return '<p class="ww-store-price">' + regular + escapeStoreHtml(price) + '</p>';
}

function storeImageSource(product, width) {
  const image = String(product.imageUrl || product.catalog?.images?.[0]?.url || "");
  if (image.startsWith("/images/")) return image + (image.includes("?") ? "&" : "?") + "w=" + width;
  return (image.startsWith("/") && !image.startsWith("//")) || image.startsWith("https://") ? image : "";
}

function storeCardMarkup(rows, display, timeZone) {
  const { cards, parts, details } = storeCardLayout(display);
  const product = rows[0];
  const href = escapeStoreHtml(product.sourcePath || "/shop/");
  const title = escapeStoreHtml(product.title || "Product");
  const image = storeImageSource(product, 640);
  const mode = storeMode(display);
  // A gallery card is the photo, the name and the description, with nowhere to go: its products have no pages.
  if (mode === "gallery") return '<article class="ww-store-card"><div class="ww-store-image-link">'
    + (image ? '<img class="ww-store-image" src="' + escapeStoreHtml(image) + '" alt="' + (cards === "photo" ? "" : title) + '" loading="lazy">' : storeBlankPicture())
    + '</div><h2 class="ww-store-title' + (cards === "photo" ? ' ww-store-visually-hidden' : '') + '">' + title + '</h2>'
    + (cards !== "photo" && product.summary ? '<p class="ww-store-summary">' + escapeStoreHtml(product.summary) + '</p>' : '') + '</article>';
  // A catalog sells nothing: each card opens its product, with the price only when one is set.
  const buyable = mode === "catalog" || rows.some((row) => row.active && row.purchasable);
  if (cards === "photo") return '<article class="ww-store-card">'
    + '<a class="ww-store-image-link" href="' + href + '" aria-label="' + title + '" title="' + title + '">'
    + (image ? '<img class="ww-store-image" src="' + escapeStoreHtml(image) + '" alt="" loading="lazy">' : storeBlankPicture())
    + '</a><h2 class="ww-store-title ww-store-visually-hidden">' + title + '</h2></article>';
  const owned = Boolean(cards);
  const dates = parts.includes("dates") ? productOrderDates(product.catalog, timeZone, "en-US") : {};
  const closed = rows.every((row) => row.orderingClosed);
  const dateLine = dates.cutoff || dates.release ? '<p class="ww-store-dates">'
    + (dates.cutoff ? '<span>Order by: ' + escapeStoreHtml(dates.cutoff) + (closed ? ' (closed)' : '') + '</span>' : '')
    + (dates.release ? '<span>Release: ' + escapeStoreHtml(dates.release) + '</span>' : '') + '</p>' : '';
  const detailLines = details.map((name) => {
    const value = [].concat(product.details?.[name] ?? []).join(", ");
    return value ? '<p class="ww-store-detail"><span class="ww-store-detail-name">' + escapeStoreHtml(name) + ':</span> ' + escapeStoreHtml(value) + '</p>' : '';
  }).join('');
  return '<article class="ww-store-card">'
    + '<a class="ww-store-image-link" href="' + href + '" tabindex="-1" aria-hidden="true">'
    + (image ? '<img class="ww-store-image" src="' + escapeStoreHtml(image) + '" alt="' + title + '" loading="lazy">' : storeBlankPicture())
    + '</a><h2 class="ww-store-title"><a href="' + href + '">' + title + '</a></h2>' + storeRatingMarkup(product) + dateLine + detailLines + (!cards || parts.includes("price") ? storePriceMarkup(rows) : '')
    + (parts.includes("summary") && product.summary ? '<p class="ww-store-summary">' + escapeStoreHtml(product.summary) + '</p>' : '')
    + (buyable ? (owned ? '' : '<a class="ww-store-link" href="' + href + '">View details</a>') : '<p class="ww-store-status">' + (closed && parts.includes("dates") ? 'Pre-orders closed.' : 'Coming soon') + '</p>')
    + '</article>';
}

async function serveCommerceCheckout(env, url) {
  const snapshot = await readCommerceSnapshot(env);
  if (!snapshot?.enabled) return new Response("Store not found", { status: 404 });
  if (storeMode(snapshot.storeDisplay) !== "shop") return notFoundPage(env, url, new Response("Page not found", { status: 404 }));
  if (url.searchParams.has("session_id")) return serveCommerceSuccess(env, url);
  const main = '<section class="ww-checkout" data-ww-behavior="commerce-store" data-ww-cart data-ww-checkout-page>'
    + '<h1>Checkout</h1><p role="status" aria-live="polite">Loading checkout…</p></section>' + storePolicyLinks(snapshot);
  return commercePage("Checkout", main, env, url);
}

function serveCommerceSuccess(env, url) {
  const main = '<section class="ww-store-confirmation"><h1>Payment submitted</h1>'
    + '<p>Your payment is being confirmed. Check your email for your receipt and order updates.</p>'
    + '<a href="/orders/" data-ww-order-history-link>Order history</a> '
    + '<a href="/">Return to the website</a>'
    + '<div data-ww-behavior="commerce-store" data-ww-checkout-complete hidden></div></section>';
  return commercePage("Payment submitted", main, env, url);
}

async function handleStoreCheckout(request, env, url) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const parsed = await contactBody(request);
  if (parsed.rawBytes > MAX_PAYLOAD_BYTES) return Response.json({ error: "Your cart is too large." }, { status: 413 });
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return Response.json({ error: "Your cart could not be read." }, { status: 400 });
  }
  if (!env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return Response.json({ error: "Checkout is temporarily unavailable." }, { status: 503 });
  const limits = await Promise.all([
    env.CONTACT_ACTOR_RATE.limit({ key: "checkout-ip:" + (request.headers.get("cf-connecting-ip") || "unknown") }),
    env.CONTACT_SITE_RATE.limit({ key: "checkout-site:" + CONTACT_SITE_ID })
  ]);
  if (limits.some((limit) => !limit.success)) return Response.json({ error: "Please wait a moment and try again." }, { status: 429 });
  const formCheck = await managedFormCheck(parsed.body, env, request, "checkout");
  if (formCheck) return Response.json({ error: formCheck.message }, { status: formCheck.status });
  const response = await fetch(COMMERCE_PLATFORM_ORIGIN + "/api/site-checkout", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "WheelerWebsites-Generated-Site/1.0",
      ...(request.headers.get("authorization") ? { authorization: request.headers.get("authorization") } : {}) },
    body: JSON.stringify({
      siteId: CONTACT_SITE_ID,
      siteOrigin: url.origin,
      checkoutKey: parsed.body.checkoutKey,
      embedded: parsed.body.embedded === true,
      items: parsed.body.items,
      shippingQuoteId: parsed.body.shippingQuoteId,
      shippingRateId: parsed.body.shippingRateId,
      shippingSession: shippingPlanSession(request),
      couponCode: typeof parsed.body.couponCode === "string" ? parsed.body.couponCode.slice(0, 40) : undefined,
      // The shopper ticked the cart's news box; anything else is no answer at all.
      newsConsent: parsed.body.newsConsent === true ? true : undefined,
      // This website can bring a cart back from a reminder's link (/api/cart-saved and the cart page that reads it), so
      // the platform may plan one. A website not yet upgraded says nothing, and none is planned for it.
      savedCart: true
    })
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// What a discount code would take off the cart, asked of the platform; checkout checks the code again.
async function handleStoreCheckoutCoupon(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const parsed = await contactBody(request);
  if (parsed.rawBytes > MAX_PAYLOAD_BYTES) return Response.json({ error: "Your cart is too large." }, { status: 413 });
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return Response.json({ error: "Your cart could not be read." }, { status: 400 });
  }
  if (!env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return Response.json({ error: "Discount codes are temporarily unavailable." }, { status: 503 });
  const limits = await Promise.all([
    env.CONTACT_ACTOR_RATE.limit({ key: "coupon-ip:" + (request.headers.get("cf-connecting-ip") || "unknown") }),
    env.CONTACT_SITE_RATE.limit({ key: "coupon-site:" + CONTACT_SITE_ID })
  ]);
  if (limits.some((limit) => !limit.success)) return Response.json({ error: "Please wait a moment and try again." }, { status: 429 });
  const response = await fetch(COMMERCE_PLATFORM_ORIGIN + "/api/site-checkout-coupon", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "WheelerWebsites-Generated-Site/1.0" },
    body: JSON.stringify({ siteId: CONTACT_SITE_ID, code: String(parsed.body.code || "").slice(0, 40), items: parsed.body.items })
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// What was paid, for the website's tracking tags: asked of the platform by the payment session in the page's own
// address after checkout. Nothing about the shopper comes back, only the order's number, amounts and items.
async function handleStoreOrderPaid(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const parsed = await contactBody(request);
  const sessionId = String(parsed.body && parsed.body.sessionId || "");
  if (parsed.rawBytes > 1024 || !/^cs_(?:test|live)_[A-Za-z0-9]{8,200}$/.test(sessionId)) return Response.json({ paid: false }, { status: 400 });
  if (!env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return Response.json({ paid: false }, { status: 503 });
  const limits = await Promise.all([
    env.CONTACT_ACTOR_RATE.limit({ key: "order-paid-ip:" + (request.headers.get("cf-connecting-ip") || "unknown") }),
    env.CONTACT_SITE_RATE.limit({ key: "order-paid-site:" + CONTACT_SITE_ID })
  ]);
  if (limits.some((limit) => !limit.success)) return Response.json({ paid: false }, { status: 429 });
  const response = await fetch(COMMERCE_PLATFORM_ORIGIN + "/api/site-order-paid", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "WheelerWebsites-Generated-Site/1.0" },
    body: JSON.stringify({ siteId: CONTACT_SITE_ID, sessionId })
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// The link in a cart reminder (/cart/?saved=<token>): the cart as the shopper left it, asked of the platform by the
// link's token, or, with stop, no more reminders from this shop.
async function handleStoreCartSaved(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const parsed = await contactBody(request);
  const token = String(parsed.body && parsed.body.token || "");
  if (parsed.rawBytes > 2048 || !/^[0-9a-f]{64}$/.test(token)) return Response.json({ error: "This link can't be used." }, { status: 400 });
  if (!env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return Response.json({ error: "Your cart could not be brought back just now." }, { status: 503 });
  const limits = await Promise.all([
    env.CONTACT_ACTOR_RATE.limit({ key: "cart-saved-ip:" + (request.headers.get("cf-connecting-ip") || "unknown") }),
    env.CONTACT_SITE_RATE.limit({ key: "cart-saved-site:" + CONTACT_SITE_ID })
  ]);
  if (limits.some((limit) => !limit.success)) return Response.json({ error: "Please wait a moment and try again." }, { status: 429 });
  const response = await fetch(COMMERCE_PLATFORM_ORIGIN + "/api/site-cart-saved", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "WheelerWebsites-Generated-Site/1.0" },
    body: JSON.stringify({ siteId: CONTACT_SITE_ID, token, stop: parsed.body.stop === true })
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// Carrier rates for the cart and the address the customer typed, asked of the platform before they pay.
async function handleStoreShippingRates(request, env, url) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const parsed = await contactBody(request);
  if (parsed.rawBytes > MAX_PAYLOAD_BYTES) return Response.json({ error: "Your cart is too large." }, { status: 413 });
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return Response.json({ error: "Your cart could not be read." }, { status: 400 });
  }
  if (!env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return Response.json({ error: "Shipping rates are temporarily unavailable." }, { status: 503 });
  const limits = await Promise.all([
    env.CONTACT_ACTOR_RATE.limit({ key: "shipping-ip:" + (request.headers.get("cf-connecting-ip") || "unknown") }),
    env.CONTACT_SITE_RATE.limit({ key: "shipping-site:" + CONTACT_SITE_ID })
  ]);
  if (limits.some((limit) => !limit.success)) return Response.json({ error: "Please wait a moment and try again." }, { status: 429 });
  const response = await fetch(COMMERCE_PLATFORM_ORIGIN + "/api/site-shipping-rates", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "WheelerWebsites-Generated-Site/1.0" },
    body: JSON.stringify({ siteId: CONTACT_SITE_ID, siteOrigin: url.origin, items: parsed.body.items, addressTo: parsed.body.addressTo })
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// The embedded checkout form sends the address the customer typed so the platform can price carrier rates for it.
async function handleStoreCheckoutShipping(request, env, url) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const parsed = await contactBody(request);
  if (parsed.rawBytes > MAX_PAYLOAD_BYTES) return Response.json({ type: "error", message: "That request is too large." }, { status: 413 });
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return Response.json({ type: "error", message: "The address could not be read." }, { status: 400 });
  }
  const response = await fetch(COMMERCE_PLATFORM_ORIGIN + "/api/site-checkout-shipping", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "WheelerWebsites-Generated-Site/1.0" },
    body: JSON.stringify({ siteId: CONTACT_SITE_ID, siteOrigin: url.origin, sessionId: parsed.body.sessionId, shippingDetails: parsed.body.shippingDetails })
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// The page a signup was made on, without its query, except the tag a link carries to say where it was followed from: the
// shop's in-store QR code opens /?from=counter, so a signup made at the counter is recorded as one.
function consentSource(request) {
  const referer = request.headers.get("referer") || "managed signup form";
  try {
    const url = new URL(referer);
    const from = url.searchParams.get("from") || "";
    return url.origin + url.pathname + (/^[A-Za-z0-9_-]{1,32}$/.test(from) ? "?from=" + from : "");
  } catch { return "managed signup form"; }
}

async function handleSubscriberCapture(request, env) {
  const captureToken = String(env.SUBSCRIBER_CAPTURE_TOKEN || SUBSCRIBER_CAPTURE_TOKEN).trim();
  if ((!SUBSCRIBERS_CONFIGURED && !env.SUBSCRIBER_CAPTURE_TOKEN) || !captureToken || !env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const parsed = await contactBody(request);
  if (String(parsed.body?.website || "").trim()) return Response.json({ ok: true, message: "If the address can subscribe, you will receive a confirmation email." }, { status: 202 });
  const email = String(parsed.body?.email || "").trim().toLowerCase();
  const consent = ["true", "1", "yes", "on"].includes(String(parsed.body?.consent || "").toLowerCase());
  const limits = await Promise.all([
    env.CONTACT_ACTOR_RATE.limit({ key: "subscribe-ip:" + (request.headers.get("cf-connecting-ip") || "unknown") }),
    env.CONTACT_SITE_RATE.limit({ key: "subscribe-site:" + CONTACT_SITE_ID })
  ]);
  if (limits.some((limit) => !limit.success)) return Response.json({ error: "Please wait a moment and try again." }, { status: 429 });
  const formCheck = await managedFormCheck(parsed.body, env, request, "subscribe");
  if (formCheck) return Response.json({ error: formCheck.message }, { status: formCheck.status });
  const response = await fetch(SUBSCRIBER_PLATFORM_ORIGIN + "/api/subscribers/capture", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "WheelerWebsites-Generated-Site/1.0" },
    body: JSON.stringify({
      siteId: CONTACT_SITE_ID, captureToken, email, consent,
      // The name a sign-up asked for beside the address (a copied newsletter bar's "First name"), kept with it.
      ...(String(parsed.body?.name || "").trim() ? { name: String(parsed.body.name).trim().slice(0, 200) } : {}),
      consentSource: consentSource(request)
    })
  });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

// A sign-up form (docs/customer-accounts/sign-up-forms.md): the news signup's token, limits, honeypot and bot check,
// with the form it was made on and the name and phone a form may ask for. The platform keeps only what that form asks,
// and answers the same whoever signs up.
async function handleSignupJoin(request, env) {
  const captureToken = String(env.SUBSCRIBER_CAPTURE_TOKEN || SUBSCRIBER_CAPTURE_TOKEN).trim();
  if ((!SUBSCRIBERS_CONFIGURED && !env.SUBSCRIBER_CAPTURE_TOKEN) || !captureToken || !env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const parsed = await contactBody(request);
  if (String(parsed.body?.website || "").trim()) return Response.json({ ok: true, message: "Check your email to confirm your address." }, { status: 202 });
  const limits = await Promise.all([
    env.CONTACT_ACTOR_RATE.limit({ key: "join-ip:" + (request.headers.get("cf-connecting-ip") || "unknown") }),
    env.CONTACT_SITE_RATE.limit({ key: "join-site:" + CONTACT_SITE_ID })
  ]);
  if (limits.some((limit) => !limit.success)) return Response.json({ error: "Please wait a moment and try again." }, { status: 429 });
  const formCheck = await managedFormCheck(parsed.body, env, request, "join");
  if (formCheck) return Response.json({ error: formCheck.message }, { status: formCheck.status });
  const text = (value, most) => String(value || "").trim().slice(0, most);
  const response = await fetch(SUBSCRIBER_PLATFORM_ORIGIN + "/api/signups/capture", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "WheelerWebsites-Generated-Site/1.0" },
    body: JSON.stringify({
      siteId: CONTACT_SITE_ID, captureToken, formId: text(parsed.body?.formId, 64).toLowerCase(),
      email: text(parsed.body?.email, 320).toLowerCase(), name: text(parsed.body?.name, 200), phone: text(parsed.body?.phone, 60),
      source: consentSource(request),
      // The confirmation link may open on this website, which draws the platform's page in its own look.
      confirmPath: "/join/confirm/"
    })
  });
  return new Response(response.body, { status: response.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

const sharedContactResponsePage = async (title, main, env, url) => {
  if (!env?.ASSETS || typeof HTMLRewriter === "undefined") {
    return new Response("The shared site layout is temporarily unavailable.", { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
  }
  const homepage = await env.ASSETS.fetch(new Request(new URL("/", url.origin)));
  if (!homepage.ok || !String(homepage.headers.get("content-type") || "").includes("text/html")) {
    return new Response("The shared site layout is temporarily unavailable.", { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
  }
  const rendered = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(title); } })
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", url.origin + url.pathname); } })
    .on('meta[name="description"]', { element(element) { element.setAttribute("content", title.slice(0, 300)); } })
    .on("main", { element(element) { element.setInnerContent(main, { html: true }); } })
    .transform(homepage);
  const response = new Response(rendered.body, rendered);
  response.headers.set("cache-control", "no-store");
  response.headers.append("Link", "<" + url.origin + url.pathname + ">; rel=canonical");
  return response;
};

const contactResponse = async (result, request, status = result.status, env) => {
  if ((request.headers.get("accept") || "").includes("application/json")) {
    return Response.json(result.response, { status, headers: { "cache-control": "no-store" } });
  }
  const title = result.response.ok ? "Message received" : "Please check the form";
  const siteLabel = typeof CONTACT_SITE_LABEL === "undefined" ? "" : String(CONTACT_SITE_LABEL);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return character === "'" ? "&#39;" : "&quot;";
  });
  const returnLink = { href: "/", label: "Return to the website" };
  try {
    const referer = request.headers.get("referer");
    const previous = referer ? new URL(referer) : null;
    if (previous && previous.origin === new URL(request.url).origin && previous.pathname !== "/api/contact") {
      returnLink.href = previous.pathname;
      returnLink.label = "Return to the form";
    }
  } catch { /* use the safe same-origin homepage fallback */ }
  const main = '<section class="section section-muted" aria-labelledby="contact-response-title"><div class="container"><p><strong>'
    + escapeHtml(siteLabel) + '</strong></p><h1 id="contact-response-title">' + escapeHtml(title)
    + '</h1><p>' + escapeHtml(result.response.message) + '</p><p><a class="button btn btn-primary" href="'
    + escapeHtml(returnLink.href) + '">' + escapeHtml(returnLink.label)
    + '</a></p></div></section>';
  const url = new URL(request.url);
  const pageTitle = siteLabel ? title + " | " + siteLabel : title;
  const rendered = typeof commercePage === "function"
    ? await commercePage(title, main, env, url)
    : await sharedContactResponsePage(pageTitle, main, env, url);
  return new Response(rendered.body, { status: rendered.ok ? status : rendered.status, headers: rendered.headers });
};

async function contactBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_PAYLOAD_BYTES) return { body: {}, rawBytes: contentLength };
  if (!request.body) return { body: null, rawBytes: 0 };
  const reader = request.body.getReader();
  const chunks = [];
  let rawBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rawBytes += value.byteLength;
    if (rawBytes > MAX_PAYLOAD_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return { body: {}, rawBytes };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(rawBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder().decode(bytes);
  if ((request.headers.get("content-type") || "").includes("application/json")) {
    try { return { body: JSON.parse(raw), rawBytes }; } catch { return { body: null, rawBytes }; }
  }
  const body = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    if (Object.hasOwn(body, key)) body[key] = Array.isArray(body[key]) ? [...body[key], value] : [body[key], value];
    else body[key] = value;
  }
  return { body, rawBytes };
}

// A website whose server holds the platform's form token hands each checked message to the platform, which sends it
// to the recipient the owner chose (and can change without touching this code) and records the delivery. The local
// EMAIL binding is the fallback while the platform cannot be reached.
const FORM_PROOF_HEADER = "x-ww-form-proof";

async function handleContact(request, env, ctx) {
  const platformDelivery = Boolean(env.WW_FORM_DELIVERY_TOKEN);
  if ((!platformDelivery && (!CONTACT_CONFIGURED || !env.EMAIL)) || !env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const parsed = await contactBody(request);
  const formCheckToken = takeFormCheckToken(parsed.body);
  const result = evaluateSubmission({
    ...parsed,
    ip: request.headers.get("cf-connecting-ip") || "unknown",
    salt: CONTACT_RATE_SALT,
    siteId: CONTACT_SITE_ID,
    // With platform delivery the platform chooses the recipient and sender; these only shape the message.
    recipient: CONTACT_RECIPIENT || (platformDelivery ? "form-recipient@jaybirddigital.com" : ""),
    from: { name: CONTACT_SITE_LABEL, email: CONTACT_SENDER || (platformDelivery ? "forms@jaybirddigital.com" : "") },
    siteLabel: CONTACT_SITE_LABEL,
    receivedAt: new Date().toISOString()
  });

  const limits = await Promise.all([
    env.CONTACT_ACTOR_RATE.limit({ key: result.rateLimit.ipKey }),
    ...(result.rateLimit.emailKey ? [env.CONTACT_ACTOR_RATE.limit({ key: result.rateLimit.emailKey })] : []),
    env.CONTACT_SITE_RATE.limit({ key: result.rateLimit.siteKey || CONTACT_SITE_ID })
  ]);
  if (limits.some((limit) => !limit.success)) {
    return contactResponse({ response: { ok: false, message: "Please wait a moment and try again.", field: null }, status: 429 }, request, 429, env);
  }

  // The platform's setup test carries a one-time proof the platform itself checks before delivering, so it skips the
  // visitor check here; a made-up proof only gets the message refused by the platform.
  const proof = platformDelivery ? String(request.headers.get(FORM_PROOF_HEADER) || "").slice(0, 200) : "";
  const formCheck = proof ? null : await verifyFormCheck(formCheckToken, env, request, "contact");
  if (formCheck?.status === 503) {
    return contactResponse({ response: { ok: false, message: formCheck.message, field: null }, status: 503 }, request, 503, env);
  }
  if (formCheck?.status) {
    return contactResponse({ response: { ok: false, message: "Please complete the security check and submit the form again.", field: null }, status: 400 }, request, 400, env);
  }
  // Google could not be asked, so the message goes through and tells the owner it was not checked.
  if (formCheck?.unverified && result.outcome === "deliver" && result.email) result.email = uncheckedEmail(result.email);

  console.log(JSON.stringify({ event: result.log.event, outcome: result.log.outcome, discardReason: result.log.discardReason, bytes: result.log.bytes }));
  if (proof) {
    const outcome = result.outcome === "deliver" ? await deliverThroughPlatform(env, result.email, proof)
      : { delivered: false, detail: "The test message was not accepted by the form (" + (result.discardReason || result.outcome) + ")." };
    return Response.json({ ok: outcome.delivered, delivered: outcome.delivered, via: outcome.via || null, detail: outcome.detail || null },
      { status: result.outcome === "reject" ? 400 : 200, headers: { "cache-control": "no-store" } });
  }
  if (result.outcome === "deliver") {
    ctx.waitUntil((platformDelivery
      ? deliverThroughPlatform(env, result.email, "").then((outcome) => {
        if (outcome.delivered || !outcome.fallback || !CONTACT_CONFIGURED || !env.EMAIL) return outcome.delivered ? null : Promise.reject(new Error("not delivered"));
        console.error(JSON.stringify({ event: "contact_platform_fallback", detail: String(outcome.detail || "").slice(0, 120) }));
        return deliverContactEmail(env, result.email);
      })
      : deliverContactEmail(env, result.email)).catch(() => console.error(JSON.stringify({ event: "contact_delivery_failed" }))));
  }
  return contactResponse(result, request, result.status, env);
}

async function formTokenKey(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token))));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

const UNCHECKED_NOTE = "Note: the spam check could not be reached when this was sent, so it was delivered without one.";
function uncheckedEmail(email) {
  return { ...email,
    text: UNCHECKED_NOTE + "\n\n" + String(email.text || ""),
    html: String(email.html || "").replace("<body>", "<body><p><em>" + UNCHECKED_NOTE + "</em></p>") };
}

async function deliverThroughPlatform(env, email, proof) {
  try {
    const response = await fetch(SUBSCRIBER_PLATFORM_ORIGIN + "/api/forms/deliver", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "WheelerWebsites-Generated-Site/1.0" },
      body: JSON.stringify({ siteId: CONTACT_SITE_ID, token: env.WW_FORM_DELIVERY_TOKEN, ...(proof ? { proof } : {}),
        email: { subject: email.subject, text: email.text, html: email.html, replyTo: email.replyTo } })
    });
    const body = await response.json().catch(() => ({}));
    // Anything short of a confirmed delivery falls back to the site's own send when it has one: a stale token, an
    // outage or a refusal must never lose a visitor's message. The platform replaces a stale token within the hour.
    const delivered = response.ok && body.delivered === true;
    return { delivered, via: body.via, detail: body.detail, fallback: !delivered };
  } catch {
    return { delivered: false, fallback: true, detail: "The platform could not be reached." };
  }
}

async function deliverContactEmail(env, email) {
  try {
    await env.EMAIL.send(email);
  } catch (error) {
    if (!CONTACT_FALLBACK_SENDER) throw error;
    console.error(JSON.stringify({ event: "contact_delivery_retry", sender: CONTACT_FALLBACK_SENDER }));
    await env.EMAIL.send({ ...email, from: String(email.from).replace(CONTACT_SENDER, CONTACT_FALLBACK_SENDER) });
  }
}

const { serveOrderHistoryPage, proxyOrderHistory, addOrderHistoryNavigation } = (function createOrderHistoryRuntime({ readCommerceSnapshot, escapeStoreHtml, siteId, siteName, platformOrigin }) {
  const privateHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff" };
  // Snapshots from before order history was opt-in say enabled without the owner choosing it.
  const enabled = snapshot => snapshot?.enabled && snapshot.customerOrderHistory?.optIn === true && snapshot.customerOrderHistory.enabled === true;
  async function serveOrderHistoryPage(request, env) {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: privateHeaders });
    if (!enabled(await readCommerceSnapshot(env))) return new Response("Not found", { status: 404, headers: privateHeaders });
    const original = await env.ASSETS.fetch(new Request(new URL("/orders/index.html", request.url)));
    if (original.ok) return new Response("The existing orders page needs a route review before customer history can be enabled.", { status: 409, headers: privateHeaders });
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Order history | ' + escapeStoreHtml(siteName)
      + '</title><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/order-history.css"><script src="/order-history.js" defer></script></head><body class="ww-orders-body"><header class="ww-orders-header"><a href="/">'
      + escapeStoreHtml(siteName) + '</a><a href="/shop/">Store</a></header><main class="ww-order-history" data-ww-order-history><h1>Order history</h1><p role="status">Loading...</p><noscript>JavaScript is required to request and open your order history.</noscript></main></body></html>';
    return new Response(request.method === "HEAD" ? null : html, { headers: { ...privateHeaders, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
  }
  async function proxyOrderHistory(request, env) {
    const url = new URL(request.url), action = url.pathname.split("/").filter(Boolean).at(-1);
    const methods = { request: "POST", redeem: "POST", logout: "POST", list: "GET" };
    if (!methods[action] || request.method !== methods[action]) return Response.json({ error: "Method not allowed." }, { status: 405, headers: privateHeaders });
    if (request.method === "POST" && (request.headers.get("origin") !== url.origin || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || ""))) return Response.json({ error: "Use this website to access order history." }, { status: 403, headers: privateHeaders });
    if (!env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return Response.json({ error: "Order history is temporarily unavailable." }, { status: 503, headers: privateHeaders });
    const limits = await Promise.all([
      env.CONTACT_ACTOR_RATE.limit({ key: "order-history:" + (request.headers.get("cf-connecting-ip") || "unknown") }),
      env.CONTACT_SITE_RATE.limit({ key: "order-history:" + siteId })
    ]);
    if (limits.some(limit => !limit.success)) return Response.json({ error: "Please wait a moment and try again." }, { status: 429, headers: privateHeaders });
    let body = null;
    if (request.method === "POST") {
      const reader = request.body?.getReader(), chunks = []; let size = 0;
      if (!reader) return Response.json({ error: "Missing request." }, { status: 400, headers: privateHeaders });
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 4096) { await reader.cancel(); return Response.json({ error: "Request is too large." }, { status: 413, headers: privateHeaders }); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        body = { siteId, siteOrigin: url.origin, email: parsed.email, token: parsed.token };
      } catch { return Response.json({ error: "Invalid request." }, { status: 400, headers: privateHeaders }); }
    }
    const destination = new URL("/api/order-history/" + action, platformOrigin);
    destination.searchParams.set("siteId", siteId); destination.searchParams.set("siteOrigin", url.origin);
    for (const key of ["cursor", "limit"]) if (url.searchParams.has(key)) destination.searchParams.set(key, url.searchParams.get(key));
    const cookie = (request.headers.get("cookie") || "").split(";").map(part => part.trim()).find(part => /^__Host-ww-order-session=[a-f0-9]{64}$/.test(part));
    try {
      const upstream = await fetch(destination, { method: request.method, redirect: "manual", headers: { accept: "application/json", "content-type": "application/json", origin: url.origin, ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
      // Workers throw on the redirect mode "error" before anything is sent, so a redirect is not followed. It is refused here
      // instead, which keeps the cookie and body from travelling to a second address.
      if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) { await upstream.body?.cancel().catch(() => {}); throw new Error("redirect"); }
      const headers = new Headers({ ...privateHeaders, "content-type": "application/json; charset=utf-8" });
      const session = upstream.headers.get("set-cookie");
      if (session && /^__Host-ww-order-session=(?:[a-f0-9]{64})?;/.test(session)) headers.set("set-cookie", session);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch { return Response.json({ error: "Order history is temporarily unavailable." }, { status: 503, headers: privateHeaders }); }
  }
  // The menu item lives in the Store drop-down (storeSubmenuMarkup); this only drops links once history is off.
  async function addOrderHistoryNavigation(response, env) {
    if (!response.ok || !String(response.headers.get("content-type") || "").includes("text/html") || typeof HTMLRewriter === "undefined") return response;
    if (enabled(await readCommerceSnapshot(env))) return response;
    return new HTMLRewriter().on("[data-ww-order-history-link]", { element(element) { element.remove(); } }).transform(response);
  }
  return { serveOrderHistoryPage, proxyOrderHistory, addOrderHistoryNavigation };
})({ readCommerceSnapshot, escapeStoreHtml, siteId: CONTACT_SITE_ID, siteName: STORE_SITE_NAME, platformOrigin: COMMERCE_PLATFORM_ORIGIN });
const { serveShippingPlanPage, proxyShippingPlan, shippingPlanSession } = (function createShippingPlanRuntime({ readCommerceSnapshot, escapeStoreHtml, siteId, siteName, platformOrigin }) {
  const privateHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff" };
  const enabled = snapshot => snapshot?.enabled && snapshot.shippingPlans?.enabled === true;
  const sessionPattern = /^__Host-ww-ship-session=([a-f0-9]{64})$/;
  // Checkout passes the plan session along so a member's order ships with their plan instead of paying shipping now.
  function shippingPlanSession(request) {
    const part = (request.headers.get("cookie") || "").split(";").map(entry => entry.trim()).find(entry => sessionPattern.test(entry));
    return part ? sessionPattern.exec(part)[1] : "";
  }
  async function serveShippingPlanPage(request, env) {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: privateHeaders });
    if (!enabled(await readCommerceSnapshot(env))) return new Response("Not found", { status: 404, headers: privateHeaders });
    const original = await env.ASSETS.fetch(new Request(new URL("/shipping-plan/index.html", request.url)));
    if (original.ok) return new Response("The existing shipping-plan page needs a route review before shipping plans can be offered.", { status: 409, headers: privateHeaders });
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shipping plan | ' + escapeStoreHtml(siteName)
      + '</title><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/order-history.css"><link rel="stylesheet" href="/shipping-plan.css"><script src="/shipping-plan.js" defer></script></head><body class="ww-orders-body"><header class="ww-orders-header"><a href="/">'
      + escapeStoreHtml(siteName) + '</a><a href="/shop/">Store</a></header><main class="ww-order-history ww-shipping-plan" data-ww-shipping-plan><h1>Shipping plan</h1><p role="status">Loading...</p><noscript>JavaScript is required to open your shipping plan.</noscript></main></body></html>';
    return new Response(request.method === "HEAD" ? null : html, { headers: { ...privateHeaders, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
  }
  async function proxyShippingPlan(request, env) {
    const url = new URL(request.url), action = url.pathname.split("/").filter(Boolean).at(-1);
    const methods = { status: "GET", request: "POST", redeem: "POST", accept: "POST", card: "POST", logout: "POST" };
    if (!methods[action] || request.method !== methods[action]) return Response.json({ error: "Method not allowed." }, { status: 405, headers: privateHeaders });
    if (request.method === "POST" && (request.headers.get("origin") !== url.origin || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || ""))) return Response.json({ error: "Use this website to open your shipping plan." }, { status: 403, headers: privateHeaders });
    if (!env.CONTACT_ACTOR_RATE || !env.CONTACT_SITE_RATE) return Response.json({ error: "Shipping plans are temporarily unavailable." }, { status: 503, headers: privateHeaders });
    const limits = await Promise.all([
      env.CONTACT_ACTOR_RATE.limit({ key: "shipping-plan:" + (request.headers.get("cf-connecting-ip") || "unknown") }),
      env.CONTACT_SITE_RATE.limit({ key: "shipping-plan:" + siteId })
    ]);
    if (limits.some(limit => !limit.success)) return Response.json({ error: "Please wait a moment and try again." }, { status: 429, headers: privateHeaders });
    let body = null;
    if (request.method === "POST") {
      const reader = request.body?.getReader(), chunks = []; let size = 0;
      if (!reader) return Response.json({ error: "Missing request." }, { status: 400, headers: privateHeaders });
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 4096) { await reader.cancel(); return Response.json({ error: "Request is too large." }, { status: 413, headers: privateHeaders }); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        body = { siteId, siteOrigin: url.origin, email: parsed.email, token: parsed.token, planId: parsed.planId, agree: parsed.agree === true, cadence: parsed.cadence };
      } catch { return Response.json({ error: "Invalid request." }, { status: 400, headers: privateHeaders }); }
    }
    const destination = new URL("/api/shipping-plan/" + action, platformOrigin);
    destination.searchParams.set("siteId", siteId); destination.searchParams.set("siteOrigin", url.origin);
    if (action === "status" && /^cs_[A-Za-z0-9_]{1,200}$/.test(url.searchParams.get("setup") || "")) destination.searchParams.set("setup", url.searchParams.get("setup"));
    const session = shippingPlanSession(request);
    try {
      const upstream = await fetch(destination, { method: request.method, redirect: "manual", headers: { accept: "application/json", "content-type": "application/json", origin: url.origin, ...(session ? { cookie: "__Host-ww-ship-session=" + session } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
      // Workers throw on the redirect mode "error" before anything is sent, so a redirect is not followed. It is refused here
      // instead, which keeps the cookie and body from travelling to a second address.
      if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) { await upstream.body?.cancel().catch(() => {}); throw new Error("redirect"); }
      const headers = new Headers({ ...privateHeaders, "content-type": "application/json; charset=utf-8" });
      const cookie = upstream.headers.get("set-cookie");
      if (cookie && /^__Host-ww-ship-session=(?:[a-f0-9]{64})?;/.test(cookie)) headers.set("set-cookie", cookie);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch { return Response.json({ error: "Shipping plans are temporarily unavailable." }, { status: 503, headers: privateHeaders }); }
  }
  return { serveShippingPlanPage, proxyShippingPlan, shippingPlanSession };
})({ readCommerceSnapshot, escapeStoreHtml, siteId: CONTACT_SITE_ID, siteName: STORE_SITE_NAME, platformOrigin: COMMERCE_PLATFORM_ORIGIN });

// The website's icon (docs/site-icon.md): the picture the owner chose, or the website's initials on its own button
// colour, drawn here. The choice is a small public record in storage, read at most once a minute, so it takes effect
// without a new version of this code. A page that already names an icon keeps it unless the owner chose one.
let siteIconCache = null;
async function siteIconSettings(env) {
  if (siteIconCache && Date.now() - siteIconCache.at < 60000) return siteIconCache.value;
  let value = null;
  try {
    const object = env.MEDIA ? await env.MEDIA.get("site-integrations/" + CONTACT_SITE_ID + "/icon.json") : null;
    value = object ? await object.json() : null;
  } catch { value = null; }
  siteIconCache = { at: Date.now(), value };
  return value;
}
// The brand kit's picture for shared links (docs/brand-kit-plan.md): a page with no og:image of its own gets it.
let siteBrandCache = null;
async function siteBrandSettings(env) {
  if (siteBrandCache && Date.now() - siteBrandCache.at < 60000) return siteBrandCache.value;
  let value = null;
  try {
    const object = env.MEDIA ? await env.MEDIA.get("site-integrations/" + CONTACT_SITE_ID + "/brand.json") : null;
    value = object ? await object.json() : null;
  } catch { value = null; }
  siteBrandCache = { at: Date.now(), value };
  return value;
}
// Whether the website takes email signups (site-integrations/<site>/signups.json, which the platform publishes as the
// owner turns them on or off), read at most once a minute: the cart offers its "email me news" box only then.
let siteSignupsCache = null;
async function siteSignupsSettings(env) {
  if (siteSignupsCache && Date.now() - siteSignupsCache.at < 60000) return siteSignupsCache.value;
  let value = null;
  try {
    const object = env.MEDIA ? await env.MEDIA.get("site-integrations/" + CONTACT_SITE_ID + "/signups.json") : null;
    value = object ? await object.json() : null;
  } catch { value = null; }
  siteSignupsCache = { at: Date.now(), value };
  return value;
}
function siteSharePath(brand) {
  const path = String((brand && brand.share && brand.share.mediaPath) || "").replace(/^[/]+/, "");
  return /^[A-Za-z0-9][A-Za-z0-9/_. -]{0,300}[.](?:png|jpe?g|webp|gif|avif)$/i.test(path) && path.indexOf("..") < 0 ? path : "";
}
function siteIconInitials(name) {
  const words = String(name || "").replace(/[^\p{L}\p{N}\s&-]/gu, " ").split(/[\s&-]+/).filter(Boolean);
  const meaningful = words.filter((word) => !/^(?:the|a|an|of|and|de|la|le|el)$/i.test(word));
  const use = meaningful.length ? meaningful : words;
  if (!use.length) return "W";
  if (use.length === 1) return use[0].slice(0, use[0].length > 4 ? 2 : 1).toUpperCase();
  return (use[0][0] + use[1][0]).toUpperCase();
}
function siteIconSvg(settings) {
  const colour = (value, fallback) => (/^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback);
  const initials = String((settings && settings.initials) || siteIconInitials(CONTACT_SITE_LABEL)).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "W";
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="' + colour(settings && settings.background, "#1f2933") + '"/>'
    + '<text x="32" y="32" dy=".35em" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="' + (initials.length > 1 ? 28 : 36) + '" fill="'
    + colour(settings && settings.color, "#ffffff") + '">' + initials + '</text></svg>';
}
// The icon picture: in the shared bucket, or, for a website that keeps its photos in a bucket of its own (bound as PHOTOS,
// every name starting photos/), there.
async function siteIconObject(env, mediaPath) {
  const relative = String(mediaPath).replace(/^\/+/, "");
  const shared = env.MEDIA ? await env.MEDIA.get(MEDIA_PREFIX + relative) : null;
  if (shared) return shared;
  return env.PHOTOS && relative.indexOf("photos/") === 0 && relative.indexOf("..") < 0 ? env.PHOTOS.get(relative) : null;
}
async function serveSiteIcon(env, size) {
  const settings = await siteIconSettings(env);
  if (settings && settings.mediaPath && (env.MEDIA || env.PHOTOS)) {
    const object = await siteIconObject(env, settings.mediaPath);
    if (object) {
      try {
        if (!env.IMAGES) throw new Error("no images binding");
        const result = await env.IMAGES.input(object.body).transform({ width: size, height: size, fit: "cover" }).output({ format: "image/png" });
        const response = result.response();
        response.headers.set("cache-control", "public, max-age=3600");
        return response;
      } catch {
        const original = await siteIconObject(env, settings.mediaPath);
        if (original) {
          const headers = new Headers({ "cache-control": "public, max-age=3600" });
          if (original.httpMetadata && original.httpMetadata.contentType) headers.set("content-type", original.httpMetadata.contentType);
          return new Response(original.body, { headers });
        }
      }
    }
  }
  return new Response(siteIconSvg(settings), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
function withSiteIcon(handler) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === "/_ww/icon" && (request.method === "GET" || request.method === "HEAD")) {
        const size = Math.min(256, Math.max(16, parseInt(url.searchParams.get("size") || "64", 10) || 64));
        return serveSiteIcon(env, size);
      }
      if (url.pathname === "/favicon.ico" && request.method === "GET") {
        const settings = await siteIconSettings(env);
        if (settings && settings.mediaPath) return serveSiteIcon(env, 48);
      }
      const response = await handler.fetch(request, env, ctx);
      if (request.method !== "GET" || response.status !== 200 || typeof HTMLRewriter === "undefined"
        || !String(response.headers.get("content-type") || "").includes("text/html")) return response;
      const settings = await siteIconSettings(env);
      const chosen = Boolean(settings && settings.mediaPath);
      const version = encodeURIComponent(String((settings && settings.updatedAt) || "1"));
      const share = siteSharePath(await siteBrandSettings(env));
      const shareUrl = share ? url.origin + "/images/" + share.split("/").map(encodeURIComponent).join("/") + "?w=1200" : "";
      let hasIcon = false;
      let hasShare = false;
      return new HTMLRewriter()
        .on("link[rel]", { element(element) {
          if (!/icon/i.test(element.getAttribute("rel") || "")) return;
          if (chosen) element.remove(); else hasIcon = true;
        } })
        .on('meta[property="og:image"], meta[name="twitter:image"]', { element(element) {
          if (String(element.getAttribute("content") || "").trim()) hasShare = true;
        } })
        .on("head", { element(element) {
          element.onEndTag((end) => {
            if (chosen) end.before('<link rel="icon" href="/_ww/icon?v=' + version + '"><link rel="apple-touch-icon" href="/_ww/icon?size=180&v=' + version + '">', { html: true });
            else if (!hasIcon) end.before('<link rel="icon" href="/_ww/icon?v=' + version + '">', { html: true });
            if (shareUrl && !hasShare) end.before('<meta property="og:image" content="' + shareUrl.replace(/"/g, "&quot;") + '"><meta name="twitter:image" content="' + shareUrl.replace(/"/g, "&quot;") + '">', { html: true });
          });
        } })
        .transform(response);
    }
  };
}

const siteRequestHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // This site's own server code (src/site-routes.js) answers first; everything it passes on is the platform's.
    const own = await siteRoutes(request, env, ctx);
    if (own) return own;
    // The website's own API (src/site-api.js) answers under its prefix, apart from this server, and nothing else does.
    if (url.pathname.startsWith(SITE_API_PREFIX)) return siteApiResponse(request, env, ctx, { siteId: CONTACT_SITE_ID, source: SITE_API_SOURCE });
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/" + INDEXNOW_KEY + ".txt") {
      return new Response(request.method === "HEAD" ? null : INDEXNOW_KEY, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }
    if (url.pathname === "/_ww/security/capabilities" && request.method === "GET") {
      return Response.json({
        siteId: CONTACT_SITE_ID,
        turnstile: true,
        ...formCheckCapabilities(env),
        contactForm: CONTACT_CONFIGURED,
        formDelivery: 1,
        platformDelivery: Boolean(env.WW_FORM_DELIVERY_TOKEN),
        // A short key of the token, so the platform can tell a stale one and replace it; it reveals nothing usable.
        ...(env.WW_FORM_DELIVERY_TOKEN ? { platformDeliveryKey: await formTokenKey(env.WW_FORM_DELIVERY_TOKEN) } : {}),
        turnstileEnabled: formCheckCapabilities(env).formCheckProvider === "turnstile",
        siteApi: SITE_API_PREFIX
      }, {
        headers: { "cache-control": "no-store" }
      });
    }
    if (url.pathname === "/api/contact") return handleContact(request, env, ctx);
    if (url.pathname === "/api/instagram-feed" && request.method === "GET") return serveInstagramFeed(env);
    if (url.pathname === "/api/facebook-feed" && request.method === "GET") return serveFacebookFeed(env);
    if (url.pathname === "/api/events" && request.method === "GET") return serveEventSnapshot(request, env, false);
    if (url.pathname === "/events.ics" && request.method === "GET") return serveEventSnapshot(request, env, true);
    if (url.pathname === "/api/updates" && request.method === "GET") return serveUpdateSnapshot(request, env);
    if (url.pathname === "/api/subscribe") return handleSubscriberCapture(request, env);
    if (url.pathname === "/api/join") return handleSignupJoin(request, env);
    if (url.pathname === "/api/store") {
      return request.method === "GET" ? serveCommerceSnapshot(request, env)
        : new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    }
    if (url.pathname === "/api/checkout") return handleStoreCheckout(request, env, url);
    if (url.pathname === "/api/checkout-coupon") return handleStoreCheckoutCoupon(request, env);
    if (url.pathname === "/api/order-paid") return handleStoreOrderPaid(request, env);
    if (url.pathname === "/api/cart-saved") return handleStoreCartSaved(request, env);
    if (url.pathname === "/api/shipping-rates") return handleStoreShippingRates(request, env, url);
    if (url.pathname === "/api/checkout-shipping") return handleStoreCheckoutShipping(request, env, url);
    if (url.pathname.startsWith("/api/order-history/")) return proxyOrderHistory(request, env);
    if (["/orders", "/orders/", "/orders/access", "/orders/access/"].includes(url.pathname)) return serveOrderHistoryPage(request, env);
    if (url.pathname.startsWith("/api/shipping-plan/")) return proxyShippingPlan(request, env);
    if (["/shipping-plan", "/shipping-plan/", "/shipping-plan/access", "/shipping-plan/access/"].includes(url.pathname)) return serveShippingPlanPage(request, env);
    if (request.method === "GET" && !url.pathname.startsWith("/images/")
      && !url.pathname.startsWith("/media/")) {
      const collectionPage = await serveManagedShopCollection(request, env);
      if (collectionPage) return collectionPage;
      const productRoute = url.pathname.endsWith("/") ? url.pathname : url.pathname + "/";
      const dynamicProductRoute = COMMERCE_PRODUCT_PATHS.includes(productRoute)
        || /^\/products\/[a-z0-9-]+\/$/i.test(productRoute);
      const commerceRoute = ["/shop", "/shop/", "/cart", "/cart/", "/checkout", "/checkout/",
        "/checkout/success", "/checkout/success/"].includes(url.pathname) || dynamicProductRoute;
      const policyRoute = url.pathname === "/policies" || url.pathname.startsWith("/policies/");
      const commerceSnapshot = commerceRoute || policyRoute ? await readCommerceSnapshot(env) : null;
      if (policyRoute && commerceSnapshot?.enabled) {
        const policyPage = await serveStorePolicy(request, env, url, commerceSnapshot);
        if (policyPage) return policyPage;
      }
      if (commerceSnapshot?.enabled && (commerceSnapshot.hiddenProductPaths || []).includes(productRoute)) return new Response("Product not found", { status: 404 });
      if (commerceRoute && commerceSnapshot?.enabled) {
        if (url.pathname === "/shop" || url.pathname === "/shop/") return serveCommerceShop(env, url);
        if (url.pathname === "/cart" || url.pathname === "/cart/") return serveCommerceCart(env, url);
        if (url.pathname === "/checkout" || url.pathname === "/checkout/") return serveCommerceCheckout(env, url);
        if (url.pathname === "/checkout/success" || url.pathname === "/checkout/success/") return serveCommerceSuccess(env, url);
        if (dynamicProductRoute) {
          const productPage = await serveCommerceProductPage(request, env, productRoute);
          if (productPage.status !== 404 || !PENDING_COLLECTION_SOURCES[productRoute]) return productPage;
        }
      }
      const managedEvent = eventDetailRoutes(await readEventSnapshot(env))
        .find((entry) => entry.path === productRoute);
      if (managedEvent) {
        // A migrated route may have a verified source-backed page with booking,
        // RSVP or other details the managed event row does not represent yet.
        // Keep that page; owner-created events have no asset and use this view.
        const copiedPage = await env.ASSETS.fetch(request);
        if (!copiedPage.ok) return serveManagedEventPage(env, url, managedEvent);
      }
      // Not imported yet: the source page, until this site replaces it on that domain.
      const pendingSource = !managedEvent && PENDING_COLLECTION_SOURCES[productRoute];
      if (pendingSource && new URL(pendingSource).host !== url.host) return Response.redirect(pendingSource, 302);
    }
    if (url.pathname.startsWith("/images/")) return serveImage(request, env, ctx, url);
    if (url.pathname.startsWith("/media/")) return serveMedia(request, env, url);
    if (url.pathname === "/favicon.ico" && FAVICON_MEDIA_PATH) {
      const icon = await env.ASSETS.fetch(request);
      if (icon.ok) return icon;
      return serveImage(request, env, ctx, new URL("/images/" + FAVICON_MEDIA_PATH, url.origin));
    }
    // The sitemap is written with relative <loc> values, which is invalid per
    // the sitemaps.org protocol — a <loc> must be an absolute URL. Rewrite them
    // on the fly using the request origin, so the same file works for the
    // *.workers.dev preview and any custom domain alike.
    // robots.txt exists to point a crawler at the sitemap, and the directive has
    // to be an absolute URL. The origin is only known per request - the same
    // site answers on *.workers.dev and on its custom domain - so it is added
    // here rather than baked into the file, exactly as the sitemap below is.
    if (url.pathname === "/robots.txt") {
      const robots = await env.ASSETS.fetch(new Request(new URL("/robots.txt", url.origin), request));
      if (robots.ok) {
        const body = await robots.text();
        const withSitemap = /^\s*sitemap\s*:/im.test(body)
          ? body
          : `${body.replace(/\s*$/, "")}\nSitemap: ${url.origin}/sitemap.xml\n`;
        return new Response(withSitemap, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return robots;
    }
    if (url.pathname === "/sitemap.xml") {
      const sitemap = await env.ASSETS.fetch(new Request(new URL("/sitemap.xml", url.origin), request));
      if (sitemap.ok) {
        let body = await sitemap.text();
        body = await addCommerceRoutesToSitemap(body, env, url.origin);
        // Every backslash here is doubled because this whole Worker is written
        // from a template literal: "/" in the template becomes "/" in the
        // generated file, which turned this regex into /<loc>(/ — an
        // unterminated group that failed the wrangler build.
        const rewritten = body.replace(/<loc>(\/[^<]*)<\/loc>/g, (_, path) => `<loc>${url.origin}${path}</loc>`);
        return new Response(rewritten, { headers: { "content-type": "application/xml; charset=utf-8" } });
      }
      return sitemap;
    }
    if (url.pathname === "/site-manifest.json") {
      return addCommerceRoutesToManifest(
        await env.ASSETS.fetch(new Request(new URL("/site-manifest.json", url.origin), request)), env
      );
    }
    // Try the path as sent and with a trailing slash, so both /about-us and
    // /about-us/ find the same redirect.
    const target = REDIRECTS[url.pathname] || REDIRECTS[url.pathname + "/"] || REDIRECTS[url.pathname.replace(/\/$/, "")];
    if (target && target !== url.pathname) {
      return Response.redirect(new URL(target + url.search, url.origin).toString(), 301);
    }
    // Canonical is declared here, not in the page, and as a header rather than
    // a <link>.
    //
    // The generator cannot know this site's address: it answers on a
    // *.workers.dev preview and, later, on a custom domain. A canonical baked
    // in at build time would name the workers.dev URL and tell Google to
    // deindex the real domain the day it is attached - worse than none at all.
    // Google reads Link: rel="canonical" exactly as it reads the tag, and doing
    // it in a header costs nothing: the HTML is not parsed or rewritten.
    const response = withManagedFormCheck(
      await addOrderHistoryNavigation(await addCommerceNavigation(await env.ASSETS.fetch(request), env), env), env, request
    );
    const type = response.headers.get("content-type") || "";
    if (response.status === 404 && request.method === "GET" && !type.includes("text/html") && !/\.[a-z0-9]+$/i.test(url.pathname)) return notFoundPage(env, url, response);
    if (!type.includes("text/html") || !response.ok) return response;
    const canonical = new Response(response.body, response);
    canonical.headers.append("Link", `<${url.origin}${url.pathname}>; rel="canonical"`);

    return canonical;
  }
};

// Every request passes the icon first (src/content/site-icon.js on the platform writes what it reads).
const siteHandler = withSiteIcon(siteRequestHandler);

// The owner's own content, resolved while the page streams.
//
// Wrapped around the handler rather than written into it, so this site and a
// site retrofitted afterwards resolve content through the same code. Anything
// that is not an HTML page passes straight through.
export default withSiteContent(siteHandler, {
  key: "site-content/b97ce281-ffaf-4808-b4d6-9778c1d2d95e.json",
  binding: "MEDIA",
  formCheck: signupFormCheck,
  // This Worker takes sign-up forms at /api/join, so the content layer draws them (public/signup-forms-site.js).
  joinFormCheck: (env, language) => signupFormCheck(env, language, "join")
});

// BEGIN MANAGED SHOP COLLECTIONS
const SHOP_COLLECTION_CONFIG = {"routes":[]};
function productExpired(product, policy, now = Date.now()) {
  const at = retentionHideAt(product, policy);
  return at !== null && at <= now;
}
function retentionHideAt(product, policy) {
  if (!policy?.enabled || product.catalog?.retentionExempt === true) return null;
  if (policy.keepStock !== false && product.inventoryMode === 'tracked' && Number(product.inventoryQuantity) > 0) return null;
  const months = Number(policy.months);
  if (!Number.isInteger(months) || months < 1 || months > 240) return null;
  const catalog = product.catalog || {};
  let raw;
  if (typeof policy.basis === 'string' && policy.basis.startsWith('field:')) {
    const key = policy.basis.slice(6), attribute = catalog.attributes?.[policy.basisLabel];
    const value = [catalog.fields?.[key], catalog.publication?.[key], Array.isArray(attribute) ? attribute[0] : attribute].find((entry) => typeof entry === 'string' && entry.trim());
    const text = String(value || '').trim(), us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text), iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/.exec(text);
    raw = us ? `${us[3].length === 2 ? `20${us[3]}` : us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : '';
  } else raw = policy.basis === 'cutoff' ? catalog.orderCutoffAt : policy.basis === 'created' ? product.createdAt : catalog.releaseDate || catalog.releaseAt;
  const date = new Date(raw || product.createdAt || '');
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(day,last));
  return date.getTime();
}
function productSalePrice(product, now = Date.now()) {
  const regular = product.regularPriceAmount ?? product.priceAmount;
  const sale = product.catalog?.sale;
  const ruleSales = Array.isArray(product.catalog?.ruleSales) ? product.catalog.ruleSales : [];
  let amount = regular;
  for (const offer of [sale?.enabled ? sale : null, ...ruleSales]) {
    if (!offer || regular == null || (offer.startsAt && Date.parse(offer.startsAt) > now) || (offer.endsAt && Date.parse(offer.endsAt) <= now)) continue;
    let price = regular;
    if (Number.isInteger(offer.percentOff) && offer.percentOff > 0 && offer.percentOff < 100) price = Number.isSafeInteger(Number(regular)) ? Number((BigInt(regular) * BigInt(100 - offer.percentOff) + 50n) / 100n) : regular;
    else if (Number.isSafeInteger(offer.amountOff) && offer.amountOff > 0) price = Math.max(0, Number(regular) - offer.amountOff);
    else if (offer === sale && Number.isSafeInteger(sale.priceAmount) && sale.priceAmount >= 0) price = sale.priceAmount;
    if (price < amount) amount = price;
  }
  const onSale = amount != null && amount < regular;
  return {...product,priceAmount:onSale?amount:regular,regularPriceAmount:regular,onSale};
}
function storeCardLayout(display) {
  const style = display && display.cards;
  const cards = style === 'preorder' ? 'custom' : ['photo','price','details','custom'].indexOf(style) !== -1 ? style : '';
  const known = ['price','summary','dates','add'];
  const chosen = style === 'preorder' ? ['dates','price','add'] : Array.isArray(display && display.cardParts) ? display.cardParts : ['price','add'];
  const parts = cards === 'price' ? ['price'] : cards === 'details' ? ['price','summary'] : cards === 'custom' ? known.filter((part) => chosen.indexOf(part) !== -1) : [];
  const details = cards === 'custom' && Array.isArray(display.cardDetails) ? display.cardDetails.filter((name) => typeof name === 'string' && name).slice(0, 6) : [];
  return { cards, parts, details };
}
function storeMode(display) {
  const mode = display && display.mode;
  return mode === 'gallery' || mode === 'catalog' ? mode : 'shop';
}
function readableBannerColors(banner) {
  const TONES = {accent:['#213e52','#ffffff'],neutral:['#eef2f4','#243542'],warm:['#f2e4c8','#41331d']};
  const REQUIRED = 4.5, TARGET = 4.54; // a little over, so a browser's rounding never lands under the rule
  const hex = value => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
  const channels = value => [1,3,5].map(at => parseInt(value.slice(at,at+2),16));
  const toHex = values => '#'+values.map(value => Math.max(0,Math.min(255,value)).toString(16).padStart(2,'0')).join('');
  const luminance = value => {
    const [r,g,b] = channels(value).map(channel => {const s = channel/255;return s <= 0.03928 ? s/12.92 : ((s+0.055)/1.055)**2.4;});
    return 0.2126*r+0.7152*g+0.0722*b;
  };
  const contrast = (first,second) => {const [light,dark] = [luminance(first),luminance(second)].sort((x,y)=>y-x);return (light+0.05)/(dark+0.05);};
  const tone = TONES[banner?.tone] || TONES.accent;
  const givenBackground = hex(banner?.backgroundColor), givenText = hex(banner?.textColor);
  const background = givenBackground || tone[0];
  let text = givenText || tone[1];
  if (contrast(background,text) >= REQUIRED) return {backgroundColor:givenBackground,textColor:givenText,adjusted:false};
  if (!givenText) {
    text = contrast(background,'#111111') >= contrast(background,'#ffffff') ? '#111111' : '#ffffff';
    if (contrast(background,text) >= REQUIRED) return {backgroundColor:background,textColor:text,adjusted:true};
  }
  // One colour stepped toward black or toward white until the pair is readable; null when that direction never is.
  const moved = (colour,against,darker) => {
    let values = channels(colour);
    for (let step = 0; step < 255; step += 1) {
      values = values.map(value => darker ? Math.floor(value*0.96) : Math.ceil(value+(255-value)*0.06));
      const next = toHex(values);
      if (contrast(next,against) >= TARGET) return next;
      if (next === (darker ? '#000000' : '#ffffff')) return null;
    }
    return null;
  };
  const distance = (first,second) => {const a = channels(first), b = channels(second);return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);};
  const choices = [];
  for (const darker of [true,false]) {
    const newText = moved(text,background,darker);
    if (newText) choices.push({backgroundColor:background,textColor:newText,cost:distance(text,newText)});
    const newBackground = moved(background,text,darker);
    if (newBackground) choices.push({backgroundColor:newBackground,textColor:text,cost:1.5*distance(background,newBackground)});
  }
  // Black or white text always reads on any one background, so there is always a choice; this is for a bad input.
  if (!choices.length) return {backgroundColor:'#213e52',textColor:'#ffffff',adjusted:true};
  const best = choices.sort((first,second)=>first.cost-second.cost)[0];
  return {backgroundColor:best.backgroundColor,textColor:best.textColor,adjusted:true};
}
function storeBannerColorRules(banners) {
  return (Array.isArray(banners) ? banners : []).map((banner,index) => {
    const shown = readableBannerColors(banner);
    const background = shown.backgroundColor ? 'background:'+shown.backgroundColor+';' : '';
    const color = shown.textColor ? 'color:'+shown.textColor+';' : '';
    return background || color ? '.ww-store-announcements>.ww-store-announcement:nth-child('+(index+1)+'){'+background+color+'}' : '';
  }).join('');
}
function productCutoffDay(product, fallbackZone = "UTC") {
  const catalog = product.catalog || {};
  if (!catalog.orderCutoffAt || !Number.isFinite(Date.parse(catalog.orderCutoffAt))) return "";
  try {
    const zone = catalog.orderCutoffTimeZone || fallbackZone;
    const formats = productCutoffDay.formats || (productCutoffDay.formats = new Map());
    if (!formats.has(zone)) { if (formats.size >= 64) formats.clear(); formats.set(zone,new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })); }
    const parts = formats.get(zone).formatToParts(new Date(catalog.orderCutoffAt));
    const value = type => parts.find(part => part.type === type)?.value;
    return `${value("year")}-${value("month")}-${value("day")}`;
  } catch { return ""; }
}
function shopCollectionIndex(snapshot, config = {}) {
  if (!snapshot?.enabled) return [];
  const normalize = value => { try { const u = new URL(value, "https://collection.invalid"); return u.origin === "https://collection.invalid" && !u.search && !u.hash ? `${u.pathname.replace(/\/+$/, "")}/` : ""; } catch { return ""; } };
  const configuredRoutes = new Map((config.routes || []).map(route => [normalize(route.path), route]));
  const cutoffDays = new Map();
  const groups = new Map();
  const seen = new Set();
  for (const product of [...snapshot.sourceProducts || [], ...snapshot.products || []]) {
    if (seen.has(product.id) || product.catalog?.visible === false) continue;
    seen.add(product.id);
    const cutoffKey = String(product.catalog?.orderCutoffAt || "") + ":" + String(product.catalog?.orderCutoffTimeZone || "");
    if (!cutoffDays.has(cutoffKey)) cutoffDays.set(cutoffKey, productCutoffDay(product, config.timeZone || snapshot.collectionTimeZone || "UTC"));
    const day = cutoffDays.get(cutoffKey);
    const entries = day ? [{ path: `/shop/foc/${day}/`, title: `FOC ${day.slice(5,7)}/${day.slice(8,10)}/${day.slice(0,4)}`, kind: "foc", cutoffDate: day }] : [];
    const categories = new Map((product.catalog?.categories || []).map(c => [normalize(c.path), c.label]));
    if (product.categoryPath && !categories.has(normalize(product.categoryPath))) categories.set(normalize(product.categoryPath), "");
    for (const [path, label] of categories) {
      if (!path || path === "/" || /^\/(?:collections\/foc-|shop\/foc\/|products\/|api\/|images\/|media\/)/i.test(path) || ["/shop/","/cart/","/checkout/"].includes(path)) continue;
      const configured = configuredRoutes.get(path);
      entries.push({ path, title: configured?.title || label || decodeURIComponent(path.split("/").filter(Boolean).at(-1)).replace(/-/g," "), kind: "category", categoryPath: path });
    }
    for (const entry of entries) {
      const group = groups.get(entry.path) || { ...entry, products: [] };
      group.products.push(product);
      groups.set(entry.path, group);
    }
  }
  return [...groups.values()].sort((a,b) => a.path.localeCompare(b.path));
}
function shopMenuFilter(snapshot, samples = [], contrast = []) {
  const key = path => `${String(path || "").replace(/\/+$/, "")}/`;
  const wanted = new Set((samples || []).map(key).filter(path => path !== "/"));
  const others = new Set((contrast || []).map(key).filter(path => path !== "/" && !wanted.has(path)));
  if (!wanted.size) return "";
  const rows = [...snapshot?.sourceProducts || [], ...snapshot?.products || []];
  const counts = new Map();
  const matched = [];
  const contrasted = [];
  for (const row of rows) {
    for (const [name, values] of Object.entries(row.catalog?.attributes || {})) {
      for (const value of [].concat(values)) counts.set(name + "\u0000" + value, (counts.get(name + "\u0000" + value) || 0) + 1);
    }
    if (row.sourcePath && wanted.has(key(row.sourcePath))) matched.push(row);
    else if (row.sourcePath && others.has(key(row.sourcePath))) contrasted.push(row);
  }
  if (matched.length < 3) return "";
  const has = (row, name, value) => [].concat(row.catalog?.attributes?.[name] || []).includes(value);
  let best = null;
  for (const [name, values] of Object.entries(matched[0].catalog?.attributes || {})) {
    for (const value of [].concat(values)) {
      if (!matched.every(row => has(row, name, value))) continue;
      if (contrasted.length && contrasted.filter(row => has(row, name, value)).length * 2 >= contrasted.length) continue;
      const count = counts.get(name + "\u0000" + value) || 0;
      if (count < rows.length && (!best || count > best.count)) best = { name, value, count };
    }
  }
  return best ? new URLSearchParams([["attr." + best.name, best.value]]).toString() : "";
}
function shopMenuGroups(index, kind, timeZone = "UTC", now = Date.now()) {
  const today = productCutoffDay({ catalog: { orderCutoffAt: new Date(now).toISOString() } }, timeZone);
  return index.filter(group => group.kind === kind && (kind !== "foc" || group.cutoffDate >= today));
}
function resolveShopCollection(snapshot, pathname, config = {}, collections = null) {
  const path = `${String(pathname).replace(/\/+$/, "")}/`;
  const index = collections || shopCollectionIndex(snapshot, config);
  const direct = index.find(group => group.path === path);
  if (direct) return { group: direct, path };
  const alias = path.match(/^\/collections\/foc-(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})(?:-[a-z0-9-]+)?\/$/i);
  if (alias) {
    const year = alias[3].length === 2 ? `20${alias[3]}` : alias[3];
    const canonical = `/shop/foc/${year}-${alias[1].padStart(2,"0")}-${alias[2].padStart(2,"0")}/`;
    return { path: canonical, group: index.find(group => group.path === canonical) || null };
  }
  const known = [...config.routes || [], ...(snapshot?.collectionRoutePaths || []).map(path=>({path}))].some(route => `${route.path.replace(/\/+$/, "")}/` === path);
  if (known || /^\/(?:shop\/foc\/|categories\/|collections\/)/i.test(path)) return { path, group: null };
  return null;
}
const { serveManagedShopCollection, commerceRoutes, addCommerceNavigation,
      addCommerceRoutesToManifest, addCommerceRoutesToSitemap } = (function createShopCollectionRuntime({
  config: SHOP_COLLECTION_CONFIG, readCommerceSnapshot, escapeStoreHtml, commercePage, shopMenuGroups,
  projectShopCatalog, shopCollectionIndex, shopMenuFilter, resolveShopCollection, legacycommerceRoutes,
  legacyaddCommerceNavigation, legacyaddCommerceRoutesToManifest, legacyaddCommerceRoutesToSitemap, storeBannerColorRules,
  shopTheme = null, renderProductCardList = null
}) {
  // A page's menus and links count the shop's products many times over; each count is worked out once per published
  // shop. readCommerceSnapshot hands back the same object for a few seconds, so this lasts that long and no longer.
  const memo = new WeakMap();
  const remembered = (snapshot, key, make) => {
    let entry = memo.get(snapshot);
    if (!entry) memo.set(snapshot, entry = new Map());
    if (!entry.has(key)) entry.set(key, make());
    return entry.get(key);
  };
  const totalOf = (snapshot, params) => remembered(snapshot, "total " + params.toString(), () => projectShopCatalog(snapshot, params).pagination?.total);
  const indexOf = snapshot => remembered(snapshot, "index", () => shopCollectionIndex(snapshot, SHOP_COLLECTION_CONFIG));
  async function serveManagedShopCollection(request, env) {
    const url = new URL(request.url);
    const snapshot = await readCommerceSnapshot(env);
    // The source store's search address searches the product module. With nothing asked yet, a copied search page
    // (TheGlamourAddict's "Search our site", Nov 23 2026) is served as it was: its form asks this address again.
    if (snapshot?.enabled && ["/search", "/search/"].includes(url.pathname)) {
      const query = url.searchParams.get("q");
      if (!query && env?.ASSETS && (await env.ASSETS.fetch(new Request(new URL("/search/", url)))).ok) return null;
      return Response.redirect(new URL("/shop/" + (query ? "?" + new URLSearchParams([["q", query]]) : ""), url), 301);
    }
    if (snapshot?.enabled && ["/collections", "/collections/", "/collections/all", "/collections/all/"].includes(url.pathname)) return Response.redirect(new URL("/shop/"+url.search,url),301);
    const match = resolveShopCollection(snapshot, url.pathname, SHOP_COLLECTION_CONFIG, snapshot ? indexOf(snapshot) : undefined);
    if (!match) return null;
    if (!snapshot?.enabled || !match.group) {
      // A page the website itself publishes at this address is served, not hidden behind an empty store category.
      const own = env?.ASSETS ? await env.ASSETS.fetch(new Request(new URL(match.path, url))) : null;
      if (own?.ok) return null;
      return new Response("Collection not found", {status:404,headers:{"cache-control":"no-store"}});
    }
    if (url.pathname !== match.path) return Response.redirect(new URL(match.path + url.search,url),301);
    const group = match.group;
    // A copied collection page whose store list is this collection keeps the source's page around it (heading, words,
    // layout); the generic page is for a collection the website has no page of its own for. TheGlamourAddict's
    // /collections/frontpage/ and /collections/glamour-reloved/ (Nov 23 2026) were otherwise replaced by it.
    if (group.kind === "category" && env?.ASSETS) {
      const own = await env.ASSETS.fetch(new Request(new URL(match.path, url)));
      if (own.ok && String(own.headers.get("content-type") || "").includes("text/html")
        && (await own.text()).includes('data-ww-product-category="'+escapeStoreHtml(group.categoryPath)+'"')) return null;
    }
    // A category's page lists it in the order the site it was copied from did (a Shopify collection's own order, kept as
    // each product's place in it, TheGlamourAddict Nov 23 2026); a category the owner made has none, so it lists by name.
    const attributes = group.kind === "foc" ? 'data-ww-product-category="*" data-ww-product-cutoff="'+escapeStoreHtml(group.cutoffDate)+'"'
      : 'data-ww-product-category="'+escapeStoreHtml(group.categoryPath)+'" data-ww-product-order="source"';
    // A copied shop's own cards (product-card-runtime.mjs) draw the list here too, as on its copied collection pages:
    // no count the source never printed, the store's search and sort only where its lists had their own, and as many
    // products a page as its pages showed (TheGlamourAddict's theme: 18, Nov 24 2026).
    const mode = storeMode(snapshot.storeDisplay);
    const theme = shopTheme?.cards && renderProductCardList && !storeCardLayout(snapshot.storeDisplay).cards && mode !== "gallery" ? shopTheme.cards : null;
    const pageSize = Math.floor(Number(theme?.pageSize)) > 0 ? Math.min(Math.floor(Number(theme.pageSize)), 48) : 0;
    const params = new URLSearchParams(url.search);params.set("view","list");params.set("pageSize",String(pageSize || 24));
    params.set("category",group.kind === "category" ? group.categoryPath : "*");
    if(group.kind === "category")params.set("order","source");
    if(group.kind === "foc")params.set("cutoffDate",group.cutoffDate);
    const listing = projectShopCatalog(snapshot,params);
    // A gallery's products have no pages of their own: its cards are the photo, the name and the description.
    const cards = [...listing.products || [], ...listing.sourceProducts || []].map(product => {
      const image = product.imageUrl || product.catalog?.images?.[0]?.url;
      const title = escapeStoreHtml(product.title);
      const path = escapeStoreHtml(product.sourcePath || "/shop/");
      const picture = image ? '<img class="ww-store-image" src="'+escapeStoreHtml(image)+'" alt="'+title+'" loading="lazy">' : '';
      if (mode === "gallery") return '<article class="ww-store-card">'+picture+'<h2>'+title+'</h2>'+(product.summary ? '<p class="ww-store-summary">'+escapeStoreHtml(product.summary)+'</p>' : '')+'</article>';
      let price = ""; try { if (product.priceAmount != null) price = new Intl.NumberFormat("en",{style:"currency",currency:product.currency}).format(product.priceAmount / 10 ** new Intl.NumberFormat("en",{style:"currency",currency:product.currency}).resolvedOptions().maximumFractionDigits); } catch {}
      return '<article class="ww-store-card"><a href="'+path+'">'+picture+'<h2>'+title+'</h2></a>'+(price ? '<p>'+escapeStoreHtml(price)+'</p>' : '')+'</article>';
    }).join("");
    const modeAttribute = mode === "shop" ? "" : ' data-ww-store-mode="'+mode+'"';
    const rows = [...listing.sourceProducts || [], ...listing.products || []];
    const themed = theme && rows.length ? renderProductCardList(theme, rows.map(row => [row]), { mode }) : "";
    if (themed) return commercePage(group.title, '<section class="ww-product-section"><h1>'+escapeStoreHtml(group.title)+'</h1><div data-ww-behavior="commerce-store" data-ww-product-list data-ww-product-cards'+(theme.controls ? ' data-ww-product-controls' : '')+(pageSize ? ' data-ww-product-page-size="'+pageSize+'"' : '')+' '+attributes+modeAttribute+' aria-live="polite">'+themed+'</div></section>',env,url);
    return commercePage(group.title, '<section class="ww-product-section"><h1>'+escapeStoreHtml(group.title)+'</h1><p>'+listing.pagination.total+(listing.pagination.total === 1 ? ' product' : ' products')+'</p><div data-ww-behavior="commerce-store" data-ww-product-list '+attributes+modeAttribute+' aria-live="polite"><div class="ww-store-grid">'+cards+'</div></div></section>',env,url);
  }

  async function rewriteShopCollectionLinks(response, env) {
    if (!response.ok || !String(response.headers.get("content-type") || "").includes("text/html") || typeof HTMLRewriter === "undefined") return response;
    const snapshot = await readCommerceSnapshot(env);
    if (!snapshot?.enabled) return response;
    const index = indexOf(snapshot);
    const resolve = path => resolveShopCollection(snapshot,path,SHOP_COLLECTION_CONFIG,index);
    const now = Date.now();
    const banners = (snapshot.storeBanners || []).map((banner,position)=>({...banner,position})).filter(banner=>banner.enabled && (!banner.startsAt || Date.parse(banner.startsAt)<=now) && (!banner.endsAt || Date.parse(banner.endsAt)>now)).slice(0,4);
    const bannerMarkup = banners.length ? '<aside class="ww-store-announcements" aria-label="Store announcements">'+banners.map(banner=>'<div class="ww-store-announcement" data-ww-banner-index="'+banner.position+'" data-tone="'+escapeStoreHtml(banner.tone)+'"><span>'+escapeStoreHtml(banner.message)+'</span>'+(banner.href?'<a href="'+escapeStoreHtml(banner.href)+'">'+escapeStoreHtml(banner.linkLabel || 'Learn more')+'</a>':'')+'</div>').join('')+'</aside>' : '';
    // Each banner's own colours, kept readable: one saved before colours were checked is corrected here.
    const bannerColors = storeBannerColorRules(banners);
    let headerFound = false, contentStarted = false, headerEnded = false, bannersAfterBars = false;
    let hasMenu = false, storeNavigation = false;
    const STORE_PATH = /^\/(?:shop|collections|categories|products)(?:\/|$)/;
    const menuItems = (kind, filter = "", suffix = "") => shopMenuGroups(index, kind, SHOP_COLLECTION_CONFIG.timeZone || snapshot.collectionTimeZone || "UTC").filter(group => {
      if (!filter) return true;
      const params = new URLSearchParams(filter);params.set("view","list");params.set("pageSize","1");
      params.set("category",group.kind === "category" ? group.categoryPath : "*");
      if(group.kind === "foc")params.set("cutoffDate",group.cutoffDate);
      return totalOf(snapshot,params) > 0;
    }).map(group=>'<li><a class="nav-link" href="'+escapeStoreHtml(group.path+(filter?"?"+filter:""))+'">'+escapeStoreHtml(group.title+suffix)+'</a></li>').join("");
    const menu = kind => { const items = menuItems(kind); return items ? '<li class="nav-folder" data-ww-shop-collection-menu="'+kind+'"><details name="ww-nav-folders"><summary class="nav-link">'+(kind === "foc" ? "Preorders by FOC date" : "Shop categories")+'</summary><ul class="nav-submenu">'+items+'</ul></details></li>' : ""; };
    const rewritten = new HTMLRewriter()
      .on("head",{element(element){if(banners.length)element.append('<style>.ww-store-announcements{display:grid;position:relative;z-index:2}.ww-store-announcement{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:.5rem 1rem;padding:.7rem 1.25rem;text-align:center;background:#213e52;color:#fff;font-size:.95rem;line-height:1.5}.ww-store-announcement[data-tone="neutral"]{background:#eef2f4;color:#243542}.ww-store-announcement[data-tone="warm"]{background:#f2e4c8;color:#41331d}.ww-store-announcement a{color:inherit;font-weight:600;text-decoration:underline;text-underline-offset:.2em}'+bannerColors+'</style>',{html:true});}})
      .on("main,article",{element(){contentStarted=true;}})
      .on("header",{element(element){if(headerFound || contentStarted)return;headerFound=true;if(element.hasAttribute("data-ww-source-header"))storeNavigation=true;
        // A source header's own bars come first; announcements follow them, as on the source.
        bannersAfterBars=element.hasAttribute("data-ww-bands-after");
        element.onEndTag(end=>{headerEnded=true;if(bannerMarkup&&!bannersAfterBars)end.after(bannerMarkup,{html:true});});}})
      .on("aside.ww-sh-bands",{element(element){if(!headerEnded||!bannersAfterBars||!bannerMarkup)return;bannersAfterBars=false;element.onEndTag(end=>end.after(bannerMarkup,{html:true}));}})
      // A header that already reaches the catalog keeps its own menu: generic
      // menus are only offered where the source had no store navigation.
      .on("header a[href]",{element(element){try{if(STORE_PATH.test(new URL(element.getAttribute("href"),"https://store.invalid").pathname))storeNavigation=true;}catch{}}})
      .on("header ul#primary-nav, header ul.nav-list", {element(element) { element.onEndTag(end=>{if (!hasMenu && !storeNavigation) {hasMenu=true;end.before(menu("foc") + menu("category"),{html:true});}}); }}).on("[data-ww-shop-collection-menu]", { element(element) {
      hasMenu = true;
      // HTMLRewriter returns attribute values with their entities still encoded.
      const attribute = name => String(element.getAttribute(name) || "").replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, entity) => ({amp:"&",lt:"<",gt:">",quot:'"',"#39":"'","#x27":"'"})[entity]);
      const kind = attribute("data-ww-shop-collection-menu");
      const samples = attribute("data-ww-menu-samples"), contrast = attribute("data-ww-menu-contrast");
      const filter = remembered(snapshot, "filter " + samples + "\n" + contrast, () => shopMenuFilter(snapshot, samples.split(/\s+/).filter(Boolean), contrast.split(/\s+/).filter(Boolean)));
      const items = menuItems(kind, filter, attribute("data-ww-menu-item-suffix"));
      if (!items) { element.remove(); return; }
      const label = attribute("data-ww-menu-label") || (kind === "foc" ? "Preorders by FOC date" : "Shop categories");
      element.setInnerContent('<details name="ww-nav-folders"><summary class="nav-link">'+escapeStoreHtml(label)+'</summary><ul class="nav-submenu">'+items+'</ul></details>',{html:true});
    }}).on("[data-ww-collection-path]",{element(element){const match=resolve(element.getAttribute("data-ww-collection-path"));if(match&&!match.group)element.remove();}})
      .on("a[href]",{element(element){const path=element.getAttribute("href");if(!/^\/(?!\/)/.test(path))return;let url;try{url=new URL(path,"https://store.invalid");}catch{return;}const match=resolve(url.pathname);
        if(url.search && (match?.group || ["/shop/","/shop","/collections/all/"].includes(url.pathname))){
          const params = new URLSearchParams(url.search);params.set("view","list");params.set("pageSize","1");
          if(match?.group?.kind === "category")params.set("category",match.group.categoryPath);
          if(match?.group?.kind === "foc")params.set("cutoffDate",match.group.cutoffDate);
          const total=totalOf(snapshot,params);
          if(total===0){element.remove();return;}
        }
        if(["/collections/all/","/collections/all","/collections/","/collections"].includes(url.pathname)){element.setAttribute("href","/shop/"+url.search);return;}
        if(!match)return;if(!match.group)element.remove();else element.setAttribute("href",match.path+url.search+url.hash);}}).transform(response);
    const result = new Response(rewritten.body, rewritten);
    result.headers.set("cache-control", "no-store");
    return result;
  }

  async function commerceRoutes(env) {
    const routes = await legacycommerceRoutes(env);
    const snapshot = await readCommerceSnapshot(env);
    const collections = (snapshot ? indexOf(snapshot) : shopCollectionIndex(snapshot, SHOP_COLLECTION_CONFIG)).map(group => ({path:group.path,name:group.title,purpose:"Managed shop collection"}));
    return [...new Map([...routes, ...collections].map(route => [route.path,route])).values()];
  }
  async function addCommerceNavigation(response, env) {
    return legacyaddCommerceNavigation(await rewriteShopCollectionLinks(response, env), env);
  }
  async function addCommerceRoutesToManifest(response, env) {
    const updated = await legacyaddCommerceRoutesToManifest(response, env);
    if (!updated.ok) return updated;
    const snapshot = await readCommerceSnapshot(env);
    if (!snapshot?.enabled) return updated;
    const manifest = await updated.json();
    const index = shopCollectionIndex(snapshot, SHOP_COLLECTION_CONFIG);
    manifest.routes = (manifest.routes || []).filter(route => {
      const match = resolveShopCollection(snapshot,route.path,SHOP_COLLECTION_CONFIG,index);
      return !match || (match.group && match.path === route.path);
    });
    return Response.json(manifest, {headers:updated.headers});
  }
  async function addCommerceRoutesToSitemap(body, env, origin) {
    const updated = await legacyaddCommerceRoutesToSitemap(body,env,origin);
    const snapshot = await readCommerceSnapshot(env);
    if (!snapshot?.enabled) return updated;
    const index = shopCollectionIndex(snapshot, SHOP_COLLECTION_CONFIG);
    return String(updated).replace(/<url>\s*<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/g, (entry,loc) => {
      try {
        const path = new URL(loc,origin).pathname;
        const match = resolveShopCollection(snapshot,path,SHOP_COLLECTION_CONFIG,index);
        return match && (!match.group || match.path !== path) ? "" : entry;
      } catch { return entry; }
    });
  }

  return {serveManagedShopCollection, commerceRoutes, addCommerceNavigation,
    addCommerceRoutesToManifest, addCommerceRoutesToSitemap};
})({
      config: SHOP_COLLECTION_CONFIG, readCommerceSnapshot, escapeStoreHtml, commercePage, shopMenuGroups,
      projectShopCatalog, shopCollectionIndex, shopMenuFilter, resolveShopCollection, legacycommerceRoutes,
      legacyaddCommerceNavigation, legacyaddCommerceRoutesToManifest, legacyaddCommerceRoutesToSitemap, storeBannerColorRules,
      shopTheme: typeof STORE_SHOP_THEME === "undefined" ? null : STORE_SHOP_THEME,
      renderProductCardList: typeof renderProductCardList === "function" ? renderProductCardList : null
    });
// END MANAGED SHOP COLLECTIONS
