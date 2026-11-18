const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const decodedInstructionRecords = new WeakSet();
const decodedTransactionInstructionRecords = new WeakSet();

function readDensePlainArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum) {
    throw new Error(label + " is invalid");
  }
  const keys = Reflect.ownKeys(value);
  const snapshot = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) throw new Error(label + " contains a sparse entry");
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains an accessor-backed entry");
    }
    snapshot.push(descriptor.value);
  }
  if (keys.length !== value.length + 1 ||
      keys.some(key => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9]\\d*)$/.test(key) ||
         Number(key) >= value.length))) {
    throw new Error(label + " contains unsupported properties");
  }
  return snapshot;
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Compute Budget instruction data is not canonical base64");
  }
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) {
    throw new Error("Compute Budget instruction data is not canonical base64");
  }
  return bytes;
}

function readU32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * Decode one explicitly supported Compute Budget instruction.
 * This is a syntax decoder only: it does not attest transaction or route trust.
 */
export function decodeComputeBudgetInstruction(programId, encodedData) {
  if (programId !== COMPUTE_BUDGET_PROGRAM_ID) {
    throw new Error("Compute Budget decoder rejects unknown program IDs");
  }
  const bytes = decodeCanonicalBase64(encodedData);
  if (bytes.length !== 5 && bytes.length !== 9) {
    throw new Error("Compute Budget instruction has an unsupported payload length");
  }
  const tag = bytes[0];
  let decoded;
  if (tag === 1 && bytes.length === 5) {
    const heapFrameBytes = readU32LE(bytes, 1);
    if (heapFrameBytes < 32768 || heapFrameBytes > 262144 || heapFrameBytes % 1024 !== 0) {
      throw new Error("Compute Budget heap-frame size is outside the supported range");
    }
    decoded = { variant: "requestHeapFrame", heapFrameBytes };
  } else if (tag === 2 && bytes.length === 5) {
    const units = readU32LE(bytes, 1);
    if (units < 1 || units > 1400000) {
      throw new Error("Compute Budget unit limit is outside the supported range");
    }
    decoded = { variant: "setComputeUnitLimit", units };
  } else if (tag === 3 && bytes.length === 9) {
    let microLamports = 0n;
    for (let i = 8; i >= 1; i--) microLamports = (microLamports << 8n) | BigInt(bytes[i]);
    decoded = { variant: "setComputeUnitPrice", microLamports };
  } else if (tag === 4 && bytes.length === 5) {
    const bytesLimit = readU32LE(bytes, 1);
    if (bytesLimit < 1 || bytesLimit > 64 * 1024 * 1024) {
      throw new Error("Compute Budget loaded-account-data limit is outside the supported range");
    }
    decoded = { variant: "setLoadedAccountsDataSizeLimit", bytes: bytesLimit };
  } else {
    throw new Error("Compute Budget instruction variant or payload shape is unsupported");
  }
  const record = Object.freeze({
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    decoderVersion: 1,
    ...decoded
  });
  decodedInstructionRecords.add(record);
  return record;
}

/**
 * Enforce transaction-level uniqueness for decoded Compute Budget variants.
 * This does not verify other instruction families or attest the whole transaction.
 */
export function validateComputeBudgetInstructionSet(instructions) {
  const records = readDensePlainArray(instructions, 64, "Compute Budget instruction collection");
  const seen = new Set();
  for (const instruction of records) {
    if (!instruction || !decodedInstructionRecords.has(instruction) ||
        instruction.programId !== COMPUTE_BUDGET_PROGRAM_ID ||
        instruction.decoderVersion !== 1 ||
        typeof instruction.variant !== "string" || seen.has(instruction.variant)) {
      throw new Error("Compute Budget instruction set contains an unknown or duplicate variant");
    }
    seen.add(instruction.variant);
  }
  return Object.freeze(records);
}

export const COMPUTE_BUDGET_PROGRAM = COMPUTE_BUDGET_PROGRAM_ID;

/**
 * Versioned, reject-by-default transaction instruction decoder registry.
 *
 * Registry v1 intentionally supports only Compute Budget instructions, which
 * have no account metas. Every other program is rejected until a separately
 * reviewed decoder and account-role schema are added. This registry does not
 * establish whole-transaction semantics or authorize signing/submission.
 */
export const INSTRUCTION_DECODER_REGISTRY_VERSION = 1;

export function decodeSupportedTransactionInstruction({ programId, data, accountIndexes }) {
  if (typeof programId !== "string") {
    throw new Error("Instruction does not match a reviewed account-role schema");
  }
  const indexes = readDensePlainArray(accountIndexes, 0, "Instruction account indexes");
  if (indexes.length !== 0) {
    throw new Error("Instruction does not match a reviewed account-role schema");
  }
  if (programId !== COMPUTE_BUDGET_PROGRAM_ID) {
    throw new Error("Instruction registry rejects an unsupported program ID");
  }
  const decoded = decodeComputeBudgetInstruction(programId, data);
  const record = Object.freeze({
    registryVersion: INSTRUCTION_DECODER_REGISTRY_VERSION,
    programId,
    decoderVersion: decoded.decoderVersion,
    variant: decoded.variant,
    accountRoles: Object.freeze([]),
    decoded
  });
  decodedTransactionInstructionRecords.add(record);
  return record;
}

export function validateSupportedTransactionInstructionSet(instructions) {
  const records = readDensePlainArray(
    instructions, 64, "Supported transaction instruction collection"
  );
  const decoded = [];
  for (const instruction of records) {
    if (!instruction || !decodedTransactionInstructionRecords.has(instruction) ||
        instruction.registryVersion !== INSTRUCTION_DECODER_REGISTRY_VERSION ||
        instruction.programId !== COMPUTE_BUDGET_PROGRAM_ID ||
        instruction.decoderVersion !== 1 ||
        !Array.isArray(instruction.accountRoles) || instruction.accountRoles.length !== 0 ||
        !decodedInstructionRecords.has(instruction.decoded) ||
        instruction.decoded.variant !== instruction.variant) {
      throw new Error("Instruction registry rejected an unknown, forged, or unsupported record");
    }
    decoded.push(instruction.decoded);
  }
  validateComputeBudgetInstructionSet(decoded);
  return Object.freeze(records);
}


/**
 * Apply caller-supplied transaction policy ceilings to a reviewed Compute
 * Budget instruction set. Priority fee is conservatively rounded up to the
 * next lamport: ceil(microLamportsPerUnit * unitLimit / 1_000_000).
 *
 * This helper requires explicit finite policy limits and does not supply
 * defaults, infer runtime defaults, or attest the rest of the transaction.
 */
export function validateComputeBudgetPolicy(instructions, limits) {
  const reviewed = validateComputeBudgetInstructionSet(instructions);
  if (!limits || typeof limits !== "object" || Array.isArray(limits) ||
      !Number.isSafeInteger(limits.maxComputeUnitLimit) ||
      limits.maxComputeUnitLimit < 1 || limits.maxComputeUnitLimit > 1400000 ||
      !Number.isSafeInteger(limits.maxHeapFrameBytes) ||
      limits.maxHeapFrameBytes < 32768 || limits.maxHeapFrameBytes > 262144 ||
      limits.maxHeapFrameBytes % 1024 !== 0 ||
      !Number.isSafeInteger(limits.maxLoadedAccountDataBytes) ||
      limits.maxLoadedAccountDataBytes < 1 || limits.maxLoadedAccountDataBytes > 64 * 1024 * 1024 ||
      (typeof limits.maxPriorityFeeLamports !== "bigint" && !Number.isSafeInteger(limits.maxPriorityFeeLamports)) ||
      BigInt(limits.maxPriorityFeeLamports) < 0n) {
    throw new Error("Compute Budget policy limits are invalid or incomplete");
  }

  const byVariant = new Map(reviewed.map(instruction => [instruction.variant, instruction]));
  const unitLimit = byVariant.get("setComputeUnitLimit")?.units;
  const heapFrameBytes = byVariant.get("requestHeapFrame")?.heapFrameBytes;
  const loadedBytes = byVariant.get("setLoadedAccountsDataSizeLimit")?.bytes;
  const microLamports = byVariant.get("setComputeUnitPrice")?.microLamports ?? 0n;

  if (unitLimit !== undefined && unitLimit > limits.maxComputeUnitLimit) {
    throw new Error("Compute Budget unit limit exceeds transaction policy");
  }
  if (heapFrameBytes !== undefined && heapFrameBytes > limits.maxHeapFrameBytes) {
    throw new Error("Compute Budget heap-frame size exceeds transaction policy");
  }
  if (loadedBytes !== undefined && loadedBytes > limits.maxLoadedAccountDataBytes) {
    throw new Error("Compute Budget loaded-account-data limit exceeds transaction policy");
  }
  const effectiveUnits = BigInt(unitLimit ?? limits.maxComputeUnitLimit);
  const priorityFeeLamports = (microLamports * effectiveUnits + 999999n) / 1000000n;
  if (priorityFeeLamports > BigInt(limits.maxPriorityFeeLamports)) {
    throw new Error("Compute Budget priority fee exceeds transaction policy");
  }
  return Object.freeze({
    unitLimit: unitLimit ?? null,
    heapFrameBytes: heapFrameBytes ?? null,
    loadedAccountDataBytes: loadedBytes ?? null,
    priorityFeeLamports
  });
}
