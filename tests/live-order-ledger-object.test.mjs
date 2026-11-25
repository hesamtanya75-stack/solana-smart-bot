import test from "node:test";
import assert from "node:assert/strict";
import { LiveOrderLedgerObject } from "../live-order-ledger-object.js";
import { prepareLiveOrderEvidence } from "../live-order-evidence-service.js";

const secret = "durable-object-reservation-secret-minimum-32";
const binding = {
  idempotencyKey: "do-reservation-test-key-9876",
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amountAtomic: "10000000"
};
function mockStorage() {
  const values = new Map();
  let tail = Promise.resolve();
  return {
    async get(key) { return values.get(key); },
    async transaction(fn) {
      const previous = tail;
      let unlock;
      tail = new Promise(resolve => { unlock = resolve; });
      await previous;
      const writes = new Map();
      try {
        const result = await fn({
          get: async key => writes.has(key) ? writes.get(key) : values.get(key),
          put: async (key, value) => writes.set(key, value)
        });
        for (const [key, value] of writes) values.set(key, value);
        return result;
      } finally { unlock(); }
    }
  };
}
async function attested() {
  const t = Date.now();
  const result = await prepareLiveOrderEvidence({
    binding, secret, now: () => t,
    inspectRisk: async mint => ({ ok: true, mint, rugScore: 100 }),
    fetchQuote: async q => ({
      provider: "mock", inputMint: q.inputMint, outputMint: q.outputMint,
      inputAmountAtomic: q.amountAtomic, outputAmountAtomic: "800000",
      fetchedAt: t, evidenceClass: "provider-response-unverified"
    })
  });
  return result.attestation;
}
function request(body, headers = { "Content-Type": "application/json" }) {
  return new Request("https://do.internal/reserve-evidence", {
    method: "POST", headers, body: JSON.stringify(body)
  });
}

test("Durable Object verifies and stores evidence reservation", async () => {
  const object = new LiveOrderLedgerObject({ storage: mockStorage() }, {
    LIVE_ORDER_EVIDENCE_HMAC_SECRET: secret
  });
  const body = { binding, attestation: await attested() };
  const firstResponse = await object.fetch(request(body));
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.equal(first.reservation.status, "created");
  assert.equal(first.reservation.execution, "not-authorized");

  const duplicateResponse = await object.fetch(request(body));
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicate.reservation.duplicate, true);
  assert.equal(duplicate.reservation.version, 1);
});

test("concurrent identical reservations serialize to one record", async () => {
  const object = new LiveOrderLedgerObject({ storage: mockStorage() }, {
    LIVE_ORDER_EVIDENCE_HMAC_SECRET: secret
  });
  const body = { binding, attestation: await attested() };
  const responses = await Promise.all([object.fetch(request(body)), object.fetch(request(body))]);
  const results = await Promise.all(responses.map(r => r.json()));
  assert.deepEqual(results.map(x => x.reservation.duplicate).sort(), [false, true]);
  assert.equal(results[0].reservation.version, 1);
  assert.equal(results[1].reservation.version, 1);
});

test("Durable Object rejects malformed payloads and missing secret", async () => {
  const object = new LiveOrderLedgerObject({ storage: mockStorage() }, {});
  assert.equal((await object.fetch(request({ binding, attestation: await attested() }))).status, 503);
  const configured = new LiveOrderLedgerObject({ storage: mockStorage() }, {
    LIVE_ORDER_EVIDENCE_HMAC_SECRET: secret
  });
  assert.equal((await configured.fetch(request([]))).status, 400);
  assert.equal((await configured.fetch(request({}, { "Content-Type": "text/plain" }))).status, 415);
});
