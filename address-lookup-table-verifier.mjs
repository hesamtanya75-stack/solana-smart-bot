const LOOKUP_TABLE_META_SIZE = 56;
const LOOKUP_TABLE_MAX_ADDRESSES = 256;
const U64_MAX = 0xffffffffffffffffn;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const decodedLookupTables = new WeakSet();

export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = "AddressLookupTab1e1111111111111111111111111";

function snapshotPlainRecord(value, fields, label) {
  if (!value || typeof value !== "object" ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${label} is malformed`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    throw new Error(`${label} has unsupported properties`);
  }
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(`${label} contains accessor-backed or missing fields`);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function snapshotPlainArray(value, label, maxLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maxLength) {
    throw new Error(`${label} is malformed`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 ||
      keys.some(key => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9]\\d*)$/.test(key) || Number(key) >= value.length))) {
    throw new Error(`${label} has unsupported properties`);
  }
  const snapshot = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(`${label} contains sparse or accessor-backed entries`);
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function encodeBase58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    value /= 58n;
    encoded = BASE58_ALPHABET[remainder] + encoded;
  }
  let zeroPrefix = 0;
  while (zeroPrefix < bytes.length && bytes[zeroPrefix] === 0) zeroPrefix++;
  return "1".repeat(zeroPrefix) + encoded;
}

function asBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < LOOKUP_TABLE_META_SIZE ||
      value.byteLength > LOOKUP_TABLE_META_SIZE + LOOKUP_TABLE_MAX_ADDRESSES * 32) {
    throw new Error("Address lookup table account data has an invalid size");
  }
  return Uint8Array.from(value);
}

/**
 * Decode canonical Address Lookup Table account bytes.
 * This validates serialized state only; it does not authenticate RPC provenance,
 * account ownership, finalized commitment, or SlotHashes ancestry.
 */
export function decodeAddressLookupTableAccountData(input) {
  const data = asBytes(input);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 1) {
    throw new Error("Address lookup table account is not initialized");
  }
  const deactivationSlot = view.getBigUint64(4, true);
  const lastExtendedSlot = view.getBigUint64(12, true);
  const lastExtendedSlotStartIndex = data[20];
  const authorityTag = data[21];
  if (authorityTag !== 0 && authorityTag !== 1) {
    throw new Error("Address lookup table authority option is invalid");
  }
  if (data[54] !== 0 || data[55] !== 0) {
    throw new Error("Address lookup table metadata padding is noncanonical");
  }
  let authority = null;
  if (authorityTag === 1) {
    authority = encodeBase58(data.subarray(22, 54));
  } else {
    for (let i = 22; i < 54; i++) {
      if (data[i] !== 0) throw new Error("Frozen lookup table contains nonzero reserved authority bytes");
    }
  }
  const addressBytesLength = data.byteLength - LOOKUP_TABLE_META_SIZE;
  if (addressBytesLength % 32 !== 0) {
    throw new Error("Address lookup table address region is truncated");
  }
  const addressCount = addressBytesLength / 32;
  if (addressCount > LOOKUP_TABLE_MAX_ADDRESSES ||
      lastExtendedSlotStartIndex > addressCount) {
    throw new Error("Address lookup table address metadata is inconsistent");
  }
  const addresses = [];
  for (let offset = LOOKUP_TABLE_META_SIZE; offset < data.byteLength; offset += 32) {
    addresses.push(encodeBase58(data.subarray(offset, offset + 32)));
  }
  const record = Object.freeze({
    deactivationSlot,
    lastExtendedSlot,
    lastExtendedSlotStartIndex,
    authority,
    addresses: Object.freeze(addresses)
  });
  decodedLookupTables.add(record);
  return record;
}

/**
 * Resolve only indexes visible at bankSlot.
 * slotHashes must come from a separately authenticated, same-bank finalized
 * context; this pure helper cannot establish that provenance itself.
 */
export function resolveAddressLookupTableIndexes(input) {
  const { table, indexes: rawIndexes, bankSlot, slotHashes: rawSlotHashes } =
    snapshotPlainRecord(input, ["table", "indexes", "bankSlot", "slotHashes"],
      "Address lookup table resolution input");
  if (!table || typeof table !== "object" || !decodedLookupTables.has(table) ||
      typeof bankSlot !== "bigint" || bankSlot < 0n || bankSlot > U64_MAX) {
    throw new Error("Address lookup table resolution input is malformed");
  }
  const indexes = snapshotPlainArray(rawIndexes, "Address lookup table indexes", 256);
  const slotHashes = snapshotPlainArray(rawSlotHashes, "Address lookup table SlotHashes", 512);
  if (indexes.length < 1 || slotHashes.some(slot =>
    typeof slot !== "bigint" || slot < 0n || slot > U64_MAX)) {
    throw new Error("Address lookup table resolution input is malformed");
  }
  const active = table.deactivationSlot === U64_MAX ||
    table.deactivationSlot === bankSlot ||
    slotHashes.includes(table.deactivationSlot);
  if (!active) throw new Error("Address lookup table is deactivated at the supplied bank slot");
  const visibleCount = bankSlot > table.lastExtendedSlot
    ? table.addresses.length
    : table.lastExtendedSlotStartIndex;
  const seen = new Set();
  const resolved = [];
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index > 255 ||
        index >= visibleCount || seen.has(index)) {
      throw new Error("Address lookup table index is invalid, duplicated, or not yet active");
    }
    seen.add(index);
    resolved.push(table.addresses[index]);
  }
  return Object.freeze(resolved);
}
