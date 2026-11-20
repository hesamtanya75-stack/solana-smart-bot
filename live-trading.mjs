/**
 * Solana live-trading preparation module.
 * Server-side Jupiter V2 order retrieval only; no signing or submission.
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const EXPECTED_BOT_WALLET = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
import {
  validateAndResolveUnsignedJupiterTransaction,
  isTrustedUnsignedMessageEvidence
} from "./trusted-live-evidence.mjs";
import { readBoundedJsonResponse } from "./rpc-response.mjs";

function isCanonicalU64(value, allowZero = false) {
  if (typeof value !== "string" || value.length > 20 ||
      !/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  const amount = BigInt(value);
  return (allowZero || amount > 0n) && amount <= 18446744073709551615n;
}

/**
 * Validate only the documented Jupiter V2 route-plan envelope.
 * This is structural consistency, not DEX instruction or execution verification.
 */
function validateJupiterOrderRoutePlan(routePlan) {
  if (!Array.isArray(routePlan) || Object.getPrototypeOf(routePlan) !== Array.prototype ||
      routePlan.length === 0 || routePlan.length > 64) return false;
  const keys = Reflect.ownKeys(routePlan);
  if (keys.length !== routePlan.length + 1 ||
      keys.some(key => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
         Number(key) >= routePlan.length))) return false;

  for (let index = 0; index < routePlan.length; index++) {
    const stepDescriptor = Object.getOwnPropertyDescriptor(routePlan, String(index));
    if (!stepDescriptor || !Object.prototype.hasOwnProperty.call(stepDescriptor, "value")) return false;
    const step = stepDescriptor.value;
    if (!step || typeof step !== "object" || Array.isArray(step) ||
        (Object.getPrototypeOf(step) !== Object.prototype && Object.getPrototypeOf(step) !== null)) return false;
    const stepKeys = Reflect.ownKeys(step);
    if (stepKeys.some(key => !["swapInfo", "percent", "bps", "usdValue"].includes(key)) ||
        !stepKeys.includes("swapInfo") || !stepKeys.includes("percent") || !stepKeys.includes("bps")) return false;
    const info = step.swapInfo;
    if (!info || typeof info !== "object" || Array.isArray(info) ||
        (Object.getPrototypeOf(info) !== Object.prototype && Object.getPrototypeOf(info) !== null)) return false;
    const infoKeys = Reflect.ownKeys(info);
    if (infoKeys.some(key => !["ammKey", "label", "inputMint", "outputMint", "inAmount", "outAmount"].includes(key)) ||
        !["ammKey", "label", "inputMint", "outputMint", "inAmount", "outAmount"].every(key => infoKeys.includes(key))) return false;
    if (![info.ammKey, info.inputMint, info.outputMint].every(value => typeof value === "string" && BASE58.test(value)) ||
        typeof info.label !== "string" || info.label.length === 0 || info.label.length > 128 ||
        !isCanonicalU64(info.inAmount) || !isCanonicalU64(info.outAmount) ||
        !Number.isFinite(step.percent) || step.percent < 0 || step.percent > 100 ||
        !Number.isFinite(step.bps) || step.bps < 0 || step.bps > 10000 ||
        (step.usdValue != null && (!Number.isFinite(step.usdValue) || step.usdValue < 0))) return false;
  }
  return true;
}

const REVIEWED_PROGRAM_IDS = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
]);

/**
 * Derive Solana message-level signer/writable privileges from the message
 * header and resolved v0 lookup partitions. This is not instruction semantic
 * approval, runtime account state, or proof of program behavior.
 */
function deriveMessageAccountPrivileges(evidence) {
  const header = evidence?.header;
  const staticKeys = evidence?.staticAccountKeys;
  const accountKeys = evidence?.accountKeys;
  const loadedWritable = evidence?.resolvedWritableAddresses ?? [];
  const loadedReadonly = evidence?.resolvedReadonlyAddresses ?? [];
  const staticCount = evidence?.staticAccountCount;
  const required = header?.numRequiredSignatures;
  const readonlySigned = header?.numReadonlySignedAccounts;
  const readonlyUnsigned = header?.numReadonlyUnsignedAccounts;
  if (!header || !Array.isArray(staticKeys) || !Array.isArray(accountKeys) ||
      !Array.isArray(loadedWritable) || !Array.isArray(loadedReadonly) ||
      !Number.isInteger(staticCount) || staticCount < 1 || staticCount !== staticKeys.length ||
      !Number.isInteger(required) || required < 1 || required > staticCount ||
      !Number.isInteger(readonlySigned) || readonlySigned < 0 || readonlySigned > required ||
      !Number.isInteger(readonlyUnsigned) || readonlyUnsigned < 0 ||
      readonlyUnsigned > staticCount - required ||
      accountKeys.length !== staticCount + loadedWritable.length + loadedReadonly.length ||
      accountKeys.some((key, index) => typeof key !== "string" || !BASE58.test(key) ||
        (index < staticCount && key !== staticKeys[index]) ||
        (index >= staticCount && index < staticCount + loadedWritable.length &&
          key !== loadedWritable[index - staticCount]) ||
        (index >= staticCount + loadedWritable.length &&
          key !== loadedReadonly[index - staticCount - loadedWritable.length])) ||
      new Set(accountKeys).size !== accountKeys.length) {
    throw new Error("Unsigned transaction account privilege metadata is incomplete or inconsistent");
  }
  const accounts = accountKeys.map((pubkey, index) => {
    if (index < required) {
      return Object.freeze({
        pubkey, isSigner: true,
        isWritable: index < required - readonlySigned,
        source: "static-signer"
      });
    }
    if (index < staticCount) {
      return Object.freeze({
        pubkey, isSigner: false,
        isWritable: index < staticCount - readonlyUnsigned,
        source: "static-nonsigner"
      });
    }
    if (index < staticCount + loadedWritable.length) {
      return Object.freeze({ pubkey, isSigner: false, isWritable: true, source: "lookup-writable" });
    }
    return Object.freeze({ pubkey, isSigner: false, isWritable: false, source: "lookup-readonly" });
  });
  return Object.freeze({
    scope: "compiled-message-header-and-alt-partitions-only",
    accounts: Object.freeze(accounts)
  });
}


/**
 * Inventory compiled instruction program IDs after message/ALT validation.
 * This is identifier inventory only; it does not decode or approve semantics.
 */
function inventoryUnsignedInstructionPrograms(evidence) {
  // Defensive compatibility path: current V1 parsing exposes these fields,
  // but older or partial evidence must never be mistaken for an empty inventory.
  if (evidence?.messageVersion === 1 &&
      (!Array.isArray(evidence.accountKeys) || !Array.isArray(evidence.compiledInstructions))) {
    return Object.freeze({
      scope: "unavailable-v1-instruction-addresses-not-exposed",
      instructionCount: evidence.instructionCount,
      programIds: Object.freeze([]),
      unsupportedProgramIds: Object.freeze([]),
      allProgramsRecognized: false,
      semanticInstructionVerification: false,
      cpiProgramIdsVerified: false,
      tokenBalanceEffectsVerified: false,
      accountPrivilegesVerified: false,
      programExecutableFlagsVerified: false,
      instructionAccountIndexesVerified: false,
      messageAccountPrivilegesDerived: false,
      instructionAccountPrivilegesDerived: false,
      instructionAccountPrivilegesScope: "unavailable",
      instructionAccountPrivileges: Object.freeze([]),
      messageAccountPrivileges: Object.freeze([])
    });
  }
  if (!evidence || !Array.isArray(evidence.accountKeys) ||
      !Array.isArray(evidence.compiledInstructions) ||
      evidence.compiledInstructions.length === 0 ||
      evidence.compiledInstructions.length > 256) {
    throw new Error("Unsigned transaction instruction inventory is incomplete");
  }
  const messageAccountPrivileges = deriveMessageAccountPrivileges(evidence);
  const counts = new Map();
  for (const instruction of evidence.compiledInstructions) {
    if (!instruction || !Number.isInteger(instruction.programIdIndex) ||
        instruction.programIdIndex < 0 ||
        instruction.programIdIndex >= evidence.accountKeys.length) {
      throw new Error("Unsigned transaction contains an invalid program index");
    }
    if (!Array.isArray(instruction.accountKeyIndexes) ||
        instruction.accountKeyIndexes.some(index =>
          !Number.isInteger(index) || index < 0 || index >= evidence.accountKeys.length)) {
      throw new Error("Unsigned transaction contains an invalid instruction account index");
    }
    const programId = evidence.accountKeys[instruction.programIdIndex];
    if (typeof programId !== "string" || !BASE58.test(programId)) {
      throw new Error("Unsigned transaction contains an invalid program address");
    }
    counts.set(programId, (counts.get(programId) || 0) + 1);
  }
  const programIds = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([programId, instructionCount]) => Object.freeze({
      programId,
      instructionCount,
      decoderRegistryRecognized: REVIEWED_PROGRAM_IDS.has(programId)
    }));
  const unsupportedProgramIds = programIds
    .filter(item => !item.decoderRegistryRecognized)
    .map(item => item.programId);
  // Bind the narrow finalized executable-account evidence to this exact
  // compiled-message program-ID set. A plain caller-supplied object is never
  // sufficient: the evidence must carry this module's private provenance brand.
  const executableEvidence = evidence.programExecutableEvidence;
  const expectedExecutableProgramIds = [...counts.keys()].sort();
  const suppliedExecutablePrograms = executableEvidence?.programs;
  const suppliedExecutableProgramIds = Array.isArray(suppliedExecutablePrograms)
    ? suppliedExecutablePrograms.map(item => item?.programId).sort()
    : [];
  const programExecutableFlagsVerified =
    isTrustedUnsignedMessageEvidence(evidence) &&
    evidence.programExecutableFlagsVerified === true &&
    executableEvidence?.scope === "finalized-account-executable-flag-and-loader-owner-only" &&
    Number.isSafeInteger(executableEvidence.contextSlot) &&
    executableEvidence.contextSlot > 0 &&
    Array.isArray(suppliedExecutablePrograms) &&
    suppliedExecutablePrograms.length === expectedExecutableProgramIds.length &&
    suppliedExecutableProgramIds.every((programId, index) =>
      programId === expectedExecutableProgramIds[index]) &&
    suppliedExecutablePrograms.every(item =>
      item?.executable === true && item?.commitment === "finalized" &&
      item?.contextSlot === executableEvidence.contextSlot &&
      typeof item?.owner === "string" && BASE58.test(item.owner));
  // Resolve each compiled instruction's account indexes to the already-derived
  // message-level privileges. Preserve repeated indexes and original ordering.
  const instructionAccountPrivileges = evidence.compiledInstructions.map((instruction, index) =>
    Object.freeze({
      instructionIndex: index,
      programId: evidence.accountKeys[instruction.programIdIndex],
      accounts: Object.freeze(instruction.accountKeyIndexes.map(accountIndex =>
        messageAccountPrivileges.accounts[accountIndex]))
    }));
  return Object.freeze({
    scope: "compiled-program-id-inventory-only",
    instructionCount: evidence.compiledInstructions.length,
    programIds: Object.freeze(programIds),
    unsupportedProgramIds: Object.freeze(unsupportedProgramIds),
    allProgramsRecognized: unsupportedProgramIds.length === 0,
    semanticInstructionVerification: false,
    cpiProgramIdsVerified: false,
    tokenBalanceEffectsVerified: false,
    accountPrivilegesVerified: false,
    programExecutableFlagsVerified,
    programExecutableEvidenceScope: programExecutableFlagsVerified
      ? executableEvidence.scope
      : "not-verified",
    instructionAccountIndexesVerified: true,
    messageAccountPrivilegesDerived: true,
    instructionAccountPrivilegesDerived: true,
    instructionAccountPrivilegesScope: "compiled-instruction-indexes-mapped-to-message-header-and-alt-privileges-only",
    instructionAccountPrivileges: Object.freeze(instructionAccountPrivileges),
    messageAccountPrivileges
  });
}

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

  // Do not set receiver: Jupiter requires it to differ from taker, while this
  // single-wallet flow pins both signing and settlement to the bot wallet.
  // Ask Jupiter to exclude every non-Metis router; still verify the returned
  // router because provider-side query filters are not an authorization boundary.
  const params = new URLSearchParams({
    inputMint, outputMint, amount: String(amountLamports),
    taker: policy.wallet,
    excludeRouters: "jupiterz,dflow,okx",
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
      !validateJupiterOrderRoutePlan(order.routePlan)) {
    throw new Error("Jupiter returned an incomplete or non-executable order");
  }
  const transactionEvidence = await validateAndResolveUnsignedJupiterTransaction(
    order.transaction, policy.wallet, fetchImpl
  );
  const instructionProgramInventory = inventoryUnsignedInstructionPrograms(transactionEvidence);
  return Object.freeze({
    requestId: order.requestId, transaction: order.transaction,
    inputMint, outputMint, inputAmount: String(amountLamports),
    outputAmount: String(order.outAmount), router: String(order.router || "unknown"),
    transactionVersion: transactionEvidence.messageVersion,
    feeBps: order.feeBps != null && Number.isFinite(Number(order.feeBps)) ? Number(order.feeBps) : null,
    transactionEvidence,
    instructionProgramInventory,
    // An unsigned Jupiter payload is inspection evidence only. It is never
    // approval to sign or submit, even when structural/ALT checks pass.
    analysisOnly: true,
    semanticInstructionVerification: false,
    routeVerification: "unsigned-structure-and-alt-only",
    signingPermitted: false,
    submissionPermitted: false
  });
}

async function executeLiveOrder() {
  throw new Error("Live execution is not implemented; no transaction was signed or submitted");
}

export {
  SOL_MINT, EXPECTED_BOT_WALLET, readLivePolicy,
  evaluateLiveTradeEligibility, getJupiterOrder, executeLiveOrder
};
