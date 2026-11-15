import test from "node:test";
import assert from "node:assert/strict";
import { LiveTradeCoordinator } from "../live-trade-coordinator.mjs";

class MemoryStorage {
  constructor() { this.values = new Map(); this.tail = Promise.resolve(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}
function trustedEvidence(overrides = {}) {
  const fetchedAt = Date.now();
  return {
    quote: { provider: "Coinbase", pair: "SOL/USD", price: 200, fetchedAt, quoteId: "test-quote-" + fetchedAt },
    risk: { provider: "test-fixture", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fetchedAt,
      checks: {
        mintAuthoritySafe: true, freezeAuthoritySafe: true, token2022ExtensionsSafe: true,
        holderConcentrationSafe: true, sellRouteAvailable: true, marketLiquiditySafe: true,
        marketVolumeSafe: true, rugCheckSafe: true
      }, sellRoute: { semanticInstructionVerification: true, routeVerification: "semantically-verified" }, passed: true },
    passed: true,
    ...overrides
  };
}
function makeCoordinator(evidenceProvider = async () => trustedEvidence(), settlementVerifier = async args => ({
    verified: true, signature: args.signature, inputMint: args.inputMint, inputAmount: args.inputAmount,
    outputMint: args.outputMint, outputAmount: args.outputAmount, owner: args.expectedOwner,
    confirmationStatus: "finalized"
  })) {
  const storage = new MemoryStorage();
  const coordinator = new LiveTradeCoordinator({ storage }, {
    COORDINATOR_INTERNAL_TOKEN: "test-only-internal-token-32-characters",
    COORDINATOR_OPERATOR_TOKEN: "test-only-operator-token-32-characters",
    FETCH_TRUSTED_LIVE_EVIDENCE: evidenceProvider,
    VERIFY_FINALIZED_SETTLEMENT: settlementVerifier
  });
  return { coordinator, storage };
}
function validReservation(overrides = {}) {
  return {
    idempotencyKey: "order-key-0001",
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    destination: "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy",
    slippageBps: 50,
    quoteId: "coinbase-quote-0001",
    amountLamports: 10_000_000,
    solUsd: 200,
    quoteTimestamp: Date.now(),
    riskPassed: true,
    ...overrides
  };
}
async function post(coordinator, path, body, operatorToken = "test-only-operator-token-32-characters") {
  const headers = { "Content-Type": "application/json", Authorization: "Bearer test-only-internal-token-32-characters" };
  if (operatorToken) headers["X-Operator-Token"] = operatorToken;
  const response = await coordinator.fetch(new Request("https://coordinator" + path, {
    method: "POST", headers, body: JSON.stringify(body)
  }));
  return { status: response.status, body: await response.json() };
}

test("coordinator rejects oversized authenticated request bodies before JSON parsing", async () => {
  const { coordinator } = makeCoordinator();
  const response = await coordinator.fetch(new Request("https://coordinator/kill-switch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-only-internal-token-32-characters"
    },
    body: JSON.stringify({ enabled: false, padding: "x".repeat(16385) })
  }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Request body too large" });
});

test("status endpoint returns a fail-closed conflict for impossible ledger dates", async () => {
  const { coordinator, storage } = makeCoordinator();
  await storage.put("coordinator_state", {
    killSwitch: true,
    reservations: {
      "bad-date-key-0001": {
        idempotencyKey: "bad-date-key-0001",
        intentFingerprint: "immutable-intent",
        amountCents: 100,
        day: "2026-02-30",
        status: "closed"
      }
    },
    killSwitchAudit: []
  });
  const response = await coordinator.fetch(new Request("https://coordinator/status", {
    headers: { Authorization: "Bearer test-only-internal-token-32-characters" }
  }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /reservation ledger contains an invalid record/);
});

test("full reservation history blocks new evidence requests but preserves ledger", async () => {
  let evidenceCalls = 0;
  const { coordinator, storage } = makeCoordinator(async () => {
    evidenceCalls += 1;
    return trustedEvidence();
  });
  await post(coordinator, "/kill-switch", { enabled: false });
  const day = new Date().toISOString().slice(0, 10);
  const reservations = {};
  for (let index = 0; index < 1000; index += 1) {
    const key = "history-key-" + String(index).padStart(4, "0");
    reservations[key] = {
      idempotencyKey: key,
      intentFingerprint: "immutable-intent-" + index,
      amountCents: 100,
      day,
      status: "closed"
    };
  }
  await storage.put("coordinator_state", {
    killSwitch: false,
    reservations,
    killSwitchAudit: []
  });

  const result = await post(coordinator, "/reserve", validReservation());
  assert.equal(result.status, 409);
  assert.match(result.body.error, /history capacity reached/);
  assert.equal(evidenceCalls, 0);
  assert.equal(Object.keys((await storage.get("coordinator_state")).reservations).length, 1000);
});

test("malformed reservation ledger fails closed before requesting live evidence", async () => {
  let evidenceCalls = 0;
  const { coordinator, storage } = makeCoordinator(async () => {
    evidenceCalls += 1;
    return trustedEvidence();
  });
  await post(coordinator, "/kill-switch", { enabled: false });
  await storage.put("coordinator_state", {
    killSwitch: false,
    reservations: {
      "corrupt-key-0001": {
        idempotencyKey: "corrupt-key-0001",
        intentFingerprint: "immutable-intent",
        amountCents: "not-a-number",
        day: new Date().toISOString().slice(0, 10),
        status: "pending"
      }
    },
    killSwitchAudit: []
  });

  const result = await post(coordinator, "/reserve", validReservation());
  assert.equal(result.status, 409);
  assert.match(result.body.error, /reservation ledger contains an invalid record/);
  assert.equal(evidenceCalls, 0);
});

test("kill switch starts active and blocks reservations", async () => {
  const { coordinator } = makeCoordinator();
  const result = await post(coordinator, "/reserve", validReservation());
  assert.equal(result.status, 409);
  assert.match(result.body.error, /kill switch/);
});

test("reservation enforces $3 trade cap and fresh SOL/USD quote", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const tooLarge = await post(coordinator, "/reserve", validReservation({
    amountLamports: 15_000_001
  }));
  assert.equal(tooLarge.status, 409);
  const staleCoordinator = makeCoordinator(async () => trustedEvidence({
    quote: { provider: "test-fixture", price: 200, fetchedAt: Date.now() - 31_000 }
  })).coordinator;
  await post(staleCoordinator, "/kill-switch", { enabled: false });
  const stale = await post(staleCoordinator, "/reserve", validReservation({
    idempotencyKey: "order-key-stale"
  }));
  assert.equal(stale.status, 409);
});

test("coordinator rejects risk evidence that became stale during upstream collection", async () => {
  const originalNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const { coordinator } = makeCoordinator(async () => {
      const evidence = trustedEvidence();
      // Simulate slow holder pagination / upstream risk probes after evidence
      // collection began. Its original timestamp must not be refreshed.
      clock += 31_000;
      return evidence;
    });
    await post(coordinator, "/kill-switch", { enabled: false });
    const result = await post(coordinator, "/reserve", validReservation({
      idempotencyKey: "order-key-slow-evidence"
    }));
    assert.equal(result.status, 409);
    assert.match(result.body.error, /Trusted token risk evidence is stale/);
  } finally {
    Date.now = originalNow;
  }
});

test("daily spend cap is enforced atomically and pending reservations remain counted", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const first = await post(coordinator, "/reserve", validReservation({
    idempotencyKey: "order-key-0001", amountLamports: 12_500_000, solUsd: 200
  }));
  const second = await post(coordinator, "/reserve", validReservation({
    idempotencyKey: "order-key-0002", amountLamports: 12_500_000, solUsd: 200
  }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const third = await post(coordinator, "/reserve", validReservation({
    idempotencyKey: "order-key-0003", amountLamports: 1_000_000, solUsd: 200
  }));
  assert.equal(third.status, 409);
  assert.match(third.body.error, /Daily USD spend limit/);
});

test("idempotency retries bypass quote expiry but never the emergency stop", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const first = await post(coordinator, "/reserve", validReservation());
  assert.equal(first.status, 200);

  // A duplicate retry does not need a fresh quote while reservations remain enabled.
  const retry = await post(coordinator, "/reserve", validReservation({
    quoteTimestamp: Date.now() - 60_000
  }));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.reservation.idempotencyKey, "order-key-0001");

  // But the emergency stop must take precedence over the idempotent fast path.
  await post(coordinator, "/kill-switch", { enabled: true });
  const stoppedRetry = await post(coordinator, "/reserve", validReservation({
    quoteTimestamp: Date.now() - 60_000
  }));
  assert.equal(stoppedRetry.status, 409);
  assert.match(stoppedRetry.body.error, /emergency kill switch is active/i);
});

test("idempotency key rejects any changed immutable order intent", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const first = await post(coordinator, "/reserve", validReservation({ solUsd: 1 }));
  assert.equal(first.status, 200);
  const changed = await post(coordinator, "/reserve", validReservation({
    amountLamports: 10_000_001, solUsd: 1
  }));
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /Idempotency key/);
});

test("ambiguous pending reservations cannot be failed or release capacity", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  await post(coordinator, "/reserve", validReservation());
  const rejected = await post(coordinator, "/fail", {
    idempotencyKey: "order-key-0001"
  });
  assert.equal(rejected.status, 409);
  const status = await coordinator.status();
  assert.equal(status.openPositions, 1);
  assert.equal(status.dailySpendUsdCents, 200);
});

test("fail and close transitions remain blocked without independent proof; confirmation requires finalized settlement", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  await post(coordinator, "/reserve", validReservation());

  for (const [path, extra] of [
    ["/fail", {
      definitelyNotSubmitted: true,
      resolutionReason: "RPC confirmed no transaction was submitted"
    }],
    ["/close", {}]
  ]) {
    const result = await post(coordinator, path, {
      idempotencyKey: "order-key-0001",
      ...extra
    });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /Independent failure and close proofs are not implemented/);
  }

  const status = await coordinator.status();
  assert.equal(status.openPositions, 1);
  assert.equal(status.dailySpendUsdCents, 200);
});

test("confirmation stores only independently verified finalized settlement evidence", async () => {
  let verifiedArgs;
  const verifier = async args => {
    verifiedArgs = args;
    return {
      verified: true, signature: args.signature, inputMint: args.inputMint,
      inputAmount: args.inputAmount, outputMint: args.outputMint,
      outputAmount: args.outputAmount, owner: args.expectedOwner,
      confirmationStatus: "finalized"
    };
  };
  const { coordinator } = makeCoordinator(undefined, verifier);
  await post(coordinator, "/kill-switch", { enabled: false });
  await post(coordinator, "/reserve", validReservation());
  const result = await post(coordinator, "/confirm", {
    idempotencyKey: "order-key-0001",
    signature: "5".repeat(64),
    outputAmount: "987654"
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.reservation.status, "confirmed");
  assert.equal(result.body.reservation.settlementProof.verified, true);
  assert.equal(verifiedArgs.inputMint, "So11111111111111111111111111111111111111112");
  assert.equal(verifiedArgs.inputAmount, "10000000");
  assert.equal(verifiedArgs.outputAmount, "987654");
  assert.equal((await coordinator.status()).openPositions, 1);
});

test("mismatched settlement proof cannot confirm a reservation", async () => {
  const verifier = async args => ({
    verified: true, signature: args.signature, inputMint: args.inputMint,
    inputAmount: args.inputAmount, outputMint: args.outputMint,
    outputAmount: "1", owner: args.expectedOwner, confirmationStatus: "finalized"
  });
  const { coordinator } = makeCoordinator(undefined, verifier);
  await post(coordinator, "/kill-switch", { enabled: false });
  await post(coordinator, "/reserve", validReservation());
  const result = await post(coordinator, "/confirm", {
    idempotencyKey: "order-key-0001", signature: "5".repeat(64), outputAmount: "987654"
  });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /proof is incomplete or mismatched/);
  assert.equal((await coordinator.status()).openPositions, 1);
});

test("browser-supplied risk flag is ignored; server evidence controls approval", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const result = await post(coordinator, "/reserve", validReservation({ riskPassed: false, solUsd: 0.01 }));
  assert.equal(result.status, 200);
  assert.equal(result.body.reservation.solUsd, 200);
  assert.equal(result.body.reservation.quoteProvider, "Coinbase");
});

test("server-side risk evidence failure blocks reservation even if browser claims approval", async () => {
  const { coordinator } = makeCoordinator(async () => trustedEvidence({
    passed: false, risk: { provider: "test-fixture", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fetchedAt: Date.now(), checks: {}, passed: false }
  }));
  await post(coordinator, "/kill-switch", { enabled: false });
  const result = await post(coordinator, "/reserve", validReservation({ riskPassed: true }));
  assert.equal(result.status, 409);
  assert.match(result.body.error, /risk checks/);
});

test("coordinator blocks reservation when Jupiter instruction semantics are unverified", async () => {
  const evidence = trustedEvidence();
  evidence.passed = false;
  evidence.risk.passed = false;
  evidence.risk.checks.sellRouteAvailable = false;
  const { coordinator } = makeCoordinator(async () => evidence);
  await post(coordinator, "/kill-switch", { enabled: false });
  const result = await post(coordinator, "/reserve", validReservation());
  assert.equal(result.status, 409);
  assert.match(result.body.error, /risk checks/);
});

test("coordinator rejects a positive sell-route flag without semantic instruction verification", async () => {
  const evidence = trustedEvidence();
  evidence.risk.sellRoute = {
    semanticInstructionVerification: false,
    routeVerification: "unsigned-transaction-structure-only"
  };
  const { coordinator } = makeCoordinator(async () => evidence);
  await post(coordinator, "/kill-switch", { enabled: false });
  const result = await post(coordinator, "/reserve", validReservation());
  assert.equal(result.status, 409);
  assert.match(result.body.error, /instruction semantics and lookup tables are not verified/);
});

test("ten open reservations block an eleventh", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  for (let i = 0; i < 10; i++) {
    const result = await post(coordinator, "/reserve", validReservation({
      idempotencyKey: "position-key-" + String(i).padStart(4, "0"),
      amountLamports: 1_000_000,
      solUsd: 200
    }));
    assert.equal(result.status, 200);
  }
  const blocked = await post(coordinator, "/reserve", validReservation({
    idempotencyKey: "position-key-0010",
    amountLamports: 1_000_000,
    solUsd: 200
  }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Maximum open positions/);
});

test("concurrent reservations cannot exceed the $5 daily cap", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const requests = [0, 1, 2].map(i => post(coordinator, "/reserve", validReservation({
    idempotencyKey: "parallel-key-" + String(i).padStart(4, "0"),
    amountLamports: 12_500_000,
    solUsd: 200
  })));
  const results = await Promise.all(requests);
  assert.equal(results.filter(result => result.status === 200).length, 2);
  assert.equal(results.filter(result => result.status === 409).length, 1);
});

test("emergency stop blocks new reservations immediately", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  await post(coordinator, "/kill-switch", { enabled: true });
  const result = await post(coordinator, "/reserve", validReservation());
  assert.equal(result.status, 409);
});

test("kill switch requires a separate operator credential and records an audit trail", async () => {
  const { coordinator } = makeCoordinator();

  const missingOperator = await post(coordinator, "/kill-switch", { enabled: false }, null);
  assert.equal(missingOperator.status, 401);
  assert.match(missingOperator.body.error, /operator/i);

  const reusedInternal = await post(coordinator, "/kill-switch", { enabled: false },
    "test-only-internal-token-32-characters");
  assert.equal(reusedInternal.status, 401);
  assert.equal((await coordinator.status()).killSwitch, true);

  const disabled = await post(coordinator, "/kill-switch", { enabled: false });
  assert.equal(disabled.status, 200);
  const enabled = await post(coordinator, "/kill-switch", { enabled: true });
  assert.equal(enabled.status, 200);

  const unauthorizedAudit = await coordinator.fetch(new Request("https://coordinator/audit", {
    headers: { Authorization: "Bearer test-only-internal-token-32-characters" }
  }));
  assert.equal(unauthorizedAudit.status, 401);

  const audit = await coordinator.fetch(new Request("https://coordinator/audit", {
    headers: {
      Authorization: "Bearer test-only-internal-token-32-characters",
      "X-Operator-Token": "test-only-operator-token-32-characters"
    }
  }));
  assert.equal(audit.status, 200);
  const body = await audit.json();
  assert.deepEqual(body.events.map(event => event.action), ["deactivated", "activated"]);
  assert.equal(body.events[1].previousKillSwitch, false);
  assert.equal(body.events[1].killSwitch, true);
});


test("coordinator rejects requests without the internal bearer credential", async () => {
  const { coordinator } = makeCoordinator();
  const response = await coordinator.fetch(new Request("https://coordinator/status"));
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Unauthorized/);
});



test("coordinator requires a well-formed Bearer authorization header", async () => {
  const { coordinator } = makeCoordinator();
  for (const authorization of [
    "test-only-internal-token-32-characters",
    "Bearer test-only-internal-token-32-characters extra",
    "Basic test-only-internal-token-32-characters",
    "Bearer"
  ]) {
    const response = await coordinator.fetch(new Request("https://coordinator/status", {
      headers: { Authorization: authorization }
    }));
    assert.equal(response.status, 401, authorization);
  }
});

test("idempotency binds mint, destination, slippage and quote identity", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const first = await post(coordinator, "/reserve", validReservation());
  assert.equal(first.status, 200);
  const changed = await post(coordinator, "/reserve", validReservation({
    destination: "11111111111111111111111111111111"
  }));
  assert.equal(changed.status, 400);
  assert.match(changed.body.error, /immutable order intent/);
});


test("reservation history is bounded without discarding idempotency records", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const original = validReservation();
  const first = await post(coordinator, "/reserve", original);
  assert.equal(first.status, 200);

  await coordinator.withState(state => {
    for (let i = 1; i < 1000; i++) {
      state.reservations["capacity-key-" + String(i).padStart(4, "0")] = {
        idempotencyKey: "capacity-key-" + String(i).padStart(4, "0"),
        intentFingerprint: "historical-" + i,
        amountCents: 0,
        day: new Date().toISOString().slice(0, 10),
        status: "failed"
      };
    }
  });

  await post(coordinator, "/kill-switch", { enabled: true });
  const duplicate = await post(coordinator, "/reserve", original);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /emergency kill switch is active/i);

  // Re-enable reservations only to exercise the capacity guard.
  await post(coordinator, "/kill-switch", { enabled: false });
  const blocked = await post(coordinator, "/reserve", validReservation({
    idempotencyKey: "capacity-new-order"
  }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /history capacity reached/);
  const status = await coordinator.status();
  assert.equal(status.limits.maxReservations, 1000);
});


test("concurrent retries with the same idempotency key create exactly one reservation", async () => {
  const { coordinator, storage } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });

  const requests = [0, 1].map(() => post(coordinator, "/reserve", validReservation()));
  const results = await Promise.all(requests);
  assert.equal(results.filter(result => result.status === 200).length, 2);
  assert.equal(results.filter(result => result.body.duplicate === false).length, 1);
  assert.equal(results.filter(result => result.body.duplicate === true).length, 1);

  const state = await storage.get("coordinator_state");
  assert.equal(Object.keys(state.reservations).filter(key => key === "order-key-0001").length, 1);
  assert.equal(Object.keys(state.reservations).length, 1);
});

test("kill switch blocks an in-flight duplicate after another request reserves the same key", async () => {
  let releaseFirstEvidence;
  let signalFirstEvidence;
  const firstEvidenceStarted = new Promise(resolve => { signalFirstEvidence = resolve; });
  const firstEvidenceGate = new Promise(resolve => { releaseFirstEvidence = resolve; });
  let evidenceCalls = 0;
  const { coordinator } = makeCoordinator(async () => {
    evidenceCalls += 1;
    if (evidenceCalls === 1) {
      signalFirstEvidence();
      await firstEvidenceGate;
    }
    return trustedEvidence();
  });

  await post(coordinator, "/kill-switch", { enabled: false });
  const inFlight = post(coordinator, "/reserve", validReservation());
  await firstEvidenceStarted;

  // A second request with the same intent wins the reservation while the
  // first request is still fetching evidence.
  const winner = await post(coordinator, "/reserve", validReservation());
  assert.equal(winner.status, 200);
  assert.equal(winner.body.duplicate, false);

  await post(coordinator, "/kill-switch", { enabled: true });
  releaseFirstEvidence();
  const stopped = await inFlight;
  assert.equal(stopped.status, 409);
  assert.match(stopped.body.error, /emergency kill switch is active/i);
});

test("kill switch activated during evidence retrieval blocks the in-flight reservation", async () => {
  let signalStarted;
  let releaseEvidence;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const evidenceGate = new Promise(resolve => { releaseEvidence = resolve; });
  const { coordinator } = makeCoordinator(async () => {
    signalStarted();
    await evidenceGate;
    return trustedEvidence();
  });
  await post(coordinator, "/kill-switch", { enabled: false });

  const pendingReservation = post(coordinator, "/reserve", validReservation());
  await started;
  const stopped = await post(coordinator, "/kill-switch", { enabled: true });
  assert.equal(stopped.status, 200);
  releaseEvidence();

  const result = await pendingReservation;
  assert.equal(result.status, 409);
  assert.match(result.body.error, /kill switch/);
  const status = await coordinator.status();
  assert.equal(status.openPositions, 0);
  assert.equal(status.dailySpendUsdCents, 0);
});
