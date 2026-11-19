const MAX_ACCOUNT_KEYS = 256;
const BASE58_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function snapshotPlainArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum) {
    throw new Error(label + " is malformed");
  }
  const keys = Reflect.ownKeys(value);
  const snapshot = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      if (label === "Resolved address lookup table list") {
        throw new Error("Resolved address lookup table entry is malformed");
      }
      if (label.includes("account keys") || label.includes("lookup addresses")) {
        throw new Error("Resolved lookup account key is invalid or duplicated");
      }
      throw new Error(label + " contains a sparse entry");
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains an accessor-backed entry");
    }
    snapshot.push(descriptor.value);
  }
  if (keys.length !== value.length + 1) {
    throw new Error(label + " contains unsupported properties");
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length) {
      throw new Error(label + " contains unsupported properties");
    }
  }
  return snapshot;
}

function snapshotPlainRecord(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " is malformed");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + " must be a plain data record");
  }
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      throw new Error(label + " contains unsupported properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains accessor-backed properties");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

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
 * Derive account signer/writable privileges from a validated legacy/v0
 * message header and ALREADY-RESOLVED address lookup table addresses.
 *
 * This helper does not fetch/verify lookup tables, parse wire messages, verify
 * signatures, or establish transaction semantics. Lookup addresses must be
 * resolved and authenticated by a separate trusted layer before calling it.
 */
export function deriveMessageAccountRoles(input) {
  const args = snapshotPlainRecord(
    input,
    ["staticAccountKeys", "header", "resolvedAddressTableLookups"],
    "Message account-role input"
  );
  if (!Array.isArray(args.staticAccountKeys) || args.staticAccountKeys.length < 1 ||
      args.staticAccountKeys.length > MAX_ACCOUNT_KEYS) {
    throw new Error("Message account-role input is malformed");
  }
  const staticAccountKeys = snapshotPlainArray(
    args.staticAccountKeys, MAX_ACCOUNT_KEYS, "Static account keys"
  );
  const lookupEntries = snapshotPlainArray(
    args.resolvedAddressTableLookups ?? [], MAX_ACCOUNT_KEYS, "Resolved address lookup table list"
  );
  const header = snapshotPlainRecord(
    args.header,
    ["numRequiredSignatures", "numReadonlySignedAccounts", "numReadonlyUnsignedAccounts"],
    "Message header"
  );
  if (staticAccountKeys.length < 1) {
    throw new Error("Message account-role input is malformed");
  }
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = header;
  const staticCount = staticAccountKeys.length;
  if (![numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts].every(Number.isInteger) ||
      numRequiredSignatures < 1 || numRequiredSignatures > staticCount ||
      numReadonlySignedAccounts < 0 || numReadonlySignedAccounts > numRequiredSignatures ||
      numReadonlyUnsignedAccounts < 0 || numReadonlyUnsignedAccounts > staticCount - numRequiredSignatures) {
    throw new Error("Message header privilege counts are invalid");
  }

  const allKeys = [];
  for (const key of staticAccountKeys) {
    if (!isCanonicalPublicKey(key) || allKeys.includes(key)) {
      throw new Error("Static account keys are invalid or duplicated");
    }
    allKeys.push(key);
  }

  const roles = staticAccountKeys.map((publicKey, index) => Object.freeze({
    index,
    publicKey,
    source: "static",
    signer: index < numRequiredSignatures,
    writable: index < numRequiredSignatures
      ? index < numRequiredSignatures - numReadonlySignedAccounts
      : index < staticCount - numReadonlyUnsignedAccounts
  }));

  const writableLookupAddresses = [];
  const readonlyLookupAddresses = [];
  for (const lookupInput of lookupEntries) {
    const lookup = snapshotPlainRecord(
      lookupInput, ["writableAddresses", "readonlyAddresses"],
      "Resolved address lookup table entry"
    );
    const writableAddresses = snapshotPlainArray(
      lookup.writableAddresses, MAX_ACCOUNT_KEYS, "Resolved writable lookup addresses"
    );
    const readonlyAddresses = snapshotPlainArray(
      lookup.readonlyAddresses, MAX_ACCOUNT_KEYS, "Resolved readonly lookup addresses"
    );
    if (writableAddresses.length + readonlyAddresses.length >
        MAX_ACCOUNT_KEYS - staticCount - writableLookupAddresses.length - readonlyLookupAddresses.length) {
      throw new Error("Resolved message account keys exceed parser limit");
    }
    for (const address of writableAddresses) writableLookupAddresses.push(address);
    for (const address of readonlyAddresses) readonlyLookupAddresses.push(address);
  }
  // Solana v0 account-key order is static keys, then ALL loaded writable
  // addresses, then ALL loaded readonly addresses (not per-table interleaving).
  for (const [source, writable, addresses] of [
    ["lookup-writable", true, writableLookupAddresses],
    ["lookup-readonly", false, readonlyLookupAddresses]
  ]) {
    for (const publicKey of addresses) {
      if (!isCanonicalPublicKey(publicKey) || allKeys.includes(publicKey)) {
        throw new Error("Resolved lookup account key is invalid or duplicated");
      }
      if (allKeys.length >= MAX_ACCOUNT_KEYS) throw new Error("Resolved message account keys exceed parser limit");
      const index = allKeys.length;
      allKeys.push(publicKey);
      roles.push(Object.freeze({ index, publicKey, source, signer: false, writable }));
    }
  }

  return Object.freeze({
    accountCount: roles.length,
    staticAccountCount: staticCount,
    lookupAccountCount: roles.length - staticCount,
    roles: Object.freeze(roles)
  });
}
