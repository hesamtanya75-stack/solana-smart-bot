import {
  decodeSupportedTransactionInstruction,
  validateSupportedTransactionInstructionSet,
  INSTRUCTION_DECODER_REGISTRY_VERSION
} from "./compute-budget-decoder.mjs";

const MAX_ACCOUNT_KEYS = 256;
const MAX_INSTRUCTIONS = 64;
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

/**
 * Parse a bounded, already-deserialized message instruction list for analysis.
 *
 * This deliberately supports only instruction programs registered by the
 * versioned decoder registry. It is not a Solana wire-format parser, does not
 * verify signatures, address lookup table contents, CPI effects, token deltas,
 * or whole-transaction semantics. Any unsupported program fails closed.
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

    const programId = accountKeys[instruction.programIdIndex];
    return decodeSupportedTransactionInstruction({
      programId,
      data: instruction.data,
      accountIndexes: instruction.accountKeyIndexes
    });
  });

  const validated = validateSupportedTransactionInstructionSet(decodedInstructions);
  return Object.freeze({
    parserVersion: 1,
    decoderRegistryVersion: INSTRUCTION_DECODER_REGISTRY_VERSION,
    instructionCount: validated.length,
    instructions: validated,
    analysisOnly: true,
    semanticVerification: "incomplete",
    signingPermitted: false,
    submissionPermitted: false
  });
}
