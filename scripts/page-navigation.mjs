// Navigating to a page without hanging on it.
//
// WHY. A build died here:
//
//   page.goto: Timeout 60000ms exceeded.
//   navigating to "http://127.0.0.1:35999/news-events/", waiting until "networkidle"
//
// That is a LOCAL static server. The page loaded fine; what never happened was
// "networkidle", because the page references something external - an image from
// the old host, a font, a beacon - that never resolves from a CI runner. The
// condition we were waiting for simply cannot occur, so we wait the full minute
// and then throw, on a page that was ready in milliseconds.
//
// networkidle is the wrong tool. Playwright's own guidance is not to use it for
// this reason. What we actually need is: the DOM is parsed, layout has settled
// enough to measure, and fonts are applied so contrast and widths are real.
// Each of those is individually achievable, and none of them should be able to
// fail a build because a third-party asset is slow.
//
// So: navigate on domcontentloaded, which is deterministic, then make a
// BEST-EFFORT attempt to let the network go quiet and the fonts load. Both are
// bounded and both swallow their own timeouts.

/** Wait for something useful, but never let waiting be the thing that fails. */
async function settle(page, settleMs) {
  // Give in-flight requests a brief chance to finish so layout and computed
  // styles are stable. If they never do, we measure what the visitor would
  // actually see at this moment, which is the honest answer anyway.
  // Guarded: not every page-like object implements every wait, and a missing
  // convenience must not become a navigation failure.
  if (typeof page.waitForLoadState === "function") {
    await page.waitForLoadState("networkidle", { timeout: settleMs }).catch(() => {});
  }
  // Fonts change both text width and contrast, so they matter for overflow and
  // for WCAG. Bounded, and failure is not fatal.
  if (typeof page.evaluate === "function") {
    await Promise.race([
      Promise.resolve(page.evaluate(() => document.fonts?.ready)).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, settleMs))
    ]);
  }
}

/**
 * Navigates and returns the response, without ever hanging on network idle.
 *
 * @param {import("playwright").Page} page
 * @param {string} url
 * @param {{timeout?: number, settleMs?: number}} [options]
 */
export async function gotoSettled(page, url, { timeout = 60_000, settleMs = 3_000 } = {}) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await settle(page, settleMs);
  return response;
}

/** The same, for a reload. */
export async function reloadSettled(page, { timeout = 60_000, settleMs = 3_000 } = {}) {
  const response = await page.reload({ waitUntil: "domcontentloaded", timeout });
  await settle(page, settleMs);
  return response;
}
