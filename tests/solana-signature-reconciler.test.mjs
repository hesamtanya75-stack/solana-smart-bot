import test from "node:test";
import assert from "node:assert/strict";
import { reconcileFinalizedSignature } from "../solana-signature-reconciler.js";

const signature = "S".repeat(64);
const rpcUrl = "https://rpc.example.invalid";
const ok = body => ({ ok: true, status: 200, json: async () => body });
const result = value => ({ jsonrpc: "2.0", id: "signature-reconcile", result: { value: [value] } });

test("requests signature status with history and reports finalized success only", async () => {
  let request;
  const out = await reconcileFinalizedSignature({
    signature, rpcUrl, now: () => 12345,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return ok(result({ slot: 77, confirmations: null, err: null, confirmationStatus: "finalized" }));
    }
  });
  assert.equal(request.url, rpcUrl);
  const body = JSON.parse(request.options.body);
  assert.equal(body.method, "getSignatureStatuses");
  assert.deepEqual(body.params, [[signature], { searchTransactionHistory: true }]);
  assert.equal(out.outcome, "confirmed");
  assert.equal(out.slot, 77);
  assert.equal(out.observedAt, 12345);
  assert.equal(out.chainError, null);
});

test("unseen and non-final signatures remain pending", async () => {
  const unseen = await reconcileFinalizedSignature({
    signature, rpcUrl, fetchImpl: async () => ok(result(null))
  });
  assert.equal(unseen.outcome, "pending");
  const confirmed = await reconcileFinalizedSignature({
    signature, rpcUrl, fetchImpl: async () => ok(result({
      slot: 10, confirmations: 2, err: null, confirmationStatus: "confirmed"
    }))
  });
  assert.equal(confirmed.outcome, "pending");
});

test("finalized on-chain error is a failed outcome, not a transport error", async () => {
  const out = await reconcileFinalizedSignature({
    signature, rpcUrl, fetchImpl: async () => ok(result({
      slot: 11, confirmations: null, err: { InstructionError: [0, "Custom"] },
      confirmationStatus: "finalized"
    }))
  });
  assert.equal(out.outcome, "failed");
  assert.deepEqual(out.chainError, { InstructionError: [0, "Custom"] });
});

test("fails closed on invalid signature, RPC errors, malformed data and HTTP failure", async () => {
  await assert.rejects(reconcileFinalizedSignature({
    signature: "bad", rpcUrl, fetchImpl: async () => ok(result(null))
  }), /signature/);
  await assert.rejects(reconcileFinalizedSignature({
    signature, rpcUrl, fetchImpl: async () => ok({ error: { message: "private endpoint detail" } })
  }), /response shape/);
  await assert.rejects(reconcileFinalizedSignature({
    signature, rpcUrl, fetchImpl: async () => ({ ok: false, status: 503 })
  }), /HTTP 503/);
  await assert.rejects(reconcileFinalizedSignature({
    signature, rpcUrl, fetchImpl: async () => ok(result({ slot: 0, confirmationStatus: "finalized", err: null }))
  }), /malformed/);
});

test("does not leak thrown transport details", async () => {
  await assert.rejects(reconcileFinalizedSignature({
    signature, rpcUrl, fetchImpl: async () => { throw new Error("secret provider trace"); }
  }), error => {
    assert.doesNotMatch(error.message, /secret provider trace/);
    return true;
  });
});
