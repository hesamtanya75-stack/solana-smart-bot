import test from "node:test";
import assert from "node:assert/strict";
import { calculateVerifiedTransactionCosts } from "../verified-transaction-costs.mjs";

function evidence(overrides = {}) {
  return {
    semanticInstructionVerification: true,
    messageAccountEffectsVerified: true,
    feeQuoteBoundToMessage: true,
    messageDigest: "a".repeat(64),
    computeUnitPriceMicroLamports: "10000",
    computeUnitLimit: "200000",
    baseFeeLamports: "5000",
    tipLamports: "1000",
    rentLamports: "2039280",
    otherOutflowLamports: "250",
    ...overrides
  };
}

test("calculates priority fee with ceiling and sums every cost component exactly", () => {
  const result = calculateVerifiedTransactionCosts(evidence());
  assert.equal(result.maxPriorityFeeLamports, "2000");
  assert.equal(result.totalFeeLamports, "2047530");
  assert.equal(result.messageDigest, "a".repeat(64));
});

test("rounds fractional priority lamports upward", () => {
  const result = calculateVerifiedTransactionCosts(evidence({
    computeUnitPriceMicroLamports: "1",
    computeUnitLimit: "1"
  }));
  assert.equal(result.maxPriorityFeeLamports, "1");
});

test("fails closed when semantic or account-effect evidence is missing", () => {
  for (const key of ["semanticInstructionVerification", "messageAccountEffectsVerified", "feeQuoteBoundToMessage"]) {
    assert.throws(() => calculateVerifiedTransactionCosts(evidence({ [key]: false })), /not semantically verified/);
  }
});

test("rejects missing, non-canonical, negative, unsafe, and overflowing values", () => {
  for (const value of [undefined, 1, -1, "01", "1.5", "1e3", (1n << 64n).toString()]) {
    assert.throws(() => calculateVerifiedTransactionCosts(evidence({
      baseFeeLamports: value
    })));
  }
});

test("rejects a zero compute unit limit and malformed message digest", () => {
  assert.throws(() => calculateVerifiedTransactionCosts(evidence({ computeUnitLimit: "0" })), /greater than zero/);
  assert.throws(() => calculateVerifiedTransactionCosts(evidence({ messageDigest: "not-a-digest" })), /digest/);
});

test("rejects aggregate costs outside the u64 range", () => {
  assert.throws(() => calculateVerifiedTransactionCosts(evidence({
    baseFeeLamports: ((1n << 64n) - 1n).toString(),
    tipLamports: "1"
  })), /u64 range/);
});
