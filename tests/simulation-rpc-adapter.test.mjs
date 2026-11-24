import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSimulationRpcRequest } from "../simulation-rpc-adapter.mjs";

test("simulation RPC request hashes the exact transaction bytes encoded in its body", async () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const request = await createSimulationRpcRequest({
    serializedTransaction: bytes,
    endpoint: "https://api.devnet.solana.com",
    requestId: 7
  });
  const envelope = JSON.parse(request.body);
  assert.equal(request.method, "POST");
  assert.equal(request.endpoint, "https://api.devnet.solana.com/");
  assert.equal(request.transactionDigest, expected);
  assert.equal(request.digestSource, "sha256-of-exact-base64-rpc-transaction-bytes");
  assert.equal(envelope.jsonrpc, "2.0");
  assert.equal(envelope.id, 7);
  assert.equal(envelope.method, "simulateTransaction");
  assert.deepEqual([...Buffer.from(envelope.params[0], "base64")], [...bytes]);
  assert.deepEqual(envelope.params[1], {
    encoding: "base64",
    sigVerify: false,
    replaceRecentBlockhash: true,
    innerInstructions: true,
    innerInstructionsEncoding: "json",
    commitment: "confirmed"
  });
  assert.equal(request.responseIdentityVerified, false);
  assert.equal(request.signingPermitted, false);
  assert.equal(request.submissionPermitted, false);
  assert.ok(Object.isFrozen(request));
});

test("simulation RPC request snapshots bytes before asynchronous digest", async () => {
  const bytes = Uint8Array.from([9, 8, 7]);
  const expected = createHash("sha256").update(bytes).digest("hex");
  const pending = createSimulationRpcRequest({
    serializedTransaction: bytes,
    endpoint: "https://rpc.example.test"
  });
  bytes.fill(0);
  const request = await pending;
  const envelope = JSON.parse(request.body);
  assert.equal(request.transactionDigest, expected);
  assert.deepEqual([...Buffer.from(envelope.params[0], "base64")], [9, 8, 7]);
});

test("simulation RPC request rejects malformed bytes, endpoints and ids", async () => {
  const common = { endpoint: "https://api.devnet.solana.com" };
  await assert.rejects(createSimulationRpcRequest({
    ...common, serializedTransaction: new Uint8Array()
  }), /bounded Uint8Array/);
  await assert.rejects(createSimulationRpcRequest({
    ...common, serializedTransaction: new Uint8Array(1233)
  }), /bounded Uint8Array/);
  await assert.rejects(createSimulationRpcRequest({
    ...common, serializedTransaction: [1, 2, 3]
  }), /bounded Uint8Array/);
  await assert.rejects(createSimulationRpcRequest({
    serializedTransaction: Uint8Array.from([1]), endpoint: "http://rpc.example.test"
  }), /HTTPS/);
  await assert.rejects(createSimulationRpcRequest({
    serializedTransaction: Uint8Array.from([1]), endpoint: "https://user:secret@rpc.example.test"
  }), /HTTPS/);
  await assert.rejects(createSimulationRpcRequest({
    serializedTransaction: Uint8Array.from([1]), endpoint: "https://rpc.example.test/?token=secret"
  }), /HTTPS/);
  await assert.rejects(createSimulationRpcRequest({
    ...common, serializedTransaction: Uint8Array.from([1]), requestId: 0
  }), /request id/);
});


test("simulation RPC adapter rejects accessor-backed top-level arguments without invoking getters", async () => {
  let invoked = false;
  const hostile = { endpoint: "https://api.devnet.solana.com" };
  Object.defineProperty(hostile, "serializedTransaction", {
    enumerable: true,
    get() { invoked = true; return Uint8Array.from([1, 2, 3]); }
  });
  await assert.rejects(createSimulationRpcRequest(hostile), /accessor-backed/);
  assert.equal(invoked, false);
});
