import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTE_BUDGET_PROGRAM,
  decodeComputeBudgetInstruction,
  validateComputeBudgetInstructionSet,
  INSTRUCTION_DECODER_REGISTRY_VERSION,
  decodeSupportedTransactionInstruction,
  validateSupportedTransactionInstructionSet,
  validateComputeBudgetPolicy
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


test("Compute Budget policy enforces explicit compute and priority-fee ceilings", () => {
  const limit = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 200000));
  const price = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(3, 250000, 8));
  const heap = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(1, 65536));
  const loaded = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(4, 1048576));
  const limits = {
    maxComputeUnitLimit: 300000,
    maxPriorityFeeLamports: 50000n,
    maxHeapFrameBytes: 131072,
    maxLoadedAccountDataBytes: 2097152
  };
  const result = validateComputeBudgetPolicy([limit, price, heap, loaded], limits);
  assert.equal(result.unitLimit, 200000);
  assert.equal(result.priorityFeeLamports, 50000n);
  assert.equal(result.heapFrameBytes, 65536);
  assert.equal(result.loadedAccountDataBytes, 1048576);
  assert.ok(Object.isFrozen(result));
  assert.throws(() => validateComputeBudgetPolicy([limit, price], {
    ...limits, maxPriorityFeeLamports: 49999n
  }), /priority fee exceeds transaction policy/);
  assert.throws(() => validateComputeBudgetPolicy([limit], {
    ...limits, maxComputeUnitLimit: 199999
  }), /unit limit exceeds transaction policy/);
  assert.throws(() => validateComputeBudgetPolicy([heap], {
    ...limits, maxHeapFrameBytes: 32768
  }), /heap-frame size exceeds transaction policy/);
  assert.throws(() => validateComputeBudgetPolicy([loaded], {
    ...limits, maxLoadedAccountDataBytes: 1024
  }), /loaded-account-data limit exceeds transaction policy/);
});

test("Compute Budget policy rejects ceilings outside supported protocol bounds", () => {
  const limit = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 200000));
  const valid = {
    maxComputeUnitLimit: 300000,
    maxPriorityFeeLamports: 50000n,
    maxHeapFrameBytes: 131072,
    maxLoadedAccountDataBytes: 2097152
  };
  const invalidPolicies = [
    { ...valid, maxComputeUnitLimit: 1400001 },
    { ...valid, maxHeapFrameBytes: 32769 },
    { ...valid, maxHeapFrameBytes: 263168 },
    { ...valid, maxLoadedAccountDataBytes: 64 * 1024 * 1024 + 1 }
  ];
  for (const policy of invalidPolicies) {
    assert.throws(
      () => validateComputeBudgetPolicy([limit], policy),
      /policy limits are invalid or incomplete/
    );
  }
});

test("Compute Budget policy rejects missing or malformed policy ceilings", () => {
  const limit = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 200000));
  assert.throws(() => validateComputeBudgetPolicy([limit], null), /invalid or incomplete/);
  assert.throws(() => validateComputeBudgetPolicy([limit], {
    maxComputeUnitLimit: 200000,
    maxPriorityFeeLamports: -1n,
    maxHeapFrameBytes: 65536,
    maxLoadedAccountDataBytes: 1000000
  }), /invalid or incomplete/);
});


test("Compute Budget validators reject accessor-backed instruction arrays without invoking getters", () => {
  const limit = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 200000));
  let getterCalled = false;
  const records = [limit];
  Object.defineProperty(records, "0", {
    enumerable: true,
    get() {
      getterCalled = true;
      return limit;
    }
  });
  assert.throws(() => validateComputeBudgetInstructionSet(records), /accessor-backed/);
  assert.equal(getterCalled, false);

  const transactionRecord = decodeSupportedTransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM,
    data: data(2, 200000),
    accountIndexes: []
  });
  getterCalled = false;
  const transactionRecords = [transactionRecord];
  Object.defineProperty(transactionRecords, "0", {
    enumerable: true,
    get() {
      getterCalled = true;
      return transactionRecord;
    }
  });
  assert.throws(() => validateSupportedTransactionInstructionSet(transactionRecords), /accessor-backed/);
  assert.equal(getterCalled, false);
});

test("Compute Budget validators reject decorated and custom-prototype arrays", () => {
  const limit = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 200000));
  const decorated = [limit];
  decorated.extra = true;
  assert.throws(() => validateComputeBudgetInstructionSet(decorated), /unsupported properties/);
  const custom = [limit];
  Object.setPrototypeOf(custom, { inherited: true });
  assert.throws(() => validateComputeBudgetInstructionSet(custom), /invalid/);

  const transactionRecord = decodeSupportedTransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM,
    data: data(2, 200000),
    accountIndexes: []
  });
  const transactionRecords = [transactionRecord];
  transactionRecords.extra = true;
  assert.throws(() => validateSupportedTransactionInstructionSet(transactionRecords), /unsupported properties/);
});

test("Compute Budget registry rejects decorated empty account-index arrays", () => {
  const indexes = [];
  indexes.extra = true;
  assert.throws(() => decodeSupportedTransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM,
    data: data(2, 200000),
    accountIndexes: indexes
  }), /unsupported properties/);
});


test("Compute Budget policy snapshots exact own data limits and rejects accessors without invoking them", () => {
  const limit = decodeComputeBudgetInstruction(COMPUTE_BUDGET_PROGRAM, data(2, 200000));
  const valid = {
    maxComputeUnitLimit: 300000,
    maxPriorityFeeLamports: 50000n,
    maxHeapFrameBytes: 131072,
    maxLoadedAccountDataBytes: 2097152
  };
  let getterCalls = 0;
  const accessorLimits = { ...valid };
  Object.defineProperty(accessorLimits, "maxPriorityFeeLamports", {
    enumerable: true,
    get() { getterCalls++; return 50000n; }
  });
  assert.throws(() => validateComputeBudgetPolicy([limit], accessorLimits),
    /own data properties/);
  assert.equal(getterCalls, 0);

  const decoratedLimits = { ...valid, unexpected: true };
  assert.throws(() => validateComputeBudgetPolicy([limit], decoratedLimits),
    /invalid or incomplete/);

  const customPrototype = Object.assign(Object.create({ inherited: true }), valid);
  assert.throws(() => validateComputeBudgetPolicy([limit], customPrototype),
    /invalid or incomplete/);

  assert.equal(validateComputeBudgetPolicy([limit], valid).unitLimit, 200000);
});
