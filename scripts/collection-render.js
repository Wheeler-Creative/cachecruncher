// How a blog post or a repeating page looks, and its list page. Pure and DOM-free: the owner's preview, the platform
// Worker and each website's own Worker draw the same markup from it.
//
// A list's design is a handful of named choices, never CSS: whatever is chosen, the page keeps the website's own
// fonts and colours, because it is drawn inside the website's own header and footer.

import { cleanTarget } from "./newsletter-blocks.js";

// 6: pages drawn block by block from the pattern their set shares, links between lists, pages that stay the
// website's own, lists with no list page.
export const COLLECTIONS_RENDER_VERSION = 6;

// look: "site" draws the list in the website's own design when one was kept from its pages (see
// src/collection-stencil.js); "simple" always uses the layout below. Without a kept design both are the simple layout.
export const DESIGN_CHOICES = Object.freeze({
  look: Object.freeze(["site", "simple"]),
  layout: Object.freeze(["stacked", "side"]),
  photo: Object.freeze(["wide", "square", "portrait", "round"]),
  width: Object.freeze(["narrow", "wide"]),
  index: Object.freeze(["cards", "list", "grid"])
});

export const DESIGN_DEFAULTS = Object.freeze({
  blog: Object.freeze({ look: "site", layout: "stacked", photo: "wide", width: "narrow", index: "cards" }),
  pages: Object.freeze({ look: "site", layout: "side", photo: "portrait", width: "wide", index: "grid" })
});

export function normalizeDesign(input, preset = "pages") {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const defaults = DESIGN_DEFAULTS[preset] || DESIGN_DEFAULTS.pages;
  return Object.fromEntries(Object.entries(DESIGN_CHOICES).map(([name, choices]) => [name,
    choices.includes(source[name]) ? source[name] : defaults[name]]));
}

const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const unescape = (text) => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name]);

// **bold**, *italic* and [words](address) inside one line, after everything else was escaped.
const emphasis = (html) => html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");

function inline(text) {
  // Links are set aside first, so an asterisk in an address is never read as emphasis.
  const links = [];
  // A backslash keeps the mark after it as it is written: \* is an asterisk, never emphasis.
  const html = escape(text).replace(/\u0000/g, "").replace(/\\([\\*])/g, (whole, mark) => (mark === "*" ? "&#42;" : "&#92;"))
    .replace(/\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/g, (whole, label, address) => {
    const target = cleanTarget(unescape(address));
    if (!target) return label;
    links.push(`<a href="${escape(target)}"${/^https?:/i.test(target) ? ' rel="noopener"' : ""}>${emphasis(label)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  return emphasis(html).replace(/\u0000(\d+)\u0000/g, (_, index) => links[Number(index)]);
}

// The little writing a text box allows: paragraphs (a blank line between them), ## and ### subheadings, - and 1. lists,
// > quotes, a photo on a line of its own as ![what it shows](address "caption"), --- for a line across, **bold**, *italic*
// and [words](address). Nothing typed can become markup of its own.
//
// A part of a page kept in the website's own design says how its writing was marked up there (options): headings are
// the heading tags it used, in order (["h4", "h5", "h6"]: ## is an h4); quoteP whether a quote holds paragraphs; figure
// the website's own markup around a photo; inline for a single paragraph or line, where the writing has no blocks.
const PHOTO_LINE = /^!\[([^\]\n]{0,300})\]\(([^)\s]{1,2000})(?:\s+"([^"\n]{0,500})")?\)$/;

function photoLine(match, figure) {
  const src = cleanTarget(match[2]);
  if (!src) return "";
  const values = { src: escape(src), alt: escape(match[1] || ""), caption: escape(match[3] || "") };
  if (figure) return fillStencil(figure, values);
  return `<figure class="ww-collection-photo"><img src="${values.src}" alt="${values.alt}" loading="lazy" decoding="async">`
    + `${values.caption ? `<figcaption>${values.caption}</figcaption>` : ""}</figure>`;
}

export function richText(value, options = {}) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (options?.inline) {
    const paragraphs = [[]];
    for (const raw of lines) { if (raw.trim()) paragraphs.at(-1).push(raw.trim().replace(/^\\(?=[^\\*])/, "")); else if (paragraphs.at(-1).length) paragraphs.push([]); }
    return paragraphs.filter((part) => part.length).map((part) => part.map(inline).join("<br>")).join("<br><br>");
  }
  const levels = (Array.isArray(options?.headings) ? options.headings : []).filter((tag) => /^h[1-6]$/.test(tag));
  const headings = levels.length ? levels : ["h2", "h3"];
  const figure = typeof options?.figure === "string" && options.figure.includes("{{ww:src}}") ? options.figure : "";
  const out = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  const flushParagraph = () => { if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`); paragraph = []; };
  const flushList = () => { if (list) out.push(`<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.type}>`); list = null; };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${options?.quoteP ? `<p>${quote.map(inline).join("<br>")}</p>` : quote.map(inline).join("<br>")}</blockquote>`);
    quote = [];
  };
  const flush = () => { flushParagraph(); flushList(); flushQuote(); };
  for (const raw of lines) {
    const line = raw.trim();
    // A line that starts with a backslash is a paragraph, however it goes on.
    if (/^\\[^\\*]/.test(line)) { flushList(); flushQuote(); paragraph.push(line.slice(1)); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    const ordered = /^\d{1,3}[.)]\s+(.+)$/.exec(line);
    const quoted = /^>\s?(.*)$/.exec(line);
    const photo = PHOTO_LINE.exec(line);
    if (!line) flush();
    else if (photo) { flush(); out.push(photoLine(photo, figure)); }
    else if (/^-{3,}$/.test(line)) { flush(); out.push("<hr>"); }
    else if (heading) {
      flush();
      const tag = headings[Math.min(headings.length - 1, Math.max(0, heading[1].length - 2))];
      out.push(`<${tag}>${inline(heading[2])}</${tag}>`);
    } else if (quoted) { flushParagraph(); flushList(); if (quoted[1].trim()) quote.push(quoted[1].trim()); }
    else if (bullet || ordered) {
      flushParagraph(); flushQuote();
      const type = bullet ? "ul" : "ol";
      if (list?.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push((bullet || ordered)[1]);
    } else { flushList(); flushQuote(); paragraph.push(line); }
  }
  flush();
  return out.join("");
}

// How long a date is written: "September 2, 2026" (long) unless the website's own cards wrote theirs another way.
export const DATE_STYLES = Object.freeze(["long", "medium", "short", "full"]);

export function formatItemDate(date, language = "en", style = "long") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return "";
  try {
    return new Intl.DateTimeFormat(language || "en", { dateStyle: DATE_STYLES.includes(style) ? style : "long", timeZone: "UTC" })
      .format(new Date(`${date}T00:00:00Z`));
  } catch { return date; }
}

// path is the folder a list's pages are in; listPath is its list page when the website keeps that somewhere else
// (posts at /post/..., listed at /blog/).
const listPath = (list) => list.path || `/${list.id}/`;
const listPagePath = (list) => list.listPath || listPath(list);
const itemPath = (list, item) => item.path || `${listPath(list)}${item.slug}/`;

export function firstImage(template, content) {
  const block = (template?.blocks || []).find((candidate) => candidate.kind === "image" && content?.[candidate.key]?.src);
  return block ? content[block.key] : null;
}

const STYLE = `<style data-ww-collection>
.ww-collection{box-sizing:border-box;width:100%;max-width:72rem;margin:0 auto;padding:clamp(1.5rem,4vw,3.5rem) clamp(1rem,4vw,2rem);color:inherit;font:inherit;line-height:1.65;text-align:start}
.ww-collection *{box-sizing:border-box}.ww-collection--narrow{max-width:46rem}
.ww-collection h1{margin:0 0 .5rem;font-size:clamp(1.9rem,4.5vw,2.8rem);line-height:1.15}
.ww-collection h2{margin:2rem 0 .75rem;font-size:clamp(1.3rem,3vw,1.6rem);line-height:1.25}.ww-collection h3{margin:1.5rem 0 .5rem;font-size:1.2rem;line-height:1.3}
.ww-collection p,.ww-collection ul,.ww-collection ol{margin:0 0 1rem}.ww-collection li{margin:0 0 .35rem}
.ww-collection a{color:inherit;text-decoration:underline;text-underline-offset:.15em}
.ww-collection img{display:block;max-width:100%;height:auto;border-radius:6px}
.ww-collection figure{margin:1.5rem 0}.ww-collection figcaption{margin-top:.45rem;font-size:.9em;opacity:.75}
.ww-collection hr{margin:2rem 0;border:0;border-top:1px solid currentColor;opacity:.2}
.ww-collection-back{margin:0 0 1.25rem;font-size:.95em}.ww-collection-date{margin:0 0 1.5rem;opacity:.75}
.ww-collection-head{margin-bottom:1.5rem}.ww-collection-intro{max-width:46rem;font-size:1.08em}
.ww-collection-button{display:inline-block;padding:.65rem 1.25rem;border:2px solid currentColor;border-radius:999px;font-weight:600;text-decoration:none!important}
.ww-collection-photo img{width:100%;object-fit:cover}
.ww-photo-wide .ww-collection-photo img{aspect-ratio:16/9}.ww-photo-square .ww-collection-photo img{aspect-ratio:1}
.ww-photo-portrait .ww-collection-photo img{aspect-ratio:4/5}.ww-photo-round .ww-collection-photo img{aspect-ratio:1;border-radius:50%}
.ww-collection--side .ww-collection-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:clamp(1.5rem,4vw,3rem);align-items:start}
.ww-collection--side .ww-collection-aside figure{margin-top:0}.ww-collection--side.ww-photo-round .ww-collection-aside img{max-width:18rem}
.ww-collection-items{display:grid;gap:clamp(1rem,3vw,2rem);margin:2rem 0 0;padding:0;list-style:none}
.ww-collection-items>li{margin:0}.ww-collection-card h2{margin:.75rem 0 .35rem;font-size:1.25rem}.ww-collection-card p{margin:0 0 .5rem}
.ww-collection-card h2 a{text-decoration:none}.ww-collection-card h2 a:hover,.ww-collection-card h2 a:focus-visible{text-decoration:underline}
.ww-index-cards{grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr))}
.ww-index-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,12rem),1fr));text-align:center}.ww-index-grid .ww-collection-photo img{margin:0 auto}
.ww-index-list>li{display:grid;grid-template-columns:minmax(0,9rem) minmax(0,1fr);gap:1.25rem;align-items:start;padding-bottom:1.5rem;border-bottom:1px solid rgba(127,127,127,.25)}
.ww-index-list>li:not(:has(.ww-collection-photo)){grid-template-columns:minmax(0,1fr)}.ww-index-list .ww-collection-card h2{margin-top:0}
.ww-collection-empty{opacity:.75}
@media(max-width:700px){.ww-collection--side .ww-collection-body{grid-template-columns:1fr}.ww-index-list>li{grid-template-columns:minmax(0,6rem) minmax(0,1fr)}}
</style>`;

function photoMarkup(image, { lazy = true } = {}) {
  if (!image?.src) return "";
  const src = cleanTarget(image.src);
  if (!src) return "";
  return `<figure class="ww-collection-photo"><img src="${escape(src)}" alt="${escape(image.alt || "")}"${lazy ? ' loading="lazy"' : ""} decoding="async">`
    + `${image.caption ? `<figcaption>${escape(image.caption)}</figcaption>` : ""}</figure>`;
}

function blockMarkup(block, value, options) {
  if (block.kind === "divider") return "<hr>";
  if (value === undefined || value === null || value === "") return "";
  if (block.kind === "heading") return `<h2>${escape(value)}</h2>`;
  if (block.kind === "text") return richText(value);
  if (block.kind === "image") return photoMarkup(value, options);
  if (block.kind === "button") {
    const url = cleanTarget(value?.url);
    return url && value.label ? `<p><a class="ww-collection-button" href="${escape(url)}">${escape(value.label)}</a></p>` : "";
  }
  return "";
}

function designClasses(design, extra = "") {
  return ["ww-collection", `ww-collection--${design.width}`, `ww-collection--${design.layout}`, `ww-photo-${design.photo}`, extra].filter(Boolean).join(" ");
}

// One page of a list: its title, its date when the list keeps dates, then its blocks in the list's layout.
export function renderItemFragment(list, item, { language = "en" } = {}) {
  const design = normalizeDesign(list.design, list.preset);
  const blocks = list.template?.blocks || [];
  const content = item.content || {};
  const leadIndex = design.layout === "side" ? blocks.findIndex((block) => block.kind === "image" && content[block.key]?.src) : -1;
  let firstPhoto = true;
  const draw = (block) => {
    const html = blockMarkup(block, content[block.key], { lazy: !(block.kind === "image" && firstPhoto) });
    if (block.kind === "image" && html) firstPhoto = false;
    return html;
  };
  const lead = leadIndex >= 0 ? draw(blocks[leadIndex]) : "";
  const rest = blocks.filter((_, index) => index !== leadIndex).map(draw).join("");
  const date = list.dates !== "none" && item.date ? `<p class="ww-collection-date"><time datetime="${escape(item.date)}">${escape(formatItemDate(item.date, language))}</time></p>` : "";
  const body = `<article class="${designClasses(design)}" data-ww-collection="${escape(list.id)}">`
    + `<p class="ww-collection-back"><a href="${escape(listPagePath(list))}">&larr; ${escape(list.title)}</a></p>`
    + `<header class="ww-collection-head"><h1>${escape(item.title)}</h1>${date}</header>`
    + (design.layout === "side" && lead
      ? `<div class="ww-collection-body"><div class="ww-collection-aside">${lead}</div><div class="ww-collection-main-column">${rest}</div></div>`
      : `<div class="ww-collection-content">${rest}</div>`)
    + "</article>";
  return { head: STYLE, body };
}

// A list's own page: its title, the owner's introduction, and a card for each published page.
export function renderListFragment(list, { language = "en", empty = "" } = {}) {
  const design = normalizeDesign(list.design, list.preset);
  const cards = (list.items || []).map((item) => {
    const href = escape(itemPath(list, item));
    const image = item.image || (item.imageUrl ? { src: item.imageUrl, alt: "" } : null);
    const date = list.dates !== "none" && item.date ? `<p class="ww-collection-date"><time datetime="${escape(item.date)}">${escape(formatItemDate(item.date, language))}</time></p>` : "";
    return `<li class="ww-collection-card">${image?.src ? photoMarkup({ src: image.src, alt: "" }) : ""}`
      + `<div><h2><a href="${href}">${escape(item.title)}</a></h2>${date}${item.summary ? `<p>${escape(item.summary)}</p>` : ""}</div></li>`;
  }).join("");
  const body = `<section class="${designClasses(design, "ww-collection-index")}" data-ww-collection="${escape(list.id)}">`
    + `<header class="ww-collection-head"><h1>${escape(list.title)}</h1>${list.intro ? `<div class="ww-collection-intro">${richText(list.intro)}</div>` : ""}</header>`
    + (cards ? `<ul class="ww-collection-items ww-index-${design.index}">${cards}</ul>` : empty ? `<p class="ww-collection-empty">${escape(empty)}</p>` : "")
    + "</section>";
  return { head: STYLE, body };
}

// A whole page for a frame or a website that cannot lend its own header and footer.
export function renderStandalonePage(fragment, { title = "", origin = "", language = "en" } = {}) {
  return `<!doctype html><html lang="${escape(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `${origin ? `<base href="${escape(origin)}/">` : ""}<title>${escape(title)}</title>${fragment.head}</head>`
    + `<body style="margin:0;font-family:system-ui,sans-serif;color:#1f2328;background:#fff"><main>${fragment.body}</main></body></html>`;
}

// A stencil kept from the website's own pages, with its slots filled. Optional parts ({{ww-if:x}}...{{ww-end:x}}) stay
// only when x has a value, and {{ww-unless:x}} parts only when it has none; a part may carry a number (x~3) so that
// parts can sit inside one another. Every value is escaped here except the writing and the cards, which are drawn here too.
export function fillStencil(markup, values) {
  let text = String(markup || "");
  for (let pass = 0; pass < 8 && /\{\{ww-(?:if|unless):/.test(text); pass += 1) {
    text = text.replace(/\{\{ww-(if|unless):([a-z0-9_:-]+)(~\d+)?\}\}([\s\S]*?)\{\{ww-end:\2\3\}\}/g,
      (_, kind, key, number, inner) => ((kind === "if") === Boolean(values[key]) ? inner : ""));
  }
  return text.replace(/\{\{ww:([a-z0-9_:-]+)\}\}/g, (_, key) => values[key] ?? "");
}

function stencilValues(list, item, language, stencil = null) {
  // A card's photo is the page's first unless its cards show a photo of their own (slots.imageKey).
  const keyed = stencil?.slots?.imageKey ? item.images?.[stencil.slots.imageKey] || item.content?.[stencil.slots.imageKey]?.src : null;
  const image = keyed ? { src: keyed } : item.image?.src ? item.image : firstImage(list.template, item.content) || (item.imageUrl ? { src: item.imageUrl } : null);
  const src = image?.src ? cleanTarget(image.src) : null;
  const values = {
    url: escape(item.path || ""), title: escape(item.title), image: src ? escape(src) : "", "image-alt": escape(image?.alt || ""),
    summary: escape(item.summary || ""),
    date: list.dates !== "none" && item.date ? escape(formatItemDate(item.date, language, stencil?.slots?.dateStyle)) : "",
    "date-iso": escape(item.date || "")
  };
  for (const [key, value] of Object.entries(item.extras || {})) values[`x:${key}`] = escape(value);
  for (const block of list.template?.blocks || []) {
    if (block.kind === "heading" && item.content?.[block.key]) values[`x:${block.key}`] = escape(item.content[block.key]);
  }
  return values;
}

// Pages drawn as cards, each in the card kept from one of the website's own (a list page's, or a place's on another page).
export function renderStencilCards(list, stencil, items, { language = "en" } = {}) {
  return items.map((item) => fillStencil(stencil.card, stencilValues(list, item, language, stencil))).join("");
}

// The list page in the website's own design: its page, with a card drawn from its own card for each page.
export function renderStencilList(list, stencil, { language = "en", items = [], title = "" } = {}) {
  return { head: "", body: fillStencil(stencil.main, { items: renderStencilCards(list, stencil, items, { language }), "list-title": escape(title || list.title) }) };
}

// A page drawn from the pattern its set shares (src/page-pattern.js): every field goes back into the place it had on
// the website's own pages. A line is words; writing is drawn as the page marked its writing up; a photo, a link and
// a choice fill their own slots; links to pages of another set are that set's pages (item.refs, written when the
// website's files are) drawn in the card the website already used. `mark` wraps writing so a check can tell it
// from the layout around it; it is never used on the website.
export function renderPatternItem(list, pattern, item, { language = "en", mark = false } = {}) {
  const content = item.content || {};
  const values = { url: escape(item.path || ""), title: escape(item.title),
    date: list.dates !== "none" && item.date ? escape(formatItemDate(item.date, language, pattern.slots?.dateStyle)) : "",
    "date-iso": escape(item.date || "") };
  for (const field of pattern.fields || []) {
    const value = content[field.key];
    if (field.kind === "heading") { if (typeof value === "string" && value) values[`x:${field.key}`] = escape(value); }
    else if (field.kind === "text") {
      const html = typeof value === "string" && value ? (field.plain ? escape(value) : richText(value, field)) : "";
      if (html) values[`t:${field.key}`] = mark ? `<ww-f>${html}</ww-f>` : html;
    } else if (field.kind === "image") {
      const src = value?.src ? cleanTarget(value.src) : null;
      if (src) { values[`i:${field.key}`] = escape(src); values[`i:${field.key}:alt`] = escape(value.alt || ""); }
    } else if (field.kind === "link") {
      const target = typeof value === "string" ? cleanTarget(value) : null;
      if (target) values[`u:${field.key}`] = escape(target);
    } else if (field.kind === "links") {
      const cards = renderLinkCards(field, item.refs?.[field.key]);
      if (cards) values[`r:${field.key}`] = cards;
    } else if (field.kind === "choice") {
      const options = (field.options || []).map((option) => option.id);
      values[`c:${field.key}:${options.includes(value) ? value : options[0]}`] = "1";
    }
  }
  return { head: "", body: fillStencil(pattern.main, values) };
}

// The pages a page links to, each in the card kept from the website. refs: [{ url, title, ...the card's own slots }].
export function renderLinkCards(field, refs) {
  return (Array.isArray(refs) ? refs : []).filter((ref) => ref && typeof ref === "object" && cleanTarget(ref.url)).slice(0, 60).map((ref) => {
    const values = {};
    for (const [key, value] of Object.entries(ref)) {
      if (typeof value !== "string" || !value) continue;
      values[key] = escape(key === "url" || key.startsWith("u:") || (key.startsWith("i:") && !key.endsWith(":alt")) ? cleanTarget(value) || "" : value);
    }
    return fillStencil(field.card, values);
  }).join("");
}

// One page in the website's own design. Its blocks are drawn into the place the old page had its writing, except the
// cover photo and the words the stencil has slots of its own for.
export function renderStencilItem(list, stencil, item, { language = "en" } = {}) {
  if (stencil?.v >= 2 && Array.isArray(stencil.fields)) return renderPatternItem(list, stencil, item, { language });
  const blocks = list.template?.blocks || [];
  const content = item.content || {};
  const values = stencilValues(list, item, language, stencil);
  const cover = stencil.coverInBody ? null : blocks.find((block) => block.kind === "image" && content[block.key]?.src);
  const slotted = new Set([cover?.key, ...(stencil.extras || []).map((extra) => extra.key)]);
  if (cover) { values.image = escape(cleanTarget(content[cover.key].src) || ""); values["image-alt"] = escape(content[cover.key].alt || ""); }
  const date = list.dates !== "none" && item.date && !stencil.slots?.date
    ? `<p class="ww-collection-date"><time datetime="${escape(item.date)}">${escape(formatItemDate(item.date, language))}</time></p>` : "";
  values.body = date + blocks.filter((block) => !slotted.has(block.key)).map((block) => blockMarkup(block, content[block.key], { lazy: true })).join("");
  return { head: "", body: fillStencil(stencil.main, values) };
}
