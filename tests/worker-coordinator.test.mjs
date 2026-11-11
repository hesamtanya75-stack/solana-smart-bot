import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const workerModuleUrl = "data:text/javascript;base64," + Buffer.from(workerSource).toString("base64");
const { BotCoordinator } = await import(workerModuleUrl);

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
  await Promise.all([
    call({ op: "state-patch", patch: { autoEnabled: true } }),
    call({ op: "state-patch", patch: { paused: true } }),
    call({ op: "state-patch", patch: { balance: 77 } })
  ]);
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
