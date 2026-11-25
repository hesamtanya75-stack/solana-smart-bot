import { isValidSolanaPublicKey } from "./solana-wallet-reconciliation.js";

/**
 * Read-only live-order evidence preparation service.
 * Inject trusted server functions; this module never signs or submits transactions.
 */
import { createOrderEvidenceAttestation } from "./live-order-evidence-attestation.js";

const KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const AMOUNT_PATTERN = /^[1-9][0-9]{0,39}$/;

export async function prepareLiveOrderEvidence({
  binding, inspectRisk, fetchQuote, secret, now = Date.now
}) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      !KEY_PATTERN.test(binding.idempotencyKey || "") ||
      !isValidSolanaPublicKey(binding.inputMint) ||
      !isValidSolanaPublicKey(binding.outputMint) ||
      binding.inputMint === binding.outputMint ||
      typeof binding.amountAtomic !== "string" || !AMOUNT_PATTERN.test(binding.amountAtomic)) {
    throw new TypeError("Order evidence request is invalid");
  }
  if (typeof inspectRisk !== "function" || typeof fetchQuote !== "function" ||
      typeof now !== "function") {
    throw new TypeError("Trusted evidence providers are not configured");
  }

  // Inspect output token server-side. Never accept client-supplied risk assertions.
  const inspected = await inspectRisk(binding.outputMint);
  const riskCheckedAt = now();
  const riskMetricsValid = inspected &&
    Number.isFinite(inspected.rugScore) && inspected.rugScore >= 0 && inspected.rugScore <= 2500 &&
    Number.isFinite(inspected.largestPct) && inspected.largestPct >= 0 && inspected.largestPct <= 30 &&
    Number.isFinite(inspected.topTenPct) && inspected.topTenPct >= 0 && inspected.topTenPct <= 50;
  if (!inspected || inspected.ok !== true || !riskMetricsValid) {
    const error = new Error("Token risk checks failed or required risk metrics are missing/unsafe");
    error.code = "RISK_REJECTED";
    error.reasons = Array.isArray(inspected?.reasons) ? inspected.reasons.slice(0, 12) : [];
    throw error;
  }

  const quote = await fetchQuote({
    inputMint: binding.inputMint,
    outputMint: binding.outputMint,
    amountAtomic: binding.amountAtomic
  });
  const issuedAt = now();
  const risk = {
    passed: true,
    mint: binding.outputMint,
    checkedAt: riskCheckedAt,
    riskSource: "worker-inspectMint",
    riskSummary: {
      rugScore: Number.isFinite(inspected.rugScore) ? inspected.rugScore : null,
      largestHolderPct: Number.isFinite(inspected.largestPct) ? inspected.largestPct : null,
      topTenHolderPct: Number.isFinite(inspected.topTenPct) ? inspected.topTenPct : null
    }
  };
  const attestation = await createOrderEvidenceAttestation({
    binding, quote, risk, secret, now: issuedAt, ttlMs: 15000
  });
  return Object.freeze({
    mode: "read-only-evidence",
    execution: "not-authorized",
    quote,
    risk,
    attestation
  });
}
