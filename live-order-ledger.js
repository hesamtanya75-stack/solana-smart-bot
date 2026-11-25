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
  constructor(storage) {
    if (!storage || typeof storage.transaction !== "function") {
      throw new TypeError("Transactional Durable Object storage is required");
    }
    this.storage = storage;
  }

  async create(record, requestHash) {
    if (!validateOrderRecord(record).ok || record.status !== "created") {
      throw new TypeError("Only a valid created order may enter the ledger");
    }
    if (typeof requestHash !== "string" || !HASH_PATTERN.test(requestHash)) {
      throw new TypeError("A SHA-256 request fingerprint is required");
    }
    return this.storage.transaction(async txn => {
      const key = PREFIX + record.orderId;
      const existing = await txn.get(key);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          return { ok: false, conflict: true, reason: "Idempotency key reused with different request" };
        }
        return { ok: true, duplicate: true, record: { ...existing.record }, version: existing.version };
      }
      const entry = { requestHash: requestHash.toLowerCase(), record: { ...record }, version: 1 };
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
      const result = transitionOrder(entry.record, nextStatus, metadata);
      if (!result.ok) return result;
      const updated = { ...entry, record: result.record, version: entry.version + 1 };
      await txn.put(key, updated);
      return { ok: true, record: { ...updated.record }, version: updated.version };
    });
  }
}
