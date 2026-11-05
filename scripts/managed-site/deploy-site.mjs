// Validates, deploys and indexes a managed site, one phase at a time. There are two callers, and both use this
// script so they cannot drift apart:
//   .github/workflows/deploy-manual-change.yml: a change pushed to the site's main by hand
//   the platform's runtime upgrade (scripts/delivery/upgrade-site-runtimes.mjs in the platform), which pushes its
//     commit with [skip ci] and runs these phases from its own job, so an upgrade starts no job in the site's
//     repository
//
//   node scripts/managed-site/deploy-site.mjs install|validate|deploy|index
//
// Each phase reads only the credentials it needs. The caller passes them to that phase alone: nothing for install
// and validate (GH_TOKEN optionally, so the test selector can find the last deploy), CLOUDFLARE_API_TOKEN for
// deploy, and SUPABASE_URL with SUPABASE_SERVICE_ROLE_KEY for index.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function run(program, args) {
  console.log(`$ ${[program, ...args].join(" ")}`);
  const result = spawnSync(program, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

export const PHASES = {
  install: () => (existsSync("package-lock.json") ? run(npm, ["ci"]) : run(npm, ["install", "--no-package-lock"])),
  validate: () => {
    run(npm, ["run", "build", "--if-present"]);
    run(npm, ["run", "build:data", "--if-present"]);
    run(npm, ["run", "lint", "--if-present"]);
    run(process.execPath, ["scripts/managed-site/site-test-runner.mjs"]);
    run(npm, ["run", "check", "--if-present"]);
    run(process.execPath, ["--check", "src/worker.js"]);
    run(npx, ["wrangler", "deploy", "--dry-run"]);
  },
  deploy: () => {
    run(npm, ["run", "build", "--if-present"]);
    run(npx, ["wrangler", "deploy", "--keep-vars"]);
    // Which media the deployed site links to, so a picture it still uses is never deleted.
    if (existsSync("scripts/managed-site/media-links.mjs")) run(process.execPath, ["scripts/managed-site/media-links.mjs", "--publish"]);
  },
  index: () => run(process.execPath, ["scripts/managed-site/index-code.mjs"])
};

const phase = process.argv[2];
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!Object.hasOwn(PHASES, phase)) {
    console.error(`Usage: deploy-site.mjs ${Object.keys(PHASES).join("|")}`);
    process.exit(2);
  }
  PHASES[phase]();
}
