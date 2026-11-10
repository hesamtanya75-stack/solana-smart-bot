import test from "node:test";
import assert from "node:assert/strict";
import { readLivePolicy, getJupiterOrder, executeLiveOrder, SOL_MINT } from "../live-trading.mjs";

const goodEnv = {
  LIVE_TRADING_ENABLED: "true",
  BOT_WALLET_PUBLIC_KEY: "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy",
  LIVE_MAX_TRADE_LAMPORTS: "10000000",
  LIVE_MAX_DAILY_LAMPORTS: "50000000",
  LIVE_MAX_SLIPPAGE_BPS: "50",
  LIVE_MIN_LIQUIDITY_USD: "10000",
  LIVE_MIN_VOLUME_24H_USD: "1000",
  LIVE_MAX_OPEN_POSITIONS: "3",
  JUPITER_API_KEY: "test-only"
};

test("live trading is disabled unless the flag is exactly true", () => {
  assert.equal(readLivePolicy({ LIVE_TRADING_ENABLED: "TRUE" }).enabled, false);
  assert.equal(readLivePolicy({}).enabled, false);
});

test("enabled policy requires explicit bounded risk configuration", () => {
  assert.equal(readLivePolicy(goodEnv).wallet, goodEnv.BOT_WALLET_PUBLIC_KEY);
  assert.throws(() => readLivePolicy({ ...goodEnv, LIVE_MAX_SLIPPAGE_BPS: "500" }));
  assert.throws(() => readLivePolicy({ ...goodEnv, LIVE_MAX_DAILY_LAMPORTS: "1" }));
  assert.throws(() => readLivePolicy({ ...goodEnv, BOT_WALLET_PUBLIC_KEY: "" }));
});

test("order request is blocked while live trading is disabled", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: { ...goodEnv, LIVE_TRADING_ENABLED: "false" },
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000,
    fetchImpl: async () => { throw new Error("fetch must not run"); }
  }), /Live trading is disabled/);
});

test("order request enforces the per-trade cap before network access", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 10000001,
    fetchImpl: async () => { throw new Error("fetch must not run"); }
  }), /per-trade limit/);
});

test("valid Jupiter order is parsed but never executed", async () => {
  let request;
  const result = await getJupiterOrder({
    env: goodEnv,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        requestId: "req-test",
        transaction: "dGVzdA==",
        outAmount: "12345",
        routePlan: [{ swapInfo: { label: "test" } }],
        router: "metis",
        transactionVersion: 0,
        feeBps: 0
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal(result.requestId, "req-test");
  assert.equal(result.inputMint, SOL_MINT);
  assert.equal(request.options.headers["x-api-key"], "test-only");
  await assert.rejects(() => executeLiveOrder(), /not implemented/);
});

test("malformed Jupiter order fails closed", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000,
    fetchImpl: async () => new Response(JSON.stringify({ requestId: "x", transaction: "", outAmount: "0", routePlan: [] }), { status: 200 })
  }), /incomplete or non-executable/);
});
