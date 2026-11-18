import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTE_BUDGET_PROGRAM,
  decodeComputeBudgetInstruction,
  validateComputeBudgetInstructionSet,
  INSTRUCTION_DECODER_REGISTRY_VERSION,
  decodeSupportedTransactionInstruction,
  validateSupportedTransactionInstructionSet
} from "../compute-budget-decoder.mjs";

function data(tag, value, width = 4) {
  const bytes = Buffer.alloc(1 + width);
  bytes[0] = tag;
  if (width === 8) bytes.writeBigUInt64LE(BigInt(value), 1);
  else bytes.writeUInt32LE(value, 1);
  return bytes.toString("base64");
}

test("Compute Budget decoder accepts supported bounded instruction variants", () => {
  assert.deepEqual(
    decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(1, 32768)),
    { programId: COMPUTE_BUDGET_PROGRAM, decoderVersion: 1, variant: "requestHeapFrame", heapFrameBytes: 32768 }
  );
  assert.equal(
    decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 1400000)).units,
    1400000
  );
  assert.equal(
    decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(3, 123456789, 8)).microLamports,
    123456789n
  );
  assert.equal(
    decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(4, 1024)).bytes,
    1024
  );
});

test("Compute Budget decoder rejects unknown programs, variants and legacy RequestUnits", () => {
  assert.throws(() => decodeComputeBudgetInstruction("11111111111111111111111111111111", data(2, 1000)),
    /unknown program IDs/);
  assert.throws(() => decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(99, 1000)),
    /variant or payload shape is unsupported/);
  assert.throws(() => decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(0, 1000)),
    /variant or payload shape is unsupported/);
});

test("Compute Budget decoder rejects malformed, non-canonical and wrong-length payloads", () => {
  for (const value of ["", "!!!!", "Ag==", "AgAAAA==", "AgAAAAAA"]) {
    assert.throws(() => decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, value));
  }
  assert.throws(() => decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 0)),
    /outside the supported range/);
  assert.throws(() => decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 1400001)),
    /outside the supported range/);
  assert.throws(() => decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(1, 32769)),
    /outside the supported range/);
  assert.throws(() => decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(4, 64 * 1024 * 1024 + 1)),
    /outside the supported range/);
});

test("Compute Budget decoder preserves u64 priority price exactly", () => {
  const value = 18446744073709551615n;
  assert.equal(
    decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(3, value, 8)).microLamports,
    value
  );
});

test("Compute Budget instruction set rejects duplicate variants and malformed entries", () => {
  const limit = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 200000));
  const price = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(3, 10, 8));
  assert.equal(validateComputeBudgetInstructionSet([limit, price]).length, 2);
  assert.throws(() => validateComputeBudgetInstructionSet([limit, limit]), /unknown or duplicate variant/);
  assert.throws(() => validateComputeBudgetInstructionSet([{ ...limit, decoderVersion: 2 }]), /unknown or duplicate variant/);
  assert.throws(() => validateComputeBudgetInstructionSet([{ ...limit }]), /unknown or duplicate variant/);
  assert.throws(() => validateComputeBudgetInstructionSet(new Array(65)), /collection is invalid/);
});

test("versioned instruction registry accepts only reviewed Compute Budget instructions", () => {
  assert.equal(INSTRUCTION_DECODER_REGISTRY_VERSION, 1);
  const limit = decodeSupportedTransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM, data: data(2, 200000), accountIndexes: []
  });
  const price = decodeSupportedTransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM, data: data(3, 10, 8), accountIndexes: []
  });
  assert.equal(limit.registryVersion, 1);
  assert.equal(limit.accountRoles.length, 0);
  assert.equal(limit.variant, "setComputeUnitLimit");
  assert.equal(validateSupportedTransactionInstructionSet([limit, price]).length, 2);
});

test("versioned instruction registry rejects unknown programs and unsupported account layouts", () => {
  assert.throws(() => decodeSupportedTransactionInstruction({
    programId: "11111111111111111111111111111111", data: data(2, 200000), accountIndexes: []
  }), /unsupported program ID/);
  assert.throws(() => decodeSupportedTransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM, data: data(2, 200000), accountIndexes: [0]
  }), /account-role schema/);
  assert.throws(() => decodeSupportedTransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM, data: data(2, 200000), accountIndexes: null
  }), /account-role schema/);
});

test("versioned instruction registry rejects forged, mutated and duplicate records", () => {
  const limit = decodeSupportedTransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM, data: data(2, 200000), accountIndexes: []
  });
  const price = decodeSupportedTransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM, data: data(3, 10, 8), accountIndexes: []
  });
  assert.throws(() => validateSupportedTransactionInstructionSet([{ ...limit }]), /forged/);
  assert.throws(() => validateSupportedTransactionInstructionSet([{
    ...limit, registryVersion: 2
  }]), /forged/);
  assert.throws(() => validateSupportedTransactionInstructionSet([limit, limit]), /duplicate variant/);
  assert.equal(validateSupportedTransactionInstructionSet([limit, price]).length, 2);
  assert.throws(() => validateSupportedTransactionInstructionSet(new Array(65)), /collection is invalid/);
});
