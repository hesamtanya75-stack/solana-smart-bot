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


test("evidence reservation rejects a duplicate key with a changed evidence digest", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  const evidenceOrder = { ...order, evidenceDigest: "c".repeat(64), evidencePreparedAt: 1_800_000_000_000, evidenceExpiresAt: 1_800_000_015_000 };
  assert.equal((await ledger.create(evidenceOrder, hash)).duplicate, false);
  const changedEvidence = { ...evidenceOrder, evidenceDigest: "d".repeat(64) };
  const result = await ledger.create(changedEvidence, hash);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.match(result.reason, /different evidence/);
  assert.equal((await ledger.get(order.orderId)).record.evidenceDigest, "c".repeat(64));
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


async function makeUncertain(ledger, id = order.orderId) {
  await ledger.create({ ...order, orderId: id }, hash);
  await ledger.transition(id, 1, "validated");
  await ledger.transition(id, 2, "submitted", { signature: "S".repeat(64) });
  return ledger.transition(id, 3, "reconciliation_required");
}

test("ledger rejects caller-supplied terminal reconciliation metadata", async () => {
  const ledger = new LiveOrderLedger(fakeStorage());
  await makeUncertain(ledger);
  const forged = await ledger.transition(order.orderId, 4, "confirmed", {
    finalizedAt: 1_800_000_000_100,
    reconciledAt: 1_800_000_000_100,
    reconciliationResult: "confirmed"
  });
  assert.equal(forged.ok, false);
  assert.match(forged.reason, /server-side signature reconciliation/);
});

test("server reconciler binds finalized evidence to stored signature before terminal commit", async () => {
  let observedSignature;
  const ledger = new LiveOrderLedger(fakeStorage(), {
    reconcileSignature: async signature => {
      observedSignature = signature;
      return { signature, outcome: "confirmed", observedAt: 1_800_000_000_100, slot: 99 };
    }
  });
  await makeUncertain(ledger);
  const reconciled = await ledger.reconcile(order.orderId, 4);
  assert.equal(observedSignature, "S".repeat(64));
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.record.status, "confirmed");
  assert.equal(reconciled.record.signature, observedSignature);
  assert.equal(reconciled.record.reconciliationResult, "confirmed");
  assert.equal(reconciled.record.reconciledAt, 1_800_000_000_100);
  assert.equal(reconciled.version, 5);
});

test("pending reconciliation leaves uncertain order untouched", async () => {
  const ledger = new LiveOrderLedger(fakeStorage(), {
    reconcileSignature: async signature => ({ signature, outcome: "pending", observedAt: 1_800_000_000_100 })
  });
  await makeUncertain(ledger);
  const pending = await ledger.reconcile(order.orderId, 4);
  assert.equal(pending.ok, true);
  assert.equal(pending.pending, true);
  assert.equal((await ledger.get(order.orderId)).record.status, "reconciliation_required");
});

test("mismatched or malformed server evidence cannot finalize an order", async () => {
  for (const evidence of [
    { signature: "X".repeat(64), outcome: "confirmed", observedAt: 1_800_000_000_100, slot: 9 },
    { signature: "S".repeat(64), outcome: "confirmed", observedAt: 1_800_000_000_100 },
    { signature: "S".repeat(64), outcome: "confirmed", observedAt: 1_800_000_000_100, slot: 0 }
  ]) {
    const ledger = new LiveOrderLedger(fakeStorage(), { reconcileSignature: async () => evidence });
    await makeUncertain(ledger);
    assert.equal((await ledger.reconcile(order.orderId, 4)).ok, false);
    assert.equal((await ledger.get(order.orderId)).record.status, "reconciliation_required");
  }
});

test("RPC reconciliation failure and stale version fail closed", async () => {
  const ledger = new LiveOrderLedger(fakeStorage(), {
    reconcileSignature: async () => { throw new Error("private RPC error"); }
  });
  await makeUncertain(ledger);
  assert.equal((await ledger.reconcile(order.orderId, 3)).conflict, true);
  assert.equal((await ledger.reconcile(order.orderId, 4)).ok, false);
  assert.equal((await ledger.get(order.orderId)).record.status, "reconciliation_required");
});
