import {
  decodeSupportedTransactionInstruction,
  validateSupportedTransactionInstructionSet,
  INSTRUCTION_DECODER_REGISTRY_VERSION,
  validateComputeBudgetPolicy
} from "./compute-budget-decoder.mjs";
import {
  decodeSystemProgramInstruction,
  validateSystemProgramInstructionSet
} from "./system-program-decoder.mjs";
import { deriveMessageAccountRoles } from "./message-account-roles.mjs";
import {
  decodeSplTokenInstruction,
  validateSplTokenInstructionSet
} from "./spl-token-decoder.mjs";
import {
  decodeAssociatedTokenInstruction,
  validateAssociatedTokenInstructionSet
} from "./associated-token-account-decoder.mjs";

const MAX_ACCOUNT_KEYS = 256;
const MAX_INSTRUCTIONS = 64;
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const BASE58_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function isCanonicalPublicKey(value) {
  if (typeof value !== "string" || !BASE58_PUBLIC_KEY.test(value)) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  const leadingZeroBytes = value.match(/^1*/)[0].length;
  const hex = decoded.toString(16);
  const significantBytes = decoded === 0n ? 0 : Math.ceil(hex.length / 2);
  return leadingZeroBytes + significantBytes === 32;
}

function requireRole(roles, index, expected, label) {
  const role = roles[index];
  if (!role || (expected.signer && !role.signer) ||
      (expected.nonSigner && role.signer) ||
      (expected.writable && !role.writable) ||
      (expected.readonly && role.writable)) {
    throw new Error(label + " account privilege requirements are not satisfied");
  }
}

function analyzeSystemInstructionPrivileges(instructions, roles) {
  for (const instruction of instructions) {
    const required = instruction.variant === "transfer"
      ? [{ signer: true, writable: true }, { signer: false, writable: true }]
      : [{ signer: true, writable: true }, { signer: true, writable: true }];
    if (!Array.isArray(instruction.accountIndexes) || instruction.accountIndexes.length !== 2) {
      throw new Error("System instruction account-role analysis found an invalid account layout");
    }
    for (let position = 0; position < required.length; position++) {
      requireRole(roles, instruction.accountIndexes[position], required[position], "System instruction");
    }
  }
}

function analyzeSplTokenInstructionPrivileges(instructions, roles) {
  for (const instruction of instructions) {
    requireRole(roles, instruction.sourceAccountIndex, { writable: true }, "SPL Token source");
    requireRole(roles, instruction.destinationAccountIndex, { writable: true }, "SPL Token destination");
    requireRole(roles, instruction.authorityAccountIndex, { signer: true }, "SPL Token authority");
    if (instruction.variant === "transferChecked") {
      requireRole(roles, instruction.mintAccountIndex, { readonly: true }, "SPL Token mint");
    }
  }
}

function analyzeAssociatedTokenInstructionPrivileges(instructions, roles) {
  for (const instruction of instructions) {
    requireRole(roles, instruction.payerAccountIndex, { signer: true, writable: true }, "ATA payer");
    requireRole(roles, instruction.associatedAccountIndex, { writable: true, nonSigner: true }, "ATA destination");
    // When payer and owner are the same compiled account, the global message
    // privileges are the union of both roles: payer signer+writable wins.
    // Otherwise owner and mint must be readonly non-signers.
    if (instruction.payerAccountIndex !== instruction.ownerAccountIndex) {
      requireRole(roles, instruction.ownerAccountIndex, { readonly: true, nonSigner: true }, "ATA owner");
    }
    requireRole(roles, instruction.mintAccountIndex, { readonly: true, nonSigner: true }, "ATA mint");
    requireRole(roles, instruction.systemProgramAccountIndex, { readonly: true, nonSigner: true }, "ATA System Program");
    requireRole(roles, instruction.tokenProgramAccountIndex, { readonly: true, nonSigner: true }, "ATA Token Program");
  }
}

/**
 * Parse a bounded, already-deserialized message instruction list for analysis.
 * Optional header/lookup inputs enable a structural signer/writable cross-check.
 * Lookup addresses are caller-supplied and are NOT authenticated by this parser.
 *
 * This is not a wire-format parser, does not verify signatures, lookup-table
 * contents, CPI effects, token deltas, or whole-transaction semantics.
 */
export function parseSupportedInstructionMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) ||
      !Array.isArray(message.accountKeys) ||
      message.accountKeys.length < 1 || message.accountKeys.length > MAX_ACCOUNT_KEYS ||
      !Array.isArray(message.instructions) ||
      message.instructions.length < 1 || message.instructions.length > MAX_INSTRUCTIONS) {
    throw new Error("Transaction message shape is invalid or exceeds parser limits");
  }

  for (let index = 0; index < message.instructions.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(message.instructions, index)) {
      throw new Error("Transaction message contains a sparse compiled instruction list");
    }
  }

  const accountKeys = message.accountKeys;
  const seenAccountKeys = new Set();
  for (const key of accountKeys) {
    if (!isCanonicalPublicKey(key)) {
      throw new Error("Transaction message contains an invalid account key");
    }
    if (seenAccountKeys.has(key)) {
      throw new Error("Transaction message contains duplicate account keys");
    }
    seenAccountKeys.add(key);
  }

  const computeBudgetInstructions = [];
  const systemProgramInstructions = [];
  const splTokenInstructions = [];
  const associatedTokenInstructions = [];
  const programIdIndexes = [];
  const decodedInstructions = message.instructions.map((instruction, position) => {
    if (!instruction || typeof instruction !== "object" || Array.isArray(instruction) ||
        !Number.isInteger(instruction.programIdIndex) ||
        instruction.programIdIndex < 0 || instruction.programIdIndex >= accountKeys.length ||
        !Array.isArray(instruction.accountKeyIndexes) ||
        instruction.accountKeyIndexes.length > MAX_ACCOUNT_KEYS ||
        instruction.accountKeyIndexes.some(index =>
          !Number.isInteger(index) || index < 0 || index >= accountKeys.length) ||
        typeof instruction.data !== "string") {
      throw new Error("Transaction instruction " + position + " has an invalid compiled layout");
    }

    for (let index = 0; index < instruction.accountKeyIndexes.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(instruction.accountKeyIndexes, index)) {
        throw new Error("Transaction instruction " + position + " contains sparse account indexes");
      }
    }

    const programId = accountKeys[instruction.programIdIndex];
    programIdIndexes.push(instruction.programIdIndex);
    if (programId === SYSTEM_PROGRAM_ID) {
      const decoded = decodeSystemProgramInstruction(
        programId, instruction.data, instruction.accountKeyIndexes
      );
      systemProgramInstructions.push(decoded);
      return decoded;
    }
    if (programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
      const decoded = decodeSplTokenInstruction(programId, instruction.data, instruction.accountKeyIndexes);
      splTokenInstructions.push(decoded);
      return decoded;
    }
    if (programId === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") {
      const decoded = decodeAssociatedTokenInstruction(
        programId, instruction.data, instruction.accountKeyIndexes, accountKeys
      );
      associatedTokenInstructions.push(decoded);
      return decoded;
    }
    const decoded = decodeSupportedTransactionInstruction({
      programId,
      data: instruction.data,
      accountIndexes: instruction.accountKeyIndexes
    });
    computeBudgetInstructions.push(decoded);
    return decoded;
  });

  validateSupportedTransactionInstructionSet(computeBudgetInstructions);
  const computeBudgetPolicy = message.computeBudgetPolicy === undefined
    ? null
    : validateComputeBudgetPolicy(
      computeBudgetInstructions.map(instruction => instruction.decoded),
      message.computeBudgetPolicy
    );
  validateSystemProgramInstructionSet(systemProgramInstructions);
  validateSplTokenInstructionSet(splTokenInstructions);
  validateAssociatedTokenInstructionSet(associatedTokenInstructions);

  let accountPrivilegeAnalysis = "not-provided";
  if (message.header !== undefined) {
    const lookupTables = message.resolvedAddressTableLookups ?? [];
    const staticAccountKeys = message.staticAccountKeys ?? accountKeys;
    if (lookupTables.length > 0 && message.staticAccountKeys === undefined) {
      throw new Error("Versioned message with address lookups must provide staticAccountKeys separately");
    }
    const derived = deriveMessageAccountRoles({
      staticAccountKeys,
      header: message.header,
      resolvedAddressTableLookups: lookupTables
    });
    if (derived.roles.length !== accountKeys.length ||
        derived.roles.some((role, index) => role.publicKey !== accountKeys[index])) {
      throw new Error("Resolved message account keys do not match static and lookup account ordering");
    }
    for (const programIdIndex of programIdIndexes) {
      requireRole(derived.roles, programIdIndex, { readonly: true, nonSigner: true }, "Instruction program");
    }
    analyzeSystemInstructionPrivileges(systemProgramInstructions, derived.roles);
    analyzeSplTokenInstructionPrivileges(splTokenInstructions, derived.roles);
    analyzeAssociatedTokenInstructionPrivileges(associatedTokenInstructions, derived.roles);
    accountPrivilegeAnalysis = "structural-match-only";
  }

  const validated = Object.freeze([...decodedInstructions]);
  return Object.freeze({
    parserVersion: 1,
    decoderRegistryVersion: INSTRUCTION_DECODER_REGISTRY_VERSION,
    instructionCount: validated.length,
    instructions: validated,
    computeBudgetPolicy: computeBudgetPolicy === null
      ? "not-provided"
      : Object.freeze({ status: "validated", ...computeBudgetPolicy }),
    accountPrivilegeAnalysis,
    associatedAddressVerification: associatedTokenInstructions.length
      ? "not-performed"
      : "not-applicable",
    analysisOnly: true,
    semanticVerification: "incomplete",
    signingPermitted: false,
    submissionPermitted: false
  });
}
