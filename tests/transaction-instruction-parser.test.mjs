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

function priorityPriceData(microLamports) {
  const bytes = Buffer.alloc(9);
  bytes[0] = 3;
  bytes.writeBigUInt64LE(BigInt(microLamports), 1);
  return bytes.toString("base64");
}

const SYSTEM = "11111111111111111111111111111111";
const SOURCE = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DESTINATION = "So11111111111111111111111111111111111111112";

function transferData(lamports) {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(2, 0);
  bytes.writeBigUInt64LE(BigInt(lamports), 4);
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

test("transaction parser integrates the syntax-only System Program transfer decoder", () => {
  const parsed = parseSupportedInstructionMessage(message([{
    programIdIndex: 0,
    accountKeyIndexes: [1, 2],
    data: transferData(2500000000n)
  }], [SYSTEM, SOURCE, DESTINATION]));
  assert.equal(parsed.instructionCount, 1);
  assert.equal(parsed.instructions[0].variant, "transfer");
  assert.equal(parsed.instructions[0].lamports, 2500000000n);
  assert.deepEqual(parsed.instructions[0].accountRoles, ["source", "destination"]);
  assert.deepEqual(parsed.instructions[0].accountIndexes, [1, 2]);
  assert.ok(Object.isFrozen(parsed.instructions[0].accountIndexes));
  assert.equal(parsed.analysisOnly, true);
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("transaction parser preserves original order across Compute Budget and System instructions", () => {
  const parsed = parseSupportedInstructionMessage(message([
    { programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000) },
    { programIdIndex: 1, accountKeyIndexes: [2, 3], data: transferData(42) },
    { programIdIndex: 0, accountKeyIndexes: [], data: priorityPriceData(1) }
  ], [COMPUTE_BUDGET_PROGRAM, SYSTEM, SOURCE, DESTINATION]));
  assert.deepEqual(parsed.instructions.map(instruction => instruction.variant), [
    "setComputeUnitLimit",
    "transfer",
    "setComputeUnitPrice"
  ]);
  assert.equal(parsed.instructions[1].lamports, 42n);
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("transaction parser rejects malformed System Program account layouts and unsupported variants", () => {
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0, accountKeyIndexes: [1], data: transferData(1)
  }], [SYSTEM, SOURCE])), /payload or account count is invalid/);
  const unknown = Buffer.alloc(4);
  unknown.writeUInt32LE(99, 0);
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0, accountKeyIndexes: [1, 2], data: unknown.toString("base64")
  }], [SYSTEM, SOURCE, DESTINATION])), /variant is unsupported/);
});

test("transaction parser rejects unregistered Token and Token-2022 instructions", () => {
  for (const programId of [
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

test("transaction parser rejects sparse compiled account index arrays", () => {
  const sparseIndexes = new Array(2);
  sparseIndexes[0] = 1;
  assert.throws(() => parseSupportedInstructionMessage(message([{
    programIdIndex: 0, accountKeyIndexes: sparseIndexes, data: transferData(1)
  }], [SYSTEM, SOURCE, DESTINATION])), /sparse account indexes/);
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

import { deriveMessageAccountRoles } from "../message-account-roles.mjs";

test("System Transfer account indexes can be cross-checked against derived privileges without granting semantic trust", () => {
  const accountKeys = [SOURCE, SYSTEM, DESTINATION];
  const parsed = parseSupportedInstructionMessage(message([{
    programIdIndex: 1,
    accountKeyIndexes: [0, 2],
    data: transferData(123)
  }], accountKeys));
  const roles = deriveMessageAccountRoles({
    staticAccountKeys: accountKeys,
    header: {
      numRequiredSignatures: 2,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 0
    }
  });
  const transfer = parsed.instructions[0];
  const sourceRole = roles.roles[transfer.accountIndexes[0]];
  const destinationRole = roles.roles[transfer.accountIndexes[1]];
  assert.equal(sourceRole.publicKey, SOURCE);
  assert.equal(sourceRole.signer, true);
  assert.equal(sourceRole.writable, true);
  assert.equal(destinationRole.publicKey, DESTINATION);
  assert.equal(destinationRole.signer, false);
  assert.equal(destinationRole.writable, true);
  // These two helpers are not yet a complete semantic verifier or signer gate.
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("System Transfer with a readonly source remains analysis-only and is not promoted to approval", () => {
  const accountKeys = [SOURCE, SYSTEM, DESTINATION];
  const parsed = parseSupportedInstructionMessage(message([{
    programIdIndex: 1,
    accountKeyIndexes: [0, 2],
    data: transferData(123)
  }], accountKeys));
  const roles = deriveMessageAccountRoles({
    staticAccountKeys: accountKeys,
    header: {
      numRequiredSignatures: 2,
      numReadonlySignedAccounts: 1,
      numReadonlyUnsignedAccounts: 0
    }
  });
  const sourceRole = roles.roles[parsed.instructions[0].accountIndexes[0]];
  assert.equal(sourceRole.signer, true);
  assert.equal(sourceRole.writable, false);
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});
