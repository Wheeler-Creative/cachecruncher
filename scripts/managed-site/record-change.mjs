import { headers, requireEnvironment, restUrl } from "./lib.mjs";

requireEnvironment(["REQUEST_ID", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
const outcome = process.argv[2];
if (!["deployed", "rejected", "failed"].includes(outcome)) throw new Error("Invalid outcome");

const lookup = await fetch(restUrl("edit_requests", `?id=eq.${encodeURIComponent(process.env.REQUEST_ID)}&select=id,site_id,title`), { headers: headers() });
if (!lookup.ok) throw new Error(await lookup.text());
const [request] = await lookup.json();
if (!request) throw new Error("Request not found");

const files = (process.env.CHANGED_FILES || "").split("\n").map((value) => value.trim()).filter(Boolean).slice(0, 40);
const response = await fetch(restUrl("site_change_log", "?on_conflict=request_id"), {
  method: "POST",
  headers: headers({ Prefer: "return=minimal,resolution=merge-duplicates" }),
  body: JSON.stringify({
    site_id: request.site_id,
    request_id: request.id,
    summary: String(process.env.CHANGE_SUMMARY || request.title).slice(0, 500),
    files,
    outcome
  })
});
if (!response.ok) throw new Error(await response.text());
console.log(`Recorded ${outcome} change for ${request.id}`);