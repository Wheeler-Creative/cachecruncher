import { loadConfig, headers, output, repositoryMatches, requireEnvironment, restUrl } from "./lib.mjs";

requireEnvironment(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITHUB_REPOSITORY"]);
const config = await loadConfig();
const requestedId = process.env.REQUEST_ID;
const filters = requestedId
  ? `id=eq.${encodeURIComponent(requestedId)}&status=eq.queued`
  : "status=eq.queued&order=created_at.asc&limit=100";
const select = "id,request_branch,pull_request_url,site_repositories(repo_slug)";
const response = await fetch(restUrl("edit_requests", `?${filters}&select=${encodeURIComponent(select)}`), { headers: headers() });
if (!response.ok) throw new Error(await response.text());

const requests = await response.json();
const request = requests.find((item) => repositoryMatches(config, item.site_repositories?.repo_slug));
if (!request) {
  console.log("No queued request for this repository");
  await output({ request_id: "", request_branch: "", pull_request_url: "" });
} else {
  await output({
    request_id: request.id,
    request_branch: request.request_branch,
    pull_request_url: request.pull_request_url
  });
  console.log(`Found queued request ${request.id}`);
}