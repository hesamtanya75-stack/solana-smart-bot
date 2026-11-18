const MAX_ACCOUNT_KEYS = 256;
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
 * Derive account signer/writable privileges from a validated legacy/v0
 * message header and ALREADY-RESOLVED address lookup table addresses.
 *
 * This helper does not fetch/verify lookup tables, parse wire messages, verify
 * signatures, or establish transaction semantics. Lookup addresses must be
 * resolved and authenticated by a separate trusted layer before calling it.
 */
export function deriveMessageAccountRoles({ staticAccountKeys, header, resolvedAddressTableLookups = [] }) {
  if (!Array.isArray(staticAccountKeys) || staticAccountKeys.length < 1 ||
      staticAccountKeys.length > MAX_ACCOUNT_KEYS ||
      !Array.isArray(resolvedAddressTableLookups) || !header || typeof header !== "object" ||
      Array.isArray(header)) {
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

  const allKeys = [...staticAccountKeys];
  if (allKeys.some(key => !isCanonicalPublicKey(key)) || new Set(allKeys).size !== allKeys.length) {
    throw new Error("Static account keys are invalid or duplicated");
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
  for (const lookup of resolvedAddressTableLookups) {
    if (!lookup || typeof lookup !== "object" || Array.isArray(lookup) ||
        !Array.isArray(lookup.writableAddresses) || !Array.isArray(lookup.readonlyAddresses)) {
      throw new Error("Resolved address lookup table entry is malformed");
    }
    if (lookup.writableAddresses.length + lookup.readonlyAddresses.length >
        MAX_ACCOUNT_KEYS - staticCount - writableLookupAddresses.length - readonlyLookupAddresses.length) {
      throw new Error("Resolved message account keys exceed parser limit");
    }
    for (const publicKey of lookup.writableAddresses) writableLookupAddresses.push(publicKey);
    for (const publicKey of lookup.readonlyAddresses) readonlyLookupAddresses.push(publicKey);
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
