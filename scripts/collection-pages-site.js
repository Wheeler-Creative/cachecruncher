// A website's blog and repeating pages, served by the website's own Worker from the snapshot the platform publishes
// (site-integrations/<site>/collections.json and one file per list). A list appears on the website once it has a
// published page: its list page, a page for each item, its place in the menu and in the sitemap. Anything this does
// not recognise falls through to the website's own pages, so a list never hides one of them by accident.
//
// On a website in more than one language a list has a page in each language it has pages in (/blog/ and /en/blog/),
// each in that language's own menu, and a page links to its translations. A list kept in the website's own design
// (a stencil per language) is drawn into the very page it came from, so it looks as it did.
//
// A list page is at the folder its pages are in (/blog/ for /blog/a-post/) unless the website already had a page that
// lists them somewhere else (posts at /post/a-post/, listed at /blog/): then that page is the list page (listPaths),
// the menu's own link to it stays the only one, and the folder leads to it.
//
// Other pages of the website that show a few of a list's pages (a home page's latest posts) are the list's places:
// their cards are drawn again from the list, newest first, each place in its own card (see fillCollectionPlaces).
//
// A set brought in from the website adds nothing to it. Where the website had no page listing its pages there is
// none (noListPage); a page that does not come back the same when drawn from the list stays the website's own page
// (own): the list knows it, links to it and shows it on cards, and this Worker leaves its address to the website. A
// list page shows only the pages the website's own list page showed (unlisted pages are left out).

import { renderItemFragment, renderListFragment, renderStandalonePage, renderStencilCards, renderStencilItem, renderStencilList } from "./collection-render.js";
export { COLLECTIONS_RENDER_VERSION } from "./collection-render.js";

const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const LIST_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const FOLDER = /^\/(?:[^\s/"'<>?#\\%]+\/){1,4}$/;
const FOLDER_OR_HOME = /^\/(?:[^\s/"'<>?#\\%]+\/){0,4}$/;
const NAV = new Set(["button", "submenu"]);

const decoded = (path) => { try { return decodeURI(path); } catch { return path; } };
const languageOf = (item) => item.language || "";
const titleIn = (list, code) => (code ? list.titles?.[code] || list.title : list.title);

// The lists that are on the website, with the old addresses that now lead to them.
export function parseCollectionsIndex(text) {
  try {
    const index = typeof text === "string" ? (text ? JSON.parse(text) : null) : text;
    const languages = (Array.isArray(index?.languages) ? index.languages : [])
      .filter((entry) => LANGUAGE.test(String(entry?.code || "")) && FOLDER.test(String(entry?.prefix || "")))
      .map((entry) => ({ code: entry.code, prefix: entry.prefix }));
    // more: lists written for a website that knows how to draw them (this one does).
    const collections = [...(Array.isArray(index?.collections) ? index.collections : []), ...(Array.isArray(index?.more) ? index.more : [])]
      .filter((list) => LIST_ID.test(String(list?.id || "")) && Array.isArray(list.items) && list.items.length)
      .map((list) => {
        const paths = { "": `/${list.id}/` };
        for (const [code, path] of Object.entries(list.paths || {})) if (code && LANGUAGE.test(code) && FOLDER.test(String(path))) paths[code] = path;
        const listPaths = { ...paths };
        for (const [code, path] of Object.entries(list.listPaths || {})) if (paths[code] && FOLDER.test(String(path))) listPaths[code] = path;
        // Never a list's own page, and nothing the Worker could not take for a selector or a card.
        const places = (Array.isArray(list.places) ? list.places : []).filter((place) => place && FOLDER_OR_HOME.test(String(place.route || ""))
          && !Object.values(listPaths).includes(place.route) && typeof place.selector === "string" && place.selector && place.selector.length <= 600 && !/[<{}]/.test(place.selector)
          && typeof place.card === "string" && place.card.includes("{{ww:url}}") && place.card.length <= 20000
          && Number.isInteger(place.count) && place.count > 0 && (!place.language || paths[place.language]))
          .slice(0, 6).map((place) => ({ route: place.route, language: place.language || "", selector: place.selector, count: Math.min(place.count, 24), card: place.card,
            slots: place.slots && typeof place.slots === "object" ? place.slots : {} }));
        const noListPage = (Array.isArray(list.noListPage) ? list.noListPage : []).map(String).filter((code) => paths[code] !== undefined);
        return { ...list, paths, listPaths, places, noListPage, stencils: Array.isArray(list.stencils) ? list.stencils.map(String) : [] };
      });
    const redirects = new Map();
    for (const list of collections) {
      const bases = Object.values(list.paths);
      for (const [from, to] of Object.entries(list.redirects || {})) {
        if (String(from).startsWith("/") && !String(from).startsWith("//") && bases.some((base) => String(to).startsWith(base))) redirects.set(from, to);
      }
    }
    return { collections, redirects, language: String(index?.language || ""), languages };
  } catch { return { collections: [], redirects: new Map(), language: "", languages: [] }; }
}

export function parseCollectionList(text) {
  try {
    const list = typeof text === "string" ? (text ? JSON.parse(text) : null) : text;
    return list?.enabled && Array.isArray(list.items) ? list : null;
  } catch { return null; }
}

const slashed = (path) => (path.endsWith("/") ? path : `${path}/`);
const unescaped = (text) => String(text ?? "").replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (whole, decimal, hex, name) => {
  if (name) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[name.toLowerCase()];
  try { return String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex, 16)); } catch { return whole; }
});

// What a path is: a list page (in a language), one of its pages, an old address that moved, the folder of a list whose
// list page is somewhere else, or none of these. A list page is there only in the languages the list has pages in.
export function collectionRoute(pathname, index) {
  const raw = String(pathname || "/");
  const path = decoded(raw);
  const moved = index.redirects.get(path) || index.redirects.get(slashed(path)) || index.redirects.get(raw) || index.redirects.get(slashed(raw));
  if (moved) return { redirect: moved };
  const folder = slashed(path);
  for (const list of index.collections) {
    for (const [language, base] of Object.entries(list.paths)) {
      const page = list.listPaths[language];
      const listed = !list.noListPage.includes(language);
      const shown = list.items.some((item) => languageOf(item) === language);
      if (path === page && shown && listed) return { list, language };
      if (!folder.startsWith(base)) continue;
      const rest = folder.slice(base.length);
      if (!rest) {
        if (page !== base && shown && listed) return { folder: page };
        continue;
      }
      if (!/^[^/]+\/$/.test(rest)) continue;
      const item = list.items.find((candidate) => candidate.path === `${base}${rest}` && languageOf(candidate) === language);
      // A page that stays the website's own is the website's to answer, slash and all.
      if (item?.own) return null;
      if (item) return path.endsWith("/") ? { list, item, language } : { redirect: item.path };
    }
  }
  return null;
}

const SWITCHES = 'a[hreflang], a[class*="lang"], [class*="lang"] a, [id*="lang"] a';

// The website's own page with its main content replaced: its header, footer, fonts and colours stay. keepMain keeps
// the page's own <main> (a stencil of the website's design is its content). alternates are the page in each language
// ("" is the main one), for search engines and for the website's own language switch: a switch link to another
// language leads to this page's translation there, or to that language's home page. ownHead is a list drawn into the
// very page of the website that listed its pages: what that page says about itself (its title, its description)
// stays, as its design does.
// lentTitle is the title of the page lending its design: where that page's own <title> holds it among other words
// (" | Studio"), the new title takes its place and the other words stay.
export function composeCollectionPage(shell, fragment, { title = "", summary = "", origin, canonical = "", image = "", schema = null,
  keepMain = false, ownHead = false, lentTitle = "", alternates = null, index = null, language = "", homes = null } = {}) {
  const framed = (written) => {
    const whole = unescaped(written).replace(/\s+/g, " ").trim();
    const at = lentTitle ? whole.indexOf(lentTitle) : -1;
    return at >= 0 && whole.length <= 300 ? `${whole.slice(0, at)}${title}${whole.slice(at + lentTitle.length)}` : title;
  };
  const versions = Object.entries(alternates || {});
  const hreflang = versions.length > 1 ? versions.map(([code, path]) => {
    const tag = code || index?.language || "x-default";
    return `<link rel="alternate" hreflang="${escape(tag)}" href="${escape(new URL(path, `${origin}/`).href)}">`;
  }).join("") : "";
  const head = fragment.head + hreflang + (schema ? `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>` : "");
  const imageUrl = image ? new URL(image, `${origin}/`).href : "";
  const languageAt = (path) => (index?.languages || []).find((entry) => path === entry.prefix.slice(0, -1) || path.startsWith(entry.prefix))?.code || "";
  let rewriter = new HTMLRewriter()
    .on("base", { element(element) { element.remove(); } })
    .on('link[rel="alternate"][hreflang]', { element(element) { element.remove(); } })
    .on('link[rel="canonical"]', { element(element) { if (canonical) element.setAttribute("href", canonical); } })
    .on('meta[property="og:url"]', { element(element) { if (canonical) element.setAttribute("content", canonical); } })
    .on('meta[property="og:type"]', { element(element) { if (schema) element.setAttribute("content", "article"); } })
    .on('meta[property="og:image"],meta[name="twitter:image"]', { element(element) { if (imageUrl) element.setAttribute("content", imageUrl); } })
    .on("head", { element(element) {
      element.prepend(`<base href="${escape(origin)}/">`, { html: true });
      element.append(head, { html: true });
    } });
  if (!ownHead) {
    let words = "", drawn = false;
    rewriter = rewriter.on("title", {
      element(element) { element.onEndTag((end) => { if (!drawn) end.before(title); }); },
      text(chunk) {
        words += chunk.text;
        if (!chunk.lastInTextNode) { chunk.remove(); return; }
        chunk.replace(framed(words));
        drawn = true;
      }
    }).on('meta[property="og:title"],meta[name="twitter:title"]', { element(element) { element.setAttribute("content", framed(element.getAttribute("content") || "")); } });
  }
  // The owner's words above the list, when there are any, describe the page even where it keeps its own title.
  if (!ownHead || summary) {
    rewriter = rewriter.on('meta[name="description"],meta[property="og:description"],meta[name="twitter:description"]', { element(element) { element.setAttribute("content", summary); } });
  }
  if (keepMain && !ownHead) {
    // The page lent its design is another post: what it said about itself goes.
    rewriter = rewriter.on('script[type="application/ld+json"], meta[property^="article:"], meta[name="keywords"]', { element(element) { element.remove(); } });
  }
  if (index?.languages?.length) {
    rewriter = rewriter.on(SWITCHES, { element(element) {
      const href = element.getAttribute("href");
      if (!href || /^(?:#|mailto:|tel:)/i.test(href)) return;
      let url;
      try { url = new URL(href, `${origin}/`); } catch { return; }
      if (url.origin !== origin) return;
      const target = languageAt(decoded(url.pathname));
      if (target === language) return;
      const next = alternates?.[target] || homes?.[target];
      if (next) element.setAttribute("href", next);
    } });
  }
  const response = rewriter.on("main", { element(element) {
    if (!keepMain) {
      element.setAttribute("class", "ww-collection-main");
      element.removeAttribute("style");
    }
    element.setInnerContent(fragment.body, { html: true });
  } }).transform(shell);
  response.headers.set("cache-control", "no-store");
  response.headers.delete("etag");
  response.headers.delete("content-length");
  // The shell page's response named the shell as canonical in its Link header (the site adds one to every page it
  // serves): an events, FAQ or list page drawn inside the home page told search engines it was the home page.
  // The header names the page being composed, the same address its tag names.
  if (canonical) replaceCanonicalHeader(response.headers, canonical);
  return response;
}

// Serves a list's pages, or null for anything that is not one so the website answers it. shell(path) is the
// website's own page at path.
// Every Link header entry but rel="canonical" is kept; the canonical one names `href`.
export function replaceCanonicalHeader(headers, href) {
  const kept = String(headers.get("link") || "").split(/,(?=\s*<)/).map((entry) => entry.trim())
    .filter((entry) => entry && !/;\s*rel\s*=\s*"?canonical"?/i.test(entry));
  headers.set("link", [`<${href}>; rel="canonical"`, ...kept].join(", "));
  return headers;
}

export async function serveCollection(request, index, { readList, shell } = {}) {
  if (!["GET", "HEAD"].includes(request.method) || !index.collections.length) return null;
  const url = new URL(request.url);
  const route = collectionRoute(url.pathname, index);
  if (!route) return null;
  const moved = (to) => new Response(null, { status: 301, headers: { location: `${to}${url.search}`, "cache-control": "public, max-age=300" } });
  if (route.redirect) return moved(route.redirect);
  if (route.folder) {
    // The folder leads to the list page, unless the website has a page of its own there.
    const own = shell ? await Promise.resolve().then(() => shell(url.pathname)).catch(() => null) : null;
    const kept = Boolean(own?.ok && (own.headers.get("content-type") || "").includes("text/html"));
    await own?.body?.cancel?.();
    return kept ? null : moved(route.folder);
  }
  const code = route.language || "";
  const language = code || index.language || "en";
  const languages = index.languages || [];
  const homes = Object.fromEntries([["", "/"], ...languages.map((entry) => [entry.code, entry.prefix])]);
  const home = homes[code] || "/";
  const named = { ...route.list, title: titleIn(route.list, code), path: route.list.paths[code], listPath: route.list.listPaths[code] };
  const designed = route.list.design?.look !== "simple" && route.list.stencils.includes(code);
  let fragment, meta, alternates, shellPath = home, keepMain = false, ownHead = false, lentTitle = "";
  if (route.item) {
    const full = readList ? parseCollectionList(await readList(route.list.id)) : null;
    const item = full?.items.find((candidate) => candidate.path === route.item.path && candidate.status === "published");
    if (!item) return null;
    const stencil = designed ? full.stencil?.[code]?.item : null;
    if (stencil?.main) {
      fragment = renderStencilItem(full, stencil, item, { language });
      shellPath = stencil.shell;
      keepMain = true;
      lentTitle = String(stencil.title || full.items.find((candidate) => candidate.path === stencil.shell || candidate.sourcePath === stencil.shell)?.title || "");
    } else fragment = renderItemFragment({ ...full, id: route.list.id, title: named.title, path: named.path, listPath: named.listPath }, item, { language });
    alternates = route.item.alternates || item.alternates || null;
    const image = route.item.image?.src || item.imageUrl || "";
    meta = { title: item.title, summary: item.summary || "", image,
      schema: full.preset === "blog" ? { "@context": "https://schema.org", "@type": "BlogPosting", headline: item.title,
        ...(item.date ? { datePublished: item.date } : {}), ...(image ? { image: new URL(image, url.origin).href } : {}),
        ...(item.summary ? { description: item.summary } : {}), inLanguage: language, mainEntityOfPage: url.href } : null };
  } else {
    const items = route.list.items.filter((item) => languageOf(item) === code && !item.unlisted);
    const full = designed && readList ? parseCollectionList(await readList(route.list.id)) : null;
    const stencil = full?.stencil?.[code]?.list;
    if (stencil?.main && stencil.card) {
      fragment = renderStencilList(route.list, stencil, { language, items, title: named.title });
      shellPath = stencil.shell;
      keepMain = true;
      ownHead = stencil.shell === named.listPath;
    } else fragment = renderListFragment({ ...named, items }, { language });
    alternates = Object.fromEntries(Object.entries(route.list.listPaths).filter(([other]) => route.list.items.some((item) => languageOf(item) === other)));
    meta = { title: named.title, summary: String(route.list.intro || "").replace(/[#*[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 300) };
  }
  if (shell) {
    let page = await Promise.resolve().then(() => shell(shellPath)).catch(() => null);
    if (!(page?.ok && (page.headers.get("content-type") || "").includes("text/html")) && shellPath !== home) {
      await page?.body?.cancel?.();
      page = await Promise.resolve().then(() => shell(home)).catch(() => null);
      ownHead = false;
      lentTitle = "";
    }
    if (page?.ok && (page.headers.get("content-type") || "").includes("text/html")) {
      const composed = composeCollectionPage(page, fragment, { ...meta, origin: url.origin, canonical: `${url.origin}${url.pathname}`,
        keepMain, ownHead, lentTitle, alternates, index, language: code, homes });
      // So a reader can tell a page drawn from a list from the website's own page at the same address.
      composed.headers.set("x-ww-collection", route.list.id);
      return request.method === "HEAD" ? new Response(null, composed) : composed;
    }
    await page?.body?.cancel?.();
  }
  return new Response(request.method === "HEAD" ? null : renderStandalonePage(fragment, { title: meta.title, origin: url.origin, language }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
  });
}

// A page of the website that shows a few of a list's pages has them drawn again from the list: the newest, as many as
// the page showed, each in the place's own card. The page is read twice. First for what the place's container links
// to now: only one whose links still lead to the list's pages (or into their folder, for one since removed) is drawn
// again, so a page that was rearranged keeps its cards as they were written rather than losing something else.
export async function fillCollectionPlaces(response, index, { pathname = "/", origin = "" } = {}) {
  const path = slashed(decoded(String(pathname || "/")));
  const here = index.collections.flatMap((list) => (list.places || []).filter((place) => place.route === path).map((place) => ({ list, place })));
  if (!here.length || typeof HTMLRewriter === "undefined" || !response?.ok || !(response.headers.get("content-type") || "").includes("text/html")) return response;
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  const page = () => new Response(text, { status: response.status, headers });
  const linked = here.map(() => []);
  try {
    let reader = new HTMLRewriter();
    here.forEach(({ place }, at) => { reader = reader.on(`${place.selector} a[href]`, { element(element) { linked[at].push(element.getAttribute("href")); } }); });
    await reader.transform(new Response(text)).text();
  } catch { return page(); }
  const leads = (list, href) => {
    let url;
    try { url = new URL(String(href || ""), `${origin || "https://site.invalid"}/`); } catch { return false; }
    if (origin && url.origin !== origin) return false;
    const target = slashed(decoded(url.pathname));
    return list.items.some((item) => item.path === target) || index.redirects.has(target) || Object.values(list.paths).some((folder) => target.startsWith(folder) && target !== folder);
  };
  try {
    let rewriter = new HTMLRewriter(), drawn = 0;
    here.forEach(({ list, place }, at) => {
      const links = linked[at];
      if (links.length < 2 || links.filter((href) => leads(list, href)).length * 2 < links.length) return;
      const items = list.items.filter((item) => languageOf(item) === place.language).slice(0, place.count);
      if (!items.length) return;
      const cards = renderStencilCards(list, place, items, { language: place.language || index.language || "en" });
      let done = false;
      rewriter = rewriter.on(place.selector, { element(element) { if (done) return; done = true; element.setInnerContent(cards, { html: true }); } });
      drawn += 1;
    });
    return drawn ? rewriter.transform(page()) : page();
  } catch { return page(); }
}

// Class tokens safe to copy from the menu's own items; state classes belong to the item they were on.
function navigationClass(value) {
  return String(value || "").split(/\s+/).filter((token) => /^[A-Za-z0-9_-]+$/.test(token)
    && !["active", "current", "is-active", "is-current", "selected", "current-menu-item", "nav-folder"].includes(token)).join(" ");
}

function hrefPath(value) {
  try { return new URL(value, "https://site.invalid").pathname; } catch { return ""; }
}

export const MAX_MENU_PAGES = 30;

// Each list whose owner put it in the menu becomes one more item of the website's own menu, wearing the classes of
// its other items. A drop-down reuses the store's menu (its button, styles and script already ship with every site).
// On a page in another language, the list's page in that language is offered, when the list has pages in it; a menu
// that already links to the list page keeps its own link, and gets no second one. A page that says it is in another language (its <html lang> differs
// from the website's, or matches its own language folder such as /en/) never gets the main language's buttons.
export function addCollectionNav(response, index, { pathname = "/", languagePrefixes = [] } = {}) {
  const path = decoded(String(pathname || "/"));
  const current = (index.languages || []).find((entry) => path === entry.prefix.slice(0, -1) || path.startsWith(entry.prefix));
  if (!current && languagePrefixes.some((code) => path === `/${code}` || path.startsWith(`/${code}/`))) return response;
  const code = current?.code || "";
  const lists = index.collections.filter((list) => NAV.has(list.nav) && list.paths[code]).map((list) => ({
    id: list.id, nav: list.nav, title: titleIn(list, code), href: list.listPaths[code], folder: list.paths[code],
    items: list.items.filter((item) => languageOf(item) === code)
  })).filter((list) => list.items.length);
  if (!lists.length || typeof HTMLRewriter === "undefined") return response;
  let siteHeader = "pending", contentStarted = false, menu = "pending", itemClass = null, linkClass = null, foreign = false;
  const linked = new Set();
  const submenu = lists.some((list) => list.nav === "submenu");
  const primaryOf = (value) => String(value || "").trim().toLowerCase().split("-")[0];
  const markup = () => foreign ? "" : lists.filter((list) => !linked.has(list.id)).map((list) => {
    const href = escape(list.href);
    const current = path === list.href || path.startsWith(list.href) || path.startsWith(list.folder) ? ' aria-current="page"' : "";
    const link = `<a${linkClass ? ` class="${linkClass}"` : ""} href="${href}"${current}>${escape(list.title)}</a>`;
    const classes = [itemClass, list.nav === "submenu" ? "ww-store-menu" : ""].filter(Boolean).join(" ");
    const pages = list.nav === "submenu" ? list.items.slice(0, MAX_MENU_PAGES) : [];
    const drop = pages.length ? `<button type="button" class="ww-store-toggle" aria-expanded="false" aria-label="${escape(`${list.title}: more`)}"><span aria-hidden="true"></span></button>`
      + `<ul class="ww-store-submenu"><li><a class="ww-store-submenu-all" href="${href}">${escape(list.title)}</a></li>`
      + pages.map((item) => `<li><a href="${escape(item.path)}">${escape(item.title)}</a></li>`).join("") + "</ul>" : "";
    return `<li${classes ? ` class="${classes}"` : ""} data-ww-collection-nav="${list.id}">${link}${drop}</li>`;
  }).join("");
  const inMenu = () => siteHeader === "open" && menu === "open";
  let rewriter = new HTMLRewriter();
  if (!current) rewriter = rewriter.on("html", { element(element) {
    const lang = primaryOf(element.getAttribute("lang"));
    if (!lang) return;
    const main = primaryOf(index.language);
    foreign = main ? lang !== main : path.split("/")[1]?.toLowerCase() === lang;
  } });
  if (submenu) rewriter = rewriter.on("head", { element(element) { element.prepend('<link rel="stylesheet" href="/shop.css">', { html: true }); } });
  return rewriter.on("main, article", { element() { contentStarted = true; } })
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
      const target = decoded(hrefPath(element.getAttribute("href")));
      for (const list of lists) if (target === list.href || target === list.href.slice(0, -1)) linked.add(list.id);
    } })
    .transform(response);
}

// The sitemap names each list page and its pages; an old address that now leads to one of them is left out.
// Pages the runtime serves that no file stands for (an events page where the owner put it, the FAQ page, newsletter
// issues) added to a sitemap that does not list them yet. They were served and linked, and listed nowhere.
export function addSitemapPages(xml, paths, origin) {
  const text = String(xml);
  const listed = new Set([...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => decoded(hrefPath(match[1]))));
  const add = [...new Set((paths || []).filter((path) => typeof path === "string" && path.startsWith("/")))]
    .filter((path) => !listed.has(path) && !listed.has(path.replace(/\/$/, "") || "/"))
    .map((path) => `<url><loc>${escape(origin + encodeURI(path))}</loc></url>`).join("");
  return add && text.includes("</urlset>") ? text.replace("</urlset>", `${add}</urlset>`) : text;
}

export function collectionSitemap(xml, index, origin) {
  if (!index.collections.length) return xml;
  let text = String(xml);
  // Any address the lists send elsewhere leaves the sitemap: a page moved into a list (index.redirects) and an item
  // asked for without its slash, which the list redirects to the item. The second stayed listed, so a translated
  // website's sitemap named /areas/brentwood beside /areas/brentwood/ and its health check flagged the redirect.
  text = text.replace(/\s*<url>[\s\S]*?<\/url>/g, (entry) => {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/.exec(entry)?.[1];
    if (!loc) return entry;
    const path = hrefPath(loc);
    return index.redirects.has(path) || collectionRoute(path, index)?.redirect ? "" : entry;
  });
  const listed = new Set([...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => decoded(hrefPath(match[1]))));
  const add = index.collections.flatMap((list) => [
    ...Object.entries(list.listPaths).filter(([code]) => !list.noListPage.includes(code) && list.items.some((item) => languageOf(item) === code)).map(([, path]) => ({ path })),
    ...list.items.map((item) => ({ path: item.path, date: item.date }))])
    .filter((entry) => entry.path && !listed.has(entry.path))
    .map((entry) => `<url><loc>${escape(origin + encodeURI(entry.path))}</loc>${entry.date ? `<lastmod>${escape(entry.date)}</lastmod>` : ""}</url>`).join("");
  return add && text.includes("</urlset>") ? text.replace("</urlset>", `${add}</urlset>`) : text;
}
