import { decodeSolanaTransaction } from "./solana-transaction-decoder.mjs";
import { validateDecodedSwapTransaction } from "./solana-instruction-policy.mjs";
import { validateMetisJupiterV6Instruction } from "./solana-metis-validator.mjs";
import { inspectMetisOrderWithTrustedRpc } from "./solana-trusted-rpc.mjs";

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
  liquidityUsd, volume24hUsd, riskChecks,
  riskDataFetchedAtMs, marketDataFetchedAtMs
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
  const now = Date.now();
  const isFreshTimestamp = (value) => Number.isSafeInteger(value) &&
    value <= now + 5000 && now - value <= 30000;
  if (!isFreshTimestamp(riskDataFetchedAtMs) ||
      !isFreshTimestamp(marketDataFetchedAtMs)) {
    throw new Error("Server-side price or risk data is missing, stale, or future-dated");
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
 * Retrieves and structurally inspects an unsigned Jupiter V2 order using a
 * trusted caller-supplied allow-list and ALT resolver. This generic structural
 * check does not semantically approve a swap, sign, or submit a transaction.
 */
async function getJupiterOrder({
  env, inputMint = SOL_MINT, outputMint, amountLamports, eligibility,
  fetchImpl = fetch, lookupTableResolver, transactionAllowList,
  getCurrentBlockHeight
}) {
  const policy = readLivePolicy(env);
  if (!policy.enabled) throw new Error(policy.reason || "Live trading is disabled");
  evaluateLiveTradeEligibility({ ...(eligibility || {}), policy, amountLamports });

  if (!BASE58.test(String(inputMint)) || !BASE58.test(String(outputMint))) throw new Error("Invalid token mint");
  if (inputMint === outputMint) throw new Error("Input and output mints must differ");

  const params = new URLSearchParams({
    inputMint, outputMint, amount: String(amountLamports),
    taker: policy.wallet, slippageBps: String(policy.maxSlippageBps),
    swapMode: "ExactIn", maxSupportedTransactionVersion: "0",
    excludeRouters: "jupiterz,dflow,okx"
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
  // Do not trust the Jupiter routePlan or browser values to create an allow-list.
  // A trusted server caller must supply reviewed IDs and a trusted ALT resolver.
  if (!transactionAllowList || typeof transactionAllowList !== "object") {
    throw new Error("Trusted transaction program/account allow-list is required");
  }
  // Only the Metis on-chain router is supported in this initial review scope.
  // Explicitly reject RFQ and third-party routers, gasless payers, and stale/malformed quote metadata.
  const allowedRouters = transactionAllowList.allowedRouters;
  if (!Array.isArray(allowedRouters) || allowedRouters.length !== 1 ||
      allowedRouters[0] !== "metis" || order.router !== "metis") {
    throw new Error("Only the explicitly reviewed Metis router is permitted");
  }
  if (order.mode !== "manual" || order.swapMode !== "ExactIn" ||
      order.transactionVersion !== 0 ||
      order.gasless !== false || order.signatureFeePayer !== policy.wallet) {
    throw new Error("Jupiter order mode, version, or fee payer is not approved");
  }
  if (!Number.isSafeInteger(order.feeBps) || order.feeBps < 0 || order.feeBps > 255 ||
      !BASE58.test(String(order.feeMint)) ||
      (order.feeMint !== inputMint && order.feeMint !== outputMint)) {
    throw new Error("Jupiter fee metadata is missing or inconsistent");
  }
  if (!/^[0-9]+$/.test(String(order.otherAmountThreshold || "")) ||
      BigInt(order.otherAmountThreshold) <= 0n ||
      BigInt(order.otherAmountThreshold) > BigInt(order.outAmount) ||
      order.slippageBps !== policy.maxSlippageBps) {
    throw new Error("Jupiter minimum output or slippage metadata is invalid");
  }
  if (!/^[0-9]+$/.test(String(order.lastValidBlockHeight || "")) ||
      BigInt(order.lastValidBlockHeight) <= 0n ||
      BigInt(order.lastValidBlockHeight) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Jupiter order block-height expiry is missing or invalid");
  }
  if (typeof getCurrentBlockHeight !== "function") {
    throw new Error("Trusted RPC block-height provider is required");
  }
  const currentBlockHeight = await trustedRpc.getBlockHeight();
  const lastValidBlockHeight = Number(order.lastValidBlockHeight);
  if (!Number.isSafeInteger(currentBlockHeight) || currentBlockHeight < 0 ||
      lastValidBlockHeight <= currentBlockHeight ||
      lastValidBlockHeight - currentBlockHeight > 150) {
    throw new Error("Jupiter order is expired or its block-height window is not fresh");
  }
  if (!Array.isArray(order.routePlan) || order.routePlan.some((step) => {
    const info = step?.swapInfo;
    return !info || !BASE58.test(String(info.ammKey || "")) ||
      typeof info.label !== "string" || !info.label ||
      !BASE58.test(String(info.inputMint || "")) ||
      !BASE58.test(String(info.outputMint || "")) ||
      !/^[0-9]+$/.test(String(info.inAmount || "")) ||
      !/^[0-9]+$/.test(String(info.outAmount || "")) ||
      BigInt(info.inAmount) <= 0n || BigInt(info.outAmount) <= 0n;
  })) {
    throw new Error("Jupiter route plan contains incomplete or invalid swap steps");
  }

  const decoded = await decodeSolanaTransaction(order.transaction, {
    lookupTableResolver
  });
  const jupiterInstructions = decoded.instructions.filter((item) =>
    item.programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTa4"
  );
  if (jupiterInstructions.length !== 1 || !metisPolicy ||
      !Array.isArray(metisPolicy.allowedCpiProgramIds) ||
      !Array.isArray(metisPolicy.allowedCpiAccountKeys) ||
      !Array.isArray(metisPolicy.supportingCpiProgramIds)) {
    throw new Error("Trusted Metis semantic policy and CPI allow-lists are required");
  }
  const metisInstruction = validateMetisJupiterV6Instruction({
    decoded,
    instruction: jupiterInstructions[0],
    expectedSigner: policy.wallet,
    inputMint,
    outputMint,
    inAmount: order.inAmount,
    outAmount: order.outAmount,
    slippageBps: order.slippageBps,
    platformFeeBps: order.feeBps,
    routePlan: order.routePlan,
    dexProgramBySwapVariant: metisPolicy.dexProgramBySwapVariant,
    dexLabelsBySwapVariant: metisPolicy.dexLabelsBySwapVariant,
    allowedDexProgramIds: metisPolicy.allowedDexProgramIds
  });
  const instructionValidators = {
    ...(transactionAllowList.instructionValidators || {}),
    [jupiterInstructions[0].programId]: (instruction) => ({
      allowed: instruction.index === jupiterInstructions[0].index
    })
  };
  const instructionPolicy = validateDecodedSwapTransaction({
    decoded,
    expectedSigner: policy.wallet,
    requiredAccounts: transactionAllowList.requiredAccounts,
    allowedProgramIds: transactionAllowList.allowedProgramIds,
    allowedAccountKeys: transactionAllowList.allowedAccountKeys,
    allowedWritableAccountKeys: transactionAllowList.allowedWritableAccountKeys,
    instructionValidators
  });
  const rpcInspection = await inspectMetisOrderWithTrustedRpc({
    rpc: trustedRpc,
    encodedTransaction: order.transaction,
    decoded,
    tokenAccountExpectations: metisInstruction.tokenAccountExpectations,
    allowedCpiProgramIds: metisPolicy.allowedCpiProgramIds,
    allowedCpiAccountKeys: metisPolicy.allowedCpiAccountKeys,
    requiredCpiProgramIds: metisInstruction.requiredCpiProgramIds,
    expectedCpiProgramIds: [...new Set([...metisInstruction.requiredCpiProgramIds, ...metisPolicy.supportingCpiProgramIds])],
    minContextSlot
  });

  // Inspection metadata only; no transaction bytes are returned or executed.
  return Object.freeze({
    requestId: order.requestId,
    router: order.router,
    inputMint: order.inputMint,
    outputMint: order.outputMint,
    inAmount: String(order.inAmount),
    outAmount: String(order.outAmount),
    instructionPolicy,
    metisInstruction: Object.freeze({
      instructionName: metisInstruction.instructionName,
      routeSteps: metisInstruction.routeSteps
    }),
    rpcInspection
  });
}

async function executeLiveOrder() {
  throw new Error("Live execution is not implemented; no transaction was signed or submitted");
}

export {
  SOL_MINT, EXPECTED_BOT_WALLET, readLivePolicy,
  evaluateLiveTradeEligibility, getJupiterOrder, executeLiveOrder
};
