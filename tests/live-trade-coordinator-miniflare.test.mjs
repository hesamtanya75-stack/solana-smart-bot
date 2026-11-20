import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const INTERNAL_TOKEN = "coordinator-runtime-internal-token-longer-than-thirty-two";
const OPERATOR_TOKEN = "coordinator-runtime-operator-token-longer-than-thirty-two";

test("LiveTradeCoordinator preserves pending reservation and locked spend across a Miniflare runtime restart", async () => {
  const persistencePath = await mkdtemp(join(tmpdir(), "solana-coordinator-do-"));
  const createRuntime = () => new Miniflare(convertV4MiniflareOptions({
    modules: [
      { type: "ESModule", path: "tests/fixtures/live-trade-coordinator-runtime.mjs" },
      { type: "ESModule", path: "live-trade-coordinator.mjs" },
      { type: "ESModule", path: "trusted-live-evidence.mjs" },
      { type: "ESModule", path: "address-lookup-table-verifier.mjs" },
      { type: "ESModule", path: "rpc-response.mjs" }
    ],
    modulesRoot: process.cwd(),
    compatibilityDate: "2026-11-06",
    durableObjects: { LIVE_TRADE_COORDINATOR: "LiveTradeCoordinator" },
    bindings: {
      COORDINATOR_INTERNAL_TOKEN: INTERNAL_TOKEN,
      COORDINATOR_OPERATOR_TOKEN: OPERATOR_TOKEN
    },
    // Miniflare 5 persists Durable Object SQLite state below this path.
    // Reopening a new Miniflare instance against it exercises runtime restart,
    // unlike reacquiring a namespace/stub in the same instance.
    resourcePersistencePath: persistencePath
  }));

  let mf;
  try {
    mf = createRuntime();
    const namespace = await mf.getDurableObjectNamespace("LIVE_TRADE_COORDINATOR");
    const id = namespace.idFromName("coordinator-persistence-runtime");
    const stub = namespace.get(id);
    const call = async (path, { method = "GET", body, operator = false } = {}) => {
      const response = await stub.fetch("https://coordinator.internal" + path, {
        method,
        headers: {
          Authorization: "Bearer " + INTERNAL_TOKEN,
          ...(operator ? { "X-Operator-Token": OPERATOR_TOKEN } : {}),
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return { status: response.status, body: await response.json() };
    };

    const initial = await call("/status");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.killSwitch, true);

    const disabled = await call("/kill-switch", {
      method: "POST", operator: true, body: { enabled: false, reason: "runtime persistence test" }
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.killSwitch, false);

    // Seed the durable pending ledger left by an ambiguous settlement RPC
    // outage. No failure proof exists, so spend and position capacity stay locked.
    const seeded = await stub.fetch("https://coordinator.internal/__test/seed-pending", {
      method: "POST",
      headers: { Authorization: "Bearer " + INTERNAL_TOKEN }
    });
    assert.equal(seeded.status, 200);
    assert.deepEqual(await seeded.json(), { seeded: true });

    const beforeRestart = await call("/status");
    assert.equal(beforeRestart.body.openPositions, 1);
    assert.equal(beforeRestart.body.dailySpendUsdCents, 200);

    // Dispose the complete Miniflare/workerd runtime, then reopen the same
    // Durable Object namespace and ID from the same persistent storage path.
    await mf.dispose();
    mf = undefined;

    mf = createRuntime();
    const restartedNamespace = await mf.getDurableObjectNamespace("LIVE_TRADE_COORDINATOR");
    const restartedStub = restartedNamespace.get(
      restartedNamespace.idFromName("coordinator-persistence-runtime")
    );
    const restartedResponse = await restartedStub.fetch("https://coordinator.internal/status", {
      headers: { Authorization: "Bearer " + INTERNAL_TOKEN }
    });
    assert.equal(restartedResponse.status, 200);
    const restartedStatus = await restartedResponse.json();
    assert.equal(restartedStatus.killSwitch, false);
    assert.equal(restartedStatus.openPositions, 1);
    assert.equal(restartedStatus.dailySpendUsdCents, 200);

    const stopResponse = await restartedStub.fetch("https://coordinator.internal/kill-switch", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + INTERNAL_TOKEN,
        "X-Operator-Token": OPERATOR_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ enabled: true, reason: "keep unresolved reservation locked" })
    });
    assert.equal(stopResponse.status, 200);
    const stopped = await restartedStub.fetch("https://coordinator.internal/status", {
      headers: { Authorization: "Bearer " + INTERNAL_TOKEN }
    });
    assert.equal(stopped.status, 200);
    const stoppedStatus = await stopped.json();
    assert.equal(stoppedStatus.killSwitch, true);
    assert.equal(stoppedStatus.openPositions, 1);
    assert.equal(stoppedStatus.dailySpendUsdCents, 200);
  } finally {
    if (mf) await mf.dispose();
    await rm(persistencePath, { recursive: true, force: true });
  }
});
