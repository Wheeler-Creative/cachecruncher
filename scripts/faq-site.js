// Frequently asked questions on the website. The platform publishes the owner's questions to
// site-integrations/<site>/faq.json; this draws them into the page where the page's own questions are.
//
// A page marks each of its questions (data-ww-faq names the list, data-ww-faq-item the question). Where the published
// file has that list, the first marked question becomes the whole current list and the rest are taken out, so what an
// owner adds, rewrites, reorders or removes shows without the page being rebuilt. A list the file does not have is left
// exactly as the page wrote it - which is also what a website shows before its questions were ever brought in.

import { FAQ_RENDER_VERSION, MAX_FAQ_LISTS, normalizeFaqList, renderFaqItems } from "./faq-render.js";
import { composeCollectionPage } from "./collection-pages-site.js";

export { FAQ_RENDER_VERSION };

// The page the website draws itself at /faq/ when the owner asks for one - a website with no page carrying its
// questions still shows them, with nothing built. The owner's heading for it, and whether the menu gets a button.
export const FAQ_PAGE_PATH = "/faq/";
const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
export function faqPageSettings(input) {
  if (!input || typeof input !== "object") return null;
  const label = line(input.label, 40);
  return label ? { label, nav: input.nav === "button" ? "button" : "none" } : null;
}

export function parseFaqs(text) {
  try {
    const value = JSON.parse(text || "{}");
    const lists = new Map();
    // A module turned off publishes enabled false and draws nothing; a file from before the switch has no such field.
    const enabled = value?.enabled !== false;
    for (const entry of (enabled && Array.isArray(value.lists) ? value.lists : []).slice(0, MAX_FAQ_LISTS)) {
      const list = normalizeFaqList(entry);
      if (list && !lists.has(list.key)) lists.set(list.key, list);
    }
    // A page that carried the same questions as another list is drawn from that list, in its own design. Its key is a list of
    // its own for the page that marks it, and no list at all for the page the website draws (renderFaqFragment), where the
    // same questions would otherwise be shown twice. A file read by a website from before this has no aliases and leaves
    // that page as it wrote it, which is the safe way for it to fail.
    for (const entry of (enabled && Array.isArray(value.aliases) ? value.aliases : []).slice(0, MAX_FAQ_LISTS)) {
      const target = lists.get(String(entry?.of || ""));
      if (!target || lists.has(String(entry?.key || ""))) continue;
      const alias = normalizeFaqList({ key: entry.key, stencil: entry.stencil, items: target.items });
      if (alias) lists.set(alias.key, { ...alias, alias: true });
    }
    return { lists, enabled, page: enabled ? faqPageSettings(value.page) : null };
  } catch { return { lists: new Map(), enabled: false, page: null }; }
}

const WORDS = {
  en: { none: "No questions yet." }, tr: { none: "Henüz soru yok." }, de: { none: "Noch keine Fragen." },
  es: { none: "Todavía no hay preguntas." }, fr: { none: "Pas encore de questions." }
};
const STYLE = "<style>.ww-faq-page{max-width:48rem;margin:0 auto;padding:clamp(1.5rem,4vw,3rem) 1rem}.ww-faq-page .ww-collection-head{margin-bottom:1.5rem}"
  + ".ww-faq-list{display:grid;gap:.5rem;margin:0 0 2rem}.ww-faq-page .ww-faq-item{border-top:1px solid rgba(0,0,0,.12);padding:.75rem 0}"
  + ".ww-faq-page .ww-faq-item summary{cursor:pointer;font-weight:600}.ww-faq-empty{opacity:.8}</style>";

// The page's body: every published list under the owner's heading, each question drawn the way its list draws it.
export function renderFaqFragment(index, { language = "en" } = {}) {
  const words = WORDS[String(language || "en").slice(0, 2).toLowerCase()] || WORDS.en;
  const lists = [...index.lists.values()].filter((list) => list.items.length && !list.alias);
  const body = `<section class="ww-faq-page" data-ww-faq-page><header class="ww-collection-head"><h1>${escape(index.page?.label)}</h1></header>`
    + (lists.length
      ? lists.map((list) => `<div class="ww-faq-list" data-ww-faq-list="${escape(list.key)}">${renderFaqItems(list)}</div>`).join("")
      : `<p class="ww-faq-empty">${escape(words.none)}</p>`)
    + "</section>";
  return { head: STYLE, body };
}

// Serves the FAQ page at /faq/ when the published file asks for one, or null for any other request so the website
// answers it. shell(path) is the website's own page at path, which lends its header, footer and styles; a website that
// has a page of its own at /faq/ keeps it.
export async function serveFaqPage(request, index, { shell, language = "en" } = {}) {
  const page = index?.enabled ? index.page : null;
  if (!page || !["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  const path = (() => { try { return decodeURI(url.pathname); } catch { return url.pathname; } })();
  if (path === FAQ_PAGE_PATH.slice(0, -1)) return new Response(null, { status: 301, headers: { location: `${FAQ_PAGE_PATH}${url.search}`, "cache-control": "public, max-age=300" } });
  if (path !== FAQ_PAGE_PATH) return null;
  const own = shell ? await Promise.resolve().then(() => shell(path)).catch(() => null) : null;
  if (own?.ok && (own.headers.get("content-type") || "").includes("text/html")) return own;
  await own?.body?.cancel?.();
  const home = shell ? await Promise.resolve().then(() => shell("/")).catch(() => null) : null;
  const fragment = renderFaqFragment(index, { language });
  if (home?.ok && (home.headers.get("content-type") || "").includes("text/html")) {
    const composed = composeCollectionPage(home, fragment, { title: page.label, summary: "", origin: url.origin, canonical: `${url.origin}${FAQ_PAGE_PATH}` });
    composed.headers.set("x-ww-faq-page", "1");
    return request.method === "HEAD" ? new Response(null, composed) : composed;
  }
  await home?.body?.cancel?.();
  return new Response(request.method === "HEAD" ? null : `<!doctype html><html lang="${escape(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(page.label)}</title>${fragment.head}</head><body>${fragment.body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

// The page with its questions drawn from the published lists.
export function addFaqs(response, index) {
  if (!index?.lists?.size || typeof HTMLRewriter === "undefined") return response;
  const drawn = new Set();
  return new HTMLRewriter()
    .on("[data-ww-faq-item]", { element(element) {
      const list = index.lists.get(String(element.getAttribute("data-ww-faq") || ""));
      if (!list) return;
      if (drawn.has(list.key)) { element.remove(); return; }
      drawn.add(list.key);
      element.replace(renderFaqItems(list), { html: true });
    } })
    .transform(response);
}
