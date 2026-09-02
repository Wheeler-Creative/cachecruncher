import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { headers, loadConfig, repositoryMatches, requireEnvironment, restUrl, updateRequest } from "./lib.mjs";
import { standardsRegressions } from "../site-standards.mjs";

requireEnvironment(["REQUEST_ID", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY", "GITHUB_REPOSITORY"]);
const config = await loadConfig();
const requestId = process.env.REQUEST_ID;

function allowedPath(filePath) {
  const normalized = path.posix.normalize(String(filePath).replaceAll("\\", "/"));
  const root = normalized.split("/")[0];
  return !normalized.startsWith("../")
    && config.allowedRoots.includes(root)
    && config.allowedExtensions.includes(path.posix.extname(normalized));
}

async function listFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(relative);
    return entry.isFile() && allowedPath(relative) ? [relative] : [];
  }));
  return nested.flat();
}

async function sourceContext() {
  const candidates = (await Promise.all(config.allowedRoots.map(listFiles))).flat().sort();
  const source = {};
  let usedBytes = 0;
  for (const file of candidates) {
    const content = await readFile(file, "utf8");
    const clipped = content.slice(0, config.maxFileBytes);
    const bytes = Buffer.byteLength(clipped);
    if (usedBytes + bytes > config.maxSourceBytes) continue;
    source[file] = clipped;
    usedBytes += bytes;
  }
  return source;
}

async function fetchRequest() {
  const select = "id,request_body,status,request_branch,customer_sites(site_name,request_policy),site_repositories(repo_slug,repository_role,automation_enabled)";
  const response = await fetch(restUrl("edit_requests", `?id=eq.${encodeURIComponent(requestId)}&select=${encodeURIComponent(select)}`), { headers: headers() });
  if (!response.ok) throw new Error(await response.text());
  const [request] = await response.json();
  if (!request) throw new Error("Request not found");
  if (request.status !== "queued") throw new Error(`Request is ${request.status}, not queued`);
  const repository = request.site_repositories;
  if (!repositoryMatches(config, repository?.repo_slug) || repository?.repository_role !== "frontend" || !repository?.automation_enabled) {
    throw new Error("Request does not belong to this managed frontend repository");
  }
  return request;
}

async function openRouterJson(name, schema, messages, temperature = 0.2) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": `https://github.com/${process.env.GITHUB_REPOSITORY}`,
      "x-title": "Wheelers Websites Managed Site Editor"
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_CODER_MODEL || "openrouter/pareto-code",
      temperature,
      response_format: {
        type: "json_schema",
        json_schema: {
          name,
          strict: true,
          schema
        }
      },
      messages
    })
  });
  if (!response.ok) throw new Error(`OpenRouter failed: ${await response.text()}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no structured content");
  return JSON.parse(content);
}

async function planChange(request, source) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "relevant_files", "steps", "risks", "verification"],
    properties: {
      summary: { type: "string" },
      relevant_files: {
        type: "array",
        minItems: 1,
        maxItems: config.maxFiles,
        items: { type: "string" }
      },
      steps: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
      risks: { type: "array", maxItems: 8, items: { type: "string" } },
      verification: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } }
    }
  };
  const prompt = {
    role: "You plan a small, bounded edit to an existing customer website.",
    task: request.request_body,
    customer_policy: request.customer_sites?.request_policy || {},
    available_source_files: source,
    constraints: [
      "Inspect the supplied code before planning.",
      "Choose only existing files that are directly relevant.",
      "Prefer the smallest complete change that satisfies the request.",
      "Name concrete verification steps tied to the requested visible outcome.",
      "Do not plan infrastructure, authentication, secrets, billing, backend, package, or dependency changes."
    ]
  };
  return openRouterJson("managed_site_plan", schema, [
    { role: "system", content: "Create a precise implementation plan grounded only in the supplied repository code." },
    { role: "user", content: JSON.stringify(prompt) }
  ], 0.1);
}

function validatePlan(plan, source) {
  if (!plan || typeof plan.summary !== "string" || !Array.isArray(plan.relevant_files) || !plan.relevant_files.length) {
    throw new Error("Model response has no usable implementation plan");
  }
  for (const file of plan.relevant_files) {
    if (typeof file !== "string" || !allowedPath(file) || !Object.hasOwn(source, file)) {
      throw new Error(`Plan selected a forbidden or unavailable file: ${file}`);
    }
  }
}

async function recordPlan(plan) {
  const response = await fetch(restUrl("edit_request_events"), {
    method: "POST",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify({ request_id: requestId, event_type: "implementation_plan_created", payload: plan })
  });
  if (!response.ok) console.error(`Unable to record implementation plan: ${await response.text()}`);
}

async function generateEdits(request, source, plan) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "edits"],
    properties: {
      summary: { type: "string" },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: config.maxFiles,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          }
        }
      }
    }
  };
  const selectedSource = Object.fromEntries(plan.relevant_files.map((file) => [file, source[file]]));
  const prompt = {
    role: "You implement a reviewed plan for a bounded customer website edit.",
    task: request.request_body,
    implementation_plan: plan,
    source_files: selectedSource,
    forbidden: ["infrastructure", "authentication", "secrets", "billing", "backend", "package files", "dependencies", "generated commands", "destructive operations"],
    constraints: [
      "Follow the implementation plan exactly.",
      "Make only the smallest changes needed.",
      "Edit existing selected files only.",
      `Return at most ${config.maxFiles} edits.`,
      "Return complete replacement file content."
    ]
  };
  return openRouterJson("managed_site_edits", schema, [
    { role: "system", content: "Implement the supplied code-grounded plan. Return valid JSON only and never include commands." },
    { role: "user", content: JSON.stringify(prompt) }
  ]);
}

function validate(result) {
  if (!result || typeof result.summary !== "string" || !Array.isArray(result.edits) || !result.edits.length) {
    throw new Error("Model response has no usable edits");
  }
  if (result.edits.length > config.maxFiles) throw new Error("Model returned too many edits");
  for (const edit of result.edits) {
    if (!edit || typeof edit.path !== "string" || typeof edit.content !== "string") throw new Error("Model returned an invalid edit");
    if (!allowedPath(edit.path) || !existsSync(edit.path)) throw new Error(`Forbidden or missing edit path: ${edit.path}`);
    if (Buffer.byteLength(edit.content) > config.maxFileBytes) throw new Error(`Edit is too large: ${edit.path}`);
  }
}

function routeForFile(file) {
  const relative = String(file).replace(/^public\//, "").replace(/index\.html?$/i, "");
  return `/${relative}`.replace(/\/+/g, "/");
}

export async function assertNoStandardsRegressions(originals, edits, siteRoot = process.cwd()) {
  const problems = [];
  for (const edit of edits) {
    if (!/\.html?$/i.test(edit.path)) continue;
    const before = originals.get(edit.path) ?? "";
    const { failures, warnings } = await standardsRegressions(before, edit.content, {
      route: routeForFile(edit.path),
      siteRoot
    });
    if (warnings.length) console.error(`${edit.path}: ${warnings.join("; ")}`);
    for (const failure of failures) problems.push(`${edit.path}: ${failure}`);
  }
  if (problems.length) {
    throw new Error(`This change would break the site's standards: ${problems.join("; ")}`);
  }
}

try {
  const request = await fetchRequest();
  await updateRequest(requestId, { status: "planning", updated_at: new Date().toISOString() });
  const source = await sourceContext();
  const plan = await planChange(request, source);
  validatePlan(plan, source);
  await recordPlan(plan);
  console.log(JSON.stringify({ requestId, plan }));
  const result = await generateEdits(request, source, plan);
  validate(result);
  const originals = new Map(await Promise.all(result.edits.map(async (edit) => [edit.path, await readFile(edit.path, "utf8")])));
  await assertNoStandardsRegressions(originals, result.edits);
  for (const edit of result.edits) await writeFile(edit.path, edit.content, "utf8");
  await updateRequest(requestId, { status: "testing", updated_at: new Date().toISOString() });
  console.log(JSON.stringify({ requestId, summary: result.summary, files: result.edits.map((edit) => edit.path) }));
} catch (error) {
  try { await updateRequest(requestId, { status: "failed", updated_at: new Date().toISOString() }); } catch {}
  console.error(error?.stack || error);
  process.exit(1);
}
