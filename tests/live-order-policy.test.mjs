import test from "node:test";
import assert from "node:assert/strict";
import { validateLiveOrderPolicy } from "../live-order-policy.js";

const now = 1_800_000_000_000;
const policy = {
  liveEnabled: true, emergencyPause: false, maxOrderSol: 0.1,
  maxDailySol: 0.5, maxOpenPositions: 4, maxSlippageBps: 500, maxEstimatedFeeSol: 0.002
};
const order = {
  amountSol: 0.05, dailySpendSol: 0.1, estimatedFeeSol: 0.001, openPositions: 1,
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "TokenMintExample111111111111111111111111111",
  idempotencyKey: "order-key-123456789",
  riskEvidence: { passed: true, checkedAt: now - 1000 },
  quote: {
    trusted: true, checkedAt: now - 1000,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "TokenMintExample111111111111111111111111111",
    inputAmount: 0.05, minimumOutput: 100, slippageBps: 250
  }
};

test("valid fresh order policy passes without performing execution", () => {
  assert.deepEqual(validateLiveOrderPolicy(order, policy, now), { ok: true, errors: [] });
});

test("live mode and emergency pause fail closed", () => {
  assert.equal(validateLiveOrderPolicy(order, { ...policy, liveEnabled: false }, now).ok, false);
  assert.equal(validateLiveOrderPolicy(order, { ...policy, emergencyPause: true }, now).ok, false);
});

test("order and daily spend limits are enforced", () => {
  assert.equal(validateLiveOrderPolicy({ ...order, amountSol: 0.2 }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, dailySpendSol: 0.49 }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, openPositions: 4 }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, estimatedFeeSol: 0.01 }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, dailySpendSol: 0.449 }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, dailySpendSol: Number.MAX_VALUE }, policy, now).ok, false);
});

test("missing, stale, future, or mismatched quote and risk evidence fail closed", () => {
  assert.equal(validateLiveOrderPolicy({ ...order, quote: null }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, riskEvidence: { passed: true, checkedAt: now - 40000 } }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, quote: { ...order.quote, checkedAt: now + 1 } }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, quote: { ...order.quote, outputMint: "wrong" } }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, quote: { ...order.quote, inputAmount: 0.04 } }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, quote: { ...order.quote, slippageBps: 501 } }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, quote: { ...order.quote, slippageBps: NaN } }, policy, now).ok, false);
  const { slippageBps: _missingSlippage, ...quoteWithoutSlippage } = order.quote;
  assert.equal(validateLiveOrderPolicy({ ...order, quote: quoteWithoutSlippage }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, estimatedFeeSol: undefined }, policy, now).ok, false);
});

test("invalid values and absent idempotency key are rejected", () => {
  assert.equal(validateLiveOrderPolicy({ ...order, amountSol: Infinity }, policy, now).ok, false);
  assert.equal(validateLiveOrderPolicy({ ...order, idempotencyKey: "" }, policy, now).ok, false);
});
