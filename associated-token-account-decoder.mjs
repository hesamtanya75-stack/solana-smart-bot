const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const CLASSIC_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const decodedRecords = new WeakSet();

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function readDensePlainArray(value, maximum, exactLength, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum ||
      (exactLength !== null && value.length !== exactLength)) {
    throw new Error(label + " must be a bounded plain array");
  }
  const keys = Reflect.ownKeys(value);
  const snapshot = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) throw new Error(label + " must not be sparse");
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " must not contain accessor-backed entries");
    }
    snapshot.push(descriptor.value);
  }
  if (keys.length !== value.length + 1 ||
      keys.some(key => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
         Number(key) >= value.length))) {
    throw new Error(label + " contains unsupported properties");
  }
  return snapshot;
}

function isCanonicalPublicKey(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  let decoded = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let byteLength = 0;
  for (let remaining = decoded; remaining > 0n; remaining >>= 8n) byteLength++;
  const leadingZeroBytes = value.match(/^1*/)[0].length;
  return byteLength + leadingZeroBytes === 32;
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length !== 4 ||
      !/^[A-Za-z0-9+/]{2}==$/.test(value)) {
    throw new Error("Associated Token instruction data is not canonical one-byte base64");
  }
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value || bytes.length !== 1) {
    throw new Error("Associated Token instruction data is not canonical one-byte base64");
  }
  return bytes;
}

/**
 * Syntax-only decoder for ATA Create and CreateIdempotent.
 * It does not derive/verify the associated address or inspect account state.
 */
export function decodeAssociatedTokenInstruction(programId, encodedData, accountIndexes, accountKeys) {
  if (programId !== ASSOCIATED_TOKEN_PROGRAM_ID) {
    throw new Error("Associated Token decoder rejects unknown program IDs");
  }
  if (!Array.isArray(accountIndexes) || accountIndexes.length !== 6 ||
      !Array.isArray(accountKeys)) {
    throw new Error("Associated Token account layout is unsupported");
  }
  const indexes = readDensePlainArray(
    accountIndexes, 6, 6, "Associated Token account indexes"
  );
  const keys = readDensePlainArray(
    accountKeys, 256, null, "Associated Token account keys"
  );
  if (keys.length === 0) {
    throw new Error("Associated Token account layout is unsupported");
  }
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
      throw new Error("Associated Token account indexes are invalid");
    }
  }
  const [payerIndex, associatedIndex, ownerIndex, mintIndex, systemIndex, tokenProgramIndex] = indexes;
  // Compiled message account keys are deduplicated. Solana therefore encodes
  // payer === owner as the SAME account index, not as duplicate key entries.
  // Permit only this documented role alias; every other role index is distinct.
  const roleIndexes = [payerIndex, associatedIndex, ownerIndex, mintIndex, systemIndex, tokenProgramIndex];
  for (let left = 0; left < roleIndexes.length; left++) {
    for (let right = left + 1; right < roleIndexes.length; right++) {
      if (roleIndexes[left] === roleIndexes[right] &&
          !(left === 0 && right === 2)) {
        throw new Error("Associated Token account indexes contain an unsupported role alias");
      }
    }
  }
  const roleKeys = indexes.map(index => keys[index]);
  if (roleKeys.some(key => !isCanonicalPublicKey(key))) {
    throw new Error("Associated Token role accounts must be canonical 32-byte public keys");
  }
  // Compiled message account keys are deduplicated by public key as well as
  // index. Reject a repeated key under different indexes; only payer/owner
  // may share the exact same index.
  for (let left = 0; left < roleKeys.length; left++) {
    for (let right = left + 1; right < roleKeys.length; right++) {
      if (roleKeys[left] === roleKeys[right] &&
          !(left === 0 && right === 2 && roleIndexes[left] === roleIndexes[right])) {
        throw new Error("Associated Token role accounts contain a duplicate public key");
      }
    }
  }
  // The only supported role alias is payer === owner, represented by one
  // shared compiled account index. The message-level key list is deduplicated.
  if (keys[systemIndex] !== SYSTEM_PROGRAM_ID ||
      ![CLASSIC_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(keys[tokenProgramIndex])) {
    throw new Error("Associated Token system or token program account is invalid");
  }
  const bytes = decodeCanonicalBase64(encodedData);
  const variant = bytes[0] === 0 ? "create" :
    bytes[0] === 1 ? "createIdempotent" : null;
  if (!variant) throw new Error("Associated Token instruction variant is unsupported");
  const record = Object.freeze({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    decoderVersion: 1,
    analysisOnly: true,
    variant,
    accountIndexes: Object.freeze(indexes),
    payerAccountIndex: payerIndex,
    associatedAccountIndex: associatedIndex,
    ownerAccountIndex: ownerIndex,
    mintAccountIndex: mintIndex,
    systemProgramAccountIndex: systemIndex,
    tokenProgramAccountIndex: tokenProgramIndex,
    tokenProgramId: keys[tokenProgramIndex],
    associatedAccountAddress: keys[associatedIndex],
    ownerAddress: keys[ownerIndex],
    mintAddress: keys[mintIndex],
    accountRoles: Object.freeze(["payer", "associatedAccount", "owner", "mint", "systemProgram", "tokenProgram"])
  });
  decodedRecords.add(record);
  return record;
}

export function validateAssociatedTokenInstructionSet(instructions) {
  if (!Array.isArray(instructions) || instructions.length > 64) {
    throw new Error("Associated Token instruction set is invalid");
  }
  for (let index = 0; index < instructions.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(instructions, index) ||
        !instructions[index] || !decodedRecords.has(instructions[index])) {
      throw new Error("Associated Token instruction set contains an unreviewed record");
    }
  }
  return Object.freeze([...instructions]);
}

/** True only for records produced by this module's syntax decoder. */
export function isDecodedAssociatedTokenInstruction(record) {
  return Boolean(record && typeof record === "object" && decodedRecords.has(record));
}
