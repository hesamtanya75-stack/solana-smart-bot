const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const MAX_DATA_LENGTH = 128;
const decodedRecords = new WeakSet();

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DATA_LENGTH ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("System Program instruction data is not canonical base64");
  }
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) {
    throw new Error("System Program instruction data is not canonical base64");
  }
  return bytes;
}

function readU32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readU64LE(bytes, offset) {
  let value = 0n;
  for (let i = offset + 7; i >= offset; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function toHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Syntax-only decoder for two explicitly reviewed System Program variants.
 * It does not validate account privileges, signatures, runtime state, rent,
 * CPI behavior, transaction intent, or net funds flow.
 */
export function decodeSystemProgramInstruction(programId, encodedData, accountIndexes) {
  if (programId !== SYSTEM_PROGRAM_ID) throw new Error("System decoder rejects unknown program IDs");
  if (!Array.isArray(accountIndexes) || accountIndexes.some(index =>
    !Number.isInteger(index) || index < 0 || index > 255)) {
    throw new Error("System instruction account indexes are invalid");
  }
  const bytes = decodeCanonicalBase64(encodedData);
  if (bytes.length < 4) throw new Error("System instruction discriminator is truncated");
  const variant = readU32LE(bytes, 0);
  let decoded;
  if (variant === 2) {
    if (bytes.length !== 12 || accountIndexes.length !== 2) {
      throw new Error("System Transfer payload or account count is invalid");
    }
    decoded = { variant: "transfer", lamports: readU64LE(bytes, 4), accountRoles: ["source", "destination"] };
  } else if (variant === 0) {
    if (bytes.length !== 52 || accountIndexes.length !== 2) {
      throw new Error("System CreateAccount payload or account count is invalid");
    }
    decoded = {
      variant: "createAccount",
      lamports: readU64LE(bytes, 4),
      space: readU64LE(bytes, 12),
      ownerBytesHex: toHex(bytes.slice(20, 52)),
      accountRoles: ["funding", "newAccount"]
    };
  } else {
    throw new Error("System instruction variant is unsupported");
  }
  const record = Object.freeze({
    programId: SYSTEM_PROGRAM_ID,
    decoderVersion: 1,
    analysisOnly: true,
    ...decoded,
    accountRoles: Object.freeze(decoded.accountRoles)
  });
  decodedRecords.add(record);
  return record;
}

export function validateSystemProgramInstructionSet(instructions) {
  if (!Array.isArray(instructions) || instructions.length > 64 ||
      instructions.some(instruction => !instruction || !decodedRecords.has(instruction))) {
    throw new Error("System instruction set contains an unreviewed record");
  }
  return Object.freeze([...instructions]);
}
