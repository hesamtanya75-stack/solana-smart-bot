import test from "node:test";
import assert from "node:assert/strict";
import { decodeSplTokenInstruction, validateSplTokenInstructionSet } from "../spl-token-decoder.mjs";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
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

test("rejects unsupported variants, multisig layouts, duplicate accounts and malformed data", () => {
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(Buffer.from([9])), [0, 1, 2]), /variant is unsupported/);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(Buffer.from([3, ...Array(7).fill(0)])), [0, 1, 2]), /payload or account layout/);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(Buffer.from([3, ...Array(8).fill(0)])), [0, 1, 2, 3]), /payload or account layout/);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, encoded(Buffer.from([3, ...Array(8).fill(0)])), [0, 0, 2]), /payload or account layout/);
  assert.throws(() => decodeSplTokenInstruction("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", encoded(Buffer.from([3, ...Array(8).fill(0)])), [0, 1, 2]), /unknown program/);
  assert.throws(() => decodeSplTokenInstruction(TOKEN, "not-base64", [0, 1, 2]), /canonical base64/);
});

test("rejects forged and sparse decoded instruction collections", () => {
  assert.throws(() => validateSplTokenInstructionSet([{}]), /unreviewed/);
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
