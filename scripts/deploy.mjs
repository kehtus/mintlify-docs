import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const API_BASE = "https://api.mintlify.com/v1";
const POLL_MS = 3000;
const MAX_POLLS = 40;

function loadEnv(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

loadEnv(resolve(process.cwd(), ".env"));

const apiKey = process.env.MINTLIFY_API_KEY;
const projectId = process.env.MINTLIFY_PROJECT_ID;

if (!apiKey || !projectId) {
  console.error(
    "Missing MINTLIFY_API_KEY or MINTLIFY_PROJECT_ID. Copy .env.example to .env and fill in values."
  );
  process.exit(1);
}

if (apiKey.startsWith("mint_us_")) {
  console.error(
    "This key starts with mint_us_ (Index API). Deploy needs an Admin API key that starts with mint_ from https://app.mintlify.com/settings/organization/api-keys"
  );
  process.exit(1);
}

if (apiKey.startsWith("mint_dsc_")) {
  console.error(
    "This key starts with mint_dsc_ (Assistant API). Deploy needs an Admin API key that starts with mint_."
  );
  process.exit(1);
}

async function mintlify(path, { method = "GET" } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { response, body };
}

const triggered = await mintlify(`/project/update/${projectId}`, {
  method: "POST",
});

if (!triggered.response.ok) {
  const detail =
    triggered.body?.error || triggered.body?.message || JSON.stringify(triggered.body);
  console.error(`Deploy trigger failed (${triggered.response.status}): ${detail}`);
  if (triggered.response.status === 401) {
    console.error(
      "Mintlify rejected the key. Create an Admin API key (prefix mint_) and put it in .env as MINTLIFY_API_KEY."
    );
  }
  process.exit(1);
}

const statusId = triggered.body?.statusId;
if (!statusId) {
  console.error("Trigger succeeded but no statusId was returned:", triggered.body);
  process.exit(1);
}

console.log(`Queued deploy. statusId=${statusId}`);

for (let i = 0; i < MAX_POLLS; i += 1) {
  const status = await mintlify(`/project/update-status/${statusId}`);
  if (!status.response.ok) {
    console.error(
      `Status check failed (${status.response.status}):`,
      status.body?.error || status.body
    );
    process.exit(1);
  }

  const state = status.body?.status ?? "unknown";
  const summary = status.body?.summary ? ` — ${status.body.summary}` : "";
  console.log(`[${state}] poll ${i + 1}/${MAX_POLLS}${summary}`);

  if (state === "success") {
    const host = status.body?.subdomain
      ? `https://${status.body.subdomain}.mintlify.app`
      : "dashboard";
    console.log(`Deploy succeeded. ${host}`);
    process.exit(0);
  }

  if (state === "failure") {
    if (Array.isArray(status.body?.logs) && status.body.logs.length) {
      console.error(status.body.logs.join("\n"));
    }
    console.error("Deploy failed.");
    process.exit(1);
  }

  await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
}

console.error("Timed out waiting for deploy status.");
process.exit(1);
