import test from "node:test";
import assert from "node:assert/strict";
import { PaperStateCoordinator } from "../paper-state-coordinator.js";

class MemoryStorage {
  values = new Map();
  tail = Promise.resolve();
  async transaction(callback) {
    let release;
    const previous = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    const tx = {
      get: async key => this.values.get(key),
      put: async (key, value) => { this.values.set(key, structuredClone(value)); }
    };
    try { return await callback(tx); }
    finally { release(); }
  }
}
function fixture() {
  const storage = new MemoryStorage();
  return { storage, coordinator: new PaperStateCoordinator({ storage }) };
}
const initial = {
  balance: 100, trades: [], autoEnabled: false, paused: false,
  scannedMints: [], deferredMints: [], lastRunAt: null,
  lastMessage: "ready", lastScanReport: [], updatedAt: null
};

test("snapshot remains uninitialized until an explicit import", async () => {
  const { coordinator, storage } = fixture();
  assert.deepEqual(await coordinator.snapshot(), { initialized: false, state: null, version: 0 });
  assert.equal(storage.values.size, 0);
});

test("two concurrent commits from one version: exactly one wins", async () => {
  const { coordinator } = fixture();
  await coordinator.importOnce(initial);
  const results = await Promise.allSettled([
    coordinator.commit(1, { ...initial, balance: 90 }),
    coordinator.commit(1, { ...initial, balance: 80 })
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal((await coordinator.snapshot()).version, 2);
  assert.ok([90, 80].includes((await coordinator.snapshot()).state.balance));
});

test("concurrent patches preserve both independent changes", async () => {
  const { coordinator } = fixture();
  await coordinator.importOnce(initial);
  const results = await Promise.all([
    coordinator.patch({ autoEnabled: true }),
    coordinator.patch({ paused: true })
  ]);
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.state.autoEnabled, true);
  assert.equal(snapshot.state.paused, true);
  assert.ok(results.every(result => result.ok));
});

test("stale Cron commit cannot overwrite a newer dashboard patch", async () => {
  const { coordinator } = fixture();
  await coordinator.importOnce(initial);
  const stale = { ...initial, balance: 95 };
  await coordinator.patch({ paused: true });
  await assert.rejects(() => coordinator.commit(1, stale), /Version conflict/);
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.state.balance, 100);
  assert.equal(snapshot.state.paused, true);
});

test("import is once-only and never overwrites existing state", async () => {
  const { coordinator } = fixture();
  await coordinator.importOnce(initial);
  await assert.rejects(() => coordinator.importOnce({ ...initial, balance: 1 }), /Already initialized/);
  assert.equal((await coordinator.snapshot()).state.balance, 100);
  assert.equal((await coordinator.status()).imported, true);
});

test("concurrent imports cannot replace each other", async () => {
  const { coordinator } = fixture();
  const results = await Promise.allSettled([
    coordinator.importOnce({ ...initial, balance: 70 }),
    coordinator.importOnce({ ...initial, balance: 60 })
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
});

test("invalid and oversized state is rejected without writing", async () => {
  const { coordinator, storage } = fixture();
  await assert.rejects(() => coordinator.importOnce({ ...initial, trades: Array(501).fill({}) }), /Invalid or oversized trades/);
  assert.equal(storage.values.size, 0);
  await assert.rejects(() => coordinator.importOnce({ ...initial, balance: -1 }), /Invalid balance/);
  assert.equal(storage.values.size, 0);
});

test("patch rejects attempts to alter version or import metadata", async () => {
  const { coordinator } = fixture();
  await coordinator.importOnce(initial);
  await assert.rejects(() => coordinator.patch({ version: 999 }), /unsupported fields/);
  assert.equal((await coordinator.snapshot()).version, 1);
});


test("import rejects unknown fields instead of silently persisting them", async () => {
  const { coordinator, storage } = fixture();
  await assert.rejects(
    () => coordinator.importOnce({ ...initial, walletPrivateKey: "must-not-be-stored" }),
    /unsupported fields/
  );
  assert.equal(storage.values.size, 0);
});

test("state validation rejects coercible balances and malformed metadata", async () => {
  const { coordinator, storage } = fixture();
  await assert.rejects(() => coordinator.importOnce({ ...initial, balance: "100" }), /Invalid balance/);
  await assert.rejects(() => coordinator.importOnce({ ...initial, lastRunAt: 123 }), /Invalid lastRunAt/);
  await assert.rejects(() => coordinator.importOnce({ ...initial, autoEnabled: 1 }), /Invalid automation flags/);
  assert.equal(storage.values.size, 0);
});

test("collection entries are validated before paper state is persisted", async () => {
  const { coordinator, storage } = fixture();
  const invalidStates = [
    { ...initial, trades: [{ mint: "So11111111111111111111111111111111111111112", buyPrice: "1", tokens: 2 }] },
    { ...initial, scannedMints: [null] },
    { ...initial, deferredMints: [{ mint: "So11111111111111111111111111111111111111112", retryAt: "later" }] },
    { ...initial, lastScanReport: [{ mint: "So11111111111111111111111111111111111111112", status: "blocked", reasons: "not-an-array" }] }
  ];
  for (const state of invalidStates) {
    await assert.rejects(() => coordinator.importOnce(state));
    assert.equal(storage.values.size, 0);
  }
});

test("valid legacy-shaped paper trades and scan metadata remain accepted", async () => {
  const { coordinator } = fixture();
  const state = {
    ...initial,
    trades: [{
      mint: "So11111111111111111111111111111111111111112",
      amount: 5, buyPrice: 1.25, currentPrice: 1.3, tokens: 4,
      sold: false, boughtAt: "2026-01-01T00:00:00.000Z", mode: "paper"
    }],
    scannedMints: ["So11111111111111111111111111111111111111112"],
    deferredMints: [{ mint: "So11111111111111111111111111111111111111112", retryAt: 123456 }],
    lastScanReport: [{
      mint: "So11111111111111111111111111111111111111112",
      status: "rejected", reasons: ["Liquidity too low"]
    }]
  };
  await coordinator.importOnce(state);
  assert.deepEqual((await coordinator.snapshot()).state, state);
});

test("paper state rejects oversized metadata and collection strings", async () => {
  const { coordinator, storage } = fixture();
  const mint = "S".repeat(65);
  const invalidStates = [
    { ...initial, lastMessage: "x".repeat(2001) },
    { ...initial, lastRunAt: "x".repeat(65) },
    { ...initial, scannedMints: [mint] },
    { ...initial, deferredMints: [{ mint, retryAt: 1 }] },
    { ...initial, lastScanReport: [{
      mint: "So11111111111111111111111111111111111111112",
      status: "rejected", reasons: Array(13).fill("reason")
    }] },
    { ...initial, trades: [{
      mint, buyPrice: 1, tokens: 1, sold: false
    }] }
  ];
  for (const state of invalidStates) {
    await assert.rejects(() => coordinator.importOnce(state));
    assert.equal(storage.values.size, 0);
  }
});
