import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidSourceState,
  isUninitializedTargetState,
  isDefaultLikeSourceState,
  statesMatch
} from "../scripts/migration-safety.mjs";

const emptyWorkerState = {
  balance: 100,
  trades: [],
  autoEnabled: false,
  paused: false,
  scannedMints: [],
  deferredMints: [],
  lastScanReport: [],
  updatedAt: null
};

test("source state requires a finite nonnegative balance and a trades array", () => {
  assert.equal(isValidSourceState({ balance: 100, trades: [] }), true);
  assert.equal(isValidSourceState({ balance: 0, trades: [] }), true);
  for (const balance of [-1, "NaN", Infinity, null, undefined, true, false, ""]) {
    assert.equal(isValidSourceState({ balance, trades: [] }), false);
  }
  assert.equal(isValidSourceState({ balance: 100, trades: {} }), false);
  assert.equal(isValidSourceState(null), false);
});

test("target guard accepts only the exact pristine Worker default", () => {
  assert.equal(isUninitializedTargetState(emptyWorkerState), true);
  assert.equal(isUninitializedTargetState({ ...emptyWorkerState, balance: 99 }), false);
  assert.equal(isUninitializedTargetState({ ...emptyWorkerState, updatedAt: "2026-11-19T00:00:00.000Z" }), false);
  assert.equal(isUninitializedTargetState({ ...emptyWorkerState, autoEnabled: true }), false);
  assert.equal(isUninitializedTargetState({ ...emptyWorkerState, trades: [{ mint: "token" }] }), false);
  assert.equal(isUninitializedTargetState({ ...emptyWorkerState, scannedMints: ["token"] }), false);
  assert.equal(isUninitializedTargetState({ ...emptyWorkerState, deferredMints: ["token"] }), false);
  assert.equal(isUninitializedTargetState({ ...emptyWorkerState, lastScanReport: [{ reason: "x" }] }), false);
  assert.equal(isUninitializedTargetState(null), false);
});

test("post-import verification compares balance and exact trade history", () => {
  const source = { balance: 95.25, trades: [{ mint: "abc", sold: false }] };
  assert.equal(statesMatch(source, { balance: 95.25, trades: [{ mint: "abc", sold: false }] }), true);
  assert.equal(statesMatch(source, { balance: 95.24, trades: source.trades }), false);
  assert.equal(statesMatch(source, { balance: 95.25, trades: [] }), false);
  assert.equal(statesMatch(source, null), false);
});

test("default-like Deno state is flagged because GET cannot prove KV key existence", () => {
  assert.equal(isDefaultLikeSourceState({ balance: 100, trades: [] }), true);
  assert.equal(isDefaultLikeSourceState({ balance: "100", trades: [] }), true);
  assert.equal(isDefaultLikeSourceState({ balance: 99, trades: [] }), false);
  assert.equal(isDefaultLikeSourceState({ balance: 100, trades: [{ mint: "abc" }] }), false);
  assert.equal(isDefaultLikeSourceState(null), false);
});
