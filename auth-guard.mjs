/**
 * Isolated authentication guard Durable Object.
 *
 * This is a concurrency-safe primitive, not yet wired into Worker auth routes.
 * Do not bind or deploy it until the KV-to-DO profile migration and route
 * integration have been separately reviewed. The existing LIVE_TRADE_COORDINATOR
 * remains completely separate.
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

function validScope(scope) {
  return typeof scope === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(scope);
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

export class AuthGuard {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async withState(operation) {
    let result;
    await this.ctx.storage.transaction(async txn => {
      const state = (await txn.get("auth_guard_state")) || {
        backupHash: null,
        lastTotpCounter: -1,
        failures: {}
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
      const key = "scope:" + scope;
      const current = state.failures[key];
      const active = current && Number(current.resetAt) > now ? current : { count: 0, resetAt: now + 900000 };
      active.count = Math.min(1000000, Number(active.count || 0) + 1);
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

  async provisionBackupHash(hash) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) {
      throw new Error("Invalid backup-code hash");
    }
    return this.withState(state => {
      state.backupHash = hash.toLowerCase();
      return true;
    });
  }

  async fetch(request) {
    const expected = String(this.env?.AUTH_GUARD_INTERNAL_TOKEN || "");
    const supplied = (request.headers.get("Authorization") || "").replace(/^Bearer\\s+/i, "");
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
