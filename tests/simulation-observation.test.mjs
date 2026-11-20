import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSimulationObservation } from "../simulation-observation.mjs";

const digest = "a".repeat(64);

function simulation(innerInstructions = []) {
  return {
    context: { slot: 1234 },
    value: undefined,
    meta: { err: null, innerInstructions }
  };
}

test("simulation observation records bounded CPI indexes without granting approval", () => {
  const result = normalizeSimulationObservation({
    messageDigest: digest,
    simulationResult: simulation([
      { index: 1, instructions: [
        { programIdIndex: 4 },
        { programIdIndex: 2 }
      ] },
      { index: 0, instructions: [{ programIdIndex: 3 }] }
    ]),
    topLevelInstructionCount: 2,
    accountKeyCount: 5
  });
  assert.equal(result.scope, "simulation-observation-only");
  assert.equal(result.messageDigest, digest);
  assert.equal(result.contextSlot, 1234);
  assert.equal(result.simulationSucceeded, true);
  assert.equal(result.innerInstructionCount, 3);
  assert.deepEqual(result.groups.map(group => group.topLevelInstructionIndex), [0, 1]);
  assert.equal(result.cpiProgramIdsVerified, false);
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.tokenBalanceEffectsVerified, false);
  assert.equal(result.signingPermitted, false);
  assert.equal(result.submissionPermitted, false);
});

test("simulation observation preserves failed simulation as diagnostic failure", () => {
  const result = normalizeSimulationObservation({
    messageDigest: digest,
    simulationResult: {
      context: { slot: 1235 },
      meta: { err: { InstructionError: [0, "Custom"] }, innerInstructions: [] }
    },
    topLevelInstructionCount: 1,
    accountKeyCount: 1
  });
  assert.equal(result.simulationSucceeded, false);
  assert.equal(result.simulationErrorPresent, true);
});

test("simulation observation rejects malformed, duplicate, and out-of-range CPI indexes", () => {
  const base = {
    messageDigest: digest,
    topLevelInstructionCount: 1,
    accountKeyCount: 2
  };
  assert.throws(() => normalizeSimulationObservation({
    ...base,
    simulationResult: simulation([{ index: 1, instructions: [] }])
  }), /group index is invalid/);
  assert.throws(() => normalizeSimulationObservation({
    ...base,
    simulationResult: simulation([
      { index: 0, instructions: [] },
      { index: 0, instructions: [] }
    ])
  }), /duplicate inner instruction groups/);
  assert.throws(() => normalizeSimulationObservation({
    ...base,
    simulationResult: simulation([
      { index: 0, instructions: [{ programIdIndex: 2 }] }
    ])
  }), /program index is invalid/);
  assert.throws(() => normalizeSimulationObservation({
    ...base,
    simulationResult: simulation()
  }), /innerInstructions/);
});

test("simulation observation rejects accessor-backed metadata without invoking getters", () => {
  let invoked = false;
  const meta = { err: null, innerInstructions: [] };
  Object.defineProperty(meta, "innerInstructions", {
    get() { invoked = true; return []; },
    enumerable: true
  });
  assert.throws(() => normalizeSimulationObservation({
    messageDigest: digest,
    simulationResult: { context: { slot: 1 }, meta },
    topLevelInstructionCount: 1,
    accountKeyCount: 1
  }), /accessor-backed/);
  assert.equal(invoked, false);
});
