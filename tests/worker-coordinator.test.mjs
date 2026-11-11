import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const nodeCompatibleWorkerSource =
  "class DurableObject { constructor(ctx) { this.ctx = ctx; } }\n" +
  workerSource.replace('import { DurableObject } from "cloudflare:workers";\n', "");
const workerModuleUrl = "data:text/javascript;base64," + Buffer.from(nodeCompatibleWorkerSource).toString("base64");
const { BotCoordinator, default: worker } = await import(workerModuleUrl);

class SerialStorage {
  constructor() {
    this.values = new Map();
    this.tail = Promise.resolve();
  }
  async transaction(callback) {
    let release;
    const previous = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await callback({
        get: async key => this.values.get(key),
        put: async (key, value) => { this.values.set(key, structuredClone(value)); },
        delete: async key => { this.values.delete(key); }
      });
    } finally {
      release();
    }
  }
}

function setup() {
  const storage = new SerialStorage();
  const coordinator = new BotCoordinator({ storage });
  return {
    storage,
    call: async payload => {
      const response = await coordinator.fetch(new Request("https://coordinator.test/operation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }));
      return response.json();
    }
  };
}

class MemoryKV {
  constructor(entries = []) { this.values = new Map(entries); }
  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

test("concurrent login failures cannot exceed the five-attempt limit", async () => {
  const { call, storage } = setup();
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    call({ op: "login-attempt", ip: "203.0.113.7", success: false })
  ));
  assert.equal(results.filter(result => result.allowed).length, 5);
  assert.equal(results.filter(result => result.locked).length, 15);
  assert.equal(storage.values.get("login:203.0.113.7").count, 5);
});

test("TOTP challenge attempts are counted atomically and cannot be reused", async () => {
  const { call } = setup();
  const challengeId = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal((await call({ op: "mfa-create", challengeId })).ok, true);
  const attempts = await Promise.all(Array.from({ length: 12 }, () =>
    call({ op: "mfa-attempt", challengeId })
  ));
  assert.equal(attempts.filter(result => result.allowed).length, 5);
  assert.equal(attempts.filter(result => result.allowed === false).length, 7);
  assert.equal((await call({ op: "mfa-consume", challengeId })).consumed, false);
});

test("TOTP rate limits apply across newly created challenges from the same IP", async () => {
  const { call } = setup();
  const challengeIds = Array.from({ length: 8 }, (_, index) =>
    "123e4567-e89b-42d3-a456-" + String(index).padStart(12, "0")
  );
  await Promise.all(challengeIds.map(challengeId => call({ op: "mfa-create", challengeId })));
  const attempts = await Promise.all(challengeIds.map(challengeId =>
    call({ op: "mfa-attempt", challengeId, ip: "198.51.100.8" })
  ));
  assert.equal(attempts.filter(result => result.allowed).length, 5);
  assert.equal(attempts.filter(result => result.locked).length, 3);
});

test("a recovery code can be consumed only once under concurrency", async () => {
  const { call } = setup();
  const hash = "a".repeat(64);
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    call({ op: "backup-consume", hash })
  ));
  assert.equal(results.filter(result => result.consumed).length, 1);
  assert.equal(results.filter(result => !result.consumed).length, 9);
});

test("concurrent state patches preserve independent updates", async () => {
  const { call, storage } = setup();
  const updates = await Promise.all([
    call({ op: "state-patch", patch: { autoEnabled: true } }),
    call({ op: "state-patch", patch: { paused: true } }),
    call({ op: "state-patch", patch: { balance: 77 } })
  ]);
  assert.equal(new Set(updates.map(result => result.state.updatedAt)).size, 3);
  const state = storage.values.get("bot_state");
  assert.equal(state.autoEnabled, true);
  assert.equal(state.paused, true);
  assert.equal(state.balance, 77);
});

test("stale scheduled state writes are rejected instead of overwriting newer state", async () => {
  const { call, storage } = setup();
  const initial = await call({ op: "state-read" });
  assert.equal(initial.state, null);
  assert.equal((await call({
    op: "state-save",
    expectedUpdatedAt: null,
    state: { balance: 90, updatedAt: "version-1" }
  })).ok, true);
  const stale = await call({
    op: "state-save",
    expectedUpdatedAt: null,
    state: { balance: 10, updatedAt: "stale-version" }
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(storage.values.get("bot_state").balance, 90);
});

test("first authenticated state access migrates legacy KV paper trades before updates", async () => {
  const storage = new SerialStorage();
  const coordinator = new BotCoordinator({ storage });
  const kv = new MemoryKV([[
    "bot_state",
    JSON.stringify({
      balance: 42.5,
      trades: [{ mint: "LegacyMint", amount: 5, buyPrice: 1, tokens: 5, sold: false }],
      autoEnabled: true,
      paused: false,
      scannedMints: [],
      deferredMints: [],
      lastScanReport: [],
      updatedAt: null
    })
  ]]);
  const env = {
    BOT_STATE: kv,
    BOT_LOGIN_PASSWORD: "test-password",
    BOT_COORDINATOR: {
      idFromName: name => name,
      get: () => ({ fetch: (input, init) => coordinator.fetch(new Request(input, init)) })
    }
  };
  const login = await worker.fetch(new Request("https://worker.test/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.9" },
    body: JSON.stringify({ password: "test-password" })
  }), env);
  assert.equal(login.status, 200);
  const { token } = await login.json();

  const stateResponse = await worker.fetch(new Request("https://worker.test/api/state", {
    headers: { Authorization: "Bearer " + token }
  }), env);
  assert.equal(stateResponse.status, 200);
  const migrated = await stateResponse.json();
  assert.equal(migrated.balance, 42.5);
  assert.equal(migrated.trades[0].mint, "LegacyMint");

  const acceptedWrite = await worker.fetch(new Request("https://worker.test/api/state", {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedUpdatedAt: migrated.updatedAt,
      balance: 41.5,
      trades: migrated.trades,
      scannedMints: migrated.scannedMints
    })
  }), env);
  assert.equal(acceptedWrite.status, 200);
  const saved = await acceptedWrite.json();
  assert.equal(saved.state.balance, 41.5);

  const staleWrite = await worker.fetch(new Request("https://worker.test/api/state", {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedUpdatedAt: migrated.updatedAt,
      balance: 1,
      trades: [],
      scannedMints: []
    })
  }), env);
  assert.equal(staleWrite.status, 409);

  const updateResponse = await worker.fetch(new Request("https://worker.test/api/automation", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ paused: true })
  }), env);
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.state.balance, 41.5);
  assert.equal(updated.state.trades[0].mint, "LegacyMint");
  assert.equal(updated.state.paused, true);
});
