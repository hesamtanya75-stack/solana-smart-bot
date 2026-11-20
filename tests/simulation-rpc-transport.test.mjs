import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSimulationRpcRequest } from "../simulation-rpc-adapter.mjs";
import { performReadOnlySimulation } from "../simulation-rpc-transport.mjs";

async function makeRequest() {
  return createSimulationRpcRequest({
    serializedTransaction: Uint8Array.from([1, 2, 3, 4]),
    endpoint: "https://api.devnet.solana.com",
    requestId: 22
  });
}

function rpcResponse(id = 22, result = { context: { slot: 900 }, value: { err: null, innerInstructions: [] } }) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
}

test("read-only transport sends exact request and binds matching response id and endpoint", async () => {
  const request = await makeRequest();
  let observed;
  const result = await performReadOnlySimulation({
    request,
    endpoint: "https://api.devnet.solana.com",
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return rpcResponse();
    }
  });
  assert.equal(observed.url, "https://api.devnet.solana.com");
  assert.equal(observed.options.method, "POST");
  assert.equal(observed.options.body, request.body);
  assert.equal(result.scope, "read-only-simulation-response");
  assert.equal(result.transactionDigest, request.transactionDigest);
  assert.equal(result.endpointIdentity, request.endpoint);
  assert.equal(result.requestId, 22);
  assert.equal(result.contextSlot, 900);
  assert.equal(result.responseRequestIdMatched, true);
  assert.equal(result.responseEndpointMatched, true);
  assert.equal(result.simulationInputIdentityVerified, false);
  assert.equal(result.signingPermitted, false);
  assert.equal(result.submissionPermitted, false);
  assert.ok(Object.isFrozen(result));
});

test("read-only transport rejects response id mismatch, RPC errors and malformed context", async () => {
  const request = await makeRequest();
  await assert.rejects(performReadOnlySimulation({
    request, endpoint: "https://api.devnet.solana.com",
    fetchImpl: async () => rpcResponse(99)
  }), /valid id/);
  await assert.rejects(performReadOnlySimulation({
    request, endpoint: "https://api.devnet.solana.com",
    fetchImpl: async () => new Response(JSON.stringify({
      jsonrpc: "2.0", id: 22, error: { message: "rate limited" }
    }))
  }), /rate limited/);
  await assert.rejects(performReadOnlySimulation({
    request, endpoint: "https://api.devnet.solana.com",
    fetchImpl: async () => rpcResponse(22, { context: { slot: -1 }, value: {} })
  }), /context slot/);
});

test("read-only transport rejects endpoint mismatch and tampered request bytes", async () => {
  const request = await makeRequest();
  await assert.rejects(performReadOnlySimulation({
    request, endpoint: "https://rpc.other.test",
    fetchImpl: async () => { throw new Error("must not send"); }
  }), /endpoint identity/);

  const tampered = { ...request, body: request.body.replace("AQIDBA==", "AQIDBQ==") };
  await assert.rejects(performReadOnlySimulation({
    request: tampered, endpoint: "https://api.devnet.solana.com",
    fetchImpl: async () => { throw new Error("must not send"); }
  }), /do not match/);
});

test("read-only transport rejects HTTP and oversized provider responses", async () => {
  const request = await makeRequest();
  await assert.rejects(performReadOnlySimulation({
    request, endpoint: "https://api.devnet.solana.com",
    fetchImpl: async () => new Response("unavailable", { status: 503 })
  }), /HTTP 503/);
  await assert.rejects(performReadOnlySimulation({
    request, endpoint: "https://api.devnet.solana.com",
    fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 })
  }), /exceeds/);
});

test("transport does not accept request records with execution permissions", async () => {
  const request = await makeRequest();
  await assert.rejects(performReadOnlySimulation({
    request: { ...request, submissionPermitted: true },
    endpoint: "https://api.devnet.solana.com",
    fetchImpl: async () => { throw new Error("must not send"); }
  }), /metadata is invalid/);
});


test("read-only transport rejects accessor-backed request metadata without invoking it", async () => {
  const request = await makeRequest();
  let invoked = false;
  const hostile = { ...request };
  Object.defineProperty(hostile, "body", {
    enumerable: true,
    get() { invoked = true; return request.body; }
  });
  await assert.rejects(performReadOnlySimulation({
    request: hostile,
    endpoint: "https://api.devnet.solana.com",
    fetchImpl: async () => { throw new Error("must not send"); }
  }), /own data properties/);
  assert.equal(invoked, false);
});
