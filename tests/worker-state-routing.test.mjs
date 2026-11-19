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
    ["mfa_challenge:test-challenge", JSON.stringify({ createdAt: Date.now(), attempts: 0 })]
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

test("concurrent MFA login requests cannot reuse the same backup code", async () => {
  const { env } = environment();
  const backupCode = "ABCD1234EFGH5678";
  const backupHash = createHash("sha256").update(backupCode).digest("hex");
  const values = new Map([
    ["admin_profile", JSON.stringify({ totpEnabled: false, totpSecret: null, backupHash })],
    ["mfa_challenge:parallel-login", JSON.stringify({ createdAt: Date.now(), attempts: 0 })]
  ]);
  env.BOT_STATE.get = async (key, type) => {
    const value = values.get(key);
    if (value === undefined) return null;
    return type === "json" && typeof value === "string" ? JSON.parse(value) : value;
  };
  env.BOT_STATE.put = async (key, value) => { values.set(key, value); };
  env.BOT_STATE.delete = async key => { values.delete(key); };
  const submit = () => worker.fetch(new Request("https://worker.test/api/login/totp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.44" },
    body: JSON.stringify({ challengeId: "parallel-login", code: backupCode })
  }), env);
  const responses = await Promise.all([submit(), submit()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const sessions = [...values.keys()].filter(key => key.startsWith("session:"));
  assert.equal(sessions.length, 1);
  assert.equal(JSON.parse(values.get("admin_profile")).backupHash, null);
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
