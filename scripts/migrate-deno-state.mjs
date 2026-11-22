import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isValidSourceState, isCompatibleWithWorkerState, normalizeLegacySourceState, isDefaultLikeSourceState, statesMatch, isSafeBackupPath } from "./migration-safety.mjs";

const sourceUrl = required("DENO_API_URL").replace(/\/+$/, "");
const targetUrl = required("CLOUDFLARE_API_URL").replace(/\/+$/, "");
const sourcePassword = required("DENO_LOGIN_PASSWORD");
const targetPassword = required("CLOUDFLARE_LOGIN_PASSWORD");
const backupPath = resolve(process.env.STATE_BACKUP_FILE || "deno-bot-state-backup.json");
if (!isSafeBackupPath(backupPath)) {
  throw new Error("Refusing to write a private state backup inside an unignored repository path. Use the default gitignored backup filename or set STATE_BACKUP_FILE to a path outside the checkout.");
}

// Never echo a credential-bearing endpoint URL into CI logs or error output.
function safeEndpoint(url) {
  try { return new URL(url).origin; }
  catch { return "configured endpoint"; }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Non-JSON response from ${safeEndpoint(url)} (HTTP ${response.status})`); }
  if (!response.ok) {
    const message = data?.error || `HTTP ${response.status}`;
    throw new Error(`${safeEndpoint(url)}: ${message}`);
  }
  return data;
}

async function login(baseUrl, password) {
  const result = await request(baseUrl + "/api/login", {
    method: "POST",
    body: JSON.stringify({ password })
  });
  if (!result?.token) throw new Error("Login did not return a session token; stop and check whether MFA or another login step is required.");
  return result.token;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const sourceToken = await login(sourceUrl, sourcePassword);
const original = await request(sourceUrl + "/api/state", {
  headers: { authorization: "Bearer " + sourceToken }
});
if (!isValidSourceState(original)) {
  throw new Error("Source state failed validation; nothing was imported.");
}
if (!isCompatibleWithWorkerState(original)) {
  throw new Error("Source state contains fields or array sizes that the Worker would normalize or truncate. Nothing was imported; preserve the backup and reconcile the state before retrying.");
}
// Deno GET /api/state returns the same balance/trades as a pristine default
// when its KV key is absent. Require an explicit operator decision in that case.
if (isDefaultLikeSourceState(original) && process.env.CONFIRM_DEFAULT_SOURCE_STATE !== "YES") {
  throw new Error("Source looks like the default state (balance 100, no trades). Deno GET cannot prove whether its KV key exists. Verify the Deno dashboard/KV state, then rerun with CONFIRM_DEFAULT_SOURCE_STATE=YES only if this is the intended source.");
}
await writeFile(backupPath, JSON.stringify(original, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(`Backup saved: ${backupPath}`);
console.log(`Source balance: ${original.balance}; trades: ${original.trades.length}`);

const importState = normalizeLegacySourceState(original);

const targetToken = await login(targetUrl, targetPassword);
const targetStatus = await request(targetUrl + "/api/state/status", {
  headers: { authorization: "Bearer " + targetToken }
});

// Require authoritative Durable Object metadata, not a default-looking state
// document. The import endpoint performs the final atomic one-time check.
if (!targetStatus || targetStatus.initialized !== false ||
    targetStatus.version !== 0 || targetStatus.imported !== false) {
  throw new Error("Cloudflare Durable Object is already initialized or its empty state cannot be proven. Import aborted.");
}

await request(targetUrl + "/api/state/import", {
  method: "POST",
  headers: { authorization: "Bearer " + targetToken },
  body: JSON.stringify(importState)
});
const imported = await request(targetUrl + "/api/state", {
  headers: { authorization: "Bearer " + targetToken }
});

if (!statesMatch(importState, imported)) {
  throw new Error("Verification failed: imported state differs from the normalized Deno export, including Worker defaults. Keep Deno running and restore from the backup; do not repeat blindly.");
}
console.log("VERIFIED: Cloudflare state matches the complete normalized Deno export, including safe Worker defaults.");
console.log(`Cloudflare balance: ${imported.balance}; trades: ${imported.trades.length}`);
console.log("Do not delete the Deno project or KV data until you manually confirm the dashboard.");
