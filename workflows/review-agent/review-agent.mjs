import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const requiredEnv = ["GITHUB_TOKEN", "GITHUB_REPOSITORY"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

if (!process.env.REVIEW_AGENT_COMMAND) {
  throw new Error("Missing required input: review_agent_command");
}

const failOnError = boolEnv("REVIEW_AGENT_FAIL_ON_ERROR", true);
const allowRequiredNA = boolEnv("REVIEW_AGENT_ALLOW_REQUIRED_NA", false);
const maxFiles = intEnv("REVIEW_AGENT_MAX_FILES", 120);
const maxPatchChars = intEnv("REVIEW_AGENT_MAX_PATCH_CHARS", 300000);
const checkName = process.env.REVIEW_AGENT_CHECK_NAME || "Review Agent Code Review";
const codeReviewPath = process.env.REVIEW_AGENT_CODE_REVIEW_PATH || "CODE_REVIEW.md";
const repo = process.env.GITHUB_REPOSITORY;
const [owner, name] = repo.split("/");

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set");
const eventPayload = JSON.parse(await readFile(eventPath, "utf8"));
const pullRequest = eventPayload.pull_request;
if (!pullRequest?.number) {
  throw new Error("This workflow must run on pull_request_target events");
}

const issueNumber = pullRequest.number;
const headSha = pullRequest.head.sha;

async function run() {
  try {
    const standards = parseCodeReview(await readFile(codeReviewPath, "utf8"));
    if (standards.length === 0) {
      throw new Error(
        `No standards found in ${codeReviewPath}. Use headings like ### [CR-001] Title`
      );
    }

    const files = await fetchPullFiles(owner, name, issueNumber);
    const trimmedFiles = trimFiles(files, maxFiles, maxPatchChars);

    const payload = {
      pull_request: {
        number: pullRequest.number,
        title: pullRequest.title,
        body: pullRequest.body || "",
        html_url: pullRequest.html_url,
        base_ref: pullRequest.base.ref,
        head_ref: pullRequest.head.ref,
        author: pullRequest.user?.login || "unknown"
      },
      repository: {
        full_name: repo,
        default_branch: eventPayload.repository?.default_branch || "main"
      },
      standards,
      changed_files: trimmedFiles
    };

    await mkdir(".tmp", { recursive: true });
    const contextFile = path.resolve(".tmp/review-agent-context.json");
    const promptFile = path.resolve(".tmp/review-agent-prompt.txt");
    await writeFile(contextFile, JSON.stringify(payload, null, 2));
    await writeFile(promptFile, buildPrompt(), "utf8");

    const rawAgentOut = await execCommand(process.env.REVIEW_AGENT_COMMAND, {
      ...process.env,
      REVIEW_AGENT_PROMPT_FILE: promptFile,
      REVIEW_AGENT_CONTEXT_FILE: contextFile,
      REVIEW_AGENT_OUTPUT_SCHEMA_FILE: path.resolve("workflows/review-agent/review-result.schema.json")
    });

    const parsed = parseAgentJson(rawAgentOut.stdout);
    const schemaErrors = validateReviewResultShape(parsed);
    if (schemaErrors.length > 0) {
      throw new Error(`Agent output failed schema checks:\n- ${schemaErrors.join("\n- ")}`);
    }

    const score = scoreReview({
      standards,
      result: parsed,
      allowRequiredNA
    });

    await publishOutcome({
      owner,
      name,
      issueNumber,
      headSha,
      checkName,
      score,
      result: parsed
    });

    if (!score.pass) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await publishRuntimeError({
      owner,
      name,
      issueNumber,
      headSha,
      checkName,
      message,
      failOnError
    });
    if (failOnError) process.exitCode = 1;
  }
}

await run();

function boolEnv(key, fallback) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function intEnv(key, fallback) {
  const v = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}

function parseCodeReview(content) {
  const lines = content.split(/\r?\n/);
  const standards = [];
  let current = null;

  for (const line of lines) {
    const heading = line.match(/^###\s+\[([A-Za-z0-9_-]+)\]\s+(.+)$/);
    if (heading) {
      if (current) standards.push(current);
      current = {
        id: heading[1],
        title: heading[2].trim(),
        required: true,
        applies_when: "",
        pass_criteria: "",
        evidence_required: ""
      };
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^\s*[-*]?\s*(required|applies_when|pass_criteria|evidence_required)\s*:\s*(.+)\s*$/i);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (key === "required") {
      current.required = ["true", "yes", "1"].includes(value.toLowerCase());
    } else {
      current[key] = value;
    }
  }
  if (current) standards.push(current);
  return standards;
}

async function fetchPullFiles(ownerValue, repoValue, number) {
  let page = 1;
  const all = [];
  while (true) {
    const batch = await ghApi(
      `/repos/${ownerValue}/${repoValue}/pulls/${number}/files?per_page=100&page=${page}`
    );
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return all;
}

function trimFiles(files, maxFileCount, maxPatchTotal) {
  const selected = [];
  let patchCount = 0;
  for (const file of files.slice(0, maxFileCount)) {
    const patch = file.patch || "";
    const remaining = maxPatchTotal - patchCount;
    const clippedPatch = remaining > 0 ? patch.slice(0, remaining) : "";
    patchCount += clippedPatch.length;
    selected.push({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: clippedPatch
    });
    if (patchCount >= maxPatchTotal) break;
  }
  return selected;
}

function buildPrompt() {
  return [
    "You are Review Agent, a strict code-review bot.",
    "Read PR context from REVIEW_AGENT_CONTEXT_FILE.",
    "Evaluate ONLY against standards defined there.",
    "Return exactly one JSON object matching REVIEW_AGENT_OUTPUT_SCHEMA_FILE.",
    "Do not output markdown. Do not wrap in code fences.",
    "Rules:",
    "- Every required standard id must appear in standards[].",
    "- Use status pass/fail/not_applicable.",
    "- For failures include precise evidence with file and line.",
    "- Keep summary concise and concrete."
  ].join("\n");
}

function execCommand(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Agent command failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseAgentJson(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Agent returned empty output");
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(text.slice(first, last + 1));
    }
    throw new Error("Agent output is not valid JSON");
  }
}

function validateReviewResultShape(value) {
  const errors = [];
  if (!isObject(value)) return ["root must be an object"];
  if (!["pass", "fail"].includes(value.verdict)) errors.push("verdict must be pass or fail");
  if (typeof value.summary !== "string" || !value.summary.trim()) errors.push("summary must be non-empty string");
  if (!Array.isArray(value.failed_required_ids)) errors.push("failed_required_ids must be an array");
  if (!Array.isArray(value.standards) || value.standards.length === 0) errors.push("standards must be a non-empty array");

  if (Array.isArray(value.standards)) {
    value.standards.forEach((s, i) => {
      if (!isObject(s)) {
        errors.push(`standards[${i}] must be an object`);
        return;
      }
      if (!idLike(s.id)) errors.push(`standards[${i}].id is invalid`);
      if (!["pass", "fail", "not_applicable"].includes(s.status)) {
        errors.push(`standards[${i}].status must be pass/fail/not_applicable`);
      }
      if (typeof s.reason !== "string" || !s.reason.trim()) {
        errors.push(`standards[${i}].reason must be non-empty string`);
      }
      if (!Array.isArray(s.evidence)) {
        errors.push(`standards[${i}].evidence must be an array`);
      } else {
        s.evidence.forEach((e, j) => {
          if (!isObject(e)) {
            errors.push(`standards[${i}].evidence[${j}] must be object`);
            return;
          }
          if (typeof e.file !== "string" || !e.file.trim()) errors.push(`standards[${i}].evidence[${j}].file invalid`);
          if (!Number.isInteger(e.line) || e.line < 1) errors.push(`standards[${i}].evidence[${j}].line invalid`);
          if (typeof e.note !== "string" || !e.note.trim()) errors.push(`standards[${i}].evidence[${j}].note invalid`);
        });
      }
    });
  }
  return errors;
}

function scoreReview({ standards, result, allowRequiredNA: allowNA }) {
  const byId = new Map(result.standards.map((s) => [s.id, s]));
  const required = standards.filter((s) => s.required);
  const failed = [];
  const missing = [];

  for (const standard of required) {
    const entry = byId.get(standard.id);
    if (!entry) {
      missing.push(standard.id);
      continue;
    }
    if (entry.status === "pass") continue;
    if (entry.status === "not_applicable" && allowNA && entry.reason.trim().length > 12) continue;
    failed.push(standard.id);
  }

  const allFailed = [...new Set([...failed, ...missing, ...(result.failed_required_ids || [])])];
  const pass = allFailed.length === 0;
  return { pass, failed: allFailed, missing };
}

async function publishOutcome({ owner: ownerValue, name: repoValue, issueNumber: issueNo, headSha: sha, checkName: check, score, result }) {
  const conclusion = score.pass ? "success" : "failure";
  const title = score.pass
    ? "All required CODE_REVIEW standards passed"
    : `Failed standards: ${score.failed.join(", ")}`;
  const text = renderCommentBody({ score, result });

  await ghApi(`/repos/${ownerValue}/${repoValue}/check-runs`, {
    method: "POST",
    body: {
      name: check,
      head_sha: sha,
      status: "completed",
      conclusion,
      output: {
        title,
        summary: result.summary,
        text
      }
    }
  });

  await upsertComment(ownerValue, repoValue, issueNo, text);
  if (score.pass) {
    await syncLabels(ownerValue, repoValue, issueNo, "review:approved", "review:changes-requested");
  } else {
    await syncLabels(ownerValue, repoValue, issueNo, "review:changes-requested", "review:approved");
  }
}

async function publishRuntimeError({ owner: ownerValue, name: repoValue, issueNumber: issueNo, headSha: sha, checkName: check, message, failOnError: failClosed }) {
  const conclusion = failClosed ? "failure" : "neutral";
  const body = [
    "<!-- review-agent -->",
    "## Review Agent Error",
    "",
    failClosed
      ? "Review Agent failed in fail-closed mode."
      : "Review Agent failed, but fail_on_error=false so this run is neutral.",
    "",
    "```text",
    message,
    "```"
  ].join("\n");

  await ghApi(`/repos/${ownerValue}/${repoValue}/check-runs`, {
    method: "POST",
    body: {
      name: check,
      head_sha: sha,
      status: "completed",
      conclusion,
      output: {
        title: "Review Agent runtime error",
        summary: message.slice(0, 65500)
      }
    }
  });

  await upsertComment(ownerValue, repoValue, issueNo, body);
  if (failClosed) {
    await syncLabels(ownerValue, repoValue, issueNo, "review:changes-requested", "review:approved");
  }
}

function renderCommentBody({ score, result }) {
  const lines = [
    "<!-- review-agent -->",
    "## Review Agent Code Review",
    "",
    `Verdict: **${score.pass ? "PASS" : "FAIL"}**`,
    "",
    result.summary,
    ""
  ];

  if (score.failed.length > 0) {
    lines.push("### Blocking Standards", "");
    for (const id of score.failed) {
      const standard = (result.standards || []).find((s) => s.id === id);
      const reason = standard?.reason || "Missing or failed standard result.";
      lines.push(`- ${id}: ${reason}`);
    }
    lines.push("");
  }

  lines.push("### Standard Results", "");
  for (const standard of result.standards || []) {
    lines.push(`- ${standard.id}: ${standard.status} - ${standard.reason}`);
  }

  return lines.join("\n");
}

async function upsertComment(ownerValue, repoValue, issueNo, body) {
  const comments = await ghApi(
    `/repos/${ownerValue}/${repoValue}/issues/${issueNo}/comments?per_page=100`
  );
  const existing = comments.find(
    (comment) => typeof comment.body === "string" && comment.body.includes("<!-- review-agent -->")
  );

  if (existing) {
    await ghApi(`/repos/${ownerValue}/${repoValue}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: { body }
    });
    return;
  }

  await ghApi(`/repos/${ownerValue}/${repoValue}/issues/${issueNo}/comments`, {
    method: "POST",
    body: { body }
  });
}

async function syncLabels(ownerValue, repoValue, issueNo, add, remove) {
  await ghApi(`/repos/${ownerValue}/${repoValue}/issues/${issueNo}/labels`, {
    method: "POST",
    body: { labels: [add] }
  });
  try {
    await ghApi(`/repos/${ownerValue}/${repoValue}/issues/${issueNo}/labels/${encodeURIComponent(remove)}`, {
      method: "DELETE"
    });
  } catch {
    // label may not exist
  }
}

async function ghApi(route, options = {}) {
  const method = options.method || "GET";
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "makerprism-review-agent"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${route} failed (${response.status}): ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function idLike(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}
