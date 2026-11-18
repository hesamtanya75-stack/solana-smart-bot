import test from "node:test";
import assert from "node:assert/strict";
import { COMPUTE_BUDGET_PROGRAM } from "../compute-budget-decoder.mjs";
import {
  parseSupportedInstructionMessage,
  parseAndVerifySupportedInstructionMessage
} from "../transaction-instruction-parser.mjs";

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

test("transaction message parser rejects unverified execution metadata and CPI evidence", () => {
  const valid = message([{
    programIdIndex: 0,
    accountKeyIndexes: [],
    data: data(2, 200000)
  }]);
  for (const field of [
    "meta",
    "innerInstructions",
    "logs",
    "preTokenBalances",
    "postTokenBalances",
    "preBalances",
    "postBalances",
    "signature",
    "signatures"
  ]) {
    assert.throws(
      () => parseSupportedInstructionMessage({ ...valid, [field]: [] }),
      /does not accept execution metadata or CPI evidence/,
      field
    );
  }
  assert.throws(
    () => parseSupportedInstructionMessage({ ...valid, meta: { innerInstructions: [] } }),
    /does not accept execution metadata or CPI evidence/
  );
  const inheritedEvidence = Object.assign(
    Object.create({ innerInstructions: [] }),
    valid
  );
  assert.throws(
    () => parseSupportedInstructionMessage(inheritedEvidence),
    /does not accept execution metadata or CPI evidence/
  );
});

test("transaction parser rejects unknown metadata fields and non-plain message records", () => {
  const valid = message([{
    programIdIndex: 0,
    accountKeyIndexes: [],
    data: data(2, 200000)
  }]);
  assert.throws(
    () => parseSupportedInstructionMessage({ ...valid, transactionMeta: { innerInstructions: [] } }),
    /unsupported field/
  );
  const symbolField = { ...valid, [Symbol("executionEvidence")]: {} };
  assert.throws(() => parseSupportedInstructionMessage(symbolField), /unsupported field/);
  assert.throws(
    () => parseSupportedInstructionMessage(Object.assign(Object.create({ inheritedExtra: true }), valid)),
    /plain data record/
  );
  let getterCalled = false;
  const accessorMessage = {};
  Object.defineProperty(accessorMessage, "accountKeys", {
    enumerable: true,
    get() {
      getterCalled = true;
      return valid.accountKeys;
    }
  });
  Object.defineProperty(accessorMessage, "instructions", {
    enumerable: true,
    value: valid.instructions
  });
  assert.throws(() => parseSupportedInstructionMessage(accessorMessage), /plain data properties/);
  assert.equal(getterCalled, false);
});

test("transaction parser rejects metadata and accessor fields nested in compiled instructions", () => {
  const validInstruction = {
    programIdIndex: 0,
    accountKeyIndexes: [],
    data: data(2, 200000)
  };
  assert.throws(
    () => parseSupportedInstructionMessage(message([{
      ...validInstruction,
      executionEvidence: { innerInstructions: [] }
    }])),
    /unsupported field/
  );
  assert.throws(
    () => parseSupportedInstructionMessage(message([{
      ...validInstruction,
      [Symbol("meta")]: {}
    }])),
    /unsupported field/
  );
  assert.throws(
    () => parseSupportedInstructionMessage(message([
      Object.assign(Object.create({ innerInstructions: [] }), validInstruction)
    ])),
    /plain data record/
  );

  let getterCalled = false;
  const accessorInstruction = {
    programIdIndex: 0,
    accountKeyIndexes: []
  };
  Object.defineProperty(accessorInstruction, "data", {
    enumerable: true,
    get() {
      getterCalled = true;
      return data(2, 200000);
    }
  });
  assert.throws(
    () => parseSupportedInstructionMessage(message([accessorInstruction])),
    /plain data properties/
  );
  assert.equal(getterCalled, false);
});

test("transaction parser rejects accessor-backed compiled account indexes without evaluating them", () => {
  let getterCalled = false;
  const indexes = [];
  indexes.length = 1;
  Object.defineProperty(indexes, "0", {
    enumerable: true,
    get() {
      getterCalled = true;
      return 0;
    }
  });
  const instruction = {
    programIdIndex: 0,
    accountKeyIndexes: indexes,
    data: data(2, 200000)
  };
  assert.throws(
    () => parseSupportedInstructionMessage(message([instruction])),
    /sparse account indexes or accessor-backed entries/
  );
  assert.equal(getterCalled, false);
});

test("transaction parser rejects custom array iterators and methods on message collections", () => {
  const validInstruction = {
    programIdIndex: 0,
    accountKeyIndexes: [],
    data: data(2, 200000)
  };
  const accountKeys = [COMPUTE_BUDGET_PROGRAM];
  Object.defineProperty(accountKeys, Symbol.iterator, {
    value() {
      throw new Error("untrusted iterator must not run");
    }
  });
  assert.throws(
    () => parseSupportedInstructionMessage(message([validInstruction], accountKeys)),
    /unsupported properties/
  );

  const instructions = [validInstruction];
  Object.defineProperty(instructions, "map", {
    value() {
      throw new Error("untrusted map must not run");
    }
  });
  assert.throws(
    () => parseSupportedInstructionMessage(message(instructions)),
    /unsupported properties/
  );
});

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

test("transaction parser rejects unsupported Classic Token and Token-2022 instruction variants", () => {
  const classicToken = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const token2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  for (const tokenProgram of [classicToken, token2022]) {
    assert.throws(() => parseSupportedInstructionMessage(
      message([{ programIdIndex: 0, accountKeyIndexes: [], data: data(99, 0) }],
        [tokenProgram]),
    ), /SPL Token instruction variant is unsupported/);
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
    accountKeys: [SOURCE, DESTINATION, SYSTEM],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1
    },
    instructions: [{
      programIdIndex: 2,
      accountKeyIndexes: [0, 1],
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


test("parser decodes bounded Token-2022 TransferChecked but never grants semantic trust", () => {
  const token2022Program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const authority = "11111111111111111111111111111112";
  const source = "11111111111111111111111111111113";
  const destination = "11111111111111111111111111111114";
  const mint = "11111111111111111111111111111115";
  const tokenData = Buffer.alloc(10);
  tokenData[0] = 12;
  tokenData.writeBigUInt64LE(250n, 1);
  tokenData[9] = 6;
  const parsed = parseSupportedInstructionMessage({
    accountKeys: [authority, source, destination, mint, token2022Program],
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
  assert.equal(parsed.instructions[0].programId, token2022Program);
  assert.equal(parsed.instructions[0].variant, "transferChecked");
  assert.equal(parsed.instructions[0].amount, 250n);
  assert.equal(parsed.instructions[0].decimals, 6);
  assert.equal(parsed.accountPrivilegeAnalysis, "structural-match-only");
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
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
    "11111111111111111111111111111114",
    "11111111111111111111111111111113",
    "11111111111111111111111111111115",
    SYSTEM,
    tokenProgram,
    ataProgram
  ];
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys,
    header: {
      numRequiredSignatures: 2,
      numReadonlySignedAccounts: 1,
      numReadonlyUnsignedAccounts: 4
    },
    instructions: [{
      programIdIndex: 6,
      accountKeyIndexes: [0, 2, 1, 3, 4, 5],
      data: Buffer.from([0]).toString("base64")
    }]
  }), /ATA owner account privilege requirements are not satisfied/);
});


test("parser rejects an instruction program account marked writable", () => {
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const ataProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  const accountKeys = [
    "11111111111111111111111111111112",
    ataProgram,
    "11111111111111111111111111111113",
    "11111111111111111111111111111114",
    "11111111111111111111111111111115",
    SYSTEM,
    tokenProgram
  ];
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys,
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 4
    },
    instructions: [{
      programIdIndex: 1,
      accountKeyIndexes: [0, 2, 3, 4, 5, 6],
      data: Buffer.from([1]).toString("base64")
    }]
  }), /Instruction program account privilege requirements are not satisfied/);
});

test("parser rejects an instruction program account marked as a signer", () => {
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const ataProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  const accountKeys = [
    "11111111111111111111111111111112",
    ataProgram,
    "11111111111111111111111111111113",
    "11111111111111111111111111111114",
    "11111111111111111111111111111115",
    SYSTEM,
    tokenProgram
  ];
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys,
    header: {
      numRequiredSignatures: 2,
      numReadonlySignedAccounts: 1,
      numReadonlyUnsignedAccounts: 4
    },
    instructions: [{
      programIdIndex: 1,
      accountKeyIndexes: [0, 2, 3, 4, 5, 6],
      data: Buffer.from([1]).toString("base64")
    }]
  }), /Instruction program account privilege requirements are not satisfied/);
});


test("parser validates complete v0 account ordering before checking loaded writable privileges", () => {
  const staticAccountKeys = [SOURCE, SYSTEM];
  const resolvedAddressTableLookups = [{
    writableAddresses: [DESTINATION],
    readonlyAddresses: [COMPUTE_BUDGET_PROGRAM]
  }];
  const parsed = parseSupportedInstructionMessage({
    staticAccountKeys,
    accountKeys: [...staticAccountKeys, DESTINATION, COMPUTE_BUDGET_PROGRAM],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1
    },
    resolvedAddressTableLookups,
    instructions: [{
      programIdIndex: 1,
      accountKeyIndexes: [0, 2],
      data: transferData(25)
    }]
  });
  assert.equal(parsed.accountPrivilegeAnalysis, "structural-match-only");
  assert.equal(parsed.instructions[0].lamports, 25n);
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("parser rejects v0 lookup inputs without explicit static keys", () => {
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: [SYSTEM, SOURCE, DESTINATION],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1
    },
    resolvedAddressTableLookups: [{
      writableAddresses: [DESTINATION],
      readonlyAddresses: []
    }],
    instructions: [{
      programIdIndex: 0,
      accountKeyIndexes: [1, 2],
      data: transferData(25)
    }]
  }), /must provide staticAccountKeys separately/);
});

test("parser rejects v0 account keys that disagree with canonical static and lookup ordering", () => {
  assert.throws(() => parseSupportedInstructionMessage({
    staticAccountKeys: [SOURCE, SYSTEM],
    accountKeys: [SOURCE, SYSTEM, COMPUTE_BUDGET_PROGRAM],
    header: {
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1
    },
    resolvedAddressTableLookups: [{
      writableAddresses: [DESTINATION],
      readonlyAddresses: [COMPUTE_BUDGET_PROGRAM]
    }],
    instructions: [{
      programIdIndex: 1,
      accountKeyIndexes: [0, 2],
      data: transferData(25)
    }]
  }), /do not match static and lookup account ordering/);
});


const PDA_OWNER = "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY";
const PDA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PDA_CLASSIC_ATA = "3EjekkZPxiKdDB91mdJjUcjFjRmyWjP1Y4ySvfwSaQ4b";
const PDA_TOKEN_2022_ATA = "J1AgP9czKVx1tHY2TrQxMd73tguFUE7rVYynxEWsq8nr";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function ataMessageWithAddress(associatedAddress, tokenProgram = CLASSIC_TOKEN_PROGRAM) {
  const payer = "11111111111111111111111111111112";
  const system = "11111111111111111111111111111111";
  const accountKeys = [
    payer,
    associatedAddress,
    PDA_OWNER,
    PDA_MINT,
    system,
    tokenProgram,
    ATA_PROGRAM
  ];
  return {
    accountKeys,
    instructions: [{
      programIdIndex: 6,
      accountKeyIndexes: [0, 1, 2, 3, 4, 5],
      data: Buffer.from([1]).toString("base64")
    }]
  };
}

test("async parser integrates a successful ATA PDA-only verification without granting semantic trust", async () => {
  const parsed = await parseAndVerifySupportedInstructionMessage(
    ataMessageWithAddress(PDA_CLASSIC_ATA)
  );
  assert.equal(parsed.associatedAddressVerification, "pda-verified");
  assert.equal(parsed.associatedAddressPdaChecks.length, 1);
  assert.equal(parsed.associatedAddressPdaChecks[0].verified, true);
  assert.equal(parsed.associatedAddressPdaChecks[0].scope, "pda-only");
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.associatedAddressPdaChecks));
});

test("async parser verifies Token-2022 ATA PDA end-to-end without granting semantic trust", async () => {
  const parsed = await parseAndVerifySupportedInstructionMessage(
    ataMessageWithAddress(PDA_TOKEN_2022_ATA, TOKEN_2022_PROGRAM)
  );
  assert.equal(parsed.associatedAddressVerification, "pda-verified");
  assert.equal(parsed.associatedAddressPdaChecks.length, 1);
  assert.equal(parsed.associatedAddressPdaChecks[0].verified, true);
  assert.equal(parsed.associatedAddressPdaChecks[0].tokenProgramId, TOKEN_2022_PROGRAM);
  assert.equal(parsed.associatedAddressPdaChecks[0].bump, 254);
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("async parser reports an ATA PDA mismatch and never promotes it to approval", async () => {
  const parsed = await parseAndVerifySupportedInstructionMessage(
    ataMessageWithAddress("11111111111111111111111111111113")
  );
  assert.equal(parsed.associatedAddressVerification, "pda-mismatch");
  assert.equal(parsed.associatedAddressPdaChecks[0].verified, false);
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("async parser marks ATA PDA verification not applicable when no ATA instruction exists", async () => {
  const parsed = await parseAndVerifySupportedInstructionMessage(message([{
    programIdIndex: 0,
    accountKeyIndexes: [],
    data: data(2, 200000)
  }]));
  assert.equal(parsed.associatedAddressVerification, "not-applicable");
  assert.deepEqual(parsed.associatedAddressPdaChecks, []);
  assert.equal(parsed.semanticVerification, "incomplete");
  assert.equal(parsed.signingPermitted, false);
});


test("parser rejects static keys or lookup resolutions without a message header", () => {
  const base = {
    accountKeys: [SYSTEM, SOURCE, DESTINATION],
    instructions: [{
      programIdIndex: 0,
      accountKeyIndexes: [1, 2],
      data: transferData(25)
    }]
  };
  assert.throws(() => parseSupportedInstructionMessage({
    ...base,
    staticAccountKeys: [SYSTEM, SOURCE, DESTINATION]
  }), /Message account-role metadata requires a message header/);
  assert.throws(() => parseSupportedInstructionMessage({
    ...base,
    resolvedAddressTableLookups: []
  }), /Message account-role metadata requires a message header/);
  assert.throws(() => parseSupportedInstructionMessage({
    ...base,
    staticAccountKeys: [SYSTEM, SOURCE],
    resolvedAddressTableLookups: [{ writableAddresses: [DESTINATION], readonlyAddresses: [] }]
  }), /Message account-role metadata requires a message header/);
});

test("transaction parser rejects an unreviewed program even when its data mimics Compute Budget", () => {
  const unknownProgram = "11111111111111111111111111111111";
  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: [unknownProgram],
    instructions: [{
      programIdIndex: 0,
      accountKeyIndexes: [],
      data: data(2, 200000)
    }]
  }), /Instruction registry rejects an unsupported program ID/);
});
