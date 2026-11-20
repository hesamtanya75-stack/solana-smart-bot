import test from "node:test";
import assert from "node:assert/strict";
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
function validUnsignedLegacyTransaction() {
  // Build the minimal unsigned legacy message with the pinned signer and one program key.
  const decode = value => { const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n = 0n; for (const ch of value) n = n * 58n + BigInt(alphabet.indexOf(ch)); const out=[]; while(n>0n){out.unshift(Number(n & 255n));n >>= 8n;} for(let i=0;i<value.length && value[i]==="1";i++) out.unshift(0); return Buffer.from(out); };
  const key = decode(EXPECTED_BOT_WALLET);
  const message = Buffer.from([1,0,1,2,...key,...new Array(32).fill(9),...new Array(32).fill(0),1,1,0,0]);
  return Buffer.from([1,...new Array(64).fill(0),...message]).toString("base64");
}

function validRoutePlanStep(overrides = {}) {
  return {
    percent: 100,
    bps: 10000,
    swapInfo: {
      ammKey: "11111111111111111111111111111111",
      label: "Test AMM",
      inputMint: SOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000",
      outAmount: "12345"
    },
    ...overrides
  };
}

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

test("eligibility gate enforces the exact per-trade cap and accepts its boundary", () => {
  const policy = readLivePolicy(goodEnv);
  assert.deepEqual(evaluateLiveTradeEligibility({
    policy, amountLamports: policy.maxTradeLamports, ...goodEligibility
  }), { allowed: true });
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: policy.maxTradeLamports + 1, ...goodEligibility
  }), /per-trade limit/);
  for (const amountLamports of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => evaluateLiveTradeEligibility({
      policy, amountLamports, ...goodEligibility
    }), /per-trade limit/);
  }
});

test("eligibility gate enforces exact remaining daily budget without arithmetic overflow", () => {
  const policy = readLivePolicy(goodEnv);
  assert.deepEqual(evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000,
    ...goodEligibility, dailySpentLamports: policy.maxDailyLamports - 1000000
  }), { allowed: true });
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: 1000001,
    ...goodEligibility, dailySpentLamports: policy.maxDailyLamports - 1000000
  }), /daily spend limit/);
  assert.throws(() => evaluateLiveTradeEligibility({
    policy, amountLamports: 1000000,
    ...goodEligibility, dailySpentLamports: policy.maxDailyLamports + 1
  }), /daily spend limit/);
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


function validUnsignedV1Transaction() {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of EXPECTED_BOT_WALLET) n = n * 58n + BigInt(alphabet.indexOf(ch));
  const signer = [];
  while (n > 0n) { signer.unshift(Number(n & 255n)); n >>= 8n; }
  for (let i = 0; i < EXPECTED_BOT_WALLET.length && EXPECTED_BOT_WALLET[i] === "1"; i++) signer.unshift(0);
  const message = Uint8Array.from([
    0x81, 1, 0, 1, 0x0c, 0, 0, 0,
    ...new Array(32).fill(0), 1, 2, ...signer,
    ...new Array(32).fill(17),
    0x20, 0x4e, 0, 0, 0, 0, 0x40, 0,
    1, 1, 1, 0, 0, 0,
    ...new Array(64).fill(0)
  ]);
  return Buffer.from(message).toString("base64");
}

function validUnsignedV0TransactionWithLookup() {
  const decode = value => {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n;
    for (const ch of value) n = n * 58n + BigInt(alphabet.indexOf(ch));
    const out = [];
    while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
    for (let i = 0; i < value.length && value[i] === "1"; i++) out.unshift(0);
    return out;
  };
  const signer = decode(EXPECTED_BOT_WALLET);
  const message = Uint8Array.from([
    0x80, 1, 0, 1, 2, ...signer, ...new Array(32).fill(17),
    ...new Array(32).fill(0), 1, 1, 1, 2, 0,
    1, ...new Array(32).fill(42), 1, 0, 1, 1
  ]);
  return Buffer.from(Uint8Array.from([
    1, ...new Array(64).fill(0), ...message
  ])).toString("base64");
}
function mockLookupTableAccount(owner = "AddressLookupTab1e1111111111111111111111111") {
  const data = Buffer.alloc(56 + 64);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(0xffffffffffffffffn, 4);
  data.writeBigUInt64LE(90n, 12);
  data[20] = 2;
  data[21] = 0;
  data.fill(7, 56, 88);
  data.fill(8, 88, 120);
  return { owner, data: [data.toString("base64"), "base64"], executable: false, lamports: 1 };
}

test("Jupiter v0 order resolves finalized ALT addresses before returning route evidence", async () => {
  let rpcRequest;
  const result = await getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async (url, options = {}) => {
      if (String(url).startsWith("https://api.jup.ag/")) {
        return new Response(JSON.stringify({
          requestId: "req-v0-alt", transaction: validUnsignedV0TransactionWithLookup(),
          inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inAmount: "1000000", outAmount: "12345",
          routePlan: [validRoutePlanStep()], router: "metis",
          transactionVersion: 0, feeBps: 0
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      rpcRequest = JSON.parse(options.body);
      return Response.json({ jsonrpc: "2.0", id: 1, result: {
        context: { slot: 100 }, value: [mockLookupTableAccount()]
      } });
    }
  });
  assert.equal(result.transactionEvidence.messageVersion, 0);
  assert.equal(result.transactionEvidence.lookupTableResolution, "finalized-resolved");
  assert.equal(result.transactionEvidence.lookupContextSlot, 100);
  assert.deepEqual(result.transactionEvidence.resolvedWritableAddresses, ["US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx"]);
  assert.deepEqual(result.transactionEvidence.resolvedReadonlyAddresses, ["YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf"]);
  assert.equal(rpcRequest.method, "getMultipleAccounts");
  assert.deepEqual(rpcRequest.params[0], ["3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh"]);
  assert.equal(rpcRequest.params[1].commitment, "finalized");
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.routeVerification, "unsigned-structure-and-alt-only");
});

test("Jupiter v0 order fails closed when its ALT owner is not the lookup-table program", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async (url) => {
      if (String(url).startsWith("https://api.jup.ag/")) {
        return new Response(JSON.stringify({
          requestId: "req-v0-bad-alt", transaction: validUnsignedV0TransactionWithLookup(),
          inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inAmount: "1000000", outAmount: "12345",
          routePlan: [validRoutePlanStep()], router: "metis",
          transactionVersion: 0, feeBps: 0
        }), { status: 200 });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: {
        context: { slot: 100 }, value: [mockLookupTableAccount("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]
      } });
    }
  }), /unexpected program/);
});

test("valid Jupiter order is parsed but never executed", async () => {
  let request;
  const result = await getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        requestId: "req-test", transaction: validUnsignedLegacyTransaction(),
        inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "1000000", outAmount: "12345",
        routePlan: [validRoutePlanStep()], router: "metis",
        transactionVersion: 0, feeBps: 0
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal(result.requestId, "req-test");
  assert.equal(result.transactionEvidence.messageVersion, "legacy");
  assert.equal(result.transactionVersion, result.transactionEvidence.messageVersion);
  assert.equal(result.transactionEvidence.lookupTableResolution, "not-required");
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.routeVerification, "unsigned-structure-and-alt-only");
  assert.equal(result.instructionProgramInventory.scope, "compiled-program-id-inventory-only");
  assert.equal(result.instructionProgramInventory.instructionCount, 1);
  assert.equal(result.instructionProgramInventory.allProgramsRecognized, false);
  assert.deepEqual(result.instructionProgramInventory.unsupportedProgramIds, [
    "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN"
  ]);
  assert.equal(result.inputMint, SOL_MINT);
  assert.match(request.url, /taker=BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy/);
  const orderUrl = new URL(request.url);
  assert.equal(orderUrl.searchParams.get("taker"), EXPECTED_BOT_WALLET);
  assert.equal(orderUrl.searchParams.has("receiver"), false);
  assert.equal(orderUrl.searchParams.get("excludeRouters"), "jupiterz,dflow,okx");
  assert.equal(request.options.headers["x-api-key"], "test-only");
  await assert.rejects(() => executeLiveOrder(), /not implemented/);
});


test("missing Jupiter feeBps remains unknown instead of being reported as zero", async () => {
  const result = await getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async () => new Response(JSON.stringify({
      requestId: "req-missing-fee", transaction: validUnsignedLegacyTransaction(),
      inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000", outAmount: "12345",
      routePlan: [validRoutePlanStep()], router: "metis"
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  assert.equal(result.feeBps, null);
  assert.equal(result.analysisOnly, true);
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.routeVerification, "unsigned-structure-and-alt-only");
  assert.equal(result.signingPermitted, false);
  assert.equal(result.submissionPermitted, false);
  await assert.rejects(() => executeLiveOrder(), /not implemented/);
});

test("Jupiter v1 order reports the parsed message version, not provider metadata", async () => {
  const result = await getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async (url) => {
      if (String(url).startsWith("https://api.jup.ag/")) {
        return new Response(JSON.stringify({
          requestId: "req-v1", transaction: validUnsignedV1Transaction(),
          inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          inAmount: "1000000", outAmount: "12345", routePlan: [validRoutePlanStep()],
          router: "metis", transactionVersion: 0, feeBps: 0
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error("v1 transactions must not trigger ALT RPC lookup");
    }
  });
  assert.equal(result.transactionEvidence.messageVersion, 1);
  assert.equal(result.transactionVersion, 1);
  assert.equal(result.transactionEvidence.lookupTableResolution, "not-required");
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.instructionProgramInventory.scope, "compiled-program-id-inventory-only");
  assert.equal(result.instructionProgramInventory.allProgramsRecognized, false);
  assert.equal(result.instructionProgramInventory.instructionCount, 1);
  assert.deepEqual(result.instructionProgramInventory.unsupportedProgramIds, [
    "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2"
  ]);
});

test("Jupiter order rejects every router except a returned Metis route", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async () => new Response(JSON.stringify({
      requestId: "req-dflow", transaction: validUnsignedLegacyTransaction(),
      inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000", outAmount: "12345",
      routePlan: [validRoutePlanStep()], router: "dflow",
      transactionVersion: 0, feeBps: 0
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }), /incomplete or non-executable/);
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
      routePlan: [validRoutePlanStep()]
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
      routePlan: [validRoutePlanStep()]
    }), { status: 200 })
  }), /incomplete or non-executable/);
});


test("Jupiter order bounds request identifiers and serialized transaction size", async () => {
  const base = {
    requestId: "req-bounded",
    transaction: validUnsignedLegacyTransaction(),
    inputMint: SOL_MINT,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inAmount: "1000000", outAmount: "12345",
    routePlan: [validRoutePlanStep()],
    router: "metis", feeBps: 0
  };
  for (const overrides of [
    { requestId: "bad\nrequest" },
    { requestId: "x".repeat(257) },
    { transaction: "A".repeat(1648) }
  ]) {
    await assert.rejects(() => getJupiterOrder({
      env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountLamports: 1000000, eligibility: goodEligibility,
      fetchImpl: async () => new Response(JSON.stringify({ ...base, ...overrides }), { status: 200 })
    }), /incomplete or non-executable/);
  }
});

test("Jupiter order rejects output amounts outside canonical u64 bounds", async () => {
  for (const outAmount of [
    "18446744073709551616",
    "999999999999999999999999999999999999",
    "012345",
    "0"
  ]) {
    await assert.rejects(() => getJupiterOrder({
      env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountLamports: 1000000, eligibility: goodEligibility,
      fetchImpl: async () => new Response(JSON.stringify({
        requestId: "req-bad-output", transaction: validUnsignedLegacyTransaction(),
        inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "1000000", outAmount, routePlan: [validRoutePlanStep()],
        router: "metis", feeBps: 0
      }), { status: 200 })
    }), /incomplete or non-executable/);
  }
});

test("Jupiter order rejects invalid fee basis points", async () => {
  for (const feeBps of [-1, 10001, 1.5, "10"]) {
    await assert.rejects(() => getJupiterOrder({
      env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountLamports: 1000000, eligibility: goodEligibility,
      fetchImpl: async () => new Response(JSON.stringify({
        requestId: "req-bad-fee", transaction: validUnsignedLegacyTransaction(),
        inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "1000000", outAmount: "12345",
        routePlan: [validRoutePlanStep()],
        router: "metis", feeBps
      }), { status: 200 })
    }), /incomplete or non-executable/);
  }
});


test("Jupiter order rejects malformed route-plan metadata before transaction inspection", async () => {
  const valid = {
    requestId: "req-route-validation",
    transaction: validUnsignedLegacyTransaction(),
    inputMint: SOL_MINT,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inAmount: "1000000",
    outAmount: "12345",
    router: "metis",
    feeBps: 0,
    routePlan: [validRoutePlanStep()]
  };
  const invalidPlans = [
    [{ ...validRoutePlanStep(), percent: 101 }],
    [{ ...validRoutePlanStep(), bps: 10001 }],
    [{ ...validRoutePlanStep(), swapInfo: { ...validRoutePlanStep().swapInfo, inAmount: "01" } }],
    [{ ...validRoutePlanStep(), swapInfo: { ...validRoutePlanStep().swapInfo, outAmount: "18446744073709551616" } }],
    [{ ...validRoutePlanStep(), swapInfo: { ...validRoutePlanStep().swapInfo, ammKey: "not-a-public-key" } }],
    [{ ...validRoutePlanStep(), unexpected: true }],
    [{ ...validRoutePlanStep(), swapInfo: { ...validRoutePlanStep().swapInfo, unexpected: true } }]
  ];
  for (const routePlan of invalidPlans) {
    let rpcCalled = false;
    await assert.rejects(() => getJupiterOrder({
      env: goodEnv, outputMint: valid.outputMint,
      amountLamports: 1000000, eligibility: goodEligibility,
      fetchImpl: async (url) => {
        if (String(url).startsWith("https://api.jup.ag/")) {
          return new Response(JSON.stringify({ ...valid, routePlan }), { status: 200 });
        }
        rpcCalled = true;
        throw new Error("transaction inspection must not run for malformed route plans");
      }
    }), /incomplete or non-executable/);
    assert.equal(rpcCalled, false);
  }
});

test("Jupiter order rejects route plans exceeding the bounded entry count", async () => {
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async () => new Response(JSON.stringify({
      requestId: "req-too-many-routes", transaction: validUnsignedLegacyTransaction(),
      inputMint: SOL_MINT, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000", outAmount: "12345",
      routePlan: Array.from({ length: 65 }, () => (validRoutePlanStep())),
      router: "metis", feeBps: 0
    }), { status: 200 })
  }), /incomplete or non-executable/);
});


test("Jupiter order response is rejected before reading an oversized provider body", async () => {
  let reads = 0;
  const body = {
    getReader() {
      return {
        async read() {
          reads++;
          return { done: false, value: new TextEncoder().encode("{}") };
        },
        async cancel() {},
        releaseLock() {}
      };
    }
  };
  await assert.rejects(() => getJupiterOrder({
    env: goodEnv, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountLamports: 1000000, eligibility: goodEligibility,
    fetchImpl: async () => ({
      ok: true, status: 200, body,
      headers: { get(name) {
        return name.toLowerCase() === "content-length"
          ? String(2 * 1024 * 1024 + 1) : null;
      } }
    })
  }), /exceeds the 2097152-byte limit/);
  assert.equal(reads, 0);
});


test("live execution remains a hard stop and never signs or submits", async () => {
  await assert.rejects(
    executeLiveOrder(),
    /Live execution is not implemented; no transaction was signed or submitted/
  );
});
