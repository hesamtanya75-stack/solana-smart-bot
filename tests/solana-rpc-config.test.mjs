import test from "node:test";
import assert from "node:assert/strict";
import { resolveSolanaRpcEndpoints } from "../solana-rpc-config.js";

test("a configured private HTTPS RPC is prioritized and its credential is not exposed in labels", () => {
  const secretUrl = "https://rpc.provider.example/v1?api-key=secret-value";
  const result = resolveSolanaRpcEndpoints({ SOLANA_RPC_URL: secretUrl });
  assert.equal(result.endpoints[0].url, secretUrl);
  assert.equal(result.endpoints[0].label, "Configured Solana RPC");
  assert.equal(result.endpoints[0].fallback, false);
  assert.ok(!JSON.stringify(result).includes("secret-value"));
});

test("unsafe or malformed custom RPC URLs fail closed without echoing secrets", () => {
  for (const value of [
    "http://rpc.provider.example",
    "https://user:password@rpc.provider.example",
    "https://localhost/rpc",
    "https://service.internal/rpc",
    "https://127.0.0.1/rpc",
    "not-a-url?secret=do-not-log"
  ]) {
    const result = resolveSolanaRpcEndpoints({ SOLANA_RPC_URL: value });
    assert.equal(result.endpoints.some(e => e.label === "Configured Solana RPC"), false);
    assert.ok(result.errors.some(e => e.startsWith("SOLANA_RPC_URL invalid")));
    assert.ok(!result.errors.join(" ").includes("secret"));
  }
});

test("Alchemy raw keys and full HTTPS endpoint are accepted", () => {
  const raw = resolveSolanaRpcEndpoints({ ALCHEMY_API_KEY: "abc123" });
  assert.equal(raw.endpoints[0].url, "https://solana-mainnet.g.alchemy.com/v2/abc123");
  const full = resolveSolanaRpcEndpoints({ ALCHEMY_API_KEY: "https://solana-mainnet.g.alchemy.com/v2/abc123" });
  assert.equal(full.endpoints[0].url, "https://solana-mainnet.g.alchemy.com/v2/abc123");
});

test("known public mainnet endpoints remain as fallback providers", () => {
  const result = resolveSolanaRpcEndpoints({});
  assert.deepEqual(result.endpoints.map(e => e.url), [
    "https://api.mainnet.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com"
  ]);
  assert.ok(result.endpoints.every(e => e.fallback));
});

test("duplicate configured and fallback endpoint is used only once", () => {
  const result = resolveSolanaRpcEndpoints({ SOLANA_RPC_URL: "https://api.mainnet.solana.com" });
  assert.equal(result.endpoints.filter(e => e.url === "https://api.mainnet.solana.com").length, 1);
});
