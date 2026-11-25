import test from "node:test";
import assert from "node:assert/strict";
import { LiveOrderLedger } from "../live-order-ledger.js";
import { reservePreparedEvidence } from "../live-order-evidence-reservation.js";
import { prepareLiveOrderEvidence } from "../live-order-evidence-service.js";

const secret = "reservation-test-server-secret-long-enough";
const base = {
  idempotencyKey: "reserve-order-key-12345",
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amountAtomic: "125000000"
};
function storageMock() {
  const map = new Map();
  let queue = Promise.resolve();
  return {
    async get(key) { return map.get(key); },
    async transaction(fn) {
      const prior = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await prior;
      const staged = new Map();
      try {
        const result = await fn({
          get: async key => staged.has(key) ? staged.get(key) : map.get(key),
          put: async (key, value) => staged.set(key, value)
        });
        for (const [key, value] of staged) map.set(key, value);
        return result;
      } finally { release(); }
    }
  };
}
async function evidence(binding, clock) {
  return prepareLiveOrderEvidence({
    binding, secret, now: () => clock,
    inspectRisk: async mint => ({ ok: true, mint, rugScore: 120, largestPct: 10, topTenPct: 25 }),
    fetchQuote: async args => ({
      provider: "jupiter-swap-v2", inputMint: args.inputMint, outputMint: args.outputMint,
      inputAmountAtomic: args.amountAtomic, outputAmountAtomic: "900000",
      fetchedAt: clock, evidenceClass: "provider-response-unverified"
    })
  });
}

test("verified evidence creates one durable created-status reservation", async () => {
  const clock = 1_800_000_000_000;
  const ledger = new LiveOrderLedger(storageMock());
  const prepared = await evidence(base, clock);
  const result = await reservePreparedEvidence({
    binding: base, attestation: prepared.attestation, ledger, secret, now: () => clock + 2
  });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.status, "created");
  assert.equal(result.execution, "not-authorized");
  assert.match(result.record.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.record.evidenceExpiresAt, clock + 15000);
  assert.equal("signature" in result.record, false);
  assert.equal("transaction" in result.record, false);
});

test("same request key and fingerprint return the existing record", async () => {
  const clock = 1_800_000_000_000;
  const ledger = new LiveOrderLedger(storageMock());
  const prepared = await evidence(base, clock);
  const args = { binding: base, attestation: prepared.attestation, ledger, secret, now: () => clock + 1 };
  assert.equal((await reservePreparedEvidence(args)).duplicate, false);
  const again = await reservePreparedEvidence(args);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.version, 1);
});

test("same idempotency key with different request binding conflicts", async () => {
  const clock = 1_800_000_000_000;
  const ledger = new LiveOrderLedger(storageMock());
  const first = await evidence(base, clock);
  await reservePreparedEvidence({ binding: base, attestation: first.attestation, ledger, secret, now: () => clock + 1 });
  const altered = { ...base, amountAtomic: "125000001" };
  const second = await evidence(altered, clock + 10);
  const result = await reservePreparedEvidence({
    binding: altered, attestation: second.attestation, ledger, secret, now: () => clock + 11
  });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
});

test("tampered or expired attestation is rejected before ledger create", async () => {
  const clock = 1_800_000_000_000;
  let creates = 0;
  const ledger = { async create() { creates++; return { ok: true }; } };
  const prepared = await evidence(base, clock);
  const altered = { ...prepared.attestation, signature: "A".repeat(43) };
  assert.equal((await reservePreparedEvidence({
    binding: base, attestation: altered, ledger, secret, now: () => clock + 1
  })).ok, false);
  assert.equal((await reservePreparedEvidence({
    binding: base, attestation: prepared.attestation, ledger, secret, now: () => clock + 16000
  })).ok, false);
  assert.equal(creates, 0);
});

test("reservation requires ledger and never invokes any execution capability", async () => {
  const clock = 1_800_000_000_000;
  const prepared = await evidence(base, clock);
  assert.equal((await reservePreparedEvidence({
    binding: base, attestation: prepared.attestation, secret, now: () => clock + 1
  })).ok, false);
});

test("evidence-only reservation cannot enter validated or submitted lifecycle", async () => {
  const clock = Date.now();
  const ledger = new LiveOrderLedger(storageMock());
  const prepared = await evidence(base, clock);
  const reservation = await reservePreparedEvidence({
    binding: base, attestation: prepared.attestation, ledger, secret, now: () => clock + 1
  });
  assert.equal(reservation.ok, true);
  const transition = await ledger.transition(base.idempotencyKey, 1, "validated");
  assert.equal(transition.ok, false);
  assert.match(transition.reason, /Evidence-only reservation/);
  const rejected = await ledger.transition(base.idempotencyKey, 1, "rejected");
  assert.equal(rejected.ok, true);
  assert.equal(rejected.record.status, "rejected");
});
