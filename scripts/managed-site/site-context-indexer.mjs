import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

const MAX_CHUNK_CHARS = 3500;
// Exact planner reads concatenate chunks. Non-overlapping offsets keep that
// reconstruction byte-for-byte correct; structured block/theme context now
// supplies the cross-boundary discovery that overlap previously approximated.
const CHUNK_OVERLAP_CHARS = 0;
const SCHEMA_VERSION = 1;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function routeFor(file) {
  const relative = String(file).replace(/^public\//, "").replace(/index\.html?$/i, "").replace(/\.html?$/i, "");
  return `/${relative}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}
function allowed(config, file) {
  const normalized = path.posix.normalize(String(file).replaceAll("\\", "/"));
  return !normalized.startsWith("../") && config.allowedRoots.includes(normalized.split("/")[0])
    && config.allowedExtensions.includes(path.posix.extname(normalized));
}
async function listFiles(directory, config) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(relative, config);
    return entry.isFile() && allowed(config, relative) ? [relative] : [];
  }));
  return nested.flat();
}
function chunksFor(filePath, content) {
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, content.length);
    if (end < content.length) {
      const newline = content.lastIndexOf("\n", end);
      if (newline > start + MAX_CHUNK_CHARS / 2) end = newline;
    }
    const raw = content.slice(start, end);
    if (raw) chunks.push({ file_path: filePath, chunk_index: chunks.length, start_offset: start, end_offset: end, content: raw, content_hash: sha256(raw) });
    if (end >= content.length) break;
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
  return chunks;
}
function pageContext(file, source) {
  const $ = load(source);
  const blocks = $("[data-ww-block], main > section, body > section").toArray().map((node, index) => {
    const element = $(node);
    return { id: element.attr("data-ww-block") || `${routeFor(file).replace(/\W+/g, "-").replace(/^-|-$/g, "") || "home"}-section-${index + 1}`,
      tag: node.tagName, classes: String(element.attr("class") || "").split(/\s+/).filter(Boolean), heading: element.find("h1,h2,h3").first().text().replace(/\s+/g, " ").trim() };
  });
  const behaviors = [...new Set($("[data-ww-behavior]").toArray().flatMap((node) => String($(node).attr("data-ww-behavior") || "").split(/\s+/).filter(Boolean)))];
  return { route: routeFor(file), file, title: $("title").text().trim(), description: $('meta[name="description"]').attr("content") || "", blocks,
    headings: $("h1,h2,h3").toArray().map((node) => $(node).text().replace(/\s+/g, " ").trim()).filter(Boolean),
    images: $("img").length, forms: $("form").length, behaviors,
    editableFields: $("[data-ww-edit]").toArray().map((node) => ({ id: $(node).attr("data-ww-edit"), kind: $(node).attr("data-ww-kind"), label: $(node).attr("data-ww-label") || "" })) };
}
function themeContext(styles) {
  const colors = new Set(); const fonts = new Set(); const breakpoints = new Set(); const tokens = {};
  for (const { source } of styles) {
    for (const match of source.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) tokens[match[1]] = match[2].trim();
    for (const match of source.matchAll(/(?:color|background|border(?:-color)?)\s*:\s*([^;}]+)/gi)) {
      for (const color of match[1].match(/#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) || []) colors.add(color);
    }
    for (const match of source.matchAll(/font-family\s*:\s*([^;}]+)/gi)) fonts.add(match[1].trim());
    for (const match of source.matchAll(/@media\s*([^\{]+)/gi)) breakpoints.add(match[1].trim());
  }
  return { tokens, colors: [...colors].slice(0, 40), fonts: [...fonts].slice(0, 20), breakpoints: [...breakpoints].slice(0, 20) };
}

export async function buildSiteContext(config, { commit = "", sourceKind = "main_push" } = {}) {
  const files = (await Promise.all(config.allowedRoots.map((root) => listFiles(root, config)))).flat().sort();
  const selected = []; const chunks = []; let usedBytes = 0;
  for (const file of files) {
    const source = (await readFile(file, "utf8")).slice(0, config.maxFileBytes);
    const bytes = Buffer.byteLength(source);
    if (usedBytes + bytes > config.maxSourceBytes) continue;
    selected.push({ file, source, bytes }); chunks.push(...chunksFor(file, source)); usedBytes += bytes;
  }
  if (!chunks.length) throw new Error("No eligible website source found for context indexing");
  const pages = selected.filter((entry) => /^public\/.*\.html?$/i.test(entry.file) && !/(^|\/)admin\//.test(entry.file)).map((entry) => pageContext(entry.file, entry.source));
  const styles = selected.filter((entry) => /\.css$/i.test(entry.file));
  const scripts = selected.filter((entry) => /\.(?:m?js|jsx)$/i.test(entry.file)).map((entry) => ({ file: entry.file, bytes: entry.bytes,
    domSelectors: [...entry.source.matchAll(/(?:querySelector(?:All)?|getElementById)\(\s*["']([^"']+)/g)].map((match) => match[1]).slice(0, 100) }));
  const contentSources = selected.filter((entry) => /^(?:content|public\/data)\/.*\.json$/i.test(entry.file)).map((entry) => ({ file: entry.file, keys: (() => { try { return Object.keys(JSON.parse(entry.source)).slice(0, 100); } catch { return []; } })() }));
  const context = { schemaVersion: SCHEMA_VERSION, commit: commit || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), generatedAt: new Date().toISOString(), sourceKind,
    structure: { routes: pages, scripts, totals: { files: selected.length, routes: pages.length, blocks: pages.reduce((sum, page) => sum + page.blocks.length, 0), bytes: usedBytes } },
    theme: themeContext(styles), content: { features: [...new Set(pages.flatMap((page) => page.behaviors))], contentSources, taggedFields: pages.reduce((sum, page) => sum + page.editableFields.length, 0) },
    diagnostics: { omittedFiles: files.filter((file) => !selected.some((entry) => entry.file === file)), parseErrors: [] } };
  return { context, chunks, contextHash: sha256(JSON.stringify(context)) };
}

export async function activateSiteContext({ supabaseUrl, serviceKey, repositoryId, commit, sourceKind, contextHash, context, chunks, fetchImpl = fetch }) {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/activate_site_context`, { method: "POST", headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
    body: JSON.stringify({ p_repository_id: repositoryId, p_commit_sha: commit, p_schema_version: SCHEMA_VERSION, p_source_kind: sourceKind, p_context_hash: contextHash, p_context: context, p_chunks: chunks }) });
  if (!response.ok) throw new Error(`Unable to activate site context: ${await response.text()}`);
  return response.json();
}
