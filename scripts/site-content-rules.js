// The rules for resolving a site's content, with no dependencies at all.
//
// THIS FILE SHIPS INTO EVERY GENERATED SITE. Its worker imports it to resolve
// what the owner set - a phone number, a photograph, a menu - while serving a
// page, through Cloudflare's HTMLRewriter. The platform imports the same file
// so the tests, the admin console and the edit tools agree with what a visitor
// actually gets. So it has NO IMPORTS: not cheerio, not parse5, not
// node:anything. The moment it needs one it stops being shippable and the two
// sides start to drift.
//
// ---- THE TAG IS THE WHOLE INTERFACE ---------------------------------------
//
// A page says what is editable, what kind of thing it is, and what to call it.
// The admin console then renders whatever the site declares and knows nothing
// else - no per-site configuration, no vocabulary of things we thought of in
// advance, no table to keep in step. A site can offer "Bar menu" without the
// platform having ever heard of bar menus.
//
//   data-ww-edit    the id: the key in the site's content document
//   data-ww-kind    what it is, which decides both how it resolves and which
//                   field the console shows
//   data-ww-label   what the console calls it
//   data-ww-part    which part of THIS element the value fills: "text",
//                   "link", or "both". Defaults to "text".
//   data-ww-help    optional: what the owner needs to know. For a photograph
//                   this is the description of the picture that belongs there,
//                   which is the most useful sentence on the screen.
//   data-ww-background  for a background only: the background-image the page
//                   draws there today, as its stylesheet or style states it.
//
// One id may appear on many elements across many pages - a phone number
// appeared on 15 of them across 5 pages of one real site - and the label only
// has to be stated once. The console groups by id.
//
// WHY kind AND NOT A NAMED VOCABULARY. The first version had three attributes
// whose names encoded the kind (data-ww-value, data-ww-href, data-ww-slot) and
// a platform-side list of known things (phone, email, address, the socials).
// Adding a menu would have meant a fourth attribute and an entry in that list,
// and every consumer would have had to learn both. Here a new kind is one row
// in the table below.
//
// The element interface the transforms are written against is the small part
// HTMLRewriter's Element and a cheerio adapter can both satisfy:
//
//   tagName            lowercase name
//   getAttribute(n)    string | null
//   setAttribute(n,v)
//   setInnerContent(t) replace children with text
//   replace(html)      replace the element itself with markup
//
// Nothing reads a parent, a sibling or an index, because HTMLRewriter streams
// and cannot see any of them.

export const CONTENT_VERSION = 1;
// What this copy of the rules can draw; a site's Worker reports it in an x-ww-content header so the console knows.
// 2: owner-made links on text and photographs, and the words shown for email and phone links.
// 3: background images and videos.
// 4: the words a photograph place reads aloud (a logo's alt), and the header and footer as fields of their own.
export const CONTENT_RULES_VERSION = 4;

export const EDIT_ATTRIBUTE = "data-ww-edit";
export const KIND_ATTRIBUTE = "data-ww-kind";
export const LABEL_ATTRIBUTE = "data-ww-label";
export const PART_ATTRIBUTE = "data-ww-part";
export const HELP_ATTRIBUTE = "data-ww-help";
// Where the field belongs, so the console can group a site's text by section
// without parsing an id to work it out. The site says it; the screen shows it.
export const GROUP_ATTRIBUTE = "data-ww-group";
// "landscape", "portrait" or "square" - written ONLY when the page or its
// stylesheet says so, never guessed. A place with no stated shape takes any
// photograph, which is the right default: vetoing a good picture because we
// assumed a shape is worse than offering one that needs a look.
export const SHAPE_ATTRIBUTE = "data-ww-shape";
// A background is declared in a stylesheet, which a resolver that streams the page cannot read. So the tag
// states it: the element's whole background-image, darkening gradient and all. Resolving swaps the picture
// inside that value and leaves every other layer as the page drew it.
export const BACKGROUND_ATTRIBUTE = "data-ww-background";

// A translated page cannot carry the edit attributes: the console would index it as a second
// copy of the same fields. It carries these instead, which only the language overlay reads.
export const I18N_ATTRIBUTES = Object.freeze({ edit: "data-ww-i18n", kind: "data-ww-i18n-kind", part: "data-ww-i18n-part" });
const SOURCE_ATTRIBUTES = Object.freeze({ edit: EDIT_ATTRIBUTE, kind: KIND_ATTRIBUTE, part: PART_ATTRIBUTE });

const digits = (value) => String(value ?? "").replace(/\D/g, "");

// One number, normalised on the way in.
//
// An owner types "(210) 555-9999", "210.555.9999" or "+1 210 555 9999" and
// means the same thing. Normalising once when it is STORED - rather than
// letting the link and the words each interpret what was typed - is what keeps
// them from disagreeing: tel:+12105559999 beside the words "(210) 555-0184"
// would be a link that says one number and dials another, which is worse than
// not resolving at all.
//
// A number that is not ten digits, or eleven starting 1, is left exactly as
// typed: guessing at an international format we cannot verify would be worse
// than showing what the owner wrote.
export function normalizeEmail(value) {
  return String(value ?? "").trim().replace(/^mailto:/i, "").trim();
}

export function normalizePhone(value) {
  const bare = digits(value);
  if (bare.length === 11 && bare.startsWith("1")) return `+${bare}`;
  if (bare.length === 10) return `+1${bare}`;
  return String(value ?? "").trim();
}

function nationalPhone(value) {
  const bare = digits(value).replace(/^1(?=\d{10}$)/, "");
  return /^\d{10}$/.test(bare)
    ? `(${bare.slice(0, 3)}) ${bare.slice(3, 6)}-${bare.slice(6)}`
    : String(value ?? "").trim();
}

const trimmed = (value) => String(value ?? "").trim();

// A crop is deliberately bounded presentation metadata, not a CSS escape
// hatch. The original image is never rewritten: the owner chooses its focal
// point and an optional bounded zoom, and the site renders that same original
// file with CSS. Keep values as whole percentages so they are predictable in
// the console, compact in R2, and equally safe in HTMLRewriter and Node.
function normalizeCrop(crop) {
  if (!crop || typeof crop !== "object") return null;
  const point = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round(number) : null;
  };
  const x = point(crop.x);
  const y = point(crop.y);
  // A stored owner selection is one deliberate point. Reject a malformed
  // half-selection rather than silently turning it into a different crop.
  if (x === null || y === null) return null;
  const rawZoom = crop.zoom === undefined ? 100 : Number(crop.zoom);
  const zoom = Number.isFinite(rawZoom) && rawZoom >= 10 && rawZoom <= 250
    ? Math.round(rawZoom)
    : null;
  return zoom === null ? null : { x, y, zoom };
}

function cropStyle(crop) {
  return crop ? `object-position:${crop.x}% ${crop.y}%` : "";
}

function mergedCropStyle(existing, crop) {
  const override = cropStyle(crop);
  if (!override) return "";
  // A source can already carry sizing, transforms, or a background treatment
  // inline. The crop control changes only the focal point; it may not erase
  // those declarations when the Worker resolves the owner's photo.
  const declarations = String(existing || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const transform = declarations.find((part) => /^transform\s*:/i.test(part));
  const preserved = declarations.filter((part) => !/^object-position\s*:/i.test(part) && !/^transform\s*:/i.test(part));
  // A zoom is CSS only. If the source already transformed the image, retain
  // that transform and append scale rather than replacing it.
  const zoom = Number(crop.zoom || 100) / 100;
  const sourceTransform = transform ? transform.replace(/^transform\s*:\s*/i, "") : "";
  if (zoom !== 1) {
    preserved.push(`transform:${sourceTransform ? `${sourceTransform} ` : ""}scale(${zoom})`);
    preserved.push(`transform-origin:${crop.x}% ${crop.y}%`);
  } else if (transform) {
    preserved.push(transform);
  }
  return [...preserved, override].join(";");
}

// The declarations of a style attribute. A url() can hold a semicolon, so splitting on one is not enough.
export function styleDeclarations(style) {
  const text = String(style || "");
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === ";" && !depth) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const CSS_URL = /url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi;

// The picture a background-image value draws: its first url() that is a file rather than inline data.
export function backgroundPicture(declared) {
  for (const match of String(declared || "").matchAll(CSS_URL)) {
    const target = match[0].slice(4, -1).trim().replace(/^["']|["']$/g, "");
    if (target && !/^data:/i.test(target)) return target;
  }
  return "";
}

// The same background with another picture in it. A value that names no picture is replaced outright.
function backgroundWith(declared, path) {
  const picture = `url("${path}")`;
  let swapped = false;
  const value = String(declared || "").replace(CSS_URL, (match) => {
    if (swapped || /^url\(\s*["']?data:/i.test(match)) return match;
    swapped = true;
    return picture;
  });
  return swapped ? value : picture;
}

// Attributes for markup this file writes itself. Escaped, because the values
// come from a content document somebody typed into.
function attributeText(name, value) {
  return `${name}="${String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"`;
}

// ---- Links the owner puts on things -----------------------------------------
//
// Any editable piece can become a link. The document stores
//   link: { href, text, newTab }
// beside the value, and the transform that resolves the value draws the link:
//   text         its words become a link to href (a piece that already is a link just gets the new href)
//   photograph   the picture is wrapped in a link; text is what a screen reader announces
//   email/phone  the address stays the target and text replaces the words shown ("Contact")
// Whatever is typed ends up in an href on a public page, so a target is kept only when a browser would follow it safely.
export const LINK_ATTRIBUTE = "data-ww-link";
const IN_LINK_ATTRIBUTE = "data-ww-in-link";
const LINK_TARGET_MAX = 2000;
const LINK_TEXT_MAX = 120;

export function normalizeLinkTarget(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text.length > LINK_TARGET_MAX) return "";
  // What an owner types for these two is the bare address or number.
  if (/^[^\s@<>"'`\\()[\],;:]+@[^\s@<>"'`\\()[\],;:]+\.[A-Za-z]{2,}$/.test(text)) return `mailto:${text}`;
  const mail = /^mailto:([^\s@<>"'`\\?]+@[^\s@<>"'`\\?]+)(\?[^\s<>"'`\\]*)?$/i.exec(text);
  if (mail) return `mailto:${mail[1]}${mail[2] || ""}`;
  const phone = /^(?:tel:)?\s*(\+?[\d\s().-]{7,25})$/i.exec(text);
  if (phone && digits(phone[1]).length >= 7 && digits(phone[1]).length <= 15) {
    const bare = digits(phone[1]);
    // A US number gets its country code, the way the phone field does; anything else keeps the digits it was typed with.
    const national = bare.length === 10 ? `+1${bare}` : bare.length === 11 && bare.startsWith("1") ? `+${bare}` : "";
    return `tel:${national || (phone[1].trim().startsWith("+") ? `+${bare}` : bare)}`;
  }
  if (/[\u0000-\u001f\u007f\s<>"`\\]/.test(text) || text.startsWith("//")) return "";
  // A page on this site, or a place on the page.
  if (text.startsWith("/") || text.startsWith("#")) return text;
  if (/^https?:\/\//i.test(text)) {
    try { const url = new URL(text); return url.hostname ? url.href : ""; } catch { return ""; }
  }
  // javascript:, data: and every other scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return "";
  if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/?#].*)?$/.test(text)) {
    try { return new URL(`https://${text}`).href; } catch { return ""; }
  }
  return "";
}

export function normalizeLink(raw, kind) {
  if (!raw || typeof raw !== "object") return null;
  const text = String(raw.text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LINK_TEXT_MAX);
  // Their address is already the target: only the words shown can change.
  if (kind === "email" || kind === "phone") return text ? { text } : null;
  if (kind !== "text" && kind !== "multiline" && kind !== "image") return null;
  const href = normalizeLinkTarget(raw.href);
  if (!href) return null;
  return {
    href,
    ...(kind === "image" && text ? { text } : {}),
    ...(raw.newTab === true || raw.newTab === false ? { newTab: raw.newTab } : {})
  };
}

const KEEPS_ITS_CONTENT = new Set(["title", "option", "textarea", "button", "select", "script", "style", "summary", "label", "input", "svg", "text", "tspan"]);

// The element interface is HTMLRewriter's, which can only insert markup beside or inside an element, so a wrapper is
// an opening and a closing tag. The Node side (cheerio) cannot insert half a tag and supplies these two itself.
function wrapAround(element, open, close) {
  if (typeof element.wrapAround === "function") return element.wrapAround(open, close);
  element.before(open, { html: true });
  element.after(close, { html: true });
}
function wrapContents(element, open, close) {
  if (typeof element.wrapContents === "function") return element.wrapContents(open, close);
  element.prepend(open, { html: true });
  element.append(close, { html: true });
}

function linkAnchor(id, href, { newTab, label } = {}) {
  const opensNew = newTab === true && !/^(?:mailto|tel):/i.test(href);
  return `<a ${attributeText("href", href)} ${attributeText(LINK_ATTRIBUTE, id)}`
    + `${opensNew ? ' target="_blank" rel="noopener noreferrer"' : ""}`
    + `${label ? ` ${attributeText("aria-label", label)}` : ""}>`;
}

// A piece that already is a link just gets the owner's target.
function retargetAnchor(element, href, newTab) {
  element.setAttribute("href", href);
  if (newTab === true && !/^(?:mailto|tel):/i.test(href)) {
    element.setAttribute("target", "_blank");
    const rel = new Set(String(element.getAttribute("rel") || "").split(/\s+/).filter(Boolean));
    rel.add("noopener");
    rel.add("noreferrer");
    element.setAttribute("rel", [...rel].join(" "));
  } else if (newTab === false && element.getAttribute("target") !== null) {
    element.setAttribute("target", "_self");
  }
}

// ---- The kinds -------------------------------------------------------------
//
// `editor` is what the console shows. `render` is how the value reaches a page:
// `text` fills the element's words, `href` fills its link, `src` fills its
// image. A kind that returns no `text` never touches an element's contents; a
// kind that returns no `href` never touches its link.
export const KINDS = Object.freeze({
  text: {
    editor: "text",
    render: (value) => ({ text: trimmed(value) })
  },
  multiline: {
    editor: "multiline",
    render: (value) => ({ text: trimmed(value) })
  },
  phone: {
    editor: "tel",
    normalize: normalizePhone,
    render: (value) => {
      const normalized = normalizePhone(value);
      return {
        text: nationalPhone(normalized),
        href: normalized ? `tel:${/^\+/.test(normalized) ? normalized : digits(normalized)}` : ""
      };
    }
  },
  email: {
    editor: "email",
    // The scheme comes off first, the way it does for a phone number.
    //
    // A tag on a link carries the HREF as what the page says today, so an
    // untouched email field arrived here as "mailto:hi@example.com" - which
    // the console then showed to the owner verbatim, and saving it produced
    // href="mailto:mailto:hi@example.com". A phone number was already immune
    // because normalizePhone reduces to digits; this is the same rule stated
    // for the one kind that had no normalizer.
    normalize: normalizeEmail,
    render: (value) => {
      const address = normalizeEmail(value);
      return { text: address, href: address ? `mailto:${address}` : "" };
    }
  },
  url: {
    editor: "url",
    // What is typed is an address: "example.com" becomes https://example.com/, an email becomes mailto:, and a
    // scheme a browser should not follow from a public page (javascript:, data:) becomes nothing at all.
    normalize: (value) => normalizeLinkTarget(value) || "",
    // Text is deliberately absent: a social link's words are usually
    // "Instagram" or an icon, and replacing them with the URL would be worse
    // than leaving them.
    render: (value) => ({ href: normalizeLinkTarget(value) })
  },
  date: {
    editor: "date",
    normalize: (value) => {
      const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || "").trim());
      return match ? match[1] : String(value || "").trim();
    },
    render: (value) => {
      const v = String(value || "").trim();
      return { text: v, until: v };
    }
  },
  image: {
    editor: "image",
    // A file this site has, resolved to the path its own worker serves.
    render: (value) => ({ src: trimmed(value) ? `/images/${trimmed(value)}` : "" })
  },
  // A photograph drawn behind an element's content. It is chosen like any other photograph, but it fills a
  // style, never the element: a background's element holds the words in front of it.
  background: {
    editor: "image",
    render: (value) => ({ background: trimmed(value) ? `/images/${encodeURIComponent(trimmed(value))}` : "" })
  },
  // A video this site has, kept with its other files.
  video: {
    editor: "video",
    render: (value) => ({ video: trimmed(value) ? `/media/files/${encodeURIComponent(trimmed(value))}` : "" })
  }
});

// The kinds whose value is the name of a stored file.
const FILE_KINDS = new Set(["image", "background", "video"]);

export function isKnownKind(kind) {
  return Object.hasOwn(KINDS, String(kind));
}

// ---- Search engine verification --------------------------------------------
//
// Stored beside the owner's values and written into <head> (or served as the
// verification file) while a page is served, so adding one needs no deploy.
// Everything is checked again here: the document comes from a bucket.
const GOOGLE_TOKEN = /^[A-Za-z0-9_-]{20,120}$/;
const GOOGLE_FILE = /^google[0-9a-f]{16}\.html$/;
const BING_TOKEN = /^[A-Fa-f0-9]{32}$/;
const GA4_ID = /^G-[A-Z0-9]{4,15}$/;
const GTM_ID = /^GTM-[A-Z0-9]{4,10}$/;
const MAX_VERIFICATIONS = 5;

export function normalizeSeo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (list, pattern) => [...new Set((Array.isArray(list) ? list : [])
    .map((item) => String(item ?? "").trim()).filter((item) => pattern.test(item)))].slice(0, MAX_VERIFICATIONS);
  const googleMeta = pick(raw.googleMeta, GOOGLE_TOKEN);
  const googleFile = pick(raw.googleFile, GOOGLE_FILE);
  const bing = BING_TOKEN.test(String(raw.bing ?? "").trim()) ? String(raw.bing).trim().toUpperCase() : "";
  const ga4 = GA4_ID.test(String(raw.ga4 ?? "").trim().toUpperCase()) ? String(raw.ga4).trim().toUpperCase() : "";
  const gtm = GTM_ID.test(String(raw.gtm ?? "").trim().toUpperCase()) ? String(raw.gtm).trim().toUpperCase() : "";
  if (!googleMeta.length && !googleFile.length && !bing && !ga4 && !gtm) return null;
  return {
    ...(googleMeta.length ? { googleMeta } : {}),
    ...(googleFile.length ? { googleFile } : {}),
    ...(bing ? { bing } : {}),
    ...(ga4 ? { ga4 } : {}),
    ...(gtm ? { gtm } : {})
  };
}

// Only an identifier is ever stored; the snippet is ours. Kept identical to
// renderGoogleTagHead in scripts/google-tag-lib.mjs, which a test enforces.
const scriptString = (value) => String(value).replace(/[\\'"<]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

export function seoHeadHtml(seo) {
  const settings = normalizeSeo(seo);
  if (!settings) return "";
  const tag = (name, content) => `<meta ${attributeText("name", name)} ${attributeText("content", content)}>`;
  return [
    ...(settings.googleMeta || []).map((token) => tag("google-site-verification", token)),
    ...(settings.bing ? [tag("msvalidate.01", settings.bing)] : []),
    ...(settings.ga4 ? [
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(settings.ga4)}"></script>`
      + "<script>window.dataLayer=window.dataLayer||[];"
      + "function gtag(){dataLayer.push(arguments);}"
      + `gtag('js',new Date());gtag('config','${scriptString(settings.ga4)}');</script>`
    ] : []),
    ...(settings.gtm ? [
      "<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});"
      + "var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;"
      + "j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})"
      + `(window,document,'script','dataLayer','${scriptString(settings.gtm)}');</script>`
    ] : [])
  ].join("");
}

// What Google fetches to verify by file: its name, and that name in the body.
export function seoVerificationFile(seo, pathname) {
  const name = String(pathname || "").replace(/^\//, "");
  return normalizeSeo(seo)?.googleFile?.includes(name) ? `google-site-verification: ${name}` : "";
}

// ---- The platform's credit -------------------------------------------------
//
// "Website by Jaybird Digital", drawn into the site's footer by its own Worker (addSiteCredit in
// site-content-worker.js). The owner's choice is `credit` in this document, true or false, set from the editor's
// Settings or by the assistant, live at once like any value; a document that says nothing takes the default.
export const CREDIT_SHOWN_BY_DEFAULT = true;
export function creditShown(content) {
  const credit = content && typeof content === "object" ? content.credit : undefined;
  return typeof credit === "boolean" ? credit : CREDIT_SHOWN_BY_DEFAULT;
}

// ---- Photograph descriptions -----------------------------------------------
//
// A small index of what each library photograph shows and its shape, kept by the
// platform beside the owner content. It fills in what a page left out; it never
// replaces what somebody wrote.
// The widest copy of a library picture a page asks for (the build's SERVED_IMAGE_WIDTH in generate-site-build.mjs).
export const SERVED_IMAGE_WIDTH = 1600;

export function parseImageIndex(text) {
  let parsed = null;
  try { parsed = typeof text === "string" ? (text ? JSON.parse(text) : null) : text; } catch { return null; }
  const source = parsed && typeof parsed === "object" ? parsed.images : null;
  if (!source || typeof source !== "object") return null;
  const images = {};
  for (const [name, entry] of Object.entries(source).slice(0, 5000)) {
    if (!name || name.includes("/") || name.length > 300) continue;
    const description = typeof entry?.d === "string" ? entry.d.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const dimension = (value) => (Number.isInteger(value) && value > 0 && value <= 20000 ? value : 0);
    const width = dimension(entry?.w);
    const height = dimension(entry?.h);
    const publicPath = typeof entry?.p === "string" && /^\/(?:images|r2\/photos)\//.test(entry.p)
      && !/[?#\\\x00]/.test(entry.p) && !entry.p.split("/").some(part => part === "." || part === "..")
      && entry.p.endsWith(`/${name}`) ? entry.p : "";
    if (description || (width && height) || publicPath) images[name] = {
      d: description, w: width, h: height, ...(publicPath ? { p: publicPath } : {})
    };
  }
  return Object.keys(images).length ? images : null;
}

const plainName = (text) => String(text ?? "").toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").replace(/[^a-z0-9]+/g, "");
const GENERIC_ALT = /^(?:image|img|photo|picture|pic|untitled|screenshot|dsc|banner|slide|gallery|hero)\d*$/;

// A missing alt is always filled. A present one only when it says nothing more
// than the file's own name or a generic word; an empty alt is a deliberate
// "decorative" and stays.
export function altNeedsDescription(alt, name) {
  if (alt === null || alt === undefined) return true;
  const text = String(alt).trim();
  if (!text) return false;
  const plain = plainName(text);
  return plain === plainName(name) || GENERIC_ALT.test(plain) || /\.(?:jpe?g|png|webp|gif|avif)$/i.test(text);
}

// The library file a page's <img> points at, if it is one. Library photographs
// sit at the top of /images/, so anything deeper or elsewhere is not one.
export function libraryImageName(src) {
  const match = /^(?:\.?\/)?images\/([^/?#]+)(?:[?#].*)?$/i.exec(String(src ?? "").trim());
  if (!match) return "";
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

// ---- The stored document ---------------------------------------------------

// What a photograph says to somebody who cannot see it: one line of plain words.
const ALT_MAX = 300;
function normalizeAlt(raw) {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, ALT_MAX) : "";
}

export function emptyContent() {
  return { version: CONTENT_VERSION, values: {} };
}

// Read a stored document defensively. It comes from a bucket, it may have been
// written by an older release, and a site whose content will not parse must
// still serve its pages - from the markup, which is always complete.
export function parseContent(text) {
  if (!text) return emptyContent();
  let parsed = null;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return emptyContent();
  }
  if (!parsed || typeof parsed !== "object") return emptyContent();

  const values = {};
  for (const [id, entry] of Object.entries(parsed.values || {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id))) continue;
    const raw = typeof entry === "string" ? entry : entry?.value;
    if (typeof raw !== "string") continue;
    const kind = typeof entry === "object" && isKnownKind(entry?.kind) ? entry.kind : null;
    const value = ((kind && KINDS[kind].normalize?.(raw)) ?? raw).trim();
    const link = kind && typeof entry === "object" ? normalizeLink(entry.link, kind) : null;
    if (!value && entry?.clear === true && (kind === "text" || kind === "multiline")) {
      values[id] = { value: "", kind, clear: true, ...(link ? { link } : {}) };
      continue;
    }
    // An empty string is not "no opinion", it is a value nobody set, and
    // resolving it would blank out the page's own working fallback. A link on
    // something whose words or photograph the owner left alone still counts.
    if (!value) {
      // The same for the words a photograph the owner kept reads aloud.
      const alt = kind === "image" ? normalizeAlt(entry?.alt) : "";
      if ((link && (kind === "text" || kind === "multiline" || kind === "image")) || alt) {
        values[id] = { value: "", kind, ...(alt ? { alt } : {}), ...(link ? { link } : {}) };
      }
      continue;
    }
    // A file is a name, and this becomes a path on the site from a
    // request body: a name that could climb out of its folder is refused.
    if (FILE_KINDS.has(kind) && (value.includes("/") || value.includes(".."))) continue;
    const crop = kind === "image" ? normalizeCrop(entry?.crop) : null;
    const alt = kind === "image" ? normalizeAlt(entry?.alt) : "";
    values[id] = kind ? { value, kind, ...(crop ? { crop } : {}), ...(alt ? { alt } : {}), ...(link ? { link } : {}) } : { value };
  }
  const seo = normalizeSeo(parsed.seo);
  const translations = normalizeTranslations(parsed.translations);
  return { version: CONTENT_VERSION, values, ...(seo ? { seo } : {}), ...(translations ? { translations } : {}),
    ...(typeof parsed.credit === "boolean" ? { credit: parsed.credit } : {}) };
}

// ---- Translations of the owner's text --------------------------------------

// What each language says for a text field the owner typed, beside the words it was made
// from. `source` is what makes an entry safe to show: if the owner's words have changed
// since, the entry is not used rather than shown out of date.
//   translations: { tr: { "hours-title": { value: "Çalışma saatleri", source: "Opening hours" } } }
const TRANSLATION_LIMIT = 4000;

export function normalizeTranslations(raw) {
  if (!raw || typeof raw !== "object") return null;
  const result = {};
  for (const [language, entries] of Object.entries(raw)) {
    if (!/^[a-z]{2,3}$/.test(language) || !entries || typeof entries !== "object") continue;
    const kept = {};
    for (const [id, entry] of Object.entries(entries)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !entry || typeof entry.value !== "string" || typeof entry.source !== "string") continue;
      const value = entry.value.trim();
      const source = entry.source.trim();
      if (!value || !source || value.length > TRANSLATION_LIMIT || source.length > TRANSLATION_LIMIT) continue;
      kept[id] = { value, source };
    }
    if (Object.keys(kept).length) result[language] = kept;
  }
  return Object.keys(result).length ? result : null;
}

// The words a translated page takes from the owner's document, in the shape the transforms read.
//   - wording the owner typed, in that language, when it has been translated from what they
//     typed now (a cleared field is cleared everywhere);
//   - phone, email and web addresses, which read the same in every language.
// Photographs are applied separately, with the page's own attributes.
export function languageContent(content, language) {
  const parsed = parseContent(content);
  const translated = parsed.translations?.[language] || {};
  const values = {};
  for (const [id, entry] of Object.entries(parsed.values)) {
    if (entry.kind === "phone" || entry.kind === "email" || entry.kind === "url") values[id] = entry;
    else if ((entry.kind === "text" || entry.kind === "multiline") && entry.clear) values[id] = entry;
    else if ((entry.kind === "text" || entry.kind === "multiline") && translated[id]?.source === entry.value) {
      values[id] = { value: translated[id].value, kind: entry.kind, ...(entry.link ? { link: entry.link } : {}) };
    } else if ((entry.kind === "text" || entry.kind === "multiline") && entry.link) {
      // Where a link goes is the same in every language, even while its new words wait for a translation:
      // the page keeps its own translated words and takes the new destination.
      values[id] = { value: "", kind: entry.kind, link: entry.link };
    }
  }
  return { version: CONTENT_VERSION, values };
}

// The same, for photographs, backgrounds and videos only: the part of a document that is the same in every language.
export function imageContent(content) {
  const { values, seo } = parseContent(content);
  return { version: CONTENT_VERSION, ...(seo ? { seo } : {}),
    // The words a photograph reads aloud are the owner's language; the translated page keeps its own.
    values: Object.fromEntries(Object.entries(values).filter(([, value]) => FILE_KINDS.has(value.kind))
      .map(([id, { alt, ...value }]) => [id, value])) };
}

// ---- The transform ---------------------------------------------------------

// One selector, one handler, dispatching on the kind the page declares.
// SHOWING AN OWNER WHERE A PHOTOGRAPH GOES.
//
// The console cannot draw the site - it is a different origin, and a mockup of
// somebody's page is a lie the moment their page changes. But the site's own
// Worker already rewrites every page it serves, so the site can show the owner
// the real page with the real slot marked, and the console just points an
// iframe at it.
//
//   ?ww-slot=<id>         outline that element and leave an anchor to scroll to
//   &ww-try=<filename>    render it with a photograph that is not saved yet
//
// Both are read-only and affect one response. Nothing is stored, and a preview
// request is marked noindex so a crawler never sees an outlined page.
const HIGHLIGHT_ID = "ww-here";
export const PREVIEW_STYLE = `<style data-ww-preview="1">
[data-ww-highlight]{outline:3px solid #2f6df6 !important;outline-offset:4px !important;box-shadow:0 0 0 6px rgba(47, 109, 246, 0.28) !important;border-radius:3px !important;scroll-margin-top:140px !important;scroll-margin-bottom:140px !important;transition:outline 0.15s ease, box-shadow 0.15s ease !important;}
#${HIGHLIGHT_ID}{display:block;position:relative;top:-110px;height:0;visibility:hidden;}
#page-loader, .page-loader, #loader, .loader, [data-page-loader], [data-loader], .site-loader, .intro-loader, .mobile-loader-dancer { display: none !important; opacity: 0 !important; pointer-events: none !important; visibility: hidden !important; }
img.image-placeholder { border: none !important; background: none !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; }
[${EDIT_ATTRIBUTE}], .ww-store-announcement { cursor: pointer; }
[${EDIT_ATTRIBUTE}]:hover, .ww-store-announcement:hover { outline: 2px dashed rgba(47, 109, 246, 0.6) !important; outline-offset: 2px; }
</style>
<script data-ww-preview-bridge="1">
(function() {
  if (window.self === window.top) return;
  // The URL slot is re-applied while the page settles, but a newer selection
  // from the editor or a click must win over those late retries.
  var urlSlot = new URLSearchParams(window.location.search).get('ww-slot');
  var selected = false;

  function select(id) {
    if (id && id !== urlSlot) selected = true;
    highlightSlot(id);
  }

  function highlightUrlSlot(slot) {
    if (slot && !selected) highlightSlot(slot);
  }

  function highlightSlot(id) {
    if (!id) return;
    var prev = document.querySelectorAll('[data-ww-highlight]');
    for (var i = 0; i < prev.length; i++) {
      prev[i].removeAttribute('data-ww-highlight');
    }
    var all = document.querySelectorAll('[' + ${JSON.stringify(EDIT_ATTRIBUTE)} + ']');
    var target = null;
    for (var j = 0; j < all.length; j++) {
      if (all[j].getAttribute(${JSON.stringify(EDIT_ATTRIBUTE)}) === id) {
        target = all[j];
        break;
      }
    }
    if (target) {
      target.setAttribute('data-ww-highlight', '1');
      try {
        target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      } catch (err) {
        try { target.scrollIntoView(); } catch (e) {}
      }
      try {
        window.parent.postMessage({ type: 'ww-highlighted', id: id }, '*');
      } catch (e) {}
    }
  }

  function initBridge() {
    var params = new URLSearchParams(window.location.search);
    var slot = params.get('ww-slot');
    if (slot) {
      highlightUrlSlot(slot);
      setTimeout(function() { highlightUrlSlot(slot); }, 200);
      setTimeout(function() { highlightUrlSlot(slot); }, 650);
    }
    try {
      window.parent.postMessage({ type: 'ww-bridge-ready', slot: slot, route: window.location.pathname }, '*');
    } catch (err) {}
  }

  // Editable areas select their matching field; all other clicks and links stay inert.
  document.addEventListener('click', function(e) {
    var node = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    var target = node && node.closest
      ? node.closest('[' + ${JSON.stringify(EDIT_ATTRIBUTE)} + ']') : null;
    e.preventDefault();
    e.stopPropagation();
    var eventCard = !target && node && node.closest ? node.closest('[data-ww-event-id]') : null;
    if (eventCard) {
      var cardBounds = eventCard.getBoundingClientRect();
      var eventImage = eventCard.querySelector('img[data-ww-event-field="imageUrl"], img[data-ww-event-field="image"]');
      var imageBounds = eventImage ? eventImage.getBoundingClientRect() : null;
      try {
        window.parent.postMessage({
          type: 'ww-select-event',
          eventId: eventCard.getAttribute('data-ww-event-id'),
          route: window.location.pathname,
          rect: { left: cardBounds.left, top: cardBounds.top, width: cardBounds.width, height: cardBounds.height },
          imageRect: imageBounds ? { width: imageBounds.width, height: imageBounds.height } : null,
          viewport: { width: window.innerWidth, height: window.innerHeight }
        }, '*');
      } catch (err) {}
      return;
    }
    var banner = !target && node && node.closest ? node.closest('.ww-store-announcement') : null;
    if (banner) {
      var bannerBounds = banner.getBoundingClientRect();
      var bannerIndex = banner.getAttribute('data-ww-banner-index');
      try {
        window.parent.postMessage({
          type: 'ww-select-banner',
          index: bannerIndex === null ? -1 : Number(bannerIndex),
          text: (banner.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
          route: window.location.pathname,
          rect: { left: bannerBounds.left, top: bannerBounds.top, width: bannerBounds.width, height: bannerBounds.height },
          viewport: { width: window.innerWidth, height: window.innerHeight }
        }, '*');
      } catch (err) {}
      return;
    }
    if (!target) {
      // Words the site does not yet declare editable: offer to request the change rather than do nothing.
      var wordsNode = node;
      for (var depth = 0; wordsNode && depth < 4; depth++, wordsNode = wordsNode.parentElement) {
        var own = '';
        for (var c = 0; c < wordsNode.childNodes.length; c++) {
          if (wordsNode.childNodes[c].nodeType === 3) own += wordsNode.childNodes[c].nodeValue;
        }
        if (/[A-Za-z0-9\\u00C0-\\uFFFF]/.test(own) && own.replace(/\\s+/g, ' ').trim().length > 1) break;
      }
      if (!wordsNode || !wordsNode.getBoundingClientRect || /^(HTML|BODY|SCRIPT|STYLE)$/.test(wordsNode.tagName)) return;
      var wordsBounds = wordsNode.getBoundingClientRect();
      try {
        window.parent.postMessage({
          type: 'ww-select-text',
          text: (wordsNode.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
          route: window.location.pathname,
          rect: { left: wordsBounds.left, top: wordsBounds.top, width: wordsBounds.width, height: wordsBounds.height },
          viewport: { width: window.innerWidth, height: window.innerHeight }
        }, '*');
      } catch (err) {}
      return;
    }
    var id = target.getAttribute(${JSON.stringify(EDIT_ATTRIBUTE)});
    if (!id) return;
    select(id);
    var bounds = target.getBoundingClientRect();
    try {
      window.parent.postMessage({
        type: 'ww-select-field',
        id: id,
        route: window.location.pathname,
        rect: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
        viewport: { width: window.innerWidth, height: window.innerHeight }
      }, '*');
    } catch (err) {}
  }, true);

  window.addEventListener('message', function(e) {
    if (e.source !== window.parent || !e.data || e.data.type !== 'ww-highlight') return;
    select(e.data.id);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBridge);
  } else {
    initBridge();
  }
  window.addEventListener('load', function() {
    highlightUrlSlot(new URLSearchParams(window.location.search).get('ww-slot'));
  });
})();
</script>`;

export function contentTransforms(content, { highlight = "", preview = null, origin = "", images = null, attributes = SOURCE_ATTRIBUTES } = {}) {
  const resolved = parseContent(content);
  const transforms = [];
  // A share image has to be an absolute URL, and the address a site answers on is only known per request.
  if (/^https:\/\/[^/]+$/.test(origin)) {
    transforms.push({
      selector: 'meta[property="og:image"], meta[name="twitter:image"]',
      apply(element) {
        const value = element.getAttribute("content");
        if (value && /^\/(?!\/)/.test(value)) element.setAttribute("content", `${origin}${value}`);
      }
    });
  }
  const seoHead = seoHeadHtml(resolved.seo);
  if (seoHead) {
    transforms.push({
      selector: "head",
      apply(element) { element.append(seoHead, { html: true }); }
    });
  }
  if (highlight) {
    transforms.push({
      selector: "head",
      apply(element) { element.append(PREVIEW_STYLE, { html: true }); }
    });
  }
  // A piece inside a link cannot take another (links do not nest), and one inside a <picture> cannot be wrapped, so
  // it is marked first; the next transform reads the mark. Only when somebody has made a link, so a site without
  // any serves exactly as before.
  if (Object.values(resolved.values).some((entry) => entry.link)) {
    transforms.push({
      selector: `a:not([${LINK_ATTRIBUTE}]) [${attributes.edit}], picture [${attributes.edit}]`,
      apply(element) { element.setAttribute(IN_LINK_ATTRIBUTE, "1"); }
    });
  }
  transforms.push({
    selector: `[${attributes.edit}]`,
    apply(element) {
      const id = element.getAttribute(attributes.edit);
      if (highlight && String(id) === highlight) {
        element.setAttribute("data-ww-highlight", "1");
        // An anchor rather than an id on the element itself: a page's own CSS
        // and its own links may depend on the id it already has.
        element.before(`<span id="${HIGHLIGHT_ID}"></span>`, { html: true });
      }
      // An unsaved choice, for this one response. The KIND still comes from
      // the element, so a preview cannot ask for a value to be resolved by
      // rules meant for something else.
      const saved = resolved.values[String(id)];
      const stored = preview && String(id) === String(preview.id)
        ? { value: preview.value, crop: normalizeCrop(preview.crop), ...(saved?.alt ? { alt: saved.alt } : {}), ...(saved?.link ? { link: saved.link } : {}) }
        : saved;
      if (!stored) return;

      // The page's own declaration wins over anything the document claims: the
      // markup is what shipped, the document is what somebody typed.
      const kind = element.getAttribute(attributes.kind);
      if (!isKnownKind(kind)) return;
      const rendered = KINDS[kind].render(stored.value) || {};
      if (kind === "image" && stored.alt) rendered.alt = stored.alt;
      // Dedicated legacy buckets use their own public route; the image index
      // carries that route so every language resolves the same saved photo.
      if (kind === "image" && images?.[stored.value]?.p) rendered.src = images[stored.value].p;
      // A background fills a style and a video fills its player. Neither ever touches the element's
      // contents, which for a background are the words in front of it.
      if (kind === "background") {
        if (!rendered.background) return;
        const declared = backgroundWith(element.getAttribute(BACKGROUND_ATTRIBUTE), rendered.background);
        const kept = styleDeclarations(element.getAttribute("style")).filter((part) => !/^background-image\s*:/i.test(part));
        element.setAttribute("style", [...kept, `background-image:${declared}`].join(";"));
        // The console is re-indexed from the live site, so the tag has to state what is drawn now.
        element.setAttribute(BACKGROUND_ATTRIBUTE, declared);
        return;
      }
      if (kind === "video") {
        if (!rendered.video || element.tagName !== "video") return;
        // The page's own <source> alternatives are encodings of the video it shipped with.
        element.setInnerContent("");
        element.setAttribute("src", rendered.video);
        return;
      }
      const part = element.getAttribute(attributes.part) || "text";
      const link = stored.link || null;
      const inLink = element.getAttribute(IN_LINK_ATTRIBUTE) !== null;
      // Words the owner chose for an address that stays the target: "Contact", not the whole email.
      const words = (kind === "email" || kind === "phone") && link?.text ? link.text : "";

      // The link first. An element whose words are replaced but whose link is
      // not is a link that says one thing and does another.
      if ((part === "link" || part === "both") && rendered.href
        && element.getAttribute("href") !== null) {
        element.setAttribute("href", rendered.href);
      }
      if (link?.href && element.tagName === "a" && (kind === "text" || kind === "multiline")) {
        retargetAnchor(element, link.href, link.newTab);
      }
      if (rendered.src) {
        const style = mergedCropStyle(element.getAttribute("style"), stored.crop);
        if (element.tagName === "img") {
          element.setAttribute("src", rendered.src);
          if (style) element.setAttribute("style", style);
          if (rendered.alt) element.setAttribute("alt", rendered.alt);
          if (link?.href && !inLink) {
            const named = String(element.getAttribute("alt") || "").trim();
            wrapAround(element, linkAnchor(id, link.href, {
              newTab: link.newTab, label: link.text || (named ? "" : element.getAttribute(LABEL_ATTRIBUTE) || "Open link")
            }), "</a>");
          }
        } else {
          // An unfilled slot is a neutral <div role="img">, so filling it means
          // replacing the element rather than setting a src nothing renders.
          // The alt comes from what the page already said the picture should
          // be - data-ww-help, or the aria-label the placeholder carried - so a
          // filled photograph is described without the owner writing anything.
          const described = rendered.alt
            || element.getAttribute(HELP_ATTRIBUTE)
            || element.getAttribute("aria-label")
            || "";
          const classes = element.getAttribute("class") || "";
          // EVERY DECLARATION SURVIVES THE REPLACEMENT.
          //
          // The console is re-indexed from the live site, so an attribute
          // dropped here is a fact the site stops declaring the moment an
          // owner fills the slot. It cost exactly that: a filled photograph
          // came back with no label and no group, so re-indexing filed it
          // under "On this page" with its own id for a name - undoing the
          // thing that had just been fixed, and only for the slots an owner
          // had actually used.
          const carried = [LABEL_ATTRIBUTE, GROUP_ATTRIBUTE, HELP_ATTRIBUTE, SHAPE_ATTRIBUTE, PART_ATTRIBUTE]
            .map((name) => [name, element.getAttribute(name)])
            .filter(([, value]) => value)
            .map(([name, value]) => ` ${attributeText(name, value)}`)
            .join("");
          const picture = `<img ${attributeText(EDIT_ATTRIBUTE, id)} ${attributeText(KIND_ATTRIBUTE, kind)}${carried}`
            + `${classes ? ` ${attributeText("class", classes)}` : ""}`
            + ` ${attributeText("src", rendered.src)} ${attributeText("alt", described)}`
            + `${style ? ` ${attributeText("style", style)}` : ""} loading="lazy">`;
          element.replace(link?.href && !inLink
            ? `${linkAnchor(id, link.href, { newTab: link.newTab, label: link.text || (described.trim() ? "" : "Open link") })}${picture}</a>`
            : picture, { html: true });
          return;
        }
      } else if (kind === "image" && rendered.alt && element.tagName === "img") {
        // The owner kept the page's own photograph and only said what it shows.
        element.setAttribute("alt", rendered.alt);
        if (link?.href && !inLink) {
          const named = String(element.getAttribute("alt") || "").trim();
          wrapAround(element, linkAnchor(id, link.href, {
            newTab: link.newTab, label: link.text || (named ? "" : element.getAttribute(LABEL_ATTRIBUTE) || "Open link")
          }), "</a>");
        }
      } else if (kind === "image" && link?.href && !inLink && element.tagName === "img") {
        // The owner kept the page's own photograph and only linked it.
        const named = String(element.getAttribute("alt") || "").trim();
        wrapAround(element, linkAnchor(id, link.href, {
          newTab: link.newTab, label: link.text || (named ? "" : element.getAttribute(LABEL_ATTRIBUTE) || "Open link")
        }), "</a>");
      }
      if (kind === "date") {
        if (rendered.until && element.getAttribute("data-ww-until") !== null) {
          element.setAttribute("data-ww-until", rendered.until);
        }
        if (part === "attr" || (element.getAttribute("data-ww-until") !== null && part !== "text" && part !== "both")) {
          return;
        }
      }
      const shown = words || rendered.text;
      if ((part === "text" || part === "both" || words) && typeof shown === "string" && (shown || stored.clear)) {
        element.setInnerContent(shown);
      }
      // Words that are not already a link, made one: after the words are in, around whatever the element now holds.
      if (link && !inLink && element.tagName !== "a" && kind !== "image" && !KEEPS_ITS_CONTENT.has(element.tagName)) {
        const target = words ? rendered.href : link.href;
        if (target) wrapContents(element, linkAnchor(id, target, { newTab: words ? undefined : link.newTab }), "</a>");
      }
    }
  });
  // After the owner's own photographs are resolved, so a swapped photo is
  // described by the file it now shows.
  if (images) {
    transforms.push({
      selector: "img[src]",
      apply(element) {
        const name = libraryImageName(element.getAttribute("src"));
        const known = name ? images[name] : null;
        if (!known) return;
        if (known.d && altNeedsDescription(element.getAttribute("alt"), name)) element.setAttribute("alt", known.d);
        // An original far wider than any screen is served at a width a screen can use, as the build does for the
        // pictures it copies (sizeCopiedImages). Career Hunter's blog list showed nine originals, 31 MB, for cards
        // 370 pixels wide, and the page stalled while they were decoded. Only a bare address is changed: one that
        // already asks for a size, or a picture with its own srcset, is left as it was.
        const src = String(element.getAttribute("src") || "").trim();
        if (known.w > SERVED_IMAGE_WIDTH * 1.25 && /^\/images\/[^?#]+\.(?:jpe?g|png|webp|avif)$/i.test(src)
          && element.getAttribute("srcset") === null) {
          element.setAttribute("src", `${src}?w=${SERVED_IMAGE_WIDTH}`);
        }
        // aspect-ratio reserves the space without distorting a photo the stylesheet sizes by one side only.
        if (known.w && known.h && element.getAttribute("width") === null && element.getAttribute("height") === null
          && !/aspect-ratio/i.test(element.getAttribute("style") || "")) {
          const style = String(element.getAttribute("style") || "").trim().replace(/;$/, "");
          element.setAttribute("style", `${style ? `${style};` : ""}aspect-ratio:${known.w}/${known.h}`);
        }
      }
    });
  }
  return transforms;
}

// ---- What a page declares --------------------------------------------------

// The header and footer are tagged with ids of their own (site-content-detect.js proposeChromeTags).
export function chromeArea(id) {
  const text = String(id || "");
  return text.startsWith("site-header-") ? "header" : text.startsWith("site-footer-") ? "footer" : "";
}

// The console renders this and nothing else. Grouped by id, because one value
// appears in many places and is edited once.
export function declaredFields(references) {
  const byId = new Map();
  for (const reference of references || []) {
    if (!isKnownKind(reference?.kind)) continue;
    const id = String(reference.id || "");
    if (!id) continue;
    const field = byId.get(id) || {
      id,
      kind: reference.kind,
      editor: KINDS[reference.kind].editor,
      label: "",
      help: "",
      group: "",
      shape: "",
      until: reference.until || "",
      noLink: false,
      // "header" or "footer": shown on every page and changed once for all of them.
      area: chromeArea(id),
      places: [],
      routes: new Set()
    };
    // Stated once is enough - the label does not have to be repeated on all
    // fifteen elements that carry the id.
    if (!field.label && reference.label) field.label = reference.label;
    if (!field.help && reference.help) field.help = reference.help;
    if (!field.group && reference.group) field.group = reference.group;
    if (!field.shape && reference.shape) field.shape = reference.shape;
    if (!field.until && reference.until) field.until = reference.until;
    if (!field.current && reference.current) field.current = reference.current;
    if (!field.href && reference.href) field.href = reference.href;
    if (field.shownAlt === undefined && reference.shownAlt !== undefined) field.shownAlt = reference.shownAlt;
    // The header's and footer's place in them, so the editor can list a menu in the order a visitor reads it.
    if (field.area && field.order === undefined && Number.isFinite(reference.offset)) field.order = reference.offset;
    // Somewhere it sits inside another link (or a picture frame), so it cannot take a link of its own.
    if (reference.noLink) field.noLink = true;
    field.places.push({ route: reference.route, part: reference.part || "text" });
    if (reference.route) field.routes.add(reference.route);
    byId.set(id, field);
  }
  return [...byId.values()]
    .map((field) => ({
      ...field,
      label: field.label || field.id.replace(/-/g, " "),
      uses: field.places.length,
      routes: [...field.routes].sort()
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
