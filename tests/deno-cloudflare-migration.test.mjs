import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDenoState,
  buildCloudflareImport,
  stateMatches,
  canonicalJson,
  requireHttpsOrigin
} from "../scripts/migrate-deno-to-cloudflare.mjs";

test("validates and preserves the legacy Deno paper state", () => {
  const source = {
    balance: 87.5,
    trades: [{ mint: "So11111111111111111111111111111111111111112", amount: 5, buyPrice: 2, tokens: 2.5 }],
    updatedAt: "2026-11-20T10:00:00.000Z"
  };
  assert.equal(validateDenoState(source), source);
  const imported = buildCloudflareImport(source);
  assert.equal(imported.balance, 87.5);
  assert.equal(imported.autoEnabled, false);
  assert.equal(imported.paused, true);
  assert.equal(imported.trades.length, 1);
  assert.equal(imported.trades[0].currentPrice, 2);
  assert.equal(imported.trades[0].sold, false);
  assert.equal(imported.trades[0].boughtAt, null);
});

test("rejects unsupported top-level fields rather than silently dropping them", () => {
  assert.throws(() => validateDenoState({
    balance: 100, trades: [], updatedAt: null, customLedger: { value: 1 }
  }), /Unsupported Deno state fields/);
});

test("rejects trade fields the Cloudflare Durable Object cannot preserve", () => {
  assert.throws(() => buildCloudflareImport({
    balance: 100,
    trades: [{ mint: "mint", amount: 5, buyPrice: 2, tokens: 2.5, customMetadata: true }]
  }), /cannot preserve/);
});

test("rejects invalid balances, oversized trade arrays, and malformed trades", () => {
  assert.throws(() => validateDenoState({ balance: -1, trades: [] }), /balance/);
  assert.throws(() => validateDenoState({ balance: 1, trades: Array(501).fill({}) }), /at most 500/);
  assert.throws(() => validateDenoState({ balance: 1, trades: [{ mint: "", amount: 1, buyPrice: 1, tokens: 1 }] }), /required field/);
});

test("read-back comparison accepts only the exact normalized trade history", () => {
  const source = {
    balance: 42,
    trades: [{ mint: "mint", amount: 5, buyPrice: 2, tokens: 2.5 }]
  };
  const normalized = buildCloudflareImport(source);
  const verified = { balance: 42, trades: normalized.trades, autoEnabled: false, paused: true };
  assert.equal(stateMatches(source, verified), true);
  assert.equal(stateMatches(source, { ...verified, balance: 41 }), false);
  assert.equal(stateMatches(source, { ...verified, trades: [] }), false);
  assert.equal(stateMatches(source, { ...verified, autoEnabled: true }), false);
  assert.equal(stateMatches(source, { ...verified, paused: false }), false);
});

test("canonical JSON is independent of object key insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test("migration endpoints must be HTTPS origins without embedded credentials", () => {
  assert.equal(requireHttpsOrigin("https://example.com/path?x=1".replace("/path?x=1", "")), "https://example.com");
  assert.throws(() => requireHttpsOrigin("http://example.com"), /HTTPS origin/);
  assert.throws(() => requireHttpsOrigin("https://user:pass@example.com"), /HTTPS origin/);
  assert.throws(() => requireHttpsOrigin("not a URL"), /valid absolute URL/);
});
