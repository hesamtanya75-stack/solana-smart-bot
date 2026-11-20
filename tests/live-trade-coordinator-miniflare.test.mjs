import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const INTERNAL_TOKEN = "coordinator-runtime-internal-token-longer-than-thirty-two";
const OPERATOR_TOKEN = "coordinator-runtime-operator-token-longer-than-thirty-two";
const INPUT_MINT = "So11111111111111111111111111111111111111112";
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BOT_WALLET = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";

test("LiveTradeCoordinator keeps a real reservation pending across settlement RPC outage and Miniflare runtime restart", async () => {
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
      COORDINATOR_OPERATOR_TOKEN: OPERATOR_TOKEN,
      LIVE_MAX_PRIORITY_FEE_LAMPORTS: "3000"
    },
    resourcePersistencePath: persistencePath
  }));

  let mf;
  try {
    mf = createRuntime();
    const namespace = await mf.getDurableObjectNamespace("LIVE_TRADE_COORDINATOR");
    const id = namespace.idFromName("coordinator-persistence-runtime");
    const stub = namespace.get(id);
    const call = async (activeStub, path, { method = "GET", body, operator = false } = {}) => {
      const response = await activeStub.fetch("https://coordinator.internal" + path, {
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

    const initial = await call(stub, "/status");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.killSwitch, true);

    const disabled = await call(stub, "/kill-switch", {
      method: "POST", operator: true, body: { enabled: false, reason: "runtime persistence test" }
    });
    assert.equal(disabled.status, 200);

    const reservation = await call(stub, "/reserve", {
      method: "POST",
      body: {
        idempotencyKey: "runtime-restart-order-01",
        inputMint: INPUT_MINT,
        outputMint: OUTPUT_MINT,
        destination: BOT_WALLET,
        slippageBps: 50,
        amountLamports: 10_000_000
      }
    });
    assert.equal(reservation.status, 200);
    assert.equal(reservation.body.reservation.status, "pending");
    const reservedAmountCents = reservation.body.reservation.amountCents;
    assert.ok(Number.isSafeInteger(reservedAmountCents) && reservedAmountCents > 0);

    // The fixture's settlement verifier throws an RPC outage. The coordinator
    // must not mark this ambiguous order failed or release its spend capacity.
    const outage = await call(stub, "/confirm", {
      method: "POST",
      body: {
        idempotencyKey: "runtime-restart-order-01",
        signature: "5".repeat(88),
        outputAmount: "1000000"
      }
    });
    assert.equal(outage.status, 400);
    assert.match(outage.body.error, /Simulated settlement RPC outage/);

    const beforeRestart = await call(stub, "/status");
    assert.equal(beforeRestart.status, 200);
    assert.equal(beforeRestart.body.openPositions, 1);
    assert.equal(beforeRestart.body.dailySpendUsdCents, reservedAmountCents);

    await mf.dispose();
    mf = undefined;

    mf = createRuntime();
    const restartedNamespace = await mf.getDurableObjectNamespace("LIVE_TRADE_COORDINATOR");
    const restartedStub = restartedNamespace.get(
      restartedNamespace.idFromName("coordinator-persistence-runtime")
    );
    const restartedStatus = await call(restartedStub, "/status");
    assert.equal(restartedStatus.status, 200);
    assert.equal(restartedStatus.body.killSwitch, false);
    assert.equal(restartedStatus.body.openPositions, 1);
    assert.equal(restartedStatus.body.dailySpendUsdCents, reservedAmountCents);

    // A second reconciliation attempt still cannot release the pending
    // reservation while the settlement provider remains unavailable.
    const retry = await call(restartedStub, "/confirm", {
      method: "POST",
      body: {
        idempotencyKey: "runtime-restart-order-01",
        signature: "5".repeat(88),
        outputAmount: "1000000"
      }
    });
    assert.equal(retry.status, 400);
    assert.match(retry.body.error, /Simulated settlement RPC outage/);

    const stop = await call(restartedStub, "/kill-switch", {
      method: "POST", operator: true,
      body: { enabled: true, reason: "keep unresolved reservation locked" }
    });
    assert.equal(stop.status, 200);
    const stoppedStatus = await call(restartedStub, "/status");
    assert.equal(stoppedStatus.body.killSwitch, true);
    assert.equal(stoppedStatus.body.openPositions, 1);
    assert.equal(stoppedStatus.body.dailySpendUsdCents, reservedAmountCents);
  } finally {
    if (mf) await mf.dispose();
    await rm(persistencePath, { recursive: true, force: true });
  }
});
