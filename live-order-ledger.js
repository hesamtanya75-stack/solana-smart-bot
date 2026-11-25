/**
 * Durable-object-storage adapter for an isolated live-order ledger.
 * Not bound to the Worker and not used to submit transactions.
 * Caller must supply a stable SHA-256 request fingerprint (hex).
 */
import { transitionOrder, validateOrderRecord } from "./live-order-lifecycle.js";

const PREFIX = "live-order:";
const KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const copyEntry = entry => entry === undefined ? undefined : {
  ...entry,
  record: entry.record ? { ...entry.record } : entry.record
};

export class LiveOrderLedger {
  constructor(storage, { reconcileSignature } = {}) {
    if (!storage || typeof storage.transaction !== "function") {
      throw new TypeError("Transactional Durable Object storage is required");
    }
    if (reconcileSignature !== undefined && typeof reconcileSignature !== "function") {
      throw new TypeError("A server-side signature reconciler must be a function");
    }
    this.storage = storage;
    this.reconcileSignature = reconcileSignature;
  }

  async create(record, requestHash) {
    if (!validateOrderRecord(record).ok || record.status !== "created") {
      throw new TypeError("Only a valid created order may enter the ledger");
    }
    if (typeof requestHash !== "string" || !HASH_PATTERN.test(requestHash)) {
      throw new TypeError("A SHA-256 request fingerprint is required");
    }
    const normalizedHash = requestHash.toLowerCase();
    return this.storage.transaction(async txn => {
      const key = PREFIX + record.orderId;
      const existing = await txn.get(key);
      if (existing !== undefined) {
        if (existing.requestHash !== normalizedHash) {
          return { ok: false, conflict: true, reason: "Idempotency key reused with different request" };
        }
        // Evidence reservations are immutable: matching request parameters do not authorize replacing a prior quote/risk snapshot.
        const existingEvidenceDigest = existing.record?.evidenceDigest;
        const incomingEvidenceDigest = record.evidenceDigest;
        if ((existingEvidenceDigest !== undefined || incomingEvidenceDigest !== undefined) &&
            existingEvidenceDigest !== incomingEvidenceDigest) {
          return { ok: false, conflict: true, reason: "Idempotency key reused with different evidence" };
        }
        return { ok: true, duplicate: true, record: { ...existing.record }, version: existing.version };
      }
      const entry = { requestHash: normalizedHash, record: { ...record }, version: 1 };
      await txn.put(key, entry);
      return { ok: true, duplicate: false, record: { ...entry.record }, version: entry.version };
    });
  }

  async get(orderId) {
    if (typeof orderId !== "string" || !KEY_PATTERN.test(orderId)) return null;
    const entry = await this.storage.get(PREFIX + orderId);
    return copyEntry(entry);
  }

  async transition(orderId, expectedVersion, nextStatus, metadata = {}) {
    // Terminal states must pass through the server-side RPC reconciliation method.
    if (["confirmed", "failed"].includes(nextStatus)) {
      return { ok: false, reason: "Terminal status requires server-side signature reconciliation" };
    }
    if (typeof orderId !== "string" || !KEY_PATTERN.test(orderId) ||
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return { ok: false, reason: "Invalid order ID or expected version" };
    }
    return this.storage.transaction(async txn => {
      const key = PREFIX + orderId;
      const entry = await txn.get(key);
      if (entry === undefined) return { ok: false, reason: "Order not found" };
      if (entry.version !== expectedVersion) {
        return { ok: false, conflict: true, reason: "Order version conflict", version: entry.version };
      }
      if (entry.record.evidenceDigest && nextStatus !== "rejected") {
        return { ok: false, reason: "Evidence-only reservation cannot advance to an execution lifecycle" };
      }
      const result = transitionOrder(entry.record, nextStatus, metadata);
      if (!result.ok) return result;
      const updated = { ...entry, record: result.record, version: entry.version + 1 };
      await txn.put(key, updated);
      return { ok: true, record: { ...updated.record }, version: updated.version };
    });
  }

  async reconcile(orderId, expectedVersion) {
    if (!this.reconcileSignature) {
      return { ok: false, reason: "Server-side signature reconciler is not configured" };
    }
    if (typeof orderId !== "string" || !KEY_PATTERN.test(orderId) ||
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return { ok: false, reason: "Invalid order ID or expected version" };
    }
    const current = await this.get(orderId);
    if (!current) return { ok: false, reason: "Order not found" };
    if (current.version !== expectedVersion) {
      return { ok: false, conflict: true, reason: "Order version conflict", version: current.version };
    }
    if (current.record.status !== "reconciliation_required" ||
        typeof current.record.signature !== "string") {
      return { ok: false, reason: "Only a submitted uncertain order can be reconciled" };
    }

    let evidence;
    try {
      evidence = await this.reconcileSignature(current.record.signature);
    } catch {
      return { ok: false, reason: "Server-side signature reconciliation failed" };
    }
    if (!evidence || evidence.signature !== current.record.signature ||
        !["pending", "confirmed", "failed"].includes(evidence.outcome) ||
        !Number.isSafeInteger(evidence.observedAt) || evidence.observedAt <= 0) {
      return { ok: false, reason: "Reconciliation evidence is invalid or mismatched" };
    }
    if (evidence.outcome === "pending") {
      return { ok: true, pending: true, version: current.version };
    }
    if (!Number.isSafeInteger(evidence.slot) || evidence.slot < 1) {
      return { ok: false, reason: "Finalized reconciliation must include a valid slot" };
    }

    return this.storage.transaction(async txn => {
      const key = PREFIX + orderId;
      const entry = await txn.get(key);
      if (entry === undefined) return { ok: false, reason: "Order not found" };
      if (entry.version !== expectedVersion) {
        return { ok: false, conflict: true, reason: "Order version conflict", version: entry.version };
      }
      if (entry.record.status !== "reconciliation_required" ||
          entry.record.signature !== evidence.signature) {
        return { ok: false, conflict: true, reason: "Order changed during reconciliation" };
      }
      const terminal = evidence.outcome;
      const result = transitionOrder(entry.record, terminal, {
        finalizedAt: evidence.observedAt,
        reconciledAt: evidence.observedAt,
        reconciliationResult: terminal
      });
      if (!result.ok) return result;
      const updated = { ...entry, record: result.record, version: entry.version + 1 };
      await txn.put(key, updated);
      return { ok: true, pending: false, record: { ...updated.record }, version: updated.version };
    });
  }
}
