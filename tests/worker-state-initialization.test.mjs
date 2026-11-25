import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const coordinatorSource = await readFile(new URL("../paper-state-coordinator.js", import.meta.url), "utf8");
const coordinatorModuleUrl = "data:text/javascript;base64," + Buffer.from(coordinatorSource).toString("base64");
const limiterSource = await readFile(new URL("../mfa-rate-limiter.js", import.meta.url), "utf8");
const limiterModuleUrl = "data:text/javascript;base64," + Buffer.from(limiterSource).toString("base64");
const workerWithStubbedProviders = workerSource
  .replace('import { isAcceptableRugCheckScore } from "./rugcheck-score.js";', "const isAcceptableRugCheckScore = () => true;")
  .replace('import { resolveSolanaRpcEndpoints } from "./solana-rpc-config.js";', "const resolveSolanaRpcEndpoints = () => [];")
  .replace('import { fetchJupiterQuote } from "./jupiter-quote-client.js";', "const fetchJupiterQuote = async () => null;")
  .replace('import { prepareLiveOrderEvidence } from "./live-order-evidence-service.js";', "const prepareLiveOrderEvidence = async () => null;")
  .replace('import { parseLiveOrderEvidenceRequest } from "./live-order-evidence-request.js";', "const parseLiveOrderEvidenceRequest = () => null;")
  .replace('import { reconcileWalletReadOnly } from "./solana-wallet-reconciliation.js";', "const reconcileWalletReadOnly = async () => null;")
  .replace('import { parseRpcBatchResponse, parseRpcSingleResponse } from "./solana-rpc-response.js";', "const parseRpcBatchResponse = () => null; const parseRpcSingleResponse = () => null;")
  .replace('import { calculateCompleteHolderConcentration } from "./holder-concentration.js";', "const calculateCompleteHolderConcentration = () => null;")
  .replace('import { buildCompleteHolderEnumeration } from "./holder-enumeration.js";', "const buildCompleteHolderEnumeration = () => null;");
const workerWithEmbeddedCoordinator = workerWithStubbedProviders
  .replace(
    'export { LiveOrderLedgerObject } from "./live-order-ledger-object.js";',
    "class LiveOrderLedgerObject {} export { LiveOrderLedgerObject };"
  )
  .replace(
    'export { PaperStateCoordinator } from "./paper-state-coordinator.js";',
    "const { PaperStateCoordinator } = await import(" + JSON.stringify(coordinatorModuleUrl) + "); export { PaperStateCoordinator };"
  )
  .replace(
    'export { MfaRateLimiter } from "./mfa-rate-limiter.js";',
    "const { MfaRateLimiter } = await import(" + JSON.stringify(limiterModuleUrl) + "); export { MfaRateLimiter };"
  );
const workerModuleUrl = "data:text/javascript;base64," + Buffer.from(workerWithEmbeddedCoordinator).toString("base64");
const { default: worker, PaperStateCoordinator } = await import(workerModuleUrl);

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
function makeContext() {
  let pending;
  return {
    waitUntil(promise) { pending = promise; },
    async drain() { await pending; }
  };
}
function makeEnv(initialState) {
  const storage = new MemoryStorage();
  const coordinator = new PaperStateCoordinator({ storage });
  const stub = { fetch: (input, init) => coordinator.fetch(new Request(input, init)) };
  const touchedKvKeys = [];
  const env = {
    BOT_STATE: {
      async get(key) { touchedKvKeys.push(["get", key]); return null; },
      async put(key) { touchedKvKeys.push(["put", key]); },
      async delete(key) { touchedKvKeys.push(["delete", key]); }
    },
    PAPER_STATE_COORDINATOR: { idFromName: name => name, get: () => stub }
  };
  return { env, coordinator, touchedKvKeys };
}

test("scheduled cycle does not create default state before first login or import", async () => {
  const { env, coordinator, touchedKvKeys } = makeEnv();
  const ctx = makeContext();
  await worker.scheduled({}, env, ctx);
  await ctx.drain();
  assert.deepEqual(await coordinator.snapshot(), { initialized: false, state: null, version: 0 });
  assert.ok(!touchedKvKeys.some(([, key]) => key === "bot_state"));
});

test("scheduled cycle commits initialized paper state through the Durable Object", async () => {
  const initial = {
    balance: 100, trades: [], autoEnabled: false, paused: false,
    scannedMints: [], deferredMints: [], lastRunAt: null,
    lastMessage: "ready", lastScanReport: [], updatedAt: null
  };
  const { env, coordinator, touchedKvKeys } = makeEnv();
  await coordinator.importOnce(initial);
  const ctx = makeContext();
  await worker.scheduled({}, env, ctx);
  await ctx.drain();
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.state.autoEnabled, false);
  assert.ok(snapshot.state.updatedAt);
  assert.ok(!touchedKvKeys.some(([, key]) => key === "bot_state"));
});

test("frontend blocks silent overwrite when initialized local and server paper-trading data differ", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/function hasLegacyEmptyServerConflict\(local, remote\) \{[\s\S]*?\n\}/);
  assert.ok(match, "frontend conflict guard helper must exist");
  const vm = await import("node:vm");
  const guard = vm.runInNewContext("(" + match[0].replace(/^function hasLegacyEmptyServerConflict/, "function") + ")");

  const timestamp = "2026-11-19T00:00:00.000Z";
  assert.equal(guard({ balance: 95, trades: [{ mint: "local" }] }, { balance: 100, trades: [], updatedAt: timestamp }), true,
    "local trade history must not be replaced by an empty initialized server record");
  assert.equal(guard({ balance: 100, trades: [] }, { balance: 100, trades: [], updatedAt: timestamp }), false,
    "a pristine local default may load server state");
  assert.equal(guard({ balance: null, trades: [] }, { balance: 100, trades: [], updatedAt: timestamp }), false,
    "a missing/null legacy balance must use the default rather than being treated as zero");
  assert.equal(guard({ balance: "", trades: [] }, { balance: 100, trades: [], updatedAt: timestamp }), false,
    "a blank legacy balance must use the default rather than being treated as zero");
  assert.equal(guard({ balance: "   ", trades: [] }, { balance: 100, trades: [], updatedAt: timestamp }), false,
    "a whitespace-only legacy balance must use the default rather than being treated as zero");
  assert.equal(guard({ balance: 0, trades: [] }, { balance: 100, trades: [], updatedAt: timestamp }), true,
    "an explicit zero balance is meaningful local state and must not be overwritten");
  assert.equal(guard({ balance: 95, trades: [{ mint: "local" }] }, { balance: 90, trades: [{ mint: "remote" }], updatedAt: timestamp }), true,
    "different initialized histories must require reconciliation");
  assert.equal(guard({ balance: 95, trades: [{ mint: "same" }] }, { balance: 95, trades: [{ mint: "same" }], updatedAt: timestamp }), false,
    "identical initialized histories may sync");
  assert.equal(guard({ balance: 95, trades: [] }, { balance: 100, trades: [], updatedAt: timestamp }), true,
    "a locally changed balance must not be silently overwritten");
  assert.equal(guard({ balance: 100, trades: [] }, { balance: 95, trades: [{ mint: "remote" }], updatedAt: timestamp }), false,
    "a pristine local default may adopt initialized server history");
  assert.equal(guard({ balance: 95, trades: [{ mint: "local" }] }, { balance: 100, trades: [] }), false,
    "an uninitialized server record remains eligible for safe migration");
});


test("frontend stops repeated full-state saves after a version conflict and preserves local history", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/async function saveServerState\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, "server state save helper must exist");
  assert.match(match[0], /message\.includes\("State changed"\) \|\| message\.includes\("409"\)/,
    "a stale-write conflict must be recognized");
  assert.match(match[0], /serverModeReady = false/,
    "server persistence must stop after a conflict instead of retrying a stale full-state write");
  assert.match(match[0], /browser copy untouched/,
    "the conflict path must explicitly preserve local browser data");
  assert.match(match[0], /داتای ئەم مۆبایلە پارێزراوە/,
    "the user must be told that the local copy is preserved");
});
