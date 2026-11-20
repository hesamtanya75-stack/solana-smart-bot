import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSimulationBalanceObservation } from "../simulation-balance-observation.mjs";

const MINT = "So11111111111111111111111111111111111111112";
const OWNER = "11111111111111111111111111111111";
const PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function fixture() {
  return {
    context: { slot: 123 },
    value: {
      err: null,
      preBalances: [1000, 2000],
      postBalances: [900, 2100],
      preTokenBalances: [{
        accountIndex: 1, mint: MINT, owner: OWNER, programId: PROGRAM,
        uiTokenAmount: { amount: "100", decimals: 9 }
      }],
      postTokenBalances: [{
        accountIndex: 1, mint: MINT, owner: OWNER, programId: PROGRAM,
        uiTokenAmount: { amount: "125", decimals: 9 }
      }]
    }
  };
}

test("normalizes SOL lamport and paired token deltas as diagnostic BigInts", () => {
  const result = normalizeSimulationBalanceObservation({
    simulationResult: fixture(), accountKeyCount: 2
  });
  assert.equal(result.solLamportDeltas[0].deltaLamports, -100n);
  assert.equal(result.tokenDeltas[0].delta, 25n);
  assert.equal(result.tokenDeltas[0].status, "paired-diagnostic-only");
  assert.equal(result.tokenBalanceEffectsVerified, false);
  assert.equal(result.signingPermitted, false);
  assert.equal(result.submissionPermitted, false);
});

test("does not infer zero for a token account missing on one side", () => {
  const data = fixture();
  data.value.preTokenBalances = [];
  const result = normalizeSimulationBalanceObservation({
    simulationResult: data, accountKeyCount: 2
  });
  assert.equal(result.tokenDeltas[0].status, "unpaired-account-state");
  assert.equal(result.tokenDeltas[0].delta, null);
  assert.equal(result.tokenRecordsUnpaired, true);
});

test("rejects sparse or mismatched SOL arrays", () => {
  const data = fixture();
  data.value.preBalances = [1000, , 2000];
  assert.throws(() => normalizeSimulationBalanceObservation({
    simulationResult: data, accountKeyCount: 2
  }), /sparse|match/);
});

test("rejects duplicate token account identities", () => {
  const data = fixture();
  data.value.preTokenBalances.push(data.value.preTokenBalances[0]);
  assert.throws(() => normalizeSimulationBalanceObservation({
    simulationResult: data, accountKeyCount: 2
  }), /duplicate/);
});

test("rejects malformed amounts, indexes and decimals", () => {
  for (const patch of [
    record => { record.uiTokenAmount.amount = "01"; },
    record => { record.accountIndex = 2; },
    record => { record.uiTokenAmount.decimals = -1; }
  ]) {
    const data = fixture();
    patch(data.value.preTokenBalances[0]);
    assert.throws(() => normalizeSimulationBalanceObservation({
      simulationResult: data, accountKeyCount: 2
    }));
  }
});

test("rejects accessor-backed simulation values without invoking getters", () => {
  const data = fixture();
  let calls = 0;
  Object.defineProperty(data.value, "preBalances", {
    enumerable: true, get() { calls++; return [1000, 2000]; }
  });
  assert.throws(() => normalizeSimulationBalanceObservation({
    simulationResult: data, accountKeyCount: 2
  }), /accessor-backed/);
  assert.equal(calls, 0);
});

test("rejects mismatched account-key count and unsafe lamport values", () => {
  const data = fixture();
  data.value.postBalances[0] = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => normalizeSimulationBalanceObservation({
    simulationResult: data, accountKeyCount: 2
  }), /safe integer/);
});

test("rejects a simulation value with no explicit err field", () => {
  const data = fixture();
  delete data.value.err;
  assert.throws(() => normalizeSimulationBalanceObservation({
    simulationResult: data, accountKeyCount: 2
  }), /required err field/);
});
