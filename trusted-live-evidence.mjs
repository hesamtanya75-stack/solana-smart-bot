const SOL_MINT = "So11111111111111111111111111111111111111112";
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
    return {
      mintAuthoritySafe: parsed.mintAuthority == null,
      freezeAuthoritySafe: parsed.freezeAuthority == null,
      token2022ExtensionsSafe: true
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
export async function fetchTrustedTokenRisk(mint, fetchImpl = fetch) {
  if (typeof mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || mint === SOL_MINT) {
    throw new Error("A valid non-SOL output mint is required for risk inspection");
  }
  const [dex, rug, mintAccount, largest, supply] = await Promise.all([
    fetchJson(fetchImpl, DEX_TOKEN_URL + encodeURIComponent(mint)),
    fetchJson(fetchImpl, RUGCHECK_URL + encodeURIComponent(mint) + "/report"),
    rpc(fetchImpl, "getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]),
    rpc(fetchImpl, "getTokenLargestAccounts", [mint, { commitment: "confirmed" }]),
    rpc(fetchImpl, "getTokenSupply", [mint, { commitment: "confirmed" }])
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
  const supplyAmount = Number(supply?.value?.amount);
  const largestAccounts = largest?.value;
  if (!Number.isFinite(supplyAmount) || supplyAmount <= 0 ||
      !Array.isArray(largestAccounts) || largestAccounts.length === 0) {
    throw new Error("Holder account data is incomplete");
  }

  // Owner aggregation over the largest 20 is only a lower-bound sample.
  // Never present it as a verified top-ten wallet concentration result.
  const sampleAddresses = largestAccounts.slice(0, 20).map(item => item.address);
  const ownerResult = await rpc(fetchImpl, "getMultipleAccounts", [
    sampleAddresses, { encoding: "jsonParsed", commitment: "confirmed" }
  ]);
  const ownerBalances = new Map();
  for (const account of ownerResult?.value || []) {
    const info = account?.data?.parsed?.info;
    const owner = info?.owner;
    const amount = Number(info?.tokenAmount?.amount);
    if (!owner || !Number.isFinite(amount) || amount < 0) {
      throw new Error("Holder owner aggregation is incomplete");
    }
    ownerBalances.set(owner, (ownerBalances.get(owner) || 0) + amount);
  }
  if (ownerBalances.size === 0) throw new Error("Holder owners could not be resolved");

  const checks = {
    mintAuthoritySafe: mintSafety.mintAuthoritySafe,
    freezeAuthoritySafe: mintSafety.freezeAuthoritySafe,
    token2022ExtensionsSafe: mintSafety.token2022ExtensionsSafe,
    holderConcentrationSafe: false,
    sellRouteAvailable: false,
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
    sampleOwnerCount: ownerBalances.size,
    holderSampleOnly: true,
    checks,
    passed: Object.values(checks).every(value => value === true)
  });
}

export async function fetchTrustedLiveEvidence(mint, fetchImpl = fetch) {
  const [quote, risk] = await Promise.all([
    fetchTrustedSolUsdQuote(fetchImpl),
    fetchTrustedTokenRisk(mint, fetchImpl)
  ]);
  return Object.freeze({ quote, risk, passed: risk.passed });
}
