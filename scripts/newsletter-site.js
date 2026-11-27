import { renderIssueFragment } from "./newsletter-render.js";
import { replaceCanonicalHeader } from "./collection-pages-site.js";
export { NEWSLETTER_RENDER_VERSION } from "./newsletter-render.js";

export function publishedNewsletters(text) {
  try {
    const snapshot = typeof text === "string" ? JSON.parse(text) : text;
    return snapshot?.enabled && Array.isArray(snapshot.issues) ? snapshot.issues.filter((issue) => issue.status === "published") : [];
  } catch { return []; }
}

export const newsletterPath = (id) => `/newsletter/${encodeURIComponent(id)}/`;

const escape = (text) => String(text || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const line = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const unescaped = (text) => String(text ?? "").replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (whole, decimal, hex, name) => {
  if (decimal || hex) { try { return String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex, 16)); } catch { return whole; } }
  return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[name.toLowerCase()];
});

// What search results show for the newsletter's pages. The website health check (src/get-found/seo-health.js) wants a
// title of 15 to 60 characters, a description of 50 to 160 and one main heading; all of it comes from the website's
// name and the issues' own words, and nothing else is said.
const TITLE_MIN = 15, TITLE_MAX = 60, DESCRIPTION_MIN = 50, DESCRIPTION_MAX = 160;

// Whole words, with an ellipsis where it was cut; a description ends at a whole sentence when one is long enough.
function shorten(text, max, { sentences = false } = {}) {
  const clean = line(text);
  if (clean.length <= max) return clean;
  if (sentences) {
    const window = clean.slice(0, max);
    const end = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    if (end + 1 >= DESCRIPTION_MIN) return window.slice(0, end + 1);
  }
  const window = clean.slice(0, max - 1);
  const word = window.lastIndexOf(" ");
  return `${(word >= max / 2 ? window.slice(0, word) : window).replace(/[\s,;:|–—-]+$/, "")}…`;
}

// The website's name as its own pages give it to search engines and share previews (og:site_name), read from the page
// the newsletter is drawn in; the name the platform keeps for the website (the snapshot's siteName) when it gives none.
export function siteNameOf(html, fallback = "") {
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    if (!/\bproperty\s*=\s*["']?og:site_name["'\s>]/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const name = line(unescaped(content?.[1] ?? content?.[2] ?? ""));
    if (name) return name.slice(0, 120);
  }
  return line(fallback).slice(0, 120);
}

export function newsletterSiteName(text) {
  try {
    const snapshot = typeof text === "string" ? JSON.parse(text) : text;
    return line(snapshot?.siteName).slice(0, 120);
  } catch { return ""; }
}

// A page's title: what the page is, then the website's name, as the website's other pages are titled ("About | Name").
// Too long, the page's part gives way first and the website's name second; too short, it says it is the newsletter.
export function newsletterTitle(lead, siteName = "") {
  const head = line(lead), name = line(siteName);
  const has = (whole, part) => whole.toLowerCase().includes(part.toLowerCase());
  const filled = (title) => (title.length < TITLE_MIN && !/newsletter/i.test(title) ? `${title} newsletter` : title);
  if (!name || (head && has(head, name))) return filled(shorten(head || name || "Newsletter", TITLE_MAX));
  if (!head || has(name, head)) return filled(shorten(name, TITLE_MAX));
  const joined = filled(`${head} | ${name}`);
  if (joined.length <= TITLE_MAX) return joined;
  const room = TITLE_MAX - name.length - 3;
  if (room >= 20) return `${shorten(head, room)} | ${name}`;
  if (head.length <= TITLE_MAX - 23) return `${head} | ${shorten(name, TITLE_MAX - head.length - 3)}`;
  return shorten(head, TITLE_MAX);
}

// The list page: whose newsletter it is and the issues it lists, by their own titles.
export function newsletterListDescription(siteName, issues = []) {
  const name = line(siteName);
  const opening = !name ? "Read every issue of the newsletter" : /newsletter/i.test(name) ? `Read every issue of ${name}` : `Read every issue of the newsletter from ${name}`;
  const titles = [...new Set(issues.map((issue) => line(issue?.title)).filter(Boolean))];
  const all = `${opening}: ${titles.join(", ")}.`;
  if (titles.length && all.length <= DESCRIPTION_MAX) return all;
  const listed = [];
  for (const title of titles) {
    if (`${opening}, including ${[...listed, title].join(", ")}.`.length > DESCRIPTION_MAX) break;
    listed.push(title);
  }
  return listed.length ? `${opening}, including ${listed.join(", ")}.` : shorten(`${opening}.`, DESCRIPTION_MAX, { sentences: true });
}

// The words an issue says, in its order: its paragraphs first, its headings when it has no paragraphs.
function issueWords(issue) {
  const blocks = Array.isArray(issue?.template?.blocks) ? issue.template.blocks : [];
  const content = issue?.content || {};
  const of = (kind) => blocks.filter((block) => block.kind === kind && typeof content[block.key] === "string").map((block) => line(content[block.key])).filter(Boolean);
  const text = of("text");
  return (text.length ? text : of("heading")).join(" ");
}

// An issue's page: the owner's summary of it, filled out from the issue's own words when the summary is short or
// missing. When even those are short, it first says which newsletter the issue is from.
export function newsletterIssueDescription(issue, siteName = "") {
  const summary = line(issue?.summary);
  if (summary.length >= DESCRIPTION_MIN) return shorten(summary, DESCRIPTION_MAX, { sentences: true });
  const words = issueWords(issue);
  const both = summary && !words.toLowerCase().startsWith(summary.toLowerCase().replace(/[.…]+$/, "")) ? `${/[.!?…]$/.test(summary) ? summary : `${summary}.`} ${words}` : words || summary;
  const own = shorten(both, DESCRIPTION_MAX, { sentences: true });
  if (own.length >= DESCRIPTION_MIN) return own;
  const name = line(siteName), title = line(issue?.title);
  const whose = name && title ? `${title}: an issue of the newsletter from ${name}.` : "";
  return shorten([whose, own].filter(Boolean).join(" "), DESCRIPTION_MAX, { sentences: true });
}

export function composeNewsletterPage(shell, fragment, { title = "Newsletter", summary = "", origin, canonical = "" }) {
  // A home page without a title or a description tag of its own still gets the page's: added before its head closes.
  let titled = false, described = false;
  const response = new HTMLRewriter()
    .on("base", { element(element) { element.remove(); } })
    .on("head > title", { element(element) { titled = true; element.setInnerContent(title); } })
    .on('link[rel="canonical"]', { element(element) { if (canonical) element.setAttribute("href", canonical); } })
    .on('meta[property="og:title"],meta[name="twitter:title"]', { element(element) { element.setAttribute("content", title); } })
    .on('meta[property="og:url"]', { element(element) { if (canonical) element.setAttribute("content", canonical); } })
    .on('meta[name="description"],meta[property="og:description"],meta[name="twitter:description"]', { element(element) {
      if ((element.getAttribute("name") || "").toLowerCase() === "description") described = true;
      element.setAttribute("content", summary);
    } })
    .on("head", { element(element) {
      element.prepend(`<base href="${escape(origin)}/">`, { html: true });
      element.append(fragment.head, { html: true });
      element.onEndTag((end) => {
        if (!titled && title) end.before(`<title>${escape(title)}</title>`, { html: true });
        if (!described && summary) end.before(`<meta name="description" content="${escape(summary)}">`, { html: true });
      });
    } })
    .on("main", { element(element) {
      element.setAttribute("class", "ww-newsletter-main");
      element.removeAttribute("style");
      element.setInnerContent(fragment.body, { html: true });
    } }).transform(shell);
  response.headers.set("cache-control", "no-store");
  response.headers.delete("etag");
  response.headers.delete("content-length");
  // A newsletter page is drawn inside the home page, whose Link header named the home page as canonical.
  if (canonical) replaceCanonicalHeader(response.headers, canonical);
  return response;
}

// The website's home page, read whole, so the newsletter page can take the website's name from it before drawing.
async function homePage(shell) {
  const home = shell ? await shell().catch(() => null) : null;
  if (!home?.ok || !(home.headers.get("content-type") || "").includes("text/html")) return null;
  const html = await home.text();
  return { html, response: () => new Response(html, { status: home.status, headers: home.headers }) };
}

// The page when there is no home page to draw it in: the same head and the same main heading, on a plain page.
const plainPage = ({ title, summary, head = "", body, bodyClass = "" }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<title>${escape(title)}</title>${summary ? `<meta name="description" content="${escape(summary)}">` : ""}${head}</head>`
  + `<body${bodyClass ? ` class="${bodyClass}"` : ""}><main>${body}</main></body></html>`;

export async function serveNewsletter(request, bucket, siteId, issues, { shell, siteName = "" } = {}) {
  const url = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const match = /^\/newsletter\/([^/]+)\/(download\.pdf)?$/.exec(url.pathname);
  if (!match && url.pathname !== "/newsletter/") return null;
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const response = (body, status = 200) => new Response(request.method === "HEAD" ? null : body, { status, headers });
  if (!match) {
    // Nothing to list is no page at all, and the visitor gets the website's own not-found page.
    if (!issues.length) return null;
    const home = await homePage(shell);
    const name = siteNameOf(home?.html, siteName);
    const title = newsletterTitle("Newsletter", name);
    const summary = newsletterListDescription(name, issues);
    const links = issues.map((issue) => `<li><a href="${newsletterPath(issue.id)}">${escape(issue.title)}</a> <time>${escape(issue.issueDate)}</time></li>`).join("");
    if (home) {
      const composed = composeNewsletterPage(home.response(), { head: "", body: `<div style="max-width:900px;margin:auto;padding:24px"><h1>Newsletter</h1><ul>${links}</ul></div>` }, { title, summary, origin: url.origin, canonical: url.href });
      return request.method === "HEAD" ? new Response(null, composed) : composed;
    }
    return response(plainPage({ title, summary, body: `<div style="max-width:800px;margin:40px auto;padding:20px;font-family:Georgia,serif"><a href="/">Back to website</a><h1>Newsletter</h1><ul>${links}</ul></div>` }));
  }
  const issue = issues.find((candidate) => candidate.id === match[1]);
  if (!issue) return response("Not found", 404);
  if (match[2]) {
    let path;
    try { path = decodeURIComponent(new URL(issue.fileUrl, url.origin).pathname); } catch { return response("Not found", 404); }
    const relative = /^\/(?:media\/)?(files\/[^/]+\.pdf)$/i.exec(path)?.[1];
    if (!relative || /[\\\u0000-\u001f]/.test(relative) || relative.includes("..")) return response("Not found", 404);
    const object = await bucket?.get(`sites/${siteId}/${relative}`);
    if (!object) return response("Not found", 404);
    return new Response(request.method === "HEAD" ? null : object.body, { headers: {
      "content-type": "application/pdf", "content-disposition": `attachment; filename="${relative.split("/").pop().replace(/[^a-zA-Z0-9._-]/g, "-")}"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff"
    } });
  }
  const home = await homePage(shell);
  const name = siteNameOf(home?.html, siteName);
  const title = newsletterTitle(issue.title, name);
  const summary = newsletterIssueDescription(issue, name);
  const fragment = renderIssueFragment(issue, { origin: url.origin, downloadUrl: `${newsletterPath(issue.id)}download.pdf` });
  if (home) {
    const composed = composeNewsletterPage(home.response(), fragment, { title, summary, origin: url.origin, canonical: url.href });
    return request.method === "HEAD" ? new Response(null, composed) : composed;
  }
  const pdf = issue?.template?.presentation?.kind === "pdf-layout";
  return response(plainPage({ title, summary, head: fragment.head, body: fragment.body, bodyClass: pdf ? "pdf-document" : "" }));
}

export function replaceNewsletterPdfs(response, origin, issues, { bucket, siteId, matches = new Map() } = {}) {
  const pages = new Map(issues.filter((issue) => issue.fileUrl).flatMap((issue) => {
    const original = issue.sourceKey?.startsWith("pdf:") ? issue.sourceKey.slice(4) : "";
    return [new URL(issue.fileUrl, origin).pathname, original.startsWith("/") ? original : original.startsWith("files/") ? `/media/${original}` : ""]
      .filter(Boolean).map((path) => [path, newsletterPath(issue.id)]);
  }));
  if (!pages.size) return response;
  const hashes = new Map(issues.map((issue) => {
    const hash = /-([a-f0-9]{10})\.pdf$/i.exec(new URL(issue.fileUrl, origin).pathname)?.[1];
    return [hash, newsletterPath(issue.id)];
  }).filter(([hash]) => hash));
  let reads = 0;
  const hrefFor = async (value) => {
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin) return null;
      if (pages.has(url.pathname)) return pages.get(url.pathname);
      const key = /^\/media\/(files\/[^/]+\.pdf)$/i.exec(decodeURIComponent(url.pathname))?.[1];
      if (!bucket || !siteId || !key || key.includes("..") || !hashes.size) return null;
      let cached = matches.get(key);
      if (!cached || Date.now() - cached.at > 20000) {
        if (reads++ >= 8) return null;
        const digest = (async () => {
          const object = await bucket.get(`sites/${siteId}/${key}`);
          if (!object || object.size > 10 * 1024 * 1024) return null;
          const bytes = await object.arrayBuffer();
          if (bytes.byteLength > 10 * 1024 * 1024) return null;
          return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 10);
        })();
        cached = { at: Date.now(), digest };
        if (matches.size >= 128) matches.delete(matches.keys().next().value);
        matches.set(key, cached);
      }
      return hashes.get(await cached.digest) || null;
    } catch { return null; }
  };
  return new HTMLRewriter().on("a[href]", { async element(element) {
    if (element.getAttribute("download") !== null) return;
    const href = await hrefFor(element.getAttribute("href"));
    if (href) { element.setAttribute("href", href); element.removeAttribute("target"); }
  } }).on("iframe[src],embed[src],object[data]", { async element(element) {
    const href = await hrefFor(element.getAttribute("src") || element.getAttribute("data"));
    if (href) element.replace(`<a href="${href}">Read newsletter</a>`, { html: true });
  } }).transform(response);
}