// A newsletter's template framework: an ordered list of blocks. Each issue is created with its own copy of the
// framework and keeps what was written into it, so changing the framework later never alters an issue that exists.
// Pure and DOM-free: the dated items page edits with it and the Worker validates with it.

export const TEMPLATE_VERSION = 1;
export const MAX_BLOCKS = 60;

export const BLOCK_KINDS = Object.freeze({
  heading: { label: "Heading" },
  text: { label: "Paragraphs" },
  image: { label: "Photo" },
  button: { label: "Button" },
  divider: { label: "Divider" }
});

export const DEFAULT_NEWSLETTER_TEMPLATE = Object.freeze({
  version: TEMPLATE_VERSION,
  name: "Newsletter",
  blocks: Object.freeze([
    { key: "headline", kind: "heading", label: "Headline", required: true },
    { key: "intro", kind: "text", label: "Opening note" },
    { key: "lead_photo", kind: "image", label: "Lead photo" },
    { key: "story_1_title", kind: "heading", label: "First story title" },
    { key: "story_1", kind: "text", label: "First story" },
    { key: "story_2_title", kind: "heading", label: "Second story title" },
    { key: "story_2", kind: "text", label: "Second story" },
    { key: "coming_up_title", kind: "heading", label: "Coming up title" },
    { key: "coming_up", kind: "text", label: "Coming up" },
    { key: "closing", kind: "text", label: "Closing note" },
    { key: "button", kind: "button", label: "Button" }
  ])
});

const KEY = /^[a-z][a-z0-9_]{0,39}$/;

// A web address, a page on the site, an email or a phone number: the same shapes a page link may take.
export function cleanTarget(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 2000 || /[\s<>"`\\]/.test(text)) return null;
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  if (/^mailto:[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/i.test(text) || /^tel:\+?[\d().-]{5,25}$/i.test(text)) return text;
  try {
    const url = new URL(text);
    return ["https:", "http:"].includes(url.protocol) && url.hostname ? url.href : null;
  } catch { return null; }
}

const oneLine = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function cloneTemplate(template) {
  return JSON.parse(JSON.stringify(template));
}

export function normalizePresentation(input, keys) {
  if (!input || input.kind !== "pdf-layout" || !Array.isArray(input.pages) || input.pages.length > 16) return null;
  const number = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const colour = (value) => /^#[0-9a-f]{6}$/i.test(value || "") ? value : "#000000";
  const pages = input.pages.map((page) => ({
    width: number(page.width, 1, 4000), height: number(page.height, 1, 4000),
    nodes: (Array.isArray(page.nodes) ? page.nodes : []).slice(0, 6000).filter((node) => keys.has(node.key)).map((node) => ({
      key: node.key, x: number(node.x, -4000, 4000), y: number(node.y, -4000, 4000),
      width: number(node.width, 0, 4000), height: number(node.height, 0, 4000),
      size: number(node.size, 1, 300), font: String(node.font || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      colour: colour(node.colour), weight: node.weight === 700 ? 700 : 400, italic: node.italic === true,
      rotation: number(node.rotation, -360, 360), scale: number(node.scale ?? 1, 0.01, 20),
      text: String(node.text || "").slice(0, 2000), glyphs: String(node.glyphs || "").slice(0, 2000)
    })),
    images: (Array.isArray(page.images) ? page.images : []).slice(0, 100).map((image) => ({
      src: cleanTarget(image.src) || "", key: keys.has(image.key) ? image.key : "",
      x: number(image.x, -4000, 4000), y: number(image.y, -4000, 4000),
      width: number(image.width, 0, 4000), height: number(image.height, 0, 4000), alt: oneLine(image.alt, 300)
    })).filter((image) => image.src),
    artwork: cleanTarget(page.artwork) || ""
  }));
  const fonts = (Array.isArray(input.fonts) ? input.fonts : []).slice(0, 60).map((font) => ({
    id: String(font.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
    src: cleanTarget(font.src) || "", family: ["serif", "sans-serif", "monospace"].includes(font.family) ? font.family : "serif"
  })).filter((font) => font.id && font.src);
  const original = Object.fromEntries(Object.entries(input.original || {}).filter(([key]) => keys.has(key)).map(([key, value]) => [key,
    typeof value === "string" ? value.slice(0, 20000) : value && typeof value === "object" ? { src: cleanTarget(value.src) || "" } : ""
  ]));
  return { kind: "pdf-layout", pages, fonts, original };
}

// The framework as it may be stored: known kinds, unique keys, readable names. Anything else is an owner-readable error.
export function normalizeTemplate(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!source || !Array.isArray(source.blocks)) throw new Error("A newsletter layout needs a list of blocks.");
  if (!source.blocks.length || source.blocks.length > MAX_BLOCKS) throw new Error(`A newsletter layout needs between 1 and ${MAX_BLOCKS} blocks.`);
  const seen = new Set();
  const blocks = source.blocks.map((block) => {
    const kind = String(block?.kind || "");
    if (!Object.hasOwn(BLOCK_KINDS, kind)) throw new Error(`"${kind || "(none)"}" is not a kind of block a newsletter can hold.`);
    const key = String(block?.key || "");
    if (!KEY.test(key) || seen.has(key)) throw new Error("Every block needs its own short name made of lowercase letters, numbers and underscores.");
    seen.add(key);
    const hint = oneLine(block.hint, 200);
    return {
      key, kind, label: oneLine(block.label, 80) || BLOCK_KINDS[kind].label,
      ...(block.required === true && kind !== "divider" ? { required: true } : {}),
      ...(hint ? { hint } : {})
    };
  });
  const presentation = normalizePresentation(source.presentation, seen);
  return { version: TEMPLATE_VERSION, name: oneLine(source.name, 80) || "Newsletter", blocks,
    ...(presentation ? { presentation } : {}) };
}

export function newBlockKey(template, kind) {
  const taken = new Set((template?.blocks || []).map((block) => block.key));
  for (let number = 1; number < 1000; number += 1) {
    const key = `${kind}_${number}`;
    if (!taken.has(key)) return key;
  }
  return `${kind}_${Date.now()}`;
}

const cleanText = (value) => String(value ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// One block's value in the shape its kind stores, or null when there is nothing in it.
export function cleanBlockValue(block, raw) {
  if (block.kind === "heading") return oneLine(raw, 300) || null;
  if (block.kind === "text") {
    const text = cleanText(raw);
    if (text.length > 20000) throw new Error(`${block.label} is too long.`);
    return text || null;
  }
  if (block.kind === "image") {
    const source = raw && typeof raw === "object" ? raw : {};
    const src = String(source.src ?? "").trim() ? cleanTarget(source.src) : null;
    if (String(source.src ?? "").trim() && !src) throw new Error(`${block.label} needs a web address or a photo from your website.`);
    if (!src) return null;
    return { src, alt: oneLine(source.alt, 300), caption: oneLine(source.caption, 500) };
  }
  if (block.kind === "button") {
    const source = raw && typeof raw === "object" ? raw : {};
    const label = oneLine(source.label, 80);
    const url = String(source.url ?? "").trim() ? cleanTarget(source.url) : null;
    if (String(source.url ?? "").trim() && !url) throw new Error(`${block.label} needs a web address, a page on your website, an email or a phone number.`);
    return label && url ? { label, url } : null;
  }
  return null;
}

// What an issue stores: only the blocks its own framework has. A draft may be unfinished; a published issue must
// have what the framework calls required, and `missing` names what does not.
export function cleanContent(template, input, { forPublish = false } = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const content = {};
  const missing = [];
  for (const block of template.blocks) {
    if (block.kind === "divider") continue;
    const value = cleanBlockValue(block, source[block.key]);
    if (value === null) {
      if (forPublish && block.required) missing.push(block.label);
      continue;
    }
    content[block.key] = value;
  }
  return { content, missing };
}

export function blockHasValue(block, value) {
  if (block.kind === "divider") return true;
  try { return cleanBlockValue(block, value) !== null; } catch { return false; }
}
