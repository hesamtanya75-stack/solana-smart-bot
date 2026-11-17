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

async function runScheduledWithDexPrice(t, initial, priceUsd, beforeCompareAndSet = null) {
  const { instance } = makeDO(initial);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /api\.dexscreener\.com\/latest\/dex\/tokens\//);
    return new Response(JSON.stringify({ pairs: [{
      chainId: "solana",
      baseToken: { address: mintA },
      liquidity: { usd: 50000 },
      priceUsd
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const namespace = {
    idFromName: name => name,
    get: id => {
      assert.equal(id, "paper-trading");
      return { fetch: async (url, init) => {
        const request = new Request(url, init);
        if (beforeCompareAndSet) {
          const body = await request.clone().json();
          if (body.operation === "compare-and-set") await beforeCompareAndSet(instance);
        }
        return instance.fetch(request);
      } };
    }
  };
  const pending = [];
  await Worker.scheduled({}, {
    PAPER_TRADING_STATE: namespace,
    BOT_STATE: new MemoryKV()
  }, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  return call(instance, { operation: "get" });
}

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


test("corrupted persisted balance fails closed without resetting or overwriting the ledger", async () => {
  const { instance, storage } = makeDO({ balance: 72, trades: [], updatedAt: null });
  await call(instance, { operation: "get" });
  const record = await storage.get("paper_state_v1");
  record.state.balance = "not-a-number";
  await storage.put("paper_state_v1", record);
  const result = await call(instance, { operation: "get" });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "Paper trading state operation failed");
  const unchanged = await storage.get("paper_state_v1");
  assert.equal(unchanged.state.balance, "not-a-number");
  assert.equal(unchanged.revision, 0);
});

test("malformed trade records fail closed instead of being silently discarded", async () => {
  const { instance, storage } = makeDO({ balance: 72, trades: [], updatedAt: null });
  await call(instance, { operation: "get" });
  const record = await storage.get("paper_state_v1");
  record.state.trades = [{ mint: mintA, amount: 5, buyPrice: "broken", tokens: 2.5 }];
  await storage.put("paper_state_v1", record);
  const result = await call(instance, { operation: "get" });
  assert.equal(result.status, 503);
  const unchanged = await storage.get("paper_state_v1");
  assert.equal(unchanged.state.trades.length, 1);
  assert.equal(unchanged.state.trades[0].buyPrice, "broken");
});

test("compare-and-set refuses malformed balance and leaves the last valid state intact", async () => {
  const { instance, storage } = makeDO({ balance: 72, trades: [], updatedAt: null });
  const initial = await call(instance, { operation: "get" });
  const rejected = await call(instance, {
    operation: "compare-and-set", expectedRevision: initial.body.revision,
    state: { ...initial.body.state, balance: "100" }
  });
  assert.equal(rejected.status, 503);
  const current = await call(instance, { operation: "get" });
  assert.equal(current.status, 200);
  assert.equal(current.body.state.balance, 72);
  assert.equal(current.body.revision, 0);
  assert.equal((await storage.get("paper_state_v1")).state.balance, 72);
});

test("corrupted ledger revision fails closed and preserves the stored record", async () => {
  const { instance, storage } = makeDO({ balance: 72, trades: [], updatedAt: null });
  await call(instance, { operation: "get" });
  const record = await storage.get("paper_state_v1");
  record.revision = -1;
  await storage.put("paper_state_v1", record);
  const result = await call(instance, { operation: "get" });
  assert.equal(result.status, 503);
  assert.equal((await storage.get("paper_state_v1")).revision, -1);
});

test("duplicate idempotency records fail closed without rewriting history", async () => {
  const { instance, storage } = makeDO({ balance: 72, trades: [], updatedAt: null });
  await call(instance, { operation: "get" });
  const record = await storage.get("paper_state_v1");
  const invalid = { id: requestId("duplicate"), operation: "clear-history", intent: "" };
  record.recentOperations = [invalid, { ...invalid }];
  await storage.put("paper_state_v1", record);
  const result = await call(instance, { operation: "get" });
  assert.equal(result.status, 503);
  const preserved = await storage.get("paper_state_v1");
  assert.equal(preserved.recentOperations.length, 2);
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


test("paper-buy idempotency rejects the same mint with a changed price", async () => {
  const { instance } = makeDO({ balance: 20, trades: [], updatedAt: null });
  const first = await call(instance, {
    operation: "paper-buy", mint: mintA, price: 2, requestId: requestId("price-bound")
  });
  assert.equal(first.status, 200);
  const changedPrice = await call(instance, {
    operation: "paper-buy", mint: mintA, price: 3, requestId: requestId("price-bound")
  });
  assert.equal(changedPrice.status, 409);
  assert.match(changedPrice.body.error, /Idempotency key/);
  const replay = await call(instance, {
    operation: "paper-buy", mint: mintA, price: 2, requestId: requestId("price-bound")
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const current = await call(instance, { operation: "get" });
  assert.equal(current.body.state.balance, 15);
  assert.equal(current.body.state.trades.length, 1);
  assert.equal(current.body.state.trades[0].buyPrice, 2);
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


test("scheduled cron retries a revision conflict without overwriting concurrent dashboard settings", async () => {
  const { instance } = makeDO({ balance: 100, trades: [], autoEnabled: false, paused: false, scannedMints: [] });
  let injectedConflict = false;
  const namespace = {
    idFromName: name => name,
    get: id => {
      assert.equal(id, "paper-trading");
      return {
        fetch: async (url, init) => {
          const request = new Request(url, init);
          const body = await request.clone().json();
          if (body.operation === "compare-and-set" && !injectedConflict) {
            injectedConflict = true;
            const concurrent = await call(instance, { operation: "automation", settings: { paused: true } });
            assert.equal(concurrent.status, 200);
          }
          return instance.fetch(request);
        }
      };
    }
  };
  const pending = [];
  await Worker.scheduled({}, { PAPER_TRADING_STATE: namespace }, {
    waitUntil: promise => pending.push(promise)
  });
  await Promise.all(pending);

  const current = await call(instance, { operation: "get" });
  assert.equal(injectedConflict, true);
  assert.equal(current.status, 200);
  assert.equal(current.body.state.paused, true);
  assert.equal(current.body.state.balance, 100);
  assert.equal(current.body.state.trades.length, 0);
  assert.ok(Number.isFinite(Date.parse(current.body.state.lastRunAt)));
  assert.match(current.body.state.lastMessage, /Auto-buy inactive/);
  assert.equal(current.body.revision, 2);
});


test("scheduled cron paper-sells at the +10% threshold and credits the sale value", async t => {
  const initial = { balance: 95, autoEnabled: false, paused: false, scannedMints: [], trades: [{
    mint: mintA, amount: 5, buyPrice: 2, currentPrice: 2, tokens: 2.5, sold: false
  }] };
  const first = await runScheduledWithDexPrice(t, initial, "2.2");
  assert.equal(first.status, 200);
  assert.equal(first.body.state.balance, 100.5);
  assert.equal(first.body.state.trades[0].sold, true);
  assert.equal(first.body.state.trades[0].sellPrice, 2.2);
  assert.equal(first.body.state.trades[0].saleValue, 5.5);
});

test("scheduled cron paper-sells at the -5% threshold and credits the reduced value", async t => {
  const initial = { balance: 95, autoEnabled: false, paused: false, scannedMints: [], trades: [{
    mint: mintA, amount: 5, buyPrice: 2, currentPrice: 2, tokens: 2.5, sold: false
  }] };
  const result = await runScheduledWithDexPrice(t, initial, "1.9");
  assert.equal(result.status, 200);
  assert.equal(result.body.state.balance, 99.75);
  assert.equal(result.body.state.trades[0].sold, true);
  assert.equal(result.body.state.trades[0].saleValue, 4.75);
});


test("scheduled cron does not credit a previously sold paper trade twice", async t => {
  const initial = { balance: 95, autoEnabled: false, paused: false, scannedMints: [], trades: [{
    mint: mintA, amount: 5, buyPrice: 2, currentPrice: 2, tokens: 2.5, sold: false
  }] };
  const first = await runScheduledWithDexPrice(t, initial, "2.2");
  const second = await runScheduledWithDexPrice(t, first.body.state, "2.2");
  assert.equal(first.body.state.balance, 100.5);
  assert.equal(second.body.state.balance, 100.5);
  assert.equal(second.body.state.trades[0].sold, true);
  assert.equal(second.body.state.trades[0].saleValue, 5.5);
});

test("scheduled cron retries a sell after a concurrent revision change without double-crediting", async t => {
  const initial = { balance: 95, autoEnabled: false, paused: false, scannedMints: [], trades: [{
    mint: mintA, amount: 5, buyPrice: 2, currentPrice: 2, tokens: 2.5, sold: false
  }] };
  let injected = false;
  const result = await runScheduledWithDexPrice(t, initial, "2.2", async instance => {
    if (injected) return;
    injected = true;
    const concurrent = await call(instance, { operation: "automation", settings: { paused: true } });
    assert.equal(concurrent.status, 200);
  });
  assert.equal(injected, true);
  assert.equal(result.status, 200);
  assert.equal(result.body.state.paused, true);
  assert.equal(result.body.state.balance, 100.5);
  assert.equal(result.body.state.trades[0].sold, true);
  assert.equal(result.body.state.trades[0].saleValue, 5.5);
  assert.equal(result.body.revision, 2);
});

test("scheduled cron ignores non-finite provider prices without corrupting paper state", async t => {
  const initial = { balance: 95, autoEnabled: false, paused: false, scannedMints: [], trades: [{
    mint: mintA, amount: 5, buyPrice: 2, currentPrice: 2, tokens: 2.5, sold: false
  }] };
  const result = await runScheduledWithDexPrice(t, initial, "Infinity");
  assert.equal(result.status, 200);
  assert.equal(result.body.state.balance, 95);
  assert.equal(result.body.state.trades[0].sold, false);
  assert.equal(result.body.state.trades[0].currentPrice, 2);
  assert.ok(Number.isFinite(Date.parse(result.body.state.lastRunAt)));
});


test("legacy paper history above the supported limit fails closed without truncation", async () => {
  const trades = Array.from({ length: 501 }, (_, index) => ({
    mint: mintA,
    amount: 5,
    buyPrice: 2,
    currentPrice: 2,
    tokens: 2.5,
    sold: true,
    sellPrice: 2,
    saleValue: 5,
    boughtAt: new Date(0 + index).toISOString()
  }));
  const legacy = { balance: 100, trades, autoEnabled: false, paused: false, scannedMints: [] };
  const { instance, storage } = makeDO(legacy);
  const result = await call(instance, { operation: "get" });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, "Paper trading state operation failed");
  assert.equal(await storage.get("paper_state_v1"), undefined);
  assert.equal((await storage.values).size, 0);
});


test("legacy migration window stays closed when paper metadata shows prior activity", async () => {
  const cases = [
    { deferredMints: [{ mint: mintA, retryAt: 123 }] },
    { lastRunAt: "2026-11-17T10:00:00.000Z" },
    { lastScanReport: [{ mint: mintA, status: "blocked", reasons: ["risk"] }] },
    { lastMessage: "Previous paper trading activity" },
    { updatedAt: "2026-11-17T10:00:00.000Z" }
  ];
  for (const extra of cases) {
    const { instance } = makeDO({
      balance: 100, trades: [], autoEnabled: false, paused: false,
      scannedMints: [], ...extra
    });
    const result = await call(instance, { operation: "get" });
    assert.equal(result.status, 200);
    assert.equal(result.body.migrationOpen, false);
    const attempt = await call(instance, {
      operation: "migrate-legacy",
      expectedRevision: result.body.revision,
      state: { balance: 100, trades: [], autoEnabled: false, paused: false, scannedMints: [] }
    });
    assert.equal(attempt.status, 409);
  }
});
