const workerName = String(process.env.PREVIEW_WORKER_NAME || "").trim();
const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
if (!workerName || !token) throw new Error("PREVIEW_WORKER_NAME and Cloudflare credentials are required");
if (!/^[a-z0-9][a-z0-9-]{0,62}-request-[0-9a-f]{8}$/i.test(workerName)) {
  throw new Error("Refusing to delete a Worker that is not request-scoped");
}
// A site repository holds the platform's Cloudflare token and no account id; its deploy works because wrangler
// finds the one account the token reaches. This does the same, so cleanup does not depend on a secret no site has.
async function accountOf() {
  for (const list of ["accounts", "memberships"]) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${list}?per_page=5`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) continue;
    const ids = [...new Set(((await response.json()).result || []).map((entry) => entry.account?.id || entry.id).filter(Boolean))];
    if (ids.length > 1) throw new Error("The Cloudflare token reaches more than one account; set CLOUDFLARE_ACCOUNT_ID");
    if (ids.length === 1) return ids[0];
  }
  return "";
}
const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim() || await accountOf();
if (!accountId) throw new Error("The Cloudflare account could not be found from the token; set CLOUDFLARE_ACCOUNT_ID");
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
  { method: "DELETE", headers: { authorization: `Bearer ${token}` } }
);
if (![200, 404].includes(response.status)) throw new Error(`Preview Worker deletion returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
if (response.status === 200 && (await response.json()).success !== true) throw new Error("Cloudflare did not confirm preview Worker deletion");
console.log(`Preview Worker ${workerName} deleted (${response.status})`);