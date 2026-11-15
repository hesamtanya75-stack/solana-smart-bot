import test from "node:test";
import assert from "node:assert/strict";
import { fetchTrustedSolUsdQuote, fetchTrustedTokenRisk, validateUnsignedJupiterTransaction, resolveJupiterAddressLookupTables, validateAndResolveUnsignedJupiterTransaction, verifyFinalizedJupiterSettlement } from "../trusted-live-evidence.mjs";

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
function encodeBase58(bytes) {
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[remainder] + encoded;
    number /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) encoded = "1" + encoded;
  return encoded || "1";
}
function mockLookupTableAccount({ owner = "AddressLookupTab1e1111111111111111111111111", deactivationSlot = 0xffffffffffffffffn, lastExtendedSlot = 90n, startIndex = 2, addressCount = 2 } = {}) {
  const data = Buffer.alloc(56 + addressCount * 32);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(deactivationSlot, 4);
  data.writeBigUInt64LE(lastExtendedSlot, 12);
  data[20] = startIndex;
  data[21] = 0; // no authority
  for (let i = 0; i < addressCount; i++) data.fill(i + 7, 56 + i * 32, 56 + (i + 1) * 32);
  return { owner, data: [data.toString("base64"), "base64"], executable: false, lamports: 1 };
}
function validUnsignedV0TransactionWithLookup() {
  const signer = decodeBase58(BOT_WALLET);
  const message = Uint8Array.from([
    0x80, 1, 0, 1,
    2, ...signer, ...new Array(32).fill(17),
    ...new Array(32).fill(0),
    1, 1, 1, 2, 0,
    1, ...new Array(32).fill(42),
    1, 0,
    1, 1
  ]);
  return Buffer.from(Uint8Array.from([
    1, ...new Array(64).fill(0), ...message
  ])).toString("base64");
}
function validUnsignedV1Transaction() {
  const signer = decodeBase58(BOT_WALLET);
  const message = Uint8Array.from([
    0x81, // v1 version prefix
    1, 0, 1, // one required signer, writable signer, one readonly unsigned address
    0, 0, 0, 0, // no transaction config fields
    ...new Array(32).fill(0), // recent blockhash
    1, 2, // one instruction, two inline addresses
    ...signer,
    ...new Array(32).fill(17), // instruction program
    1, 1, 1, 0, // program index, account count, u16 data length
    0, 0, // account index, one-byte instruction data
    ...new Array(64).fill(0) // signatures are at the tail in v1
  ]);
  return Buffer.from(message).toString("base64");
}
function unsignedV1TransactionWithHeap(heapSize) {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  // Set config-mask bit 4 (heap size) and insert its u32 LE value after inline addresses.
  bytes[4] = 0x10;
  const heap = Buffer.alloc(4);
  heap.writeUInt32LE(heapSize, 0);
  return Buffer.concat([bytes.subarray(0, 106), heap, bytes.subarray(106)]).toString("base64");
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

test("v1 transaction rejects duplicate inline account addresses", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes.copy(bytes, 74, 42, 74);
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /duplicate account addresses/
  );
});

test("v1 transaction rejects program id index zero", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes[106] = 0;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /instruction header is invalid/
  );
});

test("v1 heap-size config accepts a valid 32 KiB multiple", () => {
  const parsed = validateUnsignedJupiterTransaction(unsignedV1TransactionWithHeap(32768), BOT_WALLET);
  assert.equal(parsed.messageVersion, 1);
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("v1 heap-size config rejects values outside the protocol bounds or alignment", () => {
  for (const heapSize of [0, 32767, 32769, 262145, 300000]) {
    assert.throws(
      () => validateUnsignedJupiterTransaction(unsignedV1TransactionWithHeap(heapSize), BOT_WALLET),
      /heap size is outside the valid range/
    );
  }
});

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


test("combined transaction validation resolves ALT and keeps instruction semantics untrusted", async () => {
  const parsed = await validateAndResolveUnsignedJupiterTransaction(
    validUnsignedV0TransactionWithLookup(), BOT_WALLET,
    async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 100 }, value: [mockLookupTableAccount()]
    } })
  );
  assert.equal(parsed.messageVersion, 0);
  assert.equal(parsed.lookupTableResolution, "finalized-resolved");
  assert.equal(parsed.lookupContextSlot, 100);
  assert.equal(parsed.resolvedWritableAddresses[0], encodeBase58(new Uint8Array(32).fill(7)));
  assert.equal(parsed.resolvedReadonlyAddresses[0], encodeBase58(new Uint8Array(32).fill(8)));
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("ALT resolver fetches finalized tables and resolves writable/readonly addresses", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  const account = mockLookupTableAccount();
  const result = await resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: [1]
  }], async (url, options) => {
    assert.match(String(url), /api\.mainnet-beta\.solana\.com/);
    const request = JSON.parse(options.body);
    assert.equal(request.method, "getMultipleAccounts");
    assert.deepEqual(request.params[0], [tableKey]);
    assert.equal(request.params[1].commitment, "finalized");
    assert.equal(request.params[1].encoding, "base64");
    return Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 100 }, value: [account]
    } });
  });
  assert.equal(result.contextSlot, 100);
  assert.equal(result.tables[0].writable[0], encodeBase58(new Uint8Array(32).fill(7)));
  assert.equal(result.tables[0].readonly[0], encodeBase58(new Uint8Array(32).fill(8)));
  assert.deepEqual(result.writableAddresses, [encodeBase58(new Uint8Array(32).fill(7))]);
  assert.deepEqual(result.readonlyAddresses, [encodeBase58(new Uint8Array(32).fill(8))]);
});

test("ALT resolver rejects tables not owned by the Address Lookup Table program", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [mockLookupTableAccount({ owner: "TokenkegQfeZyiNwAJNbGKPFXCWuBvf9Ss623VQ5DA" })]
  } })), /unexpected program/);
});

test("ALT resolver rejects deactivated lookup tables", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [mockLookupTableAccount({ deactivationSlot: 99n })]
  } })), /Deactivated/);
});

test("ALT resolver rejects addresses still in the same-slot warmup window", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [1], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [mockLookupTableAccount({ lastExtendedSlot: 100n, startIndex: 1 })]
  } })), /not warmed up/);
});

test("ALT resolver rejects out-of-range lookup indexes", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [2], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [mockLookupTableAccount()]
  } })), /outside the resolved address range/);
});

test("v1 transaction is structurally parsed but never semantically trusted", () => {
  const parsed = validateUnsignedJupiterTransaction(validUnsignedV1Transaction(), BOT_WALLET);
  assert.equal(parsed.messageVersion, 1);
  assert.equal(parsed.signatureCount, 1);
  assert.equal(parsed.staticAccountCount, 2);
  assert.equal(parsed.instructionCount, 1);
  assert.equal(parsed.addressLookupCount, 0);
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("v1 transaction with unknown config bits is rejected", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes[4] = 0x20; // config mask bit 5 is not defined
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /config mask is unsupported/
  );
});

test("v1 transaction with a nonzero signature is rejected", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes[bytes.length - 1] = 1;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /must be unsigned/
  );
});

test("v1 transaction exceeding its protocol size limit is rejected", () => {
  const bytes = Buffer.alloc(4097);
  bytes[0] = 0x81;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /exceeds the 4,096-byte size limit/
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
    1, 2, // one account index (first ALT-loaded writable key)
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


test("v0 instruction account indexes may reference loaded ALT keys", () => {
  const signer = decodeBase58(BOT_WALLET);
  const message = Uint8Array.from([
    0x80, 1, 0, 1,
    2, ...signer, ...new Array(32).fill(17),
    ...new Array(32).fill(0),
    1, 1, 1, 2, 0,
    1, ...new Array(32).fill(42),
    1, 3,
    1, 4
  ]);
  const transaction = Buffer.from(Uint8Array.from([
    1, ...new Array(64).fill(0), ...message
  ])).toString("base64");
  const parsed = validateUnsignedJupiterTransaction(transaction, BOT_WALLET);
  assert.equal(parsed.messageVersion, 0);
  assert.equal(parsed.addressLookupCount, 1);
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


test("settlement proof requires finalized status and exact owner-scoped balance deltas", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(7));
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 123,
          transaction: {
            signatures: [signature],
            message: { accountKeys: [BOT_WALLET] }
          },
          meta: {
            err: null,
            fee: 5000,
            preBalances: [100_000_000],
            postBalances: [89_995_000],
            preTokenBalances: [{
              mint: "So11111111111111111111111111111111111111112",
              owner: BOT_WALLET, uiTokenAmount: { amount: "10000000", decimals: 9 }
            }],
            postTokenBalances: [
              {
                mint: "So11111111111111111111111111111111111111112",
                owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 9 }
              },
              {
                mint: outputMint, owner: BOT_WALLET,
                uiTokenAmount: { amount: "12345", decimals: 6 }
              }
            ]
          }
        };
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, result
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const proof = await verifyFinalizedJupiterSettlement({
    signature,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint,
    inputAmount: "10000000",
    outputAmount: "12345"
  }, fetchImpl);
  assert.equal(proof.verified, true);
  assert.equal(proof.confirmationStatus, "finalized");
  assert.equal(proof.slot, 123);
});

test("settlement proof rejects a transaction where the bot wallet is not the fee payer", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(9));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 125,
          transaction: {
            signatures: [signature],
            message: { accountKeys: ["11111111111111111111111111111111", BOT_WALLET, "TokenAccountInput11111111111111111111111111111", "TokenAccountOutput1111111111111111111111111111"] }
          },
          meta: {
            err: null, fee: 5000,
            preBalances: [1, 100_000_000, 1, 1], postBalances: [1, 89_995_000, 1, 1],
            preTokenBalances: [
              { accountIndex: 2, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "10000000", decimals: 9 } }
            ],
            postTokenBalances: [
              { accountIndex: 2, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 9 } },
              { accountIndex: 3, mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "12345", decimals: 6 } }
            ]
          }
        };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  await assert.rejects(
    verifyFinalizedJupiterSettlement({
      signature, inputMint, outputMint, inputAmount: "10000000", outputAmount: "12345"
    }, fetchImpl),
    /not the finalized transaction fee payer/
  );
});

test("settlement proof rejects a finalized transaction with mismatched output", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(8));
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 124,
          transaction: { signatures: [signature], message: { accountKeys: [BOT_WALLET] } },
          meta: {
            err: null, fee: 5000, preBalances: [100_000_000], postBalances: [89_995_000],
            preTokenBalances: [{
              mint: "So11111111111111111111111111111111111111112",
              owner: BOT_WALLET, uiTokenAmount: { amount: "10000000", decimals: 9 }
            }],
            postTokenBalances: [
              {
                mint: "So11111111111111111111111111111111111111112",
                owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 9 }
              },
              {
                mint: outputMint, owner: BOT_WALLET,
                uiTokenAmount: { amount: "12344", decimals: 6 }
              }
            ]
          }
        };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  await assert.rejects(() => verifyFinalizedJupiterSettlement({
    signature,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint,
    inputAmount: "10000000",
    outputAmount: "12345"
  }, fetchImpl), /output token balance delta does not match/);
});

test("settlement proof rejects confirmed but non-finalized signatures", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(9));
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "confirmed" }] }
      : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  await assert.rejects(() => verifyFinalizedJupiterSettlement({
    signature,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inputAmount: "10000000",
    outputAmount: "12345"
  }, fetchImpl), /not successfully finalized/);
});
