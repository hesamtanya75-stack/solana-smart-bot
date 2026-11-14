import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { AuthGuard } from "../auth-guard.mjs";
import { PaperTradingState } from "../paper-trading-state.mjs";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const executableWorkerSource = workerSource
  .replace(/^export default \{/m, "const worker = {")
  .replace(/^export \{[^}]+\} from ["'][^"']+["'];?\s*$/gm, "");
const workerContext = vm.createContext({
  crypto: webcrypto,
  Request,
  Response,
  URL,
  TextEncoder,
  TextDecoder,
  AbortSignal,
  fetch,
  console,
  setTimeout,
  clearTimeout,
  atob,
  btoa,
  structuredClone
});
vm.runInContext(executableWorkerSource + "\nglobalThis.__worker = worker;", workerContext);
const worker = workerContext.__worker;

const INTERNAL_TOKEN = "integration-test-internal-token-0123456789";
const LOGIN_PASSWORD = "integration-test-password";

class TransactionalStorage {
  constructor() {
    this.values = new Map();
    this.tail = Promise.resolve();
  }
  async get(key) { return structuredClone(this.values.get(key)); }
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

class MemoryKV {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  }
  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, String(value)); }
  async delete(key) { this.values.delete(key); }
}

function makeEnvironment(profile = null) {
  const initial = profile ? { admin_profile: profile } : {};
  const storage = new TransactionalStorage();
  const kv = new MemoryKV(initial);
  const guard = new AuthGuard({ storage }, { AUTH_GUARD_INTERNAL_TOKEN: INTERNAL_TOKEN });
  const paperStorage = new TransactionalStorage();
  const paperState = new PaperTradingState({ storage: paperStorage }, { BOT_STATE: kv });
  const env = {
    BOT_LOGIN_PASSWORD: LOGIN_PASSWORD,
    BOT_STATE: kv,
    AUTH_GUARD_INTERNAL_TOKEN: INTERNAL_TOKEN,
    AUTH_GUARD: {
      idFromName: name => name,
      get: () => ({ fetch: (input, init) => guard.fetch(new Request(input, init)) })
    },
    PAPER_TRADING_STATE: {
      idFromName: name => name,
      get: () => ({ fetch: (input, init) => paperState.fetch(new Request(input, init)) })
    }
  };
  return { env, guard, paperState };
}

async function post(path, body, env, headers = {}) {
  return worker.fetch(new Request("https://bot.example" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://bot.example", "Sec-Fetch-Site": "same-origin", ...headers },
    body: JSON.stringify(body)
  }), env);
}

async function get(path, env, token) {
  return worker.fetch(new Request("https://bot.example" + path, {
    method: "GET",
    headers: token ? { Authorization: "Bearer " + token } : {}
  }), env);
}

async function put(path, body, env, token) {
  return worker.fetch(new Request("https://bot.example" + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, Origin: "https://bot.example", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify(body)
  }), env);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function totpCode(secret, counter) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const key = await crypto.subtle.importKey("raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const message = new Uint8Array(8);
  let n = counter;
  for (let i = 7; i >= 0; i--) { message[i] = n & 255; n = Math.floor(n / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 127) << 24) | ((mac[offset + 1] & 255) << 16) | ((mac[offset + 2] & 255) << 8) | (mac[offset + 3] & 255);
  return String(binary % 1000000).padStart(6, "0");
}

test("Worker login migrates legacy MFA and enforces one-time TOTP and backup codes", async () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const backupCode = "ABCD1234EFGH5678";
  const { env, guard } = makeEnvironment({
    email: "admin@example.test",
    phone: "",
    emailVerified: false,
    phoneVerified: false,
    totpEnabled: true,
    totpSecret: secret,
    backupHash: await sha256(backupCode),
    lastTotpCounter: -1
  });

  const login = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  assert.equal(login.status, 200);
  assert.equal(await env.BOT_STATE.get("auth_guard_migration_v1"), "complete");
  const legacyProfile = JSON.parse(await env.BOT_STATE.get("admin_profile"));
  for (const field of ["totpSecret", "pendingTotpSecret", "pendingTotpAt", "backupHash", "lastTotpCounter"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(legacyProfile, field), false, `legacy MFA field ${field} must be removed from KV`);
  }
  const challenge = await login.json();
  assert.equal(challenge.mfaRequired, true);

  const code = await totpCode(secret, Math.floor(Date.now() / 30000));
  const verified = await post("/api/login/totp", {
    challengeId: challenge.challengeId,
    code
  }, env);
  assert.equal(verified.status, 200);
  const session = await verified.json();
  assert.equal(typeof session.token, "string");

  const replay = await post("/api/login/totp", {
    challengeId: challenge.challengeId,
    code
  }, env);
  assert.equal(replay.status, 401);

  const backupLogin = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  const backupChallenge = await backupLogin.json();
  const backupVerified = await post("/api/login/totp", {
    challengeId: backupChallenge.challengeId,
    code: backupCode
  }, env);
  assert.equal(backupVerified.status, 200);

  const afterBackup = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  const afterBackupChallenge = await afterBackup.json();
  const reusedBackup = await post("/api/login/totp", {
    challengeId: afterBackupChallenge.challengeId,
    code: backupCode
  }, env);
  assert.equal(reusedBackup.status, 401);
  assert.equal((await guard.getProfile()).totpEnabled, true);
});

test("Worker TOTP setup and confirmation persist MFA state in AuthGuard", async () => {
  const { env } = makeEnvironment();
  const login = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const authHeader = { Authorization: "Bearer " + token };

  const setupWithoutPassword = await post("/api/totp/setup", {}, env, authHeader);
  assert.equal(setupWithoutPassword.status, 401);
  const setupWithWrongPassword = await post("/api/totp/setup", { password: "incorrect-password" }, env, authHeader);
  assert.equal(setupWithWrongPassword.status, 401);
  const limitedSetupAttempts = await Promise.all(Array.from({ length: 5 }, () =>
    post("/api/totp/setup", { password: "wrong-password" }, env, {
      ...authHeader,
      "CF-Connecting-IP": "203.0.113.44"
    })
  ));
  assert.equal(limitedSetupAttempts.filter(response => response.status === 401).length, 4);
  assert.equal(limitedSetupAttempts.filter(response => response.status === 429).length, 1);
  const setup = await post("/api/totp/setup", { password: LOGIN_PASSWORD }, env, authHeader);
  assert.equal(setup.status, 200);
  const setupBody = await setup.json();
  assert.equal(typeof setupBody.secret, "string");

  const code = await totpCode(setupBody.secret, Math.floor(Date.now() / 30000));
  const confirm = await post("/api/totp/confirm", { code }, env, authHeader);
  assert.equal(confirm.status, 200);
  const confirmed = await confirm.json();
  assert.equal(typeof confirmed.backupCode, "string");

  const profile = await get("/api/profile", env, token);
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).totpEnabled, true);

  const nextLogin = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  assert.equal(nextLogin.status, 200);
  assert.equal((await nextLogin.json()).mfaRequired, true);
});

test("Worker logout revokes the bearer session immediately", async () => {
  const { env } = makeEnvironment();
  const login = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  assert.equal(login.status, 200);
  const { token } = await login.json();

  const beforeLogout = await get("/api/profile", env, token);
  assert.equal(beforeLogout.status, 200);

  const logout = await post("/api/logout", {}, env, {
    Authorization: "Bearer " + token
  });
  assert.equal(logout.status, 200);
  assert.equal(await env.BOT_STATE.get("session:" + token, "json"), null);

  const afterLogout = await get("/api/profile", env, token);
  assert.equal(afterLogout.status, 401);
});

test("Worker rejects expired bearer sessions", async () => {
  const { env } = makeEnvironment();
  const token = "expired-integration-session";
  await env.BOT_STATE.put("session:" + token, JSON.stringify({
    expiresAt: Date.now() - 1
  }));

  const response = await get("/api/profile", env, token);
  assert.equal(response.status, 401);
});

test("concurrent bad password attempts are atomically throttled by AuthGuard", async () => {
  const { env, guard } = makeEnvironment();
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    post("/api/login", { password: "wrong-password" }, env, { "CF-Connecting-IP": "203.0.113.25" })
  ));
  const statuses = await Promise.all(results.map(response => response.status));
  assert.equal(statuses.filter(status => status === 401).length, 4);
  assert.equal(statuses.filter(status => status === 429).length, 8);
  const scope = "login:" + await sha256("203.0.113.25");
  assert.equal(await guard.isRateLimited(scope), true);
});


test("Worker migrates an active legacy password rate limit before checking login", async () => {
  const { env, guard } = makeEnvironment();
  const legacyKey = "login_fail:203.0.113.90";
  await env.BOT_STATE.put(legacyKey, JSON.stringify({ count: 5 }));
  const response = await post("/api/login", { password: LOGIN_PASSWORD }, env, {
    "CF-Connecting-IP": "203.0.113.90"
  });
  assert.equal(response.status, 429);
  assert.equal(await env.BOT_STATE.get(legacyKey), null);
  assert.equal(await guard.isRateLimited("login:" + await sha256("203.0.113.90")), true);
});


test("Worker preserves legacy MFA data when initialized AuthGuard state does not match it", async () => {
  const legacySecret = "JBSWY3DPEHPK3PXP";
  const { env, guard } = makeEnvironment({
    totpEnabled: true,
    totpSecret: legacySecret,
    backupHash: await sha256("ABCD1234EFGH5678"),
    lastTotpCounter: 123
  });
  await guard.initializeFromLegacy({
    totpEnabled: true,
    totpSecret: "KRUGS4ZANFZSAYJA",
    backupHash: await sha256("DIFFERENT-BACKUP-CODE"),
    lastTotpCounter: 122
  });

  const response = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  assert.equal(response.status, 503);
  assert.equal(await env.BOT_STATE.get("auth_guard_migration_v1"), null);
  const legacyProfile = await env.BOT_STATE.get("admin_profile", "json");
  assert.equal(legacyProfile.totpSecret, legacySecret);
  assert.equal(legacyProfile.lastTotpCounter, 123);
  assert.equal(legacyProfile.backupHash, await sha256("ABCD1234EFGH5678"));
});

test("Worker refuses to re-import stale KV MFA secrets if migrated Durable Object state is missing", async () => {
  const { env } = makeEnvironment({
    totpEnabled: true,
    totpSecret: "JBSWY3DPEHPK3PXP",
    backupHash: await sha256("ABCD1234EFGH5678"),
    lastTotpCounter: 123
  });
  const first = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  assert.equal(first.status, 200);
  assert.equal(await env.BOT_STATE.get("auth_guard_migration_v1"), "complete");

  const replacementGuard = new AuthGuard({ storage: new TransactionalStorage() }, {
    AUTH_GUARD_INTERNAL_TOKEN: INTERNAL_TOKEN
  });
  env.AUTH_GUARD = {
    idFromName: name => name,
    get: () => ({ fetch: (input, init) => replacementGuard.fetch(new Request(input, init)) })
  };
  const refused = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  assert.equal(refused.status, 503);
  assert.equal((await replacementGuard.getProfile()).initialized, false);
});


test("automation endpoint bounds payloads and rejects unknown or mistyped settings", async () => {
  const { env } = makeEnvironment();
  const login = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const headers = { Authorization: "Bearer " + token };

  const valid = await post("/api/automation", { enabled: true, paused: false }, env, headers);
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).state.autoEnabled, true);

  const unknown = await post("/api/automation", { enabled: false, balance: 999999 }, env, headers);
  assert.equal(unknown.status, 400);

  const mistyped = await post("/api/automation", { paused: "false" }, env, headers);
  assert.equal(mistyped.status, 400);

  const oversized = await post("/api/automation", { enabled: true, padding: "x".repeat(5000) }, env, headers);
  assert.equal(oversized.status, 400);

  const state = await (await get("/api/state", env, token)).json();
  assert.equal(state.autoEnabled, true);
  assert.equal(state.balance, 100);
});


test("Worker exposes one-time paper-state migration and rejects stale repeat writes", async () => {
  const { env } = makeEnvironment();
  const login = await post("/api/login", { password: LOGIN_PASSWORD }, env);
  assert.equal(login.status, 200);
  const { token } = await login.json();

  const initialResponse = await get("/api/state", env, token);
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.equal(initial.canMigrateLegacy, true);
  assert.equal(initial.revision, 0);

  const migration = await put("/api/state", {
    expectedRevision: initial.revision,
    balance: 82.5,
    trades: [],
    autoEnabled: false,
    paused: false,
    scannedMints: []
  }, env, token);
  assert.equal(migration.status, 200);
  const migrated = await migration.json();
  assert.equal(migrated.state.balance, 82.5);
  assert.equal(migrated.revision, 1);

  const stale = await put("/api/state", {
    expectedRevision: migrated.revision,
    balance: 999,
    trades: [],
    autoEnabled: false,
    paused: false,
    scannedMints: []
  }, env, token);
  assert.equal(stale.status, 409);

  const currentResponse = await get("/api/state", env, token);
  const current = await currentResponse.json();
  assert.equal(current.balance, 82.5);
  assert.equal(current.canMigrateLegacy, false);
});
