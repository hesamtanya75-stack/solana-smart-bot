import test from "node:test";
import assert from "node:assert/strict";
import { LiveOrderLedger } from "../live-order-ledger.js";

function fakeStorage() {
  const data = new Map();
  let tail = Promise.resolve();
  return {
    data,
    async get(key) { return data.get(key); },
    async transaction(fn) {
      // Serialized transaction mock: useful for race tests, not Cloudflare runtime proof.
      const previous = tail;
      let release;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      const staged = new Map();
      try {
        const result = await fn({
          get: async key => staged.has(key) ? staged.get(key) : data.get(key),
          put: async (key, value) => staged.set(key, value)
        });
        for (const [key, value] of staged) data.set(key, value);
        return result;
      } finally {
        release();
      }
    }
  };
}
const order = { orderId: "ledger-order-123456", status: "created", createdAt: 1_800_000_000_000 };
const hash = "a".repeat(64);

test("mock transaction discards staged writes when callback throws", async () => {
  const storage = fakeStorage();
  await assert.rejects(storage.transaction(async txn => {
    await txn.put("temporary", { value: 1 });
    throw new Error("simulated transaction failure");
  }), /simulated transaction failure/);
  assert.equal(await storage.get("temporary"), undefined);
});

test("returned ledger records are defensive copies", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  const created = await ledger.create(order, hash);
  created.record.status = "confirmed";
  const fetched = await ledger.get(order.orderId);
  fetched.record.status = "failed";
  const again = await ledger.get(order.orderId);
  assert.equal(again.record.status, "created");
  assert.equal(again.version, 1);
});

test("idempotency fingerprint comparison is case-insensitive hex", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  await ledger.create(order, hash.toUpperCase());
  const result = await ledger.create(order, hash.toLowerCase());
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
});

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

test("serial transaction mock permits only one concurrent create for a key", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  const results = await Promise.all([
    ledger.create(order, hash),
    ledger.create(order, hash),
    ledger.create(order, hash)
  ]);
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  assert.equal(results.filter(result => result.duplicate).length, 2);
  assert.equal((await ledger.get(order.orderId)).version, 1);
});

test("uses version checks for state changes and rejects stale versions", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  await ledger.create(order, hash);
  const validated = await ledger.transition(order.orderId, 1, "validated");
  assert.equal(validated.ok, true);
  assert.equal(validated.version, 2);
  const stale = await ledger.transition(order.orderId, 1, "rejected");
  assert.equal(stale.conflict, true);
});

test("concurrent compare-and-swap transitions cannot both consume one version", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  await ledger.create(order, hash);
  const results = await Promise.all([
    ledger.transition(order.orderId, 1, "validated"),
    ledger.transition(order.orderId, 1, "rejected")
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.conflict).length, 1);
  assert.equal((await ledger.get(order.orderId)).version, 2);
});

test("does not permit uncertain orders to be blindly resubmitted", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  await ledger.create(order, hash);
  await ledger.transition(order.orderId, 1, "validated");
  const sent = await ledger.transition(order.orderId, 2, "submitted", { signature: "S".repeat(64) });
  assert.equal(sent.ok, true);
  assert.equal((await ledger.get(order.orderId)).record.status, "submitted");
});
