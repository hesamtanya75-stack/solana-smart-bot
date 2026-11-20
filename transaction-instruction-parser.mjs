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
import { isTrustedUnsignedMessageEvidence } from "./trusted-live-evidence.mjs";
import {
  decodeSplTokenInstruction,
  validateSplTokenInstructionSet
} from "./spl-token-decoder.mjs";
import {
  decodeAssociatedTokenInstruction,
  validateAssociatedTokenInstructionSet
} from "./associated-token-account-decoder.mjs";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  verifyAssociatedTokenInstructionPda
} from "./associated-token-account-pda.mjs";

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

function assertDensePlainArray(value, maximum, label, minimum = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < minimum || value.length > maximum) {
    throw new Error("Transaction message shape is invalid or exceeds parser limits");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length < value.length + 1) {
    throw new Error(label === "Transaction compiled instructions"
      ? "Transaction message contains a sparse compiled instruction list"
      : "Transaction message contains an invalid account key");
  }
  if (keys.length > value.length + 1) {
    throw new Error(label + " contains unsupported properties");
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length) {
      throw new Error(label + " contains unsupported properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains accessor-backed indexes");
    }
  }
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
 * ALT-derived account roles require opaque finalized evidence produced from the exact unsigned message digest.
 *
 * This is not a wire-format parser, does not verify signatures, lookup-table
 * contents, CPI effects, token deltas, or whole-transaction semantics.
 */
const UNSUPPORTED_EXECUTION_EVIDENCE_FIELDS = Object.freeze([
  "meta",
  "innerInstructions",
  "logs",
  "preTokenBalances",
  "postTokenBalances",
  "preBalances",
  "postBalances",
  "signature",
  "signatures"
]);

export function parseSupportedInstructionMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("Transaction message shape is invalid or exceeds parser limits");
  }

  if (UNSUPPORTED_EXECUTION_EVIDENCE_FIELDS.some(field => field in message)) {
    throw new Error("Transaction message parser does not accept execution metadata or CPI evidence");
  }

  // Accept only plain data records with an explicit schema. This prevents
  // unknown metadata aliases, inherited fields, accessors, and symbol keys
  // from being silently ignored or evaluated during parsing.
  const prototype = Object.getPrototypeOf(message);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Transaction message must be a plain data record");
  }
  const allowedFields = new Set([
    "accountKeys",
    "instructions",
    "header",
    "resolvedAddressTableLookups",
    "staticAccountKeys",
    "computeBudgetPolicy",
    "trustedMessageEvidence"
  ]);
  for (const field of Reflect.ownKeys(message)) {
    if (typeof field !== "string" || !allowedFields.has(field)) {
      throw new Error("Transaction message contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(message, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error("Transaction message fields must be plain data properties");
    }
  }

  assertDensePlainArray(message.accountKeys, MAX_ACCOUNT_KEYS, "Transaction account keys", 1);
  assertDensePlainArray(message.instructions, MAX_INSTRUCTIONS, "Transaction compiled instructions", 1);
  const lookupTablesProvided = message.resolvedAddressTableLookups !== undefined;
  const suppliedLookupTables = message.resolvedAddressTableLookups ?? [];
  if (lookupTablesProvided) {
    assertDensePlainArray(suppliedLookupTables, MAX_ACCOUNT_KEYS, "Resolved address lookup tables");
    for (const table of suppliedLookupTables) {
      if (!table || typeof table !== "object" || Array.isArray(table) ||
          (Object.getPrototypeOf(table) !== Object.prototype && Object.getPrototypeOf(table) !== null)) {
        throw new Error("Resolved address lookup table entry is malformed");
      }
      const keys = Reflect.ownKeys(table);
      if (keys.length !== 2 || !keys.includes("writableAddresses") ||
          !keys.includes("readonlyAddresses")) {
        throw new Error("Resolved address lookup table entry is malformed");
      }
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(table, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          throw new Error("Resolved address lookup table entry contains accessor-backed fields");
        }
      }
      assertDensePlainArray(table.writableAddresses, MAX_ACCOUNT_KEYS, "Resolved writable lookup addresses");
      assertDensePlainArray(table.readonlyAddresses, MAX_ACCOUNT_KEYS, "Resolved readonly lookup addresses");
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
    if (!instruction || typeof instruction !== "object" || Array.isArray(instruction)) {
      throw new Error("Transaction instruction " + position + " has an invalid compiled layout");
    }
    const instructionPrototype = Object.getPrototypeOf(instruction);
    if (instructionPrototype !== Object.prototype && instructionPrototype !== null) {
      throw new Error("Transaction instruction " + position + " must be a plain data record");
    }
    const instructionFields = new Set(["programIdIndex", "accountKeyIndexes", "data"]);
    for (const field of Reflect.ownKeys(instruction)) {
      const descriptor = Object.getOwnPropertyDescriptor(instruction, field);
      if (typeof field !== "string" || !instructionFields.has(field)) {
        throw new Error("Transaction instruction " + position + " contains an unsupported field");
      }
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw new Error("Transaction instruction " + position + " fields must be plain data properties");
      }
    }
    if (!Number.isInteger(instruction.programIdIndex) ||
        instruction.programIdIndex < 0 || instruction.programIdIndex >= accountKeys.length ||
        !Array.isArray(instruction.accountKeyIndexes) ||
        Object.getPrototypeOf(instruction.accountKeyIndexes) !== Array.prototype ||
        instruction.accountKeyIndexes.length > MAX_ACCOUNT_KEYS ||
        typeof instruction.data !== "string") {
      throw new Error("Transaction instruction " + position + " has an invalid compiled layout");
    }

    const indexArrayKeys = Reflect.ownKeys(instruction.accountKeyIndexes);
    if (indexArrayKeys.some(key => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
         Number(key) >= instruction.accountKeyIndexes.length))) {
      throw new Error("Transaction instruction " + position + " account indexes contain unsupported properties");
    }
    for (let index = 0; index < instruction.accountKeyIndexes.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(instruction.accountKeyIndexes, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw new Error("Transaction instruction " + position + " contains sparse account indexes or accessor-backed entries");
      }
      const accountIndex = descriptor.value;
      if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= accountKeys.length) {
        throw new Error("Transaction instruction " + position + " has an invalid compiled layout");
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
    if (programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
        programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
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

  if (message.header === undefined &&
      (message.staticAccountKeys !== undefined ||
       message.resolvedAddressTableLookups !== undefined)) {
    throw new Error("Message account-role metadata requires a message header");
  }

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
    if (lookupTables.length > 0) {
      const evidence = message.trustedMessageEvidence;
      if (!isTrustedUnsignedMessageEvidence(evidence) ||
          evidence.lookupTableResolution !== "finalized-resolved" ||
          !Number.isSafeInteger(evidence.lookupContextSlot) ||
          evidence.lookupContextSlot < 1 ||
          evidence.messageDigest?.algorithm !== "SHA-256" ||
          !/^[a-f0-9]{64}$/.test(evidence.messageDigest.value || "")) {
        throw new Error("ALT account roles require trusted finalized message evidence");
      }
      const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      const suppliedInstructions = message.instructions.map(instruction => ({
        programIdIndex: instruction.programIdIndex,
        accountKeyIndexes: instruction.accountKeyIndexes,
        data: instruction.data
      }));
      if (!same(message.accountKeys, evidence.accountKeys) ||
          !same(message.staticAccountKeys, evidence.staticAccountKeys) ||
          !same(message.header, evidence.header) ||
          !same(lookupTables, evidence.resolvedAddressTableLookups) ||
          !same(suppliedInstructions, evidence.compiledInstructions)) {
        throw new Error("Parser message fields do not match digest-bound finalized ALT evidence");
      }
    }
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
    // A non-empty lookup set is accepted only when all layout fields match
    // the private finalized-evidence brand and its exact unsigned-message digest.
    lookupAddressAuthentication: lookupTablesProvided && suppliedLookupTables.length > 0
      ? "finalized-message-digest-bound"
      : "not-applicable",
    associatedAddressVerification: associatedTokenInstructions.length
      ? "not-performed"
      : "not-applicable",
    analysisOnly: true,
    semanticVerification: "incomplete",
    signingPermitted: false,
    submissionPermitted: false
  });
}


/**
 * Async additive parser API. Preserves the synchronous syntax parser and adds
 * an explicit ATA PDA-only check. A PDA match is not transaction approval.
 */
export async function parseAndVerifySupportedInstructionMessage(message) {
  const parsed = parseSupportedInstructionMessage(message);
  const ataInstructions = parsed.instructions.filter(instruction =>
    instruction?.programId === ASSOCIATED_TOKEN_PROGRAM_ID
  );
  if (ataInstructions.length === 0) {
    return Object.freeze({
      ...parsed,
      associatedAddressVerification: "not-applicable",
      associatedAddressPdaChecks: Object.freeze([])
    });
  }

  const checks = await Promise.all(
    ataInstructions.map(instruction => verifyAssociatedTokenInstructionPda(instruction))
  );
  const allMatch = checks.every(check => check.performed === true && check.verified === true);
  return Object.freeze({
    ...parsed,
    associatedAddressVerification: allMatch ? "pda-verified" : "pda-mismatch",
    associatedAddressPdaChecks: Object.freeze(checks)
  });
}
