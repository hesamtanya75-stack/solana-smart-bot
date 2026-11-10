import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  readLivePolicy, evaluateLiveTradeEligibility, getJupiterOrder,
  executeLiveOrder, SOL_MINT, EXPECTED_BOT_WALLET
} from "../live-trading.mjs";

const goodEnv = {
  LIVE_TRADING_ENABLED: "true", LIVE_TRADING_KILL_SWITCH: "false",
  BOT_WALLET_PUBLIC_KEY: EXPECTED_BOT_WALLET,
  LIVE_MAX_TRADE_LAMPORTS: "10000000", LIVE_MAX_DAILY_LAMPORTS: "50000000",
  LIVE_MAX_SLIPPAGE_BPS: "50", LIVE_MIN_LIQUIDITY_USD: "10000",
  LIVE_MIN_VOLUME_24H_USD: "1000", LIVE_MAX_OPEN_POSITIONS: "10",
  JUPITER_API_KEY: "test-only"
};
const goodEligibility = {
  dailySpentLamports: 1000000, openPositions: 1,
  liquidityUsd: 25000, volume24hUsd: 5000,
  riskChecks: {
    mintAuthoritySafe: true, freezeAuthoritySafe: true,
    token2022ExtensionsSafe: true, holderConcentrationSafe: true,
    sellRouteAvailable: true
  }
};

test("live trading fails closed unless both feature flag and kill switch are explicitly set", () => {
  assert.equal(readLivePolicy({ LIVE_TRADING_ENABLED: "TRUE" }).enabled, false);
  assert.equal(readLivePolicy({ ...goodEnv, LIVE_TRADING_KILL_SWITCH: "true" }).enabled, false);
  assert.equal(readLivePolicy({}).enabled, false);
});

test("enabled policy requires pinned wallet and explicit bounded risk configuration", () => {
  assert.equal(readLivePolicy(goodEnv).wallet, EXPECTED_BOT_WALLET);
  assert.throws(() => readLivePolicy({ ...goodEnv, LIVE_MAX_SLIPPAGE_BPS: "500" }));
  assert.throws(() => readLivePolicy({ ...goodEnv, LIVE_MAX_DAILY_LAMPORTS: "1" }));
  assert.throws(() => readLivePolicy({ ...goodEnv, BOT_WALLET_PUBLIC_KEY: "BbUEve9uvdrhG2oKq9VKP8xdEGwR8ZeimYHxBtvFRrh9" }), /does not match/);
});

test("eligibility gate enforces daily spend, open positions, liquidity, volume and token safety", () => {
  const policy = readLivePolicy(goodEnv);
  assert.deepEqual(evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000, ...goodEligibility
  }), { allowed: true });
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000, ...goodEligibility, dailySpentLamports: 49500000
  }), /daily spend limit/);
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000, ...goodEligibility, openPositions: 10
  }), /Maximum open positions/);
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000, ...goodEligibility, liquidityUsd: 9999
  }), /liquidity/);
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000, ...goodEligibility, volume24hUsd: 999
  }), /24-hour volume/);
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000, ...goodEligibility,
    riskChecks: { ...goodEligibility.riskChecks, freezeAuthoritySafe: false }
  }), /Token safety checks/);
});

test("eligibility gate rejects missing or invalid server-side state", () => {
  const policy = readLivePolicy(goodEnv);
  assert.throws(() => evaluateLiveTradeEligibility({ policy, amountLamports: 1000000 }), /daily spend limit/);
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000, ...goodEligibility, dailySpentLamports: -1
  }), /daily spend limit/);
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000, ...goodEligibility, liquidityUsd: Number.NaN
  }), /liquidity/);
});

test("order request is blocked while live trading is disabled", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: { ...goodEnv, LIVE_TRADING_ENABLED: "false" },
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async () => { throw new Error("fetch must not run"); }
  }), /not explicitly enabled/);
});

test("order request enforces eligibility before network access", async () => {
  let called = false;
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000,
    eligibility: { ...goodEligibility, dailySpentLamports: 49500000 },
    fetchImpl: async () => { called = true; throw new Error("fetch must not run"); }
  }), /daily spend limit/);
  assert.equal(called, false);
});

test("Jupiter order requires an explicit trusted transaction allow-list", async () => {
  let request;
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        requestId: "req-test", transaction: "dGVzdA==",
        inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "1000000", outAmount: "12345",
        routePlan: [{ swapInfo: { label: "test" } }], router: "metis",
        transactionVersion: 0, feeBps: 0
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }), error => error.message.includes("Trusted transaction program/account allow-list"));
  assert.match(request.url, /taker=BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy/);
  assert.equal(request.options.headers["x-api-key"], "test-only");
  await assert.rejects(() => executeLiveOrder(), /not implemented/);
});
test("malformed Jupiter order fails closed", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async () => new Response(JSON.stringify({
      requestId: "x", transaction: "bad*base64", outAmount: "0", routePlan: []
    }), { status: 200 })
  }), /incomplete or non-executable/);
});

test("Jupiter cannot silently change the requested input amount or mint", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async () => new Response(JSON.stringify({
      requestId: "req-test", transaction: "dGVzdA==", outAmount: "12345",
      inAmount: "999", inputMint: SOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      routePlan: [{ swapInfo: { label: "test" } }]
    }), { status: 200 })
  }), /incomplete or non-executable/);
});

test("empty or malformed unsigned transaction is rejected", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async () => new Response(JSON.stringify({
      requestId: "req-test", transaction: "", inputMint: SOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000", outAmount: "12345",
      routePlan: [{ swapInfo: { label: "test" } }]
    }), { status: 200 })
  }), /incomplete or non-executable/);
});


test("Jupiter order is decoded and structurally checked before inspection metadata is returned", async () => {
  const wallet = new PublicKey(EXPECTED_BOT_WALLET);
  const recipient = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({
      fromPubkey: wallet, toPubkey: recipient, lamports: 1
    })]
  }).compileToLegacyMessage();
  const encoded = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  const allowedAccountKeys = [
    wallet.toBase58(), recipient.toBase58(), SystemProgram.programId.toBase58()
  ];
  const result = await getJupiterOrder({
    env: goodEnv,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000,
    eligibility: goodEligibility,
    transactionAllowList: {
      requiredAccounts: [wallet.toBase58(), recipient.toBase58()],
      allowedProgramIds: [SystemProgram.programId.toBase58()],
      allowedAccountKeys,
      instructionValidators: {
        [SystemProgram.programId.toBase58()]: () => ({ allowed: true })
      }
    },
    fetchImpl: async () => new Response(JSON.stringify({
      requestId: "req-decoded", transaction: encoded,
      inputMint: SOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000", outAmount: "12345",
      routePlan: [{ swapInfo: { label: "test" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });

  assert.equal(result.requestId, "req-decoded");
  assert.equal(result.instructionPolicy.allowed, true);
  assert.equal(result.instructionPolicy.instructionCount, 1);
  assert.equal("transaction" in result, false);
});

test("Jupiter order rejects invalid serialized transactions even with an allow-list", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000,
    eligibility: goodEligibility,
    transactionAllowList: {
      requiredAccounts: [EXPECTED_BOT_WALLET],
      allowedProgramIds: ["11111111111111111111111111111111"],
      allowedAccountKeys: [EXPECTED_BOT_WALLET, "11111111111111111111111111111111"]
    },
    fetchImpl: async () => new Response(JSON.stringify({
      requestId: "req-invalid", transaction: "dGVzdA==",
      inputMint: SOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000", outAmount: "12345",
      routePlan: [{ swapInfo: { label: "test" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }), /valid Solana transaction/);
});
