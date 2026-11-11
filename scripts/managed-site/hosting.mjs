// How this website is hosted, from managed-site.json (written by the platform's site template installer).
//
// A website is either a Cloudflare Worker of its own (no "hosting" entry: every website made before November 2026) or a
// script in the platform's Workers for Platforms namespace ("hosting": { "kind": "namespace", "dispatchNamespace": … }),
// which answers at <name>-site.jaybirdsites.com and, with a domain, on the domain through the platform's dispatcher.
// The platform's own copy of this rule is src/sites/site-hosting.js (managedSiteHosting); this repository cannot import
// it, so the two are kept equal by a test in the platform.
//
//   node scripts/managed-site/hosting.mjs wrangler-args   the arguments `wrangler deploy` needs (nothing for a Worker)
//   node scripts/managed-site/hosting.mjs address <name>  a namespace script's own address (nothing for a Worker, whose
//                                                         address wrangler prints)
import { readFileSync } from "node:fs";
import process from "node:process";

// Each namespace and the suffix its dispatcher answers on: <name><suffix>.jaybirdsites.com.
const NAMESPACES = new Map([["jaybird-sites-production", "-site"], ["jaybird-sites-staging", "-site-stg"]]);

export function siteHosting(config) {
  const entry = config?.hosting;
  if (entry?.kind !== "namespace") return { kind: "worker", namespace: "" };
  if (!NAMESPACES.has(entry.dispatchNamespace)) throw new Error(`managed-site.json names an unknown dispatch namespace: ${entry.dispatchNamespace}`);
  return { kind: "namespace", namespace: entry.dispatchNamespace };
}

export function readSiteHosting(file = "managed-site.json") {
  let config = null;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return siteHosting(config);
}

// What `wrangler deploy` adds so the website (or its preview) goes where the website lives.
export const wranglerHostingArgs = (hosting = readSiteHosting()) => (hosting.kind === "namespace" ? ["--dispatch-namespace", hosting.namespace] : []);

// The address a script in the namespace answers at, or "" for a Worker of its own (or a name too long for a label).
export function namespaceAddress(name, hosting = readSiteHosting()) {
  if (hosting.kind !== "namespace" || !/^[a-z0-9][a-z0-9-]*$/.test(String(name || ""))) return "";
  const label = `${name}${NAMESPACES.get(hosting.namespace)}`;
  return label.length <= 63 ? `https://${label}.jaybirdsites.com` : "";
}

// The API path, under /accounts/<id>, of one of this website's scripts.
export const scriptApiPath = (name, hosting = readSiteHosting()) => (hosting.kind === "namespace"
  ? `/workers/dispatch/namespaces/${encodeURIComponent(hosting.namespace)}/scripts/${encodeURIComponent(name)}`
  : `/workers/scripts/${encodeURIComponent(name)}`);

if (process.argv[1] && process.argv[1].endsWith("hosting.mjs")) {
  const [command, name] = process.argv.slice(2);
  if (command === "wrangler-args") console.log(wranglerHostingArgs().join(" "));
  else if (command === "address") console.log(namespaceAddress(name));
  else {
    console.error("Usage: hosting.mjs wrangler-args | address <name>");
    process.exit(2);
  }
}
