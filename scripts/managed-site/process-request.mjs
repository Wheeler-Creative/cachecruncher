import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { headers, loadConfig, repositoryMatches, requireEnvironment, restUrl, updateRequest } from "./lib.mjs";

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

async function generateEdits(request, source) {
  const prompt = {
    role: "You make bounded edits to an existing customer website.",
    task: request.request_body,
    customer_policy: request.customer_sites?.request_policy || {},
    allowed_roots: config.allowedRoots,
    allowed_extensions: config.allowedExtensions,
    source_files: source,
    forbidden: ["infrastructure", "authentication", "secrets", "billing", "backend", "package files", "dependencies", "generated commands", "destructive operations"],
    response_schema: { summary: "string", edits: [{ path: "public/example.html", content: "complete replacement file content" }] },
    constraints: [
      "Make only the smallest changes needed.",
      "Edit existing files only.",
      `Return at most ${config.maxFiles} edits.`,
      "Return one JSON object and no markdown or commands."
    ]
  };
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": `https://github.com/${process.env.GITHUB_REPOSITORY}`,
      "x-title": "Wheelers Websites Managed Site Editor"
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite",
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "managed_site_edits",
          strict: true,
          schema: {
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
          }
        }
      },
      messages: [
        { role: "system", content: "Return a single valid JSON object only. Never include commands." },
        { role: "user", content: JSON.stringify(prompt) }
      ]
    })
  });
  if (!response.ok) throw new Error(`OpenRouter failed: ${await response.text()}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no edit content");
  return JSON.parse(content);
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

try {
  const request = await fetchRequest();
  await updateRequest(requestId, { status: "planning", updated_at: new Date().toISOString() });
  const result = await generateEdits(request, await sourceContext());
  validate(result);
  for (const edit of result.edits) await writeFile(edit.path, edit.content, "utf8");
  await updateRequest(requestId, { status: "testing", updated_at: new Date().toISOString() });
  console.log(JSON.stringify({ requestId, summary: result.summary, files: result.edits.map((edit) => edit.path) }));
} catch (error) {
  try { await updateRequest(requestId, { status: "failed", updated_at: new Date().toISOString() }); } catch {}
  console.error(error?.stack || error);
  process.exit(1);
}