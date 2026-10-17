import assert from "node:assert/strict";
import {
  WCAG_21_AA_TAGS, BLOCKING_IMPACTS, ACCESSIBILITY_VIEWPORTS, blockingViolations, mergeViolations, countNodes,
  formatViolations, summarize, remediationPrompt, remediationPatchPrompt,
  REMEDIATION_SYSTEM, REMEDIATION_PATCH_SYSTEM, applyAccessibilityPatch,
  scanPage, salvageHtml, sanitizeHtml, isCompleteDocument, documentCompletenessViolation, clampInt,
  pageVocabulary, representativePages, isSharedSource, selectScanScope
} from "./accessibility-lib.mjs";

const violation = (id, impact, nodes = 1) => ({
  id,
  impact,
  help: `${id} help`,
  helpUrl: `https://dequeuniversity.com/rules/axe/${id}`,
  description: `${id} description`,
  nodes: Array.from({ length: nodes }, (_, index) => ({
    target: `#node-${index}`,
    html: `<div id="node-${index}">x</div>`,
    failureSummary: "Fix any of the following:\n  Element has insufficient contrast"
  }))
});

// The standard the whole gate is measured against. Level A is included because
// AA is cumulative — an A failure is also an AA failure.
{
  assert.deepEqual(WCAG_21_AA_TAGS, ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  console.log("ok   scans against WCAG 2.1 AA tags, level A included");
}

{
  const merged = mergeViolations([
    { violations: [violation("color-contrast", "serious", 1)] },
    { violations: [violation("color-contrast", "serious", 2), violation("label", "critical", 1)] }
  ]);
  assert.deepEqual(merged.map((entry) => entry.id), ["color-contrast", "label"]);
  assert.equal(merged[0].nodes.length, 2);
  console.log("ok   responsive scans merge duplicate rules without losing distinct nodes");
}

// Impact helps prioritize repairs, but every detected WCAG failure blocks AA
// conformance. Responsive UI is checked at desktop and mobile widths.
{
  for (const impact of ["critical", "serious", "moderate", "minor", null]) {
    assert.ok(BLOCKING_IMPACTS.has(impact));
  }
  assert.deepEqual(ACCESSIBILITY_VIEWPORTS.map(({ name }) => name), ["desktop", "mobile"]);

  const blocking = blockingViolations([
    violation("color-contrast", "serious"),
    violation("region", "moderate"),
    violation("image-alt", "critical"),
    violation("landmark-one-main", "minor")
  ]);
  assert.deepEqual(blocking.map((entry) => entry.id), ["color-contrast", "region", "image-alt", "landmark-one-main"]);
  console.log("ok   every detected WCAG failure blocks at desktop and mobile widths");
}

{
  assert.equal(countNodes([violation("image-alt", "critical", 3), violation("label", "critical", 2)]), 5);
  assert.equal(countNodes([]), 0);
  assert.equal(countNodes(null), 0);
  console.log("ok   counts affected elements, tolerating empty input");
}

// A clean site must produce a report that cannot accidentally read as a failure.
{
  const clean = summarize([{ path: "/", violations: [] }, { path: "/about/", violations: [] }]);
  assert.equal(clean.blockingCount, 0);
  assert.equal(clean.violationCount, 0);
  assert.equal(clean.pagesScanned, 2);
  assert.deepEqual(clean.blockingRuleIds, []);
  assert.equal(clean.standard, "WCAG 2.1 AA");
  console.log("ok   a clean scan summarizes as zero blocking");
}

{
  const report = summarize([
    { path: "/", violations: [violation("image-alt", "critical", 2), violation("region", "moderate")] },
    { path: "/contact/", violations: [violation("label", "critical"), violation("color-contrast", "serious")] }
  ]);
  assert.equal(report.pagesScanned, 2);
  assert.equal(report.violationCount, 4);
  assert.equal(report.blockingCount, 4);
  assert.equal(report.nodeCount, 5);
  assert.deepEqual(report.byImpact, { critical: 2, moderate: 1, serious: 1 });
  // Sorted and de-duplicated so the failure message is stable across runs.
  assert.deepEqual(report.blockingRuleIds, ["color-contrast", "image-alt", "label", "region"]);
  assert.deepEqual(report.pages.map((page) => page.blockingCount), [2, 2]);
  assert.deepEqual(report.pages[0].ruleIds, ["image-alt", "region"]);
  console.log("ok   summarizes per page and de-duplicates blocking rule ids");
}

// The report is written to disk and posted to site_build_validations, so it has
// to survive a JSON round trip unchanged.
{
  const report = summarize([{ path: "/", violations: [violation("image-alt", "critical")] }]);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  console.log("ok   the report round-trips through JSON");
}

{
  const text = formatViolations([violation("color-contrast", "serious")]);
  assert.match(text, /\[serious\] color-contrast/);
  assert.match(text, /#node-0/);
  // Newlines inside failureSummary are flattened so log output stays readable.
  assert.ok(!text.includes("following:\n  Element"));
  console.log("ok   formats violations with impact, target and summary");
}

// The repair prompt must carry the page, the defects, and an unambiguous
// instruction to return a whole document — a partial answer would destroy the route.
{
  const prompt = remediationPrompt({
    routePath: "/contact/",
    html: "<!DOCTYPE html><html lang=\"en\"><body><img src=\"a.png\"></body></html>",
    violations: [violation("image-alt", "critical")]
  });
  assert.match(prompt, /Route: \/contact\//);
  assert.match(prompt, /image-alt/);
  assert.match(prompt, /<img src="a\.png">/);
  assert.match(prompt, /complete corrected HTML document/);
  assert.match(REMEDIATION_SYSTEM, /COMPLETE corrected HTML document/);
  assert.match(REMEDIATION_SYSTEM, /4\.5:1/);
  assert.match(REMEDIATION_SYSTEM, /not a label/);
  // Repair must not become a redesign.
  assert.match(REMEDIATION_SYSTEM, /repairing accessibility, not redesigning/);
  assert.match(REMEDIATION_SYSTEM, /Never remove content/);
  console.log("ok   the repair prompt preserves design and demands a full document");
}

{
  const html = '<!doctype html><html lang="en"><head><title>Test</title></head><body><main><img src="team.jpg"><p>Keep me.</p></main></body></html>';
  const find = '<img src="team.jpg">';
  const replace = '<img src="team.jpg" alt="Staff members at a community event">';
  const prompt = remediationPatchPrompt({
    routePath: "/team/", html, violations: [violation("image-alt", "critical")]
  });
  assert.match(prompt, /targeted edits only/i);
  assert.match(REMEDIATION_PATCH_SYSTEM, /Do not return the whole document/);

  const patched = applyAccessibilityPatch(html, JSON.stringify({ edits: [{ find, replace }] }));
  assert.ok(patched.html, patched.reason);
  assert.ok(patched.html.includes(replace));
  assert.equal(patched.html.replace(replace, find), html,
    "accessibility patching must preserve every byte outside the named node");

  const ambiguous = applyAccessibilityPatch(
    html.replace("</main>", '<img src="team.jpg"></main>'),
    JSON.stringify({ edits: [{ find, replace }] })
  );
  assert.equal(ambiguous.html, "");
  assert.match(ambiguous.reason, /ambiguous/);
  console.log("ok   accessibility repair uses unique targeted edits without page drift");
}

{
  const repaired = sanitizeHtml('<!doctype html><html><head></head><body><script>alert(1)</script><a href="javascript:alert(1)" onclick="evil()">Safe</a></body></html>');
  assert.doesNotMatch(repaired, /<script|javascript:|onclick/i);
  console.log("ok   accessibility repair output cannot reintroduce active content");
}

{
  const complete = "<!doctype html><html><head><style>body{color:#111}</style></head><body><main><section><form></form></section></main></body></html>";
  assert.equal(isCompleteDocument(complete), true);
  assert.equal(isCompleteDocument("<!doctype html><html><body><main>cut off"), false);
  assert.equal(isCompleteDocument(`${complete}<p>trailing output</p>`), false);
  assert.equal(documentCompletenessViolation(complete), null);
  assert.equal(documentCompletenessViolation("<!doctype html><html><body>cut off")?.id, "document-completeness");
  console.log("ok   accessibility repair rejects truncated or prose-tailed documents");
}

// scanPage's callback executes inside the browser, where it can't be reached by
// a normal unit test. Run it here against a stand-in window.axe to pin down the
// axe options we pass and the shape we hand back.
{
  let scriptAdded = null;
  const page = {
    addScriptTag: async (options) => { scriptAdded = options; },
    evaluate: async (fn, tags) => {
      globalThis.window = {
        axe: {
          run: async (context, options) => {
            assert.equal(context, globalThis.document);
            // Violations only: axe's "passes" payload is large and unused.
            assert.deepEqual(options.resultTypes, ["violations"]);
            assert.equal(options.runOnly.type, "tag");
            assert.deepEqual(options.runOnly.values, WCAG_21_AA_TAGS);
            return {
              violations: [{
                id: "color-contrast",
                impact: "serious",
                help: "Elements must have sufficient colour contrast",
                helpUrl: "https://example.test/color-contrast",
                description: "desc",
                // More nodes than we keep, and oversized fields, to prove the caps.
                nodes: Array.from({ length: 12 }, (_, index) => ({
                  target: [`.a-${index}`, `.b-${index}`],
                  html: "x".repeat(900),
                  failureSummary: "y".repeat(900)
                }))
              }]
            };
          }
        }
      };
      globalThis.document = globalThis.document || {};
      globalThis.window.axe.run.length;
      return fn(tags);
    }
  };

  globalThis.document = {};
  const result = await scanPage(page, { scriptPath: "/tmp/axe.min.js" });
  assert.match(scriptAdded.path, /axe\.min\.js$/);
  const [found] = result.violations;
  assert.equal(found.id, "color-contrast");
  assert.equal(found.impact, "serious");
  // Every failing element is kept so a repair can fix all of them; field lengths stay
  // capped, and the printed report shows eight elements and counts the rest.
  assert.equal(found.nodes.length, 12);
  assert.equal(found.nodes[0].target, ".a-0 .b-0");
  assert.equal(found.nodes[0].html.length, 400);
  assert.equal(found.nodes[0].failureSummary.length, 600);
  const printed = formatViolations([found]);
  assert.equal((printed.match(/^    - /gm) || []).length, 8);
  assert.match(printed, /\.\.\. and 4 more element\(s\)/);
  console.log("ok   scanPage requests WCAG 2.1 AA rules and caps its payload");
}

// A change is checked where it landed. Shared styling or code is checked against one page of each kind,
// and when nothing says what changed every page is checked.
{
  const page = (route, body) => ({ rel: `public${route}index.html`, route, html: `<main>${body}</main>` });
  const pages = [
    page("/", '<section class="hero"><a class="btn">x</a></section>'),
    ...Array.from({ length: 40 }, (_, index) => page(`/event-${index}/`, `<article class="card ww-source-inline-${index}abcdef012"><h2>t</h2></article>`)),
    page("/contact/", '<form data-ww-form="1"><input class="field"></form>'),
    page("/shop/", '<ul class="products"><li class="product card">p</li></ul>')
  ];
  assert.ok(pageVocabulary(pages[1].html).has(".card") && !pageVocabulary(pages[1].html).has(".ww-source-inline-0abcdef012"),
    "generated hash classes are not part of what a page is made of");
  const sample = representativePages(pages, 30);
  assert.deepEqual(sample.slice(0, 1), ["/"]);
  assert.ok(sample.includes("/contact/") && sample.includes("/shop/"), "each kind of page is represented");
  assert.ok(sample.length <= 5, `forty identical pages need one stand-in, got ${sample.length}`);

  assert.equal(selectScanScope({ pages, changed: null }).mode, "full", "an unknown change scans every page");
  assert.equal(selectScanScope({ pages, changed: null }).routes.length, pages.length);

  const one = selectScanScope({ pages, changed: ["public/event-3/index.html", "public/images/a.jpg"] });
  assert.deepEqual([one.mode, one.routes], ["changed", ["/event-3/"]], "a content edit checks that page only");

  const styled = selectScanScope({ pages, changed: ["public/styles.css", "public/event-3/index.html"] });
  assert.equal(styled.mode, "changed+sample");
  assert.equal(styled.routes[0], "/event-3/");
  assert.ok(styled.routes.includes("/shop/") && styled.routes.length < pages.length / 2);

  assert.deepEqual(selectScanScope({ pages, changed: ["public/images/a.jpg"] }).routes, ["/"], "an image change still checks the home page");
  assert.deepEqual(["layout/header.html", "scripts/site.mjs", "public/app.js", "src/worker.js"].map(isSharedSource), [true, true, true, true]);
  assert.deepEqual(["public/a/index.html", "public/images/a.png", "scripts/x.test.mjs", "docs/a.md"].map(isSharedSource), [false, false, false, false]);
  console.log("ok   scans the pages a change can affect, and every page when that is unknown");
}

console.log("\nall pass");
