// Select a customer's npm tests against a successful source deployment, never just the previous push.
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { selectSiteTests } from "./site-test-selection.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--directory" || !args[1] || args[1].startsWith("--"))) {
  throw new Error("Usage: site-test-runner.mjs [--directory SITE_ROOT]");
}
const directoryIndex = args.indexOf("--directory");
const directory = directoryIndex >= 0 ? path.resolve(args[directoryIndex + 1] || "") : process.cwd();
const git = (arguments_) => {
  const result = spawnSync("git", arguments_, { cwd: directory, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Site Git baseline cannot be resolved.");
  return result.stdout.trim();
};
const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
let configuration = null;
try { configuration = JSON.parse(await readFile(path.join(directory, ".wheelerswebsites", "test-scopes.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") console.log("Site scope configuration is unreadable; custom tests retain full coverage."); }
let base = process.env.SITE_TEST_BASE || "";
let baselineKnown = false;
let changedFiles = [];
try {
  if (!base && process.env.GH_TOKEN) {
    const remote = git(["remote", "get-url", "origin"]);
    const repository = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
    if (repository) {
      const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/deploy-manual-change.yml/runs?branch=main&status=success&per_page=30`, {
        headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000)
      });
      if (response.ok) {
        const runs = (await response.json()).workflow_runs || [];
        for (const run of runs.slice(0, 10)) {
          if (run.conclusion !== "success" || !run.head_sha || run.id === Number(process.env.GITHUB_RUN_ID || 0)) continue;
          const jobsResponse = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`, {
            headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000)
          });
          if (jobsResponse.ok && (await jobsResponse.json()).jobs?.some((job) => job.name === "deploy" && job.conclusion === "success")) {
            base = run.head_sha;
            break;
          }
        }
      }
    }
  }
  if (/^[a-f0-9]{40}$/.test(base) && spawnSync("git", ["merge-base", "--is-ancestor", base, "HEAD"], { cwd: directory }).status === 0) {
    changedFiles = [...new Set([
      ...git(["diff", "--name-only", "--no-renames", "-z", base, "--"]).split("\0").filter(Boolean),
      ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
    ])];
    baselineKnown = true;
  }
} catch { console.log("Successful site deployment baseline unavailable; retaining full test coverage."); }
const selection = selectSiteTests({ manifest, changedFiles, baselineKnown, configuration });
console.log(`Site tests: ${selection.mode}. ${selection.reason}`);
for (const script of selection.scripts) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { cwd: directory, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}