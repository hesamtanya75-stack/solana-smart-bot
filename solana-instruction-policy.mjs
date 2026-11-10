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

/**
 * Validate the CPI trace returned by a trusted simulation of this exact
 * unsigned transaction. This is an additional rejection gate, not proof that
 * execution will be identical on-chain. The caller must bind the simulation
 * to the exact decoded transaction and use a trusted RPC response.
 */
export function validateSimulatedCpi({
  decoded,
  simulationMeta,
  allowedCpiProgramIds,
  allowedCpiAccountKeys
} = {}) {
  if (!decoded || !Array.isArray(decoded.instructions) ||
      !Array.isArray(decoded.accountKeys) || decoded.accountKeys.length === 0) {
    throw new Error("Decoded transaction is required for CPI validation");
  }
  if (!simulationMeta || simulationMeta.err !== null ||
      !Array.isArray(simulationMeta.innerInstructions)) {
    throw new Error("Successful simulation with an explicit inner-instruction trace is required");
  }
  const programAllowList = normalizeAllowList(allowedCpiProgramIds, "CPI program");
  const accountAllowList = normalizeAllowList(allowedCpiAccountKeys, "CPI account");
  let instructionCount = 0;
  const programIds = new Set();

  for (const group of simulationMeta.innerInstructions) {
    if (!group || !Number.isInteger(group.index) || group.index < 0 ||
        group.index >= decoded.instructions.length ||
        !Array.isArray(group.instructions)) {
      throw new Error("Simulation returned a malformed CPI instruction group");
    }
    for (const inner of group.instructions) {
      if (!inner || !Number.isInteger(inner.programIdIndex) ||
          inner.programIdIndex < 0 || inner.programIdIndex >= decoded.accountKeys.length ||
          !Array.isArray(inner.accounts)) {
        throw new Error("Simulation returned a malformed CPI instruction");
      }
      const programId = decoded.accountKeys[inner.programIdIndex];
      if (!programAllowList.has(programId)) {
        throw new Error("Simulation invoked an unknown or unapproved CPI program");
      }
      for (const index of inner.accounts) {
        if (!Number.isInteger(index) || index < 0 || index >= decoded.accountKeys.length) {
          throw new Error("CPI instruction contains an invalid account index");
        }
        if (!accountAllowList.has(decoded.accountKeys[index])) {
          throw new Error("CPI instruction references an unapproved account");
        }
      }
      programIds.add(programId);
      instructionCount++;
    }
  }

  return Object.freeze({
    allowed: true,
    instructionCount,
    programIds: Object.freeze([...programIds])
  });
}
