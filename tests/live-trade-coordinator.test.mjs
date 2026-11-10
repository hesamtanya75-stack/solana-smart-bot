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
      }, passed: true },
    passed: true,
    ...overrides
  };
}
function makeCoordinator(evidenceProvider = async () => trustedEvidence()) {
  const storage = new MemoryStorage();
  const coordinator = new LiveTradeCoordinator({ storage }, {
    COORDINATOR_INTERNAL_TOKEN: "test-only-internal-token-32-characters",
    FETCH_TRUSTED_LIVE_EVIDENCE: evidenceProvider
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
async function post(coordinator, path, body) {
  const response = await coordinator.fetch(new Request("https://coordinator" + path, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-only-internal-token-32-characters" }, body: JSON.stringify(body)
  }));
  return { status: response.status, body: await response.json() };
}

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

test("daily spend cap is enforced atomically and confirmed/closed spend remains counted", async () => {
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
  await post(coordinator, "/confirm", { idempotencyKey: "order-key-0001" });
  await post(coordinator, "/close", { idempotencyKey: "order-key-0001" });
  const third = await post(coordinator, "/reserve", validReservation({
    idempotencyKey: "order-key-0003", amountLamports: 1_000_000, solUsd: 200
  }));
  assert.equal(third.status, 409);
  assert.match(third.body.error, /Daily USD spend limit/);
});

test("idempotency retries succeed after quote expiry and kill switch activation", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const first = await post(coordinator, "/reserve", validReservation());
  assert.equal(first.status, 200);
  await post(coordinator, "/kill-switch", { enabled: true });
  const retry = await post(coordinator, "/reserve", validReservation({
    quoteTimestamp: Date.now() - 60_000
  }));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.reservation.idempotencyKey, "order-key-0001");
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

test("only explicitly confirmed non-submission can release a pending reservation", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  await post(coordinator, "/reserve", validReservation());
  const failed = await post(coordinator, "/fail", {
    idempotencyKey: "order-key-0001",
    definitelyNotSubmitted: true,
    resolutionReason: "RPC confirmed no transaction was submitted"
  });
  assert.equal(failed.status, 200);
  const status = await coordinator.status();
  assert.equal(status.openPositions, 0);
  assert.equal(status.dailySpendUsdCents, 0);
});

test("browser-supplied risk flag is ignored; server evidence controls approval", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const result = await post(coordinator, "/reserve", validReservation({ riskPassed: false, solUsd: 0.01 }));
  assert.equal(result.status, 200);
  assert.equal(result.body.reservation.solUsd, 200);
  assert.equal(result.body.reservation.quoteProvider, "test-fixture");
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


test("coordinator rejects requests without the internal bearer credential", async () => {
  const { coordinator } = makeCoordinator();
  const response = await coordinator.fetch(new Request("https://coordinator/status"));
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Unauthorized/);
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
