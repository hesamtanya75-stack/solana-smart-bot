import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizeSimulationObservation, normalizeSimulationObservationForMessage } from "../simulation-observation.mjs";

const digest = "a".repeat(64);

function simulation(innerInstructions = []) {
  return {
    context: { slot: 1234 },
    value: { err: null, innerInstructions }
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
      value: { err: { InstructionError: [0, "Custom"] }, innerInstructions: [] }
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
    simulationResult: { context: { slot: 1234 }, value: { err: null } }
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
    simulationResult: { context: { slot: 1 }, value: meta },
    topLevelInstructionCount: 1,
    accountKeyCount: 1
  }), /accessor-backed/);
  assert.equal(invoked, false);
});


test("message-bound observation derives SHA-256 from an immutable byte snapshot", async () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const result = await normalizeSimulationObservationForMessage({
    serializedMessage: bytes,
    simulationResult: simulation([]),
    topLevelInstructionCount: 1,
    accountKeyCount: 1
  });
  assert.equal(result.messageDigest, expected);
  assert.equal(result.messageDigestSource, "sha256-of-supplied-serialized-message");
  assert.equal(result.simulationInputIdentityVerified, false);
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.signingPermitted, false);
  assert.equal(result.submissionPermitted, false);
  assert.ok(Object.isFrozen(result));
});

test("message-bound observation digest changes with serialized message bytes", async () => {
  const common = {
    simulationResult: simulation([]),
    topLevelInstructionCount: 1,
    accountKeyCount: 1
  };
  const first = await normalizeSimulationObservationForMessage({
    ...common, serializedMessage: Uint8Array.from([1, 2, 3])
  });
  const second = await normalizeSimulationObservationForMessage({
    ...common, serializedMessage: Uint8Array.from([1, 2, 4])
  });
  assert.notEqual(first.messageDigest, second.messageDigest);
});

test("message-bound observation rejects malformed or oversized serialized messages", async () => {
  const common = {
    simulationResult: simulation([]),
    topLevelInstructionCount: 1,
    accountKeyCount: 1
  };
  await assert.rejects(() => normalizeSimulationObservationForMessage({
    ...common, serializedMessage: new Uint8Array()
  }), /bounded Uint8Array/);
  await assert.rejects(() => normalizeSimulationObservationForMessage({
    ...common, serializedMessage: new Uint8Array(1233)
  }), /bounded Uint8Array/);
  await assert.rejects(() => normalizeSimulationObservationForMessage({
    ...common, serializedMessage: [1, 2, 3]
  }), /bounded Uint8Array/);
  const subclass = new (class extends Uint8Array {})([1, 2, 3]);
  await assert.rejects(() => normalizeSimulationObservationForMessage({
    ...common, serializedMessage: subclass
  }), /bounded Uint8Array/);
});


test("simulation observation records bounded CPI account indexes without resolving or trusting keys", () => {
  const result = normalizeSimulationObservation({
    messageDigest: digest,
    simulationResult: simulation([{
      index: 0,
      instructions: [{ programIdIndex: 2, accounts: [0, 1, 3] }]
    }]),
    topLevelInstructionCount: 1,
    accountKeyCount: 4
  });
  assert.deepEqual(result.groups[0].instructions[0].accountIndexes, [0, 1, 3]);
  assert.equal(result.cpiProgramIdsVerified, false);
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.signingPermitted, false);
  assert.equal(result.submissionPermitted, false);
});

test("simulation observation rejects malformed or out-of-range CPI account indexes", () => {
  const base = {
    messageDigest: digest,
    topLevelInstructionCount: 1,
    accountKeyCount: 3
  };
  assert.throws(() => normalizeSimulationObservation({
    ...base,
    simulationResult: simulation([{
      index: 0,
      instructions: [{ programIdIndex: 1, accounts: [0, 3] }]
    }])
  }), /account index is invalid/);
  assert.throws(() => normalizeSimulationObservation({
    ...base,
    simulationResult: simulation([{
      index: 0,
      instructions: [{ programIdIndex: 1, accounts: [0, , 2] }]
    }])
  }), /sparse or extended/);
});


test("simulation observation rejects unknown and accessor-backed CPI fields", () => {
  const base = { messageDigest: digest, topLevelInstructionCount: 1, accountKeyCount: 2 };
  const unknown = simulation([{ index: 0, instructions: [{ programIdIndex: 1, accounts: [0], invented: true }] }]);
  assert.throws(() => normalizeSimulationObservation({ ...base, simulationResult: unknown }), /unsupported properties/);
  const accessorInstruction = { programIdIndex: 1, accounts: [0] };
  Object.defineProperty(accessorInstruction, "stackHeight", { enumerable: true, get() { throw new Error("getter invoked"); } });
  assert.throws(() => normalizeSimulationObservation({
    ...base,
    simulationResult: simulation([{ index: 0, instructions: [accessorInstruction] }])
  }), /accessor-backed properties/);
});

test("simulation observation accepts bounded RPC stack height and data fields", () => {
  const result = normalizeSimulationObservation({
    messageDigest: digest,
    simulationResult: simulation([{ index: 0, instructions: [{
      programIdIndex: 1, accounts: [0], data: "AQID", stackHeight: 2
    }] }]),
    topLevelInstructionCount: 1,
    accountKeyCount: 2
  });
  assert.deepEqual(result.groups[0].instructions[0].accountIndexes, [0]);
  assert.equal(result.groups[0].instructions[0].data, "AQID");
  assert.equal(result.groups[0].instructions[0].stackHeight, 2);
  assert.equal(result.semanticInstructionVerification, false);
});


test("simulation observation rejects non-canonical CPI base64 payloads", () => {
  assert.throws(() => normalizeSimulationObservation({
    messageDigest: digest,
    simulationResult: simulation([{ index: 0, instructions: [{ programIdIndex: 1, data: "AQI" }] }]),
    topLevelInstructionCount: 1,
    accountKeyCount: 2
  }), /data is malformed/);
});


test("simulation observation rejects non-zero unused base64 padding bits", () => {
  const base = { messageDigest: digest, topLevelInstructionCount: 1, accountKeyCount: 2 };
  assert.throws(() => normalizeSimulationObservation({
    ...base,
    simulationResult: simulation([{ index: 0, instructions: [{ programIdIndex: 1, data: "AQJ=" }] }])
  }), /data is malformed/);
  assert.throws(() => normalizeSimulationObservation({
    ...base,
    simulationResult: simulation([{ index: 0, instructions: [{ programIdIndex: 1, data: "AR==" }] }])
  }), /data is malformed/);
});
