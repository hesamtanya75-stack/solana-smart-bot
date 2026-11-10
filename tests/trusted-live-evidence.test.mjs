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

test("risk inspection never claims complete holder concentration from top-20 sample", async () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const mockFetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("dexscreener.com")) return Response.json({ pairs: [{
      chainId: "solana", baseToken: { address: mint }, liquidity: { usd: 50000 },
      volume: { h24: 5000 }, priceUsd: "1", txns: { h24: { sells: 20 } }
    }] });
    if (value.includes("rugcheck.xyz")) return Response.json({ score: 100 });
    const request = JSON.parse(options.body);
    const method = request.method;
    if (method === "getAccountInfo") return Response.json({ result: {
      value: {
        owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        data: { parsed: { info: {
          mintAuthority: null,
          freezeAuthority: null,
          extensions: [{ extension: "transferHook" }]
        } } }
      }
    } });
    if (method === "getTokenLargestAccounts") return Response.json({ result: {
      value: [{ address: "11111111111111111111111111111111" }]
    } });
    if (method === "getTokenSupply") return Response.json({ result: {
      value: { amount: "1000000" }
    } });
    if (method === "getMultipleAccounts") return Response.json({ result: {
      value: [{ data: { parsed: { info: {
        owner: "11111111111111111111111111111111", tokenAmount: { amount: "1000" }
      } } } }]
    } });
    throw new Error("Unexpected RPC method " + method);
  };
  const risk = await fetchTrustedTokenRisk(mint, mockFetch);
  assert.equal(risk.holderSampleOnly, true);
  assert.equal(risk.checks.token2022ExtensionsSafe, false);
  assert.equal(risk.checks.holderConcentrationSafe, false);
  assert.equal(risk.checks.sellRouteAvailable, false);
  assert.equal(risk.passed, false);
});
