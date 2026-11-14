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
  await assert.rejects(() => guard.clearFailures("bad.scope"));
  await assert.rejects(() => guard.recordFailure("bad.scope"));
  assert.equal(await guard.clearFailures("__proto__"), true);
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


test("legacy auth state initializes once and cannot overwrite newer counters", async () => {
  const { guard } = makeGuard();
  const legacyHash = "b".repeat(64);
  assert.equal(await guard.initializeFromLegacy({
    backupHash: legacyHash,
    lastTotpCounter: 987654
  }), true);
  assert.equal(await guard.acceptTotpCounter(987654), false);
  assert.equal(await guard.acceptTotpCounter(987655), true);
  assert.equal(await guard.initializeFromLegacy({
    backupHash: "c".repeat(64),
    lastTotpCounter: 1
  }), false);
  assert.equal(await guard.consumeBackupCode(legacyHash), true);
  assert.equal(await guard.consumeBackupCode("c".repeat(64)), false);
});

test("legacy auth state rejects malformed migration data", async () => {
  const { guard } = makeGuard();
  await assert.rejects(() => guard.initializeFromLegacy({
    backupHash: "not-a-hash",
    lastTotpCounter: 100
  }));
  await assert.rejects(() => guard.initializeFromLegacy({
    backupHash: null,
    lastTotpCounter: -2
  }));
});


test("internal endpoint requires one exact Bearer credential", async () => {
  const token = "s".repeat(40);
  const guard = new AuthGuard({ storage: new TransactionalStorage() }, {
    AUTH_GUARD_INTERNAL_TOKEN: token
  });
  const makeRequest = authorization => new Request("https://internal.invalid/", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "record-failure", scope: "login:test" })
  });
  for (const authorization of [token, "Basic " + token, "Bearer " + token + " extra", "Bearer " + "x".repeat(40)]) {
    const response = await guard.fetch(makeRequest(authorization));
    assert.equal(response.status, 401);
  }
  const accepted = await guard.fetch(makeRequest("Bearer " + token));
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.count, 1);
  assert.equal(acceptedBody.limited, false);
  assert.ok(acceptedBody.resetAt > Date.now());
});
