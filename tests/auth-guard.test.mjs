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


test("an MFA challenge and its TOTP counter can only be completed once", async () => {
  const { guard } = makeGuard();
  const id = "123e4567-e89b-12d3-a456-426614174000";
  await guard.initializeFromLegacy({ totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP" });
  assert.equal(await guard.createMfaChallenge(id, 1000), true);
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    guard.completeMfaChallenge({
      challengeId: id,
      now: 1001,
      totpCounter: 123456,
      failureScope: "totp:ip-test"
    })
  ));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.reason === "missing").length, 19);
});

test("a backup code is consumed atomically when completing an MFA challenge", async () => {
  const { guard } = makeGuard();
  const hash = "d".repeat(64);
  await guard.initializeFromLegacy({
    totpEnabled: true,
    totpSecret: "JBSWY3DPEHPK3PXP",
    backupHash: hash
  });
  const ids = Array.from({ length: 2 }, (_, i) =>
    "123e4567-e89b-12d3-a456-42661417400" + i
  );
  for (const id of ids) assert.equal(await guard.createMfaChallenge(id, 2000), true);
  const results = await Promise.all(ids.map(challengeId =>
    guard.completeMfaChallenge({
      challengeId,
      now: 2001,
      backupHash: hash,
      failureScope: "totp:backup-test"
    })
  ));
  assert.equal(results.filter(result => result.ok && result.method === "backup").length, 1);
});

test("MFA challenges expire and failed attempts are rate limited atomically", async () => {
  const { guard } = makeGuard();
  const expiredId = "123e4567-e89b-12d3-a456-426614174010";
  assert.equal(await guard.createMfaChallenge(expiredId, 1000), true);
  assert.deepEqual(await guard.completeMfaChallenge({
    challengeId: expiredId,
    now: 301001,
    failureScope: "totp:expired"
  }), { ok: false, reason: "expired" });

  const id = "123e4567-e89b-12d3-a456-426614174011";
  assert.equal(await guard.createMfaChallenge(id, 400000), true);
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    guard.completeMfaChallenge({
      challengeId: id,
      now: 400001,
      failureScope: "totp:attempt-test"
    })
  ));
  assert.equal(results.filter(result => result.reason === "invalid").length, 4);
  assert.equal(results.filter(result => result.reason === "rate-limited").length, 1);
  assert.equal(results.filter(result => result.reason === "missing").length, 3);
});

test("MFA challenge creation is bounded and validates challenge identifiers", async () => {
  const { guard } = makeGuard();
  await assert.rejects(() => guard.createMfaChallenge("not-a-uuid", 1000));
  for (let i = 0; i < 100; i++) {
    const suffix = String(i).padStart(12, "0");
    const id = "123e4567-e89b-12d3-a456-" + suffix;
    assert.equal(await guard.createMfaChallenge(id, 1000), true);
  }
  assert.equal(await guard.createMfaChallenge("223e4567-e89b-12d3-a456-426614174000", 1000), false);
});


async function testTotpCode(secret, counter) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const key = await crypto.subtle.importKey("raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let n = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = n & 255; n = Math.floor(n / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 127) << 24) | ((mac[offset + 1] & 255) << 16) | ((mac[offset + 2] & 255) << 8) | (mac[offset + 3] & 255);
  return String(binary % 1000000).padStart(6, "0");
}

test("legacy TOTP profile and pending enrollment state migrate exactly once", async () => {
  const { guard } = makeGuard();
  const legacy = {
    totpEnabled: true,
    totpSecret: "JBSWY3DPEHPK3PXP",
    pendingTotpSecret: null,
    pendingTotpAt: null,
    backupHash: "e".repeat(64),
    lastTotpCounter: 123
  };
  assert.equal(await guard.initializeFromLegacy(legacy), true);
  assert.deepEqual(await guard.getProfile(), {
    initialized: true,
    totpEnabled: true,
    totpSecret: legacy.totpSecret,
    pendingTotpSecret: null,
    pendingTotpAt: null
  });
  assert.equal(await guard.initializeFromLegacy({ ...legacy, totpSecret: "A".repeat(16) }), false);
});

test("TOTP enrollment secret is stored and confirmed atomically in AuthGuard", async () => {
  const { guard } = makeGuard();
  const secret = "JBSWY3DPEHPK3PXP";
  const now = 1800000000000;
  await guard.initializeFromLegacy();
  assert.equal(await guard.beginTotpSetup(secret, now), true);
  const counter = Math.floor(now / 30000);
  const code = await testTotpCode(secret, counter);
  const backupHash = "f".repeat(64);
  const result = await guard.confirmTotpSetup({ code, backupHash, failureScope: "totp:test", now });
  assert.deepEqual(result, { ok: true, counter });
  assert.deepEqual(await guard.getProfile(), {
    initialized: true,
    totpEnabled: true,
    totpSecret: secret,
    pendingTotpSecret: null,
    pendingTotpAt: null
  });
  assert.equal((await guard.confirmTotpSetup({ code, backupHash, failureScope: "totp:test", now })).ok, false);
});

test("TOTP setup rejects expired secrets and invalid legacy secret formats", async () => {
  const { guard } = makeGuard();
  await guard.initializeFromLegacy();
  await assert.rejects(() => guard.beginTotpSetup("not-base32", 1000));
  await assert.rejects(() => guard.initializeFromLegacy({
    totpEnabled: true,
    totpSecret: null,
    lastTotpCounter: -1
  }));
});


test("TOTP enrollment failure counter is enforced within one transaction", async () => {
  const { guard } = makeGuard();
  await guard.initializeFromLegacy();
  await guard.beginTotpSetup("JBSWY3DPEHPK3PXP", 1000);
  const attempts = await Promise.all(Array.from({ length: 8 }, () =>
    guard.confirmTotpSetup({
      code: "000000",
      backupHash: "a".repeat(64),
      failureScope: "totp:atomic-test",
      now: 1001
    })
  ));
  assert.equal(attempts.filter(result => result.reason === "invalid").length, 4);
  assert.equal(attempts.filter(result => result.reason === "rate-limited").length, 4);
});
