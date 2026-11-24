import { test } from "node:test";
import assert from "node:assert/strict";
import { PaperTradingState } from "../paper-trading-state.mjs";
import Worker from "../worker.js";

class MemoryStorage {
  constructor() { this.values = new Map(); this.tail = Promise.resolve(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(callback) {
    let release;
    const previous = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    const tx = {
      get: async key => structuredClone(this.values.get(key)),
      put: async (key, value) => { this.values.set(key, structuredClone(value)); }
    };
    try { return await callback(tx); }
    finally { release(); }
  }
}
class MemoryKV {
  constructor(value = null) {
    this.values = new Map();
    if (value !== null) this.values.set("bot_state", JSON.stringify(value));
  }
  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, String(value)); }
}
function makeDO(legacy = null) {
  const storage = new MemoryStorage();
  const instance = new PaperTradingState({ storage }, { BOT_STATE: new MemoryKV(legacy) });
  return { instance, storage };
}
async function call(instance, body) {
  const response = await instance.fetch(new Request("https://paper-trading.internal/", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }));
  return { status: response.status, body: await response.json() };
}
const mintA = "So11111111111111111111111111111111111111112";
const requestId = suffix => "paper-test-request-" + suffix;

test("internal state endpoint rejects oversized request bodies before JSON parsing", async () => {
  const { instance } = makeDO({ balance: 100, trades: [], updatedAt: null });
  const response = await instance.fetch(new Request("https://paper-trading.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "get", padding: "x".repeat(262145) })
  }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Request body too large" });
});

test("migration-status preflight is read-only and does not initialize DO or KV marker", async () => {
  const { instance, storage } = makeDO({ balance: 100, trades: [], updatedAt: null });
  const result = await call(instance, { operation: "migration-status" });
  assert.equal(result.status, 200);
  assert.equal(result.body.canMigrateLegacy, true);
  assert.equal(result.body.initialized, false);
  assert.equal(result.body.revision, 0);
  assert.equal(storage.values.has("paper_state_v1"), false);
  assert.equal(await instance.env.BOT_STATE.get("paper_state_do_migration_v1"), null);
});

test("migration preflight and transaction guard reject deferred or previously active destination state", async () => {
  const nonPristine = [
    { deferredMints: [{ mint: mintA, retryAt: 123 }] }
  ];
  for (const changed of nonPristine) {
    const legacy = { balance: 100, trades: [], ...changed };
    const { instance, storage } = makeDO(legacy);
    const preflight = await call(instance, { operation: "migration-status" });
    assert.equal(preflight.body.canMigrateLegacy, false, JSON.stringify(changed));
    assert.equal(storage.values.has("paper_state_v1"), false);
    assert.equal(await instance.env.BOT_STATE.get("paper_state_do_migration_v1"), null);

    const initialized = await call(instance, { operation: "get" });
    assert.equal(initialized.status, 200);
    const attempted = await call(instance, {
      operation: "migrate-legacy", expectedRevision: initialized.body.revision,
      state: { balance: 100, trades: [], autoEnabled: false, paused: false, scannedMints: [] }
    });
    assert.equal(attempted.status, 409, JSON.stringify(changed));
  }
});

test("migration-status refuses a completed marker when DO record is absent without recovery writes", async () => {
  const { instance, storage } = makeDO({ balance: 72, trades: [], updatedAt: null });
  await instance.env.BOT_STATE.put("paper_state_do_migration_v1", "complete");
  const result = await call(instance, { operation: "migration-status" });
  assert.equal(result.status, 200);
  assert.equal(result.body.canMigrateLegacy, false);
  assert.equal(result.body.stateMissing, true);
  assert.equal(storage.values.has("paper_state_v1"), false);
  assert.equal(await instance.env.BOT_STATE.get("paper_state_do_migration_v1"), "complete");
});

test("migration-status refuses unknown marker values even when a DO record exists", async () => {
  const { instance } = makeDO({ balance: 100, trades: [], updatedAt: null });
  await call(instance, { operation: "get" });
  await instance.env.BOT_STATE.put("paper_state_do_migration_v1", "unexpected-marker");
  const result = await call(instance, { operation: "migration-status" });
  assert.equal(result.status, 200);
  assert.equal(result.body.initialized, true);
  assert.equal(result.body.canMigrateLegacy, false);
});

test("migration-status fails closed on an unknown marker without recovery writes", async () => {
  const { instance, storage } = makeDO({ balance: 100, trades: [], updatedAt: null });
  await instance.env.BOT_STATE.put("paper_state_do_migration_v1", "unexpected-marker");
  const result = await call(instance, { operation: "migration-status" });
  assert.equal(result.status, 200);
  assert.equal(result.body.canMigrateLegacy, false);
  assert.equal(result.body.stateMissing, true);
  assert.equal(storage.values.has("paper_state_v1"), false);
  assert.equal(await instance.env.BOT_STATE.get("paper_state_do_migration_v1"), "unexpected-marker");
});

test("PaperTradingState imports the existing KV paper state once", async () => {
  const { instance } = makeDO({ balance: 73.25, trades: [{
    mint: mintA, amount: 5, buyPrice: 2, currentPrice: 2.1, tokens: 2.5, sold: false
  }], autoEnabled: true, paused: false, updatedAt: "2026-11-01T00:00:00.000Z" });
  const result = await call(instance, { operation: "get" });
  assert.equal(result.status, 200);
  assert.equal(result.body.state.balance, 73.25);
  assert.equal(result.body.state.trades.length, 1);
  assert.equal(result.body.state.autoEnabled, true);
  assert.equal(result.body.revision, 0);
});

test("interrupted initializing marker safely resumes the one-time KV import", async () => {
  const kv = new MemoryKV({ balance: 61.5, trades: [], updatedAt: "2026-11-01T00:00:00.000Z" });
  await kv.put("paper_state_do_migration_v1", "initializing");
  const instance = new PaperTradingState({ storage: new MemoryStorage() }, { BOT_STATE: kv });
  const result = await call(instance, { operation: "get" });
  assert.equal(result.status, 200);
  assert.equal(result.body.state.balance, 61.5);
  assert.equal(result.body.revision, 0);
  assert.equal(await kv.get("paper_state_do_migration_v1"), "complete");
});

test("committed DO state completes a failed KV marker write before any recovery", async () => {
  const kv = new MemoryKV({ balance: 38, trades: [], updatedAt: "2026-11-01T00:00:00.000Z" });
  const originalPut = kv.put.bind(kv);
  let failCompletionOnce = true;
  kv.put = async (key, value) => {
    if (key === "paper_state_do_migration_v1" && value === "complete" && failCompletionOnce) {
      failCompletionOnce = false;
      throw new Error("simulated KV write failure");
    }
    return originalPut(key, value);
  };
  const storage = new MemoryStorage();
  const instance = new PaperTradingState({ storage }, { BOT_STATE: kv });

  const interrupted = await call(instance, { operation: "get" });
  assert.equal(interrupted.status, 503);
  assert.equal(await kv.get("paper_state_do_migration_v1"), "initializing");
  assert.equal((await storage.get("paper_state_v1")).migrationMarkerPending, true);

  const recovered = await call(instance, { operation: "get" });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.state.balance, 38);
  assert.equal(await kv.get("paper_state_do_migration_v1"), "complete");
  assert.equal((await storage.get("paper_state_v1")).migrationMarkerPending, false);

  // If DO storage is subsequently lost, the completed marker must prevent
  // the stale legacy KV snapshot from being imported again.
  storage.values.delete("paper_state_v1");
  const refused = await call(instance, { operation: "get" });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error, "Paper trading state operation failed");
});

test("missing Durable Object storage never resurrects the stale KV snapshot", async () => {
  const kv = new MemoryKV({ balance: 44, trades: [], updatedAt: "2026-11-01T00:00:00.000Z" });
  await kv.put("paper_state_do_migration_v1", "complete");
  const instance = new PaperTradingState({ storage: new MemoryStorage() }, { BOT_STATE: kv });
  const result = await call(instance, { operation: "get" });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "Paper trading state operation failed");
});

test("compare-and-set rejects stale snapshots without overwriting current state", async () => {
  const { instance } = makeDO({ balance: 100, trades: [], updatedAt: null });
  const first = await call(instance, { operation: "get" });
  const accepted = await call(instance, {
    operation: "compare-and-set", expectedRevision: 0,
    state: { ...first.body.state, balance: 95 }
  });
  assert.equal(accepted.status, 200);
  const stale = await call(instance, {
    operation: "compare-and-set", expectedRevision: 0,
    state: { ...first.body.state, balance: 50 }
  });
  assert.equal(stale.status, 409);
  const current = await call(instance, { operation: "get" });
  assert.equal(current.body.state.balance, 95);
  assert.equal(current.body.revision, 1);
});

test("idle cron snapshots do not close the one-time browser migration window", async () => {
  const { instance } = makeDO({ balance: 100, trades: [], updatedAt: null });
  const initial = await call(instance, { operation: "get" });
  const idleCycle = await call(instance, {
    operation: "compare-and-set",
    expectedRevision: initial.body.revision,
    state: { ...initial.body.state, lastRunAt: "2026-11-14T20:00:00.000Z", lastMessage: "idle cycle" }
  });
  assert.equal(idleCycle.status, 200);
  const migrated = await call(instance, {
    operation: "migrate-legacy",
    expectedRevision: idleCycle.body.revision,
    state: { balance: 75, trades: [], autoEnabled: false, paused: false, scannedMints: [] }
  });
  assert.equal(migrated.status, 200);
  assert.equal(migrated.body.state.balance, 75);
  assert.equal(migrated.body.state.lastRunAt, "2026-11-14T20:00:00.000Z");
  assert.equal(migrated.body.state.lastMessage, "idle cycle");
});

test("changing automation closes the one-time browser migration window", async () => {
  const { instance } = makeDO({ balance: 100, trades: [], updatedAt: null });
  const enabled = await call(instance, { operation: "automation", settings: { enabled: true } });
  const migration = await call(instance, {
    operation: "migrate-legacy",
    expectedRevision: enabled.body.revision,
    state: { balance: 70, trades: [], autoEnabled: false, paused: false, scannedMints: [] }
  });
  assert.equal(migration.status, 409);
  const current = await call(instance, { operation: "get" });
  assert.equal(current.body.state.autoEnabled, true);
  assert.equal(current.body.state.balance, 100);
});

test("simultaneous paper buys cannot overspend or duplicate an open mint", async () => {
  const { instance } = makeDO({ balance: 10, trades: [], updatedAt: null });
  const results = await Promise.all([
    call(instance, { operation: "paper-buy", mint: mintA, price: 2, requestId: requestId("one") }),
    call(instance, { operation: "paper-buy", mint: mintA, price: 2, requestId: requestId("two") })
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 1);
  const current = await call(instance, { operation: "get" });
  assert.equal(current.body.state.balance, 5);
  assert.equal(current.body.state.trades.filter(trade => !trade.sold).length, 1);
});

test("replayed paper-buy idempotency key charges the paper balance once", async () => {
  const { instance } = makeDO({ balance: 10, trades: [], updatedAt: null });
  const body = { operation: "paper-buy", mint: mintA, price: 2, requestId: requestId("replay") };
  const first = await call(instance, body);
  const replay = await call(instance, body);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.state.balance, 5);
  const current = await call(instance, { operation: "get" });
  assert.equal(current.body.state.balance, 5);
  assert.equal(current.body.state.trades.length, 1);
});

test("idempotency keys cannot be replayed for a different mint or operation", async () => {
  const { instance } = makeDO({ balance: 20, trades: [], updatedAt: null });
  const first = await call(instance, {
    operation: "paper-buy", mint: mintA, price: 2, requestId: requestId("bound")
  });
  assert.equal(first.status, 200);
  const changedIntent = await call(instance, {
    operation: "paper-buy", mint: "11111111111111111111111111111111", price: 3, requestId: requestId("bound")
  });
  assert.equal(changedIntent.status, 409);
  const current = await call(instance, { operation: "get" });
  assert.equal(current.body.state.balance, 15);
  assert.equal(current.body.state.trades.length, 1);
});

test("clearing history preserves the current paper balance", async () => {
  const { instance } = makeDO({ balance: 87.5, trades: [{
    mint: mintA, amount: 5, buyPrice: 2, currentPrice: 2, tokens: 2.5, sold: true, sellPrice: 2, saleValue: 5
  }], updatedAt: null });
  const result = await call(instance, { operation: "clear-history", requestId: requestId("clear") });
  assert.equal(result.status, 200);
  assert.equal(result.body.state.balance, 87.5);
  assert.deepEqual(result.body.state.trades, []);
});


test("scheduled cron persists its cycle status through authoritative paper state", async () => {
  const { instance } = makeDO({ balance: 100, trades: [], autoEnabled: false, paused: false, scannedMints: [] });
  const namespace = {
    idFromName: name => name,
    get: id => {
      assert.equal(id, "paper-trading");
      return {
        fetch: (url, init) => instance.fetch(new Request(url, init))
      };
    }
  };
  const pending = [];
  await Worker.scheduled({}, { PAPER_TRADING_STATE: namespace }, {
    waitUntil: promise => pending.push(promise)
  });
  await Promise.all(pending);

  const current = await call(instance, { operation: "get" });
  assert.equal(current.status, 200);
  assert.equal(current.body.state.balance, 100);
  assert.equal(current.body.state.trades.length, 0);
  assert.ok(Number.isFinite(Date.parse(current.body.state.lastRunAt)));
  assert.match(current.body.state.lastMessage, /Server cycle complete/);
  assert.match(current.body.state.lastMessage, /Auto-buy inactive/);
  assert.equal(current.body.revision, 1);
});
