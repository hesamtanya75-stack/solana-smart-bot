/**
 * Solana live-trading preparation module.
 * Server-side Jupiter V2 order retrieval only; no signing or submission.
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const EXPECTED_BOT_WALLET = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function finitePositive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(name + " must be a positive finite number");
  return n;
}

function readLivePolicy(env = {}) {
  if (env.LIVE_TRADING_ENABLED !== "true") {
    return Object.freeze({ enabled: false, reason: "Live trading feature flag is not explicitly enabled" });
  }
  if (env.LIVE_TRADING_KILL_SWITCH !== "false") {
    return Object.freeze({ enabled: false, reason: "Emergency kill switch is active" });
  }
  const configuredWallet = String(env.BOT_WALLET_PUBLIC_KEY || "").trim();
  if (configuredWallet !== EXPECTED_BOT_WALLET) {
    throw new Error("Configured bot wallet does not match the pinned dedicated wallet");
  }

  const maxTradeLamports = Number(env.LIVE_MAX_TRADE_LAMPORTS);
  const maxDailyLamports = Number(env.LIVE_MAX_DAILY_LAMPORTS);
  const maxSlippageBps = Number(env.LIVE_MAX_SLIPPAGE_BPS);
  const minLiquidityUsd = Number(env.LIVE_MIN_LIQUIDITY_USD);
  const minVolume24hUsd = Number(env.LIVE_MIN_VOLUME_24H_USD);
  const maxOpenPositions = Number(env.LIVE_MAX_OPEN_POSITIONS);

  if (!Number.isSafeInteger(maxTradeLamports) || maxTradeLamports <= 0) throw new Error("LIVE_MAX_TRADE_LAMPORTS must be a positive integer");
  if (!Number.isSafeInteger(maxDailyLamports) || maxDailyLamports < maxTradeLamports) throw new Error("LIVE_MAX_DAILY_LAMPORTS must be an integer at least as large as the trade limit");
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 1 || maxSlippageBps > 100) throw new Error("LIVE_MAX_SLIPPAGE_BPS must be between 1 and 100");
  finitePositive(minLiquidityUsd, "LIVE_MIN_LIQUIDITY_USD");
  finitePositive(minVolume24hUsd, "LIVE_MIN_VOLUME_24H_USD");
  if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 10) throw new Error("LIVE_MAX_OPEN_POSITIONS must be between 1 and 10");
  if (!String(env.JUPITER_API_KEY || "").trim()) throw new Error("JUPITER_API_KEY is required");

  return Object.freeze({
    enabled: true, wallet: EXPECTED_BOT_WALLET, maxTradeLamports,
    maxDailyLamports, maxSlippageBps, minLiquidityUsd, minVolume24hUsd,
    maxOpenPositions
  });
}

/**
 * All state and risk-check values must come from trusted, fresh server-side
 * sources. Missing values fail closed; browser-supplied values are not trusted.
 */
function evaluateLiveTradeEligibility({
  policy, amountLamports, dailySpentLamports, openPositions,
  liquidityUsd, volume24hUsd, riskChecks
} = {}) {
  if (!policy || policy.enabled !== true) throw new Error("Live trading policy is disabled");
  if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0 || amountLamports > policy.maxTradeLamports) {
    throw new Error("Trade amount exceeds the configured per-trade limit");
  }
  if (!Number.isSafeInteger(dailySpentLamports) || dailySpentLamports < 0 ||
      dailySpentLamports > policy.maxDailyLamports ||
      amountLamports > policy.maxDailyLamports - dailySpentLamports) {
    throw new Error("Trade would exceed the configured daily spend limit");
  }
  if (!Number.isInteger(openPositions) || openPositions < 0 || openPositions >= policy.maxOpenPositions) {
    throw new Error("Maximum open positions reached or position count is unavailable");
  }
  if (!Number.isFinite(liquidityUsd) || liquidityUsd < policy.minLiquidityUsd) {
    throw new Error("Token liquidity is below the configured minimum or unavailable");
  }
  if (!Number.isFinite(volume24hUsd) || volume24hUsd < policy.minVolume24hUsd) {
    throw new Error("Token 24-hour volume is below the configured minimum or unavailable");
  }
  const requiredChecks = [
    "mintAuthoritySafe", "freezeAuthoritySafe", "token2022ExtensionsSafe",
    "holderConcentrationSafe", "sellRouteAvailable"
  ];
  if (!riskChecks || requiredChecks.some((key) => riskChecks[key] !== true)) {
    throw new Error("Token safety checks are missing or did not all pass");
  }
  return Object.freeze({ allowed: true });
}

/**
 * Retrieves an unsigned Jupiter V2 order only. It does not decode or approve
 * transaction instructions, sign, or submit a transaction.
 */
async function getJupiterOrder({
  env, inputMint = SOL_MINT, outputMint, amountLamports, eligibility,
  fetchImpl = fetch
}) {
  const policy = readLivePolicy(env);
  if (!policy.enabled) throw new Error(policy.reason || "Live trading is disabled");
  evaluateLiveTradeEligibility({ ...(eligibility || {}), policy, amountLamports });

  if (!BASE58.test(String(inputMint)) || !BASE58.test(String(outputMint))) throw new Error("Invalid token mint");
  if (inputMint === outputMint) throw new Error("Input and output mints must differ");

  const params = new URLSearchParams({
    inputMint, outputMint, amount: String(amountLamports),
    taker: policy.wallet, slippageBps: String(policy.maxSlippageBps)
  });
  const response = await fetchImpl("https://api.jup.ag/swap/v2/order?" + params.toString(), {
    method: "GET",
    headers: { "x-api-key": String(env.JUPITER_API_KEY).trim(), "Accept": "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Jupiter order request failed with HTTP " + response.status);
  const order = await response.json();

  if (!order || typeof order !== "object" ||
      typeof order.requestId !== "string" || !order.requestId ||
      typeof order.transaction !== "string" || order.transaction.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(order.transaction) ||
      !/^[0-9]+$/.test(String(order.inAmount || "")) ||
      String(order.inAmount) !== String(amountLamports) ||
      order.inputMint !== inputMint || order.outputMint !== outputMint ||
      !/^[0-9]+$/.test(String(order.outAmount || "")) ||
      BigInt(order.outAmount) <= 0n ||
      !Array.isArray(order.routePlan) || order.routePlan.length === 0) {
    throw new Error("Jupiter returned an incomplete or non-executable order");
  }
  // Fail closed: syntactically valid Base64 is not proof of a valid or safe
  // Solana transaction. Until a real message decoder resolves address lookup
  // tables and validates every instruction/program/account against an explicit
  // reviewed allow-list, do not return an opaque transaction to any caller.
  throw new Error("Transaction decoder and program/account allow-list are not implemented; refusing opaque Jupiter transaction");
}

async function executeLiveOrder() {
  throw new Error("Live execution is not implemented; no transaction was signed or submitted");
}

export {
  SOL_MINT, EXPECTED_BOT_WALLET, readLivePolicy,
  evaluateLiveTradeEligibility, getJupiterOrder, executeLiveOrder
};
