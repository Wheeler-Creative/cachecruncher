// Finds the approved edit request this run publishes, and the exact commit it may publish.
//
// Publishing merges the request's branch only when its head is the commit the owner approved: the one the platform
// fixed when they approved (edit_requests.approved_commit_sha), or, for a request approved before approvals fixed one,
// the tested commit of the request's preview build. A branch that moved after approval (one of the platform's repairs
// finishing, a late restage, a hand push) is refused here, before anything is built, and again by the merge itself
// (gh pr merge --match-head-commit). A refusal is not a failure: the request stays approved, and the platform hands the
// preview back to its owner with the reason (src/edits/publish-recovery.js in the platform). The rules are the
// platform's (src/edits/approved-commit.js), copied because this runs in the website's repository; a platform test
// holds the two to the same answers.
//
// Outputs: request_id, request_branch, preview_worker_name, approved_commit, branch_head, refusal.
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { headers, loadConfig, output, repositoryMatches, requireEnvironment, restUrl } from "./lib.mjs";

const COMMIT = /^[0-9a-f]{40}$/;
const RETIRED_BUILD = new Set(["superseded", "cancelled", "deleted", "deployed", "failed"]);
const enc = encodeURIComponent;

// The head of a branch on the website's repository: its commit, null when the branch is gone, undefined when git
// could not say (offline): the merge's --match-head-commit still holds the publish to the approved commit then.
export function remoteHead(branch, run = (args) => execFileSync("git", args, { encoding: "utf8" })) {
  if (!branch) return null;
  try {
    const line = run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]).trim().split("\n")[0] || "";
    const sha = line.split(/\s+/)[0] || "";
    return COMMIT.test(sha) ? sha : null;
  } catch {
    return undefined;
  }
}

async function rows(fetchImpl, table, query) {
  const response = await fetchImpl(restUrl(table, query), { headers: headers() });
  if (!response.ok) throw Object.assign(new Error(await response.text()), { status: response.status });
  return response.json();
}

// The request's preview build (the platform's ownerPreviewBuild) and the revision holding it, if one does.
async function previewBuild(fetchImpl, request) {
  const [build] = await rows(fetchImpl, "site_builds", `?${request.site_id ? `site_id=eq.${enc(request.site_id)}&` : ""}build_type=eq.edit`
    + `&intake->editRequest->>id=eq.${enc(request.id)}&status=in.(preview_ready,generating)&order=created_at.desc&limit=1`
    + "&select=id,status,tested_commit_sha,activeRevision:intake->>activePreviewRevisionId");
  let held = null;
  if (build?.status === "generating" && build.activeRevision) {
    [held] = await rows(fetchImpl, "site_builds", `?id=eq.${enc(build.activeRevision)}&select=id,status&limit=1`);
    held = held || { id: build.activeRevision, status: null };
  }
  return { build: build || null, held };
}

// The platform's commitToPublish: { commit } or { commit: null, refused }.
export async function commitToPublish(request, fetchImpl = fetch) {
  if (COMMIT.test(request?.approved_commit_sha || "")) return { commit: request.approved_commit_sha, source: "approval" };
  const { build, held } = await previewBuild(fetchImpl, request);
  if (held && !RETIRED_BUILD.has(held.status)) return { commit: null, refused: "still_changing" };
  if (!COMMIT.test(build?.tested_commit_sha || "")) return { commit: null, refused: "untested" };
  return { commit: build.tested_commit_sha, source: "build" };
}

// The platform's publishRefusal: null when the branch may be published, otherwise why not.
export function publishRefusal({ approved, branchHead, refused = null }) {
  const head = COMMIT.test(branchHead || "") ? branchHead : null;
  if (refused) return { reason: refused, approvedCommit: null, branchHead: head };
  if (!COMMIT.test(approved || "")) return { reason: "untested", approvedCommit: null, branchHead: head };
  if (head !== approved) return { reason: "branch_moved", approvedCommit: approved, branchHead: head };
  return null;
}

const NONE = { request_id: "", request_branch: "", preview_worker_name: "", approved_commit: "", branch_head: "", refusal: "" };

export async function findApproved({ config, requestedId = "", fetchImpl = fetch, head = remoteHead, log = console.log }) {
  const filters = requestedId
    ? `id=eq.${enc(requestedId)}&status=eq.preview_ready&approval_status=eq.approved`
    : "status=eq.preview_ready&approval_status=eq.approved&order=created_at.asc&limit=100";
  const select = (fields) => `?${filters}&select=${enc(fields)}`;
  let requests;
  try {
    requests = await rows(fetchImpl, "edit_requests", select("id,site_id,request_branch,preview_worker_name,approved_commit_sha,site_repositories(repo_slug)"));
  } catch (error) {
    // A platform database from before approvals fixed a commit has no such column; such a request is published from
    // its preview build's tested commit.
    if (error.status !== 400 || !/approved_commit_sha/.test(error.message)) throw error;
    requests = await rows(fetchImpl, "edit_requests", select("id,site_id,request_branch,preview_worker_name,site_repositories(repo_slug)"));
  }

  const eligible = requests.filter((item) => repositoryMatches(config, item.site_repositories?.repo_slug) && item.request_branch);
  let request = null;
  let branchHead;
  for (const item of eligible) {
    const found = head(item.request_branch);
    if (found === null) continue; // its branch is gone
    request = item;
    branchHead = found;
    break;
  }
  if (!request) {
    log(eligible.length
      ? `Found ${eligible.length} approved request(s) but their branch(es) no longer exist on remote; skipping.`
      : "No approved request for this repository");
    return NONE;
  }

  const { commit, refused } = await commitToPublish(request, fetchImpl);
  // When git could not read the branch, the merge's --match-head-commit is what holds the publish to the commit.
  const refusal = publishRefusal({ approved: commit, branchHead: branchHead === undefined ? commit : branchHead, refused });
  log(refusal
    ? `Approved request ${request.id} is not published: ${refusal.reason} (approved ${refusal.approvedCommit || "none"}, branch at ${refusal.branchHead || "unknown"})`
    : `Found approved request ${request.id} at ${commit}`);
  return {
    request_id: request.id,
    request_branch: request.request_branch,
    preview_worker_name: request.preview_worker_name || "",
    approved_commit: commit || "",
    branch_head: branchHead || "",
    refusal: refusal?.reason || ""
  };
}

const invokedDirectly = process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  requireEnvironment(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITHUB_REPOSITORY"]);
  await output(await findApproved({ config: await loadConfig(), requestedId: process.env.REQUEST_ID || "" }));
}
