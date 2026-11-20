import test from "node:test";
import assert from "node:assert/strict";
import { decodeSplTokenInstruction, validateSplTokenInstructionSet } from "../spl-token-decoder.mjs";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const encoded = bytes => Buffer.from(bytes).toString("base64");

test("decodes exact classic SPL Token Transfer", () => {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(987654321n, 1);
  const result = decodeSplTokenInstruction(TOKEN, encoded(data), [1, 2, 3]);
  assert.equal(result.variant, "transfer");
  assert.equal(result.amount, 987654321n);
  assert.deepEqual(result.accountRoles, ["source", "destination", "authority"]);
  assert.deepEqual(result.accountIndexes, [1, 2, 3]);
  assert.equal(result.analysisOnly, true);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(validateSplTokenInstructionSet([result]), [result]);
});

test("decodes exact classic SPL Token TransferChecked", () => {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(42n, 1);
  data[9] = 6;
  const result = decodeSplTokenInstruction(TOKEN, encoded(data), [0, 1, 2, 3]);
  assert.equal(result.variant, "transferChecked");
  assert.equal(result.amount, 42n);
  assert.equal(result.decimals, 6);
  assert.deepEqual(result.accountRoles, ["source", "mint", "destination", "authority"]);
});

test("rejects all Token-2022 instructions until extension semantics are verified", () => {
  const checked = Buffer.alloc(10);
  checked[0] = 12;
  checked.writeBigUInt64LE(123456n, 1);
  checked[9] = 9;
  const transfer = Buffer.alloc(9);
  transfer[0] = 3;
  transfer.writeBigUInt64LE(77n, 1);
  assert.throws(
    () => decodeSplTokenInstruction(TOKEN_2022, encoded(checked), [4, 5, 6, 7]),
    /Token-2022 instructions are blocked until extension semantics are verified/
  );
  assert.throws(
    () => decodeSplTokenInstruction(TOKEN_2022, encoded(transfer), [2, 3, 4]),
    /Token-2022 instructions are blocked until extension semantics are verified/
  );
});

test("rejects Token-2022 TransferChecked layouts with extension extra accounts", () => {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(5n, 1);
  data[9] = 6;
  assert.throws(
    () => decodeSplTokenInstruction(TOKEN_2022, encoded(data), [0, 1, 2, 3, 4]),
    /TransferChecked payload or account layout is unsupported/
  );
});

test("rejects unsupported variants, multisig layouts, duplicate accounts and malformed data", () => {
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(Buffer.from([9])), [0, 1, 2]), /variant is unsupported/);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(Buffer.from([3, ...Array(7).fill(0)])), [0, 1, 2]), /payload or account layout/);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(Buffer.from([3, ...Array(8).fill(0)])), [0, 1, 2, 3]), /payload or account layout/);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(Buffer.from([3, ...Array(8).fill(0)])), [0, 0, 2]), /payload or account layout/);
  assert.throws(() => decodeSplTokenInstruction("11111111111111111111111111111111", encoded(Buffer.from([3, ...Array(8).fill(0)])), [0, 1, 2]), /unknown program/);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, "not-base64", [0, 1, 2]), /canonical base64/);
});

test("rejects forged, cloned, and sparse decoded instruction collections", () => {
  assert.throws(() => validateSplTokenInstructionSet([{}]), /unreviewed/);
  const original = decodeSplTokenInstruction(
    TOKEN, encoded(Buffer.from([3, ...Array(8).fill(0)])), [0, 1, 2]
  );
  assert.throws(() => validateSplTokenInstructionSet([{ ...original }]), /unreviewed/);
  assert.throws(() => validateSplTokenInstructionSet([Object.freeze({ ...original })]), /unreviewed/);
  const sparse = new Array(1);
  assert.throws(() => validateSplTokenInstructionSet(sparse), /unreviewed/);
});


test("rejects sparse account index arrays instead of skipping missing entries", () => {
  const sparse = new Array(3);
  sparse[0] = 0;
  sparse[2] = 2;
  const transfer = Buffer.from([3, ...Array(8).fill(0)]);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(transfer), sparse),
    /account indexes are invalid/);
});


test("decoder rejects accessor-backed account indexes without invoking getters", () => {
  let getterCalled = false;
  const indexes = [0, 1, 2];
  Object.defineProperty(indexes, "1", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalled = true;
      return 1;
    }
  });
  const transfer = Buffer.from([3, ...Array(8).fill(0)]);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(transfer), indexes),
    /accessor-backed/);
  assert.equal(getterCalled, false);
});

test("decoder rejects custom-prototype and decorated account index arrays", () => {
  const transfer = Buffer.from([3, ...Array(8).fill(0)]);
  const customPrototype = [0, 1, 2];
  Object.setPrototypeOf(customPrototype, { inherited: true });
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(transfer), customPrototype),
    /account indexes are invalid/);
  const decorated = [0, 1, 2];
  decorated.extra = true;
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(transfer), decorated),
    /unsupported properties/);
  const symbolDecorated = [0, 1, 2];
  symbolDecorated[Symbol("extra")] = true;
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(transfer), symbolDecorated),
    /unsupported properties/);
});

test("validator rejects accessor-backed instruction collections without invoking getters", () => {
  const data = Buffer.from([3, ...Array(8).fill(0)]);
  const decoded = decodeSplTokenInstruction(TOKEN, encoded(data), [0, 1, 2]);
  let getterCalled = false;
  const records = [decoded];
  Object.defineProperty(records, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalled = true;
      return decoded;
    }
  });
  assert.throws(() => validateSplTokenInstructionSet(records), /invalid/);
  assert.equal(getterCalled, false);
});
