/**
 * Solana live-trading preparation module.
 * Server-side Jupiter V2 order retrieval only; no signing or submission.
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
import { isCanonicalPublicKey, validateAndResolveUnsignedJupiterTransaction } from "./trusted-live-evidence.mjs";
import { readBoundedJsonResponse } from "./rpc-response.mjs";

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
    enabled: true, maxTradeLamports,
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
  takerWallet, fetchImpl = fetch
}) {
  const policy = readLivePolicy(env);
  if (!policy.enabled) throw new Error(policy.reason || "Live trading is disabled");
  evaluateLiveTradeEligibility({ ...(eligibility || {}), policy, amountLamports });

  if (!isCanonicalPublicKey(takerWallet)) throw new Error("A valid connected Phantom public key is required");
  if (!BASE58.test(String(inputMint)) || !BASE58.test(String(outputMint))) throw new Error("Invalid token mint");
  if (inputMint === outputMint) throw new Error("Input and output mints must differ");

  // The connected Phantom wallet is the taker and sole expected signer.
  // The public key is not signing material; Phantom retains custody of the key.
  // Exclude JupiterZ and accept only an explicitly returned Metis order below;
  // every other router remains fail-closed.
  const params = new URLSearchParams({
    inputMint, outputMint, amount: String(amountLamports),
    taker: takerWallet,
    excludeRouters: "jupiterz",
    slippageBps: String(policy.maxSlippageBps)
  });
  const response = await fetchImpl("https://api.jup.ag/swap/v2/order?" + params.toString(), {
    method: "GET",
    headers: { "x-api-key": String(env.JUPITER_API_KEY).trim(), "Accept": "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Jupiter order request failed with HTTP " + response.status);
  const order = await readBoundedJsonResponse(response);

  if (!order || typeof order !== "object" ||
      typeof order.requestId !== "string" || !/^[!-~]{1,256}$/.test(order.requestId) ||
      typeof order.transaction !== "string" || order.transaction.length === 0 ||
      order.transaction.length > 1644 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(order.transaction) ||
      !/^[0-9]+$/.test(String(order.inAmount || "")) ||
      String(order.inAmount) !== String(amountLamports) ||
      order.inputMint !== inputMint || order.outputMint !== outputMint ||
      order.router !== "metis" ||
      !/^(?:0|[1-9][0-9]*)$/.test(String(order.outAmount || "")) ||
      String(order.outAmount).length > 20 ||
      BigInt(order.outAmount) <= 0n || BigInt(order.outAmount) > 18446744073709551615n ||
      (order.feeBps != null && (!Number.isInteger(order.feeBps) || order.feeBps < 0 || order.feeBps > 10000)) ||
      !Array.isArray(order.routePlan) || order.routePlan.length === 0 || order.routePlan.length > 64) {
    throw new Error("Jupiter returned an incomplete or non-executable order");
  }
  const transactionEvidence = await validateAndResolveUnsignedJupiterTransaction(
    order.transaction, takerWallet, fetchImpl
  );
  return Object.freeze({
    requestId: order.requestId, transaction: order.transaction,
    inputMint, outputMint, inputAmount: String(amountLamports),
    outputAmount: String(order.outAmount), router: String(order.router || "unknown"),
    transactionVersion: transactionEvidence.messageVersion,
    feeBps: order.feeBps != null && Number.isFinite(Number(order.feeBps)) ? Number(order.feeBps) : null,
    transactionEvidence,
    semanticInstructionVerification: false,
    routeVerification: "unsigned-structure-and-alt-only"
  });
}

async function executeLiveOrder() {
  throw new Error("Live execution is not implemented; no transaction was signed or submitted");
}

export {
  SOL_MINT, readLivePolicy,
  evaluateLiveTradeEligibility, getJupiterOrder, executeLiveOrder
};
