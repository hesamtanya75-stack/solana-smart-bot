/**
 * Strict, fail-closed instruction policy for decoded Solana swap transactions.
 *
 * The allow-list must be supplied by trusted server code after independent
 * review. Never populate it from Jupiter responses, browser input, or routePlan.
 * Every invoked program must also have a trusted protocol-specific validator.
 * This module does not ship guessed validators: absent validators fail closed.
 * Validators must decode instruction data and verify exact amounts, token
 * accounts, authorities, fees, and any supported CPI behavior.
 */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function normalizeAllowList(values, name) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(name + " allow-list is missing or empty");
  }
  const result = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !BASE58.test(value)) {
      throw new Error(name + " allow-list contains an invalid public key");
    }
    result.add(value);
  }
  return result;
}

export function validateDecodedSwapTransaction({
  decoded,
  expectedSigner,
  requiredAccounts,
  allowedProgramIds,
  allowedAccountKeys,
  allowedWritableAccountKeys,
  instructionValidators
} = {}) {
  if (!decoded || !["legacy", 0].includes(decoded.version) ||
      !Array.isArray(decoded.instructions) || decoded.instructions.length === 0 ||
      !Array.isArray(decoded.accountKeys) || decoded.accountKeys.length === 0) {
    throw new Error("Decoded transaction is missing or invalid");
  }
  if (typeof expectedSigner !== "string" || !BASE58.test(expectedSigner)) {
    throw new Error("Expected dedicated signer is invalid");
  }
  const programAllowList = normalizeAllowList(allowedProgramIds, "Program");
  const accountAllowList = normalizeAllowList(allowedAccountKeys, "Account");
  if (!Array.isArray(requiredAccounts) || requiredAccounts.length === 0 ||
      requiredAccounts.some((key) => typeof key !== "string" || !BASE58.test(key))) {
    throw new Error("Required swap accounts are missing or invalid");
  }

  if (!Array.isArray(decoded.signerPubkeys) ||
      decoded.signerPubkeys.length !== 1 ||
      decoded.signerPubkeys[0] !== expectedSigner) {
    throw new Error("Transaction signer does not exactly match the dedicated wallet");
  }
  if (!Array.isArray(decoded.signaturesPresent) ||
      decoded.signaturesPresent.length !== decoded.signerPubkeys.length ||
      decoded.signaturesPresent.some(Boolean)) {
    throw new Error("Order transaction must be unsigned before policy review");
  }

  for (const key of decoded.accountKeys) {
    if (!accountAllowList.has(key)) {
      throw new Error("Transaction contains an account outside the explicit allow-list");
    }
  }
  for (const key of requiredAccounts) {
    if (!decoded.accountKeys.includes(key) || !accountAllowList.has(key)) {
      throw new Error("A required swap account is absent or not allow-listed");
    }
  }
  const writableAllowList = normalizeAllowList(allowedWritableAccountKeys, "Writable account");
  if (!Array.isArray(decoded.accountMetadata) ||
      decoded.accountMetadata.length !== decoded.accountKeys.length ||
      decoded.accountMetadata.some((meta, index) =>
        !meta || meta.pubkey !== decoded.accountKeys[index] ||
        meta.index !== index || typeof meta.isSigner !== "boolean" ||
        typeof meta.isWritable !== "boolean" || !meta.source ||
        !["static", "lookupTable"].includes(meta.source.type)
      )) {
    throw new Error("Trusted account privilege metadata is missing or inconsistent");
  }
  for (const meta of decoded.accountMetadata) {
    if (meta.isWritable && !writableAllowList.has(meta.pubkey)) {
      throw new Error("Transaction contains an unapproved writable account");
    }
  }
  if (!instructionValidators || typeof instructionValidators !== "object" ||
      Array.isArray(instructionValidators)) {
    throw new Error("Trusted protocol-specific instruction validators are required");
  }

  for (const instruction of decoded.instructions) {
    if (!instruction || !programAllowList.has(instruction.programId)) {
      throw new Error("Transaction contains an unknown or unapproved program");
    }
    if (!Array.isArray(instruction.accounts) ||
        instruction.accounts.some((key) => !accountAllowList.has(key))) {
      throw new Error("Instruction references an account outside the explicit allow-list");
    }
    const validator = instructionValidators[instruction.programId];
    if (typeof validator !== "function") {
      throw new Error("No trusted semantic validator exists for transaction program");
    }
    let semanticResult;
    try {
      semanticResult = validator(Object.freeze({ ...instruction }), decoded);
    } catch {
      throw new Error("Protocol-specific instruction validation failed");
    }
    if (!semanticResult || semanticResult.allowed !== true) {
      throw new Error("Protocol-specific instruction semantics were not approved");
    }
  }

  return Object.freeze({
    allowed: true,
    instructionCount: decoded.instructions.length,
    programIds: Object.freeze([...new Set(decoded.instructions.map((ix) => ix.programId))]),
    accountKeys: Object.freeze([...decoded.accountKeys])
  });
}
