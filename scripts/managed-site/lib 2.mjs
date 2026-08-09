import { appendFile, readFile } from "node:fs/promises";

export async function loadConfig() {
  const config = JSON.parse(await readFile("managed-site.json", "utf8"));
  if (config.schemaVersion !== 1 || !config.repository) throw new Error("Invalid managed-site.json");
  return config;
}

export function requireEnvironment(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing environment: ${missing.join(", ")}`);
}

export function headers(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    ...extra
  };
}

export function restUrl(table, query = "") {
  return `${process.env.SUPABASE_URL}/rest/v1/${table}${query}`;
}

export function repositoryMatches(config, slug) {
  const accepted = [config.repository, ...(config.repositoryAliases || [])];
  return accepted.some((value) => value.toLowerCase() === String(slug || "").toLowerCase());
}

export async function output(values) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value || ""}`).join("\n");
  await appendFile(process.env.GITHUB_OUTPUT, `${lines}\n`);
}

export async function updateRequest(requestId, patch) {
  const response = await fetch(restUrl("edit_requests", `?id=eq.${encodeURIComponent(requestId)}`), {
    method: "PATCH",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch)
  });
  if (!response.ok) throw new Error(`Unable to update request: ${await response.text()}`);
}