// One layout for every site's media, shared by the migrator, the cleaner and
// the portal.
//
//   sites/<site id>/<name>.<ext>        images: the site's image folder, served
//                                       at /images/<name>, where owner uploads go
//   sites/<site id>/files/<name>.<ext>  fonts, stylesheets, documents, video
//   sites/<site id>/products/<name>     a shop's product pictures, served at
//                                       /images/products/<name>; they belong to
//                                       the products that show them, never the
//                                       photo library
//   sites/<site id>/<folder>/...        build internals (snapshots, blueprints,
//                                       raw source pages, meta) - never media
//
// Pure: runs in Node and in a Worker.

export const IMAGE_EXTENSIONS = new Set(["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
export const VIDEO_TYPES = Object.freeze({ m4v: "video/mp4", mov: "video/quicktime", mp4: "video/mp4", ogv: "video/ogg", webm: "video/webm" });
export const VIDEO_EXTENSIONS = new Set(Object.keys(VIDEO_TYPES));
// The two formats every current browser plays: the only ones the uploader takes, and the only ones a page is offered.
export const PLAYABLE_VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
export const FILES_FOLDER = "files/";
export const PRODUCT_FOLDER = "products/";
export const MEDIA_USAGE_KEY = "meta/media-usage.json";
// Imported product pictures were kept beside the site's own before the product folder existed.
const EARLIER_PRODUCT_PICTURE = /^shop-import-[0-9a-f]{16}-[0-9a-f]{16}\.(?:jpg|png|webp|gif)$/;

export function isProductPictureKey(relativeKey) {
  const key = String(relativeKey || "");
  if (!key || key.includes("..")) return false;
  return (key.startsWith(PRODUCT_FOLDER) && key.length > PRODUCT_FOLDER.length && !key.slice(PRODUCT_FOLDER.length).includes("/"))
    || EARLIER_PRODUCT_PICTURE.test(key);
}
// Below this an "image" is a tracking pixel or spacer, not something to manage.
export const MIN_LIBRARY_IMAGE_BYTES = 100;

const EXTENSION_FOR_TYPE = {
  "image/avif": "avif", "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png",
  "image/svg+xml": "svg", "image/webp": "webp", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
  "application/pdf": "pdf", "text/css": "css", "font/woff2": "woff2", "font/woff": "woff",
  "font/ttf": "ttf", "font/otf": "otf", "video/mp4": "mp4"
};

// Deterministic in Node and Workers alike (no crypto.subtle, which is async).
export function stableHash(value) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0")).slice(0, 10);
}

function slug(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
}

function decoded(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function typeOf(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

// Where a file at `sourcePath` belongs. `identity` makes the name unique and
// stable: the same source always lands on the same key, so copies resume.
export function centralMediaKey(sourcePath, identity, contentType = "") {
  const segments = decoded(String(sourcePath || "")).split("/").filter(Boolean);
  const base = segments.pop() || "";
  const dot = base.lastIndexOf(".");
  let extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (!/^[a-z0-9]{1,5}$/.test(extension)) extension = "";
  const stem = extension ? base.slice(0, dot) : base;
  const type = typeOf(contentType);
  // CDNs may serve JPEG bytes from a .heic URL. Name the copied browser
  // image by the delivered type so it is available to the builder.
  if (type.startsWith("image/") && EXTENSION_FOR_TYPE[type] && !IMAGE_EXTENSIONS.has(extension)) extension = EXTENSION_FOR_TYPE[type];
  if (!extension) extension = EXTENSION_FOR_TYPE[type] || "";
  // An SVG font is image/svg+xml but belongs with the other font files.
  const fontFolder = segments.some((segment) => /^(?:web)?fonts?$/i.test(segment));
  // No extension and no type: an image is by far the likeliest, and the
  // library still checks the stored content type before showing it.
  const image = !fontFolder && (extension ? IMAGE_EXTENSIONS.has(extension) : (!type || type.startsWith("image/")));
  const name = `${slug(stem) || (image ? "image" : "file")}-${stableHash(identity)}${extension ? `.${extension}` : ""}`;
  return image ? name : `${FILES_FOLDER}${name}`;
}

// The key a copied source URL is stored under. Every query variant is its own
// file, so it is part of the identity; the fragment is not.
export function centralKeyForUrl(value, contentType = "") {
  const url = new URL(value);
  url.hash = "";
  return centralMediaKey(url.pathname, url.href, contentType);
}

// The key an already-stored object moves to when a site is cleaned up.
export function centralKeyForObject(relativeKey, contentType = "") {
  return centralMediaKey(relativeKey, `object:${relativeKey}`, contentType);
}

export function isCentralKey(relativeKey) {
  const key = String(relativeKey || "").replace(/\/$/, "");
  if (!key || key.includes("..")) return false;
  if (!key.includes("/")) return true;
  return key.startsWith(FILES_FOLDER) && !key.slice(FILES_FOLDER.length).includes("/");
}

export function isImageObject(relativeKey, contentType = "", size = MIN_LIBRARY_IMAGE_BYTES) {
  if (Number(size) < MIN_LIBRARY_IMAGE_BYTES) return false;
  const type = typeOf(contentType);
  if (type.startsWith("image/")) return true;
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return false;
  const extension = String(relativeKey || "").split(".").pop().toLowerCase();
  return IMAGE_EXTENSIONS.has(extension);
}

export function isVideoObject(relativeKey, contentType = "") {
  const type = typeOf(contentType);
  if (type.startsWith("video/")) return true;
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return false;
  return VIDEO_EXTENSIONS.has(String(relativeKey || "").split(".").pop().toLowerCase());
}

// The type a browser needs to play it: a copied video can be stored as plain bytes.
export function videoContentType(relativeKey, contentType = "") {
  const type = typeOf(contentType);
  if (type.startsWith("video/")) return type;
  return VIDEO_TYPES[String(relativeKey || "").split(".").pop().toLowerCase()] || "video/mp4";
}

// A video every browser plays, judged by the type it would be served with. A
// copied MOV or OGV is a video object, but not one a page can be given.
export function isPlayableVideoObject(relativeKey, contentType = "") {
  return isVideoObject(relativeKey, contentType) && PLAYABLE_VIDEO_TYPES.has(videoContentType(relativeKey, contentType));
}

const KEY_CHARACTERS = "A-Za-z0-9._~%+@/-";
// Root-relative only: "/images/x" inside https://other.host/images/x is not ours.
const ROOT_RELATIVE = new RegExp(`(^|[^A-Za-z0-9._~%-])/(images|media)/([${KEY_CHARACTERS}]+)`, "g");
const ANYWHERE = new RegExp(`/(images|media)/([${KEY_CHARACTERS}]+)`, "g");

function cleanKey(raw) {
  const key = decoded(String(raw).replace(/[.,]+$/, ""));
  return key && !key.startsWith("/") && !key.includes("..") ? key : "";
}

// The sitemap lists addresses (and sometimes pictures) for search engines, and is made from the pages. It is never a
// reason to keep a picture or a place a picture is used. robots.txt only points at it.
export function isSitemapFile(file) {
  return /(?:^|\/)(?:sitemap[^/]*\.xml|robots\.txt)$/i.test(String(file || "").replace(/\\/g, "/"));
}

// What a site's build writes (dist/ holds a copy of every page): counting it would count each link twice, and a link
// left in an old build would outlive the page that had it.
export function isBuiltOutputFile(file) {
  return /(?:^|\/)dist\//i.test(String(file || "").replace(/\\/g, "/"));
}

// Characters that end a web address in the middle of a text: quotes, brackets, spaces, commas and the equals sign of
// an unquoted attribute.
const ADDRESS_END = /[\s"'<>()[\]{}|\\^`,=]/;

// The address a link at `index` is written inside, when that address names a host ("https://h/a/images/x" or
// "//h/images/x"); "" for a link that is root-relative or relative.
function hostPartBefore(text, index) {
  let start = index;
  while (start > 0 && index - start < 400 && !ADDRESS_END.test(text[start - 1])) start -= 1;
  const token = text.slice(start, index);
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]+/i.test(token) ? token : "";
}

// Every stored key a text mentions. Without `ownHosts` it is deliberately generous (any host), because it decides
// what must NOT be deleted. With `ownHosts` (what a site records as its use of a picture) a link counts only when it
// is root-relative or on one of the site's own hosts: a supplier's "https://other.example/images/x" is not our file.
export function mediaReferences(text, into = new Set(), { ownHosts = null } = {}) {
  const source = String(text || "");
  for (const match of source.matchAll(ANYWHERE)) {
    if (ownHosts) {
      const address = hostPartBefore(source, match.index);
      if (address && isForeignMediaUrl(address, ownHosts)) continue;
    }
    const key = cleanKey(match[2]);
    if (key) {
      into.add(key);
      // Language maps store file links in route form ("x.pdf/"); it names the same file.
      if (key.endsWith("/")) into.add(key.slice(0, -1));
    }
  }
  return into;
}

// Rewrite root-relative /images/<old> and /media/<old> to the new keys.
export function rewriteMediaReferences(text, moves) {
  let count = 0;
  const output = String(text || "").replace(ROOT_RELATIVE, (whole, lead, route, raw) => {
    const trailing = raw.match(/[.,]+$/)?.[0] || "";
    const key = cleanKey(raw);
    const slash = key.endsWith("/");
    const target = key && moves.get(slash ? key.slice(0, -1) : key);
    if (!target) return whole;
    count += 1;
    return `${lead}/${target.startsWith(FILES_FOLDER) ? "media" : "images"}/${target}${slash ? "/" : ""}${trailing}`;
  });
  return { text: output, count };
}

// Rewrite every string in a parsed JSON document that is a stored key (bare, or
// behind /images/ or /media/), or that contains root-relative links.
export function rewriteJsonMediaValues(value, moves) {
  let count = 0;
  const visit = (node) => {
    if (typeof node === "string") {
      const bare = node.replace(/^\/(?:images|media)\//, "");
      const direct = moves.get(bare) || moves.get(cleanKey(bare));
      if (direct) {
        count += 1;
        return /^\/(?:images|media)\//.test(node)
          ? `/${direct.startsWith(FILES_FOLDER) ? "media" : "images"}/${direct}`
          : direct;
      }
      const rewritten = rewriteMediaReferences(node, moves);
      count += rewritten.count;
      return rewritten.text;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v)]));
    return node;
  };
  const next = visit(value);
  return { value: next, count };
}

// The host of an absolute URL ("https://h/x" or "//h/x"), or "" for anything relative.
function absoluteHost(value) {
  const match = /^(?:https?:)?\/\/([^/?#\s]+)/i.exec(String(value).trim());
  return match ? match[1].replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase() : "";
}

// True when `value` is an absolute URL on a host that is not the site's own. `ownHosts` lists exact hosts, and
// suffixes written ".example.com" or "*.example.com". Without a list nothing is called foreign (callers that decide
// what may be deleted stay generous).
export function isForeignMediaUrl(value, ownHosts) {
  if (!ownHosts) return false;
  const host = absoluteHost(value);
  if (!host) return false;
  for (const entry of ownHosts) {
    const own = String(entry || "").trim().toLowerCase();
    if (!own) continue;
    const suffix = own.startsWith("*.") ? own.slice(1) : own.startsWith(".") ? own : "";
    if (suffix ? host.endsWith(suffix) : host === own) return false;
  }
  return true;
}

// Strings in a JSON document (owner content, event and product snapshots)
// that name a stored key, with or without the /images/ route. A link to another
// site's picture (a supplier's cover) is not a stored key even when its path
// looks like one, when `ownHosts` says which hosts are the site's own.
export function jsonMediaReferences(value, known, into = new Set(), ownHosts = null) {
  const visit = (node) => {
    if (typeof node === "string") {
      if (isForeignMediaUrl(node, ownHosts)) return;
      const bare = node.replace(/^\/(?:images|media)\//, "");
      if (known.has(bare)) into.add(bare);
      mediaReferences(node, into);
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  };
  visit(value);
  return into;
}

// Hosts that serve a site's own storage, read from the site's own files: the address its pages name as their own
// (canonical and og:url links), its sitemap and robots.txt, the routes in its wrangler file, and workers.dev always.
// `files` is [[path, text]] and may include the wrangler file. `extra` lists hosts the caller already knows. A www
// address and its bare twin are one site. An absolute link on any other host (a supplier's cover) is not a stored key.
export function siteOwnHostsFromFiles(files = [], extra = []) {
  const hosts = new Set(["*.workers.dev"]);
  const add = (value) => {
    const host = /^(?:https?:)?\/\/([^/?#\s"'<>]+)/i.exec(String(value || "").trim())?.[1]?.replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
    if (!host) return;
    hosts.add(host);
    hosts.add(host.startsWith("www.") ? host.slice(4) : `www.${host}`);
  };
  for (const entry of extra) {
    const host = String(entry || "").trim().toLowerCase();
    if (!host) continue;
    if (host.startsWith("*.") || host.startsWith(".")) hosts.add(host);
    else add(`//${host}`);
  }
  for (const [file, text] of files) {
    const name = String(file || "").replace(/\\/g, "/");
    if (isSitemapFile(name)) {
      for (const match of String(text).matchAll(/(?:<loc>|Sitemap:\s*)\s*(https?:\/\/[^<\s]+)/gi)) add(match[1]);
    } else if (/(?:^|\/)wrangler\.(?:jsonc?|toml)$/i.test(name)) {
      for (const match of String(text).matchAll(/(?:pattern|route)["']?\s*[:=]\s*["']([^"'/*]+)/gi)) add(`//${match[1]}`);
    } else if (/\.html?$/i.test(name) && !isBuiltOutputFile(name)) {
      for (const match of String(text).matchAll(/<(?:link\b[^>]*rel=["']canonical["'][^>]*|meta\b[^>]*property=["']og:url["'][^>]*)>/gi)) {
        add(/(?:href|content)=["']([^"']+)["']/i.exec(match[0])?.[1] || "");
      }
    }
  }
  return [...hosts];
}
