// Web issues retain their PDF layout and fit source glyphs after fonts load. Email output remains a script-free column.
// Owner text is escaped; PDF font glyphs are nonselectable decoration beside one canonical readable text layer.

import { cleanTarget, normalizePresentation } from "./newsletter-blocks.js";

export const NEWSLETTER_RENDER_VERSION = 5;

// The script a web issue carries to fit each PDF glyph run to its column once the fonts are in. A fixed text, on
// purpose: the portal shows the issue in its preview frame page, whose content security policy allows this script
// by the hash of exactly this text (NEWSLETTER_FIT_SCRIPT_HASH in src/security-headers.js; the test recomputes it),
// so a change here is a change there. Customer websites serve it under their own headers.
export const NEWSLETTER_FIT_SCRIPT = `(()=>{
const fitNewsletter=()=>{
  const runs=[...document.querySelectorAll('.pdf-run')].filter(run=>run.getBoundingClientRect().width>0);
  for(const run of runs)run.firstElementChild.style.transform='none';
  const scales=runs.map(run=>{const glyph=run.firstElementChild;return{glyph,scale:run.getBoundingClientRect().width/(glyph.getBoundingClientRect().width||1)}});
  for(const {glyph,scale} of scales)glyph.style.transform='scaleX('+scale+')';
};
let frame;
const scheduleFit=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(fitNewsletter)};
(document.fonts?document.fonts.ready:Promise.resolve()).then(scheduleFit);
if(document.fonts){document.fonts.addEventListener('loadingdone',scheduleFit);document.fonts.addEventListener('loadingerror',scheduleFit)}
if(window.ResizeObserver){const observer=new ResizeObserver(scheduleFit);for(const page of document.querySelectorAll('.pdf-page'))observer.observe(page)}
})();`;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

function absolute(target, origin) {
  const clean = cleanTarget(target);
  if (!clean || !clean.startsWith("/")) return clean || "";
  try { return new URL(clean, origin).href; } catch { return clean; }
}

const paragraphs = (text) => String(text || "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);

export function issueDateLabel(issueDate, language = "en") {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(issueDate || ""));
  if (!match) return "";
  try {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      .toLocaleDateString(language, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  } catch { return match[0]; }
}

export function renderIssueHtml(issue, { siteName = "", origin = "", accent = "#1f5885", language = "en", format = "web", downloadUrl = "" } = {}) {
  if (["web", "fragment"].includes(format) && issue?.template?.presentation?.kind === "pdf-layout") return renderPdfIssue(issue, { origin, language, downloadUrl, fragment: format === "fragment" });
  const template = issue?.template?.blocks ? issue.template : { blocks: [] };
  const content = issue?.content || {};
  const safeAccent = /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#1f5885";
  let firstHeading = true;
  const body = [];
  for (const block of template.blocks) {
    const value = content[block.key];
    if (block.kind === "divider") {
      body.push('<hr style="border:0;border-top:1px solid #dde3ea;margin:26px 0">');
    } else if (block.kind === "heading" && value) {
      const level = firstHeading ? "h1" : "h2";
      const size = firstHeading ? 30 : 21;
      const above = firstHeading ? 0 : 26;
      const below = firstHeading ? 14 : 10;
      firstHeading = false;
      body.push(`<${level} style="margin:${above}px 0 ${below}px;font:700 ${size}px/1.25 Georgia,'Times New Roman',serif;color:#14202b">${escapeHtml(value)}</${level}>`);
    } else if (block.kind === "text" && value) {
      for (const part of paragraphs(value)) {
        body.push(`<p style="margin:0 0 14px;font:16px/1.65 Georgia,'Times New Roman',serif;color:#1e2a36">${escapeHtml(part).replace(/\n/g, "<br>")}</p>`);
      }
    } else if (block.kind === "image" && value?.src) {
      const src = absolute(value.src, origin);
      if (src) {
        body.push(`<img src="${escapeHtml(src)}" alt="${escapeHtml(value.alt || "")}" width="576" style="display:block;width:100%;max-width:576px;height:auto;margin:18px 0 6px;border:0;border-radius:8px">`);
        if (value.caption) body.push(`<p style="margin:0 0 16px;font:13px/1.5 Arial,Helvetica,sans-serif;color:#5b6773">${escapeHtml(value.caption)}</p>`);
      }
    } else if (block.kind === "button" && value?.label && value?.url) {
      const href = absolute(value.url, origin);
      if (href) {
        body.push(`<p style="margin:22px 0"><a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 24px;border-radius:8px;background:${safeAccent};color:#ffffff;font:700 16px Arial,Helvetica,sans-serif;text-decoration:none">${escapeHtml(value.label)}</a></p>`);
      }
    }
  }
  const dateLabel = issueDateLabel(issue?.issueDate, language);
  const eyebrow = [siteName, dateLabel].filter(Boolean).map(escapeHtml).join(" · ");
  const preheader = String(issue?.summary || "").trim();
  if (format === "fragment") return { head: "", body: `<div class="pdf-newsletter" style="max-width:900px;margin:auto;padding:24px">${body.join("")}</div>` };
  return `<!doctype html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeHtml(issue?.title || "Newsletter")}</title></head>`
    + '<body style="margin:0;padding:0;background:#f3f5f8">'
    + (preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>` : "")
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8"><tr><td align="center" style="padding:24px 12px">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px"><tr>'
    + '<td style="padding:34px 32px 24px">'
    + (eyebrow ? `<p style="margin:0 0 16px;font:700 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${safeAccent}">${eyebrow}</p>` : "")
    + (body.length ? body.join("") : `<p style="margin:0;font:16px/1.6 Arial,Helvetica,sans-serif;color:#5b6773">${escapeHtml(issue?.title || "")}</p>`)
    + "</td></tr></table></td></tr></table></body></html>";
}

export function renderIssueFragment(issue, options = {}) {
  return renderIssueHtml(issue, { ...options, format: "fragment" });
}

function renderPdfIssue(issue, { origin, language, downloadUrl, fragment = false }) {
  const blocks = issue.template.blocks || [];
  const keys = new Set(blocks.map((block) => block.key));
  const layout = normalizePresentation(issue.template.presentation, keys);
  const content = issue.content || {};
  const fonts = new Map(layout.fonts.map((font) => [font.id, font]));
  const mapped = new Set();
  const position = (box, page) => `left:${box.x / page.width * 100}%;top:${box.y / page.height * 100}%;width:${box.width / page.width * 100}%;height:${box.height / page.height * 100}%`;
  const plain = (value) => paragraphs(value).map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`).join("");
  const cssGlyphs = (value) => [...String(value || "")].map((character) => `\\${character.codePointAt(0).toString(16)} `).join("");
  const glyphWords = (node, embedded) => {
    const text = [...node.text];
    const glyphs = [...(embedded ? node.glyphs : node.text)];
    let offset = 0;
    return node.text.match(/\s+|\S+/g)?.map((part) => {
      const length = [...part].length;
      const word = glyphs.slice(offset, offset + length).join("");
      offset += length;
      return /^\s+$/.test(part) ? `<span class="pdf-space" style="width:${length * 0.28}em"></span>`
        : `<span class="pdf-word" style="--pdf-glyph:&quot;${cssGlyphs(text.length === glyphs.length ? word : part)}&quot;"></span>`;
    }).join("") || "";
  };
  const readableKeys = new Set();
  const pages = layout.pages.map((page) => {
    const groups = new Map();
    for (const node of page.nodes) {
      const group = groups.get(node.key) || [];
      group.push(node);
      groups.set(node.key, group);
    }
    const text = [...groups].map(([key, nodes]) => {
      mapped.add(key);
      if (!content[key]) return "";
      const first = nodes[0];
      const tag = blocks.find((block) => block.key === key)?.kind === "heading" ? "h2" : "div";
      const unchanged = content[key] === layout.original[key];
      const left = Math.min(...nodes.map((node) => node.x));
      const right = Math.max(...nodes.map((node) => node.x + node.width));
      const top = Math.min(...nodes.map((node) => node.y));
      const bottom = Math.max(...nodes.map((node) => node.y + node.height));
      const runs = unchanged ? nodes.map((node) => {
        const face = fonts.get(node.font);
        const family = face?.src ? `pdf-${node.font}` : face?.family || "serif";
        return `<span class="pdf-run" style="${position(node, page)};font:${node.italic ? "italic " : ""}${face?.src ? 400 : node.weight} ${node.size / page.width * 100}cqw/1 ${family};color:${node.colour}"><span class="pdf-glyph" style="transform-origin:0 0">${glyphWords(node, Boolean(face?.src))}</span></span>`;
      }).join("") : "";
      const alreadyReadable = readableKeys.has(key);
      readableKeys.add(key);
      const colour = tag === "h2" && first.colour !== "#ffffff" ? first.colour : "#151515";
      const readable = alreadyReadable ? "" : `<div class="pdf-readable${unchanged ? "" : " pdf-edit"}" style="left:${left / page.width * 100}%;top:${top / page.height * 100}%;width:${(right - left) / page.width * 100}%;min-height:${(bottom - top) / page.height * 100}%;font-size:${first.size / page.width * 100}cqw;--pdf-colour:${colour}">${plain(content[key])}</div>`;
      return { key, html: `<${tag} class="pdf-block" data-block="${key}"><span class="pdf-desktop" aria-hidden="true">${runs}</span>${readable}</${tag}>` };
    }).filter(Boolean);
    const images = page.images.map((image) => {
      if (image.key) mapped.add(image.key);
      const value = image.key ? content[image.key] : image;
      if (!value?.src) return "";
      return { key: image.key, html: `<img class="pdf-image${image.key ? " pdf-photo" : " pdf-decoration"}" src="${escapeHtml(absolute(value.src, origin))}" alt="${escapeHtml(value.alt || "")}" style="${position(image, page)}" loading="lazy">` };
    }).filter(Boolean);
    const parts = [...images, ...text].sort((left, right) => blocks.findIndex((block) => block.key === left.key) - blocks.findIndex((block) => block.key === right.key));
    return `<section class="pdf-page" style="aspect-ratio:${page.width}/${page.height}">`
      + (page.artwork ? `<img class="pdf-artwork" src="${escapeHtml(absolute(page.artwork, origin))}" alt="" aria-hidden="true">` : "") + parts.map((part) => part.html).join("") + "</section>";
  }).join("");
  const extra = blocks.filter((block) => !mapped.has(block.key) && block.kind !== "button").map((block) => {
    const value = content[block.key];
    return typeof value === "string" ? `<section>${plain(value)}</section>` : "";
  }).join("");
  const href = absolute(downloadUrl || issue.fileUrl, origin);
  const faces = layout.fonts.map((font) => {
    const source = absolute(font.src, origin);
    const versioned = `${source}${source.includes("?") ? "&" : "?"}ww-newsletter=${NEWSLETTER_RENDER_VERSION}`;
    return `@font-face{font-family:pdf-${font.id};src:url("${escapeHtml(versioned)}");font-display:block}`;
  }).join("");
  const head = `<style>${faces}
.pdf-document{margin:0;background:#e9edef;color:#151515;font-family:Georgia,serif}.pdf-newsletter,.pdf-newsletter *{box-sizing:border-box}.ww-newsletter-main{display:block;max-width:none;margin:0;padding:0}.pdf-newsletter{max-width:900px;margin:auto}.pdf-page{position:relative;container-type:inline-size;background:#fff;margin:20px 0;overflow:hidden}.pdf-artwork{position:absolute;inset:0;width:100%;height:100%}.pdf-image,.pdf-run,.pdf-readable{position:absolute}.pdf-image{object-fit:fill}.pdf-block{margin:0;font:inherit}.pdf-desktop{pointer-events:none;user-select:none}.pdf-glyph{position:absolute;left:0;top:0;display:inline-flex;width:max-content;white-space:pre}.pdf-word,.pdf-space{flex:none}.pdf-word::before{content:var(--pdf-glyph)}.pdf-readable{color:transparent;line-height:1.3;font-family:Georgia,serif}.pdf-readable p{margin:0 0 .7em}.pdf-readable::selection,.pdf-readable *::selection{background:#7abce366;color:transparent}.pdf-edit{color:var(--pdf-colour)}.pdf-edit::selection,.pdf-edit *::selection{color:inherit}.pdf-download{padding:16px;text-align:right;background:#fff}.pdf-download a{color:#15557b}.pdf-extra{padding:20px;background:#fff}.pdf-extra:empty{display:none}
@media(max-width:600px){.pdf-document{background:#fff}.pdf-page{aspect-ratio:auto!important;margin:0;padding:20px;overflow:visible;container-type:normal}.pdf-desktop,.pdf-artwork,.pdf-decoration{display:none}.pdf-readable{position:static;width:auto!important;min-height:0!important;color:var(--pdf-colour);font:16px/1.6 Georgia,serif;font-size:16px!important}.pdf-readable p{margin:0 0 1em}.pdf-page>h2 .pdf-readable{font-size:22px!important;font-weight:700}.pdf-photo{position:static;width:100%!important;height:auto!important;max-width:360px;display:block;margin:0 0 20px}.pdf-page>h2:first-of-type .pdf-readable{font-size:28px!important}}
</style>`;
  const body = `<div class="pdf-newsletter">${pages}<div class="pdf-extra">${extra}</div>${href ? `<div class="pdf-download"><a href="${escapeHtml(href)}" download>Download PDF</a></div>` : ""}</div><script>${NEWSLETTER_FIT_SCRIPT}</script>`;
  if (fragment) return { head, body };
  return `<!doctype html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(issue.title)}</title>${head}</head><body class="pdf-document"><main>${body}</main></body></html>`;
}

export function renderIssueText(issue, { siteName = "", origin = "", language = "en" } = {}) {
  const template = issue?.template?.blocks ? issue.template : { blocks: [] };
  const content = issue?.content || {};
  const lines = [[siteName, issueDateLabel(issue?.issueDate, language)].filter(Boolean).join(" · ")];
  for (const block of template.blocks) {
    const value = content[block.key];
    if (block.kind === "divider") lines.push("----");
    else if (block.kind === "heading" && value) lines.push(String(value).toUpperCase());
    else if (block.kind === "text" && value) lines.push(String(value));
    else if (block.kind === "image" && value?.src && value.caption) lines.push(String(value.caption));
    else if (block.kind === "button" && value?.label && value?.url) lines.push(`${value.label}: ${absolute(value.url, origin)}`);
  }
  return lines.filter(Boolean).join("\n\n");
}
