// A website's own API: code its owner (or their AI tool) wrote, run where it can reach nothing
// but that website's own keys.
//
// WHY THIS EXISTS. An integration that needs a secret key - a newsletter sign-up, a booking
// lookup, a webhook receiver - needs code on the server. A site's server holds bindings that
// reach beyond that site (the bucket every site shares, mail, the platform's own secrets), and
// code running inside it can take all of them: one `import { env } from "cloudflare:workers"`
// returns everything, whatever it was handed as an argument. So owner code never runs inside
// the site's server.
//
// HOW. src/site-api.js is carried into the site's Worker as TEXT (the Text rule in
// wrangler.jsonc), never imported as code. A request under /api/x/ is handed to a Dynamic
// Worker loaded from that text: its own isolate, with an env holding exactly the keys the
// owner saved, a cap on CPU and outbound calls, and a gateway on every request it makes.
// Proven on Cloudflare 2026-10-13 (docs/mcp-editing-architecture.md, "Isolating server code").
//
// This file is the site's copy of the platform's runtime: it is replaced on every runtime
// upgrade and holds nothing of the site's own. It imports nothing, so the tests can run it.

export const SITE_API_PREFIX = "/api/x/";
export const SITE_API_FILE = "src/site-api.js";
// The binding names a site's wrangler.jsonc declares for this.
export const SITE_API_LOADER = "SITE_API";
// The names of the keys the owner saved, as a JSON list, written by the platform beside the
// keys themselves (src/site-secrets.js). A list, never "every text value": the platform's own
// secrets are text values on the same Worker.
export const SITE_API_KEY_NAMES = "WW_SITE_KEYS";

// The two entries a site's wrangler.jsonc needs: the file as text, and the loader that runs it.
export function siteApiWrangler() {
  return {
    rules: [{ type: "Text", globs: ["**/site-api.js"], fallthrough: false }],
    worker_loaders: [{ binding: SITE_API_LOADER }]
  };
}

// What a new site starts with. A site whose file is still this has no API, and nothing is loaded.
export const SITE_API_DEFAULT_SOURCE = `// This website's own API. It answers requests under /api/x/ and nothing else.
//
// It runs on its own, apart from the website's server: env holds only the keys saved for this
// website (env.NAME), and it can call other services with fetch. It cannot import other files.
export default {
  async fetch(request, env, ctx) {
    return new Response("Not found", { status: 404 });
  }
};
`;

// Defaults the owner approved on 2026-10-13, to be adjusted from testing. A site's Worker can
// override either with a plain value of the same name while a number is being tried.
const DEFAULT_CPU_MS = 50;
const DEFAULT_SUBREQUESTS = 10;
const KEY_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
// The platform's own hosts, which a site's API has no business calling.
const PLATFORM_HOSTS = ["jaybirddigital.com", "wheelerswebsites.com"];
const UNAVAILABLE = "This part of the website is not available right now.";

const plain = (status, body, headers = {}) => new Response(body, {
  status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }
});
const clamp = (value, fallback, low, high) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(high, Math.max(low, Math.trunc(number))) : fallback;
};
const normalized = (text) => String(text).replace(/\r\n/g, "\n").trim();

// True when the site has written an API of its own. Not a string means the file was imported as
// code rather than text (the Node test suite does that): then there is nothing to run here.
export function hasSiteApi(source) {
  return typeof source === "string" && normalized(source) !== "" && normalized(source) !== normalized(SITE_API_DEFAULT_SOURCE);
}

export function siteApiLimits(env = {}) {
  return {
    cpuMs: clamp(env.WW_SITE_API_CPU_MS, DEFAULT_CPU_MS, 5, 1000),
    subRequests: clamp(env.WW_SITE_API_SUBREQUESTS, DEFAULT_SUBREQUESTS, 1, 50)
  };
}

// Exactly the keys the owner saved: { NAME: value }.
export function siteApiKeys(env = {}) {
  let names = [];
  try { names = JSON.parse(env[SITE_API_KEY_NAMES] || "[]"); } catch { names = []; }
  const keys = {};
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name === "string" && KEY_NAME.test(name) && name !== SITE_API_KEY_NAMES && typeof env[name] === "string") keys[name] = env[name];
  }
  return keys;
}

async function digest(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Every request the API makes passes through here (the site's Worker exports it as the
// SiteApiEgress entrypoint). Encrypted requests to anywhere but the platform itself.
export async function siteApiEgress(request, env = {}, fetchImpl = fetch) {
  let url;
  try { url = new URL(request.url); } catch { return plain(400, "That address could not be read."); }
  const host = url.hostname.toLowerCase();
  const platform = [...PLATFORM_HOSTS];
  try { platform.push(new URL(env.PORTAL_ORIGIN || "").hostname.toLowerCase()); } catch { /* no portal origin set */ }
  if (url.protocol !== "https:") return plain(403, "A website's API may only call https addresses.");
  if (platform.some((name) => name && (host === name || host.endsWith(`.${name}`)))) {
    return plain(403, "A website's API may not call the platform's own addresses.");
  }
  return fetchImpl(request);
}

// One window per visitor and one per site, kept apart from the forms that share the counters.
async function overLimit(request, env) {
  const actor = env.CUSTOMER_ACCOUNT_ACTOR_RATE || env.CONTACT_ACTOR_RATE;
  const site = env.CUSTOMER_ACCOUNT_SITE_RATE || env.CONTACT_SITE_RATE;
  if (!actor || !site) return false;
  const visitor = request.headers.get("cf-connecting-ip") || "unknown";
  const [one, all] = await Promise.all([actor.limit({ key: `site-api:${visitor}` }), site.limit({ key: "site-api" })]);
  return !one.success || !all.success;
}

// What is said in the server's log when the API fails: never a key it was handed.
function safeMessage(error, keys) {
  let message = String(error?.message || error || "").slice(0, 300);
  for (const value of Object.values(keys)) if (value) message = message.split(value).join("[key]");
  return message;
}

// The answer to a request under the prefix. Always an answer: nothing else lives there.
export async function siteApiResponse(request, env, ctx, { siteId, source }) {
  if (!hasSiteApi(source)) return plain(404, "Not found");
  const loader = env?.[SITE_API_LOADER];
  if (!loader || typeof loader.get !== "function") {
    console.error(JSON.stringify({ event: "site_api_unavailable", siteId, reason: "no loader binding" }));
    return plain(503, UNAVAILABLE);
  }
  if (await overLimit(request, env)) return plain(429, "Too many requests. Try again in a minute.", { "retry-after": "60" });

  const keys = siteApiKeys(env);
  const limits = siteApiLimits(env);
  // Without the gateway there is no network at all, rather than an unfiltered one.
  const gateway = ctx?.exports?.SiteApiEgress ?? null;
  // The same code with the same keys and limits is the same Worker; a change to any is a new one.
  const id = `${siteId}:${await digest(`${source}\n${JSON.stringify(keys)}\n${JSON.stringify(limits)}\n${gateway ? "net" : "none"}`)}`;
  // The website's own cookies (a shopper's sign-in among them) are the website's, not the API's.
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  const forwarded = new Request(request, { headers });
  let answer;
  try {
    answer = await loader.get(id, async () => ({
      compatibilityDate: "2026-08-06",
      mainModule: "site-api.js",
      modules: { "site-api.js": source },
      env: keys,
      globalOutbound: gateway,
      limits
    })).getEntrypoint().fetch(forwarded);
  } catch (error) {
    console.error(JSON.stringify({ event: "site_api_failed", siteId, message: safeMessage(error, keys) }));
    return plain(502, UNAVAILABLE);
  }
  const out = new Headers(answer.headers);
  out.delete("set-cookie");
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: out });
}
