import { parseRpcResponse, parseRpcBatchResponse, readBoundedJsonResponse } from "./rpc-response.mjs";
import { fetchCompleteMintTokenAccounts, parseMintAccount } from "./trusted-live-evidence.mjs";
const SESSION_MS = 12 * 60 * 60 * 1000;
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
const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.magicblock.app/mainnet"
];
let rpcCursor = 0;
let alchemyUnauthorized = false;

export function isShareAbovePercent(amount, supply, thresholdPercent) {
  if (typeof amount !== "bigint" || typeof supply !== "bigint" ||
      typeof thresholdPercent !== "bigint" || amount < 0n || supply <= 0n || thresholdPercent < 0n) {
    throw new TypeError("Share comparison requires non-negative BigInt amounts and a positive supply");
  }
  return amount * 100n > supply * thresholdPercent;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      ...extraHeaders
    }
  });
}

async function readBoundedJson(request, maxBytes = 8192) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Request body required");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Request body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON object required");
  }
  return value;
}
function cleanState(value) {
  const s = value && typeof value === "object" ? value : {};
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const cleanTrades = Array.isArray(s.trades) ? s.trades.slice(-500).flatMap(trade => {
    if (!trade || typeof trade !== "object" || Array.isArray(trade) ||
        typeof trade.mint !== "string" || !trade.mint.trim() || trade.mint.length > 64) return [];
    const amount = finite(trade.amount);
    const buyPrice = finite(trade.buyPrice);
    const tokens = finite(trade.tokens);
    if (amount <= 0 || buyPrice <= 0 || tokens <= 0) return [];
    return [{
      mint: trade.mint.trim(),
      amount,
      buyPrice,
      currentPrice: finite(trade.currentPrice) || buyPrice,
      tokens,
      sold: trade.sold === true,
      sellPrice: finite(trade.sellPrice),
      saleValue: finite(trade.saleValue),
      boughtAt: typeof trade.boughtAt === "string" ? trade.boughtAt.slice(0, 64) : null,
      soldAt: typeof trade.soldAt === "string" ? trade.soldAt.slice(0, 64) : null
    }];
  }) : [];
  return {
    balance: Number.isFinite(Number(s.balance)) && Number(s.balance) >= 0 ? Number(s.balance) : DEFAULT_STATE.balance,
    trades: cleanTrades,
    autoEnabled: s.autoEnabled === true,
    paused: s.paused === true,
    scannedMints: Array.isArray(s.scannedMints) ? s.scannedMints.filter(mint => typeof mint === "string" && mint.length <= 64).slice(-1000) : [],
    deferredMints: Array.isArray(s.deferredMints) ? s.deferredMints.slice(-1000).flatMap(item =>
      item && typeof item === "object" && !Array.isArray(item) &&
      typeof item.mint === "string" && item.mint.length <= 64 && Number.isFinite(Number(item.retryAt))
        ? [{ mint: item.mint, retryAt: Number(item.retryAt) }] : []) : [],
    lastRunAt: typeof s.lastRunAt === "string" ? s.lastRunAt.slice(0, 64) : null,
    lastMessage: typeof s.lastMessage === "string" ? s.lastMessage.slice(0, 2000) : DEFAULT_STATE.lastMessage,
    lastScanReport: Array.isArray(s.lastScanReport) ? s.lastScanReport.slice(-20).flatMap(item =>
      item && typeof item === "object" && !Array.isArray(item)
        ? [{ mint: typeof item.mint === "string" ? item.mint.slice(0, 64) : "",
             status: typeof item.status === "string" ? item.status.slice(0, 40) : "",
             reasons: Array.isArray(item.reasons) ? item.reasons.filter(reason => typeof reason === "string").slice(0, 10).map(reason => reason.slice(0, 300)) : [] }]
        : []) : [],
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt.slice(0, 64) : null
  };
}
function validateMigrationFields(body) {
  if (body.balance !== undefined &&
      (typeof body.balance !== "number" || !Number.isFinite(body.balance) || body.balance < 0)) {
    throw new Error("Invalid migration balance");
  }
  if (body.trades !== undefined) {
    if (!Array.isArray(body.trades) || body.trades.length > 500) {
      throw new Error("Invalid migration trades");
    }
    for (const trade of body.trades) {
      if (!trade || typeof trade !== "object" || Array.isArray(trade) ||
          typeof trade.mint !== "string" || !trade.mint.trim() || trade.mint.length > 64) {
        throw new Error("Malformed migration trade");
      }
      const amount = trade.amount;
      const buyPrice = trade.buyPrice;
      const tokens = trade.tokens;
      const currentPrice = trade.currentPrice === undefined ? buyPrice : trade.currentPrice;
      const sellPrice = trade.sellPrice === undefined ? 0 : trade.sellPrice;
      const saleValue = trade.saleValue === undefined ? 0 : trade.saleValue;
      if (![amount, buyPrice, tokens, currentPrice, sellPrice, saleValue].every(
        value => typeof value === "number" && Number.isFinite(value)
      ) || amount <= 0 || buyPrice <= 0 || tokens <= 0 ||
          currentPrice < 0 || sellPrice < 0 || saleValue < 0 ||
          (trade.sold !== undefined && typeof trade.sold !== "boolean")) {
        throw new Error("Invalid migration trade values");
      }
    }
  }
  for (const field of ["autoEnabled", "paused"]) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") {
      throw new Error("Invalid migration automation setting");
    }
  }
  if (body.scannedMints !== undefined &&
      (!Array.isArray(body.scannedMints) || body.scannedMints.length > 1000 ||
       body.scannedMints.some(mint => typeof mint !== "string" || !mint.trim() || mint.length > 64))) {
    throw new Error("Invalid migration scanned mints");
  }
}
async function paperStateCall(env, body) {
  const namespace = env.PAPER_TRADING_STATE;
  if (!namespace) throw new Error("PaperTradingState binding is not configured");
  const stub = namespace.get(namespace.idFromName("paper-trading"));
  const response = await stub.fetch("https://paper-trading.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "Paper trading state request failed");
    error.status = response.status;
    throw error;
  }
  return result;
}
async function readState(env) {
  const result = await paperStateCall(env, { operation: "get" });
  const state = cleanState(result.state);
  Object.defineProperty(state, "__revision", { value: result.revision, writable: true, configurable: true });
  Object.defineProperty(state, "__migrationOpen", { value: result.migrationOpen === true, configurable: true });
  return state;
}
async function saveState(env, state) {
  const result = await paperStateCall(env, {
    operation: "compare-and-set",
    expectedRevision: state.__revision,
    state
  });
  state.updatedAt = result.state.updatedAt;
  state.__revision = result.revision;
}
function constantTimeTextEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

async function authorized(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  const token = match ? match[1] : "";
  // Session identifiers are minted with crypto.randomUUID(); require the
  // exact Bearer scheme and reject malformed or oversized values before KV.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    return false;
  }
  const session = await env.BOT_STATE.get("session:" + token, "json");
  if (!session || session.expiresAt <= Date.now()) return false;
  // Compare the session's issuance version with the AuthGuard's current version.
  // Enabling MFA increments the version and invalidates every pre-MFA session.
  let profile;
  try {
    profile = await authGuardCall(env, { operation: "get-profile" });
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(profile.sessionVersion) || profile.sessionVersion < 0) return false;
  const sessionVersion = session.sessionVersion === undefined ? 0 : session.sessionVersion;
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return false;
  return sessionVersion === profile.sessionVersion;
}
function sameOriginApiRequest(request, url) {
  if (!url.pathname.startsWith("/api/") ||
      !["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== url.origin) return false;
    } catch {
      return false;
    }
  } else if (request.headers.get("Sec-Fetch-Site") !== "same-origin") {
    // Mutating browser requests must provide at least one same-origin signal.
    // Reject requests where both Origin and Fetch Metadata are absent.
    return false;
  }
  return request.headers.get("Sec-Fetch-Site") !== "cross-site";
}
async function rpc(method, params, env, diagnostics = null) {
  const errors = [];
  // Try the existing Alchemy key first, then fall back to a public Solana RPC.
  // Never expose the API key in logs or error messages.
  const endpoints = [];
  const alchemyConfig = String(env?.ALCHEMY_API_KEY || "").trim();
  if (alchemyConfig && !alchemyUnauthorized) {
    // Accept either the raw Alchemy API key or the complete HTTPS endpoint.
    // This avoids accidental 401s caused by storing the endpoint URL as a key.
    const alchemyUrl = /^https:\/\//i.test(alchemyConfig)
      ? alchemyConfig.replace(/\/+$/, "")
      : "https://solana-mainnet.g.alchemy.com/v2/" + alchemyConfig;
    let validAlchemyUrl = false;
    try {
      const parsed = new URL(alchemyUrl);
      validAlchemyUrl = parsed.protocol === "https:" &&
        parsed.hostname === "solana-mainnet.g.alchemy.com" &&
        parsed.pathname.startsWith("/v2/");
    } catch {}
    if (validAlchemyUrl) {
      endpoints.push({ url: alchemyUrl, label: "Alchemy Solana RPC" });
    } else {
      errors.push("Alchemy configuration invalid: use the Solana Mainnet API key or its HTTPS endpoint");
    }
  }
  // Try every configured public fallback, not just the first one. Rotate the
  // starting provider between calls to avoid repeatedly favoring one endpoint.
  for (let i = 0; i < RPCS.length; i++) {
    const fallback = RPCS[rpcCursor++ % RPCS.length];
    endpoints.push({ url: fallback, label: new URL(fallback).hostname });
  }

  // Each provider has a bounded timeout; continue to the next provider on failure.
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(7000)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await readBoundedJsonResponse(response);
      const result = parseRpcResponse(data, 1);
      if (diagnostics) diagnostics.successes.push(endpoint.label);
      return result;
    } catch (error) {
      const message = String(error?.message || error);
      if (endpoint.label === "Alchemy Solana RPC" && message === "HTTP 401") {
        alchemyUnauthorized = true;
      }
      errors.push(endpoint.label + ": " + message);
      if (diagnostics) diagnostics.errors.push(endpoint.label + ": " + message);
    }
  }
  throw new Error("Solana RPC providers failed — " + errors.join(" | "));
}

async function rpcBatch(calls, env, diagnostics = null) {
  const errors = [];
  const endpoints = [];
  const config = String(env?.ALCHEMY_API_KEY || "").trim();
  if (config && !alchemyUnauthorized) {
    const url = /^https:\/\//i.test(config)
      ? config.replace(/\/+$/, "")
      : "https://solana-mainnet.g.alchemy.com/v2/" + config;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && parsed.hostname === "solana-mainnet.g.alchemy.com" && parsed.pathname.startsWith("/v2/")) {
        endpoints.push({ url, label: "Alchemy Solana RPC" });
      }
    } catch {}
  }
  // Always make all public providers available as fallbacks, even when
  // Alchemy is configured or returns HTTP 401/403.
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[rpcCursor++ % RPCS.length];
    endpoints.push({ url, label: new URL(url).hostname });
  }
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(calls.map((call, index) => ({
          jsonrpc: "2.0", id: index + 1, method: call.method, params: call.params
        }))),
        signal: AbortSignal.timeout(7000)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await readBoundedJsonResponse(response);
      const results = parseRpcBatchResponse(data, calls.length);
      if (diagnostics) diagnostics.successes.push(endpoint.label);
      return results;
    } catch (error) {
      const message = String(error?.message || error);
      if (endpoint.label === "Alchemy Solana RPC" && message === "HTTP 401") alchemyUnauthorized = true;
      errors.push(endpoint.label + ": " + message);
      if (diagnostics) diagnostics.errors.push(endpoint.label + ": " + message);
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
    if (response.ok) return readBoundedJsonResponse(response);
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
  const data = await readBoundedJsonResponse(response);
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

async function inspectMint(mint, env, diagnostics = null) {
  // The exact requested mint must be the base token in the selected Solana pair.
  const dex = await getDexJson(
    "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(mint), env, 90
  );
  const market = (dex.pairs || []).filter(p =>
    p.chainId === "solana" && p.baseToken?.address === mint
  ).sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  if (!market) throw new Error("No verified Solana market pair for the requested mint");

  // Parse the mint only after confirming its account owner is an official SPL
  // Token or Token-2022 program. Use a complete Alchemy holder census and
  // reconcile every positive-balance token account against finalized supply.
  const [rug, rpcResults, holderAccounts] = await Promise.all([
    getJson("https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(mint) + "/report"),
    rpcBatch([
      { method: "getAccountInfo", params: [mint, { encoding: "jsonParsed", commitment: "finalized" }] },
      { method: "getTokenSupply", params: [mint, { commitment: "finalized" }] }
    ], env, diagnostics),
    fetchCompleteMintTokenAccounts(mint, fetch, env.ALCHEMY_API_KEY)
  ]);
  const [account, supply] = rpcResults;
  const details = parseMintAccount(account);
  const rawSupply = String(supply?.value?.amount ?? "");
  if (!/^[0-9]+$/.test(rawSupply) || BigInt(rawSupply) <= 0n ||
      !Array.isArray(holderAccounts) || holderAccounts.length === 0) {
    throw new Error("Complete holder data or finalized token supply is unavailable");
  }
  const supplyAmount = BigInt(rawSupply);
  const ownerBalances = new Map();
  let totalAccountBalance = 0n;
  for (const holder of holderAccounts) {
    if (!holder || typeof holder.owner !== "string" || typeof holder.amount !== "bigint" || holder.amount <= 0n) {
      throw new Error("Complete holder census contains invalid account data");
    }
    ownerBalances.set(holder.owner, (ownerBalances.get(holder.owner) || 0n) + holder.amount);
    totalAccountBalance += holder.amount;
  }
  if (ownerBalances.size === 0 || totalAccountBalance !== supplyAmount) {
    throw new Error("Complete holder census does not reconcile to finalized token supply");
  }
  const rankedOwners = [...ownerBalances.entries()].sort((a, b) => a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0);
  const sortedOwnerBalances = rankedOwners.map(([, amount]) => amount);
  const percentOfSupply = amount => Number((amount * 1000000n) / supplyAmount) / 10000;
  const holders = rankedOwners.slice(0, 10).map(([owner, amount]) => ({
    owner, amount: amount.toString(), pct: percentOfSupply(amount)
  }));
  const largestAmount = sortedOwnerBalances[0];
  const topTenAmount = sortedOwnerBalances.slice(0, 10).reduce((sum, amount) => sum + amount, 0n);
  const largestPct = percentOfSupply(largestAmount);
  const topTenPct = percentOfSupply(topTenAmount);
  // Display percentages are rounded down; make safety decisions against exact
  // integer balances so a value just above a threshold cannot slip through.
  const largestAbove30 = isShareAbovePercent(largestAmount, supplyAmount, 30n);
  const topTenAbove50 = isShareAbovePercent(topTenAmount, supplyAmount, 50n);
  const liquidity = Number(market.liquidity?.usd);
  const volume = Number(market.volume?.h24);
  const sells = Number(market.txns?.h24?.sells);
  const reasons = [];
  if (!Number.isFinite(liquidity) || liquidity < 10000) reasons.push("Liquidity unavailable or below $10,000");
  if (!Number.isFinite(volume) || volume < 1000) reasons.push("24h volume unavailable or below $1,000");
  if (!Number.isFinite(sells) || sells <= 0) reasons.push("24h sell-count data unavailable or no sells");
  if (details.mintAuthoritySafe !== true || details.freezeAuthoritySafe !== true) {
    reasons.push("Mint/Freeze authority not confirmed inactive");
  }
  if (details.token2022ExtensionsSafe !== true) {
    reasons.push("Unsupported token program or Token-2022 extension detected");
  }
  if (largestAbove30) reasons.push("Largest wallet holder above 30%");
  if (topTenAbove50) reasons.push("Top 10 wallet holders above 50%");
  if (!rug || rug.score == null || !Number.isFinite(Number(rug.score)) || Number(rug.score) > 2500) {
    reasons.push("RugCheck unavailable or score above 2500");
  }
  const price = Number(market.priceUsd);
  if (!Number.isFinite(price) || price <= 0) reasons.push("Price unavailable");
  return {
    ok: reasons.length === 0, reasons, price, market, rugScore: Number(rug?.score),
    largestPct, topTenPct, largestAbove30, topTenAbove50, holderAccountCount: holderAccounts.length,
    holderOwnerCount: ownerBalances.size, holderSampleOnly: false,
    holderCensusComplete: true, holders
  };
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
async function autoBuy(state, env, diagnostics = null) {
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
      const result = await inspectMint(mint, env, diagnostics);
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
      if (message.startsWith("No verified Solana market pair")) {
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
async function matchingTotpCounter(secret, code, time = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ""))) return null;
  for (const drift of [0, -30000, 30000]) {
    const counter = Math.floor((time + drift) / 30000);
    if (await totpCode(secret, (counter * 30000) + 1) === String(code)) return counter;
  }
  return null;
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
async function authGuardCall(env, body) {
  const namespace = env.AUTH_GUARD;
  const token = String(env.AUTH_GUARD_INTERNAL_TOKEN || "");
  if (!namespace || token.length < 32) throw new Error("Authentication guard is not configured");
  const id = namespace.idFromName("admin");
  const stub = namespace.get(id);
  const response = await stub.fetch("https://auth-guard.internal/", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  let result;
  try { result = await response.json(); } catch { throw new Error("Authentication guard response invalid"); }
  if (!response.ok) throw new Error("Authentication guard request failed");
  return result;
}
async function clearLegacyMfaProfile(env) {
  const legacy = await readProfile(env);
  let changed = false;
  for (const field of ["totpSecret", "pendingTotpSecret", "pendingTotpAt", "backupHash", "lastTotpCounter"]) {
    if (Object.prototype.hasOwnProperty.call(legacy, field)) {
      delete legacy[field];
      changed = true;
    }
  }
  if (changed) await env.BOT_STATE.put("admin_profile", JSON.stringify(legacy));
}
async function ensureAuthGuard(env) {
  const current = await authGuardCall(env, { operation: "get-profile" });
  const migrationMarker = await env.BOT_STATE.get("auth_guard_migration_v1");
  if (migrationMarker === "complete" && !current.initialized) {
    throw new Error("AuthGuard state is missing after migration; refusing to re-import stale MFA data");
  }
  if (current.initialized && migrationMarker === "complete") {
    await clearLegacyMfaProfile(env);
    return current;
  }

  const legacy = await readProfile(env);
  const legacyCounter = legacy.lastTotpCounter == null ? -1 : legacy.lastTotpCounter;
  if (!Number.isSafeInteger(legacyCounter) || legacyCounter < -1) {
    throw new Error("Legacy TOTP counter is invalid; refusing unsafe migration");
  }
  const legacyProfile = {
    backupHash: legacy.backupHash || null,
    lastTotpCounter: legacyCounter,
    totpEnabled: legacy.totpEnabled === true,
    totpSecret: legacy.totpSecret || null,
    pendingTotpSecret: legacy.pendingTotpSecret || null,
    pendingTotpAt: Number.isSafeInteger(legacy.pendingTotpAt) ? legacy.pendingTotpAt : null
  };
  if (!current.initialized) {
    await authGuardCall(env, { operation: "initialize-legacy", ...legacyProfile });
  }
  const verification = await authGuardCall(env, { operation: "verify-legacy", ...legacyProfile });
  if (verification.verified !== true) {
    throw new Error("AuthGuard legacy migration verification failed; preserving legacy MFA data");
  }
  // Persist the completion marker before deleting the legacy copy. If cleanup
  // fails, the next request can safely retry cleanup without re-importing data.
  await env.BOT_STATE.put("auth_guard_migration_v1", "complete");
  await clearLegacyMfaProfile(env);
  return await authGuardCall(env, { operation: "get-profile" });
}
async function migrateLegacyFailure(env, scope, legacyKey) {
  const legacy = await env.BOT_STATE.get(legacyKey, "json");
  const count = Math.min(5, Math.max(0, Math.floor(Number(legacy?.count || 0))));
  if (count > 0) {
    await authGuardCall(env, { operation: "import-legacy-failure", scope, count });
    await env.BOT_STATE.delete(legacyKey);
  }
}
async function consumeApiRateLimit(env, scope, limit, windowMs) {
  return authGuardCall(env, {
    operation: "consume-rate-limit",
    scope,
    limit,
    windowMs
  });
}
async function isAuthRateLimited(env, scope) {
  const result = await authGuardCall(env, { operation: "is-rate-limited", scope });
  return result.limited === true;
}
async function recordAuthFailure(env, scope) {
  return authGuardCall(env, { operation: "record-failure", scope });
}
async function authFailureScope(prefix, ip) {
  return prefix + ":" + await hashText(ip);
}
async function clearAuthFailures(env, scope) {
  return authGuardCall(env, { operation: "clear-failures", scope });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Report the actual Cloudflare Worker version instead of a manually
    // maintained commit marker that can silently become stale.
    const build = env.CF_VERSION_METADATA?.tag || env.CF_VERSION_METADATA?.id || "unavailable";
    if (!sameOriginApiRequest(request, url)) {
      return json({ error: "Cross-origin API request rejected" }, 403);
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, mode: "paper-trading", scheduler: "Cloudflare Cron", storage: "Workers KV + Durable Objects", build });
    }
    if (url.pathname === "/version" && request.method === "GET") {
      return json({ ok: true, build, frontend: "premium-dashboard-v2", asset: "index.html" });
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const { password } = await readBoundedJson(request, 4096);
        const expected = env.BOT_LOGIN_PASSWORD;
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const loginScope = await authFailureScope("login", ip);
        const profile = await ensureAuthGuard(env);
        await migrateLegacyFailure(env, loginScope, "login_fail:" + ip);
        if (await isAuthRateLimited(env, loginScope)) {
          return json({ error: "زۆر هەوڵی چوونەژوورەوە دراوە؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
        }
        if (!expected || typeof password !== "string" || !constantTimeTextEqual(password, expected)) {
          const failure = await recordAuthFailure(env, loginScope);
          if (failure.limited) return json({ error: "زۆر هەوڵی چوونەژوورەوە دراوە؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
          return json({ error: "وشەی نهێنی هەڵەیە" }, 401);
        }
        await clearAuthFailures(env, loginScope);
        if (profile.totpEnabled && profile.totpSecret) {
          const challengeId = crypto.randomUUID();
          const challenge = await authGuardCall(env, { operation: "create-challenge", challengeId });
          if (!challenge.created) return json({ error: "نەتوانرا داواکاریی پشتڕاستکردنەوە دروست بکرێت" }, 503);
          return json({ ok: true, mfaRequired: true, challengeId });
        }
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + SESSION_MS;
        await env.BOT_STATE.put("session:" + token, JSON.stringify({
          expiresAt, sessionVersion: Number.isSafeInteger(profile.sessionVersion) ? profile.sessionVersion : 0
        }), { expirationTtl: Math.ceil(SESSION_MS / 1000) });
        return json({ ok: true, token });
      } catch { return json({ error: "خزمەتگوزاری چوونەژوورەوە ئامادە نییە" }, 503); }
    }
    if (url.pathname === "/api/login/totp" && request.method === "POST") {
      try {
        const { challengeId, code } = await readBoundedJson(request, 4096);
        if (typeof challengeId !== "string" || typeof code !== "string") return json({ error: "کۆدی پشتڕاستکردنەوە نادروستە" }, 400);
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const failureScope = await authFailureScope("totp", ip);
        await migrateLegacyFailure(env, failureScope, "totp_fail:" + ip);
        if (await isAuthRateLimited(env, failureScope)) {
          return json({ error: "زۆر هەوڵی کۆدی Authenticator دراوە؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
        }
        const profile = await ensureAuthGuard(env);
        const matchedCounter = profile.totpEnabled && profile.totpSecret
          ? await matchingTotpCounter(profile.totpSecret, code) : null;
        const submittedHash = await hashText(String(code).trim().toUpperCase());
        const result = await authGuardCall(env, {
          operation: "complete-challenge",
          challengeId,
          totpCounter: matchedCounter,
          backupHash: submittedHash,
          failureScope
        });
        if (!result.ok) {
          const status = result.reason === "rate-limited" || result.reason === "attempts-exhausted" ? 429 : 401;
          return json({ error: status === 429 ? "هەوڵەکان سنووردار کراون؛ دواتر هەوڵ بدە." : "کۆدی Authenticator هەڵەیە یان کاتی داواکاری تەواو بوو." }, status);
        }
        const currentProfile = await ensureAuthGuard(env);
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + SESSION_MS;
        await env.BOT_STATE.put("session:" + token, JSON.stringify({
          expiresAt, sessionVersion: Number.isSafeInteger(currentProfile.sessionVersion) ? currentProfile.sessionVersion : 0
        }), { expirationTtl: Math.ceil(SESSION_MS / 1000) });
        return json({ ok: true, token });
      } catch { return json({ error: "نەتوانرا کۆدی پشتڕاستکردنەوە بپشکنرێت" }, 503); }
    }
    if (url.pathname.startsWith("/api/")) {
      if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);
      if (url.pathname === "/api/logout" && request.method === "POST") {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Unauthorized" }, 401);
        await env.BOT_STATE.delete("session:" + token);
        return json({ ok: true, message: "Session revoked" });
      }
      if (url.pathname === "/api/profile" && request.method === "GET") {
        const p = await readProfile(env);
        const auth = await ensureAuthGuard(env);
        return json({ email: p.email || "", phone: p.phone || "", emailVerified: !!p.emailVerified, phoneVerified: !!p.phoneVerified, totpEnabled: !!auth.totpEnabled });
      }
      if (url.pathname === "/api/profile" && request.method === "PUT") {
        try {
          const body = await readBoundedJson(request, 4096);
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
          await env.BOT_STATE.put("admin_profile", JSON.stringify(p));
          const auth = await ensureAuthGuard(env);
          return json({ ok: true, email: p.email, phone: p.phone, emailVerified: !!p.emailVerified, phoneVerified: !!p.phoneVerified, totpEnabled: !!auth.totpEnabled, message: "زانیاری پڕۆفایل پاشەکەوت کرا؛ ئیمەیڵ و مۆبایل هێشتا پشتڕاست نەکراونەتەوە." });
        } catch { return json({ error: "زانیاری پڕۆفایل نادروستە" }, 400); }
      }
      if (url.pathname === "/api/totp/setup" && request.method === "POST") {
        let reauth;
        try { reauth = await readBoundedJson(request, 4096); }
        catch { return json({ error: "پشتڕاستکردنەوەی وشەی نهێنی پێویستە" }, 400); }
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const setupScope = await authFailureScope("totp-setup", ip);
        if (await isAuthRateLimited(env, setupScope)) {
          return json({ error: "زۆر هەوڵی پشتڕاستکردنەوەی وشەی نهێنی دراوە؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
        }
        const expectedPassword = env.BOT_LOGIN_PASSWORD;
        if (typeof reauth.password !== "string" || typeof expectedPassword !== "string" ||
            !constantTimeTextEqual(reauth.password, expectedPassword)) {
          const failure = await recordAuthFailure(env, setupScope);
          if (failure.limited) return json({ error: "زۆر هەوڵی پشتڕاستکردنەوەی وشەی نهێنی دراوە؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
          return json({ error: "وشەی نهێنی نادروستە؛ چالاککردنی Authenticator ڕەتکرایەوە" }, 401);
        }
        await clearAuthFailures(env, setupScope);
        const auth = await ensureAuthGuard(env);
        if (auth.totpEnabled) return json({ error: "Google Authenticator پێشتر چالاک کراوە" }, 409);
        const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
        const result = await authGuardCall(env, { operation: "begin-totp-setup", secret });
        if (!result.ok) return json({ error: "Google Authenticator پێشتر چالاک کراوە" }, 409);
        const label = encodeURIComponent("Solana Smart Bot Admin");
        const issuer = encodeURIComponent("Solana Smart Bot");
        const uri = "otpauth://totp/" + label + "?secret=" + secret + "&issuer=" + issuer + "&algorithm=SHA1&digits=6&period=30";
        return json({ ok: true, secret, otpauthUri: uri, message: "ئەم کلیلە لە Google Authenticator بە شێوەی دستی زیاد بکە؛ پاشان کۆدی ٦ ژمارەیی بنووسە." });
      }
      if (url.pathname === "/api/totp/confirm" && request.method === "POST") {
        try {
          const ip = request.headers.get("CF-Connecting-IP") || "unknown";
          const failureScope = await authFailureScope("totp", ip);
          await migrateLegacyFailure(env, failureScope, "totp_fail:" + ip);
          if (await isAuthRateLimited(env, failureScope)) {
            return json({ error: "زۆر هەوڵی چالاککردنی Authenticator دراوە؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
          }
          const { code } = await readBoundedJson(request, 4096);
          const auth = await ensureAuthGuard(env);
          if (!auth.pendingTotpSecret || !Number.isSafeInteger(auth.pendingTotpAt) ||
              Date.now() - auth.pendingTotpAt > 600000) {
            return json({ error: "کلیلی کاتی بەسەرچووە؛ setup دووبارە بکە" }, 400);
          }
          const backupCode = crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
          const result = await authGuardCall(env, {
            operation: "confirm-totp-setup",
            code,
            backupHash: await hashText(backupCode),
            failureScope
          });
          if (!result.ok) {
            const status = result.reason === "rate-limited" ? 429 : 401;
            return json({ error: status === 429 ? "زۆر هەوڵی چالاککردنی Authenticator دراوە؛ دواتر هەوڵ بدە." : "کۆدی Authenticator هەڵەیە یان پێشتر بەکارهاتووە" }, status);
          }
          return json({ ok: true, backupCode, message: "Google Authenticator چالاک کرا. کۆدی گەڕاندنەوە تەنها یەکجار پیشان دەدرێت." });
        } catch { return json({ error: "نەتوانرا Authenticator چالاک بکرێت" }, 503); }
      }
      if (url.pathname === "/api/scan" && request.method === "POST") {
        try {
          const authorization = request.headers.get("Authorization") || "";
          const sessionToken = authorization.replace(/^Bearer\s+/i, "");
          const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
          const scanScope = "scan:" + await hashText(sessionToken + ":" + clientIp);
          const rate = await consumeApiRateLimit(env, scanScope, 10, 60000);
          if (!rate.allowed) {
            const retryAfterSeconds = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000));
            return json({
              error: "Scan rate limit reached; wait before requesting another scan.",
              retryAfterSeconds
            }, 429, { "Retry-After": String(retryAfterSeconds) });
          }

          const body = await readBoundedJson(request, 4096);
          const mint = String(body.mint || "");
          if (Object.keys(body).some(key => key !== "mint") ||
              !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
            return json({ error: "Invalid token scan request" }, 400);
          }
          // Full holder census and market checks run server-side. Partial
          // browser/RPC holder samples are never promoted to trusted evidence.
          const inspected = await inspectMint(mint, env);
          return json({ mint, ...inspected });
        } catch (error) {
          return json({ error: String(error?.message || "Trusted token scan failed") }, error.status || 503);
        }
      }
      if (url.pathname === "/api/live/status" && request.method === "GET") {
        try {
          const internalToken = String(env.COORDINATOR_INTERNAL_TOKEN || "");
          if (internalToken.length < 32 || !env.LIVE_TRADE_COORDINATOR) {
            return json({ error: "Live coordinator is not configured" }, 503);
          }
          const id = env.LIVE_TRADE_COORDINATOR.idFromName("live-trade-coordinator");
          const stub = env.LIVE_TRADE_COORDINATOR.get(id);
          const response = await stub.fetch(new Request("https://coordinator.internal/status", {
            headers: { Authorization: "Bearer " + internalToken }
          }));
          const data = await response.json().catch(() => ({}));
          return json(data, response.status);
        } catch {
          return json({ error: "Live coordinator status is unavailable" }, 503);
        }
      }
      if (url.pathname === "/api/live/kill-switch" && request.method === "POST") {
        try {
          const body = await readBoundedJson(request, 4096);
          if (Object.keys(body).length !== 1 || body.enabled !== true) {
            return json({ error: "Emergency stop endpoint only accepts enabled: true" }, 400);
          }
          const internalToken = String(env.COORDINATOR_INTERNAL_TOKEN || "");
          const operatorToken = String(env.COORDINATOR_OPERATOR_TOKEN || "");
          if (internalToken.length < 32 || operatorToken.length < 32 ||
              internalToken === operatorToken || !env.LIVE_TRADE_COORDINATOR) {
            return json({ error: "Live coordinator operator controls are not configured" }, 503);
          }
          const id = env.LIVE_TRADE_COORDINATOR.idFromName("live-trade-coordinator");
          const stub = env.LIVE_TRADE_COORDINATOR.get(id);
          const response = await stub.fetch(new Request("https://coordinator.internal/kill-switch", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + internalToken,
              "X-Operator-Token": operatorToken,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ enabled: true })
          }));
          const data = await response.json().catch(() => ({}));
          return json(data, response.status);
        } catch {
          return json({ error: "Emergency stop activation failed" }, 503);
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
      if (url.pathname === "/api/state" && request.method === "GET") {
        const state = await readState(env);
        return json({ ...state, revision: state.__revision, canMigrateLegacy: state.__migrationOpen });
      }
      if (url.pathname === "/api/state" && request.method === "PUT") {
        try {
          const body = await readBoundedJson(request, 262144);
          const writableFields = new Set(["balance", "trades", "autoEnabled", "paused", "scannedMints", "expectedRevision"]);
          if (Object.keys(body).some(key => !writableFields.has(key)) ||
              !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
            return json({ error: "Unsupported state fields or revision" }, 400);
          }
          let migrationError = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const current = await readState(env);
            if (current.__migrationOpen !== true) {
              return json({ error: "Legacy paper-state migration is no longer available" }, 409);
            }
            if (body.expectedRevision !== current.__revision) {
              return json({ error: "State revision changed; refresh before migrating" }, 409);
            }
            validateMigrationFields(body);
            const migrationFields = { ...body };
            delete migrationFields.expectedRevision;
            const state = { ...current, ...migrationFields };
            try {
              return json(await paperStateCall(env, {
                operation: "migrate-legacy",
                expectedRevision: current.__revision,
                state
              }));
            } catch (error) {
              if (error.status !== 409 || attempt === 1) throw error;
              migrationError = error;
            }
          }
          return json({ error: "Server state changed during migration; retry once more" }, migrationError?.status || 409);
        } catch (error) {
          return json({ error: error.status === 409 ? "State changed; refresh and retry" : "Invalid state" }, error.status || 400);
        }
      }
      if (url.pathname === "/api/paper/buy" && request.method === "POST") {
        try {
          const body = await readBoundedJson(request, 4096);
          const mint = String(body.mint || "");
          if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ||
              !/^[A-Za-z0-9_-]{16,100}$/.test(String(body.requestId || "")) ||
              Object.keys(body).some(key => !["mint", "requestId"].includes(key))) {
            return json({ error: "Invalid paper-buy request" }, 400);
          }
          // Protect expensive RPC, DexScreener and RugCheck inspection before it starts.
          const authorization = request.headers.get("Authorization") || "";
          const sessionToken = authorization.replace(/^Bearer\s+/i, "");
          const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
          const buyScope = "paper-buy:" + await hashText(sessionToken + ":" + clientIp);
          const rate = await consumeApiRateLimit(env, buyScope, 5, 60000);
          if (!rate.allowed) {
            const retryAfterSeconds = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000));
            return json({
              error: "Paper-buy rate limit reached; wait before trying again.",
              retryAfterSeconds
            }, 429, { "Retry-After": String(retryAfterSeconds) });
          }
          const inspected = await inspectMint(mint, env);
          if (!inspected.ok) return json({ error: "Server safety checks blocked this paper buy", reasons: inspected.reasons }, 409);
          const result = await paperStateCall(env, {
            operation: "paper-buy", mint, price: inspected.price, requestId: body.requestId
          });
          return json(result);
        } catch (error) {
          console.error("Paper buy failed", Number.isInteger(error?.status) ? error.status : "internal");
          return json({ error: "Paper buy could not be completed; retry after checking server status." }, error.status || 503);
        }
      }
      if (url.pathname === "/api/paper/clear-history" && request.method === "POST") {
        try {
          const body = await readBoundedJson(request, 4096);
          if (Object.keys(body).some(key => key !== "requestId") ||
              !/^[A-Za-z0-9_-]{16,100}$/.test(String(body.requestId || ""))) {
            return json({ error: "Invalid clear-history request" }, 400);
          }
          return json(await paperStateCall(env, { operation: "clear-history", requestId: body.requestId }));
        } catch (error) {
          return json({ error: "Could not clear paper-trading history" }, error.status || 503);
        }
      }
      if (url.pathname === "/api/automation" && request.method === "POST") {
        try {
          const body = await readBoundedJson(request, 4096);
          const keys = Object.keys(body);
          if (!keys.length || keys.some(key => !["enabled", "paused"].includes(key)) ||
              (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
              (body.paused !== undefined && typeof body.paused !== "boolean")) {
            return json({ error: "Invalid automation settings" }, 400);
          }
          const result = await paperStateCall(env, { operation: "automation", settings: body });
          return json(result);
        } catch (error) { return json({ error: "Invalid settings" }, error.status || 400); }
      }
      return json({ error: "Not found" }, 404);
    }
    const assetUrl = new URL(request.url);
    const isDashboardHtml = assetUrl.pathname === "/" || assetUrl.pathname === "/index.html";
    // The assets directory currently points at the repository root. Never let
    // the static-assets fallback publish source modules, tests, docs, or config.
    // The dashboard is self-contained, so only its two navigation paths are public.
    if (!isDashboardHtml) return json({ error: "Not found" }, 404);
    if (assetUrl.pathname === "/") assetUrl.pathname = "/index.html";

    // Fetch the dashboard as a clean GET and rebuild its HTML response.
    // This avoids forwarding browser navigation headers or stale encoding/length
    // metadata from the incoming request to the static-assets binding.
    const assetRequest = new Request(assetUrl, { method: "GET" });
    const assetResponse = await env.ASSETS.fetch(assetRequest);
    if (isDashboardHtml && assetResponse.ok) {
      const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
      const nonce = btoa(String.fromCharCode(...nonceBytes));
      const sourceHtml = await assetResponse.text();
      // The dashboard uses inline scripts; bind each script to a fresh per-response
      // nonce instead of weakening script-src with unsafe-inline.
      const html = sourceHtml.replace(/<script\b(?![^>]*\bnonce=)([^>]*)>/gi,
        (_match, attributes) => `<script nonce="${nonce}"${attributes}>`);
      return new Response(html, {
        status: assetResponse.status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "Pragma": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "strict-origin-when-cross-origin",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic' 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; connect-src 'self' https://solana.drpc.org https://api.mainnet-beta.solana.com https://solana-rpc.publicnode.com https://api.dexscreener.com https://api.rugcheck.xyz; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:`,
          "X-Solana-Smart-Bot-Build": build
        }
      });
    }

    const assetHeaders = new Headers(assetResponse.headers);
    assetHeaders.set("X-Content-Type-Options", "nosniff");
    assetHeaders.set("X-Frame-Options", "DENY");
    assetHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
    assetHeaders.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    assetHeaders.set("X-Solana-Smart-Bot-Build", build);
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers: assetHeaders
    });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const startedAt = Date.now();
      // A dashboard write can advance the authoritative revision while this
      // cycle is checking market data. Retry once from a fresh snapshot rather
      // than overwriting that newer state or silently dropping the cycle.
      for (let attempt = 0; attempt < 2; attempt++) {
        const rpcDiagnostics = { successes: [], errors: [] };
        const state = await readState(env);
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
          buyMessage = await autoBuy(state, env, rpcDiagnostics);
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
          if (error.status === 409 && attempt === 0) {
            console.warn("Paper state changed during cron cycle; retrying from fresh revision.");
            continue;
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
          durationMs: Date.now() - startedAt,
          revisionRetry: attempt
        });
        return;
      }
    })());
  }
};


// Exported for the isolated Durable Object namespace; no live route invokes it yet.
export { LiveTradeCoordinator } from "./live-trade-coordinator.mjs";

// Exported for the dedicated transactional authentication Durable Object.
export { AuthGuard } from "./auth-guard.mjs";

// Exported for authoritative, transactional paper-trading state.
export { PaperTradingState } from "./paper-trading-state.mjs";
