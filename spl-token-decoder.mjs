const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MAX_DATA_LENGTH = 16;
const decodedRecords = new WeakSet();

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
 * Syntax-only decoder for exact single-authority classic SPL Token transfers.
 * Multisig layouts and every other instruction variant intentionally fail closed.
 */
export function decodeSplTokenInstruction(programId, encodedData, accountIndexes) {
  if (programId !== TOKEN_PROGRAM_ID) {
    throw new Error("SPL Token decoder rejects unknown program IDs");
  }
  if (!Array.isArray(accountIndexes) || accountIndexes.length > 64) {
    throw new Error("SPL Token account indexes are invalid");
  }
  for (let index = 0; index < accountIndexes.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(accountIndexes, index) ||
        !Number.isInteger(accountIndexes[index]) ||
        accountIndexes[index] < 0 || accountIndexes[index] > 255) {
      throw new Error("SPL Token account indexes are invalid");
    }
  }

  const bytes = decodeCanonicalBase64(encodedData);
  const tag = bytes[0];
  let decoded;
  if (tag === 3) {
    if (bytes.length !== 9 || accountIndexes.length !== 3 ||
        new Set(accountIndexes).size !== 3) {
      throw new Error("SPL Token Transfer payload or account layout is unsupported");
    }
    decoded = {
      variant: "transfer",
      amount: readU64LE(bytes, 1),
      accountRoles: ["source", "destination", "authority"],
      sourceAccountIndex: accountIndexes[0],
      destinationAccountIndex: accountIndexes[1],
      authorityAccountIndex: accountIndexes[2]
    };
  } else if (tag === 12) {
    if (bytes.length !== 10 || accountIndexes.length !== 4 ||
        new Set(accountIndexes).size !== 4) {
      throw new Error("SPL Token TransferChecked payload or account layout is unsupported");
    }
    decoded = {
      variant: "transferChecked",
      amount: readU64LE(bytes, 1),
      decimals: bytes[9],
      accountRoles: ["source", "mint", "destination", "authority"],
      sourceAccountIndex: accountIndexes[0],
      mintAccountIndex: accountIndexes[1],
      destinationAccountIndex: accountIndexes[2],
      authorityAccountIndex: accountIndexes[3]
    };
  } else {
    throw new Error("SPL Token instruction variant is unsupported");
  }

  const record = Object.freeze({
    programId: TOKEN_PROGRAM_ID,
    decoderVersion: 1,
    analysisOnly: true,
    ...decoded,
    accountIndexes: Object.freeze([...accountIndexes]),
    accountRoles: Object.freeze(decoded.accountRoles)
  });
  decodedRecords.add(record);
  return record;
}

export function validateSplTokenInstructionSet(instructions) {
  if (!Array.isArray(instructions) || instructions.length > 64) {
    throw new Error("SPL Token instruction set is invalid");
  }
  for (let index = 0; index < instructions.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(instructions, index) ||
        !instructions[index] || !decodedRecords.has(instructions[index])) {
      throw new Error("SPL Token instruction set contains an unreviewed record");
    }
  }
  return Object.freeze([...instructions]);
}
