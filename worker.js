const BUILD_ID = "rugcheck-lp-safety-v2";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STATE = {
  balance: 100,
  trades: [],
  autoEnabled: false,
  paused: false,
  scannedMints: [],
  deferredMints: [],
  pendingMints: [],
  lastRunAt: null,
  lastMessage: "بۆتی سێرڤەر ئامادەیە؛ کڕینی خۆکار ناچالاکە.",
  lastScanReport: [],
  updatedAt: null
};
const RISKY_EXTENSIONS = new Set([6, 9, 12, 14, 26]);
const RPCS = [
  "https://public.rpc.solanavibestation.com",
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com"
];
let rpcNextAt = 0;
let rpcStartIndex = 0;
const rpcCooldowns = new Map();
let alchemyUnauthorized = false;
let rpcDiagnostics = { successes: [], errors: [] };
// Per-isolate DexScreener cache and single-flight requests prevent duplicate calls.
const dexMemoryCache = new Map();
const dexInFlight = new Map();
let dexCooldownUntil = 0;

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
    pendingMints: Array.isArray(s.pendingMints) ? [...new Set(s.pendingMints.filter(m => typeof m === "string"))].slice(0, 20) : [],
    lastScanReport: Array.isArray(s.lastScanReport) ? s.lastScanReport.slice(-20) : [],
    lastScanData: s.lastScanData && typeof s.lastScanData === "object" ? s.lastScanData : null
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
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer ([0-9a-f-]{36})$/i);
  if (!match || !env?.BOT_STATE) return false;
  const token = match[1];
  const session = await env.BOT_STATE.get("session:" + token, "json");
  if (!session || !Number.isFinite(Number(session.expiresAt)) || Number(session.expiresAt) <= Date.now()) {
    if (session) await env.BOT_STATE.delete("session:" + token);
    return false;
  }
  return true;
}
async function rpc(method, params, env) {
  const errors = [];
  const endpoints = [];
  const alchemyConfig = String(env?.ALCHEMY_API_KEY || "").trim();
  if (alchemyConfig && !alchemyUnauthorized) {
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
  for (const fallback of RPCS) {
    endpoints.push({
      url: fallback,
      label: fallback.includes("solanavibestation")
        ? "Solana Vibe Station"
        : new URL(fallback).hostname
    });
  }

  if (!endpoints.length) throw new Error("No Solana RPC providers configured");
  // Round-robin the first provider; skip temporarily blocked providers and
  // continue to the next one without repeatedly hitting the same 403/429 host.
  const startAt = rpcStartIndex % endpoints.length;
  rpcStartIndex = (rpcStartIndex + 1) % endpoints.length;
  const ordered = endpoints.slice(startAt).concat(endpoints.slice(0, startAt));
  let attempted = 0;
  for (const endpoint of ordered) {
    const cooldownUntil = rpcCooldowns.get(endpoint.label) || 0;
    if (cooldownUntil > Date.now()) {
      errors.push(endpoint.label + ": temporarily cooling down (" +
        Math.ceil((cooldownUntil - Date.now()) / 1000) + "s)");
      continue;
    }
    attempted++;
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) {
        const status = response.status;
        let cooldownMs = 0;
        if (status === 401 && endpoint.label === "Alchemy Solana RPC") {
          alchemyUnauthorized = true;
          cooldownMs = 10 * 60 * 1000;
        } else if (status === 403) {
          cooldownMs = 5 * 60 * 1000;
        } else if (status === 429) {
          const retry = Number(response.headers.get("Retry-After") || 0);
          cooldownMs = Math.min(10 * 60 * 1000,
            Math.max(30 * 1000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60 * 1000));
        } else if (status >= 500) {
          cooldownMs = 15 * 1000;
        }
        if (cooldownMs) rpcCooldowns.set(endpoint.label, Date.now() + cooldownMs);
        throw new Error("HTTP " + status);
      }
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || "RPC error");
      rpcCooldowns.delete(endpoint.label);
      rpcDiagnostics.successes.push(endpoint.label);
      return data.result;
    } catch (error) {
      const message = String(error?.message || error);
      if (/timeout|abort/i.test(message)) {
        rpcCooldowns.set(endpoint.label, Date.now() + 10 * 1000);
      }
      errors.push(endpoint.label + ": " + message);
      rpcDiagnostics.errors.push(endpoint.label + ": " + message);
    }
  }
  if (!attempted) {
    throw new Error("هەموو سێرڤەرەکانی RPC کاتی پشوویانە؛ دوای چەند چرکەیەک دووبارە هەوڵ بدە.");
  }
  throw new Error("Solana RPC providers failed — " + errors.join(" | "));
}

async function rpcBatch(calls, env) {
  // Use independent JSON-RPC requests concurrently (not a batch payload).
  // Each call rotates providers independently and fails over on 403/429/timeouts.
  return Promise.all(calls.map(call => rpc(call.method, call.params, env)));
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
  // Reuse fresh results, share in-flight requests, and serve stale data during
  // provider cooldowns rather than multiplying HTTP 429 failures.
  const now = Date.now();
  const cached = dexMemoryCache.get(url) || null;
  if (cached && now - cached.savedAt < ttlSeconds * 1000) return cached.data;
  if (dexCooldownUntil > now) {
    if (cached?.data) return cached.data;
    throw new Error("DexScreener cooldown active; retry in " +
      Math.ceil((dexCooldownUntil - now) / 1000) + "s");
  }
  const inFlight = dexInFlight.get(url);
  if (inFlight) return inFlight;
  const request = (async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (response.status === 429) {
        const retryHeader = response.headers.get("Retry-After");
        const seconds = Number(retryHeader);
        const retryAfterMs = Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000
          : Math.max(0, Date.parse(retryHeader || "") - Date.now());
        const cooldownMs = Math.min(15 * 60 * 1000, Math.max(60 * 1000, retryAfterMs));
        dexCooldownUntil = Date.now() + cooldownMs;
        if (cached?.data) return cached.data;
        throw new Error("api.dexscreener.com HTTP 429; cooldown " + Math.ceil(cooldownMs / 1000) + "s");
      }
      if (!response.ok) throw new Error("api.dexscreener.com HTTP " + response.status);
      const data = await response.json();
      dexMemoryCache.set(url, { savedAt: Date.now(), data });
      while (dexMemoryCache.size > 100) dexMemoryCache.delete(dexMemoryCache.keys().next().value);
      return data;
    } finally {
      dexInFlight.delete(url);
    }
  })();
  dexInFlight.set(url, request);
  return request;
}

let geckoDiscoveryCache = { savedAt: 0, data: null };
let jupiterDiscoveryCache = { savedAt: 0, data: null };
// Short-lived per-isolate cache for Jupiter token market fallback.
const jupiterMarketCache = new Map();
let jupiterNextAt = 0;

async function getLatestSolanaProfiles(env) {
  const errors = [];
  const sources = [];

  // Query independent discovery feeds together. A healthy DexScreener response
  // must not hide newer pools or recent tokens available from other providers.
  const [dexResult, geckoResult, jupiterResult] = await Promise.allSettled([
    (async () => {
      const profiles = await getDexJson(
        "https://api.dexscreener.com/token-profiles/latest/v1", env, 60
      );
      if (!Array.isArray(profiles)) throw new Error("invalid profile response");
      return profiles.filter(item => item?.chainId === "solana" && item?.tokenAddress)
        .map(item => ({
          chainId: "solana",
          tokenAddress: String(item.tokenAddress),
          description: item.description || item.header || item.url || "Solana token",
          url: item.url || null
        }));
    })(),
    (async () => {
      const cached = geckoDiscoveryCache;
      if (cached.data && Date.now() - cached.savedAt < 60 * 1000) return cached.data;
      const response = await fetch(
        "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,quote_token",
        {
          headers: { "Accept": "application/json;version=20230302" },
          signal: AbortSignal.timeout(12000)
        }
      );
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      const included = new Map((payload.included || []).map(item => [item.id, item]));
      const profiles = (payload.data || []).map(pool => {
        const tokenId = pool.relationships?.base_token?.data?.id;
        const token = tokenId ? included.get(tokenId) : null;
        const attrs = token?.attributes || {};
        const mint = String(attrs.address || (tokenId || "").replace(/^solana_/, ""));
        if (!mint) return null;
        return {
          chainId: "solana",
          tokenAddress: mint,
          description: [attrs.name, attrs.symbol].filter(Boolean).join(" ") || "New Solana pool",
          url: "https://www.geckoterminal.com/solana/pools/" + encodeURIComponent(pool.attributes?.address || "")
        };
      }).filter(item => item && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.tokenAddress));
      const unique = [...new Map(profiles.map(item => [item.tokenAddress, item])).values()];
      if (!unique.length) throw new Error("returned no usable Solana tokens");
      geckoDiscoveryCache = { savedAt: Date.now(), data: unique };
      return unique;
    })(),
    (async () => {
      const cached = jupiterDiscoveryCache;
      if (cached.data && Date.now() - cached.savedAt < 60 * 1000) return cached.data;
      const response = await fetch("https://api.jup.ag/tokens/v2/recent", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : (payload.tokens || payload.data || []);
      const profiles = rows.map(token => {
        const mint = String(token.id || token.address || token.mint || "");
        if (!mint) return null;
        return {
          chainId: "solana",
          tokenAddress: mint,
          description: [token.name, token.symbol].filter(Boolean).join(" ") || "Recent Solana token",
          url: "https://jup.ag/tokens/" + encodeURIComponent(mint)
        };
      }).filter(item => item && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.tokenAddress));
      const unique = [...new Map(profiles.map(item => [item.tokenAddress, item])).values()];
      if (!unique.length) throw new Error("returned no usable Solana tokens");
      jupiterDiscoveryCache = { savedAt: Date.now(), data: unique };
      return unique;
    })()
  ]);

  for (const [name, result] of [
    ["DexScreener", dexResult],
    ["GeckoTerminal", geckoResult],
    ["Jupiter", jupiterResult]
  ]) {
    if (result.status === "fulfilled") {
      if (result.value.length) sources.push(result.value);
      else errors.push(name + ": no Solana candidates");
    } else {
      errors.push(name + ": " + String(result.reason?.message || result.reason));
    }
  }

  if (!sources.length) {
    throw new Error("نەتوانرا کۆینی نوێ بدۆزرێتەوە: " + errors.join("; "));
  }

  const sourceDiagnostics = [
    { name: "DexScreener", candidates: dexResult.status === "fulfilled" ? dexResult.value.length : 0, ok: dexResult.status === "fulfilled" },
    { name: "GeckoTerminal", candidates: geckoResult.status === "fulfilled" ? geckoResult.value.length : 0, ok: geckoResult.status === "fulfilled" },
    { name: "Jupiter", candidates: jupiterResult.status === "fulfilled" ? jupiterResult.value.length : 0, ok: jupiterResult.status === "fulfilled" }
  ];
  // Round-robin the feeds so one provider cannot occupy the entire queue.
  const merged = [];
  const seen = new Set();
  const maxLength = Math.max(...sources.map(source => source.length));
  for (let index = 0; index < maxLength; index++) {
    for (const source of sources) {
      const item = source[index];
      const mint = String(item?.tokenAddress || "");
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      merged.push(item);
    }
  }
  merged.discoveryDiagnostics = { sources: sourceDiagnostics, errors, totalCandidates: merged.length };
  return merged;
}
function mintDetails(account) {
  const value = account?.value;
  if (!value) throw new Error("Mint account unavailable");
  let mintAuthority = null, freezeAuthority = null, extensions = [];
  const parsed = value.data?.parsed?.info;
  if (parsed) {
    // Null means the authority was explicitly revoked. Missing or malformed
    // fields remain unknown and must never be treated as safe.
    mintAuthority = parsed.mintAuthority === null ? false :
      typeof parsed.mintAuthority === "string" ? true : null;
    freezeAuthority = parsed.freezeAuthority === null ? false :
      typeof parsed.freezeAuthority === "string" ? true : null;
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
async function getJupiterMarketForMint(mint, env) {
  const cached = jupiterMarketCache.get(mint);
  if (cached && Date.now() - cached.savedAt < 60 * 1000) return cached.market;
  const waitMs = Math.max(0, jupiterNextAt - Date.now());
  jupiterNextAt = Date.now() + 2100;
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  const headers = { "Accept": "application/json" };
  if (env?.JUPITER_API_KEY) headers["x-api-key"] = String(env.JUPITER_API_KEY).trim();
  const response = await fetch(
    "https://api.jup.ag/tokens/v2/search?query=" + encodeURIComponent(mint),
    { headers, signal: AbortSignal.timeout(12000) }
  );
  if (!response.ok) throw new Error("Jupiter Token API HTTP " + response.status);
  const payload = await response.json();
  const token = (Array.isArray(payload) ? payload : []).find(item => item?.id === mint);
  if (!token) throw new Error("Jupiter returned no exact match for this mint");
  const stats = token.stats24h || {};
  const volume24h = Number(stats.buyVolume || 0) + Number(stats.sellVolume || 0);
  const market = {
    chainId: "solana",
    dexId: "jupiter-token-api",
    url: "https://jup.ag/tokens/" + encodeURIComponent(mint),
    baseToken: { address: mint, name: token.name || "Unknown token", symbol: token.symbol || "" },
    imageUrl: token.icon || token.logoURI || null,
    quoteToken: { address: "", name: "USD", symbol: "USD" },
    priceUsd: Number(token.usdPrice || 0) > 0 ? String(token.usdPrice) : null,
    priceChange: { h24: Number(stats.priceChange || 0) },
    volume: { h24: volume24h },
    liquidity: { usd: Number(token.liquidity || 0) },
    txns: { h24: { buys: Number(stats.numBuys || 0), sells: Number(stats.numSells || 0) } },
    mcap: Number(token.mcap || 0),
    fdv: Number(token.fdv || 0),
    isVerified: token.isVerified === true,
    organicScore: Number(token.organicScore || 0),
    audit: token.audit || null
  };
  jupiterMarketCache.set(mint, { savedAt: Date.now(), market });
  while (jupiterMarketCache.size > 100) {
    jupiterMarketCache.delete(jupiterMarketCache.keys().next().value);
  }
  return market;
}

async function enrichIncompleteMarketWithJupiter(mint, market, env) {
  const currentPrice = Number(market?.priceUsd || 0);
  const currentVolume = Number(market?.volume?.h24 || 0);
  const currentBuys = Number(market?.txns?.h24?.buys || 0);
  const currentSells = Number(market?.txns?.h24?.sells || 0);
  const existingImage = market?.imageUrl || market?.info?.imageUrl || null;
  const hasCoreMarket = currentPrice > 0 &&
    (currentVolume > 0 || currentBuys + currentSells === 0);
  // Keep complete DexScreener data, but still look up Jupiter when its token
  // logo is missing so the scan result can show a real logo instead of fallback.
  if (hasCoreMarket && existingImage) return market;
  const jupiter = await getJupiterMarketForMint(mint, env);
  return {
    ...market,
    priceUsd: currentPrice > 0 ? market.priceUsd : jupiter.priceUsd,
    priceChange: market.priceChange || jupiter.priceChange,
    volume: { h24: currentVolume > 0 ? currentVolume : jupiter.volume.h24 },
    liquidity: { usd: Number(market?.liquidity?.usd || 0) > 0 ? market.liquidity.usd : jupiter.liquidity.usd },
    txns: { h24: {
      buys: currentBuys > 0 ? currentBuys : jupiter.txns.h24.buys,
      sells: currentSells > 0 ? currentSells : jupiter.txns.h24.sells
    } },
    jupiterAudit: jupiter.audit,
    jupiterOrganicScore: jupiter.organicScore,
    jupiterVerified: jupiter.isVerified,
    imageUrl: existingImage || jupiter.imageUrl || null
  };
}

async function getMarketForMint(mint, env) {
  let dexError = null;
  try {
    const dex = await getDexJson(
      "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(mint), env, 90
    );
    const market = (dex.pairs || []).filter(p => p.chainId === "solana" &&
      (p.baseToken?.address === mint || p.quoteToken?.address === mint))
      .sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
    if (market) return await enrichIncompleteMarketWithJupiter(mint, market, env);
    dexError = new Error("DexScreener returned no Solana market pair");
  } catch (error) {
    dexError = error;
  }

  // Independent market-data fallback for tokens when DexScreener is throttled.
  try {
    const response = await fetch(
      "https://api.geckoterminal.com/api/v2/networks/solana/tokens/" +
        encodeURIComponent(mint) + "/pools?include=base_token,quote_token",
      {
        headers: { "Accept": "application/json;version=20230302" },
        signal: AbortSignal.timeout(12000)
      }
    );
    if (!response.ok) throw new Error("GeckoTerminal HTTP " + response.status);
    const payload = await response.json();
    const included = new Map((payload.included || []).map(item => [item.id, item]));
    const pools = (payload.data || []).map(pool => {
      const attrs = pool.attributes || {};
      const baseId = pool.relationships?.base_token?.data?.id;
      const quoteId = pool.relationships?.quote_token?.data?.id;
      const base = included.get(baseId)?.attributes || {};
      const quote = included.get(quoteId)?.attributes || {};
      const isBase = String(base.address || baseId?.replace(/^solana_/, "")) === mint;
      if (!isBase) return null;
      const tx = attrs.transactions?.h24 || {};
      const buys = Number(tx.buys || tx.buys_count || 0);
      const sells = Number(tx.sells || tx.sells_count || 0);
      return {
        chainId: "solana",
        dexId: "geckoterminal",
        url: "https://www.geckoterminal.com/solana/pools/" + encodeURIComponent(attrs.address || ""),
        pairAddress: attrs.address || null,
        baseToken: { address: mint, name: base.name || "Unknown token", symbol: base.symbol || "" },
        imageUrl: base.image_url || base.imageUrl || null,
        quoteToken: { address: quote.address || "", name: quote.name || "", symbol: quote.symbol || "" },
        priceUsd: attrs.base_token_price_usd || attrs.token_price_usd || null,
        priceChange: { h24: Number(attrs.price_change_percentage?.h24 || 0) },
        volume: { h24: Number(attrs.volume_usd?.h24 || 0) },
        liquidity: { usd: Number(attrs.reserve_in_usd || 0) },
        txns: { h24: { buys, sells } }
      };
    }).filter(Boolean).sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    if (!pools.length) throw new Error("No GeckoTerminal pool found for this mint");
    return await enrichIncompleteMarketWithJupiter(mint, pools[0], env);
  } catch (geckoError) {
    // Third independent source: Jupiter Token API.
    try {
      return await getJupiterMarketForMint(mint, env);
    } catch (jupiterError) {
      throw new Error("DexScreener: " + String(dexError?.message || dexError) +
        "; GeckoTerminal: " + String(geckoError?.message || geckoError) +
        "; Jupiter: " + String(jupiterError?.message || jupiterError));
    }
  }
}

async function inspectMint(mint, env) {
  const market = await getMarketForMint(mint, env);

  // RugCheck is an independent safety signal: its outage must not abort
  // the scan. RPC holder/mint data is still mandatory and fails closed.
  const [rugResult, rugSummaryResult, rpcResult] = await Promise.allSettled([
    getJson("https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(mint) + "/report"),
    getJson("https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(mint) + "/report/summary"),
    rpcBatch([
      { method: "getAccountInfo", params: [mint, { encoding: "base64", commitment: "confirmed" }] },
      { method: "getTokenLargestAccounts", params: [mint, { commitment: "confirmed" }] },
      { method: "getTokenSupply", params: [mint, { commitment: "confirmed" }] }
    ], env)
  ]);
  const fullRug = rugResult.status === "fulfilled" ? rugResult.value : null;
  const rugSummary = rugSummaryResult.status === "fulfilled" ? rugSummaryResult.value : null;
  const rug = fullRug ? {
    ...fullRug,
    score: fullRug.score ?? rugSummary?.score,
    risks: Array.isArray(fullRug.risks) ? fullRug.risks : rugSummary?.risks,
    lpLockedPct: rugSummary?.lpLockedPct
  } : (rugSummary ? rugSummary : null);
  if (rugResult.status === "rejected" || rugSummaryResult.status === "rejected") {
    console.warn("RugCheck unavailable; token remains ineligible for paper buy", {
      mint,
      error: [
        rugResult.status === "rejected" ? "full report: " + String(rugResult.reason?.message || rugResult.reason) : "",
        rugSummaryResult.status === "rejected" ? "summary: " + String(rugSummaryResult.reason?.message || rugSummaryResult.reason) : ""
      ].filter(Boolean).join("; ")
    });
  }
  if (rpcResult.status !== "fulfilled") {
    throw rpcResult.reason instanceof Error ? rpcResult.reason : new Error(String(rpcResult.reason || "Solana RPC inspection failed"));
  }
  const rpcResults = rpcResult.value;
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
  if (sells > Number(market.txns?.h24?.buys || 0) * 3) reasons.push("24h sells exceed 3x buys");
  if (details.mintAuthority !== false || details.freezeAuthority !== false) reasons.push("Mint/Freeze authority not confirmed inactive");
  if (largestPct > 30) reasons.push("Largest holder above 30%");
  if (topTenPct > 50) reasons.push("Top 10 holders above 50%");
  if (!rug || rug.score == null || Number(rug.score) > 2500) reasons.push("RugCheck unavailable or score above 2500");

  // Additional fail-closed checks from RugCheck's structured report.
  // Missing LP-lock data is unknown, never treated as locked/safe.
  const lpLockedPct = Number(rug?.lpLockedPct);
  if (!Number.isFinite(lpLockedPct)) {
    reasons.push("LP lock status unavailable");
  } else if (lpLockedPct < 80) {
    reasons.push("Less than 80% of liquidity is locked (" + lpLockedPct.toFixed(2) + "%)");
  }

  const rugRisks = Array.isArray(rug?.risks) ? rug.risks : [];
  const severeRugRisks = rugRisks.filter(item =>
    ["danger", "critical"].includes(String(item?.level || "").toLowerCase())
  );
  for (const risk of severeRugRisks) {
    const label = String(risk?.name || risk?.description || "Unspecified severe RugCheck risk");
    reasons.push("RugCheck severe risk: " + label.slice(0, 120));
  }

  const riskText = rugRisks.map(item =>
    String(item?.name || "") + " " + String(item?.description || "")
  ).join(" ");
  if (/honeypot|high\\s*tax|transfer\\s*tax|blacklist|transfer\\s*hook|permanent\\s*delegate|rug\\s*pull|fake\\s*token/i.test(riskText)) {
    reasons.push("RugCheck detected a honeypot, transfer restriction, or token-control warning");
  }
  if (rug?.tokenMeta?.mutable === true) {
    reasons.push("Token metadata is mutable");
  }

  if (details.extensions.some(type => RISKY_EXTENSIONS.has(type))) reasons.push("Risky Token-2022 extension detected");
  const price = Number(market.priceUsd || 0);
  if (!(price > 0)) reasons.push("Price unavailable");
  return {
    ok: reasons.length === 0, reasons, price, market, rugScore: rug?.score,
    largestPct, topTenPct, top: ownerPercentages.slice(0, 5),
    mintAuthority: details.mintAuthority, freezeAuthority: details.freezeAuthority,
    holderAccountsChecked: ownerBalances.size
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
async function autoBuy(state, env) {
  if (!state.autoEnabled || state.paused || state.balance < 5 || state.trades.filter(t => !t.sold).length >= 10) return "Auto-buy inactive, paused, or limit reached.";
  const profiles = await getLatestSolanaProfiles(env);
  const discoveryDiagnostics = profiles.discoveryDiagnostics || { sources: [], errors: ["Discovery diagnostics unavailable"], totalCandidates: profiles.length };
  state.lastDiscoveryDiagnostics = discoveryDiagnostics;
  const seen = new Set();
  const tokens = Array.isArray(profiles) ? profiles.filter(t => {
    const mint = String(t?.tokenAddress || "");
    if (t?.chainId !== "solana" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || seen.has(mint)) return false;
    seen.add(mint);
    return true;
  }) : [];
  let checked = 0, bought = 0, skippedExisting = 0, newlyQueued = 0;
  const report = discoveryDiagnostics.sources.map(source => ({
    status: source.ok ? "discovery-source" : "discovery-error",
    mint: source.name,
    reasons: [source.ok ? ("Candidates received: " + source.candidates) : "Source request failed"]
  }));
  for (const error of discoveryDiagnostics.errors) {
    const name = String(error).split(":")[0];
    const row = report.find(item => item.status === "discovery-error" && item.mint === name);
    if (row) row.reasons = [String(error)];
    else report.push({ status: "discovery-error", mint: name || "Discovery", reasons: [String(error)] });
  }
  const scanned = new Set(state.scannedMints);
  const traded = new Set(state.trades.map(t => t.mint));
  // Keep a bounded FIFO backlog; accept at most ten new candidates per cycle.
  state.pendingMints = [...new Set(state.pendingMints)].slice(0, 20);
  const queued = new Set(state.pendingMints);
  for (const token of tokens) {
    const mint = token.tokenAddress;
    if (newlyQueued >= 10 || state.pendingMints.length >= 20) break;
    if (!scanned.has(mint) && !traded.has(mint) && !queued.has(mint)) {
      state.pendingMints.push(mint);
      queued.add(mint);
      newlyQueued++;
    }
  }
  // Two full inspections per five-minute cron run protects RPC and Worker limits.
  // The bounded FIFO queue prevents old candidates from growing without limit.
  let queueChecksRemaining = state.pendingMints.length;
  while (checked < 2 && queueChecksRemaining-- > 0 && state.balance >= 5 &&
         state.trades.filter(t => !t.sold).length < 10 && state.pendingMints.length) {
    const mint = state.pendingMints.shift();
    if (scanned.has(mint) || traded.has(mint)) { skippedExisting++; continue; }
    const deferred = state.deferredMints.find(item => item.mint === mint);
    if (deferred && Number(deferred.retryAt) > Date.now()) {
      state.pendingMints.push(mint);
      continue;
    }
    state.deferredMints = state.deferredMints.filter(item => item.mint !== mint);
    checked++;
    try {
      const result = await inspectMint(mint, env);
      // Only mark a mint as scanned after a complete inspection.
      // Temporary RPC/API failures remain eligible for a later retry.
      state.scannedMints.push(mint);
      scanned.add(mint);
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
      traded.add(mint);
      bought++;
      report.push({ mint, status: "bought-paper", reasons: ["هەموو پشکنینەکان تێپەڕاند"] });
    } catch (error) {
      const message = String(error?.message || "داتای پشکنین بەردەست نییە");
      // Keep temporary market/RPC failures in the persistent queue for retry.
      state.deferredMints.push({ mint, retryAt: Date.now() + 5 * 60 * 1000 });
      state.pendingMints.push(mint);
      if (message === "No Solana market pair") {
        report.push({ mint, status: "deferred", reasons: ["بازاڕی Solana هێشتا نەدۆزراوەتەوە؛ دوای ٥ خولەک دووبارە پشکنین دەکرێت"] });
      } else {
        report.push({ mint, status: "blocked-error", reasons: [message, "دوای ٥ خولەک دووبارە پشکنین دەکرێت"] });
      }
      // Unknown or unavailable data always means no simulated purchase.
    }
  }
  state.scannedMints = state.scannedMints.slice(-1000);
  state.deferredMints = [...new Map(state.deferredMints.map(item => [item.mint, item])).values()].slice(-1000);
  state.pendingMints = [...new Set(state.pendingMints)].slice(0, 20);
  state.lastScanReport = report.slice(0, 20);
  const sourceSummary = discoveryDiagnostics.sources.map(source =>
    source.name + ": " + (source.ok ? source.candidates + " candidates" : "FAILED")
  ).join(", ");
  const sourceErrors = discoveryDiagnostics.errors.length ? " Source errors: " + discoveryDiagnostics.errors.join(" | ") + "." : "";
  const blocked = report.filter(x => x.status === "rejected" || x.status === "blocked-error").length;
  const deferred = report.filter(x => x.status === "deferred").length;
  const noNewTokens = checked === 0
    ? " No unscanned candidates were processed; " + skippedExisting + " already-seen tokens skipped."
    : "";
  return "Discovery sources: " + sourceSummary + ". Total merged candidates: " + discoveryDiagnostics.totalCandidates + ". Checked " + checked + " new tokens (max 2 per 5-minute cycle; up to 10 candidates are processed across five cycles); paper buys: " + bought + ". " + blocked + " blocked; " + deferred + " waiting for retry; " + state.pendingMints.length + " candidates queued; source details and scan reasons saved in report." + sourceErrors + noNewTokens;
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
      return json({ ok: true, mode: "paper-trading", scheduler: "Cloudflare Cron", storage: "Workers KV", build: BUILD_ID });
    }
    if (url.pathname === "/version" && request.method === "GET") {
      return json({ ok: true, build: BUILD_ID, frontend: "premium-dashboard-v2", asset: "index.html" });
    }
    if (url.pathname === "/login-diagnostics" && request.method === "GET") {
      const result = {
        worker: true,
        passwordSecretConfigured: typeof env.BOT_LOGIN_PASSWORD === "string" && env.BOT_LOGIN_PASSWORD.length > 0,
        kvBindingConfigured: !!env.BOT_STATE,
        kvRead: false,
        kvWrite: false,
        kvDelete: false
      };
      if (env.BOT_STATE) {
        const key = "login_diagnostic:" + crypto.randomUUID();
        let stage = "read";
        try {
          await env.BOT_STATE.get(key);
          result.kvRead = true;
          stage = "write";
          await env.BOT_STATE.put(key, "ok", { expirationTtl: 60 });
          result.kvWrite = true;
          stage = "delete";
          await env.BOT_STATE.delete(key);
          result.kvDelete = true;
        } catch (error) {
          const message = String(error?.message || error || "Unknown KV error");
          console.error("Login diagnostics KV error", { stage, name: String(error?.name || "Error"), message });
          result.kvErrorStage = stage;
          result.kvErrorName = String(error?.name || "Error").slice(0, 80);
          result.kvErrorMessage = message.slice(0, 240);
        }
      }
      return json(result);
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
      const probe = `<div id="sb-page-probe" style="position:fixed;z-index:2147483647;left:8px;right:8px;bottom:8px;padding:12px;border:2px solid #27e7d3;border-radius:12px;background:#07152b;color:#fff;font:12px/1.45 system-ui;direction:ltr;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere">DASHBOARD TEST: checking page and API…</div><script>(function(){var p=document.getElementById("sb-page-probe");var lines=[];function add(s){lines.push(s);p.textContent=lines.join("\\n");}function info(){var w=document.querySelector(".wrap"),h=document.querySelector("header"),l=document.getElementById("serverLogin"),f=document.getElementById("loginForm"),scan=document.getElementById("scan"),disc=document.getElementById("disc");var cs=function(x){if(!x)return "missing";var s=getComputedStyle(x),r=x.getBoundingClientRect();return "display="+s.display+", visibility="+s.visibility+", rect="+Math.round(r.width)+"x"+Math.round(r.height)};add("DASHBOARD TEST: HTML loaded");add("Wrap: "+cs(w));add("Header: "+cs(h));add("Login overlay: "+cs(l));add("Login form: "+cs(f));add("Scan button: "+cs(scan)+", handler="+(scan&&typeof scan.onclick));add("Discover button: "+cs(disc)+", handler="+(disc&&typeof disc.onclick));add("Body text length: "+((document.body.innerText||"").length));}window.addEventListener("error",function(e){add("JAVASCRIPT ERROR: "+e.message+" @ "+e.lineno+":"+e.colno)});window.addEventListener("unhandledrejection",function(e){add("PROMISE ERROR: "+String(e.reason&&e.reason.message||e.reason))});setTimeout(async function(){info();for(var path of ["/api/state","/api/discover"]){try{var controller=new AbortController();var timer=setTimeout(function(){controller.abort()},12000);var res=await fetch(path,{cache:"no-store",signal:controller.signal});clearTimeout(timer);var data=await res.json().catch(function(){return {}});add(path+": HTTP "+res.status+" "+(path==="/api/state"?"balance="+data.balance+", trades="+(Array.isArray(data.trades)?data.trades.length:"?"):"tokens="+(Array.isArray(data.tokens)?data.tokens.length:"?")+(data.error?", error="+data.error:"")));}catch(e){add(path+": FAILED "+String(e.message||e));}}},1200);})();</script>`;
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
      } catch (error) { console.error("Login handler error", String(error?.message || error)); return json({ error: "داواکاری هەڵەیە" }, 400); }
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
    if (url.pathname === "/api/logout" && request.method === "POST") {
      const header = request.headers.get("Authorization") || "";
      const match = header.match(/^Bearer ([0-9a-f-]{36})$/i);
      if (match && env?.BOT_STATE) await env.BOT_STATE.delete("session:" + match[1]);
      return json({ ok: true });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);
      const authHeader = request.headers.get("Authorization") || "";
      const sessionMatch = authHeader.match(/^Bearer ([0-9a-f-]{36})$/i);
      const sessionId = sessionMatch ? sessionMatch[1] : null;
      if (url.pathname === "/api/design-settings" && request.method === "GET") {
        const defaults = { theme: "purple", mode: "dark", density: "comfortable", scale: "normal", layout: "grid", accent: "#8b5cf6", background: "aurora", font: "noto", radius: 18, visible: { scan: true, token: true, market: true, security: true, holders: true, selling: true, botStats: true, trades: true, reports: true, notice: true } };
        const saved = await env.BOT_STATE.get("owner_design_settings", "json");
        return json({ ok: true, settings: { ...defaults, ...(saved && typeof saved === "object" ? saved : {}), visible: { ...defaults.visible, ...(saved?.visible && typeof saved.visible === "object" ? saved.visible : {}) } } });
      }
      if (url.pathname === "/api/design-settings" && request.method === "POST") {
        try {
          const body = await request.json();
          const defaults = { theme: "purple", mode: "dark", density: "comfortable", scale: "normal", layout: "grid", accent: "#8b5cf6", background: "aurora", font: "noto", radius: 18, visible: { scan: true, token: true, market: true, security: true, holders: true, selling: true, botStats: true, trades: true, reports: true, notice: true } };
          const allowed = { theme: ["purple", "blue", "green", "rose"], mode: ["dark", "light"], density: ["compact", "comfortable", "spacious"], scale: ["small", "normal", "large"], layout: ["grid", "single", "wide"], background: ["aurora", "midnight", "slate", "black"], font: ["noto", "system", "arial", "serif"] };
          const panelKeys = ["header", "scan", "token", "market", "security", "holders", "selling", "botStats", "trades", "reports", "notice"];
          const settings = {};
          for (const [key, values] of Object.entries(allowed)) settings[key] = values.includes(body[key]) ? body[key] : defaults[key];
          settings.accent = /^#[0-9a-f]{6}$/i.test(String(body.accent || "")) ? String(body.accent) : defaults.accent;
          settings.radius = Number.isFinite(Number(body.radius)) ? Math.max(4, Math.min(30, Number(body.radius))) : defaults.radius;
          settings.visible = {};
          for (const key of Object.keys(defaults.visible)) settings.visible[key] = body.visible && body.visible[key] === false ? false : true;
          if (body.geometry && typeof body.geometry === "object" && !Array.isArray(body.geometry)) {
            settings.geometry = {};
            for (const key of panelKeys) {
              const g = body.geometry[key];
              if (!g || typeof g !== "object" || Array.isArray(g)) continue;
              const clamp = (value, min, max, fallback) => {
                const n = Number(value);
                return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
              };
              settings.geometry[key] = {
                x: clamp(g.x, 0, 95, 0),
                y: clamp(g.y, key === "header" ? 0 : 48, 1320, key === "header" ? 0 : 48),
                w: clamp(g.w, 18, 100, 40),
                h: clamp(g.h, 55, 500, 120)
              };
            }
          }
          settings.updatedAt = new Date().toISOString();
          await env.BOT_STATE.put("owner_design_settings", JSON.stringify(settings));
          return json({ ok: true, settings });
        } catch (error) {
          console.error("Design settings save failed", String(error?.message || error));
          return json({ error: "پاشەکەوتکردنی ڕێکخستنەکانی دیزاین سەرکەوتوو نەبوو" }, 400);
        }
      }
      if (url.pathname === "/api/profile" && request.method === "GET") {
        const profile = await readProfile(env);
        return json({
          ok: true,
          profile: {
            email: String(profile.email || ""),
            phone: String(profile.phone || ""),
            emailVerified: profile.emailVerified === true,
            phoneVerified: profile.phoneVerified === true,
            totpEnabled: profile.totpEnabled === true
          }
        });
      }
      if (url.pathname === "/api/profile" && request.method === "POST") {
        try {
          const body = await request.json();
          const email = String(body.email || "").trim().toLowerCase();
          const phone = String(body.phone || "").trim();
          if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
            return json({ error: "ناونیشانی Gmail دروست نییە" }, 400);
          }
          if (phone.length > 20 || (phone && !/^\+[1-9]\d{7,14}$/.test(phone))) {
            return json({ error: "ژمارەی مۆبایل بە شێوەی نێودەوڵەتی بنووسە؛ نموونە +9647xxxxxxxxx" }, 400);
          }
          const profile = await readProfile(env);
          profile.emailVerified = email === String(profile.email || "").toLowerCase() && profile.emailVerified === true;
          profile.phoneVerified = phone === String(profile.phone || "") && profile.phoneVerified === true;
          profile.email = email;
          profile.phone = phone;
          await env.BOT_STATE.put("admin_profile", JSON.stringify(profile));
          return json({ ok: true, profile: {
            email: profile.email, phone: profile.phone,
            emailVerified: profile.emailVerified, phoneVerified: profile.phoneVerified,
            totpEnabled: profile.totpEnabled === true
          }});
        } catch { return json({ error: "زانیارییەکانی پرۆفایل پاشەکەوت نەکران" }, 400); }
      }
      if (url.pathname === "/api/verify/email/send" && request.method === "POST") {
        try {
          const profile = await readProfile(env);
          const email = String(profile.email || "").trim().toLowerCase();
          if (!email) return json({ error: "سەرەتا Gmail لە پرۆفایل پاشەکەوت بکە" }, 400);
          if (profile.emailVerified) return json({ error: "Gmail پێشتر پشتڕاست کراوەتەوە" }, 409);
          if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return json({ error: "خزمەتگوزاری ئیمەیڵ ئامادە نییە؛ RESEND_API_KEY و RESEND_FROM_EMAIL لە Cloudflare زیاد بکە" }, 503);
          const rateKey = "verify_rate:email:" + sessionId;
          if (await env.BOT_STATE.get(rateKey)) return json({ error: "تکایە پێش ناردنی کۆدی نوێ ٦٠ چرکە چاوەڕێ بکە" }, 429);
          const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: env.RESEND_FROM_EMAIL, to: [email],
              subject: "Solana Smart Bot - Email verification",
              text: "Your verification code is " + code + ". It expires in 10 minutes. If you did not request this, ignore this email."
            })
          });
          if (!response.ok) {
            const detail = await response.text();
            console.error("Email provider error", response.status, detail.slice(0, 300));
            return json({ error: "ناردنی ئیمەیڵ سەرکەوتوو نەبوو؛ دڵنیابە ناونیشانی نێرەر لە Resend پشتڕاست کراوەتەوە" }, 502);
          }
          await env.BOT_STATE.put("verify_code:email:" + sessionId, JSON.stringify({ hash: await hashText(code), target: email, createdAt: Date.now(), attempts: 0 }), { expirationTtl: 600 });
          await env.BOT_STATE.put(rateKey, "1", { expirationTtl: 60 });
          return json({ ok: true });
        } catch (error) { console.error("Email verification send failed", String(error?.message || error)); return json({ error: "ناردنی کۆدی Gmail سەرکەوتوو نەبوو" }, 502); }
      }
      if (url.pathname === "/api/verify/email/confirm" && request.method === "POST") {
        try {
          const body = await request.json();
          const key = "verify_code:email:" + sessionId;
          const pending = await env.BOT_STATE.get(key, "json");
          const profile = await readProfile(env);
          if (!pending || pending.target !== String(profile.email || "").toLowerCase() || Date.now() - Number(pending.createdAt || 0) > 600000) return json({ error: "کۆدەکە بەسەرچووە؛ دووبارە داوای کۆد بکە" }, 410);
          if (!/^\d{6}$/.test(String(body.code || "")) || await hashText(String(body.code).trim()) !== pending.hash) {
            pending.attempts = Number(pending.attempts || 0) + 1;
            if (pending.attempts >= 5) await env.BOT_STATE.delete(key);
            else await env.BOT_STATE.put(key, JSON.stringify(pending), { expirationTtl: 600 });
            return json({ error: pending.attempts >= 5 ? "هەوڵەکان تەواو بوون؛ کۆدی نوێ داوا بکە" : "کۆدی Gmail هەڵەیە" }, 401);
          }
          profile.emailVerified = true;
          await env.BOT_STATE.put("admin_profile", JSON.stringify(profile));
          await env.BOT_STATE.delete(key);
          return json({ ok: true });
        } catch { return json({ error: "پشتڕاستکردنەوەی Gmail سەرکەوتوو نەبوو" }, 400); }
      }
      if (url.pathname === "/api/verify/phone/send" && request.method === "POST") {
        try {
          const profile = await readProfile(env);
          const phone = String(profile.phone || "").trim();
          if (!phone) return json({ error: "سەرەتا ژمارەی مۆبایل لە پرۆفایل پاشەکەوت بکە" }, 400);
          if (profile.phoneVerified) return json({ error: "ژمارەی مۆبایل پێشتر پشتڕاست کراوەتەوە" }, 409);
          if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) return json({ error: "خزمەتگوزاری SMS ئامادە نییە؛ سێ Secret ـی Twilio لە Cloudflare زیاد بکە" }, 503);
          const rateKey = "verify_rate:phone:" + sessionId;
          if (await env.BOT_STATE.get(rateKey)) return json({ error: "تکایە پێش ناردنی کۆدی نوێ ٦٠ چرکە چاوەڕێ بکە" }, 429);
          const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
          const form = new URLSearchParams({ To: phone, From: env.TWILIO_FROM_NUMBER, Body: "Solana Smart Bot verification code: " + code + ". Expires in 10 minutes." });
          const credentials = btoa(env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN);
          const response = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(env.TWILIO_ACCOUNT_SID) + "/Messages.json", {
            method: "POST", headers: { "Authorization": "Basic " + credentials, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString()
          });
          if (!response.ok) {
            const detail = await response.text();
            console.error("SMS provider error", response.status, detail.slice(0, 300));
            return json({ error: "ناردنی SMS سەرکەوتوو نەبوو؛ هەژمار و ژمارەی نێرەری Twilio بپشکنە" }, 502);
          }
          await env.BOT_STATE.put("verify_code:phone:" + sessionId, JSON.stringify({ hash: await hashText(code), target: phone, createdAt: Date.now(), attempts: 0 }), { expirationTtl: 600 });
          await env.BOT_STATE.put(rateKey, "1", { expirationTtl: 60 });
          return json({ ok: true });
        } catch (error) { console.error("SMS verification send failed", String(error?.message || error)); return json({ error: "ناردنی کۆدی SMS سەرکەوتوو نەبوو" }, 502); }
      }
      if (url.pathname === "/api/verify/phone/confirm" && request.method === "POST") {
        try {
          const body = await request.json();
          const key = "verify_code:phone:" + sessionId;
          const pending = await env.BOT_STATE.get(key, "json");
          const profile = await readProfile(env);
          if (!pending || pending.target !== String(profile.phone || "") || Date.now() - Number(pending.createdAt || 0) > 600000) return json({ error: "کۆدەکە بەسەرچووە؛ دووبارە داوای کۆد بکە" }, 410);
          if (!/^\d{6}$/.test(String(body.code || "")) || await hashText(String(body.code).trim()) !== pending.hash) {
            pending.attempts = Number(pending.attempts || 0) + 1;
            if (pending.attempts >= 5) await env.BOT_STATE.delete(key);
            else await env.BOT_STATE.put(key, JSON.stringify(pending), { expirationTtl: 600 });
            return json({ error: pending.attempts >= 5 ? "هەوڵەکان تەواو بوون؛ کۆدی نوێ داوا بکە" : "کۆدی SMS هەڵەیە" }, 401);
          }
          profile.phoneVerified = true;
          await env.BOT_STATE.put("admin_profile", JSON.stringify(profile));
          await env.BOT_STATE.delete(key);
          return json({ ok: true });
        } catch { return json({ error: "پشتڕاستکردنەوەی ژمارەی مۆبایل سەرکەوتوو نەبوو" }, 400); }
      }
      if (url.pathname === "/api/totp/setup" && request.method === "POST") {
        try {
          const profile = await readProfile(env);
          if (profile.totpEnabled) return json({ error: "Google Authenticator پێشتر چالاکە" }, 409);
          const bytes = crypto.getRandomValues(new Uint8Array(20));
          const secret = base32Encode(bytes);
          await env.BOT_STATE.put("totp_pending:" + sessionId, JSON.stringify({ secret, createdAt: Date.now() }), { expirationTtl: 300 });
          const account = encodeURIComponent(profile.email || "owner");
          const issuer = encodeURIComponent("Solana Smart Bot");
          const uri = "otpauth://totp/" + issuer + ":" + account +
            "?secret=" + secret + "&issuer=" + issuer + "&algorithm=SHA1&digits=6&period=30";
          return json({ ok: true, secret, uri, expiresIn: 300 });
        } catch { return json({ error: "نەیتوانی کلیلی Authenticator دروست بکات" }, 500); }
      }
      if (url.pathname === "/api/totp/verify" && request.method === "POST") {
        try {
          const body = await request.json();
          const pendingKey = "totp_pending:" + sessionId;
          const pending = await env.BOT_STATE.get(pendingKey, "json");
          if (!pending || Date.now() - Number(pending.createdAt || 0) > 300000) {
            return json({ error: "کاتی دامەزراندن تەواو بوو؛ دووبارە دەست پێبکە" }, 410);
          }
          if (!(await verifyTotp(pending.secret, String(body.code || "").trim()))) {
            return json({ error: "کۆدی Google Authenticator هەڵەیە" }, 401);
          }
          const profile = await readProfile(env);
          profile.totpSecret = pending.secret;
          profile.totpEnabled = true;
          await env.BOT_STATE.put("admin_profile", JSON.stringify(profile));
          await env.BOT_STATE.delete(pendingKey);
          return json({ ok: true, totpEnabled: true });
        } catch { return json({ error: "چالاککردنی Authenticator سەرکەوتوو نەبوو" }, 400); }
      }
      if (url.pathname === "/api/totp/disable" && request.method === "POST") {
        try {
          const body = await request.json();
          const profile = await readProfile(env);
          if (!profile.totpEnabled || !profile.totpSecret ||
              !(await verifyTotp(profile.totpSecret, String(body.code || "").trim()))) {
            return json({ error: "کۆدی ئێستای Authenticator هەڵەیە" }, 401);
          }
          profile.totpEnabled = false;
          profile.totpSecret = null;
          profile.backupHash = null;
          await env.BOT_STATE.put("admin_profile", JSON.stringify(profile));
          return json({ ok: true, totpEnabled: false });
        } catch { return json({ error: "ناچالاککردنی Authenticator سەرکەوتوو نەبوو" }, 400); }
      }
      if (url.pathname === "/api/discover" && request.method === "GET") {
        try {
          const profiles = await getLatestSolanaProfiles(env);
          const state = await readState(env);
          const excluded = new Set([
            ...state.scannedMints,
            ...state.pendingMints,
            ...state.trades.map(trade => trade.mint)
          ]);
          const seen = new Set();
          const diagnostics = profiles.discoveryDiagnostics || { sources: [], errors: [], totalCandidates: profiles.length };
          const tokens = (Array.isArray(profiles) ? profiles : []).filter(item => {
            const mint = String(item?.tokenAddress || "");
            if (item?.chainId !== "solana" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || seen.has(mint) || excluded.has(mint)) return false;
            seen.add(mint); return true;
          }).slice(0, 10).map(item => ({ mint: item.tokenAddress, name: item.description || "Solana token", url: item.url || null }));
          return json({ ok: true, tokens, diagnostics });
        } catch (error) {
          return json({ error: "نەتوانرا کۆینی نوێ بدۆزرێتەوە: " + String(error?.message || error) }, 503);
        }
      }
      if (url.pathname === "/api/scan" && request.method === "POST") {
        try {
          const body = await request.json();
          const mint = String(body.mint || "").trim();
          if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: "ئادرەسی کۆین دروست نییە" }, 400);
          const result = await inspectMint(mint, env);
          const market = result.market;
          const tx = market.txns?.h24 || {};
          const data = {
            tokenAddress: mint, ok: result.ok, reasons: result.reasons,
            name: market.baseToken?.name || "Unknown token",
            tick: market.baseToken?.symbol || "", price: result.price,
            chg: Number(market.priceChange?.h24 || 0), holders: null,
            holderAccountsChecked: result.holderAccountsChecked,
            buys: Number(tx.buys || 0), sells: Number(tx.sells || 0),
            vol: Number(market.volume?.h24 || 0), liq: Number(market.liquidity?.usd || 0),
            top: result.top, mint: result.mintAuthority, freeze: result.freezeAuthority,
            largestPct: result.largestPct, topTenPct: result.topTenPct,
            rugScore: result.rugScore, pairAddress: market.pairAddress || null,
            dexUrl: market.url || null, imageUrl: market.imageUrl || market.info?.imageUrl || null
          };
          const state = await readState(env);
          state.lastScanReport = [{ mint, status: result.ok ? "passed" : "rejected", reasons: result.reasons, scannedAt: new Date().toISOString() }, ...state.lastScanReport].slice(0, 20);
          // Persist the most recent complete scan so the four dashboard metrics survive refreshes.
          state.lastScanData = data;
          await saveState(env, state);
          return json({ ok: true, data });
        } catch (error) {
          return json({ error: "پشکنینی کۆین سەرکەوتوو نەبوو: " + String(error?.message || error) }, 503);
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
      if (url.pathname === "/api/state" && request.method === "GET") return json(await readState(env));
      // State mutations are limited to validated paper-buy and automation routes.
      if (url.pathname === "/api/paper-buy" && request.method === "POST") {
        try {
          const body = await request.json();
          const mint = String(body.mint || "").trim();
          if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json({ error: "ئادرەسی کۆین دروست نییە" }, 400);
          const state = await readState(env);
          if (state.balance < 5) return json({ error: "باڵانسی دیمۆ بۆ کڕینی $5 بەس نییە" }, 409);
          if (state.trades.filter(t => !t.sold).length >= 10) return json({ error: "زۆرترین ژمارەی پۆزیشنی کراوە ١٠ دانەیە" }, 409);
          if (state.trades.some(t => t.mint === mint)) return json({ error: "ئەم کۆینە پێشتر لە تاقیکردنەوەدا کڕدراوە" }, 409);
          const result = await inspectMint(mint, env);
          if (!result.ok) return json({ error: "کڕینی دیمۆ ڕێگەپێنەدرا؛ پشکنینی سەلامەتی تێنەپەڕاند: " + result.reasons.join("؛ "), reasons: result.reasons }, 409);
          state.balance = Number((state.balance - 5).toFixed(2));
          const trade = {
            mint, amount: 5, buyPrice: result.price, currentPrice: result.price,
            tokens: 5 / result.price, sold: false, boughtAt: new Date().toISOString(),
            mode: "paper", riskChecks: "passed"
          };
          state.trades.push(trade);
          await saveState(env, state);
          return json({ ok: true, trade, state });
        } catch (error) {
          return json({ error: "کڕینی دیمۆ سەرکەوتوو نەبوو: " + String(error?.message || error) }, 503);
        }
      }
      if (url.pathname === "/api/clear-closed-trades" && request.method === "POST") {
        try {
          const state = await readState(env);
          const before = state.trades.length;
          state.trades = state.trades.filter(trade => !trade.sold);
          const removed = before - state.trades.length;
          await saveState(env, state);
          return json({ ok: true, removed, balance: state.balance, state });
        } catch {
          return json({ error: "نەتوانرا مامەڵە داخراوەکان پاک بکرێنەوە" }, 500);
        }
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
          "X-Solana-Smart-Bot-Build": BUILD_ID
        }
      });
    }

    const assetHeaders = new Headers(assetResponse.headers);
    assetHeaders.set("X-Solana-Smart-Bot-Build", BUILD_ID);
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
