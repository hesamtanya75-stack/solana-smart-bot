import { writeFile } from "node:fs/promises";
import { isValidSourceState, isUninitializedTargetState, statesMatch } from "./migration-safety.mjs";

const sourceUrl = required("DENO_API_URL").replace(/\/+$/, "");
const targetUrl = required("CLOUDFLARE_API_URL").replace(/\/+$/, "");
const sourcePassword = required("DENO_LOGIN_PASSWORD");
const targetPassword = required("CLOUDFLARE_LOGIN_PASSWORD");
const backupPath = process.env.STATE_BACKUP_FILE || "deno-bot-state-backup.json";

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Non-JSON response from ${url} (HTTP ${response.status})`); }
  if (!response.ok) {
    const message = data?.error || `HTTP ${response.status}`;
    throw new Error(`${url}: ${message}`);
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
await writeFile(backupPath, JSON.stringify(original, null, 2) + "\n", { flag: "wx" });
console.log(`Backup saved: ${backupPath}`);
console.log(`Source balance: ${original.balance}; trades: ${original.trades.length}`);

const targetToken = await login(targetUrl, targetPassword);
const existing = await request(targetUrl + "/api/state", {
  headers: { authorization: "Bearer " + targetToken }
});

// The Worker returns updatedAt:null only when the KV state key is absent.
// Never overwrite a state that appears initialized, even if it looks empty.
const targetIsUninitialized = isUninitializedTargetState(existing);
if (!targetIsUninitialized) {
  throw new Error("Cloudflare state is already initialized or cannot be proven empty. Import aborted to prevent overwriting existing data.");
}

await request(targetUrl + "/api/state", {
  method: "PUT",
  headers: { authorization: "Bearer " + targetToken },
  body: JSON.stringify(original)
});
const imported = await request(targetUrl + "/api/state", {
  headers: { authorization: "Bearer " + targetToken }
});

if (!statesMatch(original, imported)) {
  throw new Error("Verification failed: imported balance/trades differ. Keep Deno running and restore from the backup; do not repeat blindly.");
}
console.log("VERIFIED: Cloudflare balance and trade history match the Deno export.");
console.log(`Cloudflare balance: ${imported.balance}; trades: ${imported.trades.length}`);
console.log("Do not delete the Deno project or KV data until you manually confirm the dashboard.");
