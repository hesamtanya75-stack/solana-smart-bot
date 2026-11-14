import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { AuthGuard } from "../auth-guard.mjs";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const executableWorkerSource = workerSource
  .replace(/^export default \\{/m, "const worker = {")
  .replace(/^export \\{[^}]+\\} from ["'][^"']+["'];?\\s*$/gm, "");
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
vm.runInContext(executableWorkerSource + "\\nglobalThis.__worker = worker;", workerContext);
const worker = workerContext.__worker;

const INTERNAL_TOKEN = "integration-test-internal-token-0123456789";
const LOGIN_PASSWORD = "integration-test-password";

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
  const guard = new AuthGuard({ storage }, { AUTH_GUARD_INTERNAL_TOKEN: INTERNAL_TOKEN });
  const env = {
    BOT_LOGIN_PASSWORD: LOGIN_PASSWORD,
    BOT_STATE: new MemoryKV(initial),
    AUTH_GUARD_INTERNAL_TOKEN: INTERNAL_TOKEN,
    AUTH_GUARD: {
      idFromName: name => name,
      get: () => ({ fetch: request => guard.fetch(request) })
    }
  };
  return { env, guard };
}

async function post(path, body, env, headers = {}) {
  return worker.fetch(new Request("https://bot.example" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  }), env);
}

async function get(path, env, token) {
  return worker.fetch(new Request("https://bot.example" + path, {
    method: "GET",
    headers: token ? { Authorization: "Bearer " + token } : {}
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

  const setup = await post("/api/totp/setup", {}, env, authHeader);
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
