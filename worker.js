export { PaperStateCoordinator } from "./paper-state-coordinator.js";
import { resolveSolanaRpcEndpoints } from "./solana-rpc-config.js";
export { MfaRateLimiter } from "./mfa-rate-limiter.js";
export { AuthGuard } from "./auth-guard.mjs";
export { LiveTradeCoordinator } from "./live-trade-coordinator.mjs";

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STATE = {
  balance: 100,
  trades: [],
  autoEnabled: false,
  paused: false,
  scannedMints: [],
  deferredMints: [],
  lastRunAt: null,
  lastMessage: "بۆتی سێرڤەر ئامادەیە؛ کڕینی خۆکار ناچالاکە.",
  lastScanReport: [],
  updatedAt: null
};
const RISKY_EXTENSIONS = new Set([6, 9, 12, 14, 26]);
let rpcCursor = 0;
let rpcDiagnostics = { successes: [], errors: [] };

function getRpcEndpoints(env) {
  const resolved = resolveSolanaRpcEndpoints(env);
  const preferred = resolved.endpoints.filter(endpoint => !endpoint.fallback);
  const fallbacks = resolved.endpoints.filter(endpoint => endpoint.fallback);
  if (fallbacks.length) {
    const offset = rpcCursor++ % fallbacks.length;
    const rotated = fallbacks.slice(offset).concat(fallbacks.slice(0, offset));
    return { endpoints: preferred.concat(rotated), errors: resolved.errors };
  }
  return { endpoints: preferred, errors: resolved.errors };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
function sameOriginApiRequest(request, url) {
  if (!url.pathname.startsWith("/api/") ||
      !["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get("Origin");
  if (origin) {
    try { if (new URL(origin).origin !== url.origin) return false; }
    catch { return false; }
  } else {
    // Browser requests include Origin; Fetch Metadata is checked when supplied.
    // Non-browser clients may omit both.
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (fetchSite === "cross-site") return false;
    if (fetchSite && fetchSite !== "same-origin") return false;
  }
  return request.headers.get("Sec-Fetch-Site") !== "cross-site";
}
async function readBoundedJson(request, maxBytes = 8192) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Request body required");
  const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); const error = new Error("Request body too large"); error.status = 413; throw error; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value;
}
function cleanState(value) {
  const s = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_STATE,
    ...s,
    balance: Number.isFinite(Number(s.balance)) && Number(s.balance) >= 0 ? Number(s.balance) : 100,
    trades: Array.isArray(s.trades) ? s.trades.slice(-500) : [],
    autoEnabled: s.autoEnabled === true,
    paused: s.paused === true,
    scannedMints: Array.isArray(s.scannedMints) ? s.scannedMints.slice(-1000) : [],
    deferredMints: Array.isArray(s.deferredMints) ? s.deferredMints.slice(-1000) : [],
    lastScanReport: Array.isArray(s.lastScanReport) ? s.lastScanReport.slice(-20) : []
  };
}
const STATE_VERSION = Symbol("paperStateVersion");
async function coordinatorRequest(env, path, body) {
  if (!env.PAPER_STATE_COORDINATOR) throw new Error("Paper State Coordinator binding is unavailable");
  const id = env.PAPER_STATE_COORDINATOR.idFromName("paper-state");
  const stub = env.PAPER_STATE_COORDINATOR.get(id);
  const response = await stub.fetch("https://paper-state.internal/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "Paper State Coordinator request failed");
    error.status = response.status;
    throw error;
  }
  return result;
}
async function authRateLimitRequest(env, path, body) {
  if (!env.AUTH_RATE_LIMITER) {
    const error = new Error("Authentication rate limiter binding is unavailable");
    error.status = 503;
    throw error;
  }
  try {
    const id = env.AUTH_RATE_LIMITER.idFromName("auth-rate-limit");
    const stub = env.AUTH_RATE_LIMITER.get(id);
    const response = await stub.fetch("https://auth-rate-limit.internal" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "Authentication rate limiter request failed");
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (error?.status) throw error;
    const unavailable = new Error("Authentication rate limiter is unavailable");
    unavailable.status = 503;
    throw unavailable;
  }
}
async function readStoredState(env) {
  const snapshot = await coordinatorRequest(env, "snapshot");
  if (!snapshot.initialized || !snapshot.state) return null;
  const state = cleanState(snapshot.state);
  Object.defineProperty(state, STATE_VERSION, { value: snapshot.version, writable: true });
  return state;
}
async function readState(env) {
  return (await readStoredState(env)) || cleanState(null);
}
async function saveState(env, state) {
  const expectedVersion = state[STATE_VERSION];
  const candidate = cleanState(state);
  candidate.updatedAt = new Date().toISOString();
  if (Number.isSafeInteger(expectedVersion)) {
    const result = await coordinatorRequest(env, "commit", { expectedVersion, state: candidate });
    Object.defineProperty(state, STATE_VERSION, { value: result.version, writable: true });
    return result;
  }
  const result = await coordinatorRequest(env, "import", candidate);
  Object.defineProperty(state, STATE_VERSION, { value: result.version, writable: true });
  return result;
}
async function patchPaperState(env, patch) {
  const snapshot = await coordinatorRequest(env, "snapshot");
  if (!snapshot.initialized) {
    const initial = { ...cleanState(null), ...patch };
    try {
      await coordinatorRequest(env, "import", initial);
      return { ok: true, state: initial, version: 1 };
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  return coordinatorRequest(env, "patch", patch);
}
async function saveProfileMetadata(env, profile) {
  const profileKey = ["admin", "profile"].join("_");
  await env.BOT_STATE.put(profileKey, JSON.stringify(profile));
}
async function authGuardCall(env, body) {
  const namespace = env.AUTH_GUARD;
  const token = String(env.AUTH_GUARD_INTERNAL_TOKEN || "");
  if (!namespace || token.length < 32) throw new Error("Authentication guard is not configured");
  const stub = namespace.get(namespace.idFromName("admin"));
  const response = await stub.fetch("https://auth-guard.internal/operation", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body)
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    const error = new Error(result.error || "Authentication guard request failed");
    error.status = response.status;
    throw error;
  }
  return result;
}
async function migrateLegacyFailure(env, scope, legacyKey) {
  const legacy = await env.BOT_STATE.get(legacyKey, "json");
  const count = Math.max(0, Math.min(5, Number(legacy?.count || 0)));
  if (count > 0) await authGuardCall(env, { operation: "import-legacy-failure", scope, count });
  await env.BOT_STATE.delete(legacyKey);
}
async function matchingTotpCounter(secret, code, now = Date.now()) {
  if (!secret || !/^[0-9]{6}$/.test(String(code || ""))) return null;
  for (const drift of [0, -30000, 30000]) {
    const counter = Math.floor((now + drift) / 30000);
    if (await totpCode(secret, now + drift) === String(code)) return counter;
  }
  return null;
}
async function authorized(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  const token = match ? match[1] : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) return false;
  const session = await env.BOT_STATE.get("session:" + token, "json");
  if (!session || !(session.expiresAt > Date.now())) return false;
  const profile = await readProfile(env);
  return Number(session.authVersion || 0) === Number(profile.authVersion || 0);
}
async function rpc(method, params, env) {
  const resolved = getRpcEndpoints(env);
  const errors = [...resolved.errors];
  for (const endpoint of resolved.endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(7000)
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        throw new Error("HTTP " + response.status + (retryAfter ? " (Retry-After " + retryAfter + "s)" : ""));
      }
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || "RPC error");
      if (!Object.prototype.hasOwnProperty.call(data, "result")) throw new Error("RPC result missing");
      rpcDiagnostics.successes.push(endpoint.label);
      return data.result;
    } catch (error) {
      const message = String(error?.message || error);
      errors.push(endpoint.label + ": " + message);
      rpcDiagnostics.errors.push(endpoint.label + ": " + message);
    }
  }
  throw new Error("Solana RPC providers failed — " + errors.join(" | "));
}

async function rpcBatch(calls, env) {
  const resolved = getRpcEndpoints(env);
  const errors = [...resolved.errors];

  // Some RPC gateways reject JSON-RPC batch payloads even though they support
  // each underlying method. Retry that provider with bounded parallel singles
  // before abandoning it; this is especially important for free/shared RPCs.
  async function requestSingle(endpoint, call, id) {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: call.method, params: call.params }),
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("Retry-After");
      throw new Error("HTTP " + response.status + (retryAfter ? " (Retry-After " + retryAfter + "s)" : ""));
    }
    const item = await response.json();
    if (item?.error) throw new Error(item.error.message || "RPC error");
    if (!item || !Object.prototype.hasOwnProperty.call(item, "result")) {
      throw new Error("RPC single response missing result");
    }
    return item.result;
  }

  for (const endpoint of resolved.endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(calls.map((call, index) => ({
          jsonrpc: "2.0", id: index + 1, method: call.method, params: call.params
        }))),
        signal: AbortSignal.timeout(7000)
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        const statusError = new Error("HTTP " + response.status + (retryAfter ? " (Retry-After " + retryAfter + "s)" : ""));
        statusError.batchUnsupported = [400, 405, 415, 501].includes(response.status);
        throw statusError;
      }
      const data = await response.json();
      if (!Array.isArray(data)) {
        if (calls.length < 2) throw new Error("RPC batch response invalid");
        const results = await Promise.all(calls.map((call, index) => requestSingle(endpoint, call, index + 1)));
        rpcDiagnostics.successes.push(endpoint.label + " (single-request fallback)");
        return results;
      }
      const byId = new Map(data.map(item => [item.id, item]));
      const results = calls.map((_, index) => {
        const item = byId.get(index + 1);
        if (!item || item.error || !Object.prototype.hasOwnProperty.call(item, "result")) {
          throw new Error(item?.error?.message || "RPC batch item missing result");
        }
        return item.result;
      });
      rpcDiagnostics.successes.push(endpoint.label);
      return results;
    } catch (error) {
      const message = String(error?.message || error);
      if (error?.batchUnsupported && calls.length > 1) {
        try {
          const results = await Promise.all(calls.map((call, index) => requestSingle(endpoint, call, index + 1)));
          rpcDiagnostics.successes.push(endpoint.label + " (single-request fallback)");
          return results;
        } catch (fallbackError) {
          const fallbackMessage = String(fallbackError?.message || fallbackError);
          errors.push(endpoint.label + " batch unsupported; single requests failed: " + fallbackMessage);
          rpcDiagnostics.errors.push(endpoint.label + " batch unsupported; single requests failed: " + fallbackMessage);
          continue;
        }
      }
      errors.push(endpoint.label + ": " + message);
      rpcDiagnostics.errors.push(endpoint.label + ": " + message);
    }
  }
  throw new Error("Solana RPC batch providers failed — " + errors.join(" | "));
}

async function getJson(url) {
  const host = new URL(url).hostname;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    } catch (error) {
      lastError = new Error(host + " network error: " + String(error?.message || error));
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw lastError;
    }
    if (response.ok) return response.json();
    const status = response.status;
    lastError = new Error(host + " HTTP " + status);
    if (status !== 429 && status < 500) throw lastError;
    if (attempt < 2) {
      const retryHeader = response.headers.get("Retry-After");
      let retryAfterMs = 0;
      if (retryHeader) {
        const seconds = Number(retryHeader);
        retryAfterMs = Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000
          : Math.max(0, Date.parse(retryHeader) - Date.now());
      }
      // Respect long provider cooldowns instead of retrying early and extending the rate limit.
      if (status === 429 && retryAfterMs > 10000) {
        throw new Error(host + " HTTP 429 (provider asks to retry after " + Math.ceil(retryAfterMs / 1000) + "s)");
      }
      const delay = retryAfterMs > 0 ? retryAfterMs : 1500 * (attempt + 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error(host + " request failed");
}

async function getDexJson(url, env, ttlSeconds = 30) {
  // Cache responses and enforce a shared cooldown after HTTP 429.
  // Stale cached discovery profiles are allowed during cooldown, but stale
  // market data is never used for safety checks or simulated purchases.
  let cacheKey, cached = null;
  const discoveryOnly = url.includes("/token-profiles/latest/v1");
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    cacheKey = "dex_cache:" + hash;
    cached = await env.BOT_STATE.get(cacheKey, "json");
    if (cached?.savedAt && Date.now() - cached.savedAt < ttlSeconds * 1000) {
      return cached.data;
    }
  } catch (error) {
    console.warn("DexScreener cache read warning", String(error?.message || error));
  }

  try {
    const cooldown = await env.BOT_STATE.get("dex_cooldown", "json");
    if (cooldown?.until > Date.now()) {
      if (discoveryOnly && cached?.data) return cached.data;
      throw new Error("DexScreener cooldown active; retry in " +
        Math.ceil((cooldown.until - Date.now()) / 1000) + "s");
    }
  } catch (error) {
    if (String(error?.message || error).includes("cooldown active")) throw error;
    console.warn("DexScreener cooldown read warning", String(error?.message || error));
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (response.status === 429) {
    const retryHeader = response.headers.get("Retry-After");
    const seconds = Number(retryHeader);
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : Math.max(0, Date.parse(retryHeader || "") - Date.now());
    const cooldownMs = Math.min(15 * 60 * 1000, Math.max(60 * 1000, retryAfterMs));
    try {
      await env.BOT_STATE.put("dex_cooldown", JSON.stringify({ until: Date.now() + cooldownMs }), {
        expirationTtl: Math.ceil(cooldownMs / 1000) + 30
      });
    } catch (error) {
      console.warn("DexScreener cooldown write warning", String(error?.message || error));
    }
    if (discoveryOnly && cached?.data) return cached.data;
    throw new Error("api.dexscreener.com HTTP 429; cooldown " + Math.ceil(cooldownMs / 1000) + "s");
  }
  if (!response.ok) throw new Error("api.dexscreener.com HTTP " + response.status);
  const data = await response.json();
  if (cacheKey) {
    try {
      await env.BOT_STATE.put(cacheKey, JSON.stringify({ savedAt: Date.now(), data }), {
        expirationTtl: Math.max(60, ttlSeconds * 2)
      });
    } catch (error) {
      console.warn("DexScreener cache write warning", String(error?.message || error));
    }
  }
  return data;
}

function mintDetails(account) {
  const value = account?.value;
  if (!value) throw new Error("Mint account unavailable");
  let mintAuthority = null, freezeAuthority = null, extensions = [];
  const parsed = value.data?.parsed?.info;
  if (parsed) {
    mintAuthority = !!parsed.mintAuthority;
    freezeAuthority = !!parsed.freezeAuthority;
  }
  const raw = value.data;
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    const bytes = Uint8Array.from(atob(raw[0]), c => c.charCodeAt(0));
    if (bytes.length >= 82) {
      const u32 = i => (bytes[i] | (bytes[i+1] << 8) | (bytes[i+2] << 16) | (bytes[i+3] << 24)) >>> 0;
      const ma = u32(0), fa = u32(46);
      if (ma <= 1 && fa <= 1) {
        mintAuthority = ma === 1;
        freezeAuthority = fa === 1;
      }
    }
    if (bytes.length >= 166) {
      let offset = 166;
      while (offset + 4 <= bytes.length) {
        const type = bytes[offset] | (bytes[offset+1] << 8);
        const length = bytes[offset+2] | (bytes[offset+3] << 8);
        if (type === 0 && length === 0) break;
        if (offset + 4 + length > bytes.length) break;
        extensions.push(type);
        offset += 4 + length;
      }
    }
  }
  return { mintAuthority, freezeAuthority, extensions, owner: value.owner };
}
async function inspectMint(mint, env) {
  // Check for a real Solana market first. New-token profile entries can exist
  // before DexScreener has indexed a tradable pair; avoid spending RPC calls then.
  const dex = await getDexJson(
    "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(mint), env, 90
  );
  const market = (dex.pairs || []).filter(p => p.chainId === "solana")
    .sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  if (!market) throw new Error("No Solana market pair");

  const [rug, rpcResults] = await Promise.all([
    getJson("https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(mint) + "/report"),
    rpcBatch([
      { method: "getAccountInfo", params: [mint, { encoding: "base64", commitment: "confirmed" }] },
      { method: "getTokenLargestAccounts", params: [mint, { commitment: "confirmed" }] },
      { method: "getTokenSupply", params: [mint, { commitment: "confirmed" }] }
    ], env)
  ]);
  const [account, largest, supply] = rpcResults;
  const details = mintDetails(account);
  const supplyAmount = Number(supply?.value?.amount || 0);
  const largestAccounts = (largest?.value || []).slice(0, 20);
  if (!largestAccounts.length || !supplyAmount) throw new Error("Holder data unavailable");
  // getTokenLargestAccounts returns token accounts, not wallet owners.
  // Resolve their parsed owner fields and aggregate balances by unique wallet.
  const accountDetails = await rpc(
    "getMultipleAccounts",
    [largestAccounts.map(account => account.address), { encoding: "jsonParsed", commitment: "confirmed" }],
    env
  );
  const ownerBalances = new Map();
  for (let i = 0; i < largestAccounts.length; i++) {
    const account = accountDetails?.value?.[i];
    const info = account?.data?.parsed?.info;
    const owner = info?.owner;
    const amount = Number(info?.tokenAmount?.amount ?? largestAccounts[i]?.amount ?? 0);
    if (!owner || !Number.isFinite(amount)) continue;
    ownerBalances.set(owner, (ownerBalances.get(owner) || 0) + amount);
  }
  if (!ownerBalances.size) throw new Error("Token account owners unavailable");
  const ownerPercentages = [...ownerBalances.values()]
    .map(amount => amount / supplyAmount * 100)
    .sort((a, b) => b - a);
  const largestPct = ownerPercentages[0] || 0;
  const topTenPct = ownerPercentages.slice(0, 10).reduce((a, b) => a + b, 0);
  const liquidity = Number(market.liquidity?.usd || 0);
  const volume = Number(market.volume?.h24 || 0);
  const sells = Number(market.txns?.h24?.sells || 0);
  const reasons = [];
  if (liquidity < 10000) reasons.push("Liquidity below $10,000");
  if (volume < 1000) reasons.push("24h volume below $1,000");
  if (sells <= 0) reasons.push("No 24h sells");
  if (details.mintAuthority !== false || details.freezeAuthority !== false) reasons.push("Mint/Freeze authority not confirmed inactive");
  if (largestPct > 30) reasons.push("Largest holder above 30%");
  if (topTenPct > 50) reasons.push("Top 10 holders above 50%");
  if (!rug || rug.score == null || Number(rug.score) > 2500) reasons.push("RugCheck unavailable or score above 2500");
  if (details.extensions.some(type => RISKY_EXTENSIONS.has(type))) reasons.push("Risky Token-2022 extension detected");
  const price = Number(market.priceUsd || 0);
  if (!(price > 0)) reasons.push("Price unavailable");
  return { ok: reasons.length === 0, reasons, price, market, rugScore: rug?.score, largestPct, topTenPct };
}
async function refreshTrades(state, env) {
  const open = state.trades.filter(t => !t.sold);
  if (!open.length) return 0;
  const addresses = [...new Set(open.map(t => t.mint).filter(Boolean))].slice(0, 30);
  const data = await getDexJson("https://api.dexscreener.com/latest/dex/tokens/" + addresses.map(encodeURIComponent).join(","), env, 15);
  const best = new Map();
  for (const pair of (data.pairs || []).filter(p => p.chainId === "solana")) {
    const mint = pair.baseToken?.address;
    if (!mint) continue;
    if (!best.has(mint) || Number(pair.liquidity?.usd || 0) > Number(best.get(mint).liquidity?.usd || 0)) best.set(mint, pair);
  }
  let sold = 0;
  for (const trade of open) {
    const price = Number(best.get(trade.mint)?.priceUsd || 0);
    if (!(price > 0)) continue;
    trade.currentPrice = price;
    if (price >= Number(trade.buyPrice) * 1.10 || price <= Number(trade.buyPrice) * 0.95) {
      const saleValue = Number((Number(trade.tokens) * price).toFixed(2));
      state.balance = Number((state.balance + saleValue).toFixed(2));
      Object.assign(trade, { sold: true, sellPrice: price, saleValue, soldAt: new Date().toISOString() });
      sold++;
    }
  }
  return sold;
}
async function autoBuy(state, env) {
  if (!state.autoEnabled || state.paused || state.balance < 5 || state.trades.filter(t => !t.sold).length >= 10) return "Auto-buy inactive, paused, or limit reached.";
  const profiles = await getDexJson("https://api.dexscreener.com/token-profiles/latest/v1", env, 15);
  const seen = new Set();
  const tokens = Array.isArray(profiles) ? profiles.filter(t => {
    const mint = String(t?.tokenAddress || "");
    if (t?.chainId !== "solana" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || seen.has(mint)) return false;
    seen.add(mint);
    return true;
  }) : [];
  let checked = 0, bought = 0, skippedExisting = 0;
  const report = [];
  const scanned = new Set(state.scannedMints);
  const traded = new Set(state.trades.map(t => t.mint));
  for (const token of tokens) {
    if (checked >= 10 || state.balance < 5 || state.trades.filter(t => !t.sold).length >= 10) break;
    const mint = token.tokenAddress;
    if (scanned.has(mint) || traded.has(mint)) { skippedExisting++; continue; }
    const deferred = state.deferredMints.find(item => item.mint === mint);
    if (deferred && Number(deferred.retryAt) > Date.now()) continue;
    state.deferredMints = state.deferredMints.filter(item => item.mint !== mint);
    checked++;
    try {
      const result = await inspectMint(mint, env);
      // Only mark a mint as scanned after a complete inspection.
      // Temporary RPC/API failures remain eligible for a later retry.
      state.scannedMints.push(mint);
      if (!result.ok) {
        report.push({ mint, status: "rejected", reasons: result.reasons });
        continue;
      }
      state.balance = Number((state.balance - 5).toFixed(2));
      state.trades.push({
        mint, amount: 5, buyPrice: result.price, currentPrice: result.price,
        tokens: 5 / result.price, sold: false, boughtAt: new Date().toISOString(),
        mode: "paper", riskChecks: "passed"
      });
      bought++;
      report.push({ mint, status: "bought-paper", reasons: ["هەموو پشکنینەکان تێپەڕاند"] });
    } catch (error) {
      const message = String(error?.message || "داتای پشکنین بەردەست نییە");
      if (message === "No Solana market pair") {
        // Keep the token eligible, but don't let an unindexed profile consume
        // every minute's scan slot. Recheck it after a short cooldown.
        state.deferredMints.push({ mint, retryAt: Date.now() + 5 * 60 * 1000 });
        report.push({ mint, status: "deferred", reasons: ["بازاڕی Solana هێشتا نەدۆزراوەتەوە؛ دوای ٥ خولەک دووبارە پشکنین دەکرێت"] });
      } else {
        report.push({ mint, status: "blocked-error", reasons: [message] });
      }
      // Unknown or unavailable data always means no simulated purchase.
    }
  }
  state.scannedMints = state.scannedMints.slice(-1000);
  state.deferredMints = state.deferredMints.slice(-1000);
  state.lastScanReport = report.slice(-20);
  const blocked = report.filter(x => x.status === "rejected" || x.status === "blocked-error").length;
  const deferred = report.filter(x => x.status === "deferred").length;
  const noNewTokens = checked === 0
    ? " No unscanned new Solana tokens were available in the latest profile list; " + skippedExisting + " already-seen tokens skipped."
    : "";
  return "Checked " + checked + " new tokens (max 10 per cycle); paper buys: " + bought + ". " + blocked + " blocked; " + deferred + " waiting for a Solana market; reasons saved in scan report." + noNewTokens;
}


function base32Encode(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0; const out = [];
  for (const char of String(input || "").toUpperCase().replace(/=|\s/g, "")) {
    const n = alphabet.indexOf(char);
    if (n < 0) throw new Error("Invalid authenticator secret");
    value = (value << 5) | n; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
async function totpCode(secret, time = Date.now()) {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = Math.floor(time / 30000);
  const msg = new Uint8Array(8);
  let n = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = n & 255; n = Math.floor(n / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 127) << 24) | ((mac[offset + 1] & 255) << 16) | ((mac[offset + 2] & 255) << 8) | (mac[offset + 3] & 255);
  return String(binary % 1000000).padStart(6, "0");
}
async function verifyTotp(secret, code) {
  if (!/^\d{6}$/.test(String(code || ""))) return false;
  for (const drift of [-30000, 0, 30000]) {
    if (await totpCode(secret, Date.now() + drift) === String(code)) return true;
  }
  return false;
}
async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function readProfile(env) {
  return await env.BOT_STATE.get("admin_profile", "json") || {
    email: "", phone: "", emailVerified: false, phoneVerified: false,
    totpEnabled: false, totpSecret: null, backupHash: null
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const buildId = env.BUILD_ID || env.CF_VERSION_METADATA?.id || "local-unversioned";
    if (!sameOriginApiRequest(request, url)) return json({ error: "Cross-origin API request rejected" }, 403);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, mode: "paper-trading", scheduler: "Cloudflare Cron", storage: "Durable Object (paper state) + Workers KV (sessions/cache)", build: buildId });
    }
    if (url.pathname === "/version" && request.method === "GET") {
      return json({ ok: true, build: buildId, frontend: "premium-dashboard-v2", asset: "index.html" });
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const { password } = await readBoundedJson(request, 4096);
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ipHash = await hashText(ip);
        const loginScope = "login:" + ipHash;
        await migrateLegacyFailure(env, loginScope, "login_fail:" + ip);
        const limited = await authGuardCall(env, { operation: "is-rate-limited", scope: loginScope });
        if (limited.limited) return json({ error: "زۆر هەوڵی چوونەژوورەوە دراوە؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
        const expected = env.BOT_LOGIN_PASSWORD;
        if (!expected || typeof password !== "string" || password !== expected) {
          const failure = await authGuardCall(env, { operation: "record-failure", scope: loginScope });
          return json({ error: "وشەی نهێنی هەڵەیە" }, failure.limited ? 429 : 401);
        }
        await authGuardCall(env, { operation: "clear-failures", scope: loginScope });
        await env.BOT_STATE.delete("login_fail:" + ip);
        const legacyProfile = await readProfile(env);
        const marker = await env.BOT_STATE.get("auth_guard_migration_v1");
        const guardProfile = await authGuardCall(env, { operation: "get-profile" });
        if (marker === "complete") {
          if (!guardProfile.initialized) throw Object.assign(new Error("Migrated AuthGuard state is unavailable"), { status: 503 });
        } else {
          const migration = await authGuardCall(env, {
            operation: "initialize-legacy",
            backupHash: legacyProfile.backupHash ?? null,
            lastTotpCounter: Number.isSafeInteger(legacyProfile.lastTotpCounter) ? legacyProfile.lastTotpCounter : -1,
            totpEnabled: legacyProfile.totpEnabled === true,
            totpSecret: legacyProfile.totpSecret ?? null,
            pendingTotpSecret: legacyProfile.pendingTotpSecret ?? null,
            pendingTotpAt: Number.isSafeInteger(legacyProfile.pendingTotpAt) ? legacyProfile.pendingTotpAt : null
          });
          const verified = await authGuardCall(env, {
            operation: "verify-legacy",
            backupHash: legacyProfile.backupHash ?? null,
            lastTotpCounter: Number.isSafeInteger(legacyProfile.lastTotpCounter) ? legacyProfile.lastTotpCounter : -1,
            totpEnabled: legacyProfile.totpEnabled === true,
            totpSecret: legacyProfile.totpSecret ?? null,
            pendingTotpSecret: legacyProfile.pendingTotpSecret ?? null,
            pendingTotpAt: Number.isSafeInteger(legacyProfile.pendingTotpAt) ? legacyProfile.pendingTotpAt : null
          });
          if (!migration.initialized && !verified.verified) throw Object.assign(new Error("Legacy MFA state conflicts with initialized AuthGuard"), { status: 503 });
          if (!verified.verified) throw Object.assign(new Error("Legacy MFA migration could not be verified"), { status: 503 });
          for (const key of ["totpSecret", "pendingTotpSecret", "pendingTotpAt", "backupHash", "lastTotpCounter"]) delete legacyProfile[key];
          await env.BOT_STATE.put("admin_profile", JSON.stringify(legacyProfile));
          await env.BOT_STATE.put("auth_guard_migration_v1", "complete");
        }
        const currentGuardProfile = await authGuardCall(env, { operation: "get-profile" });
        if (currentGuardProfile.totpEnabled) {
          const challengeId = crypto.randomUUID();
          const challenge = await authGuardCall(env, { operation: "create-challenge", challengeId });
          if (!challenge.created) return json({ error: "نەتوانرا داواکاری MFA دروست بکرێت" }, 503);
          return json({ ok: true, mfaRequired: true, challengeId });
        }
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + SESSION_MS;
        await env.BOT_STATE.put("session:" + token, JSON.stringify({ expiresAt, authVersion: Number(legacyProfile.authVersion || 0) }), { expirationTtl: Math.ceil(SESSION_MS / 1000) });
        return json({ ok: true, token });
      } catch (error) {
        if (error?.status === 503) return json({ error: "خزمەتگوزاری پاراستنی چوونەژوورەوە بەردەست نییە؛ دواتر هەوڵ بدە." }, 503);
        return json({ error: "داواکاری هەڵەیە" }, 400);
      }
    }
    if (url.pathname === "/api/login/totp" && request.method === "POST") {
      try {
        const { challengeId, code } = await readBoundedJson(request, 4096);
        if (typeof challengeId !== "string" || typeof code !== "string") return json({ error: "کۆدی پشتڕاستکردنەوە نادروستە" }, 400);
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ipHash = await hashText(ip);
        const failureScope = "totp:" + ipHash;
        await migrateLegacyFailure(env, failureScope, "totp_fail:" + ip);
        const limited = await authGuardCall(env, { operation: "is-rate-limited", scope: failureScope });
        if (limited.limited) return json({ error: "هەوڵەکانی Authenticator زۆر بوون؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
        const guardProfile = await authGuardCall(env, { operation: "get-profile" });
        if (!guardProfile.totpEnabled || !guardProfile.totpSecret) return json({ error: "Authenticator is not configured correctly" }, 401);
        const matchedCounter = await matchingTotpCounter(guardProfile.totpSecret, code);
        const submittedBackupHash = await hashText(String(code).trim().toUpperCase());
        const result = await authGuardCall(env, {
          operation: "complete-challenge",
          challengeId,
          totpCounter: matchedCounter,
          backupHash: matchedCounter === null ? submittedBackupHash : null,
          failureScope
        });
        if (!result.ok) {
          if (result.reason === "rate-limited" || result.reason === "attempts-exhausted") {
            return json({ error: "هەوڵەکان تەواو بوون؛ دووبارە بچۆ ژوورەوە" }, 429);
          }
          return json({ error: "کۆدی Authenticator هەڵەیە یان داواکارییەکە بەسەرچووە" }, 401);
        }
        await env.BOT_STATE.delete("totp_fail:" + ip);
        const profile = await readProfile(env);
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + SESSION_MS;
        await env.BOT_STATE.put("session:" + token, JSON.stringify({ expiresAt, authVersion: Number(profile.authVersion || 0) }), { expirationTtl: Math.ceil(SESSION_MS / 1000) });
        return json({ ok: true, token });
      } catch (error) {
        if (error?.status === 503) return json({ error: "خزمەتگوزاری پاراستنی MFA بەردەست نییە؛ دواتر هەوڵ بدە." }, 503);
        return json({ error: "نەتوانرا کۆدی پشتڕاستکردنەوە بپشکنرێت" }, 400);
      }
    }
    if (url.pathname.startsWith("/api/")) {
      if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);
      if (url.pathname === "/api/logout" && request.method === "POST") {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        if (token) await env.BOT_STATE.delete("session:" + token);
        return json({ ok: true });
      }
      if (url.pathname === "/api/profile" && request.method === "GET") {
        const p = await readProfile(env);
        const auth = await authGuardCall(env, { operation: "get-profile" });
        return json({ email: p.email || "", phone: p.phone || "", emailVerified: !!p.emailVerified, phoneVerified: !!p.phoneVerified, totpEnabled: auth.totpEnabled === true });
      }
      if (url.pathname === "/api/profile" && request.method === "PUT") {
        try {
          const body = await request.json();
          const p = await readProfile(env);
          if (typeof body.email === "string") {
            const email = body.email.trim().slice(0, 254);
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "ئیمەیڵەکە دروست نییە" }, 400);
            if (email !== p.email) p.emailVerified = false;
            p.email = email;
          }
          if (typeof body.phone === "string") {
            const phone = body.phone.trim().slice(0, 24);
            if (phone && !/^\+?[0-9\s()-]{7,20}$/.test(phone)) return json({ error: "ژمارەی مۆبایل دروست نییە" }, 400);
            if (phone !== p.phone) p.phoneVerified = false;
            p.phone = phone;
          }
          await saveProfileMetadata(env, p);
          return json({ ok: true, email: p.email, phone: p.phone, emailVerified: !!p.emailVerified, phoneVerified: !!p.phoneVerified, totpEnabled: !!p.totpEnabled, message: "زانیاری پڕۆفایل پاشەکەوت کرا؛ ئیمەیڵ و مۆبایل هێشتا پشتڕاست نەکراونەتەوە." });
        } catch { return json({ error: "زانیاری پڕۆفایل نادروستە" }, 400); }
      }
      if (url.pathname === "/api/totp/setup" && request.method === "POST") {
        try {
          const { password } = await readBoundedJson(request, 4096);
          const expected = env.BOT_LOGIN_PASSWORD;
          const ip = request.headers.get("CF-Connecting-IP") || "unknown";
          const ipHash = await hashText(ip);
          const scope = "totp-setup:" + ipHash;
          await migrateLegacyFailure(env, scope, "totp_setup_fail:" + ip);
          const limited = await authGuardCall(env, { operation: "is-rate-limited", scope });
          if (limited.limited) return json({ error: "هەوڵی چالاککردنی Authenticator زۆر بوو؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
          if (!expected || typeof password !== "string" || password !== expected) {
            const failure = await authGuardCall(env, { operation: "record-failure", scope });
            return json({ error: "وشەی نهێنی بۆ چالاککردنی Authenticator هەڵەیە" }, failure.limited ? 429 : 401);
          }
          await authGuardCall(env, { operation: "clear-failures", scope });
          const auth = await authGuardCall(env, { operation: "get-profile" });
          if (auth.totpEnabled) return json({ error: "Google Authenticator پێشتر چالاک کراوە" }, 409);
          const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
          const begun = await authGuardCall(env, { operation: "begin-totp-setup", secret });
          if (!begun.ok) return json({ error: "نەتوانرا setup ـی Authenticator دەستپێبکرێت" }, 409);
          const label = encodeURIComponent("Solana Smart Bot Admin");
          const issuer = encodeURIComponent("Solana Smart Bot");
          const uri = "otpauth://totp/" + label + "?secret=" + secret + "&issuer=" + issuer + "&algorithm=SHA1&digits=6&period=30";
          return json({ ok: true, secret, otpauthUri: uri, message: "ئەم کلیلە لە Google Authenticator زیاد بکە؛ پاشان کۆدی ٦ ژمارەیی بنووسە." });
        } catch (error) {
          if (error?.status === 503) return json({ error: "خزمەتگوزاری پاراستنی Authenticator بەردەست نییە؛ دواتر هەوڵ بدە." }, 503);
          return json({ error: "نەتوانرا setup ـی Authenticator دەستپێبکرێت" }, 400);
        }
      }
      if (url.pathname === "/api/totp/confirm" && request.method === "POST") {
        try {
          const { code } = await readBoundedJson(request, 4096);
          const auth = await authGuardCall(env, { operation: "get-profile" });
          if (!auth.pendingTotpSecret || !Number.isSafeInteger(auth.pendingTotpAt) ||
              Date.now() < auth.pendingTotpAt || Date.now() - auth.pendingTotpAt > 600000) {
            return json({ error: "کلیلی کاتی بەسەرچووە؛ setup دووبارە بکە" }, 400);
          }
          const ip = request.headers.get("CF-Connecting-IP") || "unknown";
          const ipHash = await hashText(ip);
          const scope = "totp-setup:" + ipHash;
          const limited = await authGuardCall(env, { operation: "is-rate-limited", scope });
          if (limited.limited) return json({ error: "هەوڵی چالاککردنی Authenticator زۆر بوو؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
          const backupCode = crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
          const result = await authGuardCall(env, {
            operation: "confirm-totp-setup",
            code: String(code || ""),
            backupHash: await hashText(backupCode),
            failureScope: scope
          });
          if (!result.ok) {
            return json({ error: result.reason === "rate-limited" ? "هەوڵەکان تەواو بوون" : "کۆدی Authenticator هەڵەیە" }, result.reason === "rate-limited" ? 429 : 401);
          }
          const p = await readProfile(env);
          p.totpEnabled = true;
          p.authVersion = Number(p.authVersion || 0) + 1;
          for (const key of ["totpSecret", "pendingTotpSecret", "pendingTotpAt", "backupHash", "lastTotpCounter"]) delete p[key];
          await saveProfileMetadata(env, p);
          await authGuardCall(env, { operation: "clear-failures", scope });
          return json({ ok: true, backupCode, message: "Google Authenticator چالاک کرا. کۆدی گەڕاندنەوە تەنها یەکجار پیشان دەدرێت." });
        } catch (error) {
          if (error?.status === 503) return json({ error: "خزمەتگوزاری پاراستنی Authenticator بەردەست نییە؛ دواتر هەوڵ بدە." }, 503);
          return json({ error: "نەتوانرا Authenticator چالاک بکرێت" }, 400);
        }
      }
      if (url.pathname === "/api/market-prices" && request.method === "POST") {
        try {
          const state = await readState(env);
          const open = state.trades.filter(t => !t.sold);
          if (!open.length) return json({ ok: true, prices: {} });
          const addresses = [...new Set(open.map(t => t.mint).filter(Boolean))].slice(0, 30);
          const data = await getDexJson(
            "https://api.dexscreener.com/latest/dex/tokens/" + addresses.map(encodeURIComponent).join(","),
            env, 30
          );
          const best = new Map();
          for (const pair of (data.pairs || []).filter(p => p.chainId === "solana")) {
            const mint = pair.baseToken?.address;
            if (!mint) continue;
            if (!best.has(mint) || Number(pair.liquidity?.usd || 0) > Number(best.get(mint).liquidity?.usd || 0)) best.set(mint, pair);
          }
          const prices = {};
          for (const trade of open) {
            const price = Number(best.get(trade.mint)?.priceUsd || 0);
            if (price > 0) prices[trade.mint] = price;
          }
          // Display-only prices: never change balance or close trades from a browser poll.
          return json({ ok: true, prices });
        } catch (error) {
          return json({ error: "Market price lookup failed: " + String(error?.message || error) }, 503);
        }
      }
      if (url.pathname === "/api/state/status" && request.method === "GET") {
        return json(await coordinatorRequest(env, "status"));
      }
      if (url.pathname === "/api/state/import" && request.method === "POST") {
        try {
          const body = await request.json();
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return json({ error: "Invalid state" }, 400);
          }
          const result = await coordinatorRequest(env, "import", body);
          return json(result);
        } catch (error) {
          return json({ error: error.status === 409 ? "State is already initialized" : "Invalid state" }, error.status || 400);
        }
      }
      if (url.pathname === "/api/state" && request.method === "GET") {
        const stored = await readStoredState(env);
        const revision = stored && Number.isSafeInteger(stored[STATE_VERSION]) ? stored[STATE_VERSION] : 0;
        return json({
          ...(stored || cleanState(null)),
          revision,
          canMigrateLegacy: !stored
        });
      }
      if (url.pathname === "/api/state" && request.method === "PUT") {
        try {
          const body = await readBoundedJson(request, 256 * 1024);
          const expectedRevision = body.expectedRevision;
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            return json({ error: "Invalid expectedRevision" }, 400);
          }
          const stateKeys = [
            "balance", "trades", "autoEnabled", "paused", "scannedMints",
            "deferredMints", "lastRunAt", "lastMessage", "lastScanReport", "updatedAt"
          ];
          if (Object.keys(body).some(key => key !== "expectedRevision" && !stateKeys.includes(key))) {
            return json({ error: "State contains unsupported fields" }, 400);
          }
          const stringFields = ["lastRunAt", "lastMessage", "updatedAt"];
          for (const key of stringFields) {
            if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string") {
              return json({ error: "Invalid " + key }, 400);
            }
          }
          const limits = { trades: 500, scannedMints: 1000, deferredMints: 1000, lastScanReport: 20 };
          for (const [key, limit] of Object.entries(limits)) {
            if (body[key] !== undefined && (!Array.isArray(body[key]) || body[key].length > limit)) {
              return json({ error: "Invalid or oversized " + key }, 400);
            }
          }
          if (body.balance !== undefined && (typeof body.balance !== "number" || !Number.isFinite(body.balance) || body.balance < 0)) {
            return json({ error: "Invalid balance" }, 400);
          }
          for (const key of ["autoEnabled", "paused"]) {
            if (body[key] !== undefined && typeof body[key] !== "boolean") {
              return json({ error: "Invalid " + key }, 400);
            }
          }
          const stored = await readStoredState(env);
          const currentRevision = stored && Number.isSafeInteger(stored[STATE_VERSION]) ? stored[STATE_VERSION] : 0;
          if (expectedRevision !== currentRevision) {
            return json({ error: "State changed; reload and retry" }, 409);
          }
          const patch = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "expectedRevision"));
          if (!stored) {
            const initial = cleanState({ ...DEFAULT_STATE, ...patch, updatedAt: new Date().toISOString() });
            const result = await coordinatorRequest(env, "import", initial);
            return json({ ok: true, state: result.state || initial, revision: result.version, canMigrateLegacy: false });
          }
          const state = cleanState({ ...stored, ...patch, lastScanReport: patch.lastScanReport ?? stored.lastScanReport });
          Object.defineProperty(state, STATE_VERSION, { value: currentRevision, writable: true });
          const result = await saveState(env, state);
          return json({ ok: true, state, revision: result.version, canMigrateLegacy: false });
        } catch (error) {
          return json({ error: error.status === 409 ? "State changed; reload and retry" : "Invalid state" }, error.status || 400);
        }
      }
      if (url.pathname === "/api/automation" && request.method === "POST") {
        try {
          const body = await request.json();
          const patch = {};
          if (typeof body.enabled === "boolean") patch.autoEnabled = body.enabled;
          if (typeof body.paused === "boolean") patch.paused = body.paused;
          if (!Object.keys(patch).length) return json({ error: "Invalid settings" }, 400);
          const result = await patchPaperState(env, patch);
          return json({ ok: true, state: result.state, revision: result.version });
        } catch (error) {
          return json({ error: "Invalid settings" }, error.status || 400);
        }
      }
      return json({ error: "Not found" }, 404);
    }
    const assetUrl = new URL(request.url);
    const isDashboardHtml = assetUrl.pathname === "/" || assetUrl.pathname === "/index.html";
    if (assetUrl.pathname === "/") assetUrl.pathname = "/index.html";

    // Fetch the dashboard as a clean GET and rebuild its HTML response.
    // This avoids forwarding browser navigation headers or stale encoding/length
    // metadata from the incoming request to the static-assets binding.
    if (!isDashboardHtml) return json({ error: "Not found" }, 404);
    const assetRequest = new Request(assetUrl, { method: "GET" });
    const assetResponse = await env.ASSETS.fetch(assetRequest);
    if (isDashboardHtml && assetResponse.ok) {
      const html = await assetResponse.text();
      return new Response(html, {
        status: assetResponse.status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "Pragma": "no-cache",
          "X-Solana-Smart-Bot-Build": buildId
        }
      });
    }

    const assetHeaders = new Headers(assetResponse.headers);
    assetHeaders.set("X-Solana-Smart-Bot-Build", buildId);
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers: assetHeaders
    });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const startedAt = Date.now();
      rpcDiagnostics = { successes: [], errors: [] };
      // Do not let a scheduled cycle create a timestamped default state.
      // The dashboard uses the absence of initialized server state to detect
      // whether legacy browser paper-trading data still needs migration.
      const state = await readStoredState(env);
      if (!state) {
        console.info("Server cycle skipped: paper-trading state is not initialized.");
        return;
      }
      let sold = 0;
      let refreshWarning = "";
      let buyMessage = "";
      let buyWarning = "";

      // A temporary price-refresh failure must not prevent discovery and paper buys.
      try {
        sold = await refreshTrades(state, env);
      } catch (error) {
        refreshWarning = String(error?.message || error);
        console.error("Trade refresh warning", {
          error: refreshWarning,
          durationMs: Date.now() - startedAt
        });
      }

      // Run discovery independently so one subsystem cannot silently block the other.
      try {
        buyMessage = await autoBuy(state, env);
      } catch (error) {
        buyWarning = String(error?.message || error);
        console.error("Auto-buy warning", {
          error: buyWarning,
          durationMs: Date.now() - startedAt
        });
      }

      state.lastRunAt = new Date().toISOString();
      const warnings = [
        refreshWarning ? "Price refresh warning: " + refreshWarning : "",
        buyWarning ? "Auto-buy warning: " + buyWarning : ""
      ].filter(Boolean);
      const rpcSummary = rpcDiagnostics.successes.length
        ? " RPC responded: " + [...new Set(rpcDiagnostics.successes)].join(", ") + "."
        : " No successful RPC response was confirmed in this cycle.";
      const rpcErrors = rpcDiagnostics.errors.length
        ? " RPC errors: " + [...new Set(rpcDiagnostics.errors)].join(" | ") + "."
        : "";
      state.lastMessage = (warnings.length
        ? "Server cycle completed with warning. Sold: " + sold + ". " +
          (buyMessage || "Auto-buy not completed.") + " " + warnings.join(" | ")
        : "Server cycle complete. Sold: " + sold + ". " + buyMessage) + rpcSummary + rpcErrors;
      try {
        await saveState(env, state);
      } catch (error) {
        if (error?.status === 409) {
          console.warn("Server cycle discarded: paper state changed while this cycle was running.", {
            durationMs: Date.now() - startedAt
          });
          return;
        }
        throw error;
      }

      // Safe operational log: never include secrets, wallet data, or API keys.
      console.info("Server cycle finished", {
        sold,
        message: buyMessage,
        warnings,
        rpcResponded: [...new Set(rpcDiagnostics.successes)],
        rpcErrors: [...new Set(rpcDiagnostics.errors)],
        openTrades: state.trades.filter(t => !t.sold).length,
        scannedMints: state.scannedMints.length,
        durationMs: Date.now() - startedAt
      });
    })());
  }
};
