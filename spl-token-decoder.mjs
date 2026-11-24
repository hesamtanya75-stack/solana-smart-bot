const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SUPPORTED_TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
const MAX_DATA_LENGTH = 16;
const decodedRecords = new WeakSet();

function readDensePlainArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum) {
    throw new Error(label + " are invalid");
  }
  const keys = Reflect.ownKeys(value);
  const snapshot = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      throw new Error(label + " are invalid");
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contain accessor-backed entries");
    }
    snapshot.push(descriptor.value);
  }
  if (keys.length !== value.length + 1) {
    throw new Error(label + " contain unsupported properties");
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length) {
      throw new Error(label + " contain unsupported properties");
    }
  }
  return snapshot;
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DATA_LENGTH ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("SPL Token instruction data is not canonical base64");
  }
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) {
    throw new Error("SPL Token instruction data is not canonical base64");
  }
  return bytes;
}

function readU64LE(bytes, offset) {
  let value = 0n;
  for (let index = offset + 7; index >= offset; index--) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return value;
}

/**
 * Syntax-only decoder for exact single-authority base Transfer and
 * TransferChecked layouts under Classic SPL Token.
 *
 * Token-2022 is rejected before decoding because extension state can change
 * effective transfer behavior. This record is never a semantic approval or
 * proof of actual token deltas.
 */
export function decodeSplTokenInstruction(programId, encodedData, accountIndexes) {
  if (programId === TOKEN_2022_PROGRAM_ID) {
    // Token-2022 base transfer layouts do not establish effective transfer semantics.
    // Fees, hooks, confidential transfers and permanent delegates require state inspection.
    // Fail closed until a dedicated extension verifier is implemented.
    throw new Error("Token-2022 instructions are blocked until extension semantics are verified");
  }
  if (programId !== TOKEN_PROGRAM_ID) {
    throw new Error("SPL Token decoder rejects unknown program IDs");
  }
  const indexes = readDensePlainArray(
    accountIndexes, 64, "SPL Token account indexes"
  );
  for (const accountIndex of indexes) {
    if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > 255) {
      throw new Error("SPL Token account indexes are invalid");
    }
  }

  const bytes = decodeCanonicalBase64(encodedData);
  const tag = bytes[0];
  let decoded;
  if (tag === 3) {
    if (bytes.length !== 9 || indexes.length !== 3 ||
        new Set(indexes).size !== 3) {
      throw new Error("SPL Token Transfer payload or account layout is unsupported");
    }
    decoded = {
      variant: "transfer",
      amount: readU64LE(bytes, 1),
      accountRoles: ["source", "destination", "authority"],
      sourceAccountIndex: indexes[0],
      destinationAccountIndex: indexes[1],
      authorityAccountIndex: indexes[2]
    };
  } else if (tag === 12) {
    if (bytes.length !== 10 || indexes.length !== 4 ||
        new Set(indexes).size !== 4) {
      throw new Error("SPL Token TransferChecked payload or account layout is unsupported");
    }
    decoded = {
      variant: "transferChecked",
      amount: readU64LE(bytes, 1),
      decimals: bytes[9],
      accountRoles: ["source", "mint", "destination", "authority"],
      sourceAccountIndex: indexes[0],
      mintAccountIndex: indexes[1],
      destinationAccountIndex: indexes[2],
      authorityAccountIndex: indexes[3]
    };
  } else {
    throw new Error("SPL Token instruction variant is unsupported");
  }

  const record = Object.freeze({
    programId,
    decoderVersion: 1,
    analysisOnly: true,
    extensionSemantics: programId === TOKEN_2022_PROGRAM_ID ? "not-inspected" : "not-applicable",
    ...decoded,
    accountIndexes: Object.freeze(indexes),
    accountRoles: Object.freeze(decoded.accountRoles)
  });
  decodedRecords.add(record);
  return record;
}

export function validateSplTokenInstructionSet(instructions) {
  if (!Array.isArray(instructions) ||
      Object.getPrototypeOf(instructions) !== Array.prototype ||
      instructions.length > 64) {
    throw new Error("SPL Token instruction set is invalid");
  }
  const keys = Reflect.ownKeys(instructions);
  const snapshot = [];
  for (let index = 0; index < instructions.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(instructions, String(index));
    if (!descriptor) {
      throw new Error("SPL Token instruction set contains an unreviewed record");
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error("SPL Token instruction set is invalid");
    }
    if (!descriptor.value || !decodedRecords.has(descriptor.value)) {
      throw new Error("SPL Token instruction set contains an unreviewed record");
    }
    snapshot.push(descriptor.value);
  }
  if (keys.length !== instructions.length + 1 ||
      keys.some(key => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
         Number(key) >= instructions.length))) {
    throw new Error("SPL Token instruction set is invalid");
  }
  return Object.freeze(snapshot);
}
