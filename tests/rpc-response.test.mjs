import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRpcResponse, parseRpcBatchResponse } from "../rpc-response.mjs";

test("single RPC response requires matching id and an explicit result", () => {
  assert.equal(parseRpcResponse({ jsonrpc: "2.0", id: 1, result: null }, 1), null);
  assert.throws(() => parseRpcResponse({ jsonrpc: "2.0", id: 1 }, 1), /missing a result/);
  assert.throws(() => parseRpcResponse({ jsonrpc: "2.0", id: 2, result: true }, 1), /valid id or result/);
  assert.throws(() => parseRpcResponse({ id: 1, error: { message: "rate limited" } }, 1), /rate limited/);
});

test("batch RPC response requires every unique expected id and explicit results", () => {
  assert.deepEqual(parseRpcBatchResponse([
    { id: 2, result: "second" }, { id: 1, result: "first" }
  ], 2), ["first", "second"]);
  assert.throws(() => parseRpcBatchResponse([{ id: 1, result: 1 }], 2), /incomplete/);
  assert.throws(() => parseRpcBatchResponse([
    { id: 1, result: 1 }, { id: 1, result: 2 }
  ], 2), /duplicated/);
  assert.throws(() => parseRpcBatchResponse([
    { id: 1, result: 1 }, { id: 2 }
  ], 2), /malformed/);
});
