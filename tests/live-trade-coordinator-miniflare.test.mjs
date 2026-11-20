import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const INTERNAL_TOKEN = "coordinator-runtime-internal-token-longer-than-thirty-two";
const OPERATOR_TOKEN = "coordinator-runtime-operator-token-longer-than-thirty-two";

test("LiveTradeCoordinator preserves a pending reservation and locked spend after an RPC-outage recovery across stub recreation", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
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
    }
  }));

  try {
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

    // Simulate the durable pending ledger left behind when settlement RPC is
    // unavailable: no failure proof exists, so capacity must remain reserved.
    const seeded = await stub.fetch("https://coordinator.internal/__test/seed-pending", {
      method: "POST",
      headers: { Authorization: "Bearer " + INTERNAL_TOKEN }
    });
    assert.equal(seeded.status, 200);
    assert.deepEqual(await seeded.json(), { seeded: true });

    const recreatedNamespace = await mf.getDurableObjectNamespace("LIVE_TRADE_COORDINATOR");
    const recreatedStub = recreatedNamespace.get(recreatedNamespace.idFromName("coordinator-persistence-runtime"));
    const persisted = await recreatedStub.fetch("https://coordinator.internal/status", {
      headers: { Authorization: "Bearer " + INTERNAL_TOKEN }
    });
    assert.equal(persisted.status, 200);
    const persistedBody = await persisted.json();
    assert.equal(persistedBody.killSwitch, false);
    assert.equal(persistedBody.openPositions, 1);
    assert.equal(persistedBody.dailySpendUsdCents, 200);

    const stopWhilePending = await call("/kill-switch", {
      method: "POST", operator: true, body: { enabled: true, reason: "keep unresolved reservation locked" }
    });
    assert.equal(stopWhilePending.status, 200);
    assert.equal(stopWhilePending.body.killSwitch, true);
    const afterStop = await call("/status");
    assert.equal(afterStop.body.openPositions, 1);
    assert.equal(afterStop.body.dailySpendUsdCents, 200);

    const enabled = await call("/kill-switch", {
      method: "POST", operator: true, body: { enabled: true, reason: "restore safe default" }
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.killSwitch, true);

    const finalStatus = await call("/status");
    assert.equal(finalStatus.body.killSwitch, true);
  } finally {
    await mf.dispose();
  }
});
