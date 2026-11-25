/**
 * Pure live-order lifecycle rules for future durable ledger integration.
 * No storage, signing, RPC submission, or trade execution is performed here.
 */
const TRANSITIONS = Object.freeze({
  created: new Set(["validated", "rejected"]),
  validated: new Set(["submitted", "rejected"]),
  submitted: new Set(["confirmed", "failed", "reconciliation_required"]),
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
  if (typeof record.orderId !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(record.orderId)) {
    return { ok: false, reason: "Order ID must be a bounded idempotency identifier" };
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
  if (["submitted", "confirmed", "reconciliation_required"].includes(record.status) &&
      typeof record.signature !== "string") {
    return { ok: false, reason: "Submitted order states require a transaction signature" };
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
  const allowedMetadata = new Set(["signature", "finalizedAt", "failureReason"]);
  if (Object.keys(metadata).some(key => !allowedMetadata.has(key))) {
    return { ok: false, reason: "Transition metadata contains immutable or unsupported fields" };
  }
  if (metadata.failureReason !== undefined &&
      (typeof metadata.failureReason !== "string" || metadata.failureReason.length > 500)) {
    return { ok: false, reason: "Failure reason must be a bounded string" };
  }
  const next = { ...record, ...metadata, status: nextStatus };
  if (nextStatus === "submitted" && (typeof next.signature !== "string" || next.signature.length < 32)) {
    return { ok: false, reason: "Submission requires a recorded transaction signature" };
  }
  if (["confirmed", "failed"].includes(nextStatus) &&
      (!Number.isSafeInteger(next.finalizedAt) || next.finalizedAt <= 0)) {
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
