// Post-deploy WCAG 2.1 AA gate for a deployed preview.
//
// remediate-accessibility.mjs repairs the static files before they are
// committed; this re-checks what actually shipped, because a page can differ
// once it is served (fonts, injected markup, CSS that only resolves live).
// Nothing reaches a customer for approval without passing this.
//
// Usage: PREVIEW_URL=https://... node scripts/verify-preview-accessibility.mjs [route ...]

import { writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { gotoSettled, reloadSettled } from "./page-navigation.mjs";
import { scanPage, mergeViolations, ACCESSIBILITY_VIEWPORTS, blockingViolations, formatViolations, summarize } from "./accessibility-lib.mjs";

const previewUrl = process.env.PREVIEW_URL;
const enforce = String(process.env.A11Y_ENFORCE ?? "true").toLowerCase() !== "false";
const artifactsDirectory = process.env.A11Y_ARTIFACT_DIR || ".site-build-artifacts";

if (!previewUrl) {
  console.error("PREVIEW_URL is required");
  process.exit(1);
}

// Routes come from the command line, a manifest the site already publishes, or
// failing both, the public/ directory's own HTML layout.
async function routesToScan() {
  const explicit = process.argv.slice(2).filter(Boolean);
  if (explicit.length) return explicit;

  const manifest = await fetch(new URL("/site-manifest.json", previewUrl))
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (Array.isArray(manifest?.routes) && manifest.routes.length) {
    return manifest.routes.map((route) => route.path);
  }

  const found = [];
  const walk = async (directory, base) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, base);
      else if (entry.name === "index.html") {
        const relative = path.relative(base, full).split(path.sep).join("/");
        found.push(relative === "index.html" ? "/" : `/${relative.replace(/index\.html$/, "")}`);
      }
    }
  };
  await walk("public", "public");
  return found.length ? found : ["/"];
}

const routes = await routesToScan();
const browser = await chromium.launch({ headless: true });
const scans = [];

try {
  for (const routePath of routes) {
    const viewportScans = [];
    for (const viewport of ACCESSIBILITY_VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      try {
        const response = await gotoSettled(page, new URL(routePath, previewUrl).toString());
        if (!response || response.status() >= 400) throw new Error(`${routePath} returned HTTP ${response?.status() || "unknown"}`);
        viewportScans.push({ name: viewport.name, ...(await scanPage(page)) });
      } finally {
        await context.close();
      }
    }
    const violations = mergeViolations(viewportScans);
    const blocking = blockingViolations(violations);
    console.log(`a11y ${blocking.length ? "FAIL" : "ok  "} ${routePath} (desktop + mobile) — ${blocking.length} blocking`);
    if (blocking.length) console.error(formatViolations(blocking));
    scans.push({ path: routePath, viewports: viewportScans, violations });
  }
} finally {
  await browser.close();
}

const report = summarize(scans);
report.previewUrl = previewUrl;
report.enforced = enforce;
report.completedAt = new Date().toISOString();
await mkdir(artifactsDirectory, { recursive: true });
await writeFile(path.join(artifactsDirectory, "accessibility-preview.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Accessibility (${report.standard}): ${report.pagesScanned} page(s), `
  + `${report.blockingCount} blocking, ${report.violationCount} total.`
);

if (report.blockingCount) {
  const message = `${report.blockingCount} blocking WCAG 2.1 AA violation(s): ${report.blockingRuleIds.join(", ")}`;
  if (enforce) {
    console.error(`Refusing to present this preview for approval. ${message}`);
    process.exit(1);
  }
  console.warn(`A11Y_ENFORCE=false, continuing despite ${message}`);
}
