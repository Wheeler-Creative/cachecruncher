// Frequently asked questions, drawn the same way everywhere: by the website's Worker on a page, and by the portal's
// preview. A question and its answer are a native <details>, so the answer opens with no script, by keyboard and for a
// screen reader, and is in the page for a search engine to read.
//
// A list keeps the look of the page it was found on. When a migration brings a FAQ in, one of its questions is kept as
// a stencil - the page's own markup, with a slot where the question goes and one where the answer goes - and every
// question, including ones the owner adds later, is drawn from it.

import { fillStencil, richText } from "./collection-render.js";

// 2: the website draws a page of its own at /faq/ when the owner asks for one, and the menu button for it.
// 3: a page that carried the same questions as another list is drawn from that list (aliases in the published file).
export const FAQ_RENDER_VERSION = 3;
export const MAX_FAQ_LISTS = 40;
export const MAX_FAQ_ITEMS = 200;
export const MAX_QUESTION = 200;
export const MAX_ANSWER = 6000;
export const MAX_FAQ_STENCIL = 12000;
export const LIST_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// The question and its answer, in the plain design a website has when it kept no stencil of its own.
export const DEFAULT_FAQ_STENCIL = '<details class="ww-faq-item ww-disclosure" data-ww-faq="{{ww:list}}" data-ww-faq-item="{{ww:key}}">'
  + '<summary data-ww-faq-question>{{ww:question}}</summary>'
  + '<div class="ww-faq-answer ww-disclosure-panel" data-ww-faq-answer>{{ww:answer}}</div></details>';

export function faqListKey(value) {
  const key = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return LIST_KEY.test(key) ? key : "";
}

// A stencil is the website's own markup, so it is trusted as markup - but it must be one that can be filled: both
// slots, the two marks the Worker finds a question by, and no script of its own.
export function validFaqStencil(value) {
  const stencil = String(value || "");
  return stencil.length > 0 && stencil.length <= MAX_FAQ_STENCIL
    && stencil.includes("{{ww:question}}") && stencil.includes("{{ww:answer}}")
    && /data-ww-faq-item="\{\{ww:key\}\}"/.test(stencil) && /data-ww-faq="\{\{ww:list\}\}"/.test(stencil)
    && !/<script\b|<style\b|\son[a-z]+\s*=|javascript:/i.test(stencil);
}

export function normalizeFaqItem(entry) {
  const question = squash(entry?.question).slice(0, MAX_QUESTION);
  const key = String(entry?.id || entry?.key || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  if (!question || !key) return null;
  return { key, question, answer: String(entry?.answer ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_ANSWER) };
}

export function normalizeFaqList(entry) {
  const key = faqListKey(entry?.key);
  if (!key) return null;
  return {
    key,
    stencil: validFaqStencil(entry?.stencil) ? String(entry.stencil) : DEFAULT_FAQ_STENCIL,
    items: (Array.isArray(entry?.items) ? entry.items : []).map(normalizeFaqItem).filter(Boolean).slice(0, MAX_FAQ_ITEMS)
  };
}

// Every question of one list, each drawn from the list's stencil. Nothing typed can become markup of its own: the
// question is escaped, and the answer goes through the same small writing rules as a blog post.
export function renderFaqItems(list) {
  const marked = validFaqStencil(list?.stencil) ? list.stencil : DEFAULT_FAQ_STENCIL;
  // A page whose answer is a single <p> has that paragraph as the mark; the paragraphs drawn replace it, so none is inside another.
  const stencil = marked.replace(/<p\b[^>]*\sdata-ww-faq-answer="[^"]*"[^>]*>\{\{ww:answer\}\}<\/p>/, "{{ww:answer}}");
  // The class the page gave an answer's paragraphs travels on the answer's mark, and each paragraph drawn gets it.
  const paragraph = /data-ww-faq-answer="([A-Za-z0-9_ -]{1,200})"/.exec(marked)?.[1] || "";
  const answer = (text) => (paragraph ? richText(text).replace(/<p>/g, `<p class="${paragraph}">`) : richText(text));
  return (list?.items || []).map((item) => fillStencil(stencil, {
    list: escape(list.key), key: escape(item.key), question: escape(item.question), answer: answer(item.answer)
  })).join("");
}

// What a search engine reads to show the questions under the result.
export function faqStructuredData(items) {
  const entities = (items || []).filter((item) => item?.question && item?.answer).slice(0, MAX_FAQ_ITEMS).map((item) => ({
    "@type": "Question", name: item.question,
    acceptedAnswer: { "@type": "Answer", text: richText(item.answer) }
  }));
  if (!entities.length) return "";
  return JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: entities }).replace(/</g, "\\u003c");
}
