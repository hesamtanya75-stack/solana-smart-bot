import test from "node:test";
import assert from "node:assert/strict";
import { fetchTrustedSolUsdQuote, fetchTrustedTokenRisk, validateUnsignedJupiterTransaction } from "../trusted-live-evidence.mjs";

const BOT_WALLET = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
function decodeBase58(value) {
  let number = 0n;
  for (const char of value) number = number * 58n +
    BigInt("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".indexOf(char));
  const bytes = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (let i = 0; i < value.length && value[i] === "1"; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}
function validUnsignedTransaction(programIdBytes = new Array(32).fill(0), signatureByte = 0) {
  const key = decodeBase58(BOT_WALLET);
  const systemProgram = new Array(32).fill(0);
  const message = Uint8Array.from([
    1, 0, 1, 2, ...key, ...programIdBytes,
    ...new Array(32).fill(0),
    1, 1, 1, 0, 0
  ]);
  return Buffer.from(Uint8Array.from([1, ...new Array(64).fill(signatureByte), ...message])).toString("base64");
}

test("unknown instruction program is parsed structurally but never semantically trusted", () => {
  const unknownProgram = new Array(32).fill(17);
  const parsed = validateUnsignedJupiterTransaction(
    validUnsignedTransaction(unknownProgram),
    BOT_WALLET
  );
  assert.equal(parsed.instructionCount, 1);
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("transaction pinned to a different wallet is rejected", () => {
  const differentWallet = "11111111111111111111111111111111";
  assert.throws(
    () => validateUnsignedJupiterTransaction(validUnsignedTransaction(), differentWallet),
    /not pinned to the expected bot wallet/
  );
});

test("non-canonical base64 transaction is rejected", () => {
  assert.throws(
    () => validateUnsignedJupiterTransaction("not base64!", BOT_WALLET),
    /not canonical base64/
  );
});

test("oversized legacy/v0 transaction is rejected before full-buffer canonicalization", () => {
  const oversized = Buffer.alloc(1233).toString("base64");
  assert.throws(
    () => validateUnsignedJupiterTransaction(oversized, BOT_WALLET),
    /exceeds the 1,232-byte size limit/
  );
});

test("non-canonical padded base64 encoding is rejected", () => {
  // "AB==" decodes to the same byte as canonical "AA==" but has non-zero pad bits.
  assert.throws(
    () => validateUnsignedJupiterTransaction("AB==", BOT_WALLET),
    /base64 encoding is non-canonical/
  );
});

test("pre-signed Jupiter transaction is rejected", () => {
  assert.throws(
    () => validateUnsignedJupiterTransaction(validUnsignedTransaction(undefined, 1), BOT_WALLET),
    /must be unsigned/
  );
});

test("malformed Jupiter instruction program index is rejected", () => {
  const encoded = validUnsignedTransaction();
  const bytes = Buffer.from(encoded, "base64");
  // The final five bytes are the one-instruction header and its indexes/data.
  bytes[bytes.length - 4] = 250;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /program index is invalid/
  );
});


test("unsupported versioned Jupiter message is rejected", () => {
  const bytes = Buffer.from(validUnsignedTransaction(), "base64");
  // Signature-count prefix + 64 signature bytes = message start.
  bytes[65] = 0x81;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /Unsupported Jupiter transaction message version/
  );
});

test("out-of-range Jupiter instruction account index is rejected", () => {
  const bytes = Buffer.from(validUnsignedTransaction(), "base64");
  bytes[bytes.length - 2] = 250;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /instruction account index is invalid/
  );
});

test("unparsed trailing Jupiter transaction bytes are rejected", () => {
  const bytes = Buffer.from(validUnsignedTransaction(), "base64");
  const extended = Buffer.concat([bytes, Buffer.from([0, 0, 0])]);
  assert.throws(
    () => validateUnsignedJupiterTransaction(extended.toString("base64"), BOT_WALLET),
    /trailing or unparsed bytes/
  );
});

test("non-canonical compact instruction count is rejected", () => {
  const bytes = Buffer.from(validUnsignedTransaction(), "base64");
  // Message begins after the one-byte signature count and 64-byte signature.
  // The instruction count follows the three-byte message header, account
  // count, two 32-byte keys, and the 32-byte recent blockhash.
  const instructionCountOffset = 65 + 3 + 1 + 64 + 32;
  const malformed = Buffer.concat([
    bytes.subarray(0, instructionCountOffset),
    Buffer.from([0x81, 0x00]),
    bytes.subarray(instructionCountOffset + 1)
  ]);
  assert.throws(
    () => validateUnsignedJupiterTransaction(malformed.toString("base64"), BOT_WALLET),
    /compact length is non-canonical/
  );
});

test("compact instruction count exceeding u16 is rejected", () => {
  const bytes = Buffer.from(validUnsignedTransaction(), "base64");
  const instructionCountOffset = 65 + 3 + 1 + 64 + 32;
  const malformed = Buffer.concat([
    bytes.subarray(0, instructionCountOffset),
    Buffer.from([0xff, 0xff, 0x04]),
    bytes.subarray(instructionCountOffset + 1)
  ]);
  assert.throws(
    () => validateUnsignedJupiterTransaction(malformed.toString("base64"), BOT_WALLET),
    /compact length exceeds u16/
  );
});

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
  const firstPage = Array.from({ length: 100 }, (_, i) => ({
    address: "TokenAccountAddress" + String(i).padStart(20, "0"),
    mint, owner: "11111111111111111111111111111111", amount: "10"
  }));
  let holderPages = 0;
  let jupiterResponseOverride = null;
  let clock = 1000;
  const originalNow = Date.now;
  Date.now = () => clock;
  const mockFetch = async (url, options = {}) => {
    // Simulate slow upstream requests. Evidence freshness must remain anchored
    // to the start of collection, not be refreshed after these requests finish.
    clock += 1000;
    const value = String(url);
    if (value.includes("dexscreener.com")) return Response.json({ pairs: [{
      chainId: "solana", baseToken: { address: mint }, liquidity: { usd: 50000 },
      volume: { h24: 5000 }, priceUsd: "1", txns: { h24: { sells: 20 } }
    }] });
    if (value.includes("rugcheck.xyz")) return Response.json({ score: 100 });
    if (value.includes("api.jup.ag/swap/v2/order")) {
      const params = new URL(value).searchParams;
      assert.equal(params.has("taker"), false, "quote-only sell check must not require a funded taker");
      const amount = params.get("amount");
      return Response.json(jupiterResponseOverride || {
        requestId: "test-sell-quote",
        transaction: null,
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
      return Response.json({ jsonrpc: "2.0", id: request.id, result: {
        token_accounts: request.params.page === 1 ? firstPage : [{
          address: "TokenAccountAddress" + "100".padStart(20, "0"),
          mint, owner: "11111111111111111111111111111112", amount: "1"
        }],
        errors: []
      } });
    }
    if (request.method === "getAccountInfo") {
      assert.equal(request.params[1].commitment, "finalized");
      return Response.json({ jsonrpc: "2.0", id: 1, result: {
        value: {
          owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
          data: { parsed: { info: {
            mintAuthority: null,
            freezeAuthority: null,
            extensions: [{ extension: "transferHook" }]
          } } }
        }
      } });
    }
    if (request.method === "getTokenSupply") {
      assert.equal(request.params[1].commitment, "finalized");
      return Response.json({ jsonrpc: "2.0", id: 1, result: {
        value: { amount: "1001", decimals: 0 }
      } });
    }
    throw new Error("Unexpected RPC method " + request.method);
  };
  let risk;
  try {
    risk = await fetchTrustedTokenRisk(
      mint, mockFetch, "test-alchemy-api-key-123456", "test-jupiter-api-key-123456"
    );
    jupiterResponseOverride = {
      requestId: "missing-transaction-field",
      inputMint: mint,
      outputMint: "So11111111111111111111111111111111111111112",
      inAmount: "3",
      outAmount: "1000000",
      routePlan: [{ swapInfo: { label: "test-route" } }]
    };
    await assert.rejects(
      fetchTrustedTokenRisk(mint, mockFetch, "test-alchemy-api-key-123456", "test-jupiter-api-key-123456"),
      /complete quote-only sell-route response/
    );
    jupiterResponseOverride = {
      transaction: null,
      inputMint: mint,
      outputMint: "So11111111111111111111111111111111111111112",
      inAmount: "3",
      outAmount: "1000000",
      routePlan: [{ swapInfo: { label: "test-route" } }]
    };
    await assert.rejects(
      fetchTrustedTokenRisk(mint, mockFetch, "test-alchemy-api-key-123456", "test-jupiter-api-key-123456"),
      /complete quote-only sell-route response/
    );
  } finally {
    Date.now = originalNow;
  }
  assert.equal(risk.fetchedAt, 1000);
  assert.ok(clock > risk.fetchedAt);
  // Three full evidence fetches run: one valid quote and two malformed quote regressions.
  // Each must still page both holder-census pages completely.
  assert.equal(holderPages, 6);
  assert.equal(risk.holderSampleOnly, false);
  assert.equal(risk.holderAccountCount, 101);
  assert.equal(risk.holderOwnerCount, 2);
  assert.ok(risk.top10OwnerConcentrationPct > 99);
  assert.equal(risk.checks.token2022ExtensionsSafe, false);
  assert.equal(risk.checks.holderConcentrationSafe, false);
  assert.equal(risk.checks.sellRouteAvailable, false);
  assert.equal(risk.sellRoute.provider, "Jupiter Swap API V2");
  assert.equal(risk.sellRoute.requestId, "test-sell-quote");
  assert.equal(risk.sellRoute.semanticInstructionVerification, false);
  assert.equal(risk.sellRoute.signatureCount, null);
  assert.equal(risk.sellRoute.walletTokenBalance, undefined);
  assert.equal(risk.sellRoute.routeVerification, "quote-only-no-transaction");
  assert.equal(risk.passed, false);
});


test("v0 transaction with address lookup tables remains structurally parsed but semantically untrusted", () => {
  const signer = decodeBase58(BOT_WALLET);
  const message = Uint8Array.from([
    0x80, // versioned message, version 0
    1, 0, 1, // one required signer, writable signer, one readonly unsigned account
    2, // two static account keys
    ...signer,
    ...new Array(32).fill(17),
    ...new Array(32).fill(0), // recent blockhash
    1, // one compiled instruction
    1, // program id index (static key 1)
    1, 0, // one account index (static key 0)
    0, // empty instruction data
    1, // one address lookup table
    ...new Array(32).fill(42), // lookup table account address
    1, 3, // one writable lookup index
    1, 4 // one readonly lookup index
  ]);
  const transaction = Buffer.from(Uint8Array.from([
    1, ...new Array(64).fill(0), ...message
  ])).toString("base64");

  const parsed = validateUnsignedJupiterTransaction(transaction, BOT_WALLET);
  assert.equal(parsed.messageVersion, 0);
  assert.equal(parsed.addressLookupCount, 1);
  assert.equal(parsed.instructionCount, 1);
  assert.equal(parsed.semanticInstructionVerification, false);
});


test("truncated v0 address lookup readonly indexes are rejected", () => {
  const signer = decodeBase58(BOT_WALLET);
  const message = Uint8Array.from([
    0x80, 1, 0, 1,
    2, ...signer, ...new Array(32).fill(17),
    ...new Array(32).fill(0),
    1, 1, 1, 0, 0,
    1, ...new Array(32).fill(42),
    1, 3,
    1, 4
  ]);
  const transaction = Buffer.from(Uint8Array.from([
    1, ...new Array(64).fill(0), ...message
  ])).toString("base64");
  const malformedBytes = Buffer.from(transaction, "base64");
  // The penultimate byte is the readonly lookup index count; claim two indexes
  // while supplying only one so the base64 encoding remains canonical.
  malformedBytes[malformedBytes.length - 2] = 2;
  const malformed = malformedBytes.toString("base64");

  assert.throws(
    () => validateUnsignedJupiterTransaction(malformed, BOT_WALLET),
    /Jupiter readonly lookup indexes are truncated/
  );
});


test("truncated v0 address lookup writable indexes are rejected", () => {
  const signer = decodeBase58(BOT_WALLET);
  const message = Uint8Array.from([
    0x80, 1, 0, 1,
    2, ...signer, ...new Array(32).fill(17),
    ...new Array(32).fill(0),
    1, 1, 1, 0, 0,
    1, ...new Array(32).fill(42),
    2, 3
  ]);
  const transaction = Buffer.from(Uint8Array.from([
    1, ...new Array(64).fill(0), ...message
  ])).toString("base64");

  assert.throws(
    () => validateUnsignedJupiterTransaction(transaction, BOT_WALLET),
    /Jupiter writable lookup indexes are truncated/
  );
});


test("Jupiter transaction requiring an additional signer is rejected", () => {
  const original = Buffer.from(validUnsignedTransaction(), "base64");
  const message = Buffer.from(original.subarray(65));
  // Add a second all-zero signature and declare both static keys as signers.
  message[0] = 2; // required signatures
  message[2] = 0; // no readonly unsigned signer accounts
  const transaction = Buffer.concat([
    Buffer.from([2]),
    Buffer.alloc(128),
    message
  ]);
  assert.throws(
    () => validateUnsignedJupiterTransaction(transaction.toString("base64"), BOT_WALLET),
    /signer header is inconsistent/
  );
});
