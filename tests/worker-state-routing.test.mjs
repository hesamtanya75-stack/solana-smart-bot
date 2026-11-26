import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { PaperStateCoordinator, MfaRateLimiter } from "../worker.js";

class MemoryStorage {
  values = new Map();
  tail = Promise.resolve();
  alarmAt = null;
  async transaction(callback) {
    let release;
    const previous = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    const tx = {
      get: async key => this.values.get(key),
      put: async (key, value) => { this.values.set(key, structuredClone(value)); },
      delete: async key => this.values.delete(key),
      list: async ({ prefix = "" } = {}) => new Map([...this.values].filter(([key]) => key.startsWith(prefix)))
    };
    try { return await callback(tx); }
    finally { release(); }
  }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }
  async delete(key) { return this.values.delete(key); }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(timestamp) { this.alarmAt = timestamp; }
}
function environment() {
  const storage = new MemoryStorage();
  const coordinator = new PaperStateCoordinator({ storage });
  const stub = { fetch: (input, init) => coordinator.fetch(new Request(input, init)) };
  const authStorage = new MemoryStorage();
  const authLimiter = new MfaRateLimiter({ storage: authStorage });
  const authStub = { fetch: (input, init) => authLimiter.fetch(new Request(input, init)) };
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
    },
    AUTH_RATE_LIMITER: {
      idFromName: name => name,
      get: () => authStub
    }
  };
  return { env, coordinator, touchedKvKeys, authStorage, authLimiter };
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

test("concurrent first-time automation patches preserve both settings", async () => {
  const storage = new MemoryStorage();
  const coordinator = new PaperStateCoordinator({ storage });
  let snapshots = 0;
  let releaseSnapshots;
  const bothSnapshots = new Promise(resolve => { releaseSnapshots = resolve; });
  const stub = {
    fetch: async (input, init) => {
      const response = await coordinator.fetch(new Request(input, init));
      if (new URL(input).pathname === "/snapshot") {
        snapshots += 1;
        if (snapshots === 2) releaseSnapshots();
        await bothSnapshots;
      }
      return response;
    }
  };
  const env = {
    BOT_STATE: {
      get: async () => ({ expiresAt: Date.now() + 60_000 }),
      put: async () => {},
      delete: async () => {}
    },
    PAPER_STATE_COORDINATOR: { idFromName: name => name, get: () => stub }
  };
  const responses = await Promise.all([
    worker.fetch(request("/api/automation", "POST", { enabled: true }), env),
    worker.fetch(request("/api/automation", "POST", { paused: true }), env)
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.state.autoEnabled, true);
  assert.equal(snapshot.state.paused, true);
  assert.equal(snapshot.version, 2);
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

test("concurrent state API PUTs cannot overwrite a newer paper-state version", async () => {
  const storage = new MemoryStorage();
  const coordinator = new PaperStateCoordinator({ storage });
  let arrivals = 0;
  let release;
  const bothCommits = new Promise(resolve => { release = resolve; });
  const stub = {
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/commit") {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothCommits;
      }
      return coordinator.fetch(new Request(input, init));
    }
  };
  const env = {
    BOT_STATE: {
      get: async () => ({ expiresAt: Date.now() + 60_000 }),
      put: async () => {},
      delete: async () => {}
    },
    PAPER_STATE_COORDINATOR: { idFromName: name => name, get: () => stub }
  };
  await coordinator.importOnce({
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  });
  const responses = await Promise.all([
    worker.fetch(request("/api/state", "PUT", { balance: 91 }), env),
    worker.fetch(request("/api/state", "PUT", { balance: 82 }), env)
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.version, 2);
  assert.ok([91, 82].includes(snapshot.state.balance));
});

test("state API rejects oversized arrays instead of silently truncating them", async () => {
  const { env, coordinator } = environment();
  const response = await worker.fetch(request("/api/state", "PUT", { balance: 90, trades: Array.from({ length: 501 }, (_, i) => ({ id: i })) }), env);
  assert.equal(response.status, 400);
  assert.equal((await coordinator.snapshot()).initialized, false);
});

test("state API rejects coercible balances before persistence", async () => {
  const { env, coordinator } = environment();
  const response = await worker.fetch(request("/api/state", "PUT", { balance: "88" }), env);
  assert.equal(response.status, 400);
  assert.equal((await coordinator.snapshot()).initialized, false);
});

test("state API rejects malformed automation flags before persistence", async () => {
  const { env, coordinator } = environment();
  const response = await worker.fetch(request("/api/state", "PUT", { balance: 88, autoEnabled: "true" }), env);
  assert.equal(response.status, 400);
  assert.equal((await coordinator.snapshot()).initialized, false);
});

test("Cron discards a stale result when dashboard state changes mid-cycle", async () => {
  const storage = new MemoryStorage();
  const coordinator = new PaperStateCoordinator({ storage });
  let raced = false;
  const stub = {
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/commit" && !raced) {
        raced = true;
        await coordinator.patch({ paused: true });
      }
      return coordinator.fetch(new Request(input, init));
    }
  };
  const env = {
    BOT_STATE: { get: async () => null, put: async () => {}, delete: async () => {} },
    PAPER_STATE_COORDINATOR: { idFromName: name => name, get: () => stub }
  };
  await coordinator.importOnce({
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  });
  let pending;
  await worker.scheduled({}, env, { waitUntil: promise => { pending = promise; } });
  await pending;
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.state.paused, true);
  assert.equal(snapshot.state.lastRunAt, null);
});

test("state API rejects unknown fields instead of silently dropping them", async () => {
  const { env, coordinator } = environment();
  const response = await worker.fetch(request("/api/state", "PUT", {
    balance: 88, walletPrivateKey: "must-not-be-stored"
  }), env);
  assert.equal(response.status, 400);
  assert.equal((await coordinator.snapshot()).initialized, false);
});

test("state API rejects malformed metadata before persistence", async () => {
  const { env, coordinator } = environment();
  const response = await worker.fetch(request("/api/state", "PUT", {
    balance: 88, lastRunAt: 123
  }), env);
  assert.equal(response.status, 400);
  assert.equal((await coordinator.snapshot()).initialized, false);
});


test("unauthenticated requests cannot read or initialize paper state", async () => {
  const { env, coordinator } = environment();
  env.BOT_STATE.get = async () => null;
  const read = await worker.fetch(new Request("https://worker.test/api/state"), env);
  const write = await worker.fetch(new Request("https://worker.test/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ balance: 1 })
  }), env);
  assert.equal(read.status, 401);
  assert.equal(write.status, 401);
  assert.equal((await coordinator.snapshot()).initialized, false);
});


test("health and version routes expose the bound Cloudflare runtime version", async () => {
  const env = { CF_VERSION_METADATA: { id: "preview-version-test-123" } };
  const health = await worker.fetch(new Request("https://worker.test/health"), env);
  const version = await worker.fetch(new Request("https://worker.test/version"), env);
  assert.equal(health.status, 200);
  assert.equal(version.status, 200);
  assert.equal((await health.json()).build, "preview-version-test-123");
  assert.equal((await version.json()).build, "preview-version-test-123");
});

test("health and version routes use a safe local fallback without version metadata", async () => {
  const health = await worker.fetch(new Request("https://worker.test/health"), {});
  const version = await worker.fetch(new Request("https://worker.test/version"), {});
  assert.equal((await health.json()).build, "local-unversioned");
  assert.equal((await version.json()).build, "local-unversioned");
});


test("unauthenticated automation and profile API requests are rejected before state access", async () => {
  const { env, coordinator, touchedKvKeys } = environment();
  env.BOT_STATE.get = async key => {
    touchedKvKeys.push(["get", key]);
    return null;
  };
  const automation = await worker.fetch(new Request("https://worker.test/api/automation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true })
  }), env);
  const profile = await worker.fetch(new Request("https://worker.test/api/profile"), env);
  assert.equal(automation.status, 401);
  assert.equal(profile.status, 401);
  assert.equal((await coordinator.snapshot()).initialized, false);
  assert.ok(!touchedKvKeys.some(([, key]) => key === "bot_state"));
});


test("password login throttles after five failures through the atomic auth Durable Object", async () => {
  const { env, authStorage } = environment();
  const values = new Map();
  env.BOT_LOGIN_PASSWORD = "preview-test-password";
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    return type === "json" && typeof value === "string" ? JSON.parse(value) : value ?? null;
  };
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  for (let i = 0; i < 5; i++) {
    const response = await worker.fetch(new Request("https://worker.test/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
      body: JSON.stringify({ password: "wrong-password" })
    }), env);
    assert.equal(response.status, 401);
  }
  const blocked = await worker.fetch(new Request("https://worker.test/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
    body: JSON.stringify({ password: "preview-test-password" })
  }), env);
  assert.equal(blocked.status, 429);
  const counter = [...authStorage.values.entries()].find(([key]) => key.startsWith("auth:login:"));
  assert.equal(counter?.[1]?.count, 5);
});

test("MFA challenge is deleted after five invalid codes", async () => {
  const { env, authStorage } = environment();
  const values = new Map([
    ["admin_profile", JSON.stringify({ totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP", backupHash: null })],
    ["mfa_challenge:test-challenge", JSON.stringify({ createdAt: Date.now(), attempts: 0, emailVerified: true })]
  ]);
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    return type === "json" && typeof value === "string" ? JSON.parse(value) : value ?? null;
  };
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  for (let i = 0; i < 5; i++) {
    const response = await worker.fetch(new Request("https://worker.test/api/login/totp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.20" },
      body: JSON.stringify({ challengeId: "test-challenge", code: "000000" })
    }), env);
    assert.equal(response.status, 401);
  }
  const blocked = await worker.fetch(new Request("https://worker.test/api/login/totp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.20" },
    body: JSON.stringify({ challengeId: "test-challenge", code: "000000" })
  }), env);
  assert.equal(blocked.status, 429);
  assert.equal(values.has("mfa_challenge:test-challenge"), false);
  const ipCounter = [...authStorage.values.entries()].find(([key]) => key.startsWith("auth:mfa-ip:"));
  const challengeCounter = authStorage.values.get("auth:mfa-challenge:test-challenge");
  assert.equal(ipCounter?.[1]?.count, 5);
  assert.equal(challengeCounter?.count, 5);
});

test("auth limiter alarm removes expired counters and preserves active windows", async () => {
  const { authLimiter, authStorage } = environment();
  const now = Date.now();
  authStorage.values.set("auth:login:expired", { count: 5, expiresAt: now - 1 });
  authStorage.values.set("auth:login:active", { count: 2, expiresAt: now + 60_000 });
  authStorage.values.set("unrelated:key", { count: 99, expiresAt: now - 1 });
  await authLimiter.alarm();
  assert.equal(authStorage.values.has("auth:login:expired"), false);
  assert.equal(authStorage.values.get("auth:login:active")?.count, 2);
  assert.equal(authStorage.values.has("unrelated:key"), true);
  assert.equal(authStorage.alarmAt, now + 60_000);
});

test("MFA attempt reservations are atomic under concurrent requests", async () => {
  const { authLimiter } = environment();
  const ipHash = "a".repeat(64);
  const results = await Promise.all(
    Array.from({ length: 12 }, () => authLimiter.reserveMfa(ipHash, "parallel-challenge"))
  );
  assert.equal(results.filter(result => result.allowed).length, 5);
  assert.equal(results.filter(result => result.reason === "challenge").length, 7);
});


test("diagnostic screen route is hidden unless explicitly enabled", async () => {
  const { env } = environment();
  env.ASSETS = { fetch: async () => new Response("Not found", { status: 404 }) };
  const hidden = await worker.fetch(new Request("https://worker.test/screen-test"), env);
  assert.equal(hidden.status, 404);
  env.ENABLE_DIAGNOSTIC_ROUTES = "true";
  const enabled = await worker.fetch(new Request("https://worker.test/screen-test"), env);
  assert.equal(enabled.status, 200);
  assert.match(await enabled.text(), /SCREEN TEST OK/);
});

test("backup-code credential claims are atomic under concurrent login attempts", async () => {
  const { authLimiter, authStorage } = environment();
  const backupCode = "ABCD1234EFGH5678";
  const backupHash = createHash("sha256").update(backupCode).digest("hex");
  const credentialHash = createHash("sha256").update("backup:" + backupHash).digest("hex");
  const claims = await Promise.all(
    Array.from({ length: 12 }, () => authLimiter.claimMfaCredential(credentialHash))
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(authStorage.values.has("auth:mfa-credential:" + credentialHash), true);
});

test("auth limiter alarm cleans expired MFA claims and retains active claims", async () => {
  const { authLimiter, authStorage } = environment();
  const now = Date.now();
  authStorage.values.set("auth:mfa-challenge-claim:expired", { expiresAt: now - 1 });
  authStorage.values.set("auth:mfa-credential:expired", { expiresAt: now - 1 });
  authStorage.values.set("auth:totp-setup-claim:expired", { expiresAt: now - 1 });
  authStorage.values.set("auth:mfa-challenge-claim:active", { expiresAt: now + 120_000 });
  await authLimiter.alarm();
  assert.equal(authStorage.values.has("auth:mfa-challenge-claim:expired"), false);
  assert.equal(authStorage.values.has("auth:mfa-credential:expired"), false);
  assert.equal(authStorage.values.has("auth:totp-setup-claim:expired"), false);
  assert.equal(authStorage.values.get("auth:mfa-challenge-claim:active")?.expiresAt, now + 120_000);
  assert.equal(authStorage.alarmAt, now + 120_000);
});

test("MFA login challenge claims are atomic and single-use", async () => {
  const { authLimiter, authStorage } = environment();
  const challengeId = "challenge-atomic-123";
  const claims = await Promise.all(
    Array.from({ length: 12 }, () => authLimiter.claimMfaChallenge(challengeId))
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(authStorage.values.has("auth:mfa-challenge-claim:" + challengeId), true);
  await authLimiter.releaseMfaChallenge(challengeId);
  assert.equal(authStorage.values.has("auth:mfa-challenge-claim:" + challengeId), false);
});

test("MFA credential claims are atomic and prevent concurrent replay", async () => {
  const { authLimiter, authStorage } = environment();
  const credentialHash = "f".repeat(64);
  const claims = await Promise.all(
    Array.from({ length: 12 }, () => authLimiter.claimMfaCredential(credentialHash))
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(authStorage.values.has("auth:mfa-credential:" + credentialHash), true);
  await authLimiter.releaseMfaCredential(credentialHash);
  assert.equal(authStorage.values.has("auth:mfa-credential:" + credentialHash), false);
});

test("TOTP setup confirmation is throttled atomically per IP", async () => {
  const { authLimiter, authStorage } = environment();
  const ipHash = "b".repeat(64);
  const results = await Promise.all(
    Array.from({ length: 12 }, () => authLimiter.reserveTotpSetup(ipHash))
  );
  assert.equal(results.filter(result => result.allowed).length, 5);
  assert.equal(results.filter(result => result.reason === "ip").length, 7);
  assert.equal(authStorage.values.get("auth:totp-setup:" + ipHash)?.count, 5);
  await authLimiter.clearTotpSetup(ipHash);
  assert.equal(authStorage.values.has("auth:totp-setup:" + ipHash), false);
});

test("auth limiter rejects malformed claim identifiers and hashes as bad requests", async () => {
  const { authLimiter } = environment();
  const invalidRequests = [
    ["/mfa-challenge-claim", { challengeId: "../bad" }],
    ["/mfa-credential-claim", { credentialHash: "not-a-hash" }]
  ];
  for (const [path, body] of invalidRequests) {
    const response = await authLimiter.fetch(new Request("https://auth-rate-limit.internal" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }));
    assert.equal(response.status, 400, path + " must reject malformed input");
  }
});

test("auth limiter storage failures return service unavailable", async () => {
  const { authLimiter, authStorage } = environment();
  authStorage.transaction = async () => { throw new Error("storage unavailable"); };
  const response = await authLimiter.fetch(new Request("https://auth-rate-limit.internal/totp-setup-attempt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ipHash: "c".repeat(64) })
  }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /storage unavailable/);
});

test("concurrent TOTP setup confirmations can claim a pending secret only once", async () => {
  const { authLimiter, authStorage } = environment();
  const secretHash = "d".repeat(64);
  const claims = await Promise.all(
    Array.from({ length: 10 }, () => authLimiter.claimTotpSetup(secretHash))
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(authStorage.values.has("auth:totp-setup-claim:" + secretHash), true);
  await authLimiter.releaseTotpSetup(secretHash);
  assert.equal(authStorage.values.has("auth:totp-setup-claim:" + secretHash), false);
});

test("TOTP setup claim expires and can be acquired again", async () => {
  const { authLimiter, authStorage } = environment();
  const secretHash = "e".repeat(64);
  assert.equal(await authLimiter.claimTotpSetup(secretHash), true);
  authStorage.values.set("auth:totp-setup-claim:" + secretHash, { expiresAt: Date.now() - 1 });
  assert.equal(await authLimiter.claimTotpSetup(secretHash), true);
});

test("TOTP setup and confirmation routes require an authenticated admin session", async () => {
  const { env } = environment();
  for (const [path, method, body] of [
    ["/api/totp/setup", "POST", {}],
    ["/api/totp/confirm", "POST", { code: "123456" }]
  ]) {
    const response = await worker.fetch(new Request("https://worker.test" + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }), env);
    assert.equal(response.status, 401, path + " must reject unauthenticated access");
  }
});


test("enabling MFA invalidates sessions issued before MFA activation", async () => {
  const { env } = environment();
  const values = new Map([
    ["session:old-session", { expiresAt: Date.now() + 60000, authVersion: 0 }],
    ["admin_profile", { totpEnabled: true, authVersion: 1 }]
  ]);
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    if (value == null) return null;
    return type === "json" ? value : JSON.stringify(value);
  };
  const response = await worker.fetch(new Request("https://worker.test/api/state", {
    headers: { Authorization: "Bearer old-session" }
  }), env);
  assert.equal(response.status, 401);
});

test("current session generation remains authorized after MFA activation", async () => {
  const { env, coordinator } = environment();
  await coordinator.importOnce({
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  });
  env.BOT_STATE.get = async (key, type) => {
    if (key === "session:current-session") {
      const session = { expiresAt: Date.now() + 60000, authVersion: 3 };
      return type === "json" ? session : JSON.stringify(session);
    }
    if (key === "admin_profile") {
      const profile = { totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP", authVersion: 3 };
      return type === "json" ? profile : JSON.stringify(profile);
    }
    return null;
  };
  const response = await worker.fetch(new Request("https://worker.test/api/state", {
    headers: { Authorization: "Bearer current-session" }
  }), env);
  assert.equal(response.status, 200);
});

test("expired and missing admin sessions cannot read paper state", async () => {
  const { env, coordinator } = environment();
  await coordinator.importOnce({
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  });
  const sessions = new Map([
    ["session:expired-session", { expiresAt: Date.now() - 1, authVersion: 0 }]
  ]);
  env.BOT_STATE.get = async (key, type) => {
    const value = sessions.get(key);
    if (value == null) return null;
    return type === "json" ? value : JSON.stringify(value);
  };
  for (const token of ["expired-session", "missing-session"]) {
    const response = await worker.fetch(new Request("https://worker.test/api/state", {
      headers: { Authorization: "Bearer " + token }
    }), env);
    assert.equal(response.status, 401, token + " must not access paper state");
  }
});

test("session with a stale auth generation cannot mutate paper state", async () => {
  const { env, coordinator } = environment();
  await coordinator.importOnce({
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  });
  const values = new Map([
    ["session:stale-generation", { expiresAt: Date.now() + 60000, authVersion: 4 }],
    ["admin_profile", { authVersion: 5, totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP" }]
  ]);
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    if (value == null) return null;
    return type === "json" ? value : JSON.stringify(value);
  };
  const response = await worker.fetch(new Request("https://worker.test/api/state", {
    method: "PUT",
    headers: { Authorization: "Bearer stale-generation", "Content-Type": "application/json" },
    body: JSON.stringify({ balance: 1 })
  }), env);
  assert.equal(response.status, 401);
  assert.equal((await coordinator.snapshot()).state.balance, 100);
});

test("authenticated logout revokes the current server session", async () => {
  const { env, touchedKvKeys } = environment();
  const response = await worker.fetch(request("/api/logout", "POST"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.ok(touchedKvKeys.some(([operation, key]) =>
    operation === "delete" && key === "session:test-session"
  ));
});

test("state status reports authoritative Durable Object initialization metadata", async () => {
  const { env, coordinator } = environment();
  const empty = await worker.fetch(request("/api/state/status"), env);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { initialized: false, version: 0, imported: false });

  await coordinator.importOnce({
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  });
  const initialized = await worker.fetch(request("/api/state/status"), env);
  assert.deepEqual(await initialized.json(), { initialized: true, version: 1, imported: true });
});

test("migration import endpoint is atomic and cannot overwrite an initialized default-looking state", async () => {
  const { env, coordinator } = environment();
  const initial = {
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  };
  await coordinator.importOnce(initial);
  const before = await worker.fetch(request("/api/state"), env);
  assert.equal((await before.json()).updatedAt, null);

  const overwrite = await worker.fetch(request("/api/state/import", "POST", {
    ...initial, lastMessage: "replacement"
  }), env);
  assert.equal(overwrite.status, 409);
  assert.equal((await coordinator.snapshot()).state.lastMessage, "ready");
});

test("migration import endpoint initializes only once on a proven empty coordinator", async () => {
  const { env, coordinator } = environment();
  const initial = {
    balance: 77, trades: [{ mint: "legacy-token", amount: 2 }],
    autoEnabled: false, paused: false, scannedMints: [], deferredMints: [],
    lastRunAt: null, lastMessage: "legacy import", lastScanReport: [], updatedAt: null
  };
  const response = await worker.fetch(request("/api/state/import", "POST", initial), env);
  assert.equal(response.status, 200);
  assert.equal((await coordinator.snapshot()).state.balance, 77);
  const repeated = await worker.fetch(request("/api/state/import", "POST", initial), env);
  assert.equal(repeated.status, 409);
  assert.equal((await coordinator.snapshot()).state.balance, 77);
});


test("migration status and import endpoints reject requests without an admin session", async () => {
  const { env, coordinator } = environment();
  const status = await worker.fetch(new Request("https://worker.test/api/state/status"), env);
  assert.equal(status.status, 401);
  const imported = await worker.fetch(new Request("https://worker.test/api/state/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      balance: 50, trades: [], autoEnabled: false, paused: false,
      scannedMints: [], deferredMints: [], lastRunAt: null,
      lastMessage: "unauthorized", lastScanReport: [], updatedAt: null
    })
  }), env);
  assert.equal(imported.status, 401);
  assert.equal((await coordinator.snapshot()).initialized, false);
});

test("enabled MFA with missing secret fails closed instead of granting a password-only session", async () => {
  const { env } = environment();
  env.BOT_LOGIN_PASSWORD = "preview-test-password";
  const stored = new Map([["admin_profile", JSON.stringify({ totpEnabled: true, totpSecret: null })]]);
  env.BOT_STATE.get = async (key) => {
    if (key === "admin_profile") return JSON.parse(stored.get(key));
    return null;
  };
  env.BOT_STATE.put = async (key, value) => { stored.set(key, value); };
  env.BOT_STATE.delete = async key => { stored.delete(key); };
  const response = await worker.fetch(new Request("https://worker.test/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "preview-test-password" })
  }), env);
  assert.equal(response.status, 503);
  assert.equal([...stored.keys()].some(key => key.startsWith("session:")), false);
});


test("backup code cannot authenticate after MFA is disabled or loses its secret", async () => {
  const { env } = environment();
  const backupCode = "ABCD1234EFGH5678";
  const backupHash = createHash("sha256").update(backupCode).digest("hex");
  const values = new Map([
    ["mfa_challenge:pending", JSON.stringify({ createdAt: Date.now(), attempts: 0 })]
  ]);
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    return type === "json" && typeof value === "string" ? JSON.parse(value) : value ?? null;
  };
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  for (const profile of [
    { totpEnabled: false, totpSecret: "JBSWY3DPEHPK3PXP", backupHash },
    { totpEnabled: true, totpSecret: null, backupHash }
  ]) {
    values.set("admin_profile", JSON.stringify(profile));
    const response = await worker.fetch(new Request("https://worker.test/api/login/totp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.67" },
      body: JSON.stringify({ challengeId: "pending", code: backupCode })
    }), env);
    assert.equal(response.status, 401);
    assert.equal([...values.keys()].some(key => key.startsWith("session:")), false);
  }
});

test("blank MFA secret is rejected before issuing a challenge", async () => {
  const { env } = environment();
  env.BOT_LOGIN_PASSWORD = "preview-test-password";
  const values = new Map([["admin_profile", JSON.stringify({ totpEnabled: true, totpSecret: "  " })]]);
  env.BOT_STATE.get = async key => key === "admin_profile" ? JSON.parse(values.get(key)) : null;
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  const response = await worker.fetch(new Request("https://worker.test/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "preview-test-password" })
  }), env);
  assert.equal(response.status, 503);
  assert.equal([...values.keys()].some(key => key.startsWith("session:") || key.startsWith("mfa_challenge:")), false);
});

test("email OTP send quota is reserved atomically under concurrent requests", async () => {
  const storage = new MemoryStorage();
  const limiter = new MfaRateLimiter({ storage });
  const ipHash = createHash("sha256").update("email-send-test-ip").digest("hex");
  const results = await Promise.all(Array.from({ length: 12 }, () => limiter.reserveEmailSend(ipHash)));
  assert.equal(results.filter(result => result.allowed).length, 3);
  assert.equal(results.filter(result => !result.allowed).length, 9);
});

test("email OTP wrong-code attempt budget is atomic under concurrent requests", async () => {
  const storage = new MemoryStorage();
  const limiter = new MfaRateLimiter({ storage });
  const results = await Promise.all(Array.from({ length: 15 }, () => limiter.reserveEmailAttempt("emailchallenge_test123")));
  assert.equal(results.filter(result => result.allowed).length, 5);
  assert.equal(results.filter(result => !result.allowed).length, 10);
});

test("email OTP challenge can be claimed only once under concurrent success attempts", async () => {
  const storage = new MemoryStorage();
  const limiter = new MfaRateLimiter({ storage });
  const results = await Promise.all(Array.from({ length: 10 }, () => limiter.claimEmailChallenge("emailchallenge_replay")));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter(value => !value).length, 9);
});


test("Gmail OTP login issues no session until correct code and rejects replay", async () => {
  const { env, authStorage } = environment();
  env.BOT_LOGIN_PASSWORD = "otp-test-password";
  env.ADMIN_EMAIL = "admin@example.com";
  env.RESEND_API_KEY = "test-resend-key";
  const values = new Map();
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    return type === "json" && typeof value === "string" ? JSON.parse(value) : value ?? null;
  };
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  const originalFetch = globalThis.fetch;
  let deliveredCode = "";
  globalThis.fetch = async (_url, init) => {
    const mail = JSON.parse(init.body);
    deliveredCode = mail.text.match(/\d{6}/)?.[0] || "";
    return new Response(JSON.stringify({ id: "preview-email" }), { status: 200 });
  };
  try {
    const login = await worker.fetch(new Request("https://worker.test/api/login", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.90" },
      body: JSON.stringify({ password: env.BOT_LOGIN_PASSWORD })
    }), env);
    assert.equal(login.status, 200);
    const challenge = await login.json();
    assert.equal(challenge.emailOtpRequired, true);
    assert.equal(deliveredCode.length, 6);
    assert.equal([...values.keys()].some(key => key.startsWith("session:")), false);

    const bad = await worker.fetch(new Request("https://worker.test/api/login/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, code: "999999" })
    }), env);
    assert.equal(bad.status, 401);
    assert.equal([...values.keys()].some(key => key.startsWith("session:")), false);

    const verified = await worker.fetch(new Request("https://worker.test/api/login/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, code: deliveredCode })
    }), env);
    assert.equal(verified.status, 200);
    const session = await verified.json();
    assert.ok(session.token);
    assert.equal(values.has("email_login_challenge:" + challenge.challengeId), false);
    assert.equal(values.has("session:" + session.token), true);

    const replay = await worker.fetch(new Request("https://worker.test/api/login/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, code: deliveredCode })
    }), env);
    assert.equal(replay.status, 401);
    assert.equal(authStorage.values.has("auth:email-challenge-claim:" + challenge.challengeId), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired Gmail OTP challenge cannot create a session", async () => {
  const { env } = environment();
  const values = new Map([["email_login_challenge:expired_test", JSON.stringify({
    codeHash: "irrelevant", createdAt: Date.now() - 601000
  })]]);
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    return type === "json" && typeof value === "string" ? JSON.parse(value) : value ?? null;
  };
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  const response = await worker.fetch(new Request("https://worker.test/api/login/email", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: "expired_test", code: "123456" })
  }), env);
  assert.equal(response.status, 401);
  assert.equal([...values.keys()].some(key => key.startsWith("session:")), false);
});

test("malformed Gmail OTP timestamps fail closed without issuing a session", async () => {
  const invalidCreatedAt = [undefined, "not-a-timestamp", NaN, 0, -1, Date.now() + 60000];
  for (const [index, createdAt] of invalidCreatedAt.entries()) {
    const { env } = environment();
    const challenge = { codeHash: "irrelevant" };
    if (createdAt !== undefined) challenge.createdAt = createdAt;
    const values = new Map([[\`email_login_challenge:bad_time_\${index}\`, JSON.stringify(challenge)]]);
    env.BOT_STATE.get = async (key, type) => {
      const value = values.get(key);
      return type === "json" && typeof value === "string" ? JSON.parse(value) : value ?? null;
    };
    env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
    env.BOT_STATE.delete = async key => { values.delete(key); };
    const response = await worker.fetch(new Request("https://worker.test/api/login/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId: \`bad_time_\${index}\`, code: "123456" })
    }), env);
    assert.equal(response.status, 401);
    assert.equal([...values.keys()].some(key => key.startsWith("session:")), false);
  }
});

test("Gmail OTP delivery failure cleans the pending challenge and fails closed", async () => {
  const { env } = environment();
  env.BOT_LOGIN_PASSWORD = "otp-test-password";
  env.ADMIN_EMAIL = "admin@example.com";
  env.RESEND_API_KEY = "test-resend-key";
  const values = new Map();
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    return type === "json" && typeof value === "string" ? JSON.parse(value) : value ?? null;
  };
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("provider error", { status: 500 });
  try {
    const response = await worker.fetch(new Request("https://worker.test/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.BOT_LOGIN_PASSWORD })
    }), env);
    assert.equal(response.status, 503);
    assert.equal([...values.keys()].some(key => key.startsWith("email_login_challenge:")), false);
    assert.equal([...values.keys()].some(key => key.startsWith("session:")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail verification precedes TOTP and creates an email-verified MFA challenge", async () => {
  const { env } = environment();
  env.BOT_LOGIN_PASSWORD = "otp-test-password";
  env.ADMIN_EMAIL = "admin@example.com";
  env.RESEND_API_KEY = "test-resend-key";
  const values = new Map([["admin_profile", JSON.stringify({
    totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP", backupHash: null, authVersion: 2
  })]]);
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    return type === "json" && typeof value === "string" ? JSON.parse(value) : value ?? null;
  };
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  const originalFetch = globalThis.fetch;
  let deliveredCode = "";
  globalThis.fetch = async (_url, init) => {
    deliveredCode = JSON.parse(init.body).text.match(/\d{6}/)?.[0] || "";
    return new Response("{}", { status: 200 });
  };
  try {
    const login = await worker.fetch(new Request("https://worker.test/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.BOT_LOGIN_PASSWORD })
    }), env);
    const first = await login.json();
    assert.equal(first.emailOtpRequired, true);
    assert.equal([...values.keys()].some(key => key.startsWith("mfa_challenge:")), false);

    const email = await worker.fetch(new Request("https://worker.test/api/login/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId: first.challengeId, code: deliveredCode })
    }), env);
    assert.equal(email.status, 200);
    const totp = await email.json();
    assert.equal(totp.mfaRequired, true);
    assert.equal([...values.keys()].some(key => key.startsWith("session:")), false);
    assert.equal(JSON.parse(values.get("mfa_challenge:" + totp.challengeId)).emailVerified, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Gmail OTP challenge is invalidated after five incorrect code attempts", async () => {
  const { env } = environment();
  env.BOT_LOGIN_PASSWORD = "otp-lockout-test-password";
  env.ADMIN_EMAIL = "admin@example.com";
  env.RESEND_API_KEY = "test-resend-key";
  const values = new Map();
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    return type === "json" && typeof value === "string" ? JSON.parse(value) : value ?? null;
  };
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  const originalFetch = globalThis.fetch;
  let deliveredCode = "";
  globalThis.fetch = async (_url, init) => {
    deliveredCode = JSON.parse(init.body).text.match(/\d{6}/)?.[0] || "";
    return new Response("{}", { status: 200 });
  };
  try {
    const login = await worker.fetch(new Request("https://worker.test/api/login", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.91" },
      body: JSON.stringify({ password: env.BOT_LOGIN_PASSWORD })
    }), env);
    assert.equal(login.status, 200);
    const { challengeId } = await login.json();
    const wrongCode = deliveredCode === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      const attempt = await worker.fetch(new Request("https://worker.test/api/login/email", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, code: wrongCode })
      }), env);
      assert.equal(attempt.status, 401);
    }
    const exhausted = await worker.fetch(new Request("https://worker.test/api/login/email", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, code: wrongCode })
    }), env);
    assert.equal(exhausted.status, 429);
    assert.equal(values.has("email_login_challenge:" + challengeId), false);
    assert.equal([...values.keys()].some(key => key.startsWith("session:")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
