/**
 * Fail-closed validation primitives for a future live-order path.
 * These functions do not create, sign, or submit transactions.
 */
export function validateLiveOrderPolicy(order, policy, now = Date.now()) {
  const errors = [];
  if (!Number.isFinite(now)) errors.push("Validation clock must be finite");
  const finitePositive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (!policy || policy.liveEnabled !== true) errors.push("Live trading is not explicitly enabled");
  if (!policy || policy.emergencyPause !== false) errors.push("Emergency pause is active or not explicitly cleared");
  if (!order || typeof order !== "object") return { ok: false, errors: ["Order payload is missing"] };
  if (!finitePositive(order.amountSol)) errors.push("Order amount must be a finite positive SOL value");
  if (!finitePositive(policy?.maxOrderSol) || (finitePositive(order.amountSol) && order.amountSol > policy.maxOrderSol)) {
    errors.push("Order exceeds or has no valid per-order spend limit");
  }
  if (!finitePositive(policy?.maxDailySol)) errors.push("Daily spend limit is missing or invalid");
  if (!Number.isFinite(policy?.maxEstimatedFeeSol) || policy.maxEstimatedFeeSol < 0) {
    errors.push("Estimated-fee ceiling is missing or invalid");
  }
  if (!Number.isFinite(order?.estimatedFeeSol) || order.estimatedFeeSol < 0 ||
      (Number.isFinite(policy?.maxEstimatedFeeSol) && order.estimatedFeeSol > policy.maxEstimatedFeeSol)) {
    errors.push("Estimated transaction fee exceeds or has no valid fee ceiling");
  }
  if (!Number.isSafeInteger(policy?.maxOpenPositions) || policy.maxOpenPositions < 1) errors.push("Open-position limit is missing or invalid");
  if (!Number.isFinite(policy?.maxSlippageBps) || policy.maxSlippageBps < 1 || policy.maxSlippageBps > 3000) {
    errors.push("Slippage limit is missing or outside the supported safety range");
  }
  const projectedDailySpend = order && Number.isFinite(order.dailySpendSol) &&
    finitePositive(order.amountSol) && Number.isFinite(order.estimatedFeeSol) && order.estimatedFeeSol >= 0
    ? order.dailySpendSol + order.amountSol + order.estimatedFeeSol
    : NaN;
  if (!Number.isFinite(order?.dailySpendSol) || order.dailySpendSol < 0 ||
      !Number.isFinite(projectedDailySpend) ||
      (finitePositive(policy?.maxDailySol) && projectedDailySpend > policy.maxDailySol)) {
    errors.push("Daily spend would exceed the configured limit or its ledger is invalid");
  }
  if (!Number.isSafeInteger(order?.openPositions) || order.openPositions < 0 ||
      (Number.isSafeInteger(policy?.maxOpenPositions) && order.openPositions >= policy.maxOpenPositions)) {
    errors.push("Open-position limit reached or position count is invalid");
  }
  if (!order?.riskEvidence || order.riskEvidence.passed !== true ||
      !Number.isFinite(order.riskEvidence.checkedAt) ||
      now - order.riskEvidence.checkedAt < 0 ||
      now - order.riskEvidence.checkedAt > 30_000) {
    errors.push("Risk evidence is missing, failed, future-dated, or stale");
  }
  if (!order?.quote || order.quote.trusted !== true ||
      !Number.isFinite(order.quote.checkedAt) ||
      now - order.quote.checkedAt < 0 ||
      now - order.quote.checkedAt > 15_000) {
    errors.push("Trusted quote is missing, untrusted, future-dated, or stale");
  }
  if (!Number.isSafeInteger(order?.quote?.slippageBps) || order.quote.slippageBps < 0 ||
      (Number.isFinite(policy?.maxSlippageBps) && order.quote.slippageBps > policy.maxSlippageBps)) {
    errors.push("Quoted slippage exceeds or has no valid slippage ceiling");
  }
  const validMint = value => typeof value === "string" && value.trim().length > 0;
  if (!validMint(order.inputMint) || !validMint(order.outputMint) ||
      order.inputMint === order.outputMint ||
      !order?.quote || !validMint(order.quote.inputMint) || !validMint(order.quote.outputMint) ||
      order.quote.inputMint === order.quote.outputMint ||
      order.quote.inputMint !== order.inputMint ||
      order.quote.outputMint !== order.outputMint ||
      !finitePositive(order.quote.inputAmount) ||
      !finitePositive(order.quote.minimumOutput) ||
      (finitePositive(order.amountSol) && Math.abs(order.quote.inputAmount - order.amountSol) > 1e-9)) {
    errors.push("Quote mint or amount fields do not match the requested order");
  }
  if (!order?.idempotencyKey || typeof order.idempotencyKey !== "string" ||
      order.idempotencyKey.trim().length < 16 || order.idempotencyKey.length > 128) {
    errors.push("A bounded idempotency key is required");
  }
  return { ok: errors.length === 0, errors };
}
