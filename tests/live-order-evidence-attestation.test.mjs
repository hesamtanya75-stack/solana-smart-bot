import test from "node:test";
import assert from "node:assert/strict";
import { createOrderEvidenceAttestation, verifyOrderEvidenceAttestation } from "../live-order-evidence-attestation.js";

const now = 1_800_000_000_000;
const secret = "test-only-secret-with-more-than-32-characters";
const binding = {
  idempotencyKey: "order-key-123456789",
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amountAtomic: "50000000"
};
const quote = {
  provider: "jupiter-swap-v2",
  inputMint: binding.inputMint,
  outputMint: binding.outputMint,
  inputAmountAtomic: binding.amountAtomic,
  outputAmountAtomic: "1000000",
  fetchedAt: now - 500,
  evidenceClass: "provider-response-unverified"
};
const risk = { passed: true, mint: binding.outputMint, checkedAt: now - 1000, riskSource: "server-inspection-v1" };

test("server HMAC attestation binds request, quote, and fresh risk snapshot", async () => {
  const attestation = await createOrderEvidenceAttestation({ binding, quote, risk, secret, now });
  const verified = await verifyOrderEvidenceAttestation({ attestation, expectedBinding: binding, secret, now: now + 1 });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.binding.amountAtomic, binding.amountAtomic);
});

test("rejects changed order binding and modified evidence", async () => {
  const attestation = await createOrderEvidenceAttestation({ binding, quote, risk, secret, now });
  assert.equal((await verifyOrderEvidenceAttestation({
    attestation, expectedBinding: { ...binding, amountAtomic: "50000001" }, secret, now: now + 1
  })).ok, false);
  const altered = { ...attestation, payload: { ...attestation.payload, quote: { ...quote, outputAmountAtomic: "9" } } };
  assert.equal((await verifyOrderEvidenceAttestation({ attestation: altered, expectedBinding: binding, secret, now: now + 1 })).ok, false);
});

test("fails closed for expired, stale, failed, mismatched, and unconfigured evidence", async () => {
  const attestation = await createOrderEvidenceAttestation({ binding, quote, risk, secret, now });
  assert.equal((await verifyOrderEvidenceAttestation({ attestation, expectedBinding: binding, secret, now: now + 15000 })).ok, false);
  await assert.rejects(createOrderEvidenceAttestation({
    binding, quote, risk: { ...risk, checkedAt: now - 16000 }, secret, now
  }));
  await assert.rejects(createOrderEvidenceAttestation({
    binding, quote: { ...quote, inputAmountAtomic: "1" }, risk, secret, now
  }));
  await assert.rejects(createOrderEvidenceAttestation({
    binding, quote: { ...quote, fetchedAt: now - 16000 }, risk, secret, now
  }));
  await assert.rejects(createOrderEvidenceAttestation({
    binding, risk: { ...risk, mint: binding.inputMint }, quote, secret, now
  }));
  await assert.rejects(createOrderEvidenceAttestation({ binding, quote, risk, secret: "short", now }));
});

test("rejects quote evidence that names an unexpected provider", async () => {
  await assert.rejects(createOrderEvidenceAttestation({
    binding, quote: { ...quote, provider: "unverified-injected-provider" }, risk, secret, now
  }), /does not bind|unsupported provenance/);
});
test("rejects malformed bindings and tampered signatures", async () => {
  await assert.rejects(createOrderEvidenceAttestation({
    binding: { ...binding, inputMint: "11111111111111111111111111111111111111111111" }, quote, risk, secret, now
  }));
  await assert.rejects(createOrderEvidenceAttestation({
    binding: { ...binding, amountAtomic: "0" }, quote, risk, secret, now
  }));
  const attestation = await createOrderEvidenceAttestation({ binding, quote, risk, secret, now });
  const badSig = { ...attestation, signature: "A".repeat(43) };
  assert.equal((await verifyOrderEvidenceAttestation({ attestation: badSig, expectedBinding: binding, secret, now: now + 1 })).ok, false);
});

test("rejects noncanonical Base64URL signature trailing bits", async () => {
  const attestation = await createOrderEvidenceAttestation({ binding, quote, risk, secret, now });
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = attestation.signature.at(-1);
  const index = alphabet.indexOf(last);
  // Base64URL encodes 32 bytes in 43 chars; the final two bits are unused.
  const alternate = alphabet[index & 60 | ((index + 1) & 3)];
  const altered = { ...attestation, signature: attestation.signature.slice(0, -1) + alternate };
  assert.equal((await verifyOrderEvidenceAttestation({
    attestation: altered, expectedBinding: binding, secret, now: now + 1
  })).ok, false);
});
