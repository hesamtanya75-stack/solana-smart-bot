import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBoundSimulationDiagnostics } from "../simulation-bound-diagnostics.mjs";

const DIGEST = "a".repeat(64);
const TX_DIGEST = "b".repeat(64);

function response(overrides = {}) {
  return {
    scope: "read-only-simulation-response",
    transactionDigest: TX_DIGEST,
    digestSource: "sha256-of-exact-base64-rpc-transaction-bytes",
    endpointIdentity: "https://rpc.example.invalid/",
    requestId: 42,
    contextSlot: 123,
    simulationResult: {
      context: { slot: 123 },
      value: {
        err: null,
        innerInstructions: [],
        preBalances: [1000],
        postBalances: [900],
        preTokenBalances: [],
        postTokenBalances: []
      }
    },
    responseRequestIdMatched: true,
    requestEndpointMatched: true,
    simulationInputIdentityVerified: false,
    signingPermitted: false,
    submissionPermitted: false,
    ...overrides
  };
}

function run(envelope = response()) {
  return normalizeBoundSimulationDiagnostics({
    response: envelope,
    messageDigest: DIGEST,
    topLevelInstructionCount: 1,
    accountKeyCount: 1
  });
}

test("builds CPI and balance diagnostics from one response and context slot", () => {
  const bundle = run();
  assert.equal(bundle.scope, "same-response-diagnostic-bundle");
  assert.equal(bundle.transactionDigest, TX_DIGEST);
  assert.equal(bundle.messageDigest, DIGEST);
  assert.equal(bundle.contextSlot, 123);
  assert.equal(bundle.cpiObservation.contextSlot, 123);
  assert.equal(bundle.balanceObservation.contextSlot, 123);
  assert.equal(bundle.balanceObservation.solLamportDeltas[0].deltaLamports, -100n);
  assert.equal(bundle.simulationInputIdentityVerified, false);
  assert.equal(bundle.remoteSimulationIdentityVerified, false);
  assert.equal(bundle.cpiProgramIdsVerified, false);
  assert.equal(bundle.semanticInstructionVerification, false);
  assert.equal(bundle.tokenBalanceEffectsVerified, false);
  assert.equal(bundle.signingPermitted, false);
  assert.equal(bundle.submissionPermitted, false);
  assert.ok(Object.isFrozen(bundle));
});

test("rejects a simulation result whose context slot differs from the response envelope", () => {
  const bad = response();
  bad.simulationResult.context.slot = 124;
  assert.throws(() => run(bad), /context slot/);
});

test("rejects envelopes that claim remote identity or execution authorization", () => {
  for (const patch of [
    { simulationInputIdentityVerified: true },
    { signingPermitted: true },
    { submissionPermitted: true },
    { responseRequestIdMatched: false },
    { requestEndpointMatched: false }
  ]) {
    assert.throws(() => run(response(patch)), /provenance validation/);
  }
});

test("rejects malformed transaction and message digests", () => {
  assert.throws(() => run(response({ transactionDigest: "not-a-digest" })), /provenance validation/);
  assert.throws(() => normalizeBoundSimulationDiagnostics({
    response: response(), messageDigest: "not-a-digest",
    topLevelInstructionCount: 1, accountKeyCount: 1
  }), /message digest/);
});

test("rejects accessor-backed response metadata without invoking the getter", () => {
  const bad = response();
  let calls = 0;
  Object.defineProperty(bad, "requestId", {
    enumerable: true,
    get() { calls++; return 42; }
  });
  assert.throws(() => run(bad), /accessor-backed/);
  assert.equal(calls, 0);
});

test("rejects a response envelope with unexpected fields", () => {
  assert.throws(() => run(response({ trusted: true })), /unsupported properties/);
});

test("rejects accessor-backed nested context slots without invoking the getter", () => {
  const bad = response();
  let calls = 0;
  Object.defineProperty(bad.simulationResult.context, "slot", {
    enumerable: true,
    get() { calls++; return 123; }
  });
  assert.throws(() => run(bad), /accessor-backed/);
  assert.equal(calls, 0);
});
