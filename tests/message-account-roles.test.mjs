import test from "node:test";
import assert from "node:assert/strict";
import { deriveMessageAccountRoles } from "../message-account-roles.mjs";

const keys = {
  a: "11111111111111111111111111111111",
  b: "ComputeBudget111111111111111111111111111111",
  c: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  d: "So11111111111111111111111111111111111111112",
  e: "SysvarRent111111111111111111111111111111111"
};

test("derives legacy static signer and writable roles from message header", () => {
  const result = deriveMessageAccountRoles({
    staticAccountKeys: [keys.a, keys.b, keys.c, keys.d],
    header: {
      numRequiredSignatures: 2,
      numReadonlySignedAccounts: 1,
      numReadonlyUnsignedAccounts: 1
    }
  });
  assert.deepEqual(result.roles.map(({ signer, writable }) => [signer, writable]), [
    [true, true], [true, false], [false, true], [false, false]
  ]);
  assert.equal(result.accountCount, 4);
  assert.ok(Object.isFrozen(result.roles));
});

test("appends resolved v0 lookup writable then readonly addresses as non-signers", () => {
  const result = deriveMessageAccountRoles({
    staticAccountKeys: [keys.a, keys.b],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1
    },
    resolvedAddressTableLookups: [{
      writableAddresses: [keys.c],
      readonlyAddresses: [keys.d, keys.e]
    }]
  });
  assert.deepEqual(result.roles.map(({ index, source, signer, writable }) =>
    [index, source, signer, writable]), [
    [0, "static", true, true],
    [1, "static", false, false],
    [2, "lookup-writable", false, true],
    [3, "lookup-readonly", false, false],
    [4, "lookup-readonly", false, false]
  ]);
});

test("keeps all writable lookup keys before readonly keys across multiple tables", () => {
  const result = deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 0
    },
    resolvedAddressTableLookups: [
      { writableAddresses: [keys.b], readonlyAddresses: [keys.c] },
      { writableAddresses: [keys.d], readonlyAddresses: [keys.e] }
    ]
  });
  assert.deepEqual(result.roles.slice(1).map(({ publicKey, writable }) => [publicKey, writable]), [
    [keys.b, true],
    [keys.d, true],
    [keys.c, false],
    [keys.e, false]
  ]);
});

test("rejects static and resolved lookup account lists above the 256-key bound", () => {
  const staticKeys = Array.from({ length: 257 }, () => keys.a);
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: staticKeys,
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 256 }
  }), /input is malformed/);

  const lookupKeys = [keys.b, keys.c, keys.d, keys.e];
  const repeated = Array.from({ length: 256 }, (_, index) => lookupKeys[index % lookupKeys.length]);
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
    resolvedAddressTableLookups: [{
      writableAddresses: repeated,
      readonlyAddresses: []
    }]
  }), /exceed parser limit/);
});

test("rejects sparse static account key arrays", () => {
  const sparseKeys = new Array(2);
  sparseKeys[0] = keys.a;
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: sparseKeys,
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }
  }), /invalid or duplicated/);
});

test("rejects malformed header counts, invalid keys, duplicates and unresolved lookup shapes", () => {
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header: { numRequiredSignatures: 2, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }
  }), /header privilege counts/);
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a, keys.a],
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }
  }), /invalid or duplicated/);
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a, keys.b],
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
    resolvedAddressTableLookups: [{ writableAddresses: [keys.a], readonlyAddresses: [] }]
  }), /invalid or duplicated/);
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
    resolvedAddressTableLookups: [{ writableAddresses: [keys.b] }]
  }), /malformed/);
});
test("rejects duplicate loaded addresses across writable and readonly groups and tables", () => {
  const header = {
    numRequiredSignatures: 1,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: 0
  };
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header,
    resolvedAddressTableLookups: [{
      writableAddresses: [keys.b],
      readonlyAddresses: [keys.b]
    }]
  }), /invalid or duplicated/);
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header,
    resolvedAddressTableLookups: [
      { writableAddresses: [keys.b], readonlyAddresses: [] },
      { writableAddresses: [], readonlyAddresses: [keys.b] }
    ]
  }), /invalid or duplicated/);
});

test("rejects sparse resolved writable and readonly lookup address arrays", () => {
  const sparseWritable = new Array(1);
  const sparseReadonly = new Array(1);
  const header = {
    numRequiredSignatures: 1,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: 0
  };
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header,
    resolvedAddressTableLookups: [{ writableAddresses: sparseWritable, readonlyAddresses: [] }]
  }), /invalid or duplicated/);
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header,
    resolvedAddressTableLookups: [{ writableAddresses: [], readonlyAddresses: sparseReadonly }]
  }), /invalid or duplicated/);
});
test("rejects sparse resolved lookup table lists", () => {
  const sparseTables = new Array(1);
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 0
    },
    resolvedAddressTableLookups: sparseTables
  }), /malformed/);
});
test("rejects sparse lookup key arrays even when holes follow valid addresses", () => {
  const sparseWritable = new Array(2);
  sparseWritable[0] = keys.b;
  const sparseReadonly = new Array(2);
  sparseReadonly[0] = keys.c;
  const header = {
    numRequiredSignatures: 1,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: 0
  };
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header,
    resolvedAddressTableLookups: [{ writableAddresses: sparseWritable, readonlyAddresses: [] }]
  }), /invalid or duplicated/);
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header,
    resolvedAddressTableLookups: [{ writableAddresses: [], readonlyAddresses: sparseReadonly }]
  }), /invalid or duplicated/);
});


test("rejects accessor-backed static keys, lookup lists and lookup addresses without invoking getters", () => {
  const header = {
    numRequiredSignatures: 1,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: 0
  };
  let getterCalled = false;
  const staticKeys = [keys.a];
  Object.defineProperty(staticKeys, "0", {
    enumerable: true,
    get() { getterCalled = true; return keys.a; }
  });
  assert.throws(() => deriveMessageAccountRoles({ staticAccountKeys: staticKeys, header }), /accessor-backed/);
  assert.equal(getterCalled, false);

  const lookupAddresses = [keys.b];
  Object.defineProperty(lookupAddresses, "0", {
    enumerable: true,
    get() { getterCalled = true; return keys.b; }
  });
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a],
    header,
    resolvedAddressTableLookups: [{ writableAddresses: lookupAddresses, readonlyAddresses: [] }]
  }), /accessor-backed/);
  assert.equal(getterCalled, false);

  const lookupTables = [{}];
  Object.defineProperty(lookupTables, "0", {
    enumerable: true,
    get() { getterCalled = true; return { writableAddresses: [], readonlyAddresses: [] }; }
  });
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a], header, resolvedAddressTableLookups: lookupTables
  }), /accessor-backed/);
  assert.equal(getterCalled, false);
});

test("rejects decorated and custom-prototype account-role collections and records", () => {
  const header = {
    numRequiredSignatures: 1,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: 0
  };
  const decorated = [keys.a];
  decorated.extra = true;
  assert.throws(() => deriveMessageAccountRoles({ staticAccountKeys: decorated, header }), /unsupported properties/);

  const custom = [keys.a];
  Object.setPrototypeOf(custom, { inherited: true });
  assert.throws(() => deriveMessageAccountRoles({ staticAccountKeys: custom, header }), /malformed/);

  const decoratedLookup = { writableAddresses: [], readonlyAddresses: [], extra: true };
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a], header, resolvedAddressTableLookups: [decoratedLookup]
  }), /unsupported properties/);

  const accessorHeader = { ...header };
  Object.defineProperty(accessorHeader, "numRequiredSignatures", {
    enumerable: true, get() { throw new Error("getter must not run"); }
  });
  assert.throws(() => deriveMessageAccountRoles({
    staticAccountKeys: [keys.a], header: accessorHeader
  }), /accessor-backed/);
});
