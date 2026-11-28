import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { insertRow, requireEnvironment, updateBuildsForRequest, updateRequest } from "./lib.mjs";

const invokedDirectly = process.argv[1]
  && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

export async function applyRequestStatus({ status, requestId, env = process.env, fetchImpl = fetch, now = new Date() }) {
  if (!status) throw new Error("Status is required");
  if (!requestId) throw new Error("Request id is required");
  if (status === "preview-cleaned") {
    await updateRequest(requestId, { preview_worker_name: null }, fetchImpl);
    return;
  }
  // The publish refused a branch that was not the commit the owner approved (find-approved.mjs). Nothing is written
  // to the request itself: it stays approved, not failed, and the platform's publish recovery reads this event, hands
  // the preview back to the owner with the reason, and never starts the publish again for that approval.
  if (status === "refused") {
    const commit = (value) => (/^[0-9a-f]{40}$/.test(value || "") ? value : null);
    await insertRow("edit_request_events", {
      request_id: requestId,
      event_type: "promotion_refused",
      payload: {
        reason: env.REFUSAL || "branch_moved",
        approvedCommit: commit(env.APPROVED_COMMIT),
        branchHead: commit(env.BRANCH_HEAD),
        run: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
          ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
        at: now.toISOString()
      }
    }, fetchImpl);
    return;
  }
  const timestamp = now.toISOString();
  const patch = {
    status,
    updated_at: timestamp,
    ...(env.PREVIEW_URL ? { preview_url: env.PREVIEW_URL } : {}),
    ...(status === "preview_ready" ? { approval_status: "pending" } : {}),
    ...(env.PREVIEW_WORKER_NAME ? { preview_worker_name: env.PREVIEW_WORKER_NAME } : {}),
    ...(env.REQUEST_BRANCH ? { request_branch: env.REQUEST_BRANCH } : {}),
    ...(env.PULL_REQUEST_URL ? { pull_request_url: env.PULL_REQUEST_URL } : {}),
    ...(status === "deployed" ? {
      deployed_at: timestamp,
      preview_url: null
    } : {})
  };

  // The AWS coordinator keeps site_builds and edit_requests together. The
  // Actions fallback must do the same or the operator console reports a
  // successfully published change as preview_ready forever. Patch the build
  // first: if Supabase refuses it, the request remains approved and retryable.
  if (status === "deployed") {
    await updateBuildsForRequest(requestId, {
      status: "deployed",
      deployed_at: timestamp,
      updated_at: timestamp
    }, fetchImpl);
  }
  await updateRequest(requestId, patch, fetchImpl);
}

if (invokedDirectly) {
  const [status] = process.argv.slice(2);
  requireEnvironment(["REQUEST_ID", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  await applyRequestStatus({ status, requestId: process.env.REQUEST_ID });
  console.log(`Request ${process.env.REQUEST_ID} updated to ${status}`);
}
