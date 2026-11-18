import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeAssociatedTokenInstruction,
  validateAssociatedTokenInstructionSet
} from "../associated-token-account-decoder.mjs";

const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const keys = ["11111111111111111111111111111112", "11111111111111111111111111111113",
  "11111111111111111111111111111114", "11111111111111111111111111111115", SYSTEM, TOKEN];
const encoded = tag => Buffer.from([tag]).toString("base64");

test("decodes exact Associated Token Create layout", () => {
  const result = decodeAssociatedTokenInstruction(ATA, encoded(0), [0,1,2,3,4,5], keys);
  assert.equal(result.variant, "create");
  assert.equal(result.payerAccountIndex, 0);
  assert.equal(result.associatedAccountIndex, 1);
  assert.equal(result.ownerAccountIndex, 2);
  assert.equal(result.mintAccountIndex, 3);
  assert.equal(result.tokenProgramId, TOKEN);
  assert.equal(result.analysisOnly, true);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(validateAssociatedTokenInstructionSet([result]), [result]);
});

test("decodes CreateIdempotent and permits the Token-2022 program account", () => {
  const token2022Keys = [...keys.slice(0,5), TOKEN_2022];
  const result = decodeAssociatedTokenInstruction(ATA, encoded(1), [0,1,2,3,4,5], token2022Keys);
  assert.equal(result.variant, "createIdempotent");
  assert.equal(result.tokenProgramId, TOKEN_2022);
});

test("rejects unsupported variants, malformed layouts, bad program accounts and duplicates", () => {
  assert.throws(() => decodeAssociatedTokenInstruction(ATA, encoded(2), [0,1,2,3,4,5], keys), /variant is unsupported/);
  assert.throws(() => decodeAssociatedTokenInstruction(ATA, encoded(0), [0,1,2,3,4], keys), /layout is unsupported/);
  assert.throws(() => decodeAssociatedTokenInstruction(ATA, encoded(0), [0,1,2,3,3,5], keys), /distinct/);
  assert.throws(() => decodeAssociatedTokenInstruction(ATA, encoded(0), [0,1,2,3,4,5], [...keys.slice(0,4), "11111111111111111111111111111116", TOKEN]), /system or token program/);
  assert.throws(() => decodeAssociatedTokenInstruction("11111111111111111111111111111111", encoded(0), [0,1,2,3,4,5], keys), /unknown program/);
  assert.throws(() => decodeAssociatedTokenInstruction(ATA, "AAA=", [0,1,2,3,4,5], keys), /canonical one-byte/);
});

test("rejects forged and sparse records", () => {
  assert.throws(() => validateAssociatedTokenInstructionSet([{}]), /unreviewed/);
  assert.throws(() => validateAssociatedTokenInstructionSet(new Array(1)), /unreviewed/);
});


test("allows payer and owner to resolve to the same wallet public key", () => {
  const payerIsOwner = [...keys];
  payerIsOwner[2] = payerIsOwner[0];
  const result = decodeAssociatedTokenInstruction(
    ATA, encoded(0), [0,1,2,3,4,5], payerIsOwner
  );
  assert.equal(result.variant, "create");
  assert.equal(result.payerAccountIndex, 0);
  assert.equal(result.ownerAccountIndex, 2);
  assert.equal(payerIsOwner[result.payerAccountIndex], payerIsOwner[result.ownerAccountIndex]);
});

test("still rejects duplicate ATA instruction account indexes", () => {
  assert.throws(
    () => decodeAssociatedTokenInstruction(ATA, encoded(0), [0,1,2,3,3,5], keys),
    /indexes must be distinct/
  );
});
