// Pre-deploy accessibility gate with automatic repair.
//
// Runs against the generated static files over a local server, so the repair
// loop costs nothing but model tokens — no deploy, no preview, no redeploy per
// attempt. verify-site-build.mjs then re-scans the deployed preview as the
// final gate; by then this should have nothing left to find.
//
// Usage: node scripts/remediate-accessibility.mjs <site-directory>

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";
import { htmlFiles, routeFor, serveForInspection } from "./static-preview-lib.mjs";
import { hasSharedLayout, renderSharedSource } from "./compose-site-chrome.mjs";
import { buildLog } from "./build-log.mjs";
import { gotoSettled } from "./page-navigation.mjs";
import {
  scanPage, mergeViolations, ACCESSIBILITY_VIEWPORTS, blockingViolations, countNodes, formatViolations, summarize,
  REMEDIATION_SYSTEM, REMEDIATION_PATCH_SYSTEM, remediationPrompt, remediationPatchPrompt,
  applyAccessibilityPatch,
  salvageHtml, sanitizeHtml, isCompleteDocument, documentCompletenessViolation, clampInt, selectScanScope
} from "./accessibility-lib.mjs";
import { describeResult } from "./html-patch-lib.mjs";
import { resolveCssContrastIssues, resolveHtmlA11yIssues, resolveLinkInTextBlockIssues } from "./accessibility-fast-agent.mjs";

const target = process.argv[2] || "generated-site";
const log = buildLog("a11y");
// A11Y_SCAN_DIR is where the pages to scan are (a shared-layout site composes them into dist/).
const publicDir = path.join(target, process.env.A11Y_SCAN_DIR || "public");
const maxAttempts = clampInt(process.env.A11Y_MAX_ATTEMPTS, 3, 1, 6);
const model = process.env.OPENROUTER_A11Y_MODEL || process.env.OPENROUTER_BUILD_MODEL || "moonshotai/kimi-k2";
const apiKey = process.env.OPENROUTER_API_KEY;
// Escape hatch for an emergency deploy. Off by default: the whole point is that
// an inaccessible site cannot reach a nonprofit's visitors.
const enforce = String(process.env.A11Y_ENFORCE ?? "true").toLowerCase() !== "false";
// Report without rewriting anything. Used on pull requests, where a contributor
// should see what is wrong rather than have their work silently rewritten.
const repairEnabled = String(process.env.A11Y_REPAIR ?? "true").toLowerCase() !== "false";

async function askRepairModel({ system, user, maxTokens }) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required to repair accessibility defects");
  // Deliberately not the shared AI Gateway client. This file is copied into
  // every managed site repository by template-sync, where ../src does not
  // exist and our gateway configuration is not present. It calls OpenRouter
  // directly so it runs the same in a customer's repository as it does here.
  // REASONING HAS TO BE HELD DOWN FOR THIS PARTICULAR TASK.
  //
  // Repairing accessibility means returning the WHOLE corrected document, so
  // every token of deliberation is a token not spent on the page. Measured
  // 2026-09-03 against z-ai/glm-5.3, which is what the build preset resolves
  // to: it spent about 75% of whatever budget it was given on reasoning and
  // never reached </html> - 3750 of 5000, 12008 of 16000, 23976 of 32000, still
  // deliberating at the end of each. A real build failed on exactly this, five
  // pages for five "did not return a complete HTML document" at roughly two and
  // a half minutes and $0.14 apiece.
  //
  // With effort low the same repair finishes in 1976 tokens for $0.0115 - half
  // the cost of the failure it replaces. Reasoning cannot be switched off
  // outright here ("Reasoning is mandatory for this endpoint"); effort is the
  // control that works.
  const send = (withReasoning) => fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      ...(withReasoning ? { reasoning: { effort: "low" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  // Not every model accepts a reasoning parameter, and some routers reject the
  // whole request for carrying one, so a refusal retries without it rather than
  // failing the repair.
  let response = await send(true);
  if (response.status === 400) response = await send(false);
  if (!response.ok) throw new Error(`Repair model returned HTTP ${response.status}`);
  const payload = await response.json();
  const message = payload?.choices?.[0]?.message;
  // content, or reasoning when a provider has parked the whole reply there.
  return message?.content || message?.reasoning || "";
}

async function repair({ routePath, html, violations }) {
  const patchReply = await askRepairModel({
    system: REMEDIATION_PATCH_SYSTEM,
    user: remediationPatchPrompt({ routePath, html, violations }),
    maxTokens: 5000
  });
  const patched = applyAccessibilityPatch(html, patchReply);
  if (patched.html) return { html: patched.html, mode: "patch", result: patched.result };

  const text = await askRepairModel({
    system: REMEDIATION_SYSTEM,
    user: remediationPrompt({ routePath, html, violations }),
    maxTokens: 16000
  });
  const repaired = sanitizeHtml(salvageHtml(text) || text.trim());
  // Never write back something that isn't a whole page — a truncated response
  // would silently destroy the route.
  if (!isCompleteDocument(repaired)) throw new Error("Repair model did not return a complete HTML document");
  return { html: repaired, mode: "rewrite", reason: patched.reason };
}

const files = await htmlFiles(publicDir);
if (!files.length) {
  log.fail("", `no HTML found under ${publicDir}`);
  process.exit(1);
}

// A11Y_CHANGED_FROM names the commit the site was last verified at. With it, only the pages changed since then
// are scanned, plus a handful that between them use every part of the site when shared styling or code changed.
// Without it, or if git cannot say what changed, every page is scanned.
function changedSince(base) {
  if (!base || base === "full") return null;
  try {
    const git = (...args) => execFileSync("git", ["-C", target, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set([
      ...git("diff", "--name-only", "--relative", base).split("\n"),
      ...git("ls-files", "--others", "--exclude-standard").split("\n")
    ].filter(Boolean))];
  } catch {
    return null;
  }
}
const changedFrom = process.env.A11Y_CHANGED_FROM;
const changed = changedSince(changedFrom);
if (changedFrom && changedFrom !== "full" && !changed) log.note(`could not tell what changed since ${changedFrom}; scanning every page`);
const sourcePath = (file) => `public/${path.relative(publicDir, file).split(path.sep).join("/")}`;
const scope = selectScanScope({
  pages: changed
    ? await Promise.all(files.map(async (file) => ({
      rel: sourcePath(file),
      route: routeFor(publicDir, file),
      html: await readFile(file, "utf8")
    })))
    : files.map((file) => ({ rel: sourcePath(file), route: routeFor(publicDir, file), html: "" })),
  changed,
  limit: clampInt(process.env.A11Y_SAMPLE_LIMIT, 30, 1, 200)
});
const scanRoutes = new Set(scope.routes);
const scanFiles = files.filter((file) => scanRoutes.has(routeFor(publicDir, file)));
if (scope.mode !== "full") {
  log.note(`scanning ${scanFiles.length} of ${files.length} page(s): ${scope.changedPages.length} changed`
    + `${scope.sample.length ? `, ${scope.sample.length} representative of every kind of page because shared files changed` : ""}`);
}

// A shared-layout site stores each page as its <main> only; the layout adds the
// document around it at build time, exactly as the local server does below.
const sharedLayout = await hasSharedLayout(target);
const isFragment = (html) => sharedLayout && !/<html\b|<!doctype/i.test(html);
const documentFor = (file, html) => (isFragment(html)
  ? renderSharedSource(target, path.relative(publicDir, file).split(path.sep).join("/"), html)
  : html);
const mainOf = (html) => String(html || "").match(/<main\b[\s\S]*<\/main>/i)?.[0] || null;

const { origin, close } = await serveForInspection(publicDir);
let browser = await chromium.launch({ headless: true });
const history = [];
let repairedPages = 0;
let initialProblemCount = 0;

const unscannable = [];
const queue = [...scanFiles];
const relaunched = new Set();
try {
  while (queue.length) {
    const file = queue.shift();
    if (!browser.isConnected()) browser = await chromium.launch({ headless: true });
    const routePath = routeFor(publicDir, file);
    let attempt = 0;
    let fastRounds = 0;
    let contrastRounds = 0;
    let scan;
    try {

    for (;;) {
      const viewportScans = [];
      const missingStyles = new Set();
      for (const viewport of ACCESSIBILITY_VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        const page = await context.newPage();
        const local = (url) => url.startsWith(`${origin}/`);
        page.on("response", (response) => {
          if (response.request().resourceType() === "stylesheet" && response.status() >= 400 && local(response.url())) {
            missingStyles.add(response.url());
          }
        });
        page.on("requestfailed", (request) => {
          if (request.resourceType() === "stylesheet" && local(request.url())) missingStyles.add(request.url());
        });
        try {
          await gotoSettled(page, new URL(routePath, origin).toString());
          viewportScans.push({ name: viewport.name, ...(await scanPage(page)) });
        } finally {
          await context.close();
        }
      }
      const completeness = documentCompletenessViolation(await documentFor(file, await readFile(file, "utf8")));
      const merged = mergeViolations([
        ...viewportScans,
        ...(completeness ? [{ name: "source", violations: [completeness] }] : [])
      ]);
      // Contrast against a page whose stylesheets did not load (media served
      // only by the deployed Worker) measures a page nobody sees. It is left to
      // the deployed-preview scan and recorded here as unverified.
      const unmeasured = missingStyles.size ? merged.filter((violation) => violation.id === "color-contrast") : [];
      scan = {
        viewports: viewportScans,
        violations: merged.filter((violation) => !unmeasured.includes(violation)),
        ...(unmeasured.length ? { unverified: { rule: "color-contrast", missingStylesheets: [...missingStyles].slice(0, 10) } } : {})
      };
      if (unmeasured.length && attempt === 0) {
        log.note(`${routePath}: contrast not verified here; ${missingStyles.size} stylesheet(s) are only served by the deployed site`);
      }
      // Not a verdict, but a darker text colour is always safe: fix what was measured, and let the deployed scan judge.
      if (repairEnabled && unmeasured.length && contrastRounds < 3) {
        contrastRounds += 1;
        const adjusted = await resolveCssContrastIssues(publicDir, unmeasured);
        if (adjusted.resolvedCount > 0) {
          log.detail(`${routePath}: adjusted ${adjusted.resolvedCount} colour(s) measured against the stylesheets available here`);
          repairedPages += 1;
          continue;
        }
      }

      const blocking = blockingViolations(scan.violations);
      if (attempt === 0) initialProblemCount += countNodes(blocking);
      if (!blocking.length) {
        log.ok(routePath, attempt ? `clean after ${attempt} repair attempt(s)` : "desktop + mobile clean");
        break;
      }
      if (!repairEnabled || attempt >= maxAttempts) {
        log.unfixed(routePath, `${blocking.length} blocking violation(s)${repairEnabled ? ` after ${attempt} repair attempt(s)` : " (scan only, A11Y_REPAIR=false)"}: ${blocking.map((v) => v.id).join(", ")}`);
          break;
      }

      attempt += 1;
      log.attempt(routePath, `${attempt}/${maxAttempts}, ${blocking.length} blocking: ${blocking.map((v) => v.id).join(", ")}`);
      const current = await readFile(file, "utf8");
      const fragment = isFragment(current);
      try {
        // Fast deterministic remediation pass first: instantly solves CSS contrast & HTML attributes
        const cssFixed = await resolveCssContrastIssues(publicDir, blocking);
        const linksFixed = await resolveLinkInTextBlockIssues(publicDir, blocking);
        cssFixed.resolvedCount += linksFixed.resolvedCount;
        const { html: deterministicHtml, changes: htmlChanges } = resolveHtmlA11yIssues(current, blocking, { fragment });
        if (cssFixed.resolvedCount > 0 || htmlChanges.length > 0) {
          if (htmlChanges.length > 0) {
            await writeFile(file, `${deterministicHtml}\n`);
          }
          log.detail(`${routePath}: fast agent resolved ${cssFixed.resolvedCount} CSS and ${htmlChanges.length} HTML issue(s)`);
          repairedPages += 1;
          // Deterministic fixes cost nothing, so they do not use up the model-repair budget (bounded so a no-op loop cannot spin).
          if (fastRounds < 12) { fastRounds += 1; attempt -= 1; }
          continue;
        }

        const repaired = await repair({ routePath, html: await documentFor(file, current), violations: blocking });
        // Repairs to the shared header or footer cannot be kept per page; only the page's own <main> is written back.
        const output = fragment ? mainOf(repaired.html) : repaired.html;
        if (!output) throw new Error("Repair did not return the page's <main> content");
        await writeFile(file, `${output}\n`);
        if (repaired.mode === "patch") {
          log.detail(`${routePath}: ${describeResult(repaired.result).replace(/\n+/g, "; ").trim()}`);
        } else {
          log.detail(`${routePath}: targeted patch unavailable (${repaired.reason}); used guarded full rewrite`);
        }
        repairedPages += 1;
      } catch (error) {
        log.skip(routePath, `repair call failed: ${error.message}`);
        break;
      }
    }

    history.push({ path: routePath, attempts: attempt, ...scan });
    } catch (error) {
      // A browser that died takes every remaining page with it; start a fresh one and try this page once more.
      if (!browser.isConnected() && !relaunched.has(file)) {
        relaunched.add(file);
        queue.unshift(file);
        continue;
      }
      // One page we could not even load must not cost us the other seven, nor
      // the whole build. A page that cannot be scanned is not a page that
      // passed, so it is recorded and surfaced - it just does not throw here.
      log.skip(routePath, `could not scan: ${error.message.split("\n")[0]}`);
      unscannable.push({ path: routePath, reason: error.message.split("\n")[0] });
    }
  }
} finally {
  await browser.close();
  close();
}

const report = summarize(history);
report.repairAttempts = history.reduce((total, entry) => total + entry.attempts, 0);
report.pagesRepaired = repairedPages;
report.initialProblemCount = initialProblemCount;
report.enforced = enforce;
report.repairEnabled = repairEnabled;
report.unscannable = unscannable;
report.scope = { mode: scope.mode, pagesOnSite: files.length, pagesScanned: scanFiles.length, changedPages: scope.changedPages.length, sample: scope.sample.length };
report.completedAt = new Date().toISOString();
await writeFile(path.join(target, ".site-accessibility.json"), `${JSON.stringify(report, null, 2)}\n`);

log.summary(`${report.pagesScanned} page(s) scanned, ${report.blockingCount} blocking, `
  + `${report.violationCount} total across ${report.nodeCount} element(s) — ${report.standard}`);

if (unscannable.length) {
  log.note(`${unscannable.length} page(s) recorded as unverified, not as passing`);
  for (const item of unscannable) log.detail(`${item.path}: ${item.reason}`);
}

if (report.blockingCount) {
  const message = `${report.blockingCount} blocking accessibility violation(s) remain: ${report.blockingRuleIds.join(", ")}`;
  if (enforce) {
    log.fail("", `blocking publish — ${message}`);
    if (!repairEnabled) {
      log.note("this run only scans and never commits a fix; repair with `node scripts/remediate-accessibility.mjs .` (A11Y_REPAIR unset, OPENROUTER_API_KEY set for model repair) and commit the result");
    }
    if (process.env.BUILD_FAILURE_FILE) {
      await mkdir(path.dirname(process.env.BUILD_FAILURE_FILE), { recursive: true });
      await writeFile(process.env.BUILD_FAILURE_FILE, `${JSON.stringify({
        schemaVersion: 1,
        code: "accessibility_unresolved",
        class: "terminal",
        retryable: false,
        stage: "site_generation",
        message,
        details: { blockingCount: report.blockingCount, ruleIds: report.blockingRuleIds }
      }, null, 2)}\n`);
    }
    process.exit(1);
  }
  log.unfixed("", `A11Y_ENFORCE=false, continuing despite ${message}`);
}
