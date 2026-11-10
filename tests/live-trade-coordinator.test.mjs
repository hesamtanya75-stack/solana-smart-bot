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
function makeCoordinator() {
  const storage = new MemoryStorage();
  const coordinator = new LiveTradeCoordinator({ storage }, {});
  return { coordinator, storage };
}
function validReservation(overrides = {}) {
  return {
    idempotencyKey: "order-key-0001",
    amountLamports: 10_000_000,
    solUsd: 200,
    quoteTimestamp: Date.now(),
    riskPassed: true,
    ...overrides
  };
}
async function post(coordinator, path, body) {
  const response = await coordinator.fetch(new Request("https://coordinator" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
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
  const stale = await post(coordinator, "/reserve", validReservation({
    idempotencyKey: "order-key-stale", quoteTimestamp: Date.now() - 31_000
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

test("idempotency prevents duplicate reservations and rejects changed amounts", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const first = await post(coordinator, "/reserve", validReservation());
  const duplicate = await post(coordinator, "/reserve", validReservation());
  assert.equal(first.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  const changed = await post(coordinator, "/reserve", validReservation({ amountLamports: 11_000_000 }));
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /Idempotency key/);
});

test("failed reservations release capacity but closed positions retain daily spend", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  await post(coordinator, "/reserve", validReservation());
  await post(coordinator, "/fail", { idempotencyKey: "order-key-0001" });
  const status = await coordinator.status();
  assert.equal(status.openPositions, 0);
  assert.equal(status.dailySpendUsdCents, 0);
});

test("missing server-side risk approval fails closed", async () => {
  const { coordinator } = makeCoordinator();
  await post(coordinator, "/kill-switch", { enabled: false });
  const result = await post(coordinator, "/reserve", validReservation({ riskPassed: false }));
  assert.equal(result.status, 409);
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
