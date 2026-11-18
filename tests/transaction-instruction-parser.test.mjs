import test from "node:test";
import assert from "node:assert/strict";
import { COMPUTE_BUDGET_PROGRAM } from "../compute-budget-decoder.mjs";
import { parseSupportedInstructionMessage } from "../transaction-instruction-parser.mjs";

function data(tag, value) {
  const bytes = Buffer.alloc(5);
  bytes[0] = tag;
  bytes.writeUInt32LE(value, 1);
  return bytes.toString("base64");
}

function message(instructions, accountKeys = [COMPUTE_BUDGET_PROGRAM]) {
  return { accountKeys, instructions };
}

test("transaction parser returns analysis-only result for registered Compute Budget instruction", () => {
  const parsed = parseSupportedInstructionMessage(message([{
    programIdIndex: 0,
    accountKeyIndexes: [],
    data: data(2, 200000)
  }]));
  assert.equal(parsed.parserVersion, 1);
  assert.equal(parsed.decoderRegistryVersion, 1);
  assert.equal(parsed.instructionCount, 1);
  assert.equal(parsed.instructions[0].variant, "setComputeUnitLimit");
  assert.equal(parsed.analysisOnly, true);
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.instructions));
});

test("transaction parser rejects unregistered System Program and token instructions", () => {
  for (const programId of [
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  ]) {
    assert.throws(() => parseSupportedInstructionMessage(
      message([{ programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000) }], [programId]),
    ), /unsupported program ID/);
  }
});

test("transaction parser rejects sparse compiled instruction arrays", () => {
  const sparseInstructions = new Array(2);
  sparseInstructions[0] = {
    programIdIndex: 0,
    accountKeyIndexes: [],
    data: data(2, 200000)
  };
  assert.throws(() => parseSupportedInstructionMessage(message(sparseInstructions)),
    /sparse compiled instruction list/);
});

test("transaction parser rejects sparse account-key arrays", () => {
  const sparseKeys = new Array(2);
  sparseKeys[0] = COMPUTE_BUDGET_PROGRAM;
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0,
    accountKeyIndexes: [],
    data: data(2, 200000)
  }], sparseKeys)), /invalid account key/);
});

test("transaction parser rejects malformed compiled instruction indexes and keys", () => {
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 2, accountKeyIndexes: [], data: data(2, 200000)
  }])), /invalid compiled layout/);
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0, accountKeyIndexes: [1], data: data(2, 200000)
  }], [COMPUTE_BUDGET_PROGRAM, "So11111111111111111111111111111111111111112"])),
  /account-role schema/);
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000)
  }], ["not-a-public-key"])), /invalid account key/);
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000)
  }], ["22222222222222222222222222222222"])), /invalid account key/);
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000)
  }], ["zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"])), /invalid account key/);
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000)
  }], [COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM])), /duplicate account keys/);
});

test("transaction parser rejects malformed data, duplicate variants and oversized messages", () => {
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0, accountKeyIndexes: [], data: "not-base64"
  }])), /canonical base64/);
  assert.throws(() => parseSupportedInstructionMessage(message([
    { programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000) },
    { programIdIndex: 0, accountKeyIndexes: [], data: data(2, 300000) }
  ])), /duplicate variant/);
  assert.throws(() => parseSupportedInstructionMessage(message(
    Array.from({ length: 65 }, () => ({
      programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000)
    }))
  )), /shape is invalid or exceeds parser limits/);
  assert.throws(() => parseSupportedInstructionMessage(message([])),
    /shape is invalid or exceeds parser limits/);
});
