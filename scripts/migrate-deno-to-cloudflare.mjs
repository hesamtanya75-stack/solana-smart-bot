import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_FIELDS = new Set(["balance", "trades", "updatedAt"]);
const TRADE_FIELDS = new Set([
  "mint", "amount", "buyPrice", "currentPrice", "tokens",
  "sold", "sellPrice", "saleValue", "boughtAt", "soldAt"
]);

export function validateDenoState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Deno state must be a JSON object");
  }
  const unknown = Object.keys(state).filter(key => !SOURCE_FIELDS.has(key));
  if (unknown.length) throw new Error("Unsupported Deno state fields: " + unknown.join(", "));
  if (!Number.isFinite(state.balance) || state.balance < 0) {
    throw new Error("Deno balance must be a finite non-negative number");
  }
  if (!Array.isArray(state.trades) || state.trades.length > 500) {
    throw new Error("Deno trades must be an array of at most 500 entries");
  }
  for (let index = 0; index < state.trades.length; index++) {
    const trade = state.trades[index];
    if (!trade || typeof trade !== "object" || Array.isArray(trade)) {
      throw new Error("Trade " + index + " is not an object");
    }
    const extras = Object.keys(trade).filter(key => !TRADE_FIELDS.has(key));
    if (extras.length) throw new Error("Trade " + index + " has fields the Cloudflare state model cannot preserve: " + extras.join(", "));
    if (typeof trade.mint !== "string" || !trade.mint.trim() || trade.mint.length > 64 ||
        !Number.isFinite(trade.amount) || trade.amount <= 0 ||
        !Number.isFinite(trade.buyPrice) || trade.buyPrice <= 0 ||
        !Number.isFinite(trade.tokens) || trade.tokens <= 0) {
      throw new Error("Trade " + index + " failed required field validation");
    }
    for (const key of ["currentPrice", "sellPrice", "saleValue"]) {
      if (trade[key] !== undefined && (!Number.isFinite(trade[key]) || trade[key] < 0)) {
        throw new Error("Trade " + index + " has invalid " + key);
      }
    }
    if (trade.sold !== undefined && typeof trade.sold !== "boolean") {
      throw new Error("Trade " + index + " has invalid sold flag");
    }
    for (const key of ["boughtAt", "soldAt"]) {
      if (trade[key] !== undefined && trade[key] !== null &&
          (typeof trade[key] !== "string" || trade[key].length > 64)) {
        throw new Error("Trade " + index + " has invalid " + key);
      }
    }
  }
  return state;
}

export function normalizeTradeForCloudflare(trade) {
  return {
    mint: trade.mint.trim(),
    amount: trade.amount,
    buyPrice: trade.buyPrice,
    currentPrice: Number.isFinite(trade.currentPrice) && trade.currentPrice > 0 ? trade.currentPrice : trade.buyPrice,
    tokens: trade.tokens,
    sold: trade.sold === true,
    sellPrice: Number.isFinite(trade.sellPrice) ? trade.sellPrice : 0,
    saleValue: Number.isFinite(trade.saleValue) ? trade.saleValue : 0,
    boughtAt: typeof trade.boughtAt === "string" ? trade.boughtAt.slice(0, 64) : null,
    soldAt: typeof trade.soldAt === "string" ? trade.soldAt.slice(0, 64) : null
  };
}

export function buildCloudflareImport(source) {
  validateDenoState(source);
  return {
    balance: source.balance,
    trades: source.trades.map(normalizeTradeForCloudflare),
    autoEnabled: false,
    paused: true,
    scannedMints: []
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function stateMatches(source, destination) {
  if (!destination || destination.balance !== source.balance ||
      destination.autoEnabled !== false || destination.paused !== true ||
      !Array.isArray(destination.trades) ||
      destination.trades.length !== source.trades.length) return false;
  const expectedTrades = buildCloudflareImport(source).trades;
  return canonicalJson(destination.trades) === canonicalJson(expectedTrades);
}

async function api(baseUrl, path, { method = "GET", token, body, cloudflare = false } = {}) {
  const url = new URL(path, baseUrl);
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (cloudflare) {
    // The Worker rejects mutation requests without same-origin request metadata.
    headers.Origin = url.origin;
    headers["Sec-Fetch-Site"] = "same-origin";
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(20000)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { throw new Error(path + " returned non-JSON HTTP " + response.status); }
  if (!response.ok) throw new Error(path + " failed with HTTP " + response.status + ": " + (data?.error || "request failed"));
  return data;
}

async function login(baseUrl, password, cloudflare) {
  const result = await api(baseUrl, "/api/login", {
    method: "POST", body: { password }, cloudflare
  });
  if (result?.token) return result.token;
  if (cloudflare && result?.mfaRequired && typeof process.env.CLOUDFLARE_TOTP_CODE === "string") {
    const completed = await api(baseUrl, "/api/login/totp", {
      method: "POST",
      body: { challengeId: result.challengeId, code: process.env.CLOUDFLARE_TOTP_CODE },
      cloudflare
    });
    if (completed?.token) return completed.token;
  }
  throw new Error(cloudflare && result?.mfaRequired
    ? "Cloudflare MFA is enabled. Set CLOUDFLARE_TOTP_CODE for this one-time run, then retry."
    : "Login did not return a session token; verify credentials and MFA configuration.");
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

export function requireHttpsOrigin(value, name = "API URL") {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(name + " must be a valid absolute URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(name + " must be an HTTPS origin without embedded credentials, query, or fragment");
  }
  return url.origin;
}

async function main() {
  const denoUrl = requireHttpsOrigin(process.env.DENO_API_URL || "https://solana-smart-bot-17.hesamtanya75-stack.deno.net", "DENO_API_URL");
  const cloudflareUrl = requireHttpsOrigin(process.env.CLOUDFLARE_API_URL || "https://solana-smart-bot-new.hesamtanya75.workers.dev", "CLOUDFLARE_API_URL");
  const cloudflarePassword = required("CLOUDFLARE_LOGIN_PASSWORD");
  const backupPath = process.env.STATE_BACKUP_FILE || "deno-bot-state-backup.json";

  // Prefer a verified direct KV export when the Deno app runtime is suspended.
  // If no export file is supplied, retain the legacy authenticated API path.
  let source;
  if (process.env.DENO_STATE_FILE) {
    const exported = JSON.parse(await readFile(resolve(process.env.DENO_STATE_FILE), "utf8"));
    source = validateDenoState(exported);
    console.log("Using validated state from the read-only Deno KV export file.");
  } else {
    const denoPassword = required("DENO_LOGIN_PASSWORD");
    const denoToken = await login(denoUrl, denoPassword, false);
    source = validateDenoState(await api(denoUrl, "/api/state", { token: denoToken }));
  }
  const sourceIsDefault = source.balance === 100 && source.trades.length === 0;
  if (sourceIsDefault && process.env.CONFIRM_DEFAULT_SOURCE_STATE !== "YES") {
    throw new Error("Deno returned the default-looking state (balance 100, zero trades). The old API cannot prove whether the KV key exists. Inspect Deno KV/dashboard; if this empty state is intentional, set CONFIRM_DEFAULT_SOURCE_STATE=YES.");
  }

  const exportText = JSON.stringify(source, null, 2) + "\n";
  const checksum = createHash("sha256").update(exportText).digest("hex");
  await writeFile(backupPath, exportText, { flag: "wx", mode: 0o600 });
  console.log("Private Deno backup created: " + backupPath);
  console.log("Source checksum (SHA-256): " + checksum);
  console.log("Source balance: " + source.balance + "; trade count: " + source.trades.length);

  const cloudflareToken = await login(cloudflareUrl, cloudflarePassword, true);
  const before = await api(cloudflareUrl, "/api/state", { token: cloudflareToken });
  if (before.canMigrateLegacy !== true || !Number.isSafeInteger(before.revision) || before.revision < 0) {
    throw new Error("Cloudflare paper state is not explicitly marked as eligible for one-time legacy migration. No destination write was attempted. Preserve the Deno backup and reconcile the existing Cloudflare state first.");
  }

  // The migration tool must never mutate the destination merely because it was invoked.
  // Require a separate, explicit operator opt-in after read-only preflight and backup.
  if (process.env.CONFIRM_CLOUDFLARE_IMPORT !== "YES") {
    throw new Error("Read-only preflight and backup completed. No Cloudflare state was changed. To authorize the one-time import, set CONFIRM_CLOUDFLARE_IMPORT=YES only after reviewing the backup checksum, source state, and destination revision.");
  }

  const payload = buildCloudflareImport(source);
  await api(cloudflareUrl, "/api/state", {
    method: "PUT",
    token: cloudflareToken,
    cloudflare: true,
    body: { ...payload, expectedRevision: before.revision }
  });

  const after = await api(cloudflareUrl, "/api/state", { token: cloudflareToken });
  if (after.canMigrateLegacy !== false || !stateMatches(source, after)) {
    throw new Error("Read-back verification failed. Keep Deno online and retain the private backup; do not retry or delete source data.");
  }
  console.log("VERIFIED: Cloudflare balance and every supported trade field match the Deno export.");
  console.log("Cloudflare state is initialized with auto-buy disabled and paused for operator review.");
  console.log("Keep Deno and its KV data until the dashboard is manually checked and signed off.");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error("Deno-to-Cloudflare migration stopped safely: " + String(error?.message || error));
    process.exitCode = 1;
  });
}
