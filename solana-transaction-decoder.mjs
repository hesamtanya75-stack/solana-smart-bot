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
        !Array.isArray(table.state?.addresses) ||
        !Array.isArray(lookup.writableIndexes) ||
        !Array.isArray(lookup.readonlyIndexes)) {
      throw new Error("Address Lookup Table is missing, mismatched, or invalid");
    }
    const selectedIndexes = [...lookup.writableIndexes, ...lookup.readonlyIndexes];
    if (selectedIndexes.some((addressIndex) =>
      !Number.isInteger(addressIndex) || addressIndex < 0 ||
      addressIndex >= table.state.addresses.length
    ) || new Set(selectedIndexes).size !== selectedIndexes.length) {
      throw new Error("Address Lookup Table contains invalid or duplicate address indexes");
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

  // Solana message privileges are encoded in the message header for static
  // keys. For v0, ALT-loaded writable keys are ordered before ALT-loaded
  // readonly keys, across the lookup tables in message order.
  const staticKeys = version === "legacy" ? message.accountKeys : message.staticAccountKeys;
  const header = message.header;
  const staticKeyCount = staticKeys.length;
  const readonlySigned = header.numReadonlySignedAccounts;
  const readonlyUnsigned = header.numReadonlyUnsignedAccounts;
  if (!Number.isInteger(readonlySigned) || readonlySigned < 0 ||
      readonlySigned > requiredSignatures ||
      !Number.isInteger(readonlyUnsigned) || readonlyUnsigned < 0 ||
      readonlyUnsigned > staticKeyCount - requiredSignatures) {
    throw new Error("Transaction message contains invalid account privilege header values");
  }

  const loadedWritableCount = lookups.reduce(
    (count, lookup) => count + lookup.writableIndexes.length, 0
  );
  const loadedReadonlyCount = lookups.reduce(
    (count, lookup) => count + lookup.readonlyIndexes.length, 0
  );
  if (staticKeyCount + loadedWritableCount + loadedReadonlyCount !== accountKeyCount) {
    throw new Error("Resolved account keys do not match static and ALT lookup counts");
  }

  const accountMetadata = accountKeys.map((pubkey, index) => {
    let isSigner = false;
    let isWritable = false;
    let source;
    if (index < staticKeyCount) {
      isSigner = index < requiredSignatures;
      isWritable = isSigner
        ? index < requiredSignatures - readonlySigned
        : index < staticKeyCount - readonlyUnsigned;
      source = Object.freeze({ type: "static", index });
    } else {
      const loadedIndex = index - staticKeyCount;
      isWritable = loadedIndex < loadedWritableCount;
      let cursor = 0;
      let origin = null;
      for (const lookup of lookups) {
        const writableCount = lookup.writableIndexes.length;
        const readonlyCount = lookup.readonlyIndexes.length;
        if (loadedIndex >= cursor && loadedIndex < cursor + writableCount) {
          origin = {
            type: "lookupTable",
            table: lookup.accountKey.toBase58(),
            access: "writable",
            addressIndex: lookup.writableIndexes[loadedIndex - cursor]
          };
          break;
        }
        cursor += writableCount;
        if (loadedIndex >= cursor && loadedIndex < cursor + readonlyCount) {
          origin = {
            type: "lookupTable",
            table: lookup.accountKey.toBase58(),
            access: "readonly",
            addressIndex: lookup.readonlyIndexes[loadedIndex - cursor]
          };
          break;
        }
        cursor += readonlyCount;
      }
      if (!origin) throw new Error("Unable to map an ALT-loaded account to its lookup table");
      source = Object.freeze(origin);
    }
    return Object.freeze({ pubkey, index, isSigner, isWritable, source });
  });

  const compiledInstructions = version === "legacy"
    ? message.instructions
    : message.compiledInstructions;
  if (!Array.isArray(compiledInstructions) ||
      compiledInstructions.length < 1 ||
      compiledInstructions.length > MAX_INSTRUCTIONS) {
    throw new Error("Transaction instruction count is empty or outside supported bounds");
  }

  const instructions = compiledInstructions.map((instruction, index) => {
    // web3.js exposes legacy account indexes as "accounts" and v0 indexes as
    // "accountKeyIndexes". Normalize either representation without trusting
    // arbitrary objects or coercing invalid index values.
    const rawAccountIndexes = version === "legacy"
      ? instruction.accounts
      : (instruction.accountKeyIndexes ?? instruction.accounts);
    if (!(Array.isArray(rawAccountIndexes) || ArrayBuffer.isView(rawAccountIndexes))) {
      throw new Error("Transaction instruction account indexes are missing or invalid");
    }
    const accountIndexes = Array.from(rawAccountIndexes);
    const programIdIndex = instruction.programIdIndex;
    if (!Number.isInteger(programIdIndex) ||
        programIdIndex < 0 ||
        programIdIndex >= accountKeyCount ||
        accountIndexes.some((accountIndex) =>
          !Number.isInteger(accountIndex) ||
          accountIndex < 0 ||
          accountIndex >= accountKeyCount
        )) {
      throw new Error("Transaction instruction references an invalid account-key index");
    }

    let instructionData;
    try {
      if (typeof instruction.data === "string") {
        instructionData = bs58.decode(instruction.data);
      } else if (instruction.data instanceof Uint8Array || ArrayBuffer.isView(instruction.data)) {
        instructionData = Uint8Array.from(instruction.data);
      } else {
        throw new Error("Unsupported instruction data representation");
      }
    } catch {
      throw new Error("Transaction contains invalid instruction data");
    }

    return Object.freeze({
      index,
      programId: accountKeys[programIdIndex],
      accountIndexes: Object.freeze(accountIndexes),
      accounts: Object.freeze(accountIndexes.map((accountIndex) => accountKeys[accountIndex])),
      dataBase64: Buffer.from(instructionData).toString("base64")
    });
  });

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
    accountMetadata: Object.freeze(accountMetadata),
    lookupTableAddresses: Object.freeze(lookups.map((lookup) => lookup.accountKey.toBase58())),
    instructions: Object.freeze(instructions)
  });
}
