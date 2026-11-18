import test from "node:test";
import assert from "node:assert/strict";
import { decodeSystemProgramInstruction, validateSystemProgramInstructionSet } from "../system-program-decoder.mjs";

const SYSTEM = "11111111111111111111111111111111";
const encoded = bytes => Buffer.from(bytes).toString("base64");
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };

test("decodes bounded System Transfer lamports without claiming semantic trust", () => {
  const bytes = Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(2500000000n)]);
  const decoded = decodeSystemProgramInstruction(SYSTEM, encoded(bytes), [0, 1]);
  assert.equal(decoded.variant, "transfer");
  assert.equal(decoded.lamports, 2500000000n);
  assert.deepEqual(decoded.accountRoles, ["source", "destination"]);
  assert.equal(decoded.analysisOnly, true);
  assert.ok(Object.isFrozen(decoded));
  assert.deepEqual(validateSystemProgramInstructionSet([decoded]), [decoded]);
});

test("decodes exact CreateAccount fields", () => {
  const owner = Buffer.from(Array.from({length: 32}, (_, i) => i));
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0]), u64(1000), u64(165), owner]);
  const decoded = decodeSystemProgramInstruction(SYSTEM, encoded(bytes), [0, 1]);
  assert.equal(decoded.variant, "createAccount");
  assert.equal(decoded.lamports, 1000n);
  assert.equal(decoded.space, 165n);
  assert.equal(decoded.ownerBytesHex, owner.toString("hex"));
});

test("rejects unsupported variants, malformed lengths, wrong accounts and forged records", () => {
  assert.throws(() => decodeSystemProgramInstruction(SYSTEM, encoded(Buffer.from([1,0,0,0,...Array(32).fill(0)])), [0]), /unsupported/);
  assert.throws(() => decodeSystemProgramInstruction(SYSTEM, encoded(Buffer.from([2,0,0,0,...Array(9).fill(0)])), [0,1]), /payload or account count/);
  assert.throws(() => decodeSystemProgramInstruction(SYSTEM, encoded(Buffer.from([2,0,0,0,...Array(8).fill(0)])), [0]), /account count/);
  assert.throws(() => decodeSystemProgramInstruction(SYSTEM, encoded(Buffer.from([2,0,0,0,...Array(8).fill(0)])), [1, 1]), /distinct account indexes/);
  assert.throws(() => decodeSystemProgramInstruction(SYSTEM, encoded(Buffer.from([0,0,0,0,...Array(48).fill(0)])), [2, 2]), /distinct account indexes/);
  assert.throws(() => decodeSystemProgramInstruction("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", encoded(Buffer.from([2,0,0,0,...Array(8).fill(0)])), [0,1]), /unknown program/);
  assert.throws(() => validateSystemProgramInstructionSet([{}]), /unreviewed/);
});
