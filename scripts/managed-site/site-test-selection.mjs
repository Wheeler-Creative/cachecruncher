// Customer test scope policy. Build, lint, source checks, and rendered QA remain separate gates.
import path from "node:path";

const inert = (file) => /^(?:docs\/|\.wheelerswebsites\/owner-content\.json$)/.test(file) || file === "README.md";

export function selectSiteTests({ manifest, changedFiles, baselineKnown, configuration = null }) {
  const scripts = manifest?.scripts || {};
  if (!scripts.test) return { mode: "none", scripts: [], reason: "This site declares no npm test script." };
  const full = (reason) => ({ mode: "full", scripts: ["test"], reason });
  if (!baselineKnown) return full("No successful deployment baseline is available.");
  if (changedFiles.some((file) => ["package.json", "package-lock.json", "wrangler.jsonc", ".wheelerswebsites/test-scopes.json"].includes(file)
    || file.startsWith(".github/") || file === "scripts/managed-site/test-changed.mjs")) return full("Site environment or test policy changed.");
  const runtime = changedFiles.filter((file) => !inert(file));
  if (!runtime.length) return { mode: "none", scripts: [], reason: "No runtime inputs changed." };
  if (String(scripts.test).trim() === "node --check src/worker.js") {
    return runtime.some((file) => file === "src/worker.js")
      ? { mode: "affected", scripts: ["test"], reason: "The site's syntax-test input changed." }
      : { mode: "none", scripts: [], reason: "The unchanged Worker syntax test has no input in this change; build/dry-run gates remain." };
  }
  if (!configuration || configuration.version !== 1 || !Array.isArray(configuration.scopes) || typeof path.matchesGlob !== "function") {
    return full("Custom site tests have no verified scope declaration.");
  }
  const selected = new Set();
  for (const file of runtime) {
    const scopes = configuration.scopes.filter((scope) => Array.isArray(scope?.paths) && scope.paths.some((pattern) => typeof pattern === "string" && path.matchesGlob(file, pattern)));
    if (!scopes.length) return full(`No declared test scope covers ${file}.`);
    for (const scope of scopes) {
      if (!["module", "feature", "visual"].includes(scope.kind) || typeof scope.script !== "string"
        || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(scope.script) || !scripts[scope.script]) return full("A site test scope is invalid or names a missing npm script.");
      selected.add(scope.script);
    }
  }
  return { mode: "affected", scripts: [...selected].sort(), reason: "Every changed runtime input has an explicit site test scope." };
}