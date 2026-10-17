import { hasSharedLayout, renderSharedSource } from "./compose-site-chrome.mjs";
// Serving a generated site locally so a browser can inspect it before deploy.
//
// remediate-accessibility.mjs and remediate-overflow.mjs both need the same
// three things: find the HTML files, map a file back to its route, and serve
// the directory over HTTP so relative and root-relative URLs resolve the way
// they will in production. Both had their own copy, and a copy is a place for
// the two to quietly disagree about what a route is.

import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

/** Every .html file under a directory, recursively. Missing directory: none. */
export async function htmlFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await htmlFiles(full));
    else if (entry.name.endsWith(".html")) found.push(full);
  }
  return found.sort();
}

/** public/about/index.html -> /about/ */
export function routeFor(publicDir, file) {
  const relative = path.relative(publicDir, file).split(path.sep).join("/");
  if (relative === "index.html") return "/";
  return `/${relative.replace(/index\.html$/, "")}`;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
  ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
  ".webmanifest": "application/manifest+json"
};

/**
 * A read-only static server on a random localhost port.
 *
 * Resolves a directory to its index.html, contains path traversal, and answers
 * 404 for anything missing rather than throwing - a page that references a
 * stylesheet we did not generate should still render for inspection.
 */
export function serveStatic(root) {
  const server = createServer(async (request, response) => {
    try {
      const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      let file = path.join(root, requested);
      if (!path.resolve(file).startsWith(path.resolve(root))) {
        response.writeHead(403).end();
        return;
      }
      const info = await stat(file).catch(() => null);
      if (info?.isDirectory()) file = path.join(file, "index.html");
      let body = await readFile(file);
      const site=path.dirname(path.resolve(root));
      if(path.extname(file)==='.html' && await hasSharedLayout(site) && !/<html\b|<!doctype/i.test(body.toString('utf8')))body=Buffer.from(await renderSharedSource(site,path.relative(root,file).split(path.sep).join('/'),body.toString('utf8')));
      response.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Starts a server and hands back its origin plus a close function. */
export async function serveForInspection(root) {
  const server = await serveStatic(root);
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close()
  };
}
