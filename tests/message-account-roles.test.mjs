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
