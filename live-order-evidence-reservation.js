/**
 * Durable idempotency reservation for verified, read-only order evidence.
 * Reserves status=created only. No execution, signing, or transaction fields.
 */
import { verifyOrderEvidenceAttestation } from "./live-order-evidence-attestation.js";

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function reservePreparedEvidence({
  binding, attestation, ledger, secret, now = Date.now
}) {
  if (!ledger || typeof ledger.create !== "function") {
    return { ok: false, reason: "Durable idempotency ledger is not configured" };
  }
  if (typeof now !== "function") return { ok: false, reason: "Trusted clock is not configured" };
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return { ok: false, reason: "Reservation clock is invalid" };
  }

  // Verify the HMAC and exact request binding before touching durable storage.
  const verified = await verifyOrderEvidenceAttestation({
    attestation, expectedBinding: binding, secret, now: timestamp
  });
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const payload = verified.payload;
  const requestHash = await sha256(JSON.stringify({
    idempotencyKey: binding.idempotencyKey,
    inputMint: binding.inputMint,
    outputMint: binding.outputMint,
    amountAtomic: binding.amountAtomic
  }));
  const evidenceDigest = await sha256(JSON.stringify({ payload, signature: attestation.signature }));
  const record = {
    orderId: binding.idempotencyKey,
    status: "created",
    createdAt: timestamp,
    evidenceDigest,
    evidencePreparedAt: payload.issuedAt,
    evidenceExpiresAt: payload.expiresAt
  };

  const stored = await ledger.create(record, requestHash);
  if (!stored.ok) return stored;
  return {
    ok: true,
    duplicate: stored.duplicate,
    status: stored.record.status,
    version: stored.version,
    record: stored.record,
    execution: "not-authorized"
  };
}
