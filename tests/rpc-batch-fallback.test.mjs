import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const start = source.indexOf("async function rpcBatch(calls, env) {");
const end = source.indexOf("\nasync function getJson(", start);
assert.ok(start >= 0 && end > start, "rpcBatch function must be present");
const rpcBatchSource = source.slice(start, end);

function loadRpcBatch(fetchImpl) {
  const diagnostics = { successes: [], errors: [] };
  const context = {
    getRpcEndpoints: () => ({
      endpoints: [{ url: "https://rpc.example", label: "Test RPC", fallback: true }],
      errors: []
    }),
    rpcDiagnostics: diagnostics,
    fetch: fetchImpl,
    AbortSignal,
    Promise,
    Map,
    Object,
    String,
    Error
  };
  const fn = vm.runInNewContext("(" + rpcBatchSource + ")", context);
  return { fn, diagnostics };
}

test("RPC batch retries same provider as parallel single requests when batch is rejected", async () => {
  let calls = 0;
  const mockFetch = async (_url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    if (Array.isArray(payload)) {
      return new Response(JSON.stringify({ error: { message: "batch not supported" } }), { status: 400 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: payload.method + "-ok" }), { status: 200 });
  };
  const { fn, diagnostics } = loadRpcBatch(mockFetch);
  const result = await fn([
    { method: "getAccountInfo", params: ["mint", {}] },
    { method: "getTokenSupply", params: ["mint", {}] },
    { method: "getTokenLargestAccounts", params: ["mint", {}] }
  ], {});
  assert.deepEqual(Array.from(result), ["getAccountInfo-ok", "getTokenSupply-ok", "getTokenLargestAccounts-ok"]);
  assert.equal(calls, 4, "one rejected batch plus three single requests");
  assert.deepEqual(Array.from(diagnostics.successes), ["Test RPC (single-request fallback)"]);
  assert.equal(diagnostics.errors.length, 0);
});

test("RPC batch preserves request order when provider responds out of order", async () => {
  const mockFetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    return new Response(JSON.stringify(payload.reverse().map(item => ({
      jsonrpc: "2.0", id: item.id, result: item.method + "-result"
    }))), { status: 200 });
  };
  const { fn } = loadRpcBatch(mockFetch);
  const result = await fn([
    { method: "first", params: [] },
    { method: "second", params: [] }
  ], {});
  assert.deepEqual(Array.from(result), ["first-result", "second-result"]);
});
