// The one rule for marking a website's FAQ, wherever the page came from.
//
// A FAQ IS MARKED, OR THE FAQ MODULE CANNOT SEE IT. The owner's FAQ list is brought in from the website's own pages,
// and the platform reads a question off a page only where the page marks it (src/site-faq-markup.js):
//
//   data-ww-faq="<list>"          on the element that wraps one question and its answer; names the list it is in
//   data-ww-faq-item="<key>"      on the same element; names the question
//   data-ww-faq-question          on the element holding the question's words
//   data-ww-faq-answer            on the element holding the answer
//
// The marks used to be written by one stage only: the migrator, for the accordions it found on a source website. The page
// design pass drew accordions of its own and marked nothing, so a site whose FAQ was redrawn had its questions on the page
// and none in the owner's list (Baumberger Endowment, 2026-10-14). A mark belongs to the page, not to whichever stage drew
// it, so it is made here, by the shape of the page, and applied on the way out of every stage that writes one.
//
// WHAT MARKING STARTS. Once a list is marked the platform takes it over: the questions are brought into the owner's list and
// the website's Worker draws the page's questions from that list, replacing the first marked question with all of them and
// removing the rest. So a list is marked only when the list can hold it without loss, and a list that cannot is left exactly
// as the page wrote it and reported (faqUnreadableIssues). The list keeps a question and an answer made of words:
// paragraphs, lists, bold, italic and links. It drops pictures, buttons, tables and video, keeps one answer element and 200
// questions of at most 200 characters, and cuts an answer at 6000 characters.
//
// Two shapes are read, by their structure:
//   a native <details> with a <summary> question and ONE element after it for the answer, and
//   an item - a block with a question that asks and ONE answer element - whose class says faq as a word of its own (faq, faq-item;
//   the class is what tells a question and its answer from any other heading and paragraph in a box).
// An answer is a <div>, <p>, <section>, <article> or <blockquote>, so that the paragraphs the list draws can sit inside it.
// Questions that sit together, with nothing but decoration between them, are a list: most end in a question mark, or a
// heading or class near them says FAQ. A list is named for its page, and two on one page never share a name.
//
// This file imports nothing but cheerio and no node: builtin. It is imported by the Worker (src/site-rules.js) and installed
// byte for byte into every managed site repository beside site-standards.mjs, which re-exports it.

import { load } from "cheerio";

// What the platform's FAQ list keeps (public/faq-render.js; scripts/faq-marks.test.mjs holds the two together).
export const FAQ_LIMITS = Object.freeze({ items: 200, lists: 40, question: 200, answer: 6000 });

// Chrome and controls that expand without being a question and its answer: the migrator never rebuilds an accordion inside them.
export const FAQ_CONVERSION_EXCLUDES = "nav,header,footer,form,[role='navigation'],[role='menu'],[role='tablist'],.w-dropdown,.dropdown-menu";
// And what is not content when deciding that something is a FAQ: those, and a sidebar, whose filters and menus are not questions.
export const FAQ_NOT_CONTENT = `${FAQ_CONVERSION_EXCLUDES},aside,[role='complementary']`;
const FAQ_WORDS = /\bfaqs?\b|frequently asked|questions? (?:and|&) answers?|common questions|\bq ?(?:&|and) ?a\b|sıkça sorulan|sık sorulan|\bsss\b|preguntas frecuentes|foire aux questions|questions fréquentes|häufig gestellte|domande frequenti|perguntas frequentes|veelgestelde/i;
const FAQ_ASKS = /[?？؟]["'”’)\]]*\s*$/;
// A class that says faq as a word of its own: faq, faqs, faq-item, wd-faq-item, site_faq.
const FAQ_CLASS_WORD = /(?:^|[-_])faqs?(?:$|[-_])/i;
const sayFaq = (element) => String(element.attr("class") || "").split(/\s+/).some((name) => FAQ_CLASS_WORD.test(name));
const FAQ_LIST_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INERT = "script,style,template,noscript";
// What an answer holds that the list cannot keep. An inline icon is decoration and is not counted.
const FAQ_UNKEPT = "img,picture,video,audio,iframe,object,embed,canvas,table,form,input,select,textarea,button,pre";
// The elements an answer can be, so that the paragraphs the list draws can sit inside it (a <p> answer is replaced by them).
const ANSWER_TAGS = /^(?:div|p|section|article|blockquote)$/;
// What the stencil would copy from a question that the website could not draw: a script, a style, a handler, a javascript: address.
const UNCOPYABLE = /\son[a-z]+\s*=|<script\b|<style\b|javascript:/i;
const QUESTION_TAGS = /^(?:h[1-6]|p|div|span|strong|b|dt)$/;

export const faqSquash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
export const faqNames = (element) => `${element.attr("class") || ""} ${element.attr("id") || ""}`;

// The same key public/faq-render.js makes (a test holds them together): the platform names a list by it.
export function faqListKey(value) {
  const key = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return FAQ_LIST_KEY.test(key) ? key : "";
}

// The page address a file is served at, the same way wherever it is asked: public/faq/index.html and public/faq.html are /faq/.
export function faqRouteForFile(file) {
  const relative = String(file || "").replace(/\\/g, "/").replace(/^\.?\/*/, "").replace(/^public\//, "")
    .replace(/(?:^|\/)index\.html?$/i, "/").replace(/\.html?$/i, "/");
  return `/${relative}`.replace(/\/+/g, "/");
}

// SHA-1 as hex, in plain JavaScript: this module may not use node:crypto, and a question's key has always been the first
// twelve characters of the SHA-1 of its lower-cased words, so the keys of questions marked before this existed do not change.
export function sha1Hex(text) {
  const message = new TextEncoder().encode(String(text));
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((message.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (message.length * 8) >>> 0);
  const words = new Uint32Array(80);
  const rotate = (value, bits) => (value << bits) | (value >>> (32 - bits));
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 80; index += 1) words[index] = rotate(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let index = 0; index < 80; index += 1) {
      const [mix, constant] = index < 20 ? [(b & c) | (~b & d), 0x5a827999] : index < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : index < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const next = (rotate(a, 5) + mix + e + constant + words[index]) >>> 0;
      e = d; d = c; c = rotate(b, 30) >>> 0; b = a; a = next;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((word) => word.toString(16).padStart(8, "0")).join("");
}

// The words of the element itself, not of its children.
const ownWords = ($, element) => faqSquash(element.contents().toArray().filter((node) => node.type === "text").map((node) => node.data).join(" "));

// Decoration between questions: nothing a reader would read (an empty wrapper, a rule, a number or a bullet), so it does not end
// one list and start another.
const LETTER = /\p{L}/u;
const decoration = ($, element) => element.is(`${INERT},hr,br`) || (!LETTER.test(element.text()) && !element.is(FAQ_UNKEPT) && !element.find(FAQ_UNKEPT).length);

// The nearest heading above a node among its earlier siblings, or the last one inside the nearest earlier sibling that has one.
const headingAbove = ($, node) => {
  for (const sibling of node.prevAll().toArray()) {
    const above = $(sibling);
    const heading = above.is("h1,h2,h3,h4,h5,h6") ? above : above.find("h1,h2,h3,h4,h5,h6").last();
    if (heading.length) return heading.text();
  }
  return "";
};

// Where a page says "these are the FAQs": the heading directly above the questions, else the nearest above their container, and
// the names (classes and ids) of that container and the two around it - never <main> or <body>, so a page class of faq-page does
// not make every disclosure on it a question, and the nearest heading wins, so the next section's heading is not the FAQ's.
function surroundings($, first, parent) {
  const said = [];
  let heading = headingAbove($, first);
  let node = parent;
  for (let depth = 0; depth < 3 && node.length && !node.is("main,body,html"); depth += 1, node = node.parent()) {
    said.push(faqNames(node));
    if (!heading) heading = headingAbove($, node);
  }
  return [...said, heading].join(" ");
}

const nameList = (names) => [...new Set(names)].join(", ");

// The innermost element that holds all of a question's words: the decoration beside them stays out of the slot. A link or a
// label is never descended into (its address would be copied onto every question drawn).
function wordsOf($, element, question) {
  let words = element;
  for (;;) {
    const inner = words.children().filter((_, child) => faqSquash($(child).text()) === question);
    if (inner.length !== 1 || ownWords($, words) || inner.is("a,label,button")) return words;
    words = inner.first();
  }
}

// A question's words without the glyphs beside them: an element with no letter in it (a "+", an arrow, a number) is decoration.
function questionOf($, element) {
  const copy = element.clone();
  copy.children().filter((_, child) => !LETTER.test($(child).text())).remove();
  return faqSquash(copy.text());
}

// Every question on the page in a shape the list reads, in page order, not yet marked.
function candidatesOf($, main) {
  const found = [];
  // What follows a question: its answer. Anything else that holds words or a picture makes the answer several elements.
  const content = (children) => children.not(INERT).filter((_, child) => faqSquash($(child).text()) || $(child).is(FAQ_UNKEPT) || $(child).find(FAQ_UNKEPT).length);
  // A wrapper that holds nothing but this one question is part of the question: it carries the builder's spacing.
  const rootOf = (element) => {
    let root = element;
    while (!root.parent().is(main) && root.parent().children().length === 1 && !ownWords($, root.parent())) root = root.parent();
    return root;
  };
  for (const node of main.find("details,[class]").toArray()) {
    const element = $(node);
    const isDetails = node.name === "details";
    // Cheap tests first: most elements on a page are neither a disclosure nor a block that says faq.
    if (!isDetails && !sayFaq(element)) continue;
    if (element.closest(FAQ_NOT_CONTENT).length || element.parents("details").length || element.closest("[data-ww-faq-item]").length) continue;
    if (isDetails) {
      const summary = element.children("summary").first();
      const question = questionOf($, summary);
      if (!summary.length || !question) continue;
      const parts = content(element.children().not("summary"));
      if (!parts.length) continue;
      const panel = parts.filter(".ww-disclosure-panel").first();
      const answer = panel.length ? panel : parts.first();
      let problem = parts.length > 1 ? "an answer is several elements" : "";
      if (!problem && ownWords($, element)) problem = "an answer has words outside any element";
      if (!problem && !ANSWER_TAGS.test(answer.get(0).name)) problem = `an answer is a <${answer.get(0).name}>, which cannot hold paragraphs: put it inside a <div>`;
      found.push({ shape: "details", root: rootOf(element), questionElement: summary, answer, question, problem });
      continue;
    }
    // An item: a block whose class says faq, holding a question that asks and one answer.
    if (element.is("main,body,section,form,ul,ol,table,tbody,tr") || element.find("details,[data-ww-faq-item]").length) continue;
    const parts = content(element.children());
    if (parts.length < 2) continue;
    const first = parts.first();
    const question = faqSquash(first.text());
    if (!QUESTION_TAGS.test(first.get(0).name) || !question || !FAQ_ASKS.test(question) || first.find(FAQ_UNKEPT).length) continue;
    const answer = parts.eq(1);
    let problem = parts.length > 2 ? "an answer is several elements" : "";
    if (!problem && ownWords($, element)) problem = "an answer has words outside any element";
    if (!problem && !ANSWER_TAGS.test(answer.get(0).name)) problem = `an answer is a <${answer.get(0).name}>, which cannot hold paragraphs: put it inside a <div>`;
    found.push({ shape: "item", root: rootOf(element), questionElement: first, answer, question, problem });
  }
  // A question inside another is part of it - except that a faq-classed container which holds items is not one itself.
  const byRoot = new Map(found.map((entry) => [entry.root.get(0), entry]));
  const dropped = new Set();
  for (const entry of found) {
    for (let node = entry.root.get(0).parent; node; node = node.parent) {
      const outer = byRoot.get(node);
      if (outer && outer !== entry) dropped.add(outer.shape === "details" ? entry : outer);
    }
  }
  return found.filter((entry) => !dropped.has(entry));
}

// What the list writes of an answer: its words, and the markup that becomes writing (a link's address, bold, a paragraph's break).
const writtenLength = (answer) => faqSquash(answer.text()).length
  + answer.find("a[href]").toArray().reduce((sum, link) => sum + String(link.attribs?.href || "").length + 4, 0)
  + answer.find("b,strong,em,i").length * 4 + Math.max(0, answer.find("p,li,h1,h2,h3,h4,h5,h6,br").length - 1) * 2;

// Why the list could not keep this run of questions as they are, or "".
function unkept($, run) {
  const reasons = [];
  for (const entry of run) if (entry.problem) reasons.push(entry.problem);
  const held = [];
  for (const entry of run) {
    for (const found of entry.answer.find(FAQ_UNKEPT).add(entry.answer.filter(FAQ_UNKEPT)).toArray()) held.push(found.name);
  }
  const named = (name) => (name === "img" || name === "picture" ? "a picture" : name === "iframe" ? "an embedded frame" : name === "pre" ? "preformatted text" : `a ${name}`);
  if (held.length) reasons.push(`an answer holds ${nameList(held.map(named))} the list cannot keep`);
  if (run.some((entry) => entry.answer.find("[hidden]").length)) reasons.push("an answer holds hidden text, which the list would show");
  if (run.some((entry) => { const words = entry.answer.clone(); words.find(`${INERT},svg`).remove(); return !faqSquash(words.text()); })) reasons.push("an answer has no words");
  if (run.some((entry) => entry.question.length > FAQ_LIMITS.question)) reasons.push(`a question is longer than ${FAQ_LIMITS.question} characters`);
  if (run.some((entry) => writtenLength(entry.answer) > FAQ_LIMITS.answer)) reasons.push(`an answer is longer than ${FAQ_LIMITS.answer} characters as the list writes it`);
  if (run.length > FAQ_LIMITS.items) reasons.push(`there are more than ${FAQ_LIMITS.items} questions in one list`);
  // The stencil is the first question's own markup; one the website could not draw would turn the whole list into the plain default.
  if (run.some((entry) => UNCOPYABLE.test($.html(entry.root).replace($.html(entry.answer), "").replace($.html(entry.questionElement), "")))) {
    reasons.push("a question holds a script, a style or an inline handler the website cannot copy");
  }
  return nameList(reasons);
}

// Every run of questions on the page that reads as a FAQ and is not marked yet, with what each mark would say.
// { lists: [{ key, items: [{ root, words, answer, question, itemKey }] }], unreadable: [{ count, reason, answers }] } - changes nothing.
export function planFaqLists($, main, route = "/") {
  const taken = new Set();
  for (const node of $("[data-ww-faq-item]").toArray()) {
    const key = faqListKey($(node).attr("data-ww-faq"));
    if (key) taken.add(key);
  }
  const byRoot = new Map();
  const parents = new Set();
  for (const entry of candidatesOf($, main)) {
    byRoot.set(entry.root.get(0), entry);
    parents.add(entry.root.parent().get(0));
  }
  // Named for the page it is on. The last two parts of the address read well and are the whole address for most pages;
  // where they are not - a deeper page, or an address the key had to shorten or respell - two pages could share a name
  // (/a/campus/help/ and /b/campus/help/), and the second one's questions were dropped for the first's. Those carry a few
  // characters of the full address as well.
  const address = String(route || "/");
  const parts = address.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const named = faqListKey(parts.slice(-2).join("-")) || "home";
  const whole = named === parts.join("-").toLowerCase() || !parts.length;
  const base = whole ? named : faqListKey(`${named.slice(0, 33)}-${sha1Hex(address).slice(0, 6)}`);
  const lists = [];
  const unreadable = [];
  for (const parent of parents) {
    // A run is questions side by side. Anything a reader would read between them (a heading, a paragraph, words, a question
    // already marked) ends one list and starts another, because the website draws a list where its first question is.
    const runs = [];
    let run = [];
    const flush = () => { if (run.length) runs.push(run); run = []; };
    for (const child of $(parent).contents().toArray()) {
      if (child.type === "text") { if (faqSquash(child.data)) flush(); continue; }
      if (child.type !== "tag") continue;
      const entry = byRoot.get(child);
      if (entry) run.push(entry);
      else if (!decoration($, $(child))) flush();
    }
    flush();
    for (const entries of runs) {
      if (entries.length < 2) continue;
      const asked = entries.filter((entry) => FAQ_ASKS.test(entry.question)).length;
      if (asked * 2 <= entries.length && !FAQ_WORDS.test(surroundings($, entries[0].root, $(parent)))) continue;
      const reason = unkept($, entries);
      if (reason) { unreadable.push({ count: entries.length, reason, answers: entries.map((entry) => entry.answer) }); continue; }
      if (lists.length >= FAQ_LIMITS.lists) { unreadable.push({ count: entries.length, reason: `there are more than ${FAQ_LIMITS.lists} lists on one page`, answers: [] }); continue; }
      let key = base;
      for (let number = 2; taken.has(key); number += 1) key = faqListKey(`${base.slice(0, 36)}-${number}`) || `${base.slice(0, 30)}-${number}`;
      taken.add(key);
      const seen = new Set();
      const items = entries.map((entry) => {
        let itemKey = sha1Hex(entry.question.toLowerCase()).slice(0, 12);
        while (seen.has(itemKey)) itemKey = sha1Hex(itemKey).slice(0, 12);
        seen.add(itemKey);
        return { root: entry.root, words: wordsOf($, entry.questionElement, entry.question), answer: entry.answer, question: entry.question, itemKey };
      });
      lists.push({ key, items });
    }
  }
  return { lists, unreadable };
}

// Marks every run of questions that reads as a FAQ, in place. Returns the lists marked: [{ key, count }].
export function markFaqLists($, main, page = {}, findings = []) {
  const plan = planFaqLists($, main, String(page.path || "/"));
  for (const list of plan.lists) {
    for (const item of list.items) {
      item.root.attr("data-ww-faq", list.key).attr("data-ww-faq-item", item.itemKey);
      item.words.attr("data-ww-faq-question", "");
      item.answer.attr("data-ww-faq-answer", "").removeAttr("hidden").removeAttr("aria-hidden");
    }
  }
  const lists = plan.lists.map((list) => ({ key: list.key, count: list.items.length }));
  if (lists.length) {
    findings.push({ module: "faq", route: page.path, status: "recreated", count: lists.reduce((sum, list) => sum + list.count, 0),
      lists: lists.map((list) => list.key),
      reason: "Frequently asked questions recognised and kept with their answers, including answers the source only showed on click; the owner manages them as FAQ items" });
  }
  for (const entry of plan.unreadable) {
    // Left as the source wrote them, but not left shut: a disclosure opens natively, and an answer the source hid with an attribute
    // would stay hidden for good.
    for (const answer of entry.answers) answer.removeAttr("hidden").removeAttr("aria-hidden");
    findings.push({ module: "faq", route: page.path, status: "partial", count: entry.count,
      reason: `${entry.count} questions kept as the source wrote them, not as the owner's FAQ list: ${entry.reason}` });
  }
  return lists;
}

const plain = (unreadable) => unreadable.map(({ count, reason }) => ({ count, reason }));

// Where a page's content is: its <main>, or its body for a page without one.
const scopeOf = ($) => {
  const main = $("main").first();
  if (main.length) return main;
  const body = $("body").first();
  return body.length ? body : $.root();
};

const startTagOf = (source, element) => {
  const at = element?.sourceCodeLocation?.startTag;
  const name = String(element?.name || "");
  return at && name && source[at.startOffset] === "<" && source.slice(at.startOffset + 1, at.startOffset + 1 + name.length).toLowerCase() === name ? at : null;
};

// The page with every unmarked FAQ marked: { html, lists: [{ key, count }], unreadable }. The marks are written into the
// page's own text at the tags they belong to, so the rest of the page is byte for byte what it was and a second run changes
// nothing. A list whose tags cannot be told apart in the text (the parser copies an unclosed <b> into every paragraph after
// it, and the copy has the original's position) is left unmarked, whole. And nothing is returned that reads differently:
// if the marked page does not have the same words and exactly the marks planned, the page comes back as it went in.
export function markFaqPage(html, { route = "/" } = {}) {
  const source = String(html ?? "");
  if (!/<details\b|faq/i.test(source)) return { html: source, lists: [], unreadable: [] };
  const $ = load(source, { sourceCodeLocationInfo: true });
  const plan = planFaqLists($, scopeOf($), route);
  if (!plan.lists.length) return { html: source, lists: [], unreadable: plain(plan.unreadable) };
  const claims = new Map();
  $("*").each((_, element) => {
    const at = element.sourceCodeLocation?.startTag;
    if (at) claims.set(at.startOffset, (claims.get(at.startOffset) || 0) + 1);
  });
  const located = (element) => {
    const at = startTagOf(source, element);
    return at && claims.get(at.startOffset) === 1 ? at : null;
  };
  const edits = new Map();
  const marked = [];
  for (const list of plan.lists) {
    const wanted = [];
    for (const item of list.items) {
      wanted.push([item.root.get(0), { "data-ww-faq": list.key, "data-ww-faq-item": item.itemKey }, false]);
      wanted.push([item.words.get(0), { "data-ww-faq-question": "" }, false]);
      wanted.push([item.answer.get(0), { "data-ww-faq-answer": "" }, true]);
    }
    if (!wanted.every(([element]) => located(element))) continue;
    for (const [element, attributes, open] of wanted) {
      const edit = edits.get(element) || { attributes: {}, open: false };
      Object.assign(edit.attributes, attributes);
      edit.open ||= open;
      edits.set(element, edit);
    }
    marked.push(list);
  }
  if (!edits.size) return { html: source, lists: [], unreadable: plain(plan.unreadable) };
  let out = source;
  for (const [element, edit] of [...edits].sort((a, b) => located(b[0]).startOffset - located(a[0]).startOffset)) {
    const at = located(element);
    let tag = source.slice(at.startOffset, at.endOffset);
    if (edit.open) {
      // An answer an old page held shut with an attribute is opened by the same edit that marks it: the attributes
      // themselves are cut by position, so a class or a title that says "hidden" is not touched.
      const cuts = ["hidden", "aria-hidden"].map((name) => element.sourceCodeLocation.attrs?.[name]).filter(Boolean)
        .map((range) => {
          let start = range.startOffset - at.startOffset;
          while (start > 0 && /\s/.test(tag[start - 1])) start -= 1;
          return [start, range.endOffset - at.startOffset];
        }).sort((a, b) => b[0] - a[0]);
      for (const [start, end] of cuts) tag = tag.slice(0, start) + tag.slice(end);
    }
    const added = Object.entries(edit.attributes).filter(([name]) => element.attribs?.[name] === undefined)
      .map(([name, value]) => ` ${name}="${value}"`).join("");
    out = out.slice(0, at.startOffset) + tag.replace(/^<[^\s/>]+/, (open) => `${open}${added}`) + out.slice(at.endOffset);
  }
  const after = load(out);
  const expected = marked.reduce((sum, list) => sum + list.items.length, 0);
  const sound = after.root().text() === $.root().text()
    && ["[data-ww-faq-item]", "[data-ww-faq-question]", "[data-ww-faq-answer]"].every((selector) => after(selector).length === $(selector).length + expected);
  if (!sound) return { html: source, lists: [], unreadable: plain(plan.unreadable) };
  return { html: out, lists: marked.map((list) => ({ key: list.key, count: list.items.length })), unreadable: plain(plan.unreadable) };
}

// The page with its unmarked FAQs marked: the shape the other deterministic repairs have (a page's text in, its text out).
export function markFaqAccordions(html, options = {}) {
  return markFaqPage(html, options).html;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// What markFaqPage would mark. Every stage that writes a page repairs it first, so this is only seen on a page nothing has
// repaired yet: the build gate says so, and a sweep reports it. Never shown to an author, who has nothing to do about it.
export function faqMarkIssues(html, { route = "/" } = {}) {
  const source = String(html ?? "");
  if (!/<details\b|faq/i.test(source)) return [];
  const $ = load(source);
  return planFaqLists($, scopeOf($), route).lists.map((list) => `${plural(list.items.length, "FAQ question")} not marked (data-ww-faq), so the website's FAQ list cannot find ${list.items.length === 1 ? "it" : "them"}`);
}

// What the FAQ list cannot keep, which the platform therefore leaves as the page wrote it - and which the author can put
// right: the page's questions are in a shape the list could read, but not with these answers. A warning, never a failure.
export function faqUnreadableIssues(html, { route = "/" } = {}) {
  const source = String(html ?? "");
  if (!/<details\b|faq/i.test(source)) return [];
  const $ = load(source);
  return planFaqLists($, scopeOf($), route).unreadable
    .map((entry) => `${plural(entry.count, "FAQ question")} left as written, not in the owner's FAQ list: ${entry.reason}. The list keeps questions whose answer is one element of words, links and lists`);
}
