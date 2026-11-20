const MAX_ACCOUNT_KEYS = 256;
const MAX_TOKEN_BALANCE_RECORDS = 1024;
const U64_MAX = 18446744073709551615n;

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " is malformed");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + " must be a plain record");
  }
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new Error(label + " contains unsupported properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains accessor-backed properties");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum) throw new Error(label + " is malformed");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw new Error(label + " is sparse or extended");
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains accessor-backed entries");
    }
    result.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw new Error(label + " contains unsupported properties");
    }
  }
  return result;
}

function parseU64(value, label) {
  if (typeof value !== "string" || value.length > 20 || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(label + " must be a canonical unsigned decimal string");
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new Error(label + " exceeds u64");
  return parsed;
}

function normalizeTokenBalances(value, accountKeyCount, label) {
  const records = snapshotArray(value, MAX_TOKEN_BALANCE_RECORDS, label);
  const seen = new Set();
  return records.map((raw, position) => {
    const record = snapshotRecord(raw,
      ["accountIndex", "mint", "owner", "programId", "uiTokenAmount"], label + "[" + position + "]");
    if (!Number.isInteger(record.accountIndex) || record.accountIndex < 0 ||
        record.accountIndex >= accountKeyCount ||
        typeof record.mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(record.mint) ||
        (record.owner != null && (typeof record.owner !== "string" ||
          !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(record.owner))) ||
        (record.programId != null && (typeof record.programId !== "string" ||
          !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(record.programId)))) {
      throw new Error(label + "[" + position + "] identity is invalid");
    }
    const amountRecord = snapshotRecord(record.uiTokenAmount,
      ["amount", "decimals", "uiAmount", "uiAmountString"], label + "[" + position + "].uiTokenAmount");
    const amount = parseU64(amountRecord.amount, label + "[" + position + "].amount");
    if (!Number.isInteger(amountRecord.decimals) || amountRecord.decimals < 0 ||
        amountRecord.decimals > 255) {
      throw new Error(label + "[" + position + "] decimals are invalid");
    }
    const identity = record.accountIndex + ":" + record.mint + ":" + (record.programId ?? "");
    if (seen.has(identity)) throw new Error(label + " contains duplicate account/mint/program records");
    seen.add(identity);
    return Object.freeze({
      accountIndex: record.accountIndex,
      mint: record.mint,
      owner: record.owner ?? null,
      programId: record.programId ?? null,
      amount,
      amountString: amount.toString(),
      decimals: amountRecord.decimals
    });
  });
}

/**
 * Produce diagnostic balance observations from a Solana simulateTransaction result.
 * No account-state authentication, remote simulation attestation, CPI reconciliation,
 * or transaction authorization is performed here.
 */
export function normalizeSimulationBalanceObservation(input) {
  const args = snapshotRecord(input, ["simulationResult", "accountKeyCount"], "Balance observation input");
  if (!Number.isInteger(args.accountKeyCount) || args.accountKeyCount < 1 ||
      args.accountKeyCount > MAX_ACCOUNT_KEYS) {
    throw new Error("Balance observation account-key count is invalid");
  }
  const root = snapshotRecord(args.simulationResult, ["context", "value"], "Simulation result");
  const context = snapshotRecord(root.context, ["slot"], "Simulation context");
  if (!Number.isSafeInteger(context.slot) || context.slot < 0) {
    throw new Error("Simulation context slot is invalid");
  }
  const value = snapshotRecord(root.value,
    ["err", "logs", "accounts", "returnData", "computeUnitsConsumed",
      "innerInstructions", "loadedAccountsDataSize", "preBalances", "postBalances",
      "preTokenBalances", "postTokenBalances"],
    "Simulation value");
  const preLamports = snapshotArray(value.preBalances, MAX_ACCOUNT_KEYS, "preBalances");
  const postLamports = snapshotArray(value.postBalances, MAX_ACCOUNT_KEYS, "postBalances");
  if (preLamports.length !== args.accountKeyCount || postLamports.length !== args.accountKeyCount) {
    throw new Error("SOL balance arrays must exactly match the message account-key count");
  }
  const lamportDeltas = preLamports.map((before, index) => {
    const after = postLamports[index];
    if (!Number.isSafeInteger(before) || before < 0 ||
        !Number.isSafeInteger(after) || after < 0) {
      throw new Error("SOL balance entry is not a nonnegative safe integer");
    }
    return Object.freeze({ accountIndex: index, preLamports: before, postLamports: after,
      deltaLamports: BigInt(after) - BigInt(before) });
  });
  const preTokens = normalizeTokenBalances(value.preTokenBalances, args.accountKeyCount, "preTokenBalances");
  const postTokens = normalizeTokenBalances(value.postTokenBalances, args.accountKeyCount, "postTokenBalances");
  const preByIdentity = new Map(preTokens.map(record => [
    record.accountIndex + ":" + record.mint + ":" + (record.programId ?? ""), record
  ]));
  const postByIdentity = new Map(postTokens.map(record => [
    record.accountIndex + ":" + record.mint + ":" + (record.programId ?? ""), record
  ]));
  const identities = new Set([...preByIdentity.keys(), ...postByIdentity.keys()]);
  const tokenDeltas = [...identities].sort().map(identity => {
    const before = preByIdentity.get(identity) ?? null;
    const after = postByIdentity.get(identity) ?? null;
    if (!before || !after) {
      return Object.freeze({ identity, status: "unpaired-account-state", pre: before, post: after, delta: null });
    }
    if (before.decimals !== after.decimals || before.owner !== after.owner) {
      return Object.freeze({ identity, status: "conflicting-account-metadata", pre: before, post: after, delta: null });
    }
    return Object.freeze({ identity, status: "paired-diagnostic-only", pre: before, post: after,
      delta: after.amount - before.amount });
  });
  return Object.freeze({
    scope: "simulation-balance-observation-only",
    contextSlot: context.slot,
    simulationSucceeded: value.err === null,
    solLamportDeltas: Object.freeze(lamportDeltas),
    tokenDeltas: Object.freeze(tokenDeltas),
    tokenRecordsUnpaired: tokenDeltas.some(item => item.status !== "paired-diagnostic-only"),
    remoteSimulationIdentityVerified: false,
    accountStateIdentityVerified: false,
    cpiEffectsReconciled: false,
    tokenBalanceEffectsVerified: false,
    signingPermitted: false,
    submissionPermitted: false
  });
}
