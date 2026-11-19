import test from "node:test";
import assert from "node:assert/strict";
import worker, { PaperStateCoordinator } from "../worker.js";

class MemoryStorage {
  values = new Map();
  tail = Promise.resolve();
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
function environment() {
  const storage = new MemoryStorage();
  const coordinator = new PaperStateCoordinator({ storage });
  const stub = { fetch: (input, init) => coordinator.fetch(new Request(input, init)) };
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
    }
  };
  return { env, coordinator, touchedKvKeys };
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
