const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const EXPECTED_BOT_WALLET = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const JUPITER_ORDER_URL = "https://api.jup.ag/swap/v2/order";
const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/SOL-USD/spot";
const DEX_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens/";
const RUGCHECK_URL = "https://api.rugcheck.xyz/v1/tokens/";
const DEVNET_OR_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const RISKY_TOKEN_2022_EXTENSIONS = new Set([6, 9, 12, 14, 26]);

function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(label + " is missing or invalid");
  return number;
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(new URL(url).hostname + " returned HTTP " + response.status);
  return response.json();
}

/** Fetches and timestamps the quote on the trusted server; caller timestamps are never used. */
export async function fetchTrustedSolUsdQuote(fetchImpl = fetch) {
  const fetchedAt = Date.now();
  const payload = await fetchJson(fetchImpl, COINBASE_SPOT_URL, {
    headers: { Accept: "application/json" }
  });
  const price = positive(payload?.data?.amount, "Coinbase SOL/USD price");
  if (payload?.data?.base !== "SOL" || payload?.data?.currency !== "USD") {
    throw new Error("Coinbase returned an unexpected SOL/USD quote");
  }
  return Object.freeze({
    provider: "Coinbase",
    pair: "SOL/USD",
    price,
    fetchedAt,
    quoteId: "coinbase-sol-usd-" + fetchedAt
  });
}

async function fetchCompleteMintTokenAccounts(mint, fetchImpl, alchemyApiKey) {
  if (typeof alchemyApiKey !== "string" || alchemyApiKey.length < 16) {
    throw new Error("Alchemy API key is required for complete paginated holder verification");
  }
  const endpoint = "https://solana-mainnet.g.alchemy.com/v2/" + encodeURIComponent(alchemyApiKey);
  const limit = 1000;
  const accounts = [];
  for (let page = 1; page <= 100; page++) {
    const payload = await fetchJson(fetchImpl, endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: page,
        method: "getTokenAccounts",
        params: { mintAddress: mint, page, limit, options: { showZeroBalance: false } }
      })
    });
    if (payload.error) throw new Error("Alchemy getTokenAccounts failed");
    const result = payload.result;
    const rows = result?.token_accounts;
    if (!Array.isArray(rows)) throw new Error("Alchemy holder page has an invalid response shape");
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      throw new Error("Alchemy holder page reported indexing errors");
    }
    for (const row of rows) {
      const rawAmount = String(row.amount);
      if (row.mint !== mint || typeof row.owner !== "string" ||
          !/^\d+$/.test(rawAmount) || BigInt(rawAmount) <= 0n) {
        throw new Error("Alchemy holder page contains incomplete or mismatched account data");
      }
      accounts.push({ owner: row.owner, amount: BigInt(rawAmount) });
    }
    if (rows.length < limit) {
      if (accounts.length === 0) throw new Error("No positive-balance token accounts were found");
      return accounts;
    }
  }
  throw new Error("Holder pagination exceeded the 100-page safety limit");
}

async function fetchTrustedSellRoute(mint, priceUsd, supplyAmount, decimals, fetchImpl, jupiterApiKey) {
  if (typeof jupiterApiKey !== "string" || jupiterApiKey.trim().length < 16) {
    throw new Error("Jupiter API key is required for server-side sell-route verification");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Token decimals are unavailable for sell-route verification");
  }
  const priceText = String(priceUsd);
  const match = /^(\d+)(?:\\.(\d+))?$/.exec(priceText);
  if (!match) throw new Error("Token USD price format is unsupported for sell-route verification");
  const priceScaled = BigInt(match[1] + (match[2] || "").padEnd(12, "0").slice(0, 12));
  if (priceScaled <= 0n) throw new Error("Token USD price is invalid for sell-route verification");
  const amount = (3n * (10n ** BigInt(decimals)) * 1_000_000_000_000n) / priceScaled;
  const maxProbeAmount = supplyAmount / 100n;
  if (amount <= 0n || maxProbeAmount <= 0n || amount > maxProbeAmount) {
    throw new Error("A $3 sell-route probe would exceed 1% of token supply or is below token precision");
  }
  const params = new URLSearchParams({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: amount.toString(),
    taker: EXPECTED_BOT_WALLET,
    slippageBps: "50"
  });
  const order = await fetchJson(fetchImpl, JUPITER_ORDER_URL + "?" + params.toString(), {
    headers: { "x-api-key": jupiterApiKey.trim(), Accept: "application/json" }
  });
  if (!order || typeof order !== "object" ||
      typeof order.requestId !== "string" || !order.requestId ||
      typeof order.transaction !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(order.transaction) ||
      order.inputMint !== mint || order.outputMint !== SOL_MINT ||
      String(order.inAmount) !== amount.toString() ||
      !/^\d+$/.test(String(order.outAmount || "")) || BigInt(order.outAmount) <= 0n ||
      !Array.isArray(order.routePlan) || order.routePlan.length === 0) {
    throw new Error("Jupiter did not return a complete executable sell order route");
  }
  return Object.freeze({
    provider: "Jupiter Swap API V2",
    requestId: order.requestId,
    inputAmount: amount.toString(),
    outputLamports: String(order.outAmount),
    router: String(order.router || "unknown"),
    routePlanCount: order.routePlan.length
  });
}

async function rpc(fetchImpl, method, params) {
  const payload = await fetchJson(fetchImpl, DEVNET_OR_MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (payload.error || !("result" in payload)) {
    throw new Error(method + " RPC response is incomplete");
  }
  return payload.result;
}

function parseMintAccount(account) {
  const value = account?.value;
  if (!value) throw new Error("Mint account is unavailable");
  const parsed = value.data?.parsed?.info;
  if (parsed) {
    // Only the classic SPL Token program is treated as extension-free.
    // Token-2022 is allowed only when the RPC explicitly returns an empty
    // extensions array; missing or unknown program metadata fails closed.
    const tokenProgram = value.owner;
    const token2022ExtensionsSafe =
      tokenProgram === TOKEN_PROGRAM_ID ||
      (tokenProgram === TOKEN_2022_PROGRAM_ID &&
        Array.isArray(parsed.extensions) && parsed.extensions.length === 0);
    return {
      mintAuthoritySafe: parsed.mintAuthority == null,
      freezeAuthoritySafe: parsed.freezeAuthority == null,
      token2022ExtensionsSafe
    };
  }
  const raw = value.data;
  if (!Array.isArray(raw) || typeof raw[0] !== "string") {
    throw new Error("Mint account encoding is unsupported");
  }
  const bytes = Uint8Array.from(atob(raw[0]), char => char.charCodeAt(0));
  if (bytes.length < 82) throw new Error("Mint account data is truncated");
  const u32 = offset => (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  const mintOption = u32(0);
  const freezeOption = u32(46);
  if (mintOption > 1 || freezeOption > 1) throw new Error("Mint authority layout is invalid");
  const extensions = [];
  if (bytes.length >= 166) {
    let offset = 166;
    while (offset + 4 <= bytes.length) {
      const type = bytes[offset] | (bytes[offset + 1] << 8);
      const length = bytes[offset + 2] | (bytes[offset + 3] << 8);
      if (type === 0 && length === 0) break;
      if (offset + 4 + length > bytes.length) throw new Error("Token-2022 extension data is truncated");
      extensions.push(type);
      offset += 4 + length;
    }
  }
  return {
    mintAuthoritySafe: mintOption === 0,
    freezeAuthoritySafe: freezeOption === 0,
    token2022ExtensionsSafe: !extensions.some(type => RISKY_TOKEN_2022_EXTENSIONS.has(type))
  };
}

/**
 * Risk evidence is generated from server-fetched feeds for the exact mint.
 * The largest-20-account sample is NOT a complete holder census, so this
 * module intentionally never marks holderConcentrationSafe true.
 */
export async function fetchTrustedTokenRisk(mint, fetchImpl = fetch, alchemyApiKey = "", jupiterApiKey = "") {
  if (typeof mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || mint === SOL_MINT) {
    throw new Error("A valid non-SOL output mint is required for risk inspection");
  }
  const [dex, rug, mintAccount, supply, holderAccounts] = await Promise.all([
    fetchJson(fetchImpl, DEX_TOKEN_URL + encodeURIComponent(mint)),
    fetchJson(fetchImpl, RUGCHECK_URL + encodeURIComponent(mint) + "/report"),
    rpc(fetchImpl, "getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]),
    rpc(fetchImpl, "getTokenSupply", [mint, { commitment: "confirmed" }]),
    fetchCompleteMintTokenAccounts(mint, fetchImpl, alchemyApiKey)
  ]);
  const pair = (dex?.pairs || [])
    .filter(item => item.chainId === "solana" && item.baseToken?.address === mint)
    .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  if (!pair) throw new Error("No verified Solana market pair for the requested mint");
  const liquidityUsd = positive(pair.liquidity?.usd, "Solana pair liquidity");
  const volume24hUsd = positive(pair.volume?.h24, "Solana pair 24-hour volume");
  const priceUsd = positive(pair.priceUsd, "Solana pair price");
  const sells24h = Number(pair.txns?.h24?.sells);
  if (!Number.isFinite(sells24h)) throw new Error("Solana pair sell-count data is unavailable");
  if (rug?.score == null || !Number.isFinite(Number(rug.score))) {
    throw new Error("RugCheck score is unavailable");
  }
  const mintSafety = parseMintAccount(mintAccount);
  const rawSupplyAmount = String(supply?.value?.amount ?? "");
  if (!/^\d+$/.test(rawSupplyAmount) || BigInt(rawSupplyAmount) <= 0n || holderAccounts.length === 0) {
    throw new Error("Holder account data is incomplete");
  }

  // Alchemy DAS pages every positive-balance token account for this mint.
  // Aggregate multiple token accounts belonging to the same wallet owner.
  const supplyAmount = BigInt(rawSupplyAmount);
  const ownerBalances = new Map();
  let totalAccountBalance = 0n;
  for (const account of holderAccounts) {
    ownerBalances.set(account.owner, (ownerBalances.get(account.owner) || 0n) + account.amount);
    totalAccountBalance += account.amount;
  }
  if (ownerBalances.size === 0 || totalAccountBalance !== supplyAmount) {
    throw new Error("Complete holder census does not reconcile to on-chain token supply");
  }
  const topTenBalance = [...ownerBalances.values()].sort((a, b) => a > b ? -1 : a < b ? 1 : 0)
    .slice(0, 10).reduce((sum, amount) => sum + amount, 0n);
  const concentrationScaled = (topTenBalance * 1_000_000n) / supplyAmount;
  const top10OwnerConcentrationPct = Number(concentrationScaled) / 10_000;
  const sellRoute = await fetchTrustedSellRoute(
    mint,
    pair.priceUsd,
    supplyAmount,
    supply?.value?.decimals,
    fetchImpl,
    jupiterApiKey
  );

  const checks = {
    mintAuthoritySafe: mintSafety.mintAuthoritySafe,
    freezeAuthoritySafe: mintSafety.freezeAuthoritySafe,
    token2022ExtensionsSafe: mintSafety.token2022ExtensionsSafe,
    holderConcentrationSafe: top10OwnerConcentrationPct <= 50,
    sellRouteAvailable: true,
    marketLiquiditySafe: liquidityUsd >= 10000,
    marketVolumeSafe: volume24hUsd >= 1000 && sells24h > 0,
    rugCheckSafe: Number(rug.score) <= 2500
  };
  return Object.freeze({
    mint,
    provider: "DexScreener + RugCheck + Solana mainnet RPC",
    fetchedAt: Date.now(),
    priceUsd,
    liquidityUsd,
    volume24hUsd,
    sells24h,
    rugScore: Number(rug.score),
    holderAccountCount: holderAccounts.length,
    holderOwnerCount: ownerBalances.size,
    holderSampleOnly: false,
    top10OwnerConcentrationPct,
    sellRoute,
    checks,
    passed: Object.values(checks).every(value => value === true)
  });
}

export async function fetchTrustedLiveEvidence(mint, fetchImpl = fetch, alchemyApiKey = "", jupiterApiKey = "") {
  const [quote, risk] = await Promise.all([
    fetchTrustedSolUsdQuote(fetchImpl),
    fetchTrustedTokenRisk(mint, fetchImpl, alchemyApiKey, jupiterApiKey)
  ]);
  return Object.freeze({ quote, risk, passed: risk.passed });
}
