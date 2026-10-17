import { renderIssueFragment, renderIssueHtml } from "./newsletter-render.js";
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

export function composeNewsletterPage(shell, fragment, { title = "Newsletter", summary = "", origin, canonical = "" }) {
  const response = new HTMLRewriter()
    .on("base", { element(element) { element.remove(); } })
    .on("title", { element(element) { element.setInnerContent(title); } })
    .on('link[rel="canonical"]', { element(element) { if (canonical) element.setAttribute("href", canonical); } })
    .on('meta[property="og:title"]', { element(element) { element.setAttribute("content", title); } })
    .on('meta[property="og:url"]', { element(element) { if (canonical) element.setAttribute("content", canonical); } })
    .on('meta[name="description"],meta[property="og:description"]', { element(element) { element.setAttribute("content", summary); } })
    .on("head", { element(element) {
      element.prepend(`<base href="${escape(origin)}/">`, { html: true });
      element.append(fragment.head, { html: true });
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

export async function serveNewsletter(request, bucket, siteId, issues, { shell } = {}) {
  const url = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const match = /^\/newsletter\/([^/]+)\/(download\.pdf)?$/.exec(url.pathname);
  if (!match && url.pathname !== "/newsletter/") return null;
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const response = (body, status = 200) => new Response(request.method === "HEAD" ? null : body, { status, headers });
  if (!match) {
    const links = issues.map((issue) => `<li><a href="${newsletterPath(issue.id)}">${escape(issue.title)}</a> <time>${escape(issue.issueDate)}</time></li>`).join("");
    if (shell) {
      const home = await shell();
      return composeNewsletterPage(home, { head: "", body: `<div style="max-width:900px;margin:auto;padding:24px"><h1>Newsletter</h1><ul>${links}</ul></div>` }, { origin: url.origin, canonical: url.href });
    }
    return response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Newsletter</title></head><body><main style="max-width:800px;margin:40px auto;padding:20px;font-family:Georgia,serif"><a href="/">Back to website</a><h1>Newsletter</h1><ul>${links}</ul></main></body></html>`);
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
  if (shell) {
    const home = await shell();
    if (home.ok && (home.headers.get("content-type") || "").includes("text/html")) {
      const composed = composeNewsletterPage(home, renderIssueFragment(issue, { origin: url.origin, downloadUrl: `${newsletterPath(issue.id)}download.pdf` }), {
        title: issue.title, summary: issue.summary, origin: url.origin, canonical: url.href
      });
      return request.method === "HEAD" ? new Response(null, composed) : composed;
    }
  }
  return response(renderIssueHtml(issue, { origin: url.origin, downloadUrl: `${newsletterPath(issue.id)}download.pdf` }));
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