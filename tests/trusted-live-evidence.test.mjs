import test from "node:test";
import assert from "node:assert/strict";
import { fetchTrustedSolUsdQuote, fetchTrustedTokenRisk } from "../trusted-live-evidence.mjs";

test("SOL/USD quote is fetched and timestamped by the server", async () => {
  const quote = await fetchTrustedSolUsdQuote(async (url) => {
    assert.match(String(url), /api\.coinbase\.com\/v2\/prices\/SOL-USD\/spot/);
    return Response.json({ data: { base: "SOL", currency: "USD", amount: "205.25" } });
  });
  assert.equal(quote.provider, "Coinbase");
  assert.equal(quote.pair, "SOL/USD");
  assert.equal(quote.price, 205.25);
  assert.ok(Number.isFinite(quote.fetchedAt));
  assert.match(quote.quoteId, /^coinbase-sol-usd-/);
});

test("SOL/USD quote rejects wrong pair and invalid prices", async () => {
  await assert.rejects(
    fetchTrustedSolUsdQuote(async () => Response.json({
      data: { base: "BTC", currency: "USD", amount: "205.25" }
    })),
    /unexpected SOL\/USD quote/
  );
  await assert.rejects(
    fetchTrustedSolUsdQuote(async () => Response.json({
      data: { base: "SOL", currency: "USD", amount: "0" }
    })),
    /missing or invalid/
  );
});

test("risk inspection rejects invalid mint before external requests", async () => {
  await assert.rejects(fetchTrustedTokenRisk("not-a-mint", async () => {
    throw new Error("network should not be called");
  }), /valid non-SOL output mint/);
});

test("holder verification fails closed when Alchemy credentials are absent", async () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  await assert.rejects(
    fetchTrustedTokenRisk(mint, async () => {
      throw new Error("network must not be called without Alchemy credentials");
    }),
    /Alchemy API key is required/
  );
});

test("risk inspection pages the complete Alchemy holder census and reconciles supply", async () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const firstPage = Array.from({ length: 1000 }, () => ({
    mint, owner: "11111111111111111111111111111111", amount: "1"
  }));
  let holderPages = 0;
  const mockFetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("dexscreener.com")) return Response.json({ pairs: [{
      chainId: "solana", baseToken: { address: mint }, liquidity: { usd: 50000 },
      volume: { h24: 5000 }, priceUsd: "1", txns: { h24: { sells: 20 } }
    }] });
    if (value.includes("rugcheck.xyz")) return Response.json({ score: 100 });
    if (value.includes("api.jup.ag/swap/v2/order")) {
      const amount = new URL(value).searchParams.get("amount");
      return Response.json({
        requestId: "test-sell-order",
        transaction: "AQ==",
        inputMint: mint,
        outputMint: "So11111111111111111111111111111111111111112",
        inAmount: amount,
        outAmount: "1000000",
        routePlan: [{ swapInfo: { label: "test-route" } }]
      });
    }
    const request = JSON.parse(options.body);
    if (value.includes("solana-mainnet.g.alchemy.com")) {
      assert.equal(request.method, "getTokenAccounts");
      holderPages++;
      return Response.json({ result: {
        token_accounts: request.params.page === 1 ? firstPage : [{
          mint, owner: "11111111111111111111111111111112", amount: "1"
        }],
        errors: []
      } });
    }
    if (request.method === "getAccountInfo") return Response.json({ result: {
      value: {
        owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        data: { parsed: { info: {
          mintAuthority: null,
          freezeAuthority: null,
          extensions: [{ extension: "transferHook" }]
        } } }
      }
    } });
    if (request.method === "getTokenSupply") return Response.json({ result: {
      value: { amount: "1001", decimals: 0 }
    } });
    throw new Error("Unexpected RPC method " + request.method);
  };
  const risk = await fetchTrustedTokenRisk(
    mint, mockFetch, "test-alchemy-api-key-123456", "test-jupiter-api-key-123456"
  );
  assert.equal(holderPages, 2);
  assert.equal(risk.holderSampleOnly, false);
  assert.equal(risk.holderAccountCount, 1001);
  assert.equal(risk.holderOwnerCount, 2);
  assert.ok(risk.top10OwnerConcentrationPct > 99);
  assert.equal(risk.checks.token2022ExtensionsSafe, false);
  assert.equal(risk.checks.holderConcentrationSafe, false);
  assert.equal(risk.checks.sellRouteAvailable, true);
  assert.equal(risk.sellRoute.provider, "Jupiter Swap API V2");
  assert.equal(risk.sellRoute.requestId, "test-sell-order");
  assert.equal(risk.passed, false);
});
