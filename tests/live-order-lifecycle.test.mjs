import test from "node:test";
import assert from "node:assert/strict";
import { validateOrderRecord, transitionOrder, mayResubmit } from "../live-order-lifecycle.js";
const base = { orderId: "order-id-1234567890", status: "created", createdAt: 1_800_000_000_000 };

test("validates created order and allows only preparation transitions", () => {
  assert.equal(validateOrderRecord(base).ok, true);
  assert.equal(mayResubmit(base), true);
  const validated = transitionOrder(base, "validated");
  assert.equal(validated.ok, true);
  assert.equal(transitionOrder(base, "submitted", { signature: "S".repeat(64) }).ok, false);
  assert.equal(transitionOrder(validated.record, "submitted", { signature: "S".repeat(64) }).ok, true);
});

test("submitted or uncertain orders cannot be blindly resent", () => {
  const sent = transitionOrder({ ...base, status: "validated" }, "submitted", { signature: "S".repeat(64) }).record;
  assert.equal(mayResubmit(sent), false);
  const uncertain = transitionOrder(sent, "reconciliation_required").record;
  assert.equal(mayResubmit(uncertain), false);
});

test("uncertain outcomes must reconcile before terminal resolution", () => {
  const sent = transitionOrder({ ...base, status: "validated" }, "submitted", { signature: "S".repeat(64) }).record;
  assert.equal(transitionOrder(sent, "confirmed", { finalizedAt: 1_800_000_000_100 }).ok, false);
  const uncertain = transitionOrder(sent, "reconciliation_required").record;
  assert.equal(transitionOrder(uncertain, "confirmed", { finalizedAt: 1_800_000_000_100, reconciledAt: 1_800_000_000_090, reconciliationResult: "confirmed" }).ok, true);
  assert.equal(transitionOrder(uncertain, "failed", { finalizedAt: 1_800_000_000_100, reconciledAt: 1_800_000_000_090, reconciliationResult: "failed" }).ok, true);
});

test("terminal orders cannot transition or resubmit", () => {
  const rejected = transitionOrder(base, "rejected").record;
  assert.equal(transitionOrder(rejected, "validated").ok, false);
  assert.equal(mayResubmit(rejected), false);
});

test("invalid identifiers, statuses, timestamps, and signatures fail closed", () => {
  assert.equal(validateOrderRecord({ ...base, orderId: "tiny" }).ok, false);
  assert.equal(validateOrderRecord({ ...base, status: "unknown" }).ok, false);
  assert.equal(validateOrderRecord({ ...base, createdAt: NaN }).ok, false);
  assert.equal(validateOrderRecord({ ...base, status: "submitted" }).ok, false);
  assert.equal(transitionOrder(base, "validated", []).ok, false);
});

test("stored records reject signature and outcome fields in incompatible states", () => {
  assert.equal(validateOrderRecord({ ...base, signature: "S".repeat(64) }).ok, false);
  assert.equal(validateOrderRecord({ ...base, finalizedAt: 1_800_000_000_100 }).ok, false);
  assert.equal(validateOrderRecord({ ...base, failureReason: "rejected" }).ok, false);
  const failedWithoutSignature = { ...base, status: "failed", finalizedAt: 1_800_000_000_100 };
  assert.equal(validateOrderRecord(failedWithoutSignature).ok, false);
  const failedWithSignature = { ...failedWithoutSignature, signature: "S".repeat(64) };
  assert.equal(validateOrderRecord(failedWithSignature).ok, false);
  assert.equal(validateOrderRecord({ ...failedWithSignature, reconciledAt: 1_800_000_000_090, reconciliationResult: "failed" }).ok, true);
});

test("order records reject unexpected fields and malformed finalization metadata", () => {
  assert.equal(validateOrderRecord({ ...base, walletPrivateKey: "never-allow" }).ok, false);
  assert.equal(validateOrderRecord({ ...base, clientOverride: true }).ok, false);
  assert.equal(validateOrderRecord({ ...base, finalizedAt: "later" }).ok, false);
  assert.equal(validateOrderRecord({ ...base, failureReason: "x".repeat(501) }).ok, false);
});

test("transition metadata is accepted only for compatible target statuses", () => {
  assert.equal(transitionOrder(base, "validated", { signature: "S".repeat(64) }).ok, false);
  assert.equal(transitionOrder(base, "validated", { finalizedAt: 1_800_000_000_100 }).ok, false);
  assert.equal(transitionOrder(base, "validated", { failureReason: "no-go" }).ok, false);
  const validated = transitionOrder(base, "validated").record;
  assert.equal(transitionOrder(validated, "submitted", { signature: "S".repeat(64) }).ok, true);
  const submitted = transitionOrder(validated, "submitted", { signature: "S".repeat(64) }).record;
  assert.equal(transitionOrder(submitted, "confirmed", { finalizedAt: 1_800_000_000_100 }).ok, false);
  const reconciled = transitionOrder(submitted, "reconciliation_required").record;
  assert.equal(transitionOrder(reconciled, "confirmed", { finalizedAt: 1_800_000_000_100 }).ok, false);
  assert.equal(transitionOrder(reconciled, "confirmed", { finalizedAt: 1_800_000_000_100, reconciledAt: 1_800_000_000_090, reconciliationResult: "failed" }).ok, false);
  assert.equal(transitionOrder(reconciled, "confirmed", { finalizedAt: 1_800_000_000_100, reconciledAt: 1_800_000_000_090, reconciliationResult: "confirmed" }).ok, true);
});

test("transition metadata cannot overwrite immutable order identity", () => {
  assert.equal(transitionOrder(base, "validated", { orderId: "attacker-overwrite-123" }).ok, false);
  assert.equal(transitionOrder(base, "validated", { createdAt: 9 }).ok, false);
  assert.equal(transitionOrder(base, "validated", { requestHash: "x" }).ok, false);
});
