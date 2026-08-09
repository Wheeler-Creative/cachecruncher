import { headers, loadConfig, output, repositoryMatches, requireEnvironment, restUrl } from "./lib.mjs";

requireEnvironment(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITHUB_REPOSITORY"]);
const config = await loadConfig();
const requestedId = process.env.REQUEST_ID;
const filters = requestedId
  ? `id=eq.${encodeURIComponent(requestedId)}&status=eq.preview_ready&approval_status=eq.approved`
  : "status=eq.preview_ready&approval_status=eq.approved&order=created_at.asc&limit=100";
const select = "id,request_branch,preview_worker_name,site_repositories(repo_slug)";
const response = await fetch(restUrl("edit_requests", `?${filters}&select=${encodeURIComponent(select)}`), { headers: headers() });
if (!response.ok) throw new Error(await response.text());

const requests = await response.json();
const request = requests.find((item) => repositoryMatches(config, item.site_repositories?.repo_slug)
  && item.request_branch && item.preview_worker_name);
if (!request) {
  console.log("No approved request for this repository");
  await output({ request_id: "", request_branch: "", preview_worker_name: "" });
} else {
  await output({ request_id: request.id, request_branch: request.request_branch, preview_worker_name: request.preview_worker_name });
  console.log(`Found approved request ${request.id}`);
}