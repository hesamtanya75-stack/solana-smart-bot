import test from "node:test";
import assert from "node:assert/strict";
import { validateSimulatedCpi } from "../solana-instruction-policy.mjs";

const signer = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const account = "11111111111111111111111111111112";
const program = "11111111111111111111111111111111";
const unknownProgram = "11111111111111111111111111111113";

function fixture() {
  return {
    instructions: [{ programId: program, accounts: [signer, account] }],
    accountKeys: [signer, account, program, unknownProgram]
  };
}

function args(overrides = {}) {
  return {
    decoded: fixture(),
    simulationMeta: {
      err: null,
      innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 2, accounts: [0, 1], data: "" }]
      }]
    },
    allowedCpiProgramIds: [program],
    allowedCpiAccountKeys: [signer, account],
    expectedOuterInstructionIndexes: [0],
    ...overrides
  };
}

test("CPI validator accepts only explicitly allow-listed simulated inner calls", () => {
  const result = validateSimulatedCpi(args());
  assert.equal(result.allowed, true);
  assert.equal(result.instructionCount, 1);
  assert.deepEqual(result.programIds, [program]);
});

test("CPI validator fails closed when simulation trace is absent or failed", () => {
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: { err: null, innerInstructions: null }
  })), /explicit inner-instruction trace/);
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: { err: { InstructionError: [0, "Custom"] }, innerInstructions: [] }
  })), /explicit inner-instruction trace/);
});

test("CPI validator rejects unknown programs and accounts", () => {
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: {
      err: null,
      innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 3, accounts: [0, 1] }]
      }]
    }
  })), /unapproved CPI program/);
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: {
      err: null,
      innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 2, accounts: [0, 3] }]
      }]
    }
  })), /unapproved account/);
});

test("CPI validator rejects malformed group and out-of-range account indexes", () => {
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: { err: null, innerInstructions: [{ index: 9, instructions: [] }] }
  })), /malformed or unexpected CPI instruction group/);
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: {
      err: null,
      innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 2, accounts: [99] }]
      }]
    }
  })), /invalid account index/);
});

test("CPI validator binds trace groups exactly to expected outer instruction indexes", () => {
  const valid = args();
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: {
      err: null,
      innerInstructions: [{ index: 1, instructions: [{ programIdIndex: 2, accounts: [0, 1] }] }]
    }
  })), /malformed or unexpected CPI instruction group/);
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: {
      err: null,
      innerInstructions: [
        { index: 0, instructions: [{ programIdIndex: 2, accounts: [0, 1] }] },
        { index: 0, instructions: [{ programIdIndex: 2, accounts: [0, 1] }] }
      ]
    }
  })), /malformed or unexpected CPI instruction group/);
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: { err: null, innerInstructions: [] }
  })), /missing an expected outer instruction group/);
  assert.throws(() => validateSimulatedCpi(args({
    simulationMeta: { err: null, innerInstructions: [{ index: 0, instructions: [] }] }
  })), /malformed or unexpected CPI instruction group/);
  assert.equal(validateSimulatedCpi(valid).allowed, true);
});
