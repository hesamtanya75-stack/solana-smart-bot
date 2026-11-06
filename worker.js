const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STATE = {
  balance: 100,
  trades: [],
  autoEnabled: false,
  paused: false,
  scannedMints: [],
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
  {
    const fallback = RPCS[rpcCursor++ % RPCS.length];
    endpoints.push({ url: fallback, label: new URL(fallback).hostname });
  }
  if (!env?.ALCHEMY_API_KEY || alchemyUnauthorized) {
    for (let i = 0; i < Math.min(2, RPCS.length); i++) {
      const fallback = RPCS[rpcCursor++ % RPCS.length];
      endpoints.push({ url: fallback, label: new URL(fallback).hostname });
    }
  }

  // Keep each RPC method to at most two outbound requests per Worker invocation.
  for (const endpoint of endpoints.slice(0, 2)) {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || "RPC error");
      return data.result;
    } catch (error) {
      const message = String(error?.message || error);
      if (endpoint.label === "Alchemy Solana RPC" && message === "HTTP 401") {
        alchemyUnauthorized = true;
      }
      errors.push(endpoint.label + ": " + message);
    }
  }
  throw new Error("Solana RPC providers failed (max 2 per method) — " + errors.join(" | "));
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
  // Reuse recent DexScreener responses across overlapping cron/API work.
  // Cache failures are non-fatal; live data remains the fallback.
  let cacheKey;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    cacheKey = "dex_cache:" + hash;
    const cached = await env.BOT_STATE.get(cacheKey, "json");
    if (cached && cached.savedAt && Date.now() - cached.savedAt < ttlSeconds * 1000) {
      return cached.data;
    }
  } catch (error) {
    console.warn("DexScreener cache read warning", String(error?.message || error));
  }

  const data = await getJson(url);
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
  const [dex, rug, account, largest, supply] = await Promise.all([
    getDexJson("https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(mint), env, 90),
    getJson("https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(mint) + "/report"),
    rpc("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }], env),
    rpc("getTokenLargestAccounts", [mint, { commitment: "confirmed" }], env),
    rpc("getTokenSupply", [mint, { commitment: "confirmed" }], env)
  ]);
  const market = (dex.pairs || []).filter(p => p.chainId === "solana")
    .sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  if (!market) throw new Error("No Solana market pair");
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
  const profiles = await getDexJson("https://api.dexscreener.com/token-profiles/latest/v1", env, 90);
  const tokens = Array.isArray(profiles) ? profiles.filter(t => t.chainId === "solana" && t.tokenAddress) : [];
  let checked = 0, bought = 0;
  const report = [];
  for (const token of tokens) {
    if (checked >= 3 || state.balance < 5 || state.trades.filter(t => !t.sold).length >= 10) break;
    const mint = token.tokenAddress;
    if (state.scannedMints.includes(mint) || state.trades.some(t => t.mint === mint)) continue;
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
      report.push({ mint, status: "blocked-error", reasons: [String(error?.message || "داتای پشکنین بەردەست نییە")] });
      // Unknown or unavailable data always means no simulated purchase.
    }
  }
  state.scannedMints = state.scannedMints.slice(-1000);
  state.lastScanReport = report.slice(-20);
  return "Checked " + checked + " new tokens (max 3 per cycle); paper buys: " + bought + ". " + report.filter(x => x.status !== "bought-paper").length + " blocked; reasons saved in scan report.";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, mode: "paper-trading", scheduler: "Cloudflare Cron", storage: "Workers KV" });
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
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + SESSION_MS;
        await env.BOT_STATE.put("session:" + token, JSON.stringify({ expiresAt }), { expirationTtl: Math.ceil(SESSION_MS / 1000) });
        return json({ ok: true, token });
      } catch { return json({ error: "داواکاری هەڵەیە" }, 400); }
    }
    if (url.pathname.startsWith("/api/")) {
      if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);
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
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const startedAt = Date.now();
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
      state.lastMessage = warnings.length
        ? "Server cycle completed with warning. Sold: " + sold + ". " +
          (buyMessage || "Auto-buy not completed.") + " " + warnings.join(" | ")
        : "Server cycle complete. Sold: " + sold + ". " + buyMessage;
      await saveState(env, state);

      // Safe operational log: never include secrets, wallet data, or API keys.
      console.info("Server cycle finished", {
        sold,
        message: buyMessage,
        warnings,
        openTrades: state.trades.filter(t => !t.sold).length,
        scannedMints: state.scannedMints.length,
        durationMs: Date.now() - startedAt
      });
    })());
  }
};
