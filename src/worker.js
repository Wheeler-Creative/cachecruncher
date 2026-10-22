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
const COMMERCE_PRODUCT_PATHS = [];
const PENDING_COLLECTION_SOURCES = {};
const SUBSCRIBERS_CONFIGURED = false;
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
// IndexNow: the search engines fetch this file to confirm the submitter controls the host (src/indexnow.js).
const INDEXNOW_KEY = "4191c1807a314d0eb0f11091ad2ac0c4";
const CONTACT_SITE_LABEL = "CacheCruncher";
const CONTACT_RATE_SALT = "3ede3976d99d2c3df76ceecec0b06ffa78073b193cb19f77bcd6ddc2869bd370";
// Permanent redirects from the URLs this site used before it was rebuilt. These
// are donor bookmarks, links in grant applications and search rankings; cleaning
// a URL without redirecting the old one is a 404 with better spelling.
const REDIRECTS = {};
const MAX_WIDTH = 2000;
// Bump to abandon everything cached under the old behaviour.
//
// Responses here are cached "immutable" for a year, so a fix to how an image
// is produced does not reach anyone already holding the old one - a photo that
// was being re-encoded to 3.4MB kept being served at 3.4MB from whichever edge
// had it. The version is part of the cache key, not the URL the page asks for,
// so nothing in the site's markup has to change.
const CACHE_VERSION = "2";
const FORMATS = { webp: "image/webp", avif: "image/avif", jpeg: "image/jpeg", png: "image/png" };

// The managed forms' bot check (scripts/form-check-rewriter.js): reCAPTCHA, Turnstile or none, read from secrets.
async function managedFormCheck(body, env, request, action) {
  const check = await verifyFormCheck(takeFormCheckToken(body), env, request, action);
  return check?.status ? check : null;
}

// The footer signup band is drawn by the content layer after the page's forms were given their check, so it asks here.
function signupFormCheck(env, language) {
  const settings = formCheckSettings(env);
  return settings && !settings.incomplete ? formCheckFields(settings, "subscribe", language) + formCheckLoader(settings) : "";
}

function imageCacheKey(request, url) {
  const key = new URL(url.toString());
  key.searchParams.set("__v", CACHE_VERSION);
  return new Request(key.toString(), { method: "GET", headers: request.headers });
}

async function serveImage(request, env, ctx, url) {
  const cache = caches.default;
  const cacheKey = imageCacheKey(request, url);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.MEDIA) return new Response("Not found", { status: 404 });
  const key = MEDIA_PREFIX + decodeURIComponent(url.pathname.slice("/images/".length));
  const object = await env.MEDIA.get(key);
  // Not in media: a photo committed under public/images/ is still this site's to serve.
  if (!object) return url.pathname === new URL(request.url).pathname ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });

  const width = Math.min(Math.max(parseInt(url.searchParams.get("w") || "0", 10) || 0, 0), MAX_WIDTH);
  // Asked for by a picture that can afford it, such as a page backdrop. Out of range is the resizer's own default.
  const asked = parseInt(url.searchParams.get("q") || "0", 10) || 0;
  const quality = asked >= 40 && asked <= 90 ? asked : 0;
  const requestedFormat = (url.searchParams.get("format") || "").toLowerCase();
  const format = FORMATS[requestedFormat] || "image/webp";

  let response;
  try {
    // Uploads are already normalized for the web. The ordinary /images/name
    // path serves those bytes directly; Images runs only for an explicit size
    // or format variant, avoiding a transformation and decode on every photo.
    if (!width && !requestedFormat) {
      const headers = new Headers({ "cache-control": "public, max-age=31536000, immutable" });
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      response = new Response(object.body, { headers });
    } else {
      if (!env.IMAGES) throw new Error("no images binding");
      let pipeline = env.IMAGES.input(object.body);
      if (width) pipeline = pipeline.transform({ width });
      const result = await pipeline.output(quality ? { format, quality } : { format });
      response = result.response();
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

let commerceSnapshotCache = { checkedAt: 0, value: null };
async function readCommerceSnapshot(env) {
  if (commerceSnapshotCache.checkedAt > Date.now() - 1000) return commerceSnapshotCache.value ? projectShopCatalog(commerceSnapshotCache.value, new URLSearchParams()) : null;
  if (!env.MEDIA) return null;
  const object = await env.MEDIA.get(PRODUCTS_JSON_KEY);
  if (!object) {
    commerceSnapshotCache = { checkedAt: Date.now(), value: null };
    return null;
  }
  try {
    commerceSnapshotCache = { checkedAt: Date.now(), value: JSON.parse(await object.text()) };
  } catch { commerceSnapshotCache = { checkedAt: Date.now(), value: null }; }
  return commerceSnapshotCache.value ? projectShopCatalog(commerceSnapshotCache.value, new URLSearchParams()) : null;
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
    showCart: saved.showCart !== false, cartLabel: String(saved.cartLabel || "Cart"), groups,
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

function storeSubmenuMarkup(settings) {
  if (!settings.groups.length && !settings.orderHistory) return "";
  const lists = settings.groups.map((group) => '<li class="ww-store-submenu-group">'
    + (group.title ? '<span class="ww-store-submenu-title">' + escapeStoreHtml(group.title) + '</span>' : "")
    + '<ul>' + group.items.map((item) => '<li><a href="' + escapeStoreHtml(item.href) + '">' + escapeStoreHtml(item.label) + '</a></li>').join("") + '</ul></li>').join("");
  const history = settings.orderHistory ? '<li><a class="ww-store-submenu-orders" href="/orders/" data-ww-order-history-link>Order history</a></li>' : "";
  return '<button type="button" class="ww-store-toggle" aria-expanded="false" aria-label="' + escapeStoreHtml("More in " + settings.label) + '"><span aria-hidden="true"></span></button>'
    + '<ul class="ww-store-submenu"><li><a class="ww-store-submenu-all" href="/shop/">' + escapeStoreHtml(settings.allLabel) + '</a></li>' + lists + history + '</ul>';
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
      } else if (configured && cart) {
        if (!settings.showCart) element.replace('<span hidden data-ww-store-hidden></span>', { html: true });
        else if (classes.includes(" ww-cart-nav ") && !classes.includes(" ww-sh-icon ")) element.setInnerContent(cartLinkContent(settings.cartLabel), { html: true });
      }
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
  const routes = new Map([["/shop/", { path: "/shop/", name: "Store" }],
    ["/checkout/", { path: "/checkout/", name: "Checkout" }]]);
  for (const product of [...(snapshot?.sourceProducts || []), ...(snapshot?.products || [])]) {
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
  if (storeRoutes.length && !routes.has("/cart/")) {
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
  const routes = [...storeRoutes, ...(storeRoutes.length ? [{ path: "/cart/", name: "Cart" }] : []),
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
  for (const [key, value] of params) if (key.startsWith("attr.")) rows = rows.filter((row) => [].concat(attributesOf(row)[key.slice(5)] || []).map(String).includes(value));
  const groups = new Map();
  for (const row of rows) {
    const key = row.sourceKey || row.id;
    const group = groups.get(key) || []; group.push(row); groups.set(key, group);
  }
  let entries = [...groups.values()];
  const amount = (group) => Math.min(...group.filter((row) => row.priceAmount != null && Number.isFinite(Number(row.priceAmount))).map((row) => Number(row.priceAmount)));
  const sort = params.get("sort");
  entries.sort((a, b) => {
    if (!["price-asc", "price-desc"].includes(sort)) return String(a[0].title).localeCompare(String(b[0].title));
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
      title: row.title, imageUrl: row.imageUrl || row.catalog?.images?.[0]?.url,
      ...(layout.parts.includes("summary") && row.description ? { summary: (() => {
        const text = String(row.description).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        return text.length > 160 ? text.slice(0, 160).replace(/\s+\S*$/, "") + "…" : text;
      })() } : {}),
      priceAmount: amounts.length ? Math.min(...amounts) : null,
      ...(layout.details.length ? { details: Object.fromEntries(layout.details.map((name) => [name, [].concat(attributesOf(row)[name] ?? []).map(String).filter(Boolean)]).filter(([, values]) => values.length)) } : {}),
      priceHighAmount: amounts.length ? Math.max(...amounts) : null,
      regularPriceAmount: row.regularPriceAmount, onSale: displayed.some(variant => variant.onSale),
      catalog: { saleType: row.catalog?.saleType, orderCutoffAt: row.catalog?.orderCutoffAt, orderCutoffTimeZone: row.catalog?.orderCutoffTimeZone,
        releaseAt: row.catalog?.releaseAt, releaseDate: row.catalog?.releaseDate },
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

async function serveCommerceSnapshot(request, env) {
  const params = new URL(request.url).searchParams;
  if (["list", "detail", "cart"].includes(params.get("view"))) {
    const snapshot = await readCommerceSnapshot(env);
    return Response.json(projectShopCatalog(snapshot || { enabled: false, siteId: CONTACT_SITE_ID }, params), { headers: { "cache-control": "no-store" } });
  }
  const snapshot = await readCommerceSnapshot(env);
  return Response.json(projectShopCatalog(snapshot || { enabled: false, siteId: CONTACT_SITE_ID }, params), { headers: { "cache-control": "no-store" } });
}

function escapeStoreHtml(value) {
  const entities = { 34: "&quot;", 39: "&#39;", 38: "&amp;", 60: "&lt;", 62: "&gt;" };
  return String(value || "").replace(/[&<>"']/g, (character) => entities[character.charCodeAt(0)]);
}

async function commercePage(title, main, env, url, description = "") {
  if (env.ASSETS) {
    const homepage = await env.ASSETS.fetch(new Request(new URL("/", url.origin)));
    if (homepage.ok && String(homepage.headers.get("content-type") || "").includes("text/html")) {
      if (typeof HTMLRewriter === "undefined") {
        const html = (await homepage.text())
          .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, "<title>" + escapeStoreHtml(title + " | " + STORE_SITE_NAME) + "</title>")
          .replace(/<main\b([^>]*)>[\s\S]*?<\/main>/i, (_, attributes) => "<main" + attributes + ">" + main + "</main>");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "Link": "<" + url.origin + url.pathname + ">; rel=canonical" } });
      }
      // Store pages are run by the shared behaviour runtime, whether or not the site's other pages load it.
      let sharedRuntime = false;
      const composed = new HTMLRewriter()
        .on("title", { element(element) { element.setInnerContent(String(title) + " | " + STORE_SITE_NAME); } })
        .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", url.origin + url.pathname); } })
        .on('meta[name="description"]', { element(element) { element.setAttribute("content", String(description || title).slice(0, 300)); } })
        .on("main", { element(element) { element.setAttribute("class", (element.getAttribute("class") || "") + " ww-commerce-main"); element.setInnerContent(main, { html: true }); } })
        .on('script[src="/app.js"]', { element() { sharedRuntime = true; } })
        .on("body", { element(element) { element.onEndTag((end) => { if (!sharedRuntime) end.before('<script src="/app.js" defer></script>', { html: true }); }); } })
        .transform(homepage);
      const commerceNavigation = await addCommerceNavigation(composed, env);
      const navigated = typeof addOrderHistoryNavigation === "function" ? await addOrderHistoryNavigation(commerceNavigation, env) : commerceNavigation;
      const response = new Response(navigated.body, navigated);
      response.headers.set("cache-control", "no-store");
      response.headers.append("Link", "<" + url.origin + url.pathname + ">; rel=canonical");
      return withManagedFormCheck(response, env);
    }
  }
  return new Response("The shared site layout is temporarily unavailable.", { status: 503, headers: { "retry-after": "5" } });
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
  const snapshot = await readCommerceSnapshot(env);
  const route = pathname.endsWith("/") ? pathname : pathname + "/";
  const products = [...(snapshot?.sourceProducts || []), ...(snapshot?.products || [])];
  const product = products.find((entry) => {
    const sourcePath = String(entry.sourcePath || "");
    return sourcePath && (sourcePath.endsWith("/") ? sourcePath : sourcePath + "/") === route;
  });
  if (!product) return new Response("Product not found", { status: 404 });
  const image = product.imageUrl || product.catalog?.images?.[0]?.url || "";
  const available = product.active && product.purchasable;
  const status = product.orderingClosed ? "Pre-orders closed" : available
    ? product.catalog?.saleType === "preorder" ? "Available to pre-order" : "Available"
    : "Not currently available to order";
  const schema = { "@context": "https://schema.org", "@type": "Product", name: product.title,
    description: product.description || "", sku: product.sku || undefined,
    image: [...new Set([product.imageIsDefault ? "" : image, ...(product.catalog?.images || []).map((entry) => entry.url)].filter(Boolean))].map((value) => new URL(value, request.url).href),
    ...(product.priceAmount != null ? { offers: { "@type": "Offer", url: new URL(request.url).origin + route,
      priceCurrency: product.currency,
      price: product.priceAmount / (10 ** new Intl.NumberFormat("en", { style: "currency", currency: product.currency }).resolvedOptions().maximumFractionDigits),
      availability: "https://schema.org/" + (available ? product.catalog?.saleType === "preorder" ? "PreOrder" : "InStock" : "OutOfStock") } } : {}) };
  const publicationLabels = { publisher: "Publisher", format: "Format", writer: "Writer", artist: "Artist", coverArtist: "Cover artist", series: "Series", issueNumber: "Issue / volume", rating: "Rating", variantDescription: "Cover variant", numberOfPages: "Pages" };
  const specs = product.catalog?.specs || [];
  const publicationMarkup = specs.length ? '<dl class="ww-store-publication ww-store-specs">' + specs.map((spec) => '<dt>' + escapeStoreHtml(spec.label) + '</dt><dd>' + escapeStoreHtml(spec.value) + '</dd>').join("") + '</dl>'
    : product.catalog?.showPublicationFacts ? '<dl class="ww-store-publication">' + Object.entries(publicationLabels)
    .filter(([key]) => product.catalog.publication?.[key]).map(([key, label]) => '<dt>' + label + '</dt><dd>' + escapeStoreHtml(product.catalog.publication[key]) + '</dd>').join("") + '</dl>' : "";
  const main = '<article class="ww-product-detail" data-ww-behavior="commerce-store" data-ww-product-detail data-ww-detail-layout="' + productImageLayout(product.catalog, snapshot.storeDisplay) + '">'
    + '<h1>' + escapeStoreHtml(product.title) + '</h1>' + storePriceMarkup([product]) + '<p class="ww-store-description">' + escapeStoreHtml(product.description) + '</p>'
    + (image ? '<img class="ww-store-image" src="' + escapeStoreHtml(image) + '" alt="' + escapeStoreHtml(product.title) + '" loading="eager">' : '')
    + (product.catalog?.releaseAt ? '<p>Expected release: <time datetime="' + escapeStoreHtml(product.catalog.releaseAt) + '">' + escapeStoreHtml(product.catalog.releaseDate || product.catalog.releaseAt.slice(0, 10)) + '</time></p>' : '')
    + publicationMarkup + '<p role="status" aria-live="polite">' + status + '</p></article>' + storePolicyLinks(snapshot)
    + '<script type="application/ld+json">' + JSON.stringify(schema).replace(/</g, "\\u003c") + '</script>';
  return commercePage(product.title || "Product", main, env, new URL(request.url), product.description);
}

// Links to the shop's written policies, drawn into the page itself so they show before any script runs.
function storePolicyLinks(snapshot) {
  const pages = Array.isArray(snapshot?.storePolicies) ? snapshot.storePolicies : [];
  if (!pages.length) return "";
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
  const main = '<section class="ww-cart" data-ww-behavior="commerce-store" data-ww-cart>'
    + '<h1>Your cart</h1><p role="status" aria-live="polite">Loading cart…</p></section>' + storePolicyLinks(snapshot);
  return commercePage("Your cart", main, env, url);
}

async function serveCommerceShop(env, url) {
  const snapshot = await readCommerceSnapshot(env);
  if (!snapshot?.enabled) return new Response("Store not found", { status: 404 });
  const params = new URLSearchParams(url.search); params.set("view", "list");
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
  const display = snapshot.storeDisplay || {};
  const ratio = STORE_PHOTO_RATIOS[display.photoShape];
  const cardStyle = storeCardLayout(display).cards;
  const columns = [2, 3, 4, 5, 6].includes(display.columns) ? display.columns : 0;
  const style = (columns ? '--ww-store-columns:' + columns + ';--ww-store-columns-md:' + Math.min(columns, 3) + ';' : "")
    + (ratio ? '--ww-store-ratio:' + ratio + ';' : "") + '--ww-store-fit:' + (display.photoFit === "fill" ? "cover" : "contain");
  const look = ' data-ww-store-display data-ww-store-fit' + (display.photoShape === "natural" ? ' data-ww-store-natural' : "") + (cardStyle ? ' data-ww-store-cards="' + cardStyle + '"' : "")
    + (columns ? ' data-ww-product-columns="' + columns + '"' : "")
    + (ratio ? ' data-ww-product-image-ratio="' + ratio + '"' : "") + ' style="' + style + '"';
  const main = '<section class="ww-shop" data-ww-behavior="commerce-store" data-ww-product-list data-ww-product-category="' + escapeStoreHtml(url.searchParams.get("category") || "*") + '"' + look
    + (url.searchParams.get("cutoffDate") ? ' data-ww-product-cutoff="' + escapeStoreHtml(url.searchParams.get("cutoffDate")) + '"' : "") + '>'
    + '<h1>' + escapeStoreHtml(settings.label) + '</h1>' + filterNote + (cards ? '<div class="ww-store-grid">' + cards + '</div>' + pagination
      : '<p class="ww-store-empty">Products will appear here when they are available.</p>') + '</section>';
  return commercePage(settings.label, main, env, url);
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
  const buyable = rows.some((row) => row.active && row.purchasable);
  if (cards === "photo") return '<article class="ww-store-card">'
    + '<a class="ww-store-image-link" href="' + href + '" aria-label="' + title + '" title="' + title + '">'
    + (image ? '<img class="ww-store-image" src="' + escapeStoreHtml(image) + '" alt="" loading="lazy">' : '<div class="ww-store-image-placeholder">Photo coming soon</div>')
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
    + (image ? '<img class="ww-store-image" src="' + escapeStoreHtml(image) + '" alt="' + title + '" loading="lazy">' : '<div class="ww-store-image-placeholder">Photo coming soon</div>')
    + '</a><h2 class="ww-store-title"><a href="' + href + '">' + title + '</a></h2>' + dateLine + detailLines + (!cards || parts.includes("price") ? storePriceMarkup(rows) : '')
    + (parts.includes("summary") && product.summary ? '<p class="ww-store-summary">' + escapeStoreHtml(product.summary) + '</p>' : '')
    + (buyable ? (owned ? '' : '<a class="ww-store-link" href="' + href + '">View details</a>') : '<p class="ww-store-status">' + (closed && parts.includes("dates") ? 'Pre-orders closed.' : 'Coming soon') + '</p>')
    + '</article>';
}

async function serveCommerceCheckout(env, url) {
  const snapshot = await readCommerceSnapshot(env);
  if (!snapshot?.enabled) return new Response("Store not found", { status: 404 });
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
      couponCode: typeof parsed.body.couponCode === "string" ? parsed.body.couponCode.slice(0, 40) : undefined
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

function consentSource(request) {
  const referer = request.headers.get("referer") || "managed signup form";
  try { const url = new URL(referer); return url.origin + url.pathname; } catch { return "managed signup form"; }
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
      consentSource: consentSource(request)
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
async function serveSiteIcon(env, size) {
  const settings = await siteIconSettings(env);
  if (settings && settings.mediaPath && env.MEDIA) {
    const key = MEDIA_PREFIX + String(settings.mediaPath).replace(/^\/+/, "");
    const object = await env.MEDIA.get(key);
    if (object) {
      try {
        if (!env.IMAGES) throw new Error("no images binding");
        const result = await env.IMAGES.input(object.body).transform({ width: size, height: size, fit: "cover" }).output({ format: "image/png" });
        const response = result.response();
        response.headers.set("cache-control", "public, max-age=3600");
        return response;
      } catch {
        const original = await env.MEDIA.get(key);
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
    if (url.pathname === "/api/store") {
      return request.method === "GET" ? serveCommerceSnapshot(request, env)
        : new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    }
    if (url.pathname === "/api/checkout") return handleStoreCheckout(request, env, url);
    if (url.pathname === "/api/checkout-coupon") return handleStoreCheckoutCoupon(request, env);
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
    if (!type.includes("text/html") || !response.ok) return response;
    const canonical = new Response(response.body, response);
    canonical.headers.append("Link", `<${url.origin}${url.pathname}>; rel="canonical"`);

    return canonical;
  }
};

// Every request passes the icon first (src/site-icon.js on the platform writes what it reads).
const siteHandler = withSiteIcon(siteRequestHandler);

// The owner's own content, resolved while the page streams.
//
// Wrapped around the handler rather than written into it, so this site and a
// site retrofitted afterwards resolve content through the same code. Anything
// that is not an HTML page passes straight through.
export default withSiteContent(siteHandler, {
  key: "site-content/b97ce281-ffaf-4808-b4d6-9778c1d2d95e.json",
  binding: "MEDIA",
  formCheck: signupFormCheck
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
  legacyaddCommerceNavigation, legacyaddCommerceRoutesToManifest, legacyaddCommerceRoutesToSitemap, storeBannerColorRules
}) {
  async function serveManagedShopCollection(request, env) {
    const url = new URL(request.url);
    const snapshot = await readCommerceSnapshot(env);
    // The source store's search address searches the product module.
    if (snapshot?.enabled && ["/search", "/search/"].includes(url.pathname)) {
      const query = url.searchParams.get("q");
      return Response.redirect(new URL("/shop/" + (query ? "?" + new URLSearchParams([["q", query]]) : ""), url), 301);
    }
    if (snapshot?.enabled && ["/collections", "/collections/", "/collections/all", "/collections/all/"].includes(url.pathname)) return Response.redirect(new URL("/shop/"+url.search,url),301);
    const match = resolveShopCollection(snapshot, url.pathname, SHOP_COLLECTION_CONFIG);
    if (!match) return null;
    if (!snapshot?.enabled || !match.group) {
      // A page the website itself publishes at this address is served, not hidden behind an empty store category.
      const own = env?.ASSETS ? await env.ASSETS.fetch(new Request(new URL(match.path, url))) : null;
      if (own?.ok) return null;
      return new Response("Collection not found", {status:404,headers:{"cache-control":"no-store"}});
    }
    if (url.pathname !== match.path) return Response.redirect(new URL(match.path + url.search,url),301);
    const group = match.group;
    const attributes = group.kind === "foc" ? 'data-ww-product-category="*" data-ww-product-cutoff="'+escapeStoreHtml(group.cutoffDate)+'"'
      : 'data-ww-product-category="'+escapeStoreHtml(group.categoryPath)+'"';
    const params = new URLSearchParams(url.search);params.set("view","list");params.set("pageSize","24");
    params.set("category",group.kind === "category" ? group.categoryPath : "*");
    if(group.kind === "foc")params.set("cutoffDate",group.cutoffDate);
    const listing = projectShopCatalog(snapshot,params);
    const cards = [...listing.products || [], ...listing.sourceProducts || []].map(product => {
      const image = product.imageUrl || product.catalog?.images?.[0]?.url;
      const title = escapeStoreHtml(product.title);
      const path = escapeStoreHtml(product.sourcePath || "/shop/");
      let price = ""; try { if (product.priceAmount != null) price = new Intl.NumberFormat("en",{style:"currency",currency:product.currency}).format(product.priceAmount / 10 ** new Intl.NumberFormat("en",{style:"currency",currency:product.currency}).resolvedOptions().maximumFractionDigits); } catch {}
      return '<article class="ww-store-card"><a href="'+path+'">'+(image ? '<img class="ww-store-image" src="'+escapeStoreHtml(image)+'" alt="'+title+'" loading="lazy">' : '')+'<h2>'+title+'</h2></a><p>'+escapeStoreHtml(price)+'</p></article>';
    }).join("");
    return commercePage(group.title, '<section class="ww-product-section"><h1>'+escapeStoreHtml(group.title)+'</h1><p>'+listing.pagination.total+' products</p><div data-ww-behavior="commerce-store" data-ww-product-list '+attributes+' aria-live="polite"><div class="ww-store-grid">'+cards+'</div></div></section>',env,url);
  }

  async function rewriteShopCollectionLinks(response, env) {
    if (!response.ok || !String(response.headers.get("content-type") || "").includes("text/html") || typeof HTMLRewriter === "undefined") return response;
    const snapshot = await readCommerceSnapshot(env);
    if (!snapshot?.enabled) return response;
    const index = shopCollectionIndex(snapshot, SHOP_COLLECTION_CONFIG);
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
      return projectShopCatalog(snapshot,params).pagination?.total > 0;
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
      const filter = shopMenuFilter(snapshot, attribute("data-ww-menu-samples").split(/\s+/).filter(Boolean), attribute("data-ww-menu-contrast").split(/\s+/).filter(Boolean));
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
          const total=projectShopCatalog(snapshot,params).pagination?.total;
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
    const collections = shopCollectionIndex(snapshot, SHOP_COLLECTION_CONFIG).map(group => ({path:group.path,name:group.title,purpose:"Managed shop collection"}));
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
      legacyaddCommerceNavigation, legacyaddCommerceRoutesToManifest, legacyaddCommerceRoutesToSitemap, storeBannerColorRules
    });
// END MANAGED SHOP COLLECTIONS
