import { test } from "node:test";
import assert from "node:assert/strict";
import { PaperTradingState } from "../paper-trading-state.mjs";

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

test("missing Durable Object storage never resurrects the stale KV snapshot", async () => {
  const kv = new MemoryKV({ balance: 44, trades: [], updatedAt: "2026-11-01T00:00:00.000Z" });
  await kv.put("paper_state_do_migration_v1", "complete");
  const instance = new PaperTradingState({ storage: new MemoryStorage() }, { BOT_STATE: kv });
  const result = await call(instance, { operation: "get" });
  assert.equal(result.status, 503);
  assert.match(result.body.error, /missing after its one-time KV migration/);
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
