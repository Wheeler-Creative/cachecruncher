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

// Attributes for markup this file writes itself. Escaped, because the values
// come from a content document somebody typed into.
function attributeText(name, value) {
  return `${name}="${String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"`;
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
    // Text is deliberately absent: a social link's words are usually
    // "Instagram" or an icon, and replacing them with the URL would be worse
    // than leaving them.
    render: (value) => ({ href: trimmed(value) })
  },
  image: {
    editor: "image",
    // A file this site has, resolved to the path its own worker serves.
    render: (value) => ({ src: trimmed(value) ? `/images/${trimmed(value)}` : "" })
  }
});

export function isKnownKind(kind) {
  return Object.hasOwn(KINDS, String(kind));
}

// ---- The stored document ---------------------------------------------------

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
    // An empty string is not "no opinion", it is a value nobody set, and
    // resolving it would blank out the page's own working fallback.
    if (!value) continue;
    // An image is a file name, and this becomes a path on the site from a
    // request body: a name that could climb out of the media prefix is refused.
    if (kind === "image" && (value.includes("/") || value.includes(".."))) continue;
    values[id] = kind ? { value, kind } : { value };
  }
  return { version: CONTENT_VERSION, values };
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
[data-ww-highlight]{outline:3px solid #2f6df6 !important;outline-offset:3px;scroll-margin-top:120px;}
#${HIGHLIGHT_ID}{display:block;position:relative;top:-110px;height:0;visibility:hidden;}
</style>`;

export function contentTransforms(content, { highlight = "", preview = null } = {}) {
  const resolved = parseContent(content);
  const transforms = [];
  if (highlight) {
    transforms.push({
      selector: "head",
      apply(element) { element.append(PREVIEW_STYLE, { html: true }); }
    });
  }
  transforms.push({
    selector: `[${EDIT_ATTRIBUTE}]`,
    apply(element) {
      const id = element.getAttribute(EDIT_ATTRIBUTE);
      if (highlight && String(id) === highlight) {
        element.setAttribute("data-ww-highlight", "1");
        // An anchor rather than an id on the element itself: a page's own CSS
        // and its own links may depend on the id it already has.
        element.before(`<span id="${HIGHLIGHT_ID}"></span>`, { html: true });
      }
      // An unsaved choice, for this one response. The KIND still comes from
      // the element, so a preview cannot ask for a value to be resolved by
      // rules meant for something else.
      const stored = preview && String(id) === String(preview.id)
        ? { value: preview.value }
        : resolved.values[String(id)];
      if (!stored) return;

      // The page's own declaration wins over anything the document claims: the
      // markup is what shipped, the document is what somebody typed.
      const kind = element.getAttribute(KIND_ATTRIBUTE);
      if (!isKnownKind(kind)) return;
      const rendered = KINDS[kind].render(stored.value) || {};
      const part = element.getAttribute(PART_ATTRIBUTE) || "text";

      // The link first. An element whose words are replaced but whose link is
      // not is a link that says one thing and does another.
      if ((part === "link" || part === "both") && rendered.href
        && element.getAttribute("href") !== null) {
        element.setAttribute("href", rendered.href);
      }
      if (rendered.src) {
        if (element.tagName === "img") {
          element.setAttribute("src", rendered.src);
          if (rendered.alt) element.setAttribute("alt", rendered.alt);
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
          element.replace(
            `<img ${attributeText(EDIT_ATTRIBUTE, id)} ${attributeText(KIND_ATTRIBUTE, kind)}${carried}`
            + `${classes ? ` ${attributeText("class", classes)}` : ""}`
            + ` ${attributeText("src", rendered.src)} ${attributeText("alt", described)} loading="lazy">`,
            { html: true }
          );
          return;
        }
      }
      if ((part === "text" || part === "both") && typeof rendered.text === "string" && rendered.text) {
        element.setInnerContent(rendered.text);
      }
    }
  });
  return transforms;
}

// ---- What a page declares --------------------------------------------------

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
      current: "",
      places: [],
      routes: new Set()
    };
    // Stated once is enough - the label does not have to be repeated on all
    // fifteen elements that carry the id.
    if (!field.label && reference.label) field.label = reference.label;
    if (!field.help && reference.help) field.help = reference.help;
    if (!field.group && reference.group) field.group = reference.group;
    if (!field.shape && reference.shape) field.shape = reference.shape;
    if (!field.current && reference.current) field.current = reference.current;
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
