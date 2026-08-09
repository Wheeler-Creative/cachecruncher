import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { headers, loadConfig, requireEnvironment, restUrl } from "./lib.mjs";

requireEnvironment([
  "REQUEST_ID",
  "PREVIEW_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY"
]);

const ARTIFACTS_DIRECTORY = ".managed-site-artifacts";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 }
];

function artifactName(site, route, viewport) {
  const routeName = route === "/" ? "home" : route.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-");
  return `${site}-${routeName || "home"}-${viewport}.jpg`;
}

async function fetchRequest(requestId) {
  const select = "id,title,request_body,customer_sites(site_name,live_url)";
  const response = await fetch(restUrl(
    "edit_requests",
    `?id=eq.${encodeURIComponent(requestId)}&select=${encodeURIComponent(select)}`
  ), { headers: headers() });
  if (!response.ok) throw new Error(`Unable to load request for verification: ${await response.text()}`);
  const [request] = await response.json();
  if (!request) throw new Error("Request not found for verification");
  return request;
}

async function capture(browser, site, baseUrl, routes) {
  const evidence = [];
  for (const route of routes) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1
      });
      const page = await context.newPage();
      const url = new URL(route, baseUrl).toString();
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status() || "unknown"}`);
        await page.waitForTimeout(1000);
        const body = await page.locator("body");
        if (!await body.isVisible()) throw new Error("body is not visible");
        const dimensions = await body.evaluate((element) => ({
          width: element.scrollWidth,
          height: element.scrollHeight
        }));
        if (dimensions.width < 10 || dimensions.height < 10) throw new Error("page rendered blank");

        const file = path.join(ARTIFACTS_DIRECTORY, artifactName(site, route, viewport.name));
        await page.screenshot({ path: file, type: "jpeg", quality: 78, fullPage: false });
        evidence.push({
          site,
          route,
          viewport: viewport.name,
          url,
          file,
          title: await page.title(),
          text: (await body.innerText()).replace(/\s+/g, " ").trim().slice(0, 1200)
        });
      } finally {
        await context.close();
      }
    }
  }
  return evidence;
}

async function imagePart(item) {
  const image = await readFile(item.file);
  return {
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` }
  };
}

async function verifyWithVision(request, evidence) {
  const content = [{
    type: "text",
    text: [
      `Customer request: ${request.title}`,
      request.request_body,
      "Compare production baseline images with preview images at matching routes and viewports.",
      "Pass only when the requested visible outcome is clearly present and the preview has no blank page, overlap, clipping, unreadable text, or mobile overflow.",
      "Return inconclusive when the requested outcome cannot be observed on these routes."
    ].join("\n\n")
  }];

  for (const item of evidence) {
    content.push({
      type: "text",
      text: `${item.site.toUpperCase()} | ${item.route} | ${item.viewport} | ${item.title}\nVisible text: ${item.text}`
    });
    content.push(await imagePart(item));
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": `https://github.com/${process.env.GITHUB_REPOSITORY || "Wheeler-Creative"}`,
      "x-title": "Wheelers Websites Visual QA"
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "visual_verification",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["status", "summary", "evidence", "issues"],
            properties: {
              status: { type: "string", enum: ["pass", "fail", "inconclusive"] },
              summary: { type: "string" },
              evidence: { type: "array", items: { type: "string" }, maxItems: 8 },
              issues: { type: "array", items: { type: "string" }, maxItems: 8 }
            }
          }
        }
      },
      messages: [
        {
          role: "system",
          content: "You are a strict visual QA gate for website changes. Judge only observable evidence and return the required JSON."
        },
        { role: "user", content }
      ]
    })
  });
  if (!response.ok) throw new Error(`Visual verification model failed: ${await response.text()}`);
  const payload = await response.json();
  const result = JSON.parse(payload?.choices?.[0]?.message?.content || "null");
  if (!result?.status || !["pass", "fail", "inconclusive"].includes(result.status)) {
    throw new Error("Visual verification returned an invalid verdict");
  }
  return result;
}

async function recordVerdict(requestId, result) {
  const response = await fetch(restUrl("edit_request_events"), {
    method: "POST",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify({
      request_id: requestId,
      event_type: `visual_verification_${result.status}`,
      payload: result
    })
  });
  if (!response.ok) console.error(`Unable to record visual verdict: ${await response.text()}`);
}

const config = await loadConfig();
const request = await fetchRequest(process.env.REQUEST_ID);
const routes = Array.isArray(config.verificationPaths) && config.verificationPaths.length
  ? config.verificationPaths.slice(0, 3)
  : ["/"];
await mkdir(ARTIFACTS_DIRECTORY, { recursive: true });

const browser = await chromium.launch({ headless: true });
let evidence;
try {
  const preview = await capture(browser, "preview", process.env.PREVIEW_URL, routes);
  const liveUrl = request.customer_sites?.live_url;
  let baseline = [];
  if (liveUrl) {
    try {
      baseline = await capture(browser, "production", liveUrl, routes);
    } catch (error) {
      console.error(`Production baseline unavailable: ${error.message}`);
    }
  }
  evidence = [...baseline, ...preview];
} finally {
  await browser.close();
}

const result = await verifyWithVision(request, evidence);
await writeFile(
  path.join(ARTIFACTS_DIRECTORY, "visual-verification.json"),
  `${JSON.stringify({ requestId: request.id, routes, result, evidence }, null, 2)}\n`
);
await recordVerdict(request.id, result);
console.log(JSON.stringify(result));
if (result.status !== "pass") {
  throw new Error(`Visual verification ${result.status}: ${result.summary}`);
}
