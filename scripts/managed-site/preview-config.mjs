// The preview's wrangler config, derived from the site's own at deploy time.
//
// WHY THIS EXISTS. A preview used to be deployed from a checked-in
// wrangler.preview.jsonc, written once at provision time by copying a fixed
// list of fields out of wrangler.jsonc: main, compatibility_date, workers_dev,
// observability, assets. Any binding the site gained afterwards - or had all
// along, since bindings are attached elsewhere - was simply absent. So a site
// that serves its photos from R2 through env.MEDIA had a preview with no MEDIA
// binding, and its worker answered 404 for every image on the page. The
// customer reviewing a change to their photos saw a page of broken images.
//
// Deriving it here means the preview has whatever the live site has, for as
// long as both are read from the same file. There is no second file to keep in
// step, which is the only version of this that stays fixed.
//
// The orchestrator's container pipeline does the same thing in
// scripts/build-handler-deploy.mjs (parseWranglerConfig / previewConfigFrom).
// The two are deliberately separate copies: this one runs inside a customer's
// repository with no access to that code. Change one, change the other.

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const SITE_CONFIG = "wrangler.jsonc";
export const PREVIEW_CONFIG = "wrangler.preview.generated.jsonc";

// Wrangler's config is JSONC: comments and trailing commas, which JSON.parse
// rejects. Strings are tracked so a "//" inside a URL is not read as a comment.
export function parseWranglerConfig(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) { if (char === "\n") { inLine = false; out += char; } continue; }
    if (inBlock) { if (char === "*" && next === "/") { inBlock = false; index += 1; } continue; }
    if (inString) {
      out += char;
      if (char === "\\") { out += next ?? ""; index += 1; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === "/" && next === "/") { inLine = true; index += 1; continue; }
    if (char === "/" && next === "*") { inBlock = true; index += 1; continue; }
    if (char === '"') inString = true;
    out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function previewConfigFrom(production, name) {
  const preview = { ...production, name, workers_dev: true };
  // Everything that would make this answer on an address that is not its own.
  // A preview inheriting the customer's routes would take over their live
  // domain, which is the one outcome worse than a preview with broken images.
  delete preview.routes;
  delete preview.route;
  delete preview.triggers;
  delete preview.env;
  return preview;
}

// Named so the Actions log shows whether the binding this exists for is
// actually present. When it silently was not, nothing in the log said so.
function bindingSummary(config) {
  const bindings = [];
  for (const bucket of config.r2_buckets || []) bindings.push(`r2:${bucket.binding}`);
  for (const namespace of config.kv_namespaces || []) bindings.push(`kv:${namespace.binding}`);
  for (const database of config.d1_databases || []) bindings.push(`d1:${database.binding}`);
  if (config.images?.binding) bindings.push(`images:${config.images.binding}`);
  if (config.assets?.binding) bindings.push(`assets:${config.assets.binding}`);
  for (const entry of config.services || []) bindings.push(`service:${entry.binding}`);
  return bindings.length ? bindings.join(", ") : "none";
}

async function main() {
  const name = (process.env.PREVIEW_WORKER_NAME || "").trim();
  if (!name) {
    console.error("PREVIEW_WORKER_NAME is required");
    process.exit(1);
  }

  let source;
  try {
    source = await readFile(SITE_CONFIG, "utf8");
  } catch {
    // Refusing rather than falling back to a bare deploy: without the config it
    // is meant to mirror, the safe outcome is no preview, not one deployed over
    // the live site.
    console.error(`Could not read ${SITE_CONFIG}; refusing to guess a preview config`);
    process.exit(1);
  }

  const production = parseWranglerConfig(source);
  const preview = previewConfigFrom(production, name);
  await writeFile(PREVIEW_CONFIG, `${JSON.stringify(preview, null, 2)}\n`);

  console.log(`Preview config ${PREVIEW_CONFIG} for ${name}`);
  console.log(`  bindings: ${bindingSummary(preview)}`);
  if (production.routes || production.route) {
    console.log("  routes dropped: a preview answers only on its own workers.dev address");
  }
}

// Importable for tests without running.
if (process.argv[1] && process.argv[1].endsWith("preview-config.mjs")) {
  await main();
}
