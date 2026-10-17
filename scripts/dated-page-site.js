// The dated items page, drawn by the website's own server, and the menu buttons a module asks for.
//
// Turning on dated items used to mean a whole website edit: a model rewrote a page to hold the event list, added a
// link it called "Events" to the menu, and the result went through a preview, its checks and a repair. All of that
// to put a list the platform already publishes (events.json) onto a page the platform could draw itself. So now it
// does: the owner names the items (Events, Concerts, Classes) and where they live (/concerts/), and the page is drawn
// at that address inside the website's own header, footer and styles, the way the blog and page sets already are.
// A button in the menu is added only when the owner asked for one, under the name they gave, while the page is served.
//
// Shared by the platform (which publishes the snapshot) and every website's Worker (which draws from it).

import { composeCollectionPage } from "./collection-pages-site.js";

// 1: the page and its menu button. A website's Worker that answers with a lower x-ww-dated is brought up to date
// through the site runtime upgrade, never through an edit.
export const DATED_RENDER_VERSION = 1;

const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const PATH = /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// What the owner chose for the page: its name, its address and whether it is in the menu. Nothing else from a
// snapshot is trusted to draw a page.
export function datedPageSettings(input) {
  const page = input && typeof input === "object" ? input : null;
  const path = String(page?.path || "").trim().toLowerCase();
  const label = line(page?.label, 40);
  if (!page || !PATH.test(path) || !label) return null;
  return { path, label, nav: page.nav === "button" ? "button" : "none" };
}

// The published snapshot, as far as a page needs it.
export function parseEventsSnapshot(text) {
  try {
    const value = typeof text === "string" ? (text ? JSON.parse(text) : null) : text;
    const events = (Array.isArray(value?.events) ? value.events : []).map((event) => ({
      title: line(event?.title, 200), description: String(event?.description || "").slice(0, 2000), location: line(event?.location, 500),
      url: /^(?:\/(?!\/)|https:\/\/)/.test(String(event?.url || "")) ? String(event.url).slice(0, 2000) : "",
      startAt: Date.parse(event?.startAt) ? String(event.startAt) : "", endAt: Date.parse(event?.endAt) ? String(event.endAt) : "",
      allDay: event?.allDay === true, timeZone: String(event?.timeZone || "UTC").slice(0, 100), status: String(event?.status || "confirmed")
    })).filter((event) => event.title && event.startAt && event.status !== "cancelled");
    return { enabled: value?.enabled === true, page: datedPageSettings(value?.page), events, calendarUrl: "/events.ics" };
  } catch { return { enabled: false, page: null, events: [], calendarUrl: "/events.ics" }; }
}

// The newsletter's snapshot as far as its menu button goes.
export function newsletterSnapshot(text) {
  try {
    const value = typeof text === "string" ? (text ? JSON.parse(text) : null) : text;
    return value && typeof value === "object" ? { enabled: value.enabled === true, nav: value.nav && typeof value.nav === "object" ? { label: line(value.nav.label, 40) } : null } : null;
  } catch { return null; }
}

// The menu buttons modules asked for: the dated items page, the newsletter, the FAQ page - each under the owner's
// own words for it.
export function moduleNavLinks({ events = null, newsletter = null, faq = null } = {}) {
  const links = [];
  if (events?.enabled && events.page?.nav === "button") links.push({ id: "dated-items", title: events.page.label, href: events.page.path });
  const newsletterLabel = line(newsletter?.nav?.label, 40);
  if (newsletter?.enabled && newsletterLabel) links.push({ id: "newsletter", title: newsletterLabel, href: "/newsletter/" });
  if (faq?.enabled && faq.page?.nav === "button") links.push({ id: "faq", title: faq.page.label, href: "/faq/" });
  return links;
}

const when = (event, language) => {
  const start = new Date(event.startAt);
  const end = event.endAt ? new Date(event.endAt) : null;
  // An all-day item is a day, not a moment: its day is read as written, not moved into a time zone.
  const options = { timeZone: event.allDay ? "UTC" : event.timeZone };
  const dateWords = { ...options, weekday: "short", month: "short", day: "numeric" };
  const timeWords = { ...options, hour: "numeric", minute: "2-digit" };
  let date, time = "";
  try {
    date = new Intl.DateTimeFormat(language, dateWords).format(start);
    if (!event.allDay) time = new Intl.DateTimeFormat(language, timeWords).format(start);
    if (end && !event.allDay && end.getTime() - start.getTime() < 24 * 3600 * 1000) time += ` – ${new Intl.DateTimeFormat(language, timeWords).format(end)}`;
    else if (end && (event.allDay || end.getTime() - start.getTime() >= 24 * 3600 * 1000)) date += ` – ${new Intl.DateTimeFormat(language, dateWords).format(end)}`;
  } catch { date = event.startAt.slice(0, 10); }
  // Plain spaces: some ICU builds put a narrow no-break space before AM and PM, which reads the same and tests differently.
  return { date: date.replace(/[\u202f\u00a0]/g, " "), time: time.replace(/[\u202f\u00a0]/g, " ") };
};

const STYLE = `<style>.ww-dated{max-width:60rem;margin:0 auto;padding:clamp(1.5rem,4vw,3rem) 1rem}.ww-dated-list{list-style:none;margin:0;padding:0;display:grid;gap:1rem}
.ww-dated-item{display:grid;grid-template-columns:minmax(6.5rem,auto) 1fr;gap:.25rem 1.25rem;align-items:start;padding:1rem 0;border-top:1px solid color-mix(in srgb,currentColor 18%,transparent)}
.ww-dated-item:last-child{border-bottom:1px solid color-mix(in srgb,currentColor 18%,transparent)}.ww-dated-when{font-weight:600;line-height:1.3}.ww-dated-when small{display:block;font-weight:400;opacity:.8}
.ww-dated-item h2{margin:0;font-size:1.15rem;line-height:1.3}.ww-dated-item p{margin:.35rem 0 0;opacity:.85}.ww-dated-where{font-size:.95rem}.ww-dated-empty{opacity:.85}
.ww-dated-past{margin-top:2rem}.ww-dated-past summary{cursor:pointer;font-weight:600}.ww-dated-feed{margin-top:1.5rem;font-size:.95rem}
@media(max-width:560px){.ww-dated-item{grid-template-columns:1fr}}</style>`;

const WORDS = {
  en: { none: "Nothing is scheduled right now. Check back soon.", past: "Past", feed: "Add these dates to your calendar" },
  tr: { none: "Şu anda planlanmış bir şey yok. Yakında tekrar bakın.", past: "Geçmiş", feed: "Bu tarihleri takviminize ekleyin" },
  de: { none: "Derzeit ist nichts geplant. Schauen Sie bald wieder vorbei.", past: "Vergangene", feed: "Diese Termine in Ihren Kalender übernehmen" },
  es: { none: "No hay nada programado por ahora. Vuelva pronto.", past: "Pasados", feed: "Añadir estas fechas a su calendario" },
  fr: { none: "Rien n'est prévu pour le moment. Revenez bientôt.", past: "Passés", feed: "Ajouter ces dates à votre agenda" }
};

// The page's content: upcoming items first, the recent past under a heading the reader can open, and the calendar
// feed. Plain, semantic markup in the website's own fonts and colours; the list carries the platform's dated-items
// marks so the editor and the detector know it for what it is.
export function renderDatedFragment(snapshot, { language = "en", now = Date.now() } = {}) {
  const words = WORDS[String(language).split("-")[0]] || WORDS.en;
  const page = snapshot.page;
  const sorted = [...snapshot.events].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const stillOn = (event) => Date.parse(event.endAt || event.startAt) + (event.allDay && !event.endAt ? 24 * 3600 * 1000 : 0) >= now;
  const upcoming = sorted.filter(stillOn);
  const past = sorted.filter((event) => !stillOn(event)).slice(-12).reverse();
  const item = (event) => {
    const { date, time } = when(event, language);
    const title = event.url ? `<a href="${escape(event.url)}">${escape(event.title)}</a>` : escape(event.title);
    return `<li class="ww-dated-item"><div class="ww-dated-when"><time datetime="${escape(event.startAt)}">${escape(date)}</time>${time ? `<small>${escape(time)}</small>` : ""}</div>`
      + `<div><h2>${title}</h2>${event.location ? `<p class="ww-dated-where">${escape(event.location)}</p>` : ""}${event.description ? `<p>${escape(event.description.slice(0, 400))}</p>` : ""}</div></li>`;
  };
  const body = `<section class="ww-dated" data-ww-event-list data-ww-events-src="/api/events" data-ww-dated-page>`
    + `<header class="ww-collection-head"><h1>${escape(page.label)}</h1></header>`
    + (upcoming.length ? `<ul class="ww-dated-list">${upcoming.map(item).join("")}</ul>` : `<p class="ww-dated-empty">${escape(words.none)}</p>`)
    + (past.length ? `<details class="ww-dated-past"><summary>${escape(words.past)}</summary><ul class="ww-dated-list">${past.map(item).join("")}</ul></details>` : "")
    + `<p class="ww-dated-feed"><a href="${escape(snapshot.calendarUrl)}">${escape(words.feed)}</a></p></section>`;
  return { head: STYLE, body };
}

// Serves the dated items page at the address the owner chose, or null for any other request so the website
// answers it. shell(path) is the website's own page at path, which lends its header, footer and styles; a website
// that has a page of its own at that address keeps it (it was built with the list on it).
export async function serveDatedPage(request, snapshot, { shell, language = "en", now = Date.now() } = {}) {
  const page = snapshot?.enabled ? snapshot.page : null;
  if (!page || !["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  const path = (() => { try { return decodeURI(url.pathname); } catch { return url.pathname; } })();
  if (path === page.path.slice(0, -1)) return new Response(null, { status: 301, headers: { location: `${page.path}${url.search}`, "cache-control": "public, max-age=300" } });
  if (path !== page.path) return null;
  const own = shell ? await Promise.resolve().then(() => shell(path)).catch(() => null) : null;
  if (own?.ok && (own.headers.get("content-type") || "").includes("text/html")) return own;
  await own?.body?.cancel?.();
  const home = shell ? await Promise.resolve().then(() => shell("/")).catch(() => null) : null;
  const fragment = renderDatedFragment(snapshot, { language, now });
  if (home?.ok && (home.headers.get("content-type") || "").includes("text/html")) {
    const composed = composeCollectionPage(home, fragment, { title: page.label, summary: "", origin: url.origin, canonical: `${url.origin}${page.path}` });
    composed.headers.set("x-ww-dated-page", "1");
    return request.method === "HEAD" ? new Response(null, composed) : composed;
  }
  await home?.body?.cancel?.();
  return new Response(request.method === "HEAD" ? null : `<!doctype html><html lang="${escape(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(page.label)}</title>${fragment.head}</head><body style="margin:0;font-family:system-ui,sans-serif;color:#1f2328;background:#fff"><main>${fragment.body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function navigationClass(value) {
  return String(value || "").split(/\s+/).filter((token) => /^[a-zA-Z0-9_-]+$/.test(token)
    && !["active", "current", "selected", "is-active", "is-current"].includes(token)).join(" ");
}
const hrefPath = (value) => { try { return new URL(String(value || ""), "https://site.invalid").pathname; } catch { return ""; } };

// Adds buttons to the website's menu while the page is served, copying the item and link classes the menu already
// uses so a new button looks like the others. A menu that already links to an address gets no second button for it.
export function addModuleNav(response, links, { pathname = "/" } = {}) {
  const wanted = (Array.isArray(links) ? links : []).filter((link) => /^\/[a-z0-9-]+\/$/.test(String(link?.href || "")) && line(link?.title, 40)).slice(0, 6);
  if (!wanted.length || typeof HTMLRewriter === "undefined") return response;
  let siteHeader = "pending", contentStarted = false, menu = "pending", itemClass = null, linkClass = null;
  const linked = new Set();
  const markup = () => wanted.filter((link) => !linked.has(link.href)).map((link) => {
    const current = pathname === link.href || pathname === link.href.slice(0, -1) ? ' aria-current="page"' : "";
    return `<li${itemClass ? ` class="${itemClass}"` : ""} data-ww-module-nav="${escape(link.id || "")}"><a${linkClass ? ` class="${linkClass}"` : ""} href="${escape(link.href)}"${current}>${escape(line(link.title, 40))}</a></li>`;
  }).join("");
  const inMenu = () => siteHeader === "open" && menu === "open";
  return new HTMLRewriter().on("main, article", { element() { contentStarted = true; } })
    .on("header", { element(element) {
      if (siteHeader !== "pending" || contentStarted) return;
      siteHeader = "open";
      element.onEndTag(() => { siteHeader = "closed"; });
    } })
    .on("header nav ul, header ul.nav-list, header ul#primary-nav", { element(element) {
      if (siteHeader !== "open" || menu !== "pending") return;
      menu = "open";
      element.onEndTag((end) => {
        menu = "closed";
        const html = markup();
        if (html) end.before(html, { html: true });
      });
    } })
    .on("header nav ul > li, header ul.nav-list > li, header ul#primary-nav > li", { element(element) {
      if (inMenu() && itemClass === null) itemClass = navigationClass(element.getAttribute("class"));
    } })
    .on("header nav ul > li > a, header ul.nav-list > li > a, header ul#primary-nav > li > a", { element(element) {
      if (inMenu() && linkClass === null) linkClass = navigationClass(element.getAttribute("class"));
    } })
    .on("header a[href]", { element(element) {
      if (siteHeader !== "open") return;
      const target = hrefPath(element.getAttribute("href"));
      for (const link of wanted) if (target === link.href || target === link.href.slice(0, -1)) linked.add(link.href);
    } })
    .transform(response);
}
