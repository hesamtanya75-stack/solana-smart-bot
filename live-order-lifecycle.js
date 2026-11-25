/**
 * Pure live-order lifecycle rules for future durable ledger integration.
 * No storage, signing, RPC submission, or trade execution is performed here.
 */
const TRANSITIONS = Object.freeze({
  created: new Set(["validated", "rejected"]),
  validated: new Set(["submitted", "rejected"]),
  submitted: new Set(["reconciliation_required"]),
  reconciliation_required: new Set(["confirmed", "failed"]),
  confirmed: new Set(),
  failed: new Set(),
  rejected: new Set()
});

const STATES = new Set(Object.keys(TRANSITIONS));

export function validateOrderRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "Order record must be an object" };
  }
  const allowedFields = new Set(["orderId", "status", "createdAt", "signature", "finalizedAt", "failureReason", "reconciledAt", "reconciliationResult", "evidenceDigest", "evidencePreparedAt", "evidenceExpiresAt"]);
  if (Object.keys(record).some(key => !allowedFields.has(key))) {
    return { ok: false, reason: "Order record contains unsupported fields" };
  }
  if (typeof record.orderId !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(record.orderId)) {
    return { ok: false, reason: "Order ID must be a bounded idempotency identifier" };
  }
  if (record.evidenceDigest !== undefined && !/^[a-f0-9]{64}$/.test(record.evidenceDigest)) {\n    return { ok: false, reason: "Evidence digest must be a SHA-256 hex string" };\n  }\n  for (const field of ["evidencePreparedAt", "evidenceExpiresAt"]) {\n    if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || record[field] <= 0)) {\n      return { ok: false, reason: "Evidence timestamps must be positive safe integers" };\n    }\n  }\n  if (record.evidenceExpiresAt !== undefined && record.evidencePreparedAt !== undefined && record.evidenceExpiresAt <= record.evidencePreparedAt) {\n    return { ok: false, reason: "Evidence expiry must follow preparation time" };\n  }\n  if (record.finalizedAt !== undefined &&
      (!Number.isSafeInteger(record.finalizedAt) || record.finalizedAt <= 0)) {
    return { ok: false, reason: "Finalization time must be a positive safe integer" };
  }
  if (record.reconciledAt !== undefined &&
      (!Number.isSafeInteger(record.reconciledAt) || record.reconciledAt <= 0)) {
    return { ok: false, reason: "Reconciliation time must be a positive safe integer" };
  }
  if (record.reconciliationResult !== undefined &&
      !["confirmed", "failed"].includes(record.reconciliationResult)) {
    return { ok: false, reason: "Reconciliation result must be a terminal chain outcome" };
  }
  if (record.failureReason !== undefined &&
      (typeof record.failureReason !== "string" || record.failureReason.length > 500)) {
    return { ok: false, reason: "Failure reason must be a bounded string" };
  }
  if (!STATES.has(record.status)) {
    return { ok: false, reason: "Unknown order status" };
  }
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt <= 0) {
    return { ok: false, reason: "Creation time must be a positive safe integer" };
  }
  if (record.signature !== undefined &&
      (typeof record.signature !== "string" || record.signature.length < 32 || record.signature.length > 128)) {
    return { ok: false, reason: "Transaction signature has invalid shape" };
  }
  if (record.signature !== undefined &&
      !["submitted", "confirmed", "failed", "reconciliation_required"].includes(record.status)) {
    return { ok: false, reason: "Signature is not valid for this order status" };
  }
  if (["submitted", "confirmed", "failed", "reconciliation_required"].includes(record.status) &&
      typeof record.signature !== "string") {
    return { ok: false, reason: "Submitted or resolved on-chain states require a transaction signature" };
  }
  if ((record.reconciledAt !== undefined || record.reconciliationResult !== undefined) &&
      !["confirmed", "failed"].includes(record.status)) {
    return { ok: false, reason: "Reconciliation evidence is only valid for terminal outcomes" };
  }
  if (["confirmed", "failed"].includes(record.status) &&
      (!Number.isSafeInteger(record.reconciledAt) || record.reconciledAt <= 0 ||
       record.reconciliationResult !== record.status)) {
    return { ok: false, reason: "Terminal order status requires matching reconciliation metadata" };
  }
  if (record.finalizedAt !== undefined && !["confirmed", "failed"].includes(record.status)) {
    return { ok: false, reason: "Finalization time is only valid for terminal outcomes" };
  }
  if (record.failureReason !== undefined && !["failed", "rejected"].includes(record.status)) {
    return { ok: false, reason: "Failure reason is only valid for failed or rejected orders" };
  }
  return { ok: true };
}

export function transitionOrder(record, nextStatus, metadata = {}) {
  const valid = validateOrderRecord(record);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  if (!STATES.has(nextStatus) || !TRANSITIONS[record.status].has(nextStatus)) {
    return { ok: false, reason: "Illegal order status transition" };
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ok: false, reason: "Transition metadata must be an object" };
  }
  const allowedMetadata = new Set(["signature", "finalizedAt", "failureReason", "reconciledAt", "reconciliationResult"]);
  if (Object.keys(metadata).some(key => !allowedMetadata.has(key))) {
    return { ok: false, reason: "Transition metadata contains immutable or unsupported fields" };
  }
  if (metadata.failureReason !== undefined &&
      (typeof metadata.failureReason !== "string" || metadata.failureReason.length > 500)) {
    return { ok: false, reason: "Failure reason must be a bounded string" };
  }
  if (metadata.signature !== undefined && nextStatus !== "submitted") {
    return { ok: false, reason: "Transaction signature may only be added at submission" };
  }
  if ((metadata.reconciledAt !== undefined || metadata.reconciliationResult !== undefined) &&
      !["confirmed", "failed"].includes(nextStatus)) {
    return { ok: false, reason: "Reconciliation metadata is only valid for terminal outcomes" };
  }
  if (metadata.finalizedAt !== undefined && !["confirmed", "failed"].includes(nextStatus)) {
    return { ok: false, reason: "Finalization time is only valid for terminal outcomes" };
  }
  if (metadata.failureReason !== undefined && !["failed", "rejected"].includes(nextStatus)) {
    return { ok: false, reason: "Failure reason is only valid for failed or rejected orders" };
  }
  const next = { ...record, ...metadata, status: nextStatus };
  if (nextStatus === "submitted" && (typeof next.signature !== "string" || next.signature.length < 32)) {
    return { ok: false, reason: "Submission requires a recorded transaction signature" };
  }
  if (["confirmed", "failed"].includes(nextStatus) &&
      (!Number.isSafeInteger(next.finalizedAt) || next.finalizedAt <= 0 ||
       !Number.isSafeInteger(next.reconciledAt) || next.reconciledAt <= 0 ||
       next.reconciliationResult !== nextStatus)) {
    return { ok: false, reason: "Final terminal status requires a timestamp" };
  }
  const nextValid = validateOrderRecord(next);
  if (!nextValid.ok) return { ok: false, reason: nextValid.reason };
  return { ok: true, record: next };
}

export function mayResubmit(record) {
  // Never blindly resend a submitted or uncertain order. Reconcile its signature first.
  return validateOrderRecord(record).ok &&
    ["created", "validated"].includes(record.status);
}
