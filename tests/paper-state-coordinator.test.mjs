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
