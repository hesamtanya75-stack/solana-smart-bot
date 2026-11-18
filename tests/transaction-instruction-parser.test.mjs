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

test("transaction parser applies explicit Compute Budget ceilings to the decoded transaction", () => {
  const parsed = parseSupportedInstructionMessage({
    ...message([
      { programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000) },
      { programIdIndex: 0, accountKeyIndexes: [], data: priorityPriceData(1) }
    ]),
    computeBudgetPolicy: {
      maxComputeUnitLimit: 300000,
      maxHeapFrameBytes: 65536,
      maxLoadedAccountDataBytes: 1024 * 1024,
      maxPriorityFeeLamports: 1n
    }
  });
  assert.deepEqual(parsed.computeBudgetPolicy, {
    status: "validated",
    unitLimit: 200000,
    heapFrameBytes: null,
    loadedAccountDataBytes: null,
    priorityFeeLamports: 1n
  });
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("transaction parser rejects Compute Budget policy breaches and incomplete policy", () => {
  const instructions = [
    { programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000) },
    { programIdIndex: 0, accountKeyIndexes: [], data: priorityPriceData(1) }
  ];
  assert.throws(() => parseSupportedInstructionMessage({
    ...message(instructions),
    computeBudgetPolicy: {
      maxComputeUnitLimit: 199999,
      maxHeapFrameBytes: 65536,
      maxLoadedAccountDataBytes: 1024 * 1024,
      maxPriorityFeeLamports: 1n
    }
  }), /unit limit exceeds transaction policy/);
  assert.throws(() => parseSupportedInstructionMessage({
    ...message(instructions),
    computeBudgetPolicy: { maxComputeUnitLimit: 300000 }
  }), /policy limits are invalid or incomplete/);
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

test("transaction parser rejects unsupported classic Token variants and all Token-2022 instructions", () => {
  const classicToken = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const token2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  assert.throws(() => parseSupportedInstructionMessage(
    message([{ programIdIndex: 0, accountKeyIndexes: [], data: data(2, 200000) }], [classicToken]),
  ), /SPL Token instruction variant is unsupported/);
  const transfer = Buffer.from([3, ...Array(8).fill(0)]).toString("base64");
  assert.throws(() => parseSupportedInstructionMessage(
    message([{ programIdIndex: 0, accountKeyIndexes: [], data: transfer }],
      [token2022]),
  ), /Instruction registry rejects an unsupported program ID/);
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
  const accountKeys = [SYSTEM, SOURCE, DESTINATION];
  const parsed = parseSupportedInstructionMessage(message([{
    programIdIndex: 0,
    accountKeyIndexes: [1, 2],
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


test("parser cross-checks System Transfer signer and writable privileges when a message header is supplied", () => {
  const parsed = parseSupportedInstructionMessage({
    accountKeys: [SOURCE, SYSTEM, DESTINATION],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 0
    },
    instructions: [{
      programIdIndex: 1,
      accountKeyIndexes: [0, 2],
      data: transferData(500)
    }]
  });
  assert.equal(parsed.accountPrivilegeAnalysis, "structural-match-only");
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("parser rejects System Transfer when the source is readonly or not a signer", () => {
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: [SYSTEM, SOURCE, DESTINATION],
    header: {
      numRequiredSignatures: 2,
      numReadonlySignedAccounts: 1,
      numReadonlyUnsignedAccounts: 0
    },
    instructions: [{
      programIdIndex: 0,
      accountKeyIndexes: [1, 2],
      data: transferData(500)
    }]
  }), /privilege requirements are not satisfied/);
});

test("parser leaves System account privilege analysis explicitly absent without a message header", () => {
  const parsed = parseSupportedInstructionMessage(message([{
    programIdIndex: 0,
    accountKeyIndexes: [1, 2],
    data: transferData(10)
  }], [SYSTEM, SOURCE, DESTINATION]));
  assert.equal(parsed.accountPrivilegeAnalysis, "not-provided");
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
});


test("parser integrates analysis-only SPL Token TransferChecked and cross-checks account privileges", () => {
  const tokenData = Buffer.alloc(10);
  tokenData[0] = 12;
  tokenData.writeBigUInt64LE(250n, 1);
  tokenData[9] = 6;
  const accountKeys = [
    "ComputeBudget111111111111111111111111111111",
    DESTINATION,
    SYSTEM,
    "SysvarRent111111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  ];
  const parsed = parseSupportedInstructionMessage({
    accountKeys,
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 2
    },
    instructions: [{
      programIdIndex: 4,
      accountKeyIndexes: [1, 3, 2, 0],
      data: tokenData.toString("base64")
    }]
  });
  assert.equal(parsed.instructions[0].variant, "transferChecked");
  assert.equal(parsed.instructions[0].amount, 250n);
  assert.equal(parsed.instructions[0].decimals, 6);
  assert.equal(parsed.accountPrivilegeAnalysis, "structural-match-only");
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("parser rejects SPL Token transfer when authority is not a signer", () => {
  const tokenData = Buffer.alloc(9);
  tokenData[0] = 3;
  tokenData.writeBigUInt64LE(10n, 1);
  const accountKeys = [
    "11111111111111111111111111111112",
    DESTINATION,
    SYSTEM,
    "SysvarRent111111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  ];
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys,
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1
    },
    instructions: [{
      programIdIndex: 4,
      accountKeyIndexes: [1, 2, 3],
      data: tokenData.toString("base64")
    }]
  }), /SPL Token authority account privilege requirements are not satisfied/);
});


test("parser keeps Token-2022 fail-closed until its extension semantics are reviewed", () => {
  const token2022Program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: [token2022Program],
    instructions: [{
      programIdIndex: 0,
      accountKeyIndexes: [],
      data: Buffer.from([3, ...Array(8).fill(0)]).toString("base64")
    }]
  }), /unsupported program ID/);
});


test("parser integrates ATA CreateIdempotent and checks account privileges", () => {
  const keys = [
    "11111111111111111111111111111112",
    "11111111111111111111111111111113",
    "11111111111111111111111111111114",
    "11111111111111111111111111111115",
    SYSTEM,
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
  ];
  const parsed = parseSupportedInstructionMessage({
    accountKeys: keys,
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 5
    },
    instructions: [{
      programIdIndex: 6,
      accountKeyIndexes: [0, 1, 2, 3, 4, 5],
      data: Buffer.from([1]).toString("base64")
    }]
  });
  assert.equal(parsed.instructions[0].variant, "createIdempotent");
  assert.equal(parsed.instructions[0].tokenProgramId, keys[5]);
  assert.equal(parsed.accountPrivilegeAnalysis, "structural-match-only");
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("parser rejects ATA creation when payer is not a signer", () => {
  const keys = [
    "11111111111111111111111111111112",
    "11111111111111111111111111111113",
    "11111111111111111111111111111114",
    "11111111111111111111111111111115",
    "11111111111111111111111111111116",
    SYSTEM,
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
  ];
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: keys,
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 6
    },
    instructions: [{
      programIdIndex: 7,
      accountKeyIndexes: [1, 2, 3, 4, 5, 6],
      data: Buffer.from([0]).toString("base64")
    }]
  }), /ATA payer account privilege requirements are not satisfied/);
});


test("parser rejects ATA destination marked as a signer", () => {
  const keys = [
    "11111111111111111111111111111112",
    "11111111111111111111111111111113",
    "11111111111111111111111111111114",
    "11111111111111111111111111111115",
    SYSTEM,
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
  ];
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: keys,
    header: {
      numRequiredSignatures: 2,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 5
    },
    instructions: [{
      programIdIndex: 6,
      accountKeyIndexes: [0, 1, 2, 3, 4, 5],
      data: Buffer.from([1]).toString("base64")
    }]
  }), /ATA destination account privilege requirements are not satisfied/);
});

test("parser rejects ATA program account marked writable", () => {
  const keys = [
    "11111111111111111111111111111112",
    "11111111111111111111111111111113",
    SYSTEM,
    "11111111111111111111111111111116",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "11111111111111111111111111111114",
    "11111111111111111111111111111115",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
  ];
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: keys,
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 5
    },
    instructions: [{
      programIdIndex: 7,
      accountKeyIndexes: [0, 1, 5, 6, 2, 4],
      data: Buffer.from([1]).toString("base64")
    }]
  }), /ATA System Program account privilege requirements are not satisfied/);
});


test("parser explicitly reports ATA address derivation as not performed", () => {
  const keys = [
    "11111111111111111111111111111112",
    "11111111111111111111111111111113",
    "11111111111111111111111111111114",
    "11111111111111111111111111111115",
    SYSTEM,
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
  ];
  const parsed = parseSupportedInstructionMessage({
    accountKeys: keys,
    instructions: [{
      programIdIndex: 6,
      accountKeyIndexes: [0, 1, 2, 3, 4, 5],
      data: Buffer.from([1]).toString("base64")
    }]
  });
  assert.equal(parsed.associatedAddressVerification, "not-performed");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("parser marks ATA address verification not applicable without ATA instructions", () => {
  const parsed = parseSupportedInstructionMessage(message([{
    programIdIndex: 0,
    accountKeyIndexes: [],
    data: data(2, 200000)
  }]));
  assert.equal(parsed.associatedAddressVerification, "not-applicable");
});


test("parser accepts canonical ATA creation when payer and owner share one compiled account index", () => {
  const payer = "11111111111111111111111111111112";
  const associated = "11111111111111111111111111111113";
  const mint = "11111111111111111111111111111114";
  const ataProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const accountKeys = [payer, associated, mint, SYSTEM, tokenProgram, ataProgram];
  const parsed = parseSupportedInstructionMessage({
    accountKeys,
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 4
    },
    instructions: [{
      programIdIndex: 5,
      accountKeyIndexes: [0, 1, 0, 2, 3, 4],
      data: Buffer.from([1]).toString("base64")
    }]
  });
  assert.equal(parsed.instructions[0].payerAccountIndex, 0);
  assert.equal(parsed.instructions[0].ownerAccountIndex, 0);
  assert.equal(parsed.accountPrivilegeAnalysis, "structural-match-only");
  assert.equal(parsed.associatedAddressVerification, "not-performed");
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("parser rejects a distinct ATA owner that is marked as a signer", () => {
  const ataProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const accountKeys = [
    "11111111111111111111111111111112",
    "11111111111111111111111111111113",
    "11111111111111111111111111111114",
    "11111111111111111111111111111115",
    "11111111111111111111111111111116",
    SYSTEM,
    tokenProgram,
    ataProgram
  ];
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys,
    header: {
      numRequiredSignatures: 2,
      numReadonlySignedAccounts: 1,
      numReadonlyUnsignedAccounts: 5
    },
    instructions: [{
      programIdIndex: 7,
      accountKeyIndexes: [0, 1, 2, 3, 5, 6],
      data: Buffer.from([0]).toString("base64")
    }]
  }), /ATA owner account privilege requirements are not satisfied/);
});
