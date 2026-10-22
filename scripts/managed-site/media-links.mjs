// The site's image links.
//
//   node scripts/managed-site/media-links.mjs --check origin/main
//     Fails if this change adds a link to an image or file outside the site's
//     one image folder (/images/<name>) or files/ (/media/files/<name>). Offline:
//     no secrets, no network. Links that were already outside are not blamed on it.
//   node scripts/managed-site/media-links.mjs --publish
//     Records what the deployed code links to, which is how the image manager
//     knows what is in use. Needs CLOUDFLARE_API_TOKEN.
//
// What counts as a link is one rule shared with the platform (media-layout.js): the site's own source files, not the
// build's copy of them (dist/), not the sitemap or robots.txt (they list addresses and are made from the pages), and
// only a link that is root-relative or on one of the site's own hosts (a supplier's /images/x is not our file).
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { MEDIA_USAGE_KEY, isBuiltOutputFile, isCentralKey, isSitemapFile, mediaReferences, siteOwnHostsFromFiles } from "./media-layout.js";

const TEXT_FILE = /\.(?:html?|css|m?js|json|jsonc|xml|txt|svg|webmanifest)$/i;
const SKIP = new Set([".git", ".github", ".wrangler", "node_modules", "docs", "scripts", "dist"]);
// Dot-entries are builder metadata (.site-generation.json), not served site content.
const skipped = (file) => file.split("/").some((part) => SKIP.has(part) || part.startsWith("."));

async function workingFiles(root = ".") {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) await walk(full);
      } else if (TEXT_FILE.test(entry.name) && !entry.name.startsWith(".")) {
        files.push([path.relative(root, full), await readFile(full, "utf8")]);
      }
    }
  };
  await walk(root);
  return files;
}

function filesAt(ref) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return git("ls-tree", "-r", "--name-only", ref).split("\n")
    .filter((file) => file && TEXT_FILE.test(file) && !skipped(file))
    .map((file) => [file, git("show", `${ref}:${file}`)]);
}

// The record is: for each stored file, how many of the site's own files link to it. `files` is [[path, text]].
function usageOf(files, extraFiles = []) {
  const ownHosts = siteOwnHostsFromFiles([...files, ...extraFiles]);
  const usage = new Map();
  for (const [file, text] of files) {
    if (isSitemapFile(file) || isBuiltOutputFile(file)) continue;
    for (const key of mediaReferences(text, new Set(), { ownHosts })) {
      if (!usage.has(key)) usage.set(key, new Set());
      usage.get(key).add(file);
    }
  }
  return usage;
}

// The site's address can be named only in its wrangler file; .toml is not a text file the scan reads.
async function wranglerFiles() {
  const found = [];
  for (const name of ["wrangler.toml"]) {
    const text = await readFile(name, "utf8").catch(() => "");
    if (text) found.push([name, text]);
  }
  return found;
}

// Site repositories carry only the API token secret; wrangler finds the account
// from it, and so does this. An explicit id wins.
async function accountIdFor(token) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=50", {
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  const accounts = body.result || [];
  if (!response.ok || accounts.length !== 1) {
    throw new Error(`Could not tell which Cloudflare account this token belongs to (${accounts.length} found); set CLOUDFLARE_ACCOUNT_ID.`);
  }
  return accounts[0].id;
}

async function publish(siteId, usage) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  const accountId = await accountIdFor(token);
  const key = `sites/${siteId}/${MEDIA_USAGE_KEY}`;
  const images = Object.fromEntries([...usage].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, files]) => [name, { uses: files.size, pages: [...files].sort().slice(0, 5) }]));
  // reading 2: sitemaps, the build's copy and other hosts' links are not counted (an older record counted them).
  const body = JSON.stringify({ version: 1, reading: 2, generatedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA || null, images });
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/sharedbucket/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { method: "PUT", body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    if (response.ok) return;
    if (attempt >= 5 || (response.status !== 429 && response.status < 500)) throw new Error(`Storage write failed (${response.status})`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

async function main() {
  const worker = await readFile("src/worker.js", "utf8").catch(() => "");
  const siteId = worker.match(/const MEDIA_PREFIX = "sites\/([0-9a-f-]{36})\/"/)?.[1];
  if (!siteId) {
    console.log("This site does not use the shared media storage; nothing to check.");
    return;
  }
  const extra = await wranglerFiles();
  const head = usageOf(await workingFiles(), extra);

  if (process.argv.includes("--publish")) {
    await publish(siteId, head);
    console.log(`Recorded ${head.size} linked files for the image manager.`);
    return;
  }

  const base = process.argv[process.argv.indexOf("--check") + 1];
  if (!process.argv.includes("--check") || !base) throw new Error("Usage: --check <base ref> | --publish");
  const before = usageOf(filesAt(base), extra);
  const outside = (usage, only) => [...usage.keys()].filter((key) => !isCentralKey(key) && only(key)).sort();
  const added = outside(head, (key) => !before.has(key));
  const inherited = outside(head, (key) => before.has(key));
  if (inherited.length) {
    console.log(`Note: ${inherited.length} link(s) were already outside the image folder before this change.`);
  }
  if (added.length) {
    for (const key of added.slice(0, 50)) console.error(`Outside the image folder: ${key} (linked from ${[...head.get(key)].slice(0, 3).join(", ")})`);
    throw new Error(`${added.length} newly linked file(s) are outside the image folder. Upload images in the image manager so they land in /images/<name>.`);
  }
  console.log("This change links nothing outside the image folder.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
