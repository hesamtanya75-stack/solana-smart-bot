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
const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.magicblock.app/mainnet"
];
let rpcCursor = 0;
let alchemyUnauthorized = false;
let rpcDiagnostics = { successes: [], errors: [] };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
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
async function readState(env) {
  return cleanState(await env.BOT_STATE.get("bot_state", "json"));
}
async function saveState(env, state) {
  state.updatedAt = new Date().toISOString();
  await env.BOT_STATE.put("bot_state", JSON.stringify(state));
}
async function authorized(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const session = await env.BOT_STATE.get("session:" + token, "json");
  return !!session && session.expiresAt > Date.now();
}
async function rpc(method, params, env) {
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
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || "RPC error");
      rpcDiagnostics.successes.push(endpoint.label);
      return data.result;
    } catch (error) {
      const message = String(error?.message || error);
      if (endpoint.label === "Alchemy Solana RPC" && message === "HTTP 401") {
        alchemyUnauthorized = true;
      }
      errors.push(endpoint.label + ": " + message);
      rpcDiagnostics.errors.push(endpoint.label + ": " + message);
    }
  }
  throw new Error("Solana RPC providers failed — " + errors.join(" | "));
}

async function rpcBatch(calls, env) {
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
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("RPC batch response invalid");
      const byId = new Map(data.map(item => [item.id, item]));
      const results = calls.map((_, index) => {
        const item = byId.get(index + 1);
        if (!item || item.error) throw new Error(item?.error?.message || "RPC batch item missing");
        return item.result;
      });
      rpcDiagnostics.successes.push(endpoint.label);
      return results;
    } catch (error) {
      const message = String(error?.message || error);
      if (endpoint.label === "Alchemy Solana RPC" && message === "HTTP 401") alchemyUnauthorized = true;
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
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, mode: "paper-trading", scheduler: "Cloudflare Cron", storage: "Workers KV", build: "59ef112" });
    }
    if (url.pathname === "/version" && request.method === "GET") {
      return json({ ok: true, build: "59ef112", frontend: "premium-dashboard-v2", asset: "index.html" });
    }
    if (url.pathname === "/asset-check" && request.method === "GET") {
      try {
        const assetUrl = new URL("/index.html", request.url);
        const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
        const html = await asset.clone().text();
        return json({ ok: asset.ok, status: asset.status, contentType: asset.headers.get("Content-Type"), bytes: new TextEncoder().encode(html).length, hasDashboardTitle: html.includes("پشکنەری زیرەکی کۆینی سولانا"), hasPremiumDesign: html.includes("SOLANA SMART BOT · FINAL PREMIUM DASHBOARD V2"), hasFinalPurpleGlass: html.includes('id="SB_FINAL_PURPLE_GLASS"'), hasOldClaudeSkin: html.includes("SB_CLAUDE_SKIN"), hasLegacyPremiumSection: html.includes("FINAL PREMIUM DASHBOARD V2"), styleTags: [...html.matchAll(/<style\b[^>]*>/gi)].map(match => match[0]), hasLoginPanel: html.includes("serverLogin") });
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 500);
      }
    }
    if (url.pathname === "/dashboard-test" && request.method === "GET") {
      const assetUrl = new URL("/index.html", request.url);
      const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
      if (!asset.ok) return new Response("Dashboard asset unavailable", { status: 502 });
      let html = await asset.text();
      const probe = `<div id="sb-page-probe" style="position:fixed;z-index:2147483647;left:8px;right:8px;bottom:8px;padding:12px;border:2px solid #27e7d3;border-radius:12px;background:#07152b;color:#fff;font:12px/1.45 system-ui;direction:ltr;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere">DASHBOARD TEST: checking visible elements…</div><script>(function(){var p=document.getElementById("sb-page-probe");function update(extra){try{var m=document.querySelector("main"),h=document.querySelector("header"),l=document.getElementById("serverLogin"),c=l&&l.querySelector(".login-card"),b=document.body;var cs=function(x){if(!x)return "missing";var s=getComputedStyle(x),r=x.getBoundingClientRect();return "display="+s.display+", visibility="+s.visibility+", opacity="+s.opacity+", rect="+Math.round(r.width)+"x"+Math.round(r.height)+", text="+(x.innerText||"").trim().slice(0,70)};var s=getComputedStyle(b);p.textContent="DASHBOARD TEST: HTML loaded\\nBody: "+s.backgroundColor+" / "+s.color+" / "+s.display+"\\nMain: "+cs(m)+"\\nHeader: "+cs(h)+"\\nLogin: "+cs(l)+"\\nLogin card: "+cs(c)+"\\nBody text length: "+(b.innerText||"").length+"\\n"+(extra||"Page scripts had time to run.");}catch(e){p.textContent="PROBE ERROR: "+e.message;}}window.addEventListener("error",function(e){update("JAVASCRIPT ERROR: "+e.message+" @ "+e.lineno+":"+e.colno);});window.addEventListener("unhandledrejection",function(e){update("PROMISE ERROR: "+String(e.reason&&e.reason.message||e.reason));});setTimeout(function(){update();},1800);})();</script>`;
      html = html.replace(/<body[^>]*>/i, match => match + probe);
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" }
      });
    }
    if (url.pathname === "/screen-test" && request.method === "GET") {
      return new Response("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Screen Test</title><style>html,body{margin:0;min-height:100%;background:#10152b;color:#fff;font:18px system-ui}main{margin:24px auto;padding:24px;max-width:520px;border:2px solid #27e7d3;border-radius:18px;background:linear-gradient(135deg,#24104d,#063b43);text-align:center}h1{color:#27e7d3}p{line-height:1.6}</style></head><body><main><h1>SCREEN TEST OK</h1><p>If you can read this, your browser can display a page from this Worker.</p><p>HTTP route: /screen-test</p></main></body></html>", {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      });
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const { password } = await request.json();
        const expected = env.BOT_LOGIN_PASSWORD;
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const loginKey = "login_fail:" + ip;
        const failures = await env.BOT_STATE.get(loginKey, "json") || { count: 0 };
        if (Number(failures.count || 0) >= 5) {
          return json({ error: "زۆر هەوڵی چوونەژوورەوە دراوە؛ ١٥ خولەک چاوەڕێ بکە." }, 429);
        }
        if (!expected || typeof password !== "string" || password !== expected) {
          await env.BOT_STATE.put(loginKey, JSON.stringify({
            count: Number(failures.count || 0) + 1
          }), { expirationTtl: 900 });
          return json({ error: "وشەی نهێنی هەڵەیە" }, 401);
        }
        await env.BOT_STATE.delete(loginKey);
        const profile = await readProfile(env);
        if (profile.totpEnabled && profile.totpSecret) {
          const challengeId = crypto.randomUUID();
          await env.BOT_STATE.put("mfa_challenge:" + challengeId, JSON.stringify({ createdAt: Date.now(), attempts: 0 }), { expirationTtl: 300 });
          return json({ ok: true, mfaRequired: true, challengeId });
        }
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + SESSION_MS;
        await env.BOT_STATE.put("session:" + token, JSON.stringify({ expiresAt }), { expirationTtl: Math.ceil(SESSION_MS / 1000) });
        return json({ ok: true, token });
      } catch { return json({ error: "داواکاری هەڵەیە" }, 400); }
    }
    if (url.pathname === "/api/login/totp" && request.method === "POST") {
      try {
        const { challengeId, code } = await request.json();
        if (typeof challengeId !== "string" || typeof code !== "string") return json({ error: "کۆدی پشتڕاستکردنەوە نادروستە" }, 400);
        const key = "mfa_challenge:" + challengeId;
        const challenge = await env.BOT_STATE.get(key, "json");
        if (!challenge || Date.now() - Number(challenge.createdAt || 0) > 300000) return json({ error: "کاتی چوونەژوورەوە تەواو بوو؛ دووبارە هەوڵ بدە" }, 401);
        if (Number(challenge.attempts || 0) >= 5) { await env.BOT_STATE.delete(key); return json({ error: "هەوڵەکان تەواو بوون؛ دووبارە بچۆ ژوورەوە" }, 429); }
        const profile = await readProfile(env);
        let valid = profile.totpEnabled && profile.totpSecret && await verifyTotp(profile.totpSecret, code);
        if (!valid && profile.backupHash) {
          const submittedHash = await hashText(String(code).trim().toUpperCase());
          if (submittedHash === profile.backupHash) {
            valid = true;
            profile.backupHash = null;
            await env.BOT_STATE.put("admin_profile", JSON.stringify(profile));
          }
        }
        if (!valid) {
          challenge.attempts = Number(challenge.attempts || 0) + 1;
          await env.BOT_STATE.put(key, JSON.stringify(challenge), { expirationTtl: 300 });
          return json({ error: "کۆدی Authenticator هەڵەیە" }, 401);
        }
        await env.BOT_STATE.delete(key);
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + SESSION_MS;
        await env.BOT_STATE.put("session:" + token, JSON.stringify({ expiresAt }), { expirationTtl: Math.ceil(SESSION_MS / 1000) });
        return json({ ok: true, token });
      } catch { return json({ error: "نەتوانرا کۆدی پشتڕاستکردنەوە بپشکنرێت" }, 400); }
    }
    if (url.pathname.startsWith("/api/")) {
      if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);
      if (url.pathname === "/api/logout" && request.method === "POST") {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\\s+/i, "");
        if (token) await env.BOT_STATE.delete("session:" + token);
        return json({ ok: true, message: "Session revoked" });
      }
      if (url.pathname === "/api/profile" && request.method === "GET") {
        const p = await readProfile(env);
        return json({ email: p.email || "", phone: p.phone || "", emailVerified: !!p.emailVerified, phoneVerified: !!p.phoneVerified, totpEnabled: !!p.totpEnabled });
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
          await env.BOT_STATE.put("admin_profile", JSON.stringify(p));
          return json({ ok: true, email: p.email, phone: p.phone, emailVerified: !!p.emailVerified, phoneVerified: !!p.phoneVerified, totpEnabled: !!p.totpEnabled, message: "زانیاری پڕۆفایل پاشەکەوت کرا؛ ئیمەیڵ و مۆبایل هێشتا پشتڕاست نەکراونەتەوە." });
        } catch { return json({ error: "زانیاری پڕۆفایل نادروستە" }, 400); }
      }
      if (url.pathname === "/api/totp/setup" && request.method === "POST") {
        const p = await readProfile(env);
        if (p.totpEnabled) return json({ error: "Google Authenticator پێشتر چالاک کراوە" }, 409);
        const secretBytes = crypto.getRandomValues(new Uint8Array(20));
        const secret = base32Encode(secretBytes);
        p.pendingTotpSecret = secret;
        p.pendingTotpAt = Date.now();
        await env.BOT_STATE.put("admin_profile", JSON.stringify(p));
        const label = encodeURIComponent("Solana Smart Bot Admin");
        const issuer = encodeURIComponent("Solana Smart Bot");
        const uri = "otpauth://totp/" + label + "?secret=" + secret + "&issuer=" + issuer + "&algorithm=SHA1&digits=6&period=30";
        return json({ ok: true, secret, otpauthUri: uri, message: "ئەم کلیلە لە Google Authenticator بە شێوەی دستی زیاد بکە؛ پاشان کۆدی ٦ ژمارەیی بنووسە." });
      }
      if (url.pathname === "/api/totp/confirm" && request.method === "POST") {
        try {
          const { code } = await request.json();
          const p = await readProfile(env);
          if (!p.pendingTotpSecret || Date.now() - Number(p.pendingTotpAt || 0) > 600000) return json({ error: "کلیلی کاتی بەسەرچووە؛ setup دووبارە بکە" }, 400);
          if (!(await verifyTotp(p.pendingTotpSecret, code))) return json({ error: "کۆدی Authenticator هەڵەیە" }, 401);
          const backupCode = crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
          p.totpSecret = p.pendingTotpSecret;
          p.totpEnabled = true;
          p.backupHash = await hashText(backupCode);
          delete p.pendingTotpSecret;
          delete p.pendingTotpAt;
          await env.BOT_STATE.put("admin_profile", JSON.stringify(p));
          return json({ ok: true, backupCode, message: "Google Authenticator چالاک کرا. کۆدی گەڕاندنەوە تەنها یەکجار پیشان دەدرێت." });
        } catch { return json({ error: "نەتوانرا Authenticator چالاک بکرێت" }, 400); }
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
      if (url.pathname === "/api/state" && request.method === "GET") return json(await readState(env));
      if (url.pathname === "/api/state" && request.method === "PUT") {
        try {
          const body = await request.json();
          const current = await readState(env);
          const state = cleanState({ ...current, ...body, lastScanReport: body.lastScanReport ?? current.lastScanReport });
          await saveState(env, state);
          return json({ ok: true, state });
        } catch { return json({ error: "Invalid state" }, 400); }
      }
      if (url.pathname === "/api/automation" && request.method === "POST") {
        try {
          const body = await request.json();
          const state = await readState(env);
          if (typeof body.enabled === "boolean") state.autoEnabled = body.enabled;
          if (typeof body.paused === "boolean") state.paused = body.paused;
          await saveState(env, state);
          return json({ ok: true, state });
        } catch { return json({ error: "Invalid settings" }, 400); }
      }
      return json({ error: "Not found" }, 404);
    }
    const assetUrl = new URL(request.url);
    const isDashboardHtml = assetUrl.pathname === "/" || assetUrl.pathname === "/index.html";
    if (assetUrl.pathname === "/") assetUrl.pathname = "/index.html";

    // Fetch the dashboard as a clean GET and rebuild its HTML response.
    // This avoids forwarding browser navigation headers or stale encoding/length
    // metadata from the incoming request to the static-assets binding.
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
          "X-Solana-Smart-Bot-Build": "59ef112"
        }
      });
    }

    const assetHeaders = new Headers(assetResponse.headers);
    assetHeaders.set("X-Solana-Smart-Bot-Build", "59ef112");
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
      await saveState(env, state);

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
