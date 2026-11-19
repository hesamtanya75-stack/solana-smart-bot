import test from "node:test";
import assert from "node:assert/strict";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
  decodeAddressLookupTableAccountData,
  resolveAddressLookupTableIndexes
} from "../address-lookup-table-verifier.mjs";

function fixture({ addresses = [], deactivationSlot = 0xffffffffffffffffn,
  lastExtendedSlot = 10n, startIndex = addresses.length, authorityTag = 0 } = {}) {
  const data = new Uint8Array(56 + addresses.length * 32);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, deactivationSlot, true);
  view.setBigUint64(12, lastExtendedSlot, true);
  data[20] = startIndex;
  data[21] = authorityTag;
  if (authorityTag === 1) data[22] = 1;
  addresses.forEach((address, index) => data.set(address, 56 + index * 32));
  return data;
}

const keyA = new Uint8Array(32).fill(1);
const keyB = new Uint8Array(32).fill(2);

test("decodes canonical lookup table metadata and ordered addresses", () => {
  const decoded = decodeAddressLookupTableAccountData(fixture({ addresses: [keyA, keyB] }));
  assert.equal(decoded.deactivationSlot, 0xffffffffffffffffn);
  assert.equal(decoded.lastExtendedSlot, 10n);
  assert.equal(decoded.lastExtendedSlotStartIndex, 2);
  assert.equal(decoded.authority, null);
  assert.equal(decoded.addresses.length, 2);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.addresses));
  assert.equal(ADDRESS_LOOKUP_TABLE_PROGRAM_ID, "AddressLookupTab1e1111111111111111111111111");
});

test("rejects uninitialized, malformed, noncanonical and oversized lookup table data", () => {
  const uninitialized = fixture({ addresses: [keyA] });
  new DataView(uninitialized.buffer).setUint32(0, 0, true);
  assert.throws(() => decodeAddressLookupTableAccountData(uninitialized), /not initialized/);
  const truncated = fixture({ addresses: [keyA] }).slice(0, 87);
  assert.throws(() => decodeAddressLookupTableAccountData(truncated), /truncated/);
  const badTag = fixture({ addresses: [keyA] });
  badTag[21] = 2;
  assert.throws(() => decodeAddressLookupTableAccountData(badTag), /authority option/);
  const badPadding = fixture({ addresses: [keyA] });
  badPadding[55] = 1;
  assert.throws(() => decodeAddressLookupTableAccountData(badPadding), /padding/);
  const badFrozenAuthority = fixture({ addresses: [keyA] });
  badFrozenAuthority[22] = 1;
  assert.throws(() => decodeAddressLookupTableAccountData(badFrozenAuthority), /reserved authority/);
  const badStartIndex = fixture({ addresses: [keyA], startIndex: 2 });
  assert.throws(() => decodeAddressLookupTableAccountData(badStartIndex), /inconsistent/);
  assert.throws(() => decodeAddressLookupTableAccountData(new Uint8Array(56 + 257 * 32)), /invalid size/);
});

test("lookup resolution rejects cloned or caller-constructed decoded table records", () => {
  const decoded = decodeAddressLookupTableAccountData(fixture({ addresses: [keyA] }));
  const clone = Object.freeze({
    ...decoded,
    addresses: Object.freeze([...decoded.addresses])
  });
  const args = { indexes: [0], bankSlot: 11n, slotHashes: [] };
  assert.throws(() => resolveAddressLookupTableIndexes({ ...args, table: clone }), /malformed/);
  assert.throws(() => resolveAddressLookupTableIndexes({
    ...args,
    table: {
      deactivationSlot: 0xffffffffffffffffn,
      lastExtendedSlot: 10n,
      lastExtendedSlotStartIndex: 1,
      authority: null,
      addresses: [decoded.addresses[0]]
    }
  }), /malformed/);
  assert.deepEqual(resolveAddressLookupTableIndexes({ ...args, table: decoded }), [decoded.addresses[0]]);
});

test("lookup resolution enforces deactivation and same-slot warmup visibility", () => {
  const table = decodeAddressLookupTableAccountData(fixture({
    addresses: [keyA, keyB], lastExtendedSlot: 10n, startIndex: 1
  }));
  assert.deepEqual(
    resolveAddressLookupTableIndexes({ table, indexes: [0], bankSlot: 10n, slotHashes: [] }),
    [table.addresses[0]]
  );
  assert.throws(
    () => resolveAddressLookupTableIndexes({ table, indexes: [1], bankSlot: 10n, slotHashes: [] }),
    /not yet active/
  );
  assert.deepEqual(
    resolveAddressLookupTableIndexes({ table, indexes: [1], bankSlot: 11n, slotHashes: [] }),
    [table.addresses[1]]
  );
  const deactivated = decodeAddressLookupTableAccountData(fixture({
    addresses: [keyA], deactivationSlot: 9n
  }));
  assert.throws(
    () => resolveAddressLookupTableIndexes({ table: deactivated, indexes: [0], bankSlot: 20n, slotHashes: [] }),
    /deactivated/
  );
  assert.deepEqual(
    resolveAddressLookupTableIndexes({ table: deactivated, indexes: [0], bankSlot: 20n, slotHashes: [9n] }),
    [deactivated.addresses[0]]
  );
});

test("lookup resolution snapshots plain inputs and rejects accessor-backed or sparse values", () => {
  const table = decodeAddressLookupTableAccountData(fixture({ addresses: [keyA] }));
  const base = { table, indexes: [0], bankSlot: 11n, slotHashes: [] };
  let getterCalled = false;
  const accessorInput = { ...base };
  Object.defineProperty(accessorInput, "bankSlot", {
    enumerable: true,
    get() { getterCalled = true; return 11n; }
  });
  assert.throws(() => resolveAddressLookupTableIndexes(accessorInput), /accessor-backed/);
  assert.equal(getterCalled, false);

  const sparseIndexes = new Array(1);
  assert.throws(() => resolveAddressLookupTableIndexes({
    ...base, indexes: sparseIndexes
  }), /sparse/);

  const accessorIndexes = [0];
  Object.defineProperty(accessorIndexes, "0", {
    enumerable: true,
    get() { getterCalled = true; return 0; }
  });
  assert.throws(() => resolveAddressLookupTableIndexes({
    ...base, indexes: accessorIndexes
  }), /accessor-backed/);
  assert.equal(getterCalled, false);

  assert.throws(() => resolveAddressLookupTableIndexes({
    ...base, slotHashes: [Number(10)]
  }), /malformed/);
});

test("lookup resolution rejects invalid and repeated indexes", () => {
  const table = decodeAddressLookupTableAccountData(fixture({ addresses: [keyA, keyB] }));
  const base = { table, bankSlot: 11n, slotHashes: [] };
  assert.throws(() => resolveAddressLookupTableIndexes({ ...base, indexes: [2] }), /invalid/);
  assert.throws(() => resolveAddressLookupTableIndexes({ ...base, indexes: [0, 0] }), /duplicated/);
  assert.throws(() => resolveAddressLookupTableIndexes({ ...base, indexes: [] }), /malformed/);
});
