import test from "node:test";
import assert from "node:assert/strict";
import { fetchJupiterQuote } from "../jupiter-quote-client.js";

const inputMint = "So11111111111111111111111111111111111111112";
const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const amountAtomic = "100000000";
const validBody = {
  inAmount: amountAtomic, outAmount: "12000000", router: "metis",
  requestId: "request-123", feeBps: 2, priceImpactPct: "0.01",
  transaction: null
};
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("requests Jupiter V2 quote without wallet taker or transaction", async () => {
  let requested;
  const result = await fetchJupiterQuote({
    inputMint, outputMint, amountAtomic, apiKey: "secret-key",
    now: () => 123456,
    fetchImpl: async (url, options) => {
      requested = { url: new URL(url), options };
      return response(validBody);
    }
  });
  assert.equal(requested.url.origin + requested.url.pathname, "https://api.jup.ag/swap/v2/order");
  assert.equal(requested.url.searchParams.get("amount"), amountAtomic);
  assert.equal(requested.url.searchParams.has("taker"), false);
  assert.equal(requested.options.headers["x-api-key"], "secret-key");
  assert.equal(requested.options.redirect, "error");
  assert.equal(result.outputAmountAtomic, "12000000");
  assert.equal(result.fetchedAt, 123456);
  assert.equal(result.evidenceClass, "provider-response-unverified");
  assert.equal(Object.hasOwn(result, "transaction"), false);
  assert.equal(Object.hasOwn(result, "trusted"), false);
});

test("rejects mint strings whose decoded public key width is invalid", async () => {
  await assert.rejects(fetchJupiterQuote({
    inputMint: "11111111111111111111111111111111111111111111", outputMint, amountAtomic,
    fetchImpl: async () => response(validBody)
  }), /valid-looking/);
});

test("rejects mismatched mint or amount response", async () => {
  await assert.rejects(fetchJupiterQuote({
    inputMint, outputMint, amountAtomic,
    fetchImpl: async () => response({ ...validBody, inAmount: "999" })
  }), /does not match/);
  await assert.rejects(fetchJupiterQuote({
    inputMint, outputMint, amountAtomic,
    fetchImpl: async () => response({ ...validBody, outputMint: inputMint })
  }), /does not match/);
});

test("rejects transaction-bearing response to maintain quote-only boundary", async () => {
  await assert.rejects(fetchJupiterQuote({
    inputMint, outputMint, amountAtomic,
    fetchImpl: async () => response({ ...validBody, transaction: "base64" })
  }), /quote-only/);
});

test("fails closed on HTTP, JSON, and invalid input", async () => {
  await assert.rejects(fetchJupiterQuote({
    inputMint, outputMint, amountAtomic,
    fetchImpl: async () => response({}, 429)
  }), /HTTP 429/);
  await assert.rejects(fetchJupiterQuote({
    inputMint, outputMint, amountAtomic,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw Error(); } })
  }), /valid JSON/);
  await assert.rejects(fetchJupiterQuote({
    inputMint, outputMint, amountAtomic: "1e8",
    fetchImpl: async () => response(validBody)
  }), /positive integer/);
});

test("never includes API key in provider error messages", async () => {
  await assert.rejects(fetchJupiterQuote({
    inputMint, outputMint, amountAtomic, apiKey: "sensitive-value",
    fetchImpl: async () => { throw Error("sensitive-value network trace"); }
  }), error => {
    assert.doesNotMatch(error.message, /sensitive-value/);
    return true;
  });
});


test("rejects a response that explicitly substitutes the input mint", async () => {
  await assert.rejects(fetchJupiterQuote({
    inputMint, outputMint, amountAtomic,
    fetchImpl: async () => response({ ...validBody, inputMint: outputMint })
  }), /does not match/);
});

test("keeps provenance unverified even when the response is well-formed", async () => {
  const result = await fetchJupiterQuote({
    inputMint, outputMint, amountAtomic,
    fetchImpl: async () => response({ ...validBody, inputMint, outputMint })
  });
  assert.equal(result.evidenceClass, "provider-response-unverified");
  assert.equal(Object.hasOwn(result, "trusted"), false);
});
