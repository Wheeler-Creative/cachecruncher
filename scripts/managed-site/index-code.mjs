import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { headers, loadConfig, requireEnvironment, restUrl, waitForRepositoryRegistration } from "./lib.mjs";

// Run only when executed as the workflow's script; imported (by a test of chunksFor) it does nothing.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  console.log("Supabase credentials not configured in this repository; skipping index.");
  process.exit(0);
}
if (isMain) requireEnvironment(["GITHUB_REPOSITORY"]);
const config = isMain ? await loadConfig() : null;
const MAX_CHUNK_CHARS = 3500;
const CHUNK_OVERLAP_CHARS = 300;

function allowedPath(filePath) {
  const normalized = path.posix.normalize(String(filePath).replaceAll("\\", "/"));
  const root = normalized.split("/")[0];
  return !normalized.startsWith("../")
    && config.allowedRoots.includes(root)
    && config.allowedExtensions.includes(path.posix.extname(normalized));
}

async function listFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(relative);
    return entry.isFile() && allowedPath(relative) ? [relative] : [];
  }));
  return nested.flat();
}

// A chunk boundary never splits a surrogate pair: an emoji cut in half is an unpaired surrogate, which the
// database refuses as invalid text (Flyloop carried this fix in its own copy of this file, 2026-08-30, and a
// runtime upgrade would have put the unsafe version back).
function safeUnicodeBoundary(content, index) {
  if (index <= 0 || index >= content.length) return index;
  const previous = content.charCodeAt(index - 1);
  const current = content.charCodeAt(index);
  return previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF ? index - 1 : index;
}

export function chunksFor(filePath, content, repositoryId, commit) {
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, content.length);
    if (end < content.length) {
      const newline = content.lastIndexOf("\n", end);
      if (newline > start + MAX_CHUNK_CHARS / 2) end = newline;
    }
    end = safeUnicodeBoundary(content, end);
    const chunk = content.slice(start, end).trim();
    if (chunk) {
      chunks.push({
        repository_id: repositoryId,
        file_path: filePath,
        chunk_index: chunks.length,
        content: chunk,
        content_hash: createHash("sha256").update(chunk).digest("hex"),
        indexed_commit: commit,
        updated_at: new Date().toISOString()
      });
    }
    if (end >= content.length) break;
    start = safeUnicodeBoundary(content, Math.max(end - CHUNK_OVERLAP_CHARS, start + 1));
  }
  return chunks;
}

async function findRepository({
  attempts = Number(process.env.INDEX_REGISTRATION_ATTEMPTS || 12),
  waitMs = Number(process.env.INDEX_REGISTRATION_WAIT_MS || 5000)
} = {}) {
  // A new repository's first push starts this workflow immediately. The build
  // coordinator registers it after consuming site.assemble's completed result,
  // so this action can reach Supabase before that coordinator pass does.
  // Wait through that bounded handoff instead of failing a successful build.
  const repository = await waitForRepositoryRegistration({
    config,
    attempts,
    waitMs,
    load: async () => {
      const response = await fetch(restUrl("site_repositories", "?select=id,repo_slug"), { headers: headers() });
      if (!response.ok) throw new Error(`Unable to load repository registration: ${await response.text()}`);
      return response.json();
    },
    onWait: (attempt) => {
      console.log(`Repository registration is not visible yet; waiting (${attempt}/${attempts})`);
    }
  });
  if (repository) return repository;
  throw new Error(`No site repository registration matches ${config.repository} after ${attempts} checks`);
}

async function indexAvailable() {
  const response = await fetch(restUrl("site_code_chunks", "?select=id&limit=1"), { headers: headers() });
  if (response.ok) return true;
  const detail = await response.text();
  if (response.status === 404 || /PGRST205|site_code_chunks/.test(detail)) {
    console.log("Code index migration 0008 is not applied; skipping index refresh");
    return false;
  }
  throw new Error(`Unable to probe code index: ${detail}`);
}

async function replaceIndex(repositoryId, chunks) {
  const remove = await fetch(restUrl("site_code_chunks", `?repository_id=eq.${encodeURIComponent(repositoryId)}`), {
    method: "DELETE",
    headers: headers({ Prefer: "return=minimal" })
  });
  if (!remove.ok) throw new Error(`Unable to clear previous code index: ${await remove.text()}`);

  for (let offset = 0; offset < chunks.length; offset += 100) {
    const response = await fetch(restUrl("site_code_chunks"), {
      method: "POST",
      headers: headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(chunks.slice(offset, offset + 100))
    });
    if (!response.ok) throw new Error(`Unable to write code index: ${await response.text()}`);
  }
}

if (isMain && await indexAvailable()) {
  const repository = await findRepository();
  const files = (await Promise.all(config.allowedRoots.map(listFiles))).flat().sort();
  const commit = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const chunks = [];
  let usedBytes = 0;

  for (const file of files) {
    const content = (await readFile(file, "utf8")).slice(0, config.maxFileBytes);
    const bytes = Buffer.byteLength(content);
    if (usedBytes + bytes > config.maxSourceBytes) continue;
    chunks.push(...chunksFor(file, content, repository.id, commit));
    usedBytes += bytes;
  }

  if (!chunks.length) throw new Error("No eligible source code found for indexing");
  await replaceIndex(repository.id, chunks);
  console.log(`Indexed ${chunks.length} chunks from ${files.length} candidate files at ${commit}`);
}
