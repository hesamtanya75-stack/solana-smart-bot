import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidSourceState,
  isCompatibleWithWorkerState,
  isUninitializedTargetState,
  isDefaultLikeSourceState,
  statesMatch,
  normalizeLegacySourceState
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
  for (const balance of [-1, "100", "NaN", Infinity, null, undefined, true, false, ""]) {
    assert.equal(isValidSourceState({ balance, trades: [] }), false);
  }
  assert.equal(isValidSourceState({ balance: 100, trades: {} }), false);
  assert.equal(isValidSourceState(null), false);
});

test("legacy Deno payload is expanded to the complete strict Durable Object schema", () => {
  const legacy = {
    balance: 87.25,
    trades: [{ mint: "legacy-token", amount: 5 }],
    updatedAt: "2026-11-18T10:00:00.000Z"
  };
  const normalized = normalizeLegacySourceState(legacy);
  assert.deepEqual(normalized, {
    balance: 87.25,
    trades: legacy.trades,
    updatedAt: legacy.updatedAt,
    autoEnabled: false,
    paused: false,
    scannedMints: [],
    deferredMints: [],
    lastRunAt: null,
    lastMessage: "بۆتی سێرڤەر ئامادەیە؛ کڕینی خۆکار ناچالاکە.",
    lastScanReport: []
  });
  assert.equal(isCompatibleWithWorkerState(normalized), true);
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

test("legacy Deno state with only balance, trades, and updatedAt is import-compatible", () => {
  assert.equal(isCompatibleWithWorkerState({
    balance: 94.5, trades: [{ mint: "legacy-token" }], updatedAt: "2026-11-18T10:00:00.000Z"
  }), true);
  assert.equal(isCompatibleWithWorkerState({ balance: 100, trades: [], updatedAt: null }), true);
});

test("migration preflight rejects fields and metadata the Durable Object cannot import", () => {
  const compatible = {
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  };
  assert.equal(isCompatibleWithWorkerState(compatible), true);
  assert.equal(isCompatibleWithWorkerState({ ...compatible, walletPrivateKey: "secret" }), false);
  assert.equal(isCompatibleWithWorkerState({ ...compatible, autoEnabled: "false" }), false);
  assert.equal(isCompatibleWithWorkerState({ ...compatible, paused: 0 }), false);
  assert.equal(isCompatibleWithWorkerState({ ...compatible, lastRunAt: 123 }), false);
  assert.equal(isCompatibleWithWorkerState({ ...compatible, scannedMints: "invalid" }), false);
  const { lastRunAt, ...withoutOptionalWorkerMetadata } = compatible;
  assert.equal(isCompatibleWithWorkerState(withoutOptionalWorkerMetadata), true);
});

test("post-import verification compares balance and exact trade history", () => {
  const source = { balance: 95.25, trades: [{ mint: "abc", sold: false }] };
  assert.equal(statesMatch(source, { balance: 95.25, trades: [{ mint: "abc", sold: false }] }), true);
  assert.equal(statesMatch(source, { balance: 95.24, trades: source.trades }), false);
  assert.equal(statesMatch(source, { balance: 95.25, trades: [] }), false);
  assert.equal(statesMatch(source, null), false);
});

test("post-import verification detects missing normalized Worker defaults", () => {
  const legacy = {
    balance: 92.5,
    trades: [{ mint: "legacy-token" }],
    updatedAt: "2026-11-18T10:00:00.000Z"
  };
  const expected = normalizeLegacySourceState(legacy);
  assert.equal(statesMatch(expected, { ...expected, updatedAt: "2026-11-19T00:00:00.000Z" }), true);
  const { lastMessage, ...missingDefault } = expected;
  assert.equal(statesMatch(expected, { ...missingDefault, updatedAt: "2026-11-19T00:00:00.000Z" }), false);
  assert.equal(statesMatch(expected, { ...expected, paused: true }), false);
});

test("default-like Deno state is flagged because GET cannot prove KV key existence", () => {
  assert.equal(isDefaultLikeSourceState({ balance: 100, trades: [] }), true);
  assert.equal(isDefaultLikeSourceState({ balance: "100", trades: [] }), true);
  assert.equal(isDefaultLikeSourceState({ balance: 99, trades: [] }), false);
  assert.equal(isDefaultLikeSourceState({ balance: 100, trades: [{ mint: "abc" }] }), false);
  assert.equal(isDefaultLikeSourceState(null), false);
});

test("migration rejects source arrays that the Worker would truncate or normalize", () => {
  const valid = {
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  };
  assert.equal(isCompatibleWithWorkerState(valid), true);
  assert.equal(isCompatibleWithWorkerState({ ...valid, trades: Array(500).fill({ mint: "legacy-token", amount: 5 }) }), true);
  assert.equal(isCompatibleWithWorkerState({ ...valid, trades: Array(501).fill({}) }), false);
  assert.equal(isCompatibleWithWorkerState({ ...valid, scannedMints: Array(1000).fill("x") }), true);
  assert.equal(isCompatibleWithWorkerState({ ...valid, scannedMints: Array(1001).fill("x") }), false);
  assert.equal(isCompatibleWithWorkerState({ ...valid, deferredMints: Array(1001).fill("x") }), false);
  assert.equal(isCompatibleWithWorkerState({ ...valid, lastScanReport: Array(21).fill({}) }), false);
  assert.equal(isCompatibleWithWorkerState({ ...valid, scannedMints: "invalid" }), false);
});

test("migration preflight rejects payloads larger than the Worker storage limit", () => {
  const oversized = {
    balance: 100,
    trades: [{ mint: "legacy-token", note: "x".repeat(1_000_001) }]
  };
  assert.equal(isCompatibleWithWorkerState(oversized), false);
});

test("post-import verification compares every source field except server timestamp", () => {
  const source = { balance: 95, trades: [{ mint: "abc" }], autoEnabled: false, customSetting: "kept" };
  assert.equal(statesMatch(source, { ...source, balance: 95, updatedAt: "2026-11-19T00:00:00.000Z" }), true);
  assert.equal(statesMatch(source, { ...source, customSetting: "lost" }), false);
  assert.equal(statesMatch(source, { ...source, trades: [] }), false);
});

test("migration preflight preserves legacy trades but rejects malformed entries", () => {
  const base = { balance: 90, trades: [{ mint: "legacy-token", amount: 5 }] };
  assert.equal(isCompatibleWithWorkerState(base), true);
  assert.equal(isCompatibleWithWorkerState({
    ...base, trades: [{ mint: "token", buyPrice: "1", tokens: 2 }]
  }), false);
  assert.equal(isCompatibleWithWorkerState({
    ...base, trades: [{ mint: "token", buyPrice: 1, tokens: -1 }]
  }), false);
  assert.equal(isCompatibleWithWorkerState({
    ...base, trades: [{ mint: "x".repeat(65) }]
  }), false);
  assert.equal(isCompatibleWithWorkerState({
    ...base, lastMessage: "x".repeat(2001)
  }), false);
  assert.equal(isCompatibleWithWorkerState({
    ...base, deferredMints: [{ mint: "token", retryAt: "later" }]
  }), false);
  assert.equal(isCompatibleWithWorkerState({
    ...base, lastScanReport: [{
      mint: "token", status: "blocked", reasons: ["x".repeat(501)]
    }]
  }), false);
});
