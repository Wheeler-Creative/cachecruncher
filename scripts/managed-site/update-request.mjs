import { requireEnvironment, updateRequest } from "./lib.mjs";

const [status] = process.argv.slice(2);
requireEnvironment(["REQUEST_ID", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
if (!status) throw new Error("Status is required");

const patch = {
  status,
  updated_at: new Date().toISOString(),
  ...(process.env.PREVIEW_URL ? { preview_url: process.env.PREVIEW_URL } : {}),
  ...(status === "preview_ready" ? { approval_status: "pending" } : {}),
  ...(process.env.PREVIEW_WORKER_NAME ? { preview_worker_name: process.env.PREVIEW_WORKER_NAME } : {}),
  ...(process.env.REQUEST_BRANCH ? { request_branch: process.env.REQUEST_BRANCH } : {}),
  ...(process.env.PULL_REQUEST_URL ? { pull_request_url: process.env.PULL_REQUEST_URL } : {}),
  ...(status === "deployed" ? { deployed_at: new Date().toISOString() } : {})
};
await updateRequest(process.env.REQUEST_ID, patch);
console.log(`Request ${process.env.REQUEST_ID} updated to ${status}`);