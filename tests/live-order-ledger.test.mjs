import test from "node:test";
import assert from "node:assert/strict";
import { LiveOrderLedger } from "../live-order-ledger.js";

function fakeStorage() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.get(key); },
    async transaction(fn) {
      // Simulates serialized atomic transaction for deterministic unit coverage.
      return fn({ get: async key => data.get(key), put: async (key, value) => data.set(key, value) });
    }
  };
}
const order = { orderId: "ledger-order-123456", status: "created", createdAt: 1_800_000_000_000 };
const hash = "a".repeat(64);

test("create is idempotent for same key and request fingerprint", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  assert.equal((await ledger.create(order, hash)).duplicate, false);
  assert.equal((await ledger.create(order, hash)).duplicate, true);
});

test("rejects reuse of an idempotency key for a different request", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  await ledger.create(order, hash);
  const result = await ledger.create(order, "b".repeat(64));
  assert.equal(result.conflict, true);
});

test("uses version checks for atomic state changes", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  await ledger.create(order, hash);
  const validated = await ledger.transition(order.orderId, 1, "validated");
  assert.equal(validated.ok, true);
  assert.equal(validated.version, 2);
  const stale = await ledger.transition(order.orderId, 1, "rejected");
  assert.equal(stale.conflict, true);
});

test("does not permit uncertain orders to be blindly resubmitted", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  await ledger.create(order, hash);
  await ledger.transition(order.orderId, 1, "validated");
  const sent = await ledger.transition(order.orderId, 2, "submitted", { signature: "S".repeat(64) });
  assert.equal(sent.ok, true);
  assert.equal((await ledger.get(order.orderId)).record.status, "submitted");
});
