/**
 * Read-only finalized-signature reconciler.
 * Injects RPC URL/fetch for tests; never signs, sends, or retries transactions.
 */
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export async function reconcileFinalizedSignature({
  signature, rpcUrl, fetchImpl = fetch, now = Date.now, timeoutMs = 7000
}) {
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    throw new TypeError("A valid Solana transaction signature is required");
  }
  if (typeof rpcUrl !== "string" || !/^https:\/\//i.test(rpcUrl) ||
      typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 || timeoutMs > 30000 || !Number.isSafeInteger(now()) || now() <= 0) {
    throw new TypeError("Reconciliation configuration is invalid");
  }
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "signature-reconcile", method: "getSignatureStatuses",
        params: [[signature], { searchTransactionHistory: true }]
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error"
    });
  } catch {
    throw new Error("Signature reconciliation RPC request failed or timed out");
  }
  if (!response?.ok) {
    throw new Error("Signature reconciliation RPC returned HTTP " +
      (Number.isInteger(response?.status) ? response.status : "unknown"));
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("Signature reconciliation RPC returned invalid JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.error || !payload.result || !Array.isArray(payload.result.value) ||
      payload.result.value.length !== 1) {
    throw new Error("Signature reconciliation RPC response shape is invalid");
  }
  const status = payload.result.value[0];
  if (status === null) {
    return Object.freeze({ outcome: "pending", signature, observedAt: now(), slot: null });
  }
  if (!status || !Number.isSafeInteger(status.slot) || status.slot < 1 ||
      !["processed", "confirmed", "finalized", null].includes(status.confirmationStatus)) {
    throw new Error("Signature reconciliation status is malformed");
  }
  if (status.confirmationStatus !== "finalized") {
    return Object.freeze({ outcome: "pending", signature, observedAt: now(), slot: status.slot });
  }
  return Object.freeze({
    outcome: status.err === null ? "confirmed" : "failed",
    signature, observedAt: now(), slot: status.slot,
    chainError: status.err === null ? null : status.err
  });
}
