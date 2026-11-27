const MAX_ATTEMPTS = 5;
const IP_WINDOW_MS = 15 * 60 * 1000;
const CHALLENGE_WINDOW_MS = 5 * 60 * 1000;

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

const MAX_REQUEST_BYTES = 2048;
const ROUTE_FIELDS = new Map([
  ["/login-attempt", ["ipHash", "legacyCount"]],
  ["/login-clear", ["ipHash"]],
  ["/mfa-attempt", ["ipHash", "challengeId", "legacyIpCount", "legacyChallengeCount"]],
  ["/mfa-clear", ["ipHash", "challengeId"]],
  ["/totp-setup-attempt", ["ipHash"]],
  ["/totp-setup-clear", ["ipHash"]],
  ["/email-send-reserve", ["ipHash"]],
  ["/email-attempt-reserve", ["challengeId"]],
  ["/email-challenge-claim", ["challengeId"]],
  ["/mfa-challenge-claim", ["challengeId"]],
  ["/mfa-challenge-release", ["challengeId"]],
  ["/mfa-credential-claim", ["credentialHash"]],
  ["/mfa-credential-release", ["credentialHash"]],
  ["/totp-setup-claim", ["secretHash"]],
  ["/totp-setup-release", ["secretHash"]]
]);

async function readBoundedRouteJson(request, pathname) {
  const allowed = ROUTE_FIELDS.get(pathname);
  if (!allowed) return Object.create(null);
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^(0|[1-9]\\d*)$/.test(contentLength) ||
      Number(contentLength) > MAX_REQUEST_BYTES)) {
    throw new TypeError("Request body is too large or malformed");
  }
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\\/json(?:\\s*;|$)/i.test(contentType)) {
    throw new TypeError("Expected JSON request body");
  }
  if (!request.body) throw new TypeError("JSON request body is required");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new TypeError("Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let text;
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Request body is not valid UTF-8");
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TypeError("Malformed JSON request body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      (Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null)) {
    throw new TypeError("JSON request body must be an object");
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new TypeError("Unexpected request field");
  }
  return body;
}

function validateHash(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("Invalid " + name);
  }
}

function validateChallengeId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError("Invalid challenge ID");
  }
}

function legacyCount(value) {
  const count = Number(value || 0);
  return Number.isSafeInteger(count) && count > 0 ? Math.min(count, MAX_ATTEMPTS) : 0;
}

export class MfaRateLimiter {
  constructor(stateful) {
    this.stateful = stateful;
    this.storage = stateful.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);
      const body = await readBoundedRouteJson(request, url.pathname);

      if (url.pathname === "/login-attempt") {
        validateHash(body.ipHash, "IP hash");
        const result = await this.reserveLogin(body.ipHash, body.legacyCount);
        await this.scheduleCleanup();
        return response(result);
      }
      if (url.pathname === "/login-clear") {
        validateHash(body.ipHash, "IP hash");
        await this.clearLogin(body.ipHash);
        return response({ ok: true });
      }
      if (url.pathname === "/mfa-attempt") {
        validateHash(body.ipHash, "IP hash");
        if (typeof body.challengeId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.challengeId)) {
          throw new TypeError("Invalid challenge ID");
        }
        const result = await this.reserveMfa(
          body.ipHash,
          body.challengeId,
          body.legacyIpCount,
          body.legacyChallengeCount
        );
        await this.scheduleCleanup();
        return response(result);
      }
      if (url.pathname === "/mfa-clear") {
        validateHash(body.ipHash, "IP hash");
        if (typeof body.challengeId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.challengeId)) {
          throw new TypeError("Invalid challenge ID");
        }
        await this.clearMfa(body.ipHash, body.challengeId);
        return response({ ok: true });
      }
      if (url.pathname === "/totp-setup-attempt" || url.pathname === "/totp-setup-clear") {
        validateHash(body.ipHash, "IP hash");
        if (url.pathname === "/totp-setup-attempt") {
          const result = await this.reserveTotpSetup(body.ipHash);
          await this.scheduleCleanup();
          return response(result);
        }
        await this.clearTotpSetup(body.ipHash);
        return response({ ok: true });
      }
      if (url.pathname === "/email-send-reserve") {
        validateHash(body.ipHash, "IP hash");
        const result = await this.reserveEmailSend(body.ipHash);
        await this.scheduleCleanup();
        return response(result);
      }
      if (url.pathname === "/email-attempt-reserve") {
        validateChallengeId(body.challengeId);
        const result = await this.reserveEmailAttempt(body.challengeId);
        await this.scheduleCleanup();
        return response(result);
      }
      if (url.pathname === "/email-challenge-claim") {
        validateChallengeId(body.challengeId);
        const claimed = await this.claimEmailChallenge(body.challengeId);
        await this.scheduleCleanup();
        return response({ claimed });
      }
      if (url.pathname === "/mfa-challenge-claim" || url.pathname === "/mfa-challenge-release") {
        validateChallengeId(body.challengeId);
        if (url.pathname === "/mfa-challenge-claim") {
          const claimed = await this.claimMfaChallenge(body.challengeId);
          await this.scheduleCleanup();
          return response({ claimed });
        }
        await this.releaseMfaChallenge(body.challengeId);
        return response({ ok: true });
      }
      if (url.pathname === "/mfa-credential-claim" || url.pathname === "/mfa-credential-release") {
        validateHash(body.credentialHash, "MFA credential hash");
        if (url.pathname === "/mfa-credential-claim") {
          const claimed = await this.claimMfaCredential(body.credentialHash);
          await this.scheduleCleanup();
          return response({ claimed });
        }
        await this.releaseMfaCredential(body.credentialHash);
        return response({ ok: true });
      }
      if (url.pathname === "/totp-setup-claim" || url.pathname === "/totp-setup-release") {
        validateHash(body.secretHash, "TOTP setup secret hash");
        if (url.pathname === "/totp-setup-claim") {
          const claimed = await this.claimTotpSetup(body.secretHash);
          await this.scheduleCleanup();
          return response({ claimed });
        }
        await this.releaseTotpSetup(body.secretHash);
        return response({ ok: true });
      }
      return response({ error: "Not found" }, 404);
    } catch (error) {
      // Reject malformed internal requests as client errors; reserve 503 for
      // Durable Object/storage failures so the Worker can fail closed clearly.
      const status = error instanceof TypeError ? 400 : 503;
      return response({ error: String(error?.message || error) }, status);
    }
  }

  async reserveLogin(ipHash, legacy = 0) {
    validateHash(ipHash, "IP hash");
    return this.storage.transaction(async txn => {
      const now = Date.now();
      const key = "auth:login:" + ipHash;
      const current = await txn.get(key);
      const entry = current && current.expiresAt > now
        ? { count: legacyCount(current.count), expiresAt: current.expiresAt }
        : { count: 0, expiresAt: now + IP_WINDOW_MS };
      entry.count = Math.max(entry.count, legacyCount(legacy));
      if (entry.count >= MAX_ATTEMPTS) return { allowed: false, reason: "ip" };
      await txn.put(key, { count: entry.count + 1, expiresAt: entry.expiresAt });
      return { allowed: true };
    });
  }

  async reserveMfa(ipHash, challengeId, legacyIp = 0, legacyChallenge = 0) {
    validateHash(ipHash, "IP hash");
    if (typeof challengeId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(challengeId)) {
      throw new TypeError("Invalid challenge ID");
    }
    return this.storage.transaction(async txn => {
      const now = Date.now();
      const ipKey = "auth:mfa-ip:" + ipHash;
      const challengeKey = "auth:mfa-challenge:" + challengeId;
      const currentIp = await txn.get(ipKey);
      const currentChallenge = await txn.get(challengeKey);
      const ipEntry = currentIp && currentIp.expiresAt > now
        ? { count: legacyCount(currentIp.count), expiresAt: currentIp.expiresAt }
        : { count: 0, expiresAt: now + IP_WINDOW_MS };
      const challengeEntry = currentChallenge && currentChallenge.expiresAt > now
        ? { count: legacyCount(currentChallenge.count), expiresAt: currentChallenge.expiresAt }
        : { count: 0, expiresAt: now + CHALLENGE_WINDOW_MS };
      ipEntry.count = Math.max(ipEntry.count, legacyCount(legacyIp));
      challengeEntry.count = Math.max(challengeEntry.count, legacyCount(legacyChallenge));

      // Preserve the challenge-first behavior: an exhausted challenge is invalidated
      // even when the same request also reaches the IP-wide threshold.
      if (challengeEntry.count >= MAX_ATTEMPTS) return { allowed: false, reason: "challenge" };
      if (ipEntry.count >= MAX_ATTEMPTS) return { allowed: false, reason: "ip" };

      await txn.put(ipKey, { count: ipEntry.count + 1, expiresAt: ipEntry.expiresAt });
      await txn.put(challengeKey, { count: challengeEntry.count + 1, expiresAt: challengeEntry.expiresAt });
      return { allowed: true };
    });
  }

  async reserveEmailSend(ipHash) {
    validateHash(ipHash, "IP hash");
    return this.storage.transaction(async txn => {
      const now = Date.now();
      const key = "auth:email-send:" + ipHash;
      const current = await txn.get(key);
      const entry = current && current.expiresAt > now
        ? { count: legacyCount(current.count), expiresAt: current.expiresAt }
        : { count: 0, expiresAt: now + IP_WINDOW_MS };
      if (entry.count >= 3) return { allowed: false, reason: "ip" };
      await txn.put(key, { count: entry.count + 1, expiresAt: entry.expiresAt });
      return { allowed: true, count: entry.count + 1 };
    });
  }

  async reserveEmailAttempt(challengeId) {
    validateChallengeId(challengeId);
    return this.storage.transaction(async txn => {
      const now = Date.now();
      const key = "auth:email-attempt:" + challengeId;
      const current = await txn.get(key);
      const entry = current && current.expiresAt > now
        ? { count: legacyCount(current.count), expiresAt: current.expiresAt }
        : { count: 0, expiresAt: now + 10 * 60 * 1000 };
      if (entry.count >= MAX_ATTEMPTS) return { allowed: false, attempts: entry.count };
      const count = entry.count + 1;
      await txn.put(key, { count, expiresAt: entry.expiresAt });
      return { allowed: true, attempts: count };
    });
  }

  async claimEmailChallenge(challengeId) {
    validateChallengeId(challengeId);
    return this.storage.transaction(async txn => {
      const key = "auth:email-challenge-claim:" + challengeId;
      const current = await txn.get(key);
      if (current && current.expiresAt > Date.now()) return false;
      await txn.put(key, { expiresAt: Date.now() + 10 * 60 * 1000 });
      return true;
    });
  }

  async reserveTotpSetup(ipHash) {
    validateHash(ipHash, "IP hash");
    return this.storage.transaction(async txn => {
      const now = Date.now();
      const key = "auth:totp-setup:" + ipHash;
      const current = await txn.get(key);
      const entry = current && current.expiresAt > now
        ? { count: legacyCount(current.count), expiresAt: current.expiresAt }
        : { count: 0, expiresAt: now + IP_WINDOW_MS };
      if (entry.count >= MAX_ATTEMPTS) return { allowed: false, reason: "ip" };
      await txn.put(key, { count: entry.count + 1, expiresAt: entry.expiresAt });
      return { allowed: true };
    });
  }

  async clearTotpSetup(ipHash) {
    validateHash(ipHash, "IP hash");
    return this.storage.transaction(txn => txn.delete("auth:totp-setup:" + ipHash));
  }

  async claimMfaChallenge(challengeId) {
    validateChallengeId(challengeId);
    return this.storage.transaction(async txn => {
      const key = "auth:mfa-challenge-claim:" + challengeId;
      const current = await txn.get(key);
      if (current && current.expiresAt > Date.now()) return false;
      await txn.put(key, { expiresAt: Date.now() + 5 * 60 * 1000 });
      return true;
    });
  }

  async releaseMfaChallenge(challengeId) {
    validateChallengeId(challengeId);
    return this.storage.transaction(txn => txn.delete("auth:mfa-challenge-claim:" + challengeId));
  }

  async claimMfaCredential(credentialHash) {
    validateHash(credentialHash, "MFA credential hash");
    return this.storage.transaction(async txn => {
      const key = "auth:mfa-credential:" + credentialHash;
      const current = await txn.get(key);
      if (current && current.expiresAt > Date.now()) return false;
      await txn.put(key, { expiresAt: Date.now() + 2 * 60 * 1000 });
      return true;
    });
  }

  async releaseMfaCredential(credentialHash) {
    validateHash(credentialHash, "MFA credential hash");
    return this.storage.transaction(txn => txn.delete("auth:mfa-credential:" + credentialHash));
  }

  async claimTotpSetup(secretHash) {
    validateHash(secretHash, "TOTP setup secret hash");
    return this.storage.transaction(async txn => {
      const key = "auth:totp-setup-claim:" + secretHash;
      const current = await txn.get(key);
      if (current && current.expiresAt > Date.now()) return false;
      await txn.put(key, { expiresAt: Date.now() + 10 * 60 * 1000 });
      return true;
    });
  }

  async releaseTotpSetup(secretHash) {
    validateHash(secretHash, "TOTP setup secret hash");
    return this.storage.transaction(txn => txn.delete("auth:totp-setup-claim:" + secretHash));
  }

  async clearLogin(ipHash) {
    validateHash(ipHash, "IP hash");
    return this.storage.transaction(txn => txn.delete("auth:login:" + ipHash));
  }

  async clearMfa(ipHash, challengeId) {
    validateHash(ipHash, "IP hash");
    if (typeof challengeId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(challengeId)) {
      throw new TypeError("Invalid challenge ID");
    }
    return this.storage.transaction(async txn => {
      await txn.delete("auth:mfa-ip:" + ipHash);
      await txn.delete("auth:mfa-challenge:" + challengeId);
    });
  }

  async scheduleCleanup() {
    try {
      const alarm = await this.storage.getAlarm();
      if (alarm === null) await this.storage.setAlarm(Date.now() + 60_000);
    } catch {
      // Rate-limit decisions remain durable even if cleanup scheduling is unavailable.
    }
  }

  async alarm() {
    const now = Date.now();
    // List, inspect, and delete in one transaction so a concurrent reservation
    // cannot replace an expired counter between the list and delete operations.
    const nextExpiry = await this.storage.transaction(async txn => {
      const entries = await txn.list({ prefix: "auth:" });
      let earliest = null;
      for (const [key, value] of entries) {
        if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
          await txn.delete(key);
        } else {
          earliest = earliest === null ? value.expiresAt : Math.min(earliest, value.expiresAt);
        }
      }
      return earliest;
    });
    if (nextExpiry !== null) await this.storage.setAlarm(nextExpiry);
  }
}
