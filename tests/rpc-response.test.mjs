import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRpcResponse, parseRpcBatchResponse } from "../rpc-response.mjs";

test("single RPC response requires JSON-RPC 2.0, matching id and explicit result", () => {
  assert.equal(parseRpcResponse({ jsonrpc: "2.0", id: 1, result: null }, 1), null);
  assert.throws(() => parseRpcResponse({ jsonrpc: "2.0", id: 1 }, 1), /missing a result/);
  assert.throws(() => parseRpcResponse({ jsonrpc: "2.0", id: 2, result: true }, 1), /valid id/);
  assert.throws(() => parseRpcResponse({ id: 1, error: { message: "rate limited" } }, 1), /invalid JSON-RPC version/);
  assert.throws(() => parseRpcResponse({ jsonrpc: "1.0", id: 1, result: true }, 1), /invalid JSON-RPC version/);
  assert.throws(() => parseRpcResponse({ id: 1, result: true }, 1), /invalid JSON-RPC version/);
});

test("batch RPC response requires JSON-RPC 2.0 and every unique expected id with explicit results", () => {
  assert.deepEqual(parseRpcBatchResponse([
    { jsonrpc: "2.0", id: 2, result: "second" },
    { jsonrpc: "2.0", id: 1, result: "first" }
  ], 2), ["first", "second"]);
  assert.throws(() => parseRpcBatchResponse([{ jsonrpc: "2.0", id: 1, result: 1 }], 2), /incomplete/);
  assert.throws(() => parseRpcBatchResponse([
    { jsonrpc: "2.0", id: 1, result: 1 }, { jsonrpc: "2.0", id: 1, result: 2 }
  ], 2), /duplicated/);
  assert.throws(() => parseRpcBatchResponse([
    { jsonrpc: "2.0", id: 1, result: 1 }, { jsonrpc: "2.0", id: 2 }
  ], 2), /malformed/);
  assert.throws(() => parseRpcBatchResponse([
    { jsonrpc: "2.0", id: 1, result: 1 }, { jsonrpc: "1.0", id: 2, result: 2 }
  ], 2), /invalid JSON-RPC version/);
  assert.throws(() => parseRpcBatchResponse([
    { jsonrpc: "2.0", id: 1, result: 1 }, { id: 2, result: 2 }
  ], 2), /invalid JSON-RPC version/);
});


test("bounded provider JSON reader accepts valid JSON within the byte limit", async () => {
  const { readBoundedJsonResponse } = await import("../rpc-response.mjs");
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" }
  });
  assert.deepEqual(await readBoundedJsonResponse(response, 64), { ok: true });
});

test("bounded provider JSON reader rejects oversized declared content before reading", async () => {
  const { readBoundedJsonResponse } = await import("../rpc-response.mjs");
  let read = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      read = true;
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    }
  }), { headers: { "Content-Length": "100" } });
  await assert.rejects(readBoundedJsonResponse(response, 16), /exceeds the 16-byte limit/);
  assert.equal(read, false);
});

test("bounded provider JSON reader rejects oversized streamed bodies without parsing", async () => {
  const { readBoundedJsonResponse } = await import("../rpc-response.mjs");
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"payload":"'));
      controller.enqueue(new Uint8Array(64).fill(65));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    }
  }));
  await assert.rejects(readBoundedJsonResponse(response, 32), /exceeds the 32-byte limit/);
});

test("bounded provider JSON reader rejects malformed JSON and invalid UTF-8", async () => {
  const { readBoundedJsonResponse } = await import("../rpc-response.mjs");
  await assert.rejects(readBoundedJsonResponse(new Response("{")), /invalid JSON/);
  await assert.rejects(
    readBoundedJsonResponse(new Response(new Uint8Array([0xff, 0xfe]))),
    /valid UTF-8/
  );
});
