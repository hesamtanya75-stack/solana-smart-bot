/**
 * Isolated authentication guard Durable Object.
 *
 * Authentication state and MFA operations are serialized through Durable Object
 * storage transactions. The existing LIVE_TRADE_COORDINATOR remains separate.
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const MAX_FAILURE_BUCKETS = 1000;

function validScope(scope) {
  return typeof scope === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(scope);
}

function pruneExpiredFailures(state, now) {
  state.failures ||= {};
  for (const [key, entry] of Object.entries(state.failures)) {
    if (!Number.isSafeInteger(entry?.resetAt) || entry.resetAt <= now) delete state.failures[key];
  }
}

function failureCapacityReached(state, key) {
  return !Object.prototype.hasOwnProperty.call(state.failures, key) &&
    Object.keys(state.failures).length >= MAX_FAILURE_BUCKETS;
}

async function readJsonBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing request body");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function validTotpSecret(value) {
  return value === null || (typeof value === "string" && /^[A-Z2-7]{16,64}$/.test(value));
}

async function totpCode(secret, counter) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("Invalid authenticator secret");
    value = (value << 5) | digit;
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

async function matchingTotpCounter(secret, code, now = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code || ""))) return null;
  for (const drift of [0, -30000, 30000]) {
    const counter = Math.floor((now + drift) / 30000);
    if (await totpCode(secret, counter) === String(code)) return counter;
  }
  return null;
}

export class AuthGuard {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async withState(operation) {
    let result;
    await this.ctx.storage.transaction(async txn => {
      const state = (await txn.get("auth_guard_state")) || {
        initialized: false,
        sessionVersion: 0,
        backupHash: null,
        lastTotpCounter: -1,
        failures: {},
        challenges: {},
        totpEnabled: false,
        totpSecret: null,
        pendingTotpSecret: null,
        pendingTotpAt: null
      };
      result = await operation(state);
      await txn.put("auth_guard_state", state);
    });
    return result;
  }

  async consumeBackupCode(submittedHash) {
    if (typeof submittedHash !== "string" || !/^[a-f0-9]{64}$/i.test(submittedHash)) return false;
    return this.withState(state => {
      if (!state.backupHash || !constantTimeEqual(state.backupHash, submittedHash)) return false;
      state.backupHash = null;
      return true;
    });
  }

  async acceptTotpCounter(counter) {
    if (!validCounter(counter)) return false;
    return this.withState(state => {
      if (counter <= Number(state.lastTotpCounter ?? -1)) return false;
      state.lastTotpCounter = counter;
      return true;
    });
  }

  async recordFailure(scope, now = Date.now()) {
    if (!validScope(scope)) {
      throw new Error("Invalid authentication failure scope");
    }
    return this.withState(state => {
      pruneExpiredFailures(state, now);
      const key = "scope:" + scope;
      if (failureCapacityReached(state, key)) {
        const resetAt = Math.min(...Object.values(state.failures).map(entry => entry.resetAt));
        return { count: 5, limited: true, resetAt };
      }
      const current = state.failures[key];
      const active = current && Number(current.resetAt) > now ? current : { count: 0, resetAt: now + 900000 };
      if (Number(active.count || 0) >= 5) {
        state.failures[key] = active;
        return { count: 5, limited: true, resetAt: active.resetAt };
      }
      active.count = Math.min(5, Number(active.count || 0) + 1);
      state.failures[key] = active;
      return { count: active.count, limited: active.count >= 5, resetAt: active.resetAt };
    });
  }

  async clearFailures(scope) {
    if (!validScope(scope)) throw new Error("Invalid authentication failure scope");
    return this.withState(state => {
      delete state.failures["scope:" + scope];
      return true;
    });
  }

  async initializeFromLegacy({
    backupHash = null,
    lastTotpCounter = -1,
    totpEnabled = false,
    totpSecret = null,
    pendingTotpSecret = null,
    pendingTotpAt = null
  } = {}) {
    if (backupHash !== null && (typeof backupHash !== "string" || !/^[a-f0-9]{64}$/i.test(backupHash))) throw new Error("Invalid legacy backup-code hash");
    if (!Number.isSafeInteger(lastTotpCounter) || lastTotpCounter < -1) throw new Error("Invalid legacy TOTP counter");
    if (typeof totpEnabled !== "boolean" || !validTotpSecret(totpSecret) || !validTotpSecret(pendingTotpSecret)) throw new Error("Invalid legacy TOTP profile");
    if (pendingTotpAt !== null && (!Number.isSafeInteger(pendingTotpAt) || pendingTotpAt < 0)) throw new Error("Invalid pending TOTP timestamp");
    if (totpEnabled && !totpSecret) throw new Error("Enabled TOTP profile is missing its secret");
    return this.withState(state => {
      if (state.initialized === true) return false;
      state.backupHash = backupHash ? backupHash.toLowerCase() : null;
      state.lastTotpCounter = lastTotpCounter;
      state.totpEnabled = totpEnabled;
      state.totpSecret = totpSecret;
      state.pendingTotpSecret = pendingTotpSecret;
      state.pendingTotpAt = pendingTotpAt;
      state.initialized = true;
      return true;
    });
  }

  async getProfile() {
    return this.withState(state => ({
      initialized: state.initialized === true,
      sessionVersion: Number.isSafeInteger(state.sessionVersion) && state.sessionVersion >= 0 ? state.sessionVersion : 0,
      totpEnabled: state.totpEnabled === true,
      totpSecret: state.totpSecret || null,
      pendingTotpSecret: state.pendingTotpSecret || null,
      pendingTotpAt: state.pendingTotpAt ?? null
    }));
  }

  async verifyLegacyProfile({
    backupHash = null,
    lastTotpCounter = -1,
    totpEnabled = false,
    totpSecret = null,
    pendingTotpSecret = null,
    pendingTotpAt = null
  } = {}) {
    if ((backupHash !== null && (typeof backupHash !== "string" || !/^[a-f0-9]{64}$/i.test(backupHash))) ||
        !Number.isSafeInteger(lastTotpCounter) || lastTotpCounter < -1 ||
        typeof totpEnabled !== "boolean" || !validTotpSecret(totpSecret) || !validTotpSecret(pendingTotpSecret) ||
        (pendingTotpAt !== null && (!Number.isSafeInteger(pendingTotpAt) || pendingTotpAt < 0))) {
      throw new Error("Invalid legacy verification profile");
    }
    return this.withState(state => state.initialized === true &&
      (state.backupHash || null) === (backupHash ? backupHash.toLowerCase() : null) &&
      Number(state.lastTotpCounter ?? -1) === lastTotpCounter &&
      (state.totpEnabled === true) === totpEnabled &&
      (state.totpSecret || null) === totpSecret &&
      (state.pendingTotpSecret || null) === pendingTotpSecret &&
      (state.pendingTotpAt ?? null) === pendingTotpAt
    );
  }

  async beginTotpSetup(secret, now = Date.now()) {
    if (!validTotpSecret(secret) || !secret || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid TOTP setup");
    return this.withState(state => {
      if (state.totpEnabled) return false;
      state.pendingTotpSecret = secret;
      state.pendingTotpAt = now;
      return true;
    });
  }

  async confirmTotpSetup({ code, backupHash, failureScope, now = Date.now() } = {}) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code) ||
        typeof backupHash !== "string" || !/^[a-f0-9]{64}$/i.test(backupHash) ||
        !validScope(failureScope) || !Number.isSafeInteger(now) || now < 0) {
      throw new Error("Invalid TOTP confirmation");
    }
    return this.withState(async state => {
      pruneExpiredFailures(state, now);
      const key = "scope:" + failureScope;
      if (failureCapacityReached(state, key)) return { ok: false, reason: "rate-limited" };
      const current = state.failures[key];
      if (current && Number(current.resetAt) > now && Number(current.count || 0) >= 5) {
        return { ok: false, reason: "rate-limited" };
      }
      if (state.totpEnabled || !state.pendingTotpSecret ||
          !Number.isSafeInteger(state.pendingTotpAt) || now < state.pendingTotpAt ||
          now - state.pendingTotpAt > 600000) return { ok: false, reason: "expired" };
      const counter = await matchingTotpCounter(state.pendingTotpSecret, code, now);
      if (counter === null || counter <= Number(state.lastTotpCounter ?? -1)) {
        const active = current && Number(current.resetAt) > now
          ? current : { count: 0, resetAt: now + 900000 };
        active.count = Math.min(1000000, Number(active.count || 0) + 1);
        state.failures[key] = active;
        return { ok: false, reason: active.count >= 5 ? "rate-limited" : "invalid" };
      }
      state.totpSecret = state.pendingTotpSecret;
      state.totpEnabled = true;
      state.sessionVersion = (Number.isSafeInteger(state.sessionVersion) && state.sessionVersion >= 0 ? state.sessionVersion : 0) + 1;
      state.lastTotpCounter = counter;
      state.backupHash = backupHash.toLowerCase();
      state.pendingTotpSecret = null;
      state.pendingTotpAt = null;
      delete state.failures[key];
      return { ok: true, counter };
    });
  }

  async importLegacyFailure(scope, count, now = Date.now()) {
    if (!validScope(scope) || !Number.isSafeInteger(count) || count < 1 || count > 5 ||
        !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid legacy failure counter");
    return this.withState(state => {
      pruneExpiredFailures(state, now);
      const key = "scope:" + scope;
      if (failureCapacityReached(state, key)) throw new Error("Authentication failure bucket capacity reached");
      const current = state.failures[key];
      if (current && Number(current.resetAt) > now) {
        const nextCount = Math.max(0, Math.min(5, Number(current.count) || 0), count);
        const changed = nextCount !== Number(current.count);
        current.count = nextCount;
        return changed;
      }
      state.failures[key] = { count, resetAt: now + 900000 };
      return true;
    });
  }

  async isRateLimited(scope, now = Date.now()) {
    if (!validScope(scope) || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid rate-limit scope");
    return this.withState(state => {
      pruneExpiredFailures(state, now);
      const key = "scope:" + scope;
      // If every bounded bucket is occupied, deny unknown scopes rather than
      // allowing an attacker to evade throttling by rotating scope identifiers.
      if (failureCapacityReached(state, key)) return true;
      const entry = state.failures[key];
      return !!entry && Number(entry.resetAt) > now && Number(entry.count || 0) >= 5;
    });
  }

  async consumeRateLimit(scope, limit = 10, windowMs = 60000, now = Date.now()) {
    if (!validScope(scope) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 3600000 ||
        !Number.isSafeInteger(now) || now < 0) {
      throw new Error("Invalid API rate-limit request");
    }
    return this.withState(state => {
      state.rateLimits ||= {};
      for (const [key, entry] of Object.entries(state.rateLimits)) {
        if (!Number.isSafeInteger(entry?.resetAt) || entry.resetAt <= now) {
          delete state.rateLimits[key];
        }
      }
      const existing = state.rateLimits[scope];
      if (!existing && Object.keys(state.rateLimits).length >= MAX_FAILURE_BUCKETS) {
        const resetAt = Math.min(...Object.values(state.rateLimits).map(entry => entry.resetAt));
        return { allowed: false, remaining: 0, resetAt, capacityLimited: true };
      }
      if (existing && (!Number.isSafeInteger(existing.count) || existing.count < 0 ||
          !Number.isSafeInteger(existing.resetAt) || existing.resetAt <= now)) {
        return { allowed: false, remaining: 0, resetAt: now + 1000, capacityLimited: true };
      }
      const active = existing && existing.resetAt > now &&
        existing.windowMs === windowMs && existing.limit === limit
        ? existing
        : { count: 0, resetAt: now + windowMs, windowMs, limit };
      if (active.count >= limit) {
        state.rateLimits[scope] = active;
        return { allowed: false, remaining: 0, resetAt: active.resetAt, capacityLimited: false };
      }
      active.count += 1;
      state.rateLimits[scope] = active;
      return {
        allowed: true,
        remaining: Math.max(0, limit - active.count),
        resetAt: active.resetAt,
        capacityLimited: false
      };
    });
  }

  async createMfaChallenge(challengeId, now = Date.now()) {
    if (typeof challengeId !== "string" || !/^[a-f0-9-]{36}$/i.test(challengeId) ||
        !Number.isSafeInteger(now) || now < 0) {
      throw new Error("Invalid MFA challenge");
    }
    return this.withState(state => {
      state.challenges ||= {};
      for (const [id, challenge] of Object.entries(state.challenges)) {
        if (!Number.isSafeInteger(challenge?.createdAt) ||
            !Number.isSafeInteger(challenge?.attempts) ||
            challenge.attempts < 0 || challenge.attempts >= 5 ||
            now - challenge.createdAt > 300000 || now < challenge.createdAt) {
          delete state.challenges[id];
        }
      }
      if (state.challenges[challengeId]) return false;
      if (Object.keys(state.challenges).length >= 100) return false;
      state.challenges[challengeId] = { createdAt: now, attempts: 0 };
      return true;
    });
  }

  async completeMfaChallenge({
    challengeId,
    now = Date.now(),
    totpCounter = null,
    backupHash = null,
    failureScope = null
  } = {}) {
    if (typeof challengeId !== "string" || !/^[a-f0-9-]{36}$/i.test(challengeId) ||
        !Number.isSafeInteger(now) || now < 0 ||
        (totpCounter !== null && !validCounter(totpCounter)) ||
        (backupHash !== null && (typeof backupHash !== "string" || !/^[a-f0-9]{64}$/i.test(backupHash))) ||
        (failureScope !== null && !validScope(failureScope))) {
      throw new Error("Invalid MFA challenge completion");
    }
    return this.withState(state => {
      state.challenges ||= {};
      const challenge = state.challenges[challengeId];
      if (!challenge) return { ok: false, reason: "missing" };
      if (!Number.isSafeInteger(challenge.createdAt) ||
          now < challenge.createdAt || now - challenge.createdAt > 300000) {
        delete state.challenges[challengeId];
        return { ok: false, reason: "expired" };
      }
      if (!Number.isSafeInteger(challenge.attempts) ||
          challenge.attempts < 0 || challenge.attempts > 5) {
        delete state.challenges[challengeId];
        return { ok: false, reason: "invalid-state" };
      }
      if (challenge.attempts >= 5) {
        delete state.challenges[challengeId];
        return { ok: false, reason: "attempts-exhausted" };
      }
      pruneExpiredFailures(state, now);
      const failureKey = failureScope === null ? null : "scope:" + failureScope;
      if (failureKey && failureCapacityReached(state, failureKey)) {
        return { ok: false, reason: "rate-limited" };
      }
      const failures = failureKey ? state.failures[failureKey] : null;
      if (failures && Number(failures.resetAt) > now && Number(failures.count || 0) >= 5) {
        return { ok: false, reason: "rate-limited", resetAt: failures.resetAt };
      }

      if (totpCounter !== null && state.totpEnabled && totpCounter > Number(state.lastTotpCounter ?? -1)) {
        state.lastTotpCounter = totpCounter;
        delete state.challenges[challengeId];
        if (failureKey) delete state.failures[failureKey];
        return { ok: true, method: "totp" };
      }
      if (backupHash !== null && state.totpEnabled && state.backupHash &&
          constantTimeEqual(state.backupHash, backupHash)) {
        state.backupHash = null;
        delete state.challenges[challengeId];
        if (failureKey) delete state.failures[failureKey];
        return { ok: true, method: "backup" };
      }

      challenge.attempts = Math.min(5, Number(challenge.attempts || 0) + 1);
      if (failureKey) {
        const active = failures && Number(failures.resetAt) > now
          ? failures
          : { count: 0, resetAt: now + 900000 };
        active.count = Math.min(1000000, Number(active.count || 0) + 1);
        state.failures[failureKey] = active;
      }
      const limited = challenge.attempts >= 5 ||
        (failureKey && Number(state.failures[failureKey]?.count || 0) >= 5);
      if (challenge.attempts >= 5) delete state.challenges[challengeId];
      return { ok: false, reason: limited ? "rate-limited" : "invalid" };
    });
  }

  async provisionBackupHash(hash) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) {
      throw new Error("Invalid backup-code hash");
    }
    return this.withState(state => {
      state.backupHash = hash.toLowerCase();
      state.initialized = true;
      return true;
    });
  }

  async fetch(request) {
    const expected = String(this.env?.AUTH_GUARD_INTERNAL_TOKEN || "");
    const authorization = request.headers.get("Authorization") || "";
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    const supplied = match ? match[1] : "";
    if (expected.length < 32 || !constantTimeEqual(supplied, expected)) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body;
    try {
      body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    } catch (error) {
      return json(
        { error: error.status === 413 ? "Request body too large" : "Invalid JSON body" },
        error.status || 400
      );
    }
    try {
      if (body.operation === "initialize-legacy") {
        return json({ initialized: await this.initializeFromLegacy({
          backupHash: body.backupHash ?? null,
          lastTotpCounter: body.lastTotpCounter ?? -1,
          totpEnabled: body.totpEnabled ?? false,
          totpSecret: body.totpSecret ?? null,
          pendingTotpSecret: body.pendingTotpSecret ?? null,
          pendingTotpAt: body.pendingTotpAt ?? null
        }) });
      }
      if (body.operation === "verify-legacy") return json({ verified: await this.verifyLegacyProfile({
        backupHash: body.backupHash ?? null,
        lastTotpCounter: body.lastTotpCounter ?? -1,
        totpEnabled: body.totpEnabled ?? false,
        totpSecret: body.totpSecret ?? null,
        pendingTotpSecret: body.pendingTotpSecret ?? null,
        pendingTotpAt: body.pendingTotpAt ?? null
      }) });
      if (body.operation === "get-profile") return json(await this.getProfile());
      if (body.operation === "begin-totp-setup") return json({ ok: await this.beginTotpSetup(body.secret) });
      if (body.operation === "confirm-totp-setup") return json(await this.confirmTotpSetup({
        code: body.code, backupHash: body.backupHash, failureScope: body.failureScope
      }));
      if (body.operation === "import-legacy-failure") return json({
        imported: await this.importLegacyFailure(body.scope, body.count)
      });
      if (body.operation === "is-rate-limited") return json({ limited: await this.isRateLimited(body.scope) });
      if (body.operation === "consume-rate-limit") {
        return json(await this.consumeRateLimit(body.scope, body.limit, body.windowMs));
      }
      if (body.operation === "create-challenge") {
        return json({ created: await this.createMfaChallenge(body.challengeId) });
      }
      if (body.operation === "complete-challenge") {
        return json(await this.completeMfaChallenge({
          challengeId: body.challengeId,
          totpCounter: body.totpCounter ?? null,
          backupHash: body.backupHash ?? null,
          failureScope: body.failureScope ?? null
        }));
      }
      if (body.operation === "consume-backup") {
        return json({ ok: await this.consumeBackupCode(body.hash) });
      }
      if (body.operation === "accept-totp") {
        return json({ ok: await this.acceptTotpCounter(body.counter) });
      }
      if (body.operation === "record-failure") {
        return json(await this.recordFailure(body.scope));
      }
      if (body.operation === "clear-failures") {
        return json({ ok: await this.clearFailures(body.scope) });
      }
      return json({ error: "Not found" }, 404);
    } catch {
      return json({ error: "Invalid authentication guard request" }, 400);
    }
  }
}
