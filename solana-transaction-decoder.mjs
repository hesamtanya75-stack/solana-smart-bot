import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

const MAX_SERIALIZED_TRANSACTION_BYTES = 1232;
const MAX_INSTRUCTIONS = 64;
const MAX_ACCOUNT_KEYS = 256;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/;

/**
 * Decode an unsigned or partially signed Solana transaction for inspection.
 *
 * This function deliberately does NOT approve instructions, verify signatures,
 * sign, or submit. For v0 transactions, every Address Lookup Table must be
 * resolved by a caller-supplied trusted RPC resolver before decoding succeeds.
 */
export async function decodeSolanaTransaction(
  encodedTransaction,
  { lookupTableResolver } = {}
) {
  if (typeof encodedTransaction !== "string" || !BASE64.test(encodedTransaction)) {
    throw new Error("Transaction must be canonical Base64");
  }

  const bytes = Buffer.from(encodedTransaction, "base64");
  if (bytes.length === 0 ||
      bytes.length > MAX_SERIALIZED_TRANSACTION_BYTES ||
      bytes.toString("base64") !== encodedTransaction) {
    throw new Error("Transaction has an invalid or unsupported serialized size/encoding");
  }

  let transaction;
  try {
    transaction = VersionedTransaction.deserialize(bytes);
  } catch {
    throw new Error("Serialized data is not a valid Solana transaction");
  }

  const message = transaction.message;
  const version = message.version === "legacy" ? "legacy" : message.version;
  if (version !== "legacy" && version !== 0) {
    throw new Error("Unsupported Solana transaction message version");
  }

  const requiredSignatures = message.header?.numRequiredSignatures;
  if (!Number.isInteger(requiredSignatures) || requiredSignatures < 1 ||
      transaction.signatures.length !== requiredSignatures ||
      transaction.signatures.some((signature) =>
        !(signature instanceof Uint8Array) || signature.length !== 64
      )) {
    throw new Error("Transaction signature slots do not match the message header");
  }

  const lookups = version === 0 ? (message.addressTableLookups || []) : [];
  const lookupTableAccounts = [];
  for (const lookup of lookups) {
    if (typeof lookupTableResolver !== "function") {
      throw new Error("Address Lookup Table resolver is required for v0 transactions");
    }
    const table = await lookupTableResolver(lookup.accountKey);
    if (!table || !table.key?.equals?.(lookup.accountKey) ||
        !Array.isArray(table.state?.addresses)) {
      throw new Error("Address Lookup Table is missing, mismatched, or invalid");
    }
    lookupTableAccounts.push(table);
  }

  let resolvedKeys;
  try {
    resolvedKeys = message.getAccountKeys(
      version === 0 ? { addressLookupTableAccounts: lookupTableAccounts } : undefined
    );
  } catch {
    throw new Error("Unable to resolve all transaction account keys");
  }

  const accountKeyCount = resolvedKeys.length;
  if (!Number.isInteger(accountKeyCount) || accountKeyCount < 1 ||
      accountKeyCount > MAX_ACCOUNT_KEYS) {
    throw new Error("Transaction account-key count is outside supported bounds");
  }

  const accountKeys = [];
  for (let index = 0; index < accountKeyCount; index += 1) {
    const key = resolvedKeys.get(index);
    if (!key || typeof key.toBase58 !== "function") {
      throw new Error("Transaction contains an unresolved account-key index");
    }
    accountKeys.push(key.toBase58());
  }

  const compiledInstructions = version === "legacy"
    ? message.instructions
    : message.compiledInstructions;
  if (!Array.isArray(compiledInstructions) ||
      compiledInstructions.length < 1 ||
      compiledInstructions.length > MAX_INSTRUCTIONS) {
    throw new Error("Transaction instruction count is empty or outside supported bounds");
  }

  const instructions = compiledInstructions.map((instruction, index) => {
    const accountIndexes = version === "legacy"
      ? instruction.accounts
      : instruction.accountKeyIndexes;
    if (!Number.isInteger(instruction.programIdIndex) ||
        instruction.programIdIndex < 0 ||
        instruction.programIdIndex >= accountKeyCount ||
        !(Array.isArray(accountIndexes) || ArrayBuffer.isView(accountIndexes)) ||
        Array.from(accountIndexes).some((accountIndex) =>
          !Number.isInteger(accountIndex) ||
          accountIndex < 0 ||
          accountIndex >= accountKeyCount
        ) ||
        !(typeof instruction.data === "string" || instruction.data instanceof Uint8Array)) {
      throw new Error("Transaction contains an invalid compiled instruction");
    }

    let instructionData;
    try {
      instructionData = typeof instruction.data === "string"
        ? bs58.decode(instruction.data)
        : instruction.data;
    } catch {
      throw new Error("Transaction contains invalid instruction data");
    }

    return Object.freeze({
      index,
      programId: accountKeys[instruction.programIdIndex],
      accountIndexes: Object.freeze(Array.from(accountIndexes)),
      accounts: Object.freeze(Array.from(accountIndexes, (accountIndex) => accountKeys[accountIndex])),
      dataBase64: Buffer.from(instructionData).toString("base64")
    });
  });

  const staticKeys = version === "legacy" ? message.accountKeys : message.staticAccountKeys;
  const signerPubkeys = staticKeys
    .slice(0, requiredSignatures)
    .map((key) => key.toBase58());

  return Object.freeze({
    version,
    recentBlockhash: message.recentBlockhash,
    requiredSignatures,
    signerPubkeys: Object.freeze(signerPubkeys),
    signaturesPresent: Object.freeze(transaction.signatures.map((signature) =>
      signature.some((byte) => byte !== 0)
    )),
    accountKeys: Object.freeze(accountKeys),
    lookupTableAddresses: Object.freeze(lookups.map((lookup) => lookup.accountKey.toBase58())),
    instructions: Object.freeze(instructions)
  });
}
