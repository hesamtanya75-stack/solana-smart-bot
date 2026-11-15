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
