import { execFileSync } from "node:child_process";

const diff = execFileSync("git", ["diff", "--unified=0", "origin/main", "--"], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024
});

const addedLines = diff
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1));
const addedText = addedLines.join("\n");

const forbidden = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["dynamic code execution", /\b(?:eval|Function)\s*\(/],
  ["javascript URL", /(?:href|src)\s*=\s*["']\s*javascript:/i]
];

const findings = forbidden
  .filter(([, pattern]) => pattern.test(addedText))
  .map(([name]) => name);

for (const token of addedText.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g)) {
  try {
    const payload = JSON.parse(Buffer.from(token[0].split(".")[1], "base64url").toString("utf8"));
    if (payload.role === "service_role") findings.push("Supabase service-role token");
  } catch {}
}

if (findings.length) {
  throw new Error(`Security check rejected added content: ${[...new Set(findings)].join(", ")}`);
}

console.log(`Security check passed for ${addedLines.length} added lines`);
