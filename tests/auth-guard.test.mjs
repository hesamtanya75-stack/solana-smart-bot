import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthGuard } from "../auth-guard.mjs";

class TransactionalStorage {
  constructor() {
    this.values = new Map();
    this.tail = Promise.resolve();
  }

  async transaction(callback) {
    let release;
    const previous = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    const tx = {
      get: async key => this.values.get(key),
      put: async (key, value) => { this.values.set(key, structuredClone(value)); }
    };
    try {
      return await callback(tx);
    } finally {
      release();
    }
  }
}

function makeGuard() {
  const storage = new TransactionalStorage();
  return { guard: new AuthGuard({ storage }, {}), storage };
}

test("only one concurrent request can consume a backup code", async () => {
  const { guard } = makeGuard();
  const hash = "a".repeat(64);
  await guard.provisionBackupHash(hash);
  const results = await Promise.all(Array.from({ length: 20 }, () => guard.consumeBackupCode(hash)));
  assert.equal(results.filter(Boolean).length, 1);
});

test("only one concurrent request can accept the same TOTP counter", async () => {
  const { guard } = makeGuard();
  const results = await Promise.all(Array.from({ length: 20 }, () => guard.acceptTotpCounter(123456)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await guard.acceptTotpCounter(123455), false);
  assert.equal(await guard.acceptTotpCounter(123457), true);
});

test("authentication failures increment atomically and enforce the threshold", async () => {
  const { guard } = makeGuard();
  const results = await Promise.all(Array.from({ length: 20 }, () => guard.recordFailure("totp:ip-test", 1000)));
  assert.equal(Math.max(...results.map(item => item.count)), 20);
  assert.equal(results.filter(item => item.limited).length, 16);
  assert.equal((await guard.recordFailure("totp:ip-test", 1001)).count, 21);
  assert.equal((await guard.recordFailure("totp:ip-test", 901001)).count, 1);
});

test("backup hashes and TOTP counters reject malformed values", async () => {
  const { guard } = makeGuard();
  assert.equal(await guard.consumeBackupCode("not-a-hash"), false);
  assert.equal(await guard.acceptTotpCounter(-1), false);
  assert.equal(await guard.acceptTotpCounter(1.5), false);
  await assert.rejects(() => guard.provisionBackupHash("bad"));
});

test("failure scopes reject invalid values without touching object keys", async () => {
  const { guard } = makeGuard();
  await assert.rejects(() => guard.clearFailures("__proto__"));
  await assert.rejects(() => guard.recordFailure("bad.scope"));
  const result = await guard.recordFailure("totp:valid-scope", 1000);
  assert.equal(result.count, 1);
});

test("internal endpoint rejects oversized request bodies", async () => {
  const token = "t".repeat(40);
  const guard = new AuthGuard({ storage: new TransactionalStorage() }, {
    AUTH_GUARD_INTERNAL_TOKEN: token
  });
  const request = new Request("https://internal.invalid/", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "record-failure", scope: "x", padding: "a".repeat(5000) })
  });
  const response = await guard.fetch(request);
  assert.equal(response.status, 413);
});
