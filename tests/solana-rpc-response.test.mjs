import test from "node:test";
import assert from "node:assert/strict";
import { parseRpcBatchResponse, parseRpcSingleResponse } from "../solana-rpc-response.js";

test("batch response validates envelopes and restores request order by ID", () => {
  const parsed = parseRpcBatchResponse([
    { jsonrpc: "2.0", id: 2, result: { slot: 20 } },
    { jsonrpc: "2.0", id: 1, result: { slot: 10 } }
  ], 2);
  assert.deepEqual(parsed, [{ slot: 10 }, { slot: 20 }]);
});

test("batch response fails closed on malformed, duplicate, missing or errored entries", () => {
  const valid = id => ({ jsonrpc: "2.0", id, result: null });
  const invalid = [
    [{ ...valid(1), jsonrpc: "1.0" }, valid(2)],
    [{ ...valid(8) }, valid(2)],
    [valid(1), valid(1)],
    [valid(1), { jsonrpc: "2.0", id: 2, error: { message: "provider failure" } }],
    [valid(1)]
  ];
  for (const payload of invalid) assert.throws(() => parseRpcBatchResponse(payload, 2));
  assert.throws(() => parseRpcBatchResponse({ jsonrpc: "2.0", id: 1, result: [] }, 2));
});

test("single fallback response validates exact JSON-RPC ID and version", () => {
  assert.deepEqual(parseRpcSingleResponse({ jsonrpc: "2.0", id: 3, result: "ok" }, 3), "ok");
  assert.throws(() => parseRpcSingleResponse({ jsonrpc: "2.0", id: 4, result: "spoof" }, 3));
  assert.throws(() => parseRpcSingleResponse({ jsonrpc: "1.0", id: 3, result: "bad" }, 3));
});
