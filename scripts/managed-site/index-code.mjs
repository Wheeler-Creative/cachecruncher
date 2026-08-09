import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { headers, loadConfig, repositoryMatches, requireEnvironment, restUrl } from "./lib.mjs";

requireEnvironment(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITHUB_REPOSITORY"]);
const config = await loadConfig();
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

function chunksFor(filePath, content, repositoryId, commit) {
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, content.length);
    if (end < content.length) {
      const newline = content.lastIndexOf("\n", end);
      if (newline > start + MAX_CHUNK_CHARS / 2) end = newline;
    }
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
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }
  return chunks;
}

async function findRepository() {
  const response = await fetch(restUrl("site_repositories", "?select=id,repo_slug"), { headers: headers() });
  if (!response.ok) throw new Error(`Unable to load repository registration: ${await response.text()}`);
  const repositories = await response.json();
  const repository = repositories.find((item) => repositoryMatches(config, item.repo_slug));
  if (!repository) throw new Error(`No site repository registration matches ${config.repository}`);
  return repository;
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

if (await indexAvailable()) {
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
