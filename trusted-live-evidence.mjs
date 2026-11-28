import { readBoundedJsonResponse } from "./rpc-response.mjs";
import { decodeAddressLookupTableAccountData } from "./address-lookup-table-verifier.mjs";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const EXPECTED_BOT_WALLET = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const JUPITER_ORDER_URL = "https://api.jup.ag/swap/v2/order";
const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/SOL-USD/spot";
const DEX_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens/";
const RUGCHECK_URL = "https://api.rugcheck.xyz/v1/tokens/";
const DEVNET_OR_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const EXPECTED_TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

function decodeBase58(value) {
  let number = 0n;
  for (const char of value) {
    const digit = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".indexOf(char);
    if (digit < 0) throw new Error("Invalid base58 address");
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (let i = 0; i < value.length && value[i] === "1"; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

function encodeBase58(bytes) {
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[remainder] + encoded;
    number /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) encoded = "1" + encoded;
  return encoded || "1";
}

function isCanonicalPublicKey(value) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    const decoded = decodeBase58(value);
    return decoded.length === 32 && encodeBase58(decoded) === value;
  } catch {
    return false;
  }
}

function isU64DecimalString(value, allowZero = false) {
  if (typeof value !== "string" || value.length > 20 ||
      !/^(?:0|[1-9]\d*)$/.test(value)) return false;
  const amount = BigInt(value);
  return (allowZero || amount > 0n) && amount <= 18446744073709551615n;
}

function validateBuildRoutePlan(routePlan, inputMint, outputMint) {
  const steps = snapshotDensePlainArray(
    routePlan, 64, "Jupiter build routePlan",
    "Jupiter build routePlan is malformed"
  );
  if (steps.length === 0) throw new Error("Jupiter build routePlan is malformed");
  const validated = steps.map((step, index) => {
    const stepRecord = snapshotPlainRecord(
      step, ["percent", "bps", "swapInfo", "label"],
      "Jupiter build routePlan[" + index + "]"
    );
    const info = snapshotPlainRecord(
      stepRecord.swapInfo,
      ["ammKey", "label", "inputMint", "outputMint", "inAmount", "outAmount", "feeAmount", "feeMint"],
      "Jupiter build routePlan[" + index + "] swapInfo"
    );
    if (!Number.isInteger(stepRecord.percent) || stepRecord.percent < 1 || stepRecord.percent > 100 ||
        !Number.isInteger(stepRecord.bps) || stepRecord.bps < 1 || stepRecord.bps > 10000 ||
        !isCanonicalPublicKey(info.ammKey) ||
        !isCanonicalPublicKey(info.inputMint) || !isCanonicalPublicKey(info.outputMint) ||
        info.inputMint === info.outputMint ||
        !isU64DecimalString(info.inAmount) || !isU64DecimalString(info.outAmount) ||
        (info.feeAmount != null && !isU64DecimalString(info.feeAmount, true)) ||
        (info.feeMint != null && !isCanonicalPublicKey(info.feeMint)) ||
        ((info.feeAmount == null) !== (info.feeMint == null))) {
      throw new Error("Jupiter build routePlan[" + index + "] is malformed");
    }
    return Object.freeze({
      percent: stepRecord.percent,
      ...(stepRecord.bps == null ? {} : { bps: stepRecord.bps }),
      swapInfo: Object.freeze({
        ammKey: info.ammKey,
        inputMint: info.inputMint,
        outputMint: info.outputMint,
        inAmount: info.inAmount,
        outAmount: info.outAmount,
        ...(info.feeAmount == null ? {} : {
          feeAmount: info.feeAmount,
          feeMint: info.feeMint
        })
      })
    });
  });
  const percentTotal = validated.reduce((sum, step) => sum + step.percent, 0);
  const bpsValues = validated.map(step => step.bps);
  const hasBps = bpsValues.some(value => value != null);
  if (percentTotal !== 100 ||
      (hasBps && (bpsValues.some(value => value == null) ||
        bpsValues.reduce((sum, value) => sum + value, 0) !== 10000)) ||
      validated.some(step =>
        step.swapInfo.inputMint !== inputMint || step.swapInfo.outputMint !== outputMint)) {
    throw new Error("Jupiter build routePlan totals or token mints are inconsistent");
  }
  return Object.freeze(validated);
}
function snapshotPlainRecord(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " is malformed");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + " is malformed");
  }
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      throw new Error(label + " is malformed");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains accessor-backed properties");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotDensePlainArray(value, maximum, label, malformedMessage = label + " is malformed") {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum) {
    throw new Error(malformedMessage);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    throw new Error(malformedMessage);
  }
  const snapshot = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) throw new Error(malformedMessage);
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains accessor-backed entries");
    }
    snapshot.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length) {
      throw new Error(malformedMessage);
    }
  }
  return snapshot;
}

function snapshotDynamicPlainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " is malformed");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + " is malformed");
  }
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(label + " is malformed");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains accessor-backed properties");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function validateBuildInstruction(instruction, name) {
  const label = "Jupiter build " + name + " instruction";
  const record = snapshotPlainRecord(instruction, ["programId", "accounts", "data"], label);
  if (!isCanonicalPublicKey(record.programId) ||
      typeof record.data !== "string" || record.data.length > 16384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data)) {
    throw new Error(label + " is malformed");
  }
  const data = Uint8Array.from(atob(record.data), char => char.charCodeAt(0));
  if (btoa(String.fromCharCode(...data)) !== record.data) {
    throw new Error("Jupiter build " + name + " instruction data is non-canonical");
  }
  if (!Array.isArray(record.accounts) || record.accounts.length > 256) {
    throw new Error(label + " is malformed");
  }
  const rawAccounts = snapshotDensePlainArray(
    record.accounts, 256, "Jupiter build " + name + " instruction account list",
    "Jupiter build " + name + " instruction account is malformed"
  );
  const accounts = rawAccounts.map((account) => {
    const meta = snapshotPlainRecord(
      account, ["pubkey", "isSigner", "isWritable"],
      "Jupiter build " + name + " instruction account"
    );
    if (!isCanonicalPublicKey(meta.pubkey) ||
        typeof meta.isSigner !== "boolean" ||
        typeof meta.isWritable !== "boolean") {
      throw new Error("Jupiter build " + name + " instruction account is malformed");
    }
    return Object.freeze({
      pubkey: meta.pubkey,
      isSigner: meta.isSigner,
      isWritable: meta.isWritable
    });
  });
  return Object.freeze({ programId: record.programId, accounts: Object.freeze(accounts), data: record.data });
}

/**
 * Validates the documented Jupiter Swap V2 /build response envelope only.
 * It does not decode instruction semantics or establish program trust.
 */
export function validateJupiterBuildResponse(build, expected = {}) {
  const record = snapshotPlainRecord(build, [
    "inputMint", "outputMint", "inAmount", "outAmount", "otherAmountThreshold",
    "slippageBps", "routePlan", "swapMode", "computeBudgetInstructions",
    "setupInstructions", "swapInstruction", "cleanupInstruction",
    "otherInstructions", "tipInstruction", "blockhashWithMetadata",
    "transactionVersion", "addressesByLookupTableAddress", "computeUnitPrice"
  ], "Jupiter build response");
  const expectedRecord = snapshotPlainRecord(
    expected, ["inputMint", "outputMint", "amount"], "Jupiter build expected intent"
  );
  const blockhashMetadata = snapshotPlainRecord(
    record.blockhashWithMetadata, ["blockhash", "lastValidBlockHeight"],
    "Jupiter build blockhash metadata"
  );
  let blockhash;
  try {
    blockhash = snapshotDensePlainArray(
      blockhashMetadata.blockhash, 32, "Jupiter build blockhash",
      "Jupiter build response envelope is incomplete or inconsistent"
    );
  } catch {
    throw new Error("Jupiter build response envelope is incomplete or inconsistent");
  }
  if (!isCanonicalPublicKey(record.inputMint) ||
      !isCanonicalPublicKey(record.outputMint) ||
      record.inputMint === record.outputMint ||
      (expectedRecord.inputMint && record.inputMint !== expectedRecord.inputMint) ||
      (expectedRecord.outputMint && record.outputMint !== expectedRecord.outputMint) ||
      !isU64DecimalString(record.inAmount) ||
      !isU64DecimalString(record.outAmount) ||
      !isU64DecimalString(record.otherAmountThreshold, true) ||
      !Number.isInteger(record.slippageBps) || record.slippageBps < 0 || record.slippageBps > 10000 ||
      !Array.isArray(record.routePlan) || record.routePlan.length === 0 || record.routePlan.length > 64 ||
      !["ExactIn", "ExactOut"].includes(record.swapMode) ||
      !Array.isArray(record.computeBudgetInstructions) || record.computeBudgetInstructions.length > 64 ||
      !Array.isArray(record.setupInstructions) || record.setupInstructions.length > 64 ||
      !Array.isArray(record.otherInstructions) || record.otherInstructions.length > 64 ||
      !Object.prototype.hasOwnProperty.call(record, "cleanupInstruction") ||
      !Object.prototype.hasOwnProperty.call(record, "tipInstruction") ||
      !Number.isSafeInteger(blockhashMetadata.lastValidBlockHeight) ||
      blockhashMetadata.lastValidBlockHeight <= 0 ||
      blockhash.length !== 32 ||
      !blockhash.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error("Jupiter build response envelope is incomplete or inconsistent");
  }
  const version = String(record.transactionVersion ?? "0");
  if (version !== "0" && version !== "1") {
    throw new Error("Jupiter build transaction version is unsupported");
  }
  const routePlan = validateBuildRoutePlan(record.routePlan, record.inputMint, record.outputMint);
  const validateList = (items, name) => Object.freeze(
    snapshotDensePlainArray(
      items, 64, "Jupiter build " + name + " instruction list",
      "Jupiter build " + name + " instruction is malformed"
    ).map((item, index) => validateBuildInstruction(item, name + "[" + index + "]"))
  );
  const computeBudgetInstructions = validateList(record.computeBudgetInstructions, "computeBudget");
  const setupInstructions = validateList(record.setupInstructions, "setup");
  const swapInstruction = validateBuildInstruction(record.swapInstruction, "swap");
  const cleanupInstruction = record.cleanupInstruction === null
    ? null : validateBuildInstruction(record.cleanupInstruction, "cleanup");
  const otherInstructions = validateList(record.otherInstructions, "other");
  const tipInstruction = record.tipInstruction === null
    ? null : validateBuildInstruction(record.tipInstruction, "tip");
  const allInstructions = [
    ...computeBudgetInstructions, ...setupInstructions, swapInstruction,
    ...(cleanupInstruction ? [cleanupInstruction] : []),
    ...otherInstructions, ...(tipInstruction ? [tipInstruction] : [])
  ];
  const totalAccountMetas = allInstructions.reduce((sum, instruction) =>
    sum + instruction.accounts.length, 0);
  const totalInstructionDataChars = allInstructions.reduce((sum, instruction) =>
    sum + instruction.data.length, 0);
  if (allInstructions.length > 256 || totalAccountMetas > 4096 ||
      totalInstructionDataChars > 262144) {
    throw new Error("Jupiter build instruction bundle exceeds aggregate resource limits");
  }
  const rawAlts = record.addressesByLookupTableAddress;
  if (rawAlts !== null && rawAlts !== undefined &&
      (typeof rawAlts !== "object" || Array.isArray(rawAlts))) {
    throw new Error("Jupiter build lookup-table map is malformed");
  }
  const altRecord = rawAlts == null
    ? Object.create(null)
    : snapshotDynamicPlainRecord(rawAlts, "Jupiter build lookup-table map");
  const altEntries = Object.entries(altRecord);
  if (altEntries.length > 64) throw new Error("Jupiter build contains too many lookup tables");
  const lookupTables = {};
  let totalLookupAddresses = 0;
  for (const [table, addresses] of altEntries) {
    const addressSnapshot = snapshotDensePlainArray(
      addresses, 256, "Jupiter build lookup-table addresses",
      "Jupiter build lookup-table addresses are malformed"
    );
    if (!isCanonicalPublicKey(table) ||
        !addressSnapshot.every(isCanonicalPublicKey) ||
        new Set(addressSnapshot).size !== addressSnapshot.length) {
      throw new Error("Jupiter build lookup-table addresses are malformed");
    }
    totalLookupAddresses += addressSnapshot.length;
    if (totalLookupAddresses > 4096) {
      throw new Error("Jupiter build lookup-table address bundle exceeds aggregate resource limits");
    }
    lookupTables[table] = Object.freeze(addressSnapshot);
  }
  if (version === "1" && (computeBudgetInstructions.length !== 0 ||
      Object.keys(lookupTables).length !== 0 ||
      !/^\d+$/.test(String(record.computeUnitPrice ?? "")))) {
    throw new Error("Jupiter v1 build response has invalid inline-account compute-budget fields");
  }
  if (expectedRecord.amount != null && String(record.inAmount) !== String(expectedRecord.amount)) {
    throw new Error("Jupiter build input amount does not match the requested amount");
  }
  return Object.freeze({
    inputMint: record.inputMint,
    outputMint: record.outputMint,
    inAmount: String(record.inAmount),
    outAmount: String(record.outAmount),
    otherAmountThreshold: String(record.otherAmountThreshold),
    slippageBps: record.slippageBps,
    swapMode: record.swapMode,
    routePlan,
    transactionVersion: Number(version),
    computeBudgetInstructions,
    setupInstructions,
    swapInstruction,
    cleanupInstruction,
    otherInstructions,
    tipInstruction,
    addressesByLookupTableAddress: Object.freeze(lookupTables),
    blockhashWithMetadata: Object.freeze({
      blockhash: Object.freeze(blockhash),
      lastValidBlockHeight: blockhashMetadata.lastValidBlockHeight
    }),
    analysisOnly: true,
    semanticInstructionVerification: false,
    routeVerification: "build-envelope-only",
    signingPermitted: false,
    submissionPermitted: false
  });
}

function readShortVector(bytes, offset) {
  let value = 0, shift = 0, cursor = offset;
  for (let i = 0; i < 3; i++) {
    if (cursor >= bytes.length) throw new Error("Jupiter transaction is truncated");
    const byte = bytes[cursor++];
    const digit = byte & 0x7f;
    if (i === 2 && (digit > 3 || (byte & 0x80) !== 0)) {
      throw new Error("Jupiter transaction compact length exceeds u16");
    }
    value += digit * (2 ** shift);
    if ((byte & 0x80) === 0) {
      if (i > 0 && digit === 0) {
        throw new Error("Jupiter transaction compact length is non-canonical");
      }
      return { value, offset: cursor };
    }
    shift += 7;
  }
  throw new Error("Jupiter transaction has an invalid compact length");
}

function validateUnsignedJupiterV1(bytes, expectedSigner) {
  // Solana v1 uses fixed-width counts, inline addresses, config values after
  // the address vector, split instruction headers/payloads, and tail signatures.
  // It has no Address Lookup Tables.
  if (bytes.length > 4096) {
    throw new Error("V1 Jupiter transaction exceeds the 4,096-byte size limit");
  }
  let cursor = 1;
  if (cursor + 3 + 4 + 32 + 2 > bytes.length) {
    throw new Error("V1 Jupiter transaction message is truncated");
  }
  const requiredSignatures = bytes[cursor++];
  const readonlySigned = bytes[cursor++];
  const readonlyUnsigned = bytes[cursor++];
  // The pinned bot wallet is the sole signer and must be writable as fee payer.
  if (requiredSignatures !== 1 || readonlySigned !== 0) {
    throw new Error("V1 Jupiter transaction signer header is inconsistent");
  }
  const configMask = (bytes[cursor] | (bytes[cursor + 1] << 8) |
    (bytes[cursor + 2] << 16) | (bytes[cursor + 3] << 24)) >>> 0;
  cursor += 4;
  if ((configMask & ~0x1f) !== 0 ||
      ((configMask & 0x3) !== 0 && (configMask & 0x3) !== 0x3)) {
    throw new Error("V1 Jupiter transaction config mask is unsupported");
  }
  // V1 transactions must explicitly request non-zero compute and loaded-data
  // budgets. Missing fields default to zero and cannot execute successfully.
  if ((configMask & 0x0c) !== 0x0c) {
    throw new Error("V1 transaction must explicitly set compute and loaded-data limits");
  }
  cursor += 32; // recent blockhash
  const instructionCount = bytes[cursor++];
  const addressCount = bytes[cursor++];
  if (instructionCount < 1 || instructionCount > 64 ||
      addressCount < requiredSignatures || addressCount > 64 ||
      readonlyUnsigned > addressCount - requiredSignatures) {
    throw new Error("V1 Jupiter transaction instruction or address count is invalid");
  }
  const addressesStart = cursor;
  if (cursor + addressCount * 32 > bytes.length) {
    throw new Error("V1 Jupiter transaction addresses are truncated");
  }
  const expectedBytes = decodeBase58(expectedSigner);
  if (expectedBytes.length !== 32 ||
      bytes.slice(addressesStart, addressesStart + 32).some((byte, i) => byte !== expectedBytes[i])) {
    throw new Error("Jupiter transaction is not pinned to the expected bot wallet");
  }
  const uniqueAddresses = new Set();
  const staticAccountKeys = [];
  for (let i = 0; i < addressCount; i++) {
    const start = addressesStart + i * 32;
    const addressBytes = bytes.subarray(start, start + 32);
    const key = Array.from(addressBytes, byte => byte.toString(16).padStart(2, "0")).join("");
    if (uniqueAddresses.has(key)) {
      throw new Error("V1 Jupiter transaction contains duplicate account addresses");
    }
    uniqueAddresses.add(key);
    staticAccountKeys.push(encodeBase58(addressBytes));
  }
  cursor += addressCount * 32;
  const configBytes = ((configMask & 0x3) ? 8 : 0) +
    ((configMask & 0x4) ? 4 : 0) +
    ((configMask & 0x8) ? 4 : 0) +
    ((configMask & 0x10) ? 4 : 0);
  if (cursor + configBytes > bytes.length) {
    throw new Error("V1 Jupiter transaction config values are truncated");
  }
  // Config values are encoded in ascending bit order: priority fee (u64),
  // compute-unit limit (u32), loaded-account data limit (u32), heap size (u32).
  let configOffset = cursor;
  if ((configMask & 0x3) !== 0) configOffset += 8;
  const computeUnitLimit = (configMask & 0x4) !== 0
    ? (bytes[configOffset] | (bytes[configOffset + 1] << 8) |
      (bytes[configOffset + 2] << 16) | (bytes[configOffset + 3] << 24)) >>> 0
    : null;
  if (computeUnitLimit !== null) configOffset += 4;
  const loadedAccountsDataSizeLimit = (configMask & 0x8) !== 0
    ? (bytes[configOffset] | (bytes[configOffset + 1] << 8) |
      (bytes[configOffset + 2] << 16) | (bytes[configOffset + 3] << 24)) >>> 0
    : null;
  if (loadedAccountsDataSizeLimit !== null) configOffset += 4;
  if (computeUnitLimit < 1 || computeUnitLimit > 1400000) {
    throw new Error("V1 transaction compute-unit limit is outside the supported range");
  }
  if (loadedAccountsDataSizeLimit < 1 || loadedAccountsDataSizeLimit > 64 * 1024 * 1024) {
    throw new Error("V1 transaction loaded-data limit is outside the supported range");
  }
  // Solana requires a 1 KiB multiple in the inclusive 32–256 KiB range.
  if ((configMask & 0x10) !== 0) {
    const heapSize = (bytes[configOffset] |
      (bytes[configOffset + 1] << 8) |
      (bytes[configOffset + 2] << 16) |
      (bytes[configOffset + 3] << 24)) >>> 0;
    if (heapSize < 32768 || heapSize > 262144 || heapSize % 1024 !== 0) {
      throw new Error("V1 Jupiter transaction heap size is outside the valid range");
    }
  }
  cursor += configBytes;
  const headers = [];
  for (let i = 0; i < instructionCount; i++) {
    if (cursor + 4 > bytes.length) {
      throw new Error("V1 Jupiter instruction headers are truncated");
    }
    const programIdIndex = bytes[cursor++];
    const accountCount = bytes[cursor++];
    const dataLength = bytes[cursor] | (bytes[cursor + 1] << 8);
    cursor += 2;
    if (programIdIndex === 0 || programIdIndex >= addressCount ||
        accountCount > addressCount || dataLength > 4096) {
      throw new Error("V1 Jupiter instruction header is invalid");
    }
    headers.push({ programIdIndex, accountCount, dataLength });
  }
  const compiledInstructions = [];
  for (const header of headers) {
    if (cursor + header.accountCount + header.dataLength > bytes.length) {
      throw new Error("V1 Jupiter instruction payload is truncated");
    }
    const accountKeyIndexes = [];
    for (let i = 0; i < header.accountCount; i++) {
      const accountIndex = bytes[cursor++];
      if (accountIndex >= addressCount) {
        throw new Error("V1 Jupiter instruction account index is invalid");
      }
      accountKeyIndexes.push(accountIndex);
    }
    const instructionData = bytes.slice(cursor, cursor + header.dataLength);
    cursor += header.dataLength;
    compiledInstructions.push(Object.freeze({
      programIdIndex: header.programIdIndex,
      accountKeyIndexes: Object.freeze(accountKeyIndexes),
      data: btoa(String.fromCharCode(...instructionData))
    }));
  }
  const signaturesLength = requiredSignatures * 64;
  if (cursor + signaturesLength !== bytes.length) {
    throw new Error("V1 Jupiter transaction signature section or trailing bytes are invalid");
  }
  for (let i = cursor; i < bytes.length; i++) {
    if (bytes[i] !== 0) throw new Error("Jupiter order transaction must be unsigned");
  }
  return {
    signatureCount: requiredSignatures,
    numRequiredSignatures: requiredSignatures,
    numReadonlySignedAccounts: readonlySigned,
    numReadonlyUnsignedAccounts: readonlyUnsigned,
    staticAccountCount: addressCount,
    staticAccountKeys: Object.freeze(staticAccountKeys),
    accountKeys: Object.freeze(staticAccountKeys),
    compiledInstructions: Object.freeze(compiledInstructions),
    instructionCount,
    addressLookupCount: 0,
    messageVersion: 1,
    semanticInstructionVerification: false
  };
}

export function validateUnsignedJupiterTransaction(encoded, expectedSigner) {
  // Reject oversized transport strings before regex scanning or base64 decoding.
  // A 4,096-byte transaction needs at most 5,464 base64 characters.
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 5464 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Jupiter transaction is empty or not canonical base64");
  }
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  // Bound decoded input before canonicalization; v1 has a larger protocol limit.
  if (bytes.length > 4096) {
    throw new Error("Jupiter transaction exceeds the 4,096-byte size limit");
  }
  if (btoa(String.fromCharCode(...bytes)) !== encoded) {
    throw new Error("Jupiter transaction base64 encoding is non-canonical");
  }
  if (bytes[0] === 0x81) return validateUnsignedJupiterV1(bytes, expectedSigner);
  if (bytes.length > 1232) {
    throw new Error("Legacy/v0 Jupiter transaction exceeds the 1,232-byte size limit");
  }
  const sigHeader = readShortVector(bytes, 0);
  const signatureCount = sigHeader.value;
  if (signatureCount < 1 || signatureCount > 64 ||
      sigHeader.offset + signatureCount * 64 >= bytes.length) {
    throw new Error("Jupiter transaction signature section is invalid");
  }
  const signaturesEnd = sigHeader.offset + signatureCount * 64;
  for (let i = sigHeader.offset; i < signaturesEnd; i++) {
    if (bytes[i] !== 0) throw new Error("Jupiter order transaction must be unsigned");
  }
  const messageStart = signaturesEnd;
  let cursor = messageStart;
  let messageVersion = "legacy";
  if ((bytes[cursor] & 0x80) !== 0) {
    if ((bytes[cursor] & 0x7f) !== 0) throw new Error("Unsupported Jupiter transaction message version");
    messageVersion = 0;
    cursor++;
  }
  if (cursor + 3 > bytes.length) throw new Error("Jupiter transaction message is truncated");
  const requiredSignatures = bytes[cursor++];
  const readonlySigned = bytes[cursor++];
  const readonlyUnsigned = bytes[cursor++];
  // The coordinator pins exactly one signer: the dedicated bot wallet.
  // Additional required signers are outside the reviewed authorization model.
  // The pinned bot wallet is the sole signer and must be writable as fee payer.
  if (requiredSignatures !== 1 || requiredSignatures !== signatureCount ||
      readonlySigned !== 0) {
    throw new Error("Jupiter transaction signer header is inconsistent");
  }
  const keysHeader = readShortVector(bytes, cursor);
  const keyCount = keysHeader.value;
  cursor = keysHeader.offset;
  if (keyCount < requiredSignatures || keyCount > 256 ||
      readonlyUnsigned > keyCount - requiredSignatures ||
      readonlySigned + readonlyUnsigned > keyCount ||
      cursor + keyCount * 32 + 32 > bytes.length) {
    throw new Error("Jupiter transaction account keys or blockhash are invalid");
  }
  const signerBytes = bytes.slice(cursor, cursor + 32);
  const expectedBytes = decodeBase58(expectedSigner);
  if (expectedBytes.length !== 32 || signerBytes.some((byte, i) => byte !== expectedBytes[i])) {
    throw new Error("Jupiter transaction is not pinned to the expected bot wallet");
  }
  // Solana message account keys must be unique; reject ambiguous static-key layouts.
  const uniqueKeys = new Set();
  const staticAccountKeys = [];
  for (let i = 0; i < keyCount; i++) {
    const start = cursor + i * 32;
    const keyBytes = bytes.slice(start, start + 32);
    const key = Array.from(keyBytes, byte => byte.toString(16).padStart(2, "0")).join("");
    if (uniqueKeys.has(key)) {
      throw new Error("Jupiter transaction contains duplicate static account keys");
    }
    uniqueKeys.add(key);
    staticAccountKeys.push(encodeBase58(keyBytes));
  }
  cursor += keyCount * 32;
  cursor += 32; // recent blockhash
  const instructionHeader = readShortVector(bytes, cursor);
  const instructionCount = instructionHeader.value;
  cursor = instructionHeader.offset;
  const instructionAccountIndexes = [];
  const compiledInstructions = [];
  if (instructionCount < 1 || instructionCount > 256) {
    throw new Error("Jupiter transaction has no instructions or an invalid instruction count");
  }
  for (let i = 0; i < instructionCount; i++) {
    if (cursor >= bytes.length) throw new Error("Jupiter instruction is truncated");
    const programIdIndex = bytes[cursor++];
    // Account zero is the writable fee payer, never an executable program account.
    if (programIdIndex === 0 || programIdIndex >= keyCount) {
      throw new Error("Jupiter instruction program index is invalid");
    }
    const accountHeader = readShortVector(bytes, cursor);
    cursor = accountHeader.offset;
    if (accountHeader.value > 256 || cursor + accountHeader.value > bytes.length) {
      throw new Error("Jupiter instruction account list is invalid");
    }
    const accountKeyIndexes = Array.from(bytes.slice(cursor, cursor + accountHeader.value));
    instructionAccountIndexes.push(...accountKeyIndexes);
    cursor += accountHeader.value;
    const dataHeader = readShortVector(bytes, cursor);
    cursor = dataHeader.offset;
    if (dataHeader.value > 1232 || cursor + dataHeader.value > bytes.length) {
      throw new Error("Jupiter instruction data is invalid");
    }
    const instructionData = bytes.slice(cursor, cursor + dataHeader.value);
    compiledInstructions.push(Object.freeze({
      programIdIndex,
      accountKeyIndexes: Object.freeze(accountKeyIndexes),
      data: btoa(String.fromCharCode(...instructionData))
    }));
    cursor += dataHeader.value;
  }
  let addressLookupCount = 0;
  let loadedAddressCount = 0;
  const addressLookups = [];
  if (messageVersion === 0) {
    const lookupHeader = readShortVector(bytes, cursor);
    addressLookupCount = lookupHeader.value;
    cursor = lookupHeader.offset;
    if (lookupHeader.value > 64) throw new Error("Jupiter address lookup count is invalid");
    for (let i = 0; i < lookupHeader.value; i++) {
      if (cursor + 32 > bytes.length) throw new Error("Jupiter address lookup is truncated");
      const tableAddress = encodeBase58(bytes.slice(cursor, cursor + 32));
      cursor += 32;
      const writable = readShortVector(bytes, cursor);
      cursor = writable.offset;
      if (writable.value > 256 || cursor + writable.value > bytes.length) {
        throw new Error("Jupiter writable lookup indexes are truncated or invalid");
      }
      const writableIndexes = Array.from(bytes.slice(cursor, cursor + writable.value));
      loadedAddressCount += writable.value;
      cursor += writable.value;
      const readonly = readShortVector(bytes, cursor);
      cursor = readonly.offset;
      if (readonly.value > 256 || cursor + readonly.value > bytes.length) {
        throw new Error("Jupiter readonly lookup indexes are truncated or invalid");
      }
      const readonlyIndexes = Array.from(bytes.slice(cursor, cursor + readonly.value));
      loadedAddressCount += readonly.value;
      cursor += readonly.value;
      addressLookups.push({ accountKey: tableAddress, writableIndexes, readonlyIndexes });
    }
  }
  // Compiled instruction account indexes address static keys followed by
  // writable and readonly ALT-loaded keys. Validate against the complete key space.
  if (instructionAccountIndexes.some(index => index >= keyCount + loadedAddressCount)) {
    throw new Error("Jupiter instruction account index is invalid");
  }
  if (cursor !== bytes.length) throw new Error("Jupiter transaction contains trailing or unparsed bytes");
  return {
    signatureCount,
    numRequiredSignatures: requiredSignatures,
    numReadonlySignedAccounts: readonlySigned,
    numReadonlyUnsignedAccounts: readonlyUnsigned,
    staticAccountCount: keyCount,
    staticAccountKeys: Object.freeze(staticAccountKeys),
    compiledInstructions: Object.freeze(compiledInstructions),
    instructionCount,
    addressLookupCount,
    addressLookups,
    messageVersion,
    // Lookup descriptors are retained for independent RPC resolution; semantics stay untrusted.
    semanticInstructionVerification: false
  };
}
function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(label + " is missing or invalid");
  return number;
}

const MAX_EXTERNAL_RESPONSE_BYTES = 2 * 1024 * 1024;

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(new URL(url).hostname + " returned HTTP " + response.status);
  return readBoundedJsonResponse(response);
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
  const limit = 100;
  const accounts = [];
  const seenAccounts = new Set();
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
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        payload.jsonrpc !== "2.0" || payload.id !== page || payload.error ||
        !payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) {
      throw new Error("Alchemy getTokenAccounts response envelope is invalid");
    }
    const result = payload.result;
    const rows = result?.token_accounts;
    if (!Array.isArray(rows)) throw new Error("Alchemy holder page has an invalid response shape");
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      throw new Error("Alchemy holder page reported indexing errors");
    }
    for (const row of rows) {
      const rawAmount = String(row.amount);
      const accountAddress = row.address || row.pubkey;
      if (row.mint !== mint || typeof row.owner !== "string" ||
          typeof accountAddress !== "string" || accountAddress.length < 32 ||
          seenAccounts.has(accountAddress) || !/^\d+$/.test(rawAmount) || BigInt(rawAmount) <= 0n) {
        throw new Error("Alchemy holder page contains incomplete, duplicate, or mismatched account data");
      }
      seenAccounts.add(accountAddress);
      accounts.push({ address: accountAddress, owner: row.owner, amount: BigInt(rawAmount) });    }
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
  const match = /^(\d+)(?:\.(\d+))?$/.exec(priceText);
  if (!match) throw new Error("Token USD price format is unsupported for sell-route verification");
  const priceScale = 24;
  const priceScaled = BigInt(match[1] + (match[2] || "").padEnd(priceScale, "0").slice(0, priceScale));
  if (priceScaled <= 0n) throw new Error("Token USD price is invalid for sell-route verification");
  const amount = (3n * (10n ** BigInt(decimals)) * (10n ** BigInt(priceScale))) / priceScaled;
  const maxProbeAmount = supplyAmount / 100n;
  if (amount <= 0n || maxProbeAmount <= 0n || amount > maxProbeAmount) {
    throw new Error("A $3 sell-route quote would exceed 1% of token supply or is below token precision");
  }

  // A quote-only request deliberately omits taker. It verifies that Jupiter
  // currently sees a route without requiring the bot wallet to own tokens
  // before its first purchase. It does not create an executable transaction.
  const params = new URLSearchParams({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: amount.toString()
  });
  const order = await fetchJson(fetchImpl, JUPITER_ORDER_URL + "?" + params.toString(), {
    headers: { "x-api-key": jupiterApiKey.trim(), Accept: "application/json" }
  });
  if (!order || typeof order !== "object" ||
      typeof order.requestId !== "string" || order.requestId.length === 0 ||
      order.transaction !== null ||
      order.inputMint !== mint || order.outputMint !== SOL_MINT ||
      String(order.inAmount) !== amount.toString() ||
      !/^\d+$/.test(String(order.outAmount || "")) || BigInt(order.outAmount) <= 0n ||
      !Array.isArray(order.routePlan) || order.routePlan.length === 0 ||
      order.errorCode != null) {
    throw new Error("Jupiter did not return a complete quote-only sell-route response");
  }
  return Object.freeze({
    provider: "Jupiter Swap API V2",
    requestId: order.requestId || null,
    inputAmount: amount.toString(),
    outputLamports: String(order.outAmount),
    router: String(order.router || "unknown"),
    routePlanCount: order.routePlan.length,
    signatureCount: null,
    staticAccountCount: null,
    messageVersion: null,
    analysisOnly: true,
    semanticInstructionVerification: false,
    routeVerification: "quote-only-no-transaction",
    signingPermitted: false,
    submissionPermitted: false
  });
}

const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = "AddressLookupTab1e1111111111111111111111111";
const ALT_DEACTIVATION_SLOT_NEVER = 18446744073709551615n;
// Private provenance registry: only this module can brand finalized, digest-bound evidence.
const TRUSTED_UNSIGNED_MESSAGE_EVIDENCE = new WeakSet();

export function isTrustedUnsignedMessageEvidence(value) {
  return Boolean(value && typeof value === "object" &&
    TRUSTED_UNSIGNED_MESSAGE_EVIDENCE.has(value));
}

/**
 * Resolves v0 lookup descriptors against finalized mainnet account state.
 * Any missing, malformed, foreign-owned, deactivated, or not-yet-warmed table
 * fails closed. This establishes address resolution only, not instruction safety.
 */
function snapshotLookupRpcAccount(account) {
  if (!account || typeof account !== "object" || Array.isArray(account) ||
      (Object.getPrototypeOf(account) !== Object.prototype && Object.getPrototypeOf(account) !== null)) {
    throw new Error("Address lookup table RPC account is malformed");
  }
  const readOwnData = (record, key, label) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains missing or accessor-backed fields");
    }
    return descriptor.value;
  };
  const owner = readOwnData(account, "owner", "Address lookup table RPC account");
  const executable = readOwnData(account, "executable", "Address lookup table RPC account");
  const rawData = readOwnData(account, "data", "Address lookup table RPC account");
  if (!Array.isArray(rawData) || Object.getPrototypeOf(rawData) !== Array.prototype ||
      rawData.length !== 2 || Reflect.ownKeys(rawData).length !== 3) {
    throw new Error("Address lookup table RPC account data is malformed");
  }
  const encoded = readOwnData(rawData, "0", "Address lookup table RPC account data");
  const encoding = readOwnData(rawData, "1", "Address lookup table RPC account data");
  return Object.freeze({ owner, executable, data: Object.freeze([encoded, encoding]) });
}

const SOLANA_PROGRAM_LOADER_IDS = new Set([
  "NativeLoader1111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "BPFLoader1111111111111111111111111111111111"
]);

/**
 * Read finalized account metadata for compiled instruction program IDs.
 * This proves only that each referenced account is marked executable and
 * owned by a recognized Solana loader at the returned finalized context.
 * It does not verify code identity, upgrade authority, semantics, or CPI.
 */
export async function resolveExecutableProgramAccounts(programIds, fetchImpl = fetch, minimumContextSlot = 0) {
  if (!Number.isSafeInteger(minimumContextSlot) || minimumContextSlot < 0) {
    throw new Error("Executable program minimum context slot is invalid");
  }
  const ids = snapshotDensePlainArray(
    programIds, 256, "Compiled instruction program IDs",
    "Compiled instruction program IDs are malformed"
  );
  if (ids.length === 0 || ids.some(id => !isCanonicalPublicKey(id)) ||
      new Set(ids).size !== ids.length) {
    throw new Error("Compiled instruction program IDs are missing, invalid, or duplicated");
  }
  const resolved = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const config = {
      commitment: "finalized",
      encoding: "base64",
      dataSlice: { offset: 0, length: 0 },
      ...(minimumContextSlot > 0 ? { minContextSlot: minimumContextSlot } : {})
    };
    const result = await rpc(fetchImpl, "getMultipleAccounts", [batch, config]);
    const slot = result?.context?.slot;
    const accounts = result?.value;
    if (!Number.isSafeInteger(slot) || slot < 1 || slot < minimumContextSlot ||
        !Array.isArray(accounts) || accounts.length !== batch.length) {
      throw new Error("Finalized program account RPC context or account count is invalid");
    }
    minimumContextSlot = slot;
    for (let index = 0; index < batch.length; index++) {
      const account = accounts[index];
      if (!account || typeof account !== "object" || Array.isArray(account) ||
          (Object.getPrototypeOf(account) !== Object.prototype && Object.getPrototypeOf(account) !== null)) {
        throw new Error("Referenced program account is missing or malformed");
      }
      const ownerDescriptor = Object.getOwnPropertyDescriptor(account, "owner");
      const executableDescriptor = Object.getOwnPropertyDescriptor(account, "executable");
      if (!ownerDescriptor || !Object.prototype.hasOwnProperty.call(ownerDescriptor, "value") ||
          !executableDescriptor || !Object.prototype.hasOwnProperty.call(executableDescriptor, "value")) {
        throw new Error("Referenced program account has missing or accessor-backed metadata");
      }
      const owner = ownerDescriptor.value;
      const executable = executableDescriptor.value;
      if (!isCanonicalPublicKey(owner) || executable !== true ||
          !SOLANA_PROGRAM_LOADER_IDS.has(owner)) {
        throw new Error("Referenced program is not confirmed executable under a recognized Solana loader");
      }
      resolved.push(Object.freeze({
        programId: batch[index],
        owner,
        executable: true,
        commitment: "finalized",
        contextSlot: slot
      }));
    }
  }
  return Object.freeze({
    scope: "finalized-account-executable-flag-and-loader-owner-only",
    contextSlot: minimumContextSlot,
    programs: Object.freeze(resolved)
  });
}

export async function resolveJupiterAddressLookupTables(lookups, fetchImpl = fetch) {
  const lookupSnapshot = snapshotDensePlainArray(
    lookups, 64, "Jupiter address lookup descriptors",
    "Jupiter address lookup table keys are invalid or duplicated"
  );
  if (lookupSnapshot.length === 0) {
    throw new Error("Jupiter address lookup descriptors are missing or invalid");
  }
  // Snapshot every descriptor and index list before reading values or making
  // an RPC request. This exported entry point must be safe when called without
  // the transaction parser, including against accessor-backed hostile inputs.
  const tables = lookupSnapshot.map((item, index) => {
    const descriptor = snapshotPlainRecord(
      item, ["accountKey", "writableIndexes", "readonlyIndexes"],
      "Jupiter address lookup descriptor " + index
    );
    const writableIndexes = snapshotDensePlainArray(
      descriptor.writableIndexes, 256,
      "Jupiter writable lookup indexes", "Jupiter address lookup indexes are malformed"
    );
    const readonlyIndexes = snapshotDensePlainArray(
      descriptor.readonlyIndexes, 256,
      "Jupiter readonly lookup indexes", "Jupiter address lookup indexes are malformed"
    );
    return Object.freeze({
      accountKey: descriptor.accountKey,
      writableIndexes: Object.freeze(writableIndexes),
      readonlyIndexes: Object.freeze(readonlyIndexes)
    });
  });
  const keys = tables.map(item => item.accountKey);
  if (keys.some(key => typeof key !== "string" || decodeBase58(key).length !== 32) ||
      new Set(keys).size !== keys.length) {
    throw new Error("Jupiter address lookup table keys are invalid or duplicated");
  }
  for (const table of tables) {
    const indexes = [...table.writableIndexes, ...table.readonlyIndexes];
    if (indexes.length > 256 ||
        indexes.some(index => !Number.isInteger(index) || index < 0 || index > 255) ||
        new Set(indexes).size !== indexes.length) {
      throw new Error("Jupiter address lookup indexes are invalid or duplicated");
    }
  }
  lookups = tables;
  const result = await rpc(fetchImpl, "getMultipleAccounts", [
    keys, { commitment: "finalized", encoding: "base64" }
  ]);
  const contextSlot = result?.context?.slot;
  const accounts = result?.value;
  if (!Number.isSafeInteger(contextSlot) || contextSlot < 1 ||
      !Array.isArray(accounts) || accounts.length !== lookups.length) {
    throw new Error("Address lookup RPC response context or account count is invalid");
  }
  const resolved = [];
  for (let i = 0; i < lookups.length; i++) {
    const account = snapshotLookupRpcAccount(accounts[i]);
    if (account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ID ||
        account.executable !== false ||
        typeof account.data[0] !== "string" ||
        account.data[1] !== "base64") {
      throw new Error("Address lookup table is missing, malformed, executable, or owned by an unexpected program");
    }
    // Bound and canonicalize RPC-controlled base64 before decoding.
    const encodedData = account.data[0];
    const maxLookupTableBase64Length = 4 * Math.ceil((56 + 256 * 32) / 3);
    if (encodedData.length > maxLookupTableBase64Length ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedData)) {
      throw new Error("Address lookup table account data exceeds limits or is not canonical base64");
    }
    const data = Uint8Array.from(atob(encodedData), char => char.charCodeAt(0));
    if (btoa(String.fromCharCode(...data)) !== encodedData) {
      throw new Error("Address lookup table account data is not canonical base64");
    }
    const decodedTable = decodeAddressLookupTableAccountData(data);
    if (decodedTable.deactivationSlot !== ALT_DEACTIVATION_SLOT_NEVER) {
      throw new Error("Deactivated address lookup tables are not trusted");
    }
    if (decodedTable.lastExtendedSlot > BigInt(contextSlot)) {
      throw new Error("Address lookup table extension slot is ahead of RPC context");
    }
    const addresses = decodedTable.addresses;
    const lastExtendedSlot = decodedTable.lastExtendedSlot;
    const lastExtendedStartIndex = decodedTable.lastExtendedSlotStartIndex;
    const table = lookups[i];
    const allIndexes = [...table.writableIndexes, ...table.readonlyIndexes];
    if (allIndexes.some(index => index >= addresses.length)) {
      throw new Error("Address lookup table index is outside the resolved address range");
    }
    const usableCount = lastExtendedSlot === BigInt(contextSlot)
      ? lastExtendedStartIndex
      : addresses.length;
    if (allIndexes.some(index => index >= usableCount)) {
      throw new Error("Address lookup table contains an address that is not warmed up");
    }
    resolved.push({
      accountKey: table.accountKey,
      writable: table.writableIndexes.map(index => addresses[index]),
      readonly: table.readonlyIndexes.map(index => addresses[index])
    });
  }
  // Solana compiles loaded account keys as all writable addresses first,
  // followed by all readonly addresses, preserving table order within each set.
  const writableAddresses = resolved.flatMap(table => table.writable);
  const readonlyAddresses = resolved.flatMap(table => table.readonly);
  if (writableAddresses.length + readonlyAddresses.length > 256) {
    throw new Error("Jupiter address lookup resolution exceeds the 256-account message key limit");
  }
  // A compiled message has one canonical account-key index per address.
  // Reject duplicate ALT-loaded keys instead of accepting ambiguous layouts.
  const loadedAddresses = [...writableAddresses, ...readonlyAddresses];
  if (new Set(loadedAddresses).size !== loadedAddresses.length) {
    throw new Error("Address lookup tables resolve duplicate account addresses");
  }
  return Object.freeze({
    contextSlot,
    writableAddresses: Object.freeze(writableAddresses),
    readonlyAddresses: Object.freeze(readonlyAddresses),
    tables: Object.freeze(resolved.map(table => Object.freeze({
      ...table,
      writable: Object.freeze(table.writable),
      readonly: Object.freeze(table.readonly)
    })))
  });
}

/**
 * Validates the unsigned message and resolves every v0 ALT against finalized
 * RPC state. The result remains structurally trusted only; instruction
 * semantics are deliberately never promoted by address resolution alone.
 */
async function createUnsignedMessageDigest(encoded, parsed, expectedSigner) {
  // Hash the exact serialized message bytes, excluding the transaction signature
  // vector. The digest is an integrity identifier, not semantic approval.
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  let messageStart;
  let messageEnd = bytes.length;
  if (parsed.messageVersion === 1) {
    messageStart = 1;
    messageEnd -= parsed.signatureCount * 64;
  } else {
    const signatureHeader = readShortVector(bytes, 0);
    messageStart = signatureHeader.offset + parsed.signatureCount * 64;
  }
  if (!Number.isSafeInteger(messageStart) || messageStart < 1 ||
      messageEnd <= messageStart || messageEnd > bytes.length) {
    throw new Error("Unable to isolate canonical serialized transaction message");
  }
  const messageBytes = bytes.slice(messageStart, messageEnd);
  if (!globalThis.crypto?.subtle?.digest) {
    throw new Error("Web Crypto SHA-256 is unavailable; message binding rejected");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", messageBytes));
  const value = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  return Object.freeze({
    algorithm: "SHA-256",
    encoding: "hex",
    value,
    messageVersion: parsed.messageVersion,
    signer: expectedSigner,
    byteLength: messageBytes.length
  });
}

function collectCompiledInstructionProgramIds(parsed, accountKeys) {
  if (!Array.isArray(parsed?.compiledInstructions) || parsed.compiledInstructions.length === 0 ||
      !Array.isArray(accountKeys) || accountKeys.length === 0) {
    throw new Error("Compiled instruction program evidence is incomplete");
  }
  const programIds = [];
  const seen = new Set();
  for (const instruction of parsed.compiledInstructions) {
    const index = instruction?.programIdIndex;
    if (!Number.isInteger(index) || index < 0 || index >= accountKeys.length) {
      throw new Error("Compiled instruction program index is outside resolved message keys");
    }
    const programId = accountKeys[index];
    if (!isCanonicalPublicKey(programId)) {
      throw new Error("Compiled instruction program ID is invalid");
    }
    if (!seen.has(programId)) {
      seen.add(programId);
      programIds.push(programId);
    }
  }
  return Object.freeze(programIds);
}

export async function validateAndResolveUnsignedJupiterTransaction(
  encoded, expectedSigner, fetchImpl = fetch
) {
  const parsed = validateUnsignedJupiterTransaction(encoded, expectedSigner);
  if (parsed.addressLookupCount === 0) {
    const messageDigest = await createUnsignedMessageDigest(encoded, parsed, expectedSigner);
    const accountKeys = parsed.staticAccountKeys;
    const programIds = collectCompiledInstructionProgramIds(parsed, accountKeys);
    const programExecutableEvidence = await resolveExecutableProgramAccounts(programIds, fetchImpl);
    const evidence = Object.freeze({
      ...parsed,
      header: Object.freeze({
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: parsed.numReadonlyUnsignedAccounts
      }),
      accountKeys,
      resolvedAddressTableLookups: Object.freeze([]),
      messageDigest,
      lookupTableResolution: "not-required",
      resolvedWritableAddresses: Object.freeze([]),
      resolvedReadonlyAddresses: Object.freeze([]),
      programExecutableEvidence,
      programExecutableFlagsVerified: true
    });
    TRUSTED_UNSIGNED_MESSAGE_EVIDENCE.add(evidence);
    return evidence;
  }
  if (!Array.isArray(parsed.addressLookups) ||
      parsed.addressLookups.length !== parsed.addressLookupCount) {
    throw new Error("Jupiter address lookup descriptors are incomplete");
  }
  const selectedLookupAddressCount = parsed.addressLookups.reduce((sum, table) =>
    sum + table.writableIndexes.length + table.readonlyIndexes.length, 0);
  if (parsed.staticAccountCount + selectedLookupAddressCount > 256) {
    throw new Error("Jupiter transaction exceeds the 256-account message key limit");
  }
  const resolution = await resolveJupiterAddressLookupTables(parsed.addressLookups, fetchImpl);
  const allMessageKeys = [...parsed.staticAccountKeys, ...resolution.writableAddresses, ...resolution.readonlyAddresses];
  if (new Set(allMessageKeys).size !== allMessageKeys.length) {
    throw new Error("Jupiter address lookup tables duplicate a static transaction account key");
  }
  const messageDigest = await createUnsignedMessageDigest(encoded, parsed, expectedSigner);
  const accountKeys = Object.freeze(allMessageKeys);
  const programIds = collectCompiledInstructionProgramIds(parsed, accountKeys);
  const programExecutableEvidence = await resolveExecutableProgramAccounts(
    programIds, fetchImpl, resolution.contextSlot
  );
  const resolvedAddressTableLookups = Object.freeze(resolution.tables.map(table =>
    Object.freeze({
      writableAddresses: table.writable,
      readonlyAddresses: table.readonly
    })
  ));
  const evidence = Object.freeze({
    ...parsed,
    header: Object.freeze({
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: parsed.numReadonlyUnsignedAccounts
    }),
    accountKeys,
    resolvedAddressTableLookups,
    messageDigest,
    lookupTableResolution: "finalized-resolved",
    lookupContextSlot: resolution.contextSlot,
    resolvedWritableAddresses: resolution.writableAddresses,
    resolvedReadonlyAddresses: resolution.readonlyAddresses,
    programExecutableEvidence,
    programExecutableFlagsVerified: true,
    semanticInstructionVerification: false
  });
  TRUSTED_UNSIGNED_MESSAGE_EVIDENCE.add(evidence);
  return evidence;
}

async function rpc(fetchImpl, method, params) {
  const payload = await fetchJson(fetchImpl, DEVNET_OR_MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.jsonrpc !== "2.0" || payload.id !== 1 ||
      payload.error || !Object.prototype.hasOwnProperty.call(payload, "result")) {
    throw new Error(method + " RPC response envelope or result is invalid");
  }
  return payload.result;
}

function sumOwnedTokenBalance(rows, mint, owner) {
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) {
    throw new Error("Finalized transaction token balance metadata is unavailable");
  }
  const keys = Reflect.ownKeys(rows);
  if (keys.length !== rows.length + 1 || !keys.includes("length")) {
    throw new Error("Finalized transaction token balance metadata is malformed");
  }
  let total = 0n;
  for (let index = 0; index < rows.length; index++) {
    const rowDescriptor = Object.getOwnPropertyDescriptor(rows, String(index));
    const row = rowDescriptor?.value;
    if (!rowDescriptor || !Object.prototype.hasOwnProperty.call(rowDescriptor, "value") ||
        !row || typeof row !== "object" ||
        (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)) {
      throw new Error("Finalized transaction token balance metadata is malformed");
    }
    const mintDescriptor = Object.getOwnPropertyDescriptor(row, "mint");
    const ownerDescriptor = Object.getOwnPropertyDescriptor(row, "owner");
    const amountRecordDescriptor = Object.getOwnPropertyDescriptor(row, "uiTokenAmount");
    if (!mintDescriptor || !Object.prototype.hasOwnProperty.call(mintDescriptor, "value") ||
        !ownerDescriptor || !Object.prototype.hasOwnProperty.call(ownerDescriptor, "value") ||
        !amountRecordDescriptor || !Object.prototype.hasOwnProperty.call(amountRecordDescriptor, "value") ||
        typeof mintDescriptor.value !== "string" || typeof ownerDescriptor.value !== "string") {
      throw new Error("Finalized transaction token balance metadata is malformed");
    }
    if (mintDescriptor.value !== mint || ownerDescriptor.value !== owner) continue;
    const amountRecord = amountRecordDescriptor.value;
    if (!amountRecord || typeof amountRecord !== "object" ||
        (Object.getPrototypeOf(amountRecord) !== Object.prototype && Object.getPrototypeOf(amountRecord) !== null)) {
      throw new Error("Finalized transaction contains an invalid owned token balance");
    }
    const amountDescriptor = Object.getOwnPropertyDescriptor(amountRecord, "amount");
    const amount = amountDescriptor?.value;
    if (!amountDescriptor || !Object.prototype.hasOwnProperty.call(amountDescriptor, "value") ||
        typeof amount !== "string" || !/^(0|[1-9]\d*)$/.test(amount)) {
      throw new Error("Finalized transaction contains an invalid owned token balance");
    }
    total += BigInt(amount);
  }
  return total;
}
/**
 * Independently verifies a finalized swap using signature status and the
 * transaction's owner-scoped pre/post balances. It never trusts caller-supplied
 * success flags. All input and output mints, including wrapped SOL, are
 * verified through exact owner-scoped SPL token balance deltas.
 */
function snapshotDenseAccountKeys(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("Finalized transaction account keys are invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw new Error("Finalized transaction account keys are incomplete");
  }
  const snapshot = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const entry = descriptor?.value;
    let key = entry;
    if (entry && typeof entry === "object" && Object.getPrototypeOf(entry) === Object.prototype) {
      const entryKeys = Reflect.ownKeys(entry);
      const pubkeyDescriptor = Object.getOwnPropertyDescriptor(entry, "pubkey");
      key = pubkeyDescriptor?.value;
      if (entryKeys.length !== 1 || entryKeys[0] !== "pubkey" ||
          !pubkeyDescriptor || !Object.prototype.hasOwnProperty.call(pubkeyDescriptor, "value")) {
        throw new Error("Finalized transaction account keys are malformed");
      }
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        typeof key !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key) ||
        decodeBase58(key).length !== 32) {
      throw new Error("Finalized transaction account keys are malformed");
    }
    snapshot.push(key);
  }
  return Object.freeze(snapshot);
}

function validateDenseLamportBalances(value, expectedLength) {
  if (!Array.isArray(value) || value.length !== expectedLength) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedLength + 1 || !keys.includes("length")) return false;
  for (let index = 0; index < expectedLength; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) return false;
  }
  return true;
}

export async function verifyFinalizedJupiterSettlement({
  signature, inputMint, outputMint, inputAmount, outputAmount,
  expectedOwner = EXPECTED_BOT_WALLET
}, fetchImpl = fetch) {
  const validAddress = value => typeof value === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && decodeBase58(value).length === 32;
  const validAmount = value => typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n;
  if (typeof signature !== "string" || decodeBase58(signature).length !== 64 ||
      !validAddress(inputMint) || !validAddress(outputMint) || inputMint === outputMint ||
      !validAddress(expectedOwner) || expectedOwner !== EXPECTED_BOT_WALLET ||
      !validAmount(inputAmount) || !validAmount(outputAmount)) {
    throw new Error("Settlement proof request is incomplete or invalid");
  }

  const statusResult = await rpc(fetchImpl, "getSignatureStatuses", [
    [signature], { searchTransactionHistory: true }
  ]);
  const status = statusResult?.value?.[0];
  if (!status || status.err !== null || status.confirmationStatus !== "finalized") {
    throw new Error("Swap signature is not successfully finalized");
  }

  const transaction = await rpc(fetchImpl, "getTransaction", [
    signature, {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: 0
    }
  ]);
  const meta = transaction?.meta;
  const message = transaction?.transaction?.message;
  const signatures = transaction?.transaction?.signatures;
  const accountKeys = message?.accountKeys;
  if (!transaction || !Number.isSafeInteger(transaction.slot) || transaction.slot < 1 ||
      !meta || meta.err !== null || !Array.isArray(signatures) || signatures[0] !== signature ||
      !Array.isArray(accountKeys) ||
      !validateDenseLamportBalances(meta.preBalances, accountKeys.length) ||
      !validateDenseLamportBalances(meta.postBalances, accountKeys.length) ||
      !Number.isSafeInteger(meta.fee) || meta.fee < 0) {
    throw new Error("Finalized transaction metadata is incomplete or indicates failure");
  }
  const keyStrings = snapshotDenseAccountKeys(accountKeys);
  const ownerIndex = keyStrings.indexOf(expectedOwner);
  // Solana's first required signer is the fee payer. Require the pinned bot
  // wallet in that position so a third-party transaction cannot settle an order.
  if (ownerIndex !== 0) throw new Error("Expected bot wallet is not the finalized transaction fee payer");

  const preOutput = sumOwnedTokenBalance(meta.preTokenBalances, outputMint, expectedOwner);
  const postOutput = sumOwnedTokenBalance(meta.postTokenBalances, outputMint, expectedOwner);
  if (postOutput - preOutput !== BigInt(outputAmount)) {
    throw new Error("Finalized output token balance delta does not match the reserved amount");
  }

  // Jupiter's SOL mint is wrapped SOL (an SPL token), not the wallet's
  // native lamport balance. Verify the exact token-account delta for every
  // input mint; native lamport deltas also include fees and account rent.
  const preInput = sumOwnedTokenBalance(meta.preTokenBalances, inputMint, expectedOwner);
  const postInput = sumOwnedTokenBalance(meta.postTokenBalances, inputMint, expectedOwner);
  if (preInput - postInput !== BigInt(inputAmount)) {
    throw new Error("Finalized input token balance delta does not match the reserved amount");
  }

  return Object.freeze({
    // "verified" is deliberately scoped to the exact finalized, owner-scoped
    // SPL balance deltas above. It is not whole-message semantic verification
    // or an all-in native SOL cost attestation.
    verified: true,
    proofScope: "finalized-owner-scoped-token-balance-deltas",
    semanticInstructionVerification: false,
    allInCostsVerified: false,
    signature,
    slot: transaction.slot,
    confirmationStatus: "finalized",
    inputMint,
    inputAmount,
    outputMint,
    outputAmount,
    owner: expectedOwner
  });
}


export function parseTrustedMintAccount(account) {
  const value = account?.value;
  if (!value) throw new Error("Mint account is unavailable");
  const tokenProgram = value.owner;
  if (!EXPECTED_TOKEN_PROGRAMS.has(tokenProgram)) {
    throw new Error("Mint account is owned by an unsupported token program");
  }
  const dataRecord = value.data;
  const parsedEnvelope = dataRecord && typeof dataRecord === "object" &&
    !Array.isArray(dataRecord) &&
    (Object.getPrototypeOf(dataRecord) === Object.prototype ||
      Object.getPrototypeOf(dataRecord) === null)
    ? Object.getOwnPropertyDescriptor(dataRecord, "parsed")
    : undefined;
  const parsed = parsedEnvelope &&
    Object.prototype.hasOwnProperty.call(parsedEnvelope, "value")
    ? parsedEnvelope.value : undefined;
  const infoDescriptor = parsed && typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (Object.getPrototypeOf(parsed) === Object.prototype ||
      Object.getPrototypeOf(parsed) === null)
    ? Object.getOwnPropertyDescriptor(parsed, "info")
    : undefined;
  if (infoDescriptor &&
      Object.prototype.hasOwnProperty.call(infoDescriptor, "value")) {
    const info = infoDescriptor.value;
    if (!info || typeof info !== "object" || Array.isArray(info) ||
        (Object.getPrototypeOf(info) !== Object.prototype &&
          Object.getPrototypeOf(info) !== null)) {
      throw new Error("Parsed mint account information is malformed");
    }
    const mintAuthority = Object.getOwnPropertyDescriptor(info, "mintAuthority");
    const freezeAuthority = Object.getOwnPropertyDescriptor(info, "freezeAuthority");
    const extensions = Object.getOwnPropertyDescriptor(info, "extensions");
    if (!mintAuthority || !Object.prototype.hasOwnProperty.call(mintAuthority, "value") ||
        !freezeAuthority || !Object.prototype.hasOwnProperty.call(freezeAuthority, "value")) {
      throw new Error("Parsed mint authority metadata is incomplete");
    }
    const validAuthority = authority => authority === null ||
      isCanonicalPublicKey(authority);
    if (!validAuthority(mintAuthority.value) ||
        !validAuthority(freezeAuthority.value)) {
      throw new Error("Parsed mint authority metadata is malformed");
    }
    let token2022ExtensionsSafe = tokenProgram === TOKEN_PROGRAM_ID;
    if (tokenProgram === TOKEN_2022_PROGRAM_ID) {
      if (!extensions || !Object.prototype.hasOwnProperty.call(extensions, "value")) {
        token2022ExtensionsSafe = false;
      } else {
        const extensionList = snapshotDensePlainArray(
          extensions.value, 64, "Parsed Token-2022 mint extensions",
          "Parsed Token-2022 mint extensions are malformed"
        );
        token2022ExtensionsSafe = extensionList.length === 0;
      }
    } else if (extensions) {
      if (!Object.prototype.hasOwnProperty.call(extensions, "value")) {
        throw new Error("Parsed mint extensions contain accessor-backed metadata");
      }
      const extensionList = snapshotDensePlainArray(
        extensions.value, 64, "Parsed mint extensions",
        "Parsed mint extensions are malformed"
      );
      if (extensionList.length !== 0) {
        token2022ExtensionsSafe = false;
      }
    }
    return {
      mintAuthoritySafe: mintAuthority.value === null,
      freezeAuthoritySafe: freezeAuthority.value === null,
      token2022ExtensionsSafe
    };
  }
  if (!EXPECTED_TOKEN_PROGRAMS.has(value.owner)) {
    throw new Error("Mint account is owned by an unsupported token program");
  }
  const raw = value.data;
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype ||
      raw.length !== 2 || Reflect.ownKeys(raw).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(raw, "0") ||
      !Object.prototype.hasOwnProperty.call(raw, "1")) {
    throw new Error("Mint account encoding is unsupported");
  }
  const encoded = Object.getOwnPropertyDescriptor(raw, "0");
  const encoding = Object.getOwnPropertyDescriptor(raw, "1");
  if (!encoded || !Object.prototype.hasOwnProperty.call(encoded, "value") ||
      !encoding || !Object.prototype.hasOwnProperty.call(encoding, "value") ||
      encoding.value !== "base64" || typeof encoded.value !== "string" ||
      encoded.value.length === 0 || encoded.value.length > 16384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded.value)) {
    throw new Error("Mint account encoding is unsupported");
  }
  const decoded = atob(encoded.value);
  const canonical = btoa(decoded);
  if (canonical !== encoded.value) {
    throw new Error("Mint account data is not canonical base64");
  }
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  if (bytes.length < 82) throw new Error("Mint account data is truncated");
  const u32 = offset => (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  const mintOption = u32(0);
  const freezeOption = u32(46);
  if (mintOption > 1 || freezeOption > 1) throw new Error("Mint authority layout is invalid");
  let hasToken2022Extensions = false;
  if (value.owner === TOKEN_PROGRAM_ID) {
    if (bytes.length !== 82) {
      throw new Error("Classic SPL Token mint account must use the exact base layout");
    }
  } else if (bytes.length !== 82) {
    // Token-2022 extended mints use the 82-byte base mint, zero padding
    // through byte 164, an AccountType byte at 165, then TLV records at 166.
    if (bytes.length < 166) {
      throw new Error("Token-2022 mint extension header is truncated");
    }
    for (let index = 82; index < 165; index++) {
      if (bytes[index] !== 0) {
        throw new Error("Token-2022 mint padding is not canonical");
      }
    }
    if (bytes[165] !== 1) {
      throw new Error("Token-2022 account type is not Mint");
    }
    const seenExtensionTypes = new Set();
    let offset = 166;
    let terminated = false;
    while (offset < bytes.length) {
      if (bytes.length - offset < 4) {
        throw new Error("Token-2022 extension TLV header is truncated");
      }
      const type = bytes[offset] | (bytes[offset + 1] << 8);
      const length = bytes[offset + 2] | (bytes[offset + 3] << 8);
      offset += 4;
      if (type === 0 && length === 0) {
        terminated = true;
        for (let index = offset; index < bytes.length; index++) {
          if (bytes[index] !== 0) {
            throw new Error("Token-2022 extension padding is not canonical");
          }
        }
        break;
      }
      if (type === 0 || length === 0 || seenExtensionTypes.has(type) ||
          offset + length > bytes.length) {
        throw new Error("Token-2022 extension TLV record is invalid");
      }
      seenExtensionTypes.add(type);
      hasToken2022Extensions = true;
      offset += length;
    }
    // A terminator is optional when the final TLV record exactly reaches
    // account end. All extension-bearing mints remain unsafe until each
    // extension type has a dedicated, reviewed semantic policy.
    if (terminated && offset > bytes.length) {
      throw new Error("Token-2022 extension terminator is invalid");
    }
  }
  return {
    mintAuthoritySafe: mintOption === 0,
    freezeAuthoritySafe: freezeOption === 0,
    token2022ExtensionsSafe: value.owner === TOKEN_PROGRAM_ID ||
      (bytes.length === 82 && !hasToken2022Extensions)
  };
}

/**
 * Risk evidence is generated from server-fetched feeds for the exact mint.
 * Holder concentration is accepted only after all paginated token accounts
 * reconcile exactly to on-chain supply. Jupiter V2 order responses are
 * inspected structurally only; semantic instruction verification is not
 * implemented, so sell-route safety remains false and reservations fail closed.
 */
export async function fetchTrustedTokenRisk(mint, fetchImpl = fetch, alchemyApiKey = "", jupiterApiKey = "") {
  // Timestamp evidence before the slowest upstream request begins. Recording it
  // only after holder pagination and the Jupiter probe could make old market,
  // RugCheck, RPC, or holder data appear freshly fetched.
  const fetchedAt = Date.now();
  if (typeof mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || mint === SOL_MINT) {
    throw new Error("A valid non-SOL output mint is required for risk inspection");
  }
  const [dex, rug, mintAccount, supply, holderAccounts] = await Promise.all([
    fetchJson(fetchImpl, DEX_TOKEN_URL + encodeURIComponent(mint)),
    fetchJson(fetchImpl, RUGCHECK_URL + encodeURIComponent(mint) + "/report"),
    rpc(fetchImpl, "getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "finalized" }]),
    rpc(fetchImpl, "getTokenSupply", [mint, { commitment: "finalized" }]),
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
  const mintSafety = parseTrustedMintAccount(mintAccount);
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
    // Structure alone does not verify programs, recipients, or lookup-table addresses.
    sellRouteAvailable: sellRoute.semanticInstructionVerification === true,
    marketLiquiditySafe: liquidityUsd >= 10000,
    marketVolumeSafe: volume24hUsd >= 1000 && sells24h > 0,
    rugCheckSafe: Number(rug.score) <= 2500
  };
  return Object.freeze({
    mint,
    provider: "DexScreener + RugCheck + Alchemy DAS + Solana mainnet RPC + Jupiter Swap API V2",
    fetchedAt,
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
