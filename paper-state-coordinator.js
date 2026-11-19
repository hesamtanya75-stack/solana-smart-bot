const STATE_KEY = "paper-state";
const VERSION_KEY = "paper-state-version";
const IMPORT_KEY = "paper-state-imported";
const DEFAULT_STATE = {
  balance: 100,
  trades: [],
  autoEnabled: false,
  paused: false,
  scannedMints: [],
  deferredMints: [],
  lastRunAt: null,
  lastMessage: "بۆتی سێرڤەر ئامادەیە؛ کڕینی خۆکار ناچالاکە.",
  lastScanReport: [],
  updatedAt: null
};
const LIMITS = {
  trades: 500,
  scannedMints: 1000,
  deferredMints: 1000,
  lastScanReport: 20
};
const ALLOWED_PATCH_KEYS = new Set([
  "balance", "trades", "autoEnabled", "paused", "scannedMints",
  "deferredMints", "lastRunAt", "lastMessage", "lastScanReport"
]);

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function validateState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("State must be an object");
  }
  if (!Number.isFinite(Number(input.balance)) || Number(input.balance) < 0) {
    throw new TypeError("Invalid balance");
  }
  for (const key of Object.keys(LIMITS)) {
    if (!Array.isArray(input[key]) || input[key].length > LIMITS[key]) {
      throw new TypeError("Invalid or oversized " + key);
    }
  }
  if (typeof input.autoEnabled !== "boolean" || typeof input.paused !== "boolean") {
    throw new TypeError("Invalid automation flags");
  }
  const state = { ...DEFAULT_STATE, ...input, balance: Number(input.balance) };
  // Never silently truncate data at the coordination boundary.
  for (const [key, limit] of Object.entries(LIMITS)) {
    if (state[key].length > limit) throw new TypeError("Oversized " + key);
  }
  return state;
}

export class PaperStateCoordinator {
  constructor(stateful) {
    this.stateful = stateful;
    this.storage = stateful.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/snapshot" && request.method === "GET") {
        return response(await this.snapshot());
      }
      if (url.pathname === "/status" && request.method === "GET") {
        return response(await this.status());
      }
      if (url.pathname === "/patch" && request.method === "POST") {
        return response(await this.patch(await request.json()));
      }
      if (url.pathname === "/commit" && request.method === "POST") {
        const body = await request.json();
        return response(await this.commit(body.expectedVersion, body.state));
      }
      if (url.pathname === "/import" && request.method === "POST") {
        return response(await this.importOnce(await request.json()));
      }
      return response({ error: "Not found" }, 404);
    } catch (error) {
      const message = String(error?.message || error);
      const status = message === "Version conflict" || message === "Already initialized" ? 409 : 400;
      return response({ error: message }, status);
    }
  }

  async snapshot() {
    return this.storage.transaction(async txn => {
      const state = await txn.get(STATE_KEY);
      const version = Number(await txn.get(VERSION_KEY) || 0);
      return { initialized: state !== undefined, state: state ?? null, version };
    });
  }

  async status() {
    return this.storage.transaction(async txn => ({
      initialized: (await txn.get(STATE_KEY)) !== undefined,
      version: Number(await txn.get(VERSION_KEY) || 0),
      imported: (await txn.get(IMPORT_KEY)) === true
    }));
  }

  async patch(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new TypeError("Patch must be an object");
    }
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => !ALLOWED_PATCH_KEYS.has(key))) {
      throw new TypeError("Patch contains unsupported fields");
    }
    return this.storage.transaction(async txn => {
      const current = await txn.get(STATE_KEY);
      if (current === undefined) throw new Error("State is not initialized");
      const next = validateState({ ...current, ...patch, updatedAt: new Date().toISOString() });
      const version = Number(await txn.get(VERSION_KEY) || 0) + 1;
      await txn.put(STATE_KEY, next);
      await txn.put(VERSION_KEY, version);
      return { ok: true, state: next, version };
    });
  }

  async commit(expectedVersion, candidate) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new TypeError("Invalid expected version");
    }
    const next = validateState(candidate);
    return this.storage.transaction(async txn => {
      const current = await txn.get(STATE_KEY);
      if (current === undefined) throw new Error("State is not initialized");
      const version = Number(await txn.get(VERSION_KEY) || 0);
      if (version !== expectedVersion) throw new Error("Version conflict");
      next.updatedAt = new Date().toISOString();
      const nextVersion = version + 1;
      await txn.put(STATE_KEY, next);
      await txn.put(VERSION_KEY, nextVersion);
      return { ok: true, state: next, version: nextVersion };
    });
  }

  async importOnce(source) {
    const next = validateState(source);
    return this.storage.transaction(async txn => {
      const current = await txn.get(STATE_KEY);
      const imported = await txn.get(IMPORT_KEY);
      if (current !== undefined || imported === true) throw new Error("Already initialized");
      await txn.put(STATE_KEY, next);
      await txn.put(VERSION_KEY, 1);
      await txn.put(IMPORT_KEY, true);
      return { ok: true, version: 1, imported: true };
    });
  }
}
