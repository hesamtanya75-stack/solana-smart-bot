import test from "node:test";
import assert from "node:assert/strict";
import { prepareLiveOrderEvidence } from "../live-order-evidence-service.js";
import { verifyOrderEvidenceAttestation } from "../live-order-evidence-attestation.js";

const secret = "unit-test-server-secret-long-enough-to-use-hmac";
const binding = {
  idempotencyKey: "evidence-key-123456789",
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amountAtomic: "50000000"
};
const quote = now => ({
  provider: "jupiter-swap-v2",
  inputMint: binding.inputMint,
  outputMint: binding.outputMint,
  inputAmountAtomic: binding.amountAtomic,
  outputAmountAtomic: "1000000",
  fetchedAt: now,
  evidenceClass: "provider-response-unverified"
});

test("prepares authenticated read-only evidence from injected server providers", async () => {
  let riskMint, quoteArgs, clock = 1_800_000_000_000;
  const result = await prepareLiveOrderEvidence({
    binding, secret,
    now: () => clock,
    inspectRisk: async mint => {
      riskMint = mint;
      return { ok: true, rugScore: 300, largestPct: 12, topTenPct: 35 };
    },
    fetchQuote: async args => {
      quoteArgs = args;
      return quote(clock);
    }
  });
  assert.equal(riskMint, binding.outputMint);
  assert.deepEqual(quoteArgs, {
    inputMint: binding.inputMint, outputMint: binding.outputMint, amountAtomic: binding.amountAtomic
  });
  assert.equal(result.mode, "read-only-evidence");
  assert.equal(result.execution, "not-authorized");
  assert.equal((await verifyOrderEvidenceAttestation({
    attestation: result.attestation, expectedBinding: binding, secret, now: clock + 1
  })).ok, true);
});

test("risk failure prevents quote fetching and fails closed", async () => {
  let quoteCalled = false;
  await assert.rejects(prepareLiveOrderEvidence({
    binding, secret, inspectRisk: async () => ({ ok: false, reasons: ["risk gate"] }),
    fetchQuote: async () => { quoteCalled = true; return quote(Date.now()); }
  }), error => error.code === "RISK_REJECTED");
  assert.equal(quoteCalled, false);
});

test("malformed order or absent trusted providers are rejected", async () => {
  await assert.rejects(prepareLiveOrderEvidence({
    binding: { ...binding, amountAtomic: "0" }, secret,
    inspectRisk: async () => ({ ok: true }), fetchQuote: async () => quote(Date.now())
  }));
  await assert.rejects(prepareLiveOrderEvidence({ binding, secret }));
});

test("stale risk evidence fails attestation after slow quote provider", async () => {
  let clock = 1_800_000_000_000;
  await assert.rejects(prepareLiveOrderEvidence({
    binding, secret, now: () => clock,
    inspectRisk: async () => ({ ok: true }),
    fetchQuote: async () => { clock += 16000; return quote(clock); }
  }));
});
