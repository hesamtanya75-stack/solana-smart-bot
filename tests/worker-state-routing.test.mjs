import test from "node:test";
import assert from "node:assert/strict";
import worker, { PaperStateCoordinator } from "../worker.js";

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
function environment() {
  const storage = new MemoryStorage();
  const coordinator = new PaperStateCoordinator({ storage });
  const stub = { fetch: request => coordinator.fetch(request) };
  const touchedKvKeys = [];
  const env = {
    BOT_STATE: {
      get: async (key) => {
        touchedKvKeys.push(["get", key]);
        if (key.startsWith("session:")) return { expiresAt: Date.now() + 60_000 };
        return null;
      },
      put: async (key) => { touchedKvKeys.push(["put", key]); },
      delete: async (key) => { touchedKvKeys.push(["delete", key]); }
    },
    PAPER_STATE_COORDINATOR: {
      idFromName: name => name,
      get: () => stub
    }
  };
  return { env, coordinator, touchedKvKeys };
}
function request(path, method = "GET", body) {
  return new Request("https://worker.test" + path, {
    method,
    headers: {
      Authorization: "Bearer test-session",
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("Worker state API initializes and reads paper state only through the Durable Object", async () => {
  const { env, coordinator, touchedKvKeys } = environment();
  const put = await worker.fetch(request("/api/state", "PUT", { balance: 88 }), env);
  assert.equal(put.status, 200);
  const get = await worker.fetch(request("/api/state"), env);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).balance, 88);
  assert.equal((await coordinator.snapshot()).state.balance, 88);
  assert.ok(!touchedKvKeys.some(([, key]) => key === "bot_state"));
});

test("automation settings use atomic Durable Object patches", async () => {
  const { env, coordinator, touchedKvKeys } = environment();
  await coordinator.importOnce({
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  });
  const response = await worker.fetch(request("/api/automation", "POST", { enabled: true, paused: true }), env);
  assert.equal(response.status, 200);
  const state = (await coordinator.snapshot()).state;
  assert.equal(state.autoEnabled, true);
  assert.equal(state.paused, true);
  assert.ok(!touchedKvKeys.some(([, key]) => key === "bot_state"));
});

test("Cron skips uninitialized state and commits initialized state with version protection", async () => {
  const { env, coordinator } = environment();
  let pending;
  await worker.scheduled({}, env, { waitUntil: promise => { pending = promise; } });
  await pending;
  assert.equal((await coordinator.snapshot()).initialized, false);

  await coordinator.importOnce({
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  });
  await worker.scheduled({}, env, { waitUntil: promise => { pending = promise; } });
  await pending;
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.version, 2);
  assert.ok(snapshot.state.lastRunAt);
});
