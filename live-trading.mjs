/**
 * Solana live-trading preparation module.
 *
 * This module is deliberately NOT wired into the Worker scheduler or HTTP API.
 * It can obtain and validate a Jupiter order, but it cannot sign or submit it.
 * Mainnet execution remains impossible until a reviewed signer and transaction
 * validation implementation are added and LIVE_TRADING_ENABLED is explicitly
 * enabled in a later, separately reviewed change.
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function finitePositive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(name + " must be a positive finite number");
  return n;
}

function readLivePolicy(env = {}) {
  // Strict opt-in. Any missing or unexpected value means disabled.
  const enabled = env.LIVE_TRADING_ENABLED === "true";
  const wallet = String(env.BOT_WALLET_PUBLIC_KEY || "").trim();
  const maxTradeLamports = Number(env.LIVE_MAX_TRADE_LAMPORTS);
  const maxDailyLamports = Number(env.LIVE_MAX_DAILY_LAMPORTS);
  const maxSlippageBps = Number(env.LIVE_MAX_SLIPPAGE_BPS);
  const minLiquidityUsd = Number(env.LIVE_MIN_LIQUIDITY_USD);
  const minVolume24hUsd = Number(env.LIVE_MIN_VOLUME_24H_USD);
  const maxOpenPositions = Number(env.LIVE_MAX_OPEN_POSITIONS);

  if (!enabled) return Object.freeze({ enabled: false, reason: "LIVE_TRADING_ENABLED is not exactly true" });
  if (!BASE58.test(wallet)) throw new Error("BOT_WALLET_PUBLIC_KEY is missing or invalid");
  if (!Number.isSafeInteger(maxTradeLamports) || maxTradeLamports <= 0) throw new Error("LIVE_MAX_TRADE_LAMPORTS must be a positive integer");
  if (!Number.isSafeInteger(maxDailyLamports) || maxDailyLamports < maxTradeLamports) throw new Error("LIVE_MAX_DAILY_LAMPORTS must be an integer at least as large as the trade limit");
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 1 || maxSlippageBps > 100) throw new Error("LIVE_MAX_SLIPPAGE_BPS must be between 1 and 100");
  finitePositive(minLiquidityUsd, "LIVE_MIN_LIQUIDITY_USD");
  finitePositive(minVolume24hUsd, "LIVE_MIN_VOLUME_24H_USD");
  if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 10) throw new Error("LIVE_MAX_OPEN_POSITIONS must be between 1 and 10");

  if (!String(env.JUPITER_API_KEY || "").trim()) throw new Error("JUPITER_API_KEY is required");
  return Object.freeze({
    enabled: true,
    wallet,
    maxTradeLamports,
    maxDailyLamports,
    maxSlippageBps,
    minLiquidityUsd,
    minVolume24hUsd,
    maxOpenPositions
  });
}

/**
 * Fetch a server-side Jupiter V2 order. This returns an unsigned transaction
 * only; it must never be passed to /execute until a reviewed signer validates
 * and signs it.
 */
async function getJupiterOrder({ env, inputMint = SOL_MINT, outputMint, amountLamports, fetchImpl = fetch }) {
  const policy = readLivePolicy(env);
  if (!policy.enabled) throw new Error("Live trading is disabled");
  if (!BASE58.test(String(inputMint)) || !BASE58.test(String(outputMint))) throw new Error("Invalid token mint");
  if (inputMint === outputMint) throw new Error("Input and output mints must differ");
  if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0 || amountLamports > policy.maxTradeLamports) {
    throw new Error("Trade amount exceeds the configured per-trade limit");
  }

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountLamports),
    taker: policy.wallet,
    slippageBps: String(policy.maxSlippageBps)
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
      typeof order.transaction !== "string" || !order.transaction ||
      !/^\d+$/.test(String(order.outAmount || "")) ||
      BigInt(order.outAmount) <= 0n ||
      !Array.isArray(order.routePlan) || order.routePlan.length === 0) {
    throw new Error("Jupiter returned an incomplete or non-executable order");
  }
  return Object.freeze({
    requestId: order.requestId,
    transaction: order.transaction,
    inputMint,
    outputMint,
    inputAmount: String(amountLamports),
    outputAmount: String(order.outAmount),
    router: String(order.router || "unknown"),
    transactionVersion: order.transactionVersion ?? 0,
    feeBps: Number.isFinite(Number(order.feeBps)) ? Number(order.feeBps) : null
  });
}

/**
 * Hard stop: do not add a naive signer or submit implementation here.
 * A production signer must deserialize the Solana message, validate every
 * program/account/instruction and token destination, then sign with a
 * dedicated key-management boundary before Jupiter /execute.
 */
async function executeLiveOrder() {
  throw new Error("Live execution is not implemented; no transaction was signed or submitted");
}

export { SOL_MINT, readLivePolicy, getJupiterOrder, executeLiveOrder };
