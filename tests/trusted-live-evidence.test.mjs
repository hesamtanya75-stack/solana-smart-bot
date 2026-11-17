import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fetchTrustedSolUsdQuote, fetchTrustedTokenRisk, validateJupiterBuildResponse, validateUnsignedJupiterTransaction, resolveJupiterAddressLookupTables, validateAndResolveUnsignedJupiterTransaction, verifyFinalizedJupiterSettlement, fetchProgramAccountIdentityEvidence, verifyUpgradeableProgramDeploymentAllowlist, verifyReviewedNativeProgramIdentities, verifyCompleteOuterProgramIdentity, decodeReviewedSystemTransfers, decodeReviewedSplTokenTransfers, verifyComputeBudgetPriorityFee } from "../trusted-live-evidence.mjs";

const BOT_WALLET = "BbUEve9uvdrhG2oKq9VKP8xdEGwR8ZeimYHxBtvFRrh9";
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
function validUnsignedV0TransactionWithLookup(signerAddress = BOT_WALLET) {
  const signer = decodeBase58(signerAddress);
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
function validUnsignedV1Transaction(signerAddress = BOT_WALLET) {
  const signer = decodeBase58(signerAddress);
  const message = Uint8Array.from([
    0x81, // v1 version prefix
    1, 0, 1, // one required signer, writable signer, one readonly unsigned address
    0x0c, 0, 0, 0, // compute-unit and loaded-account-data limits are required
    ...new Array(32).fill(0), // recent blockhash
    1, 2, // one instruction, two inline addresses
    ...signer,
    ...new Array(32).fill(17), // instruction program
    0x20, 0x4e, 0, 0, // 20,000 compute units
    0, 0, 0x40, 0, // 4 MiB loaded-account data limit
    1, 1, 1, 0, // program index, account count, u16 data length
    0, 0, // account index, one-byte instruction data
    ...new Array(64).fill(0) // signatures are at the tail in v1
  ]);
  return Buffer.from(message).toString("base64");
}
function unsignedV1TransactionWithHeap(heapSize) {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  // Set config-mask bit 4 (heap size) and insert its u32 LE value after inline addresses.
  bytes[4] = 0x1c;
  const heap = Buffer.alloc(4);
  heap.writeUInt32LE(heapSize, 0);
  return Buffer.concat([bytes.subarray(0, 114), heap, bytes.subarray(114)]).toString("base64");
}
function unsignedV1TransactionWithPriorityFee(priorityFeeLamports) {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  // Bits 0-1 jointly encode the optional total priority fee (u64 LE).
  bytes[4] = 0x0f;
  const fee = Buffer.alloc(8);
  fee.writeBigUInt64LE(BigInt(priorityFeeLamports), 0);
  return Buffer.concat([bytes.subarray(0, 106), fee, bytes.subarray(106)]).toString("base64");
}
function unsignedV1TransactionWithPriorityFeeAndHeap(priorityFeeLamports, heapSize) {
  const bytes = Buffer.from(unsignedV1TransactionWithPriorityFee(priorityFeeLamports), "base64");
  // Add heap-size bit and value after priority fee, compute limit and loaded-data limit.
  bytes[4] = 0x1f;
  const heap = Buffer.alloc(4);
  heap.writeUInt32LE(heapSize, 0);
  return Buffer.concat([bytes.subarray(0, 122), heap, bytes.subarray(122)]).toString("base64");
}
function validUnsignedTransaction(programIdBytes = new Array(32).fill(0), signatureByte = 0, signerAddress = BOT_WALLET) {
  const key = decodeBase58(signerAddress);
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

test("legacy transaction rejects duplicate static account keys", () => {
  const bytes = Buffer.from(validUnsignedTransaction(), "base64");
  bytes.copy(bytes, 101, 69, 101);
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /duplicate static account keys/
  );
});

test("v0 transaction rejects duplicate static account keys", () => {
  const bytes = Buffer.from(validUnsignedV0TransactionWithLookup(), "base64");
  bytes.copy(bytes, 102, 70, 102);
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /duplicate static account keys/
  );
});

test("legacy and v0 transactions reject fee payer as instruction program", () => {
  const legacy = Buffer.from(validUnsignedTransaction(), "base64");
  legacy[legacy.length - 4] = 0;
  assert.throws(
    () => validateUnsignedJupiterTransaction(legacy.toString("base64"), BOT_WALLET),
    /program index is invalid/
  );

  const v0 = Buffer.from(validUnsignedV0TransactionWithLookup(), "base64");
  v0[167] = 0;
  assert.throws(
    () => validateUnsignedJupiterTransaction(v0.toString("base64"), BOT_WALLET),
    /program index is invalid/
  );
});

test("legacy and v0 transactions reject a readonly sole signer fee payer", () => {
  const legacy = Buffer.from(validUnsignedTransaction(), "base64");
  legacy[66] = 1;
  assert.throws(
    () => validateUnsignedJupiterTransaction(legacy.toString("base64"), BOT_WALLET),
    /signer header is inconsistent/
  );

  const v0 = Buffer.from(validUnsignedV0TransactionWithLookup(), "base64");
  v0[67] = 1;
  assert.throws(
    () => validateUnsignedJupiterTransaction(v0.toString("base64"), BOT_WALLET),
    /signer header is inconsistent/
  );
});

test("v1 transaction rejects a readonly sole signer fee payer", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes[2] = 1;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /signer header is inconsistent/
  );
});

test("v1 transaction rejects program id index zero", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes[114] = 0;
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
  assert.equal(parsed.compiledInstructions.length, 1);
  assert.equal(parsed.staticAccountKeys[parsed.compiledInstructions[0].programIdIndex],
    encodeBase58(new Uint8Array(32).fill(17)));
  assert.deepEqual(parsed.compiledInstructions[0].accountIndexes, [0]);
  assert.equal(parsed.compiledInstructions[0].dataBase64, "");
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("unsigned transaction parser accepts the explicitly approved Phantom wallet as fee payer", () => {
  const phantomWallet = encodeBase58(new Uint8Array(32).fill(9));
  const parsed = validateUnsignedJupiterTransaction(
    validUnsignedTransaction(undefined, 0, phantomWallet),
    phantomWallet
  );
  assert.equal(parsed.staticAccountKeys[0], phantomWallet);
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("transaction pinned to a different wallet is rejected", () => {
  const differentWallet = "11111111111111111111111111111111";
  assert.throws(
    () => validateUnsignedJupiterTransaction(validUnsignedTransaction(), differentWallet),
    /does not match the expected Phantom wallet/
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


test("legacy outer instruction evidence resolves program, signer and writable account roles without semantic approval", async () => {
  const parsed = await validateAndResolveUnsignedJupiterTransaction(
    validUnsignedTransaction(), BOT_WALLET
  );
  assert.equal(parsed.outerInstructionEvidence.length, 1);
  assert.equal(parsed.outerInstructionEvidence[0].programId, encodeBase58(new Uint8Array(32)));
  assert.deepEqual(parsed.outerInstructionEvidence[0].accounts, [{
    accountIndex: 0,
    messageKeyIndex: 0,
    pubkey: BOT_WALLET,
    isSigner: true,
    isWritable: true
  }]);
  assert.equal(parsed.outerInstructionEvidence[0].dataBase64, "");
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("v0 outer instruction evidence resolves ALT-loaded writable and readonly account roles", async () => {
  const parsed = await validateAndResolveUnsignedJupiterTransaction(
    validUnsignedV0TransactionWithLookup(), BOT_WALLET,
    async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 100 }, value: [mockLookupTableAccount()]
    } })
  );
  const instruction = parsed.outerInstructionEvidence[0];
  assert.equal(instruction.programId, encodeBase58(new Uint8Array(32).fill(17)));
  assert.deepEqual(instruction.accounts.map(account => ({
    pubkey: account.pubkey, isSigner: account.isSigner, isWritable: account.isWritable
  })), [{
    pubkey: encodeBase58(new Uint8Array(32).fill(7)),
    isSigner: false,
    isWritable: true
  }]);
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("v0 rejects an ALT-loaded address used as an instruction program", async () => {
  const bytes = Buffer.from(validUnsignedV0TransactionWithLookup(), "base64");
  // The compiled instruction program index follows the message header, keys,
  // blockhash, and instruction count; index 2 is the writable ALT-loaded key.
  bytes[167] = 2;
  await assert.rejects(
    () => validateAndResolveUnsignedJupiterTransaction(
      bytes.toString("base64"), BOT_WALLET,
      async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
        context: { slot: 100 }, value: [mockLookupTableAccount()]
      } })
    ),
    /program index is invalid/
  );
});

test("legacy and v1 reject writable program accounts before exposing instruction evidence", async () => {
  const legacy = Buffer.from(validUnsignedTransaction(), "base64");
  // Message header starts after the one-byte signature count and 64-byte signature.
  // The second static key is the instruction program; mark it writable.
  legacy[67] = 0;
  await assert.rejects(
    () => validateAndResolveUnsignedJupiterTransaction(
      legacy.toString("base64"), BOT_WALLET
    ),
    /program account must be readonly and non-signer/
  );

  const v1 = Buffer.from(validUnsignedV1Transaction(), "base64");
  // V1's three-byte signer header begins immediately after the version prefix.
  v1[3] = 0;
  await assert.rejects(
    () => validateAndResolveUnsignedJupiterTransaction(
      v1.toString("base64"), BOT_WALLET
    ),
    /program account must be readonly and non-signer/
  );
});

test("v1 outer instruction evidence preserves inline accounts and opaque instruction data", async () => {
  const parsed = await validateAndResolveUnsignedJupiterTransaction(
    validUnsignedV1Transaction(), BOT_WALLET
  );
  const instruction = parsed.outerInstructionEvidence[0];
  assert.equal(instruction.programId, encodeBase58(new Uint8Array(32).fill(17)));
  assert.deepEqual(instruction.accounts[0], {
    accountIndex: 0,
    messageKeyIndex: 0,
    pubkey: BOT_WALLET,
    isSigner: true,
    isWritable: true
  });
  assert.equal(instruction.dataBase64, "AA==");
  assert.equal(parsed.semanticInstructionVerification, false);
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

test("ALT resolver rejects more than 256 aggregate loaded addresses", async () => {
  const tableKeys = [42, 43].map(value => encodeBase58(new Uint8Array(32).fill(value)));
  const makeAccount = (start) => {
    const data = Buffer.alloc(56 + 129 * 32);
    data.writeUInt32LE(1, 0);
    data.writeBigUInt64LE(0xffffffffffffffffn, 4);
    data.writeBigUInt64LE(90n, 12);
    data[20] = 129;
    for (let i = 0; i < 129; i++) data.fill(start + i, 56 + i * 32, 56 + (i + 1) * 32);
    return { owner: "AddressLookupTab1e1111111111111111111111111", data: [data.toString("base64"), "base64"] };
  };
  await assert.rejects(resolveJupiterAddressLookupTables(tableKeys.map(accountKey => ({
    accountKey,
    writableIndexes: Array.from({ length: 129 }, (_, index) => index),
    readonlyIndexes: []
  })), async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [makeAccount(1), makeAccount(130)]
  } })), /exceeds the 256-account message key limit/);
});

test("ALT resolver rejects duplicate addresses across loaded writable and readonly keys", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  const account = mockLookupTableAccount();
  const data = Buffer.from(account.data[0], "base64");
  data.copy(data, 56 + 32, 56, 56 + 32);
  account.data = [data.toString("base64"), "base64"];
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: [1]
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [account]
  } })), /duplicate account addresses/);
});

test("resolved ALT addresses cannot duplicate a static transaction account key", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  const account = mockLookupTableAccount();
  const data = Buffer.from(account.data[0], "base64");
  data.fill(17, 56, 88); // Duplicate the second inline static account key.
  account.data = [data.toString("base64"), "base64"];
  await assert.rejects(validateAndResolveUnsignedJupiterTransaction(
    validUnsignedV0TransactionWithLookup(), BOT_WALLET,
    async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 100 }, value: [account]
    } })
  ), /duplicate a static transaction account key/);
});

test("ALT resolver rejects sparse lookup descriptor arrays before RPC", async () => {
  let called = false;
  const sparseLookups = new Array(2);
  sparseLookups[0] = {
    accountKey: encodeBase58(new Uint8Array(32).fill(42)),
    writableIndexes: [], readonlyIndexes: []
  };
  await assert.rejects(
    resolveJupiterAddressLookupTables(sparseLookups, async () => {
      called = true;
      throw new Error("RPC should not be called");
    }),
    /lookup table keys are invalid or duplicated/
  );
  assert.equal(called, false);
});

test("ALT resolver rejects duplicate indexes before making an RPC request", async () => {
  let called = false;
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: encodeBase58(new Uint8Array(32).fill(42)),
    writableIndexes: [0], readonlyIndexes: [0]
  }], async () => { called = true; throw new Error("RPC should not be called"); }),
  /indexes are invalid or duplicated/);
  assert.equal(called, false);
});

test("ALT resolver rejects tables not owned by the Address Lookup Table program", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [mockLookupTableAccount({ owner: "TokenkegQfeZyiNwAJNbGKPFXCWuBvf9Ss623VQ5DA" })]
  } })), /unexpected program/);
});

test("ALT resolver rejects oversized encoded account data before decoding", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  const oversized = mockLookupTableAccount();
  oversized.data = ["A".repeat(11004), "base64"];
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [oversized]
  } })), /exceeds the maximum encoded size/);
});


test("ALT resolver rejects nonzero reserved authority bytes when authority is absent", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  const malformed = mockLookupTableAccount();
  const bytes = Buffer.from(malformed.data[0], "base64");
  bytes[22] = 1;
  malformed.data = [bytes.toString("base64"), "base64"];
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [malformed]
  } })), /metadata is invalid/);
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

test("v1 priority fee requires both mask bits and preserves config offsets", () => {
  const parsed = validateUnsignedJupiterTransaction(
    unsignedV1TransactionWithPriorityFee(5000), BOT_WALLET
  );
  assert.equal(parsed.messageVersion, 1);
  assert.equal(parsed.semanticInstructionVerification, false);
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes[4] = 0x0d; // only one of the two priority-fee mask bits
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /config mask is unsupported/
  );
});

test("v1 priority fee and heap config values are parsed in wire order", () => {
  const parsed = validateUnsignedJupiterTransaction(
    unsignedV1TransactionWithPriorityFeeAndHeap(5000, 32768), BOT_WALLET
  );
  assert.equal(parsed.messageVersion, 1);
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("v1 compute and loaded-data limits accept their supported upper boundaries", () => {
  const computeMax = Buffer.from(validUnsignedV1Transaction(), "base64");
  computeMax.writeUInt32LE(1_400_000, 106);
  const computeParsed = validateUnsignedJupiterTransaction(computeMax.toString("base64"), BOT_WALLET);
  assert.equal(computeParsed.messageVersion, 1);
  assert.equal(computeParsed.semanticInstructionVerification, false);

  const loadedDataMax = Buffer.from(validUnsignedV1Transaction(), "base64");
  loadedDataMax.writeUInt32LE(64 * 1024 * 1024, 110);
  const loadedDataParsed = validateUnsignedJupiterTransaction(loadedDataMax.toString("base64"), BOT_WALLET);
  assert.equal(loadedDataParsed.messageVersion, 1);
  assert.equal(loadedDataParsed.semanticInstructionVerification, false);
});

test("v1 heap-size config accepts the inclusive 256 KiB upper boundary", () => {
  const parsed = validateUnsignedJupiterTransaction(
    unsignedV1TransactionWithHeap(262144), BOT_WALLET
  );
  assert.equal(parsed.messageVersion, 1);
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("v1 transaction without explicit compute and loaded-data limits is rejected", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes[4] = 0;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /must explicitly set compute and loaded-data limits/
  );
});

test("v1 transaction rejects zero compute-unit or loaded-data limits", () => {
  for (const offset of [106, 110]) {
    const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
    bytes.fill(0, offset, offset + 4);
    assert.throws(
      () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
      offset === 106
        ? /compute-unit limit is outside the supported range/
        : /loaded-data limit is outside the supported range/
    );
  }
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

test("oversized Jupiter base64 input is rejected before decoding", () => {
  assert.throws(
    () => validateUnsignedJupiterTransaction("A".repeat(5468), BOT_WALLET),
    /empty or not canonical base64/
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


test("program identity evidence caps combined Program and ProgramData RPC snapshots at 100 accounts", async () => {
  const instructions = Array.from({ length: 51 }, (_, index) => ({
    programId: encodeBase58(new Uint8Array(32).fill(index + 1))
  }));
  let called = false;
  await assert.rejects(
    fetchProgramAccountIdentityEvidence(instructions, async () => {
      called = true;
      throw new Error("RPC must not be called for an oversized program set");
    }),
    /50-program RPC snapshot limit/
  );
  assert.equal(called, false);
});

test("program identity evidence resolves upgrade authority and hashes finalized deployed code", async () => {
  const programId = encodeBase58(new Uint8Array(32).fill(31));
  const programDataAddress = encodeBase58(new Uint8Array(32).fill(77));
  const authority = encodeBase58(new Uint8Array(32).fill(88));
  const loaderOwner = "BPFLoaderUpgradeab1e11111111111111111111111";
  const programState = Buffer.alloc(36);
  programState.writeUInt32LE(2, 0);
  Buffer.from(decodeBase58(programDataAddress)).copy(programState, 4);
  const elf = Buffer.alloc(64, 0);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  elf.writeUInt16LE(3, 16);
  elf[18] = 247;
  elf.writeUInt32LE(1, 20);
  elf.writeUInt16LE(64, 52);
  const programDataState = Buffer.alloc(45 + elf.length);
  programDataState.writeUInt32LE(3, 0);
  programDataState.writeBigUInt64LE(1200n, 4);
  programDataState[12] = 1;
  Buffer.from(decodeBase58(authority)).copy(programDataState, 13);
  elf.copy(programDataState, 45);
  const requests = [];
  const evidence = await fetchProgramAccountIdentityEvidence(
    [{ programId }, { programId }],
    async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      const programAccount = {
        owner: loaderOwner, executable: true, space: programState.length,
        data: [programState.toString("base64"), "base64"]
      };
      const programDataAccount = {
        owner: loaderOwner, executable: false, space: programDataState.length,
        data: [programDataState.toString("base64"), "base64"]
      };
      const value = request.params[0].length === 1
        ? [programAccount]
        : [programAccount, programDataAccount];
      return Response.json({ jsonrpc: "2.0", id: request.id, result: {
        context: { slot: requests.length === 1 ? 1234 : 1235 }, value
      } });
    }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "getMultipleAccounts");
  assert.deepEqual(requests[0].params[0], [programId]);
  assert.deepEqual(requests[1].params[0], [programId, programDataAddress]);
  assert.equal(requests[1].params[1].commitment, "finalized");
  assert.equal(evidence.contextSlot, 1234);
  assert.equal(evidence.programDataContextSlot, 1235);
  assert.deepEqual(evidence.programs[0], {
    programId, accountOwner: loaderOwner, loaderType: "upgradeable-bpf-loader",
    executable: true, dataLength: 36, programDataAddress,
    deploymentSlot: "1200", upgradeAuthority: authority, immutable: false,
    deployedCodeLength: elf.length,
    deployedCodeSha256: createHash("sha256").update(elf).digest("hex")
  });
  assert.equal(evidence.semanticInstructionVerification, false);
  assert.equal(
    evidence.verificationScope,
    "finalized-program-identity-and-upgradeable-code-hash-evidence-only"
  );
});

test("reviewed deployment allowlist matches exact code hash and upgrade authority without promoting semantics", () => {
  const programId = encodeBase58(new Uint8Array(32).fill(31));
  const programDataAddress = encodeBase58(new Uint8Array(32).fill(77));
  const authority = encodeBase58(new Uint8Array(32).fill(88));
  const codeHash = "ab".repeat(32);
  const instructionPolicySha256 = "cd".repeat(32);
  const identity = {
    verificationScope: "finalized-program-identity-and-upgradeable-code-hash-evidence-only",
    semanticInstructionVerification: false,
    programs: [{
      programId,
      accountOwner: "BPFLoaderUpgradeab1e11111111111111111111111",
      loaderType: "upgradeable-bpf-loader",
      executable: true,
      dataLength: 36,
      programDataAddress,
      deploymentSlot: "1200",
      upgradeAuthority: authority,
      immutable: false,
      deployedCodeLength: 4096,
      deployedCodeSha256: codeHash
    }]
  };
  const policy = {
    programId,
    loaderType: "upgradeable-bpf-loader",
    deployedCodeSha256: codeHash,
    upgradeAuthority: authority,
    immutable: false,
    policyId: "jupiter-metis-route",
    policyVersion: "v1.0.0",
    instructionPolicySha256
  };
  const result = verifyUpgradeableProgramDeploymentAllowlist(identity, [policy]);
  assert.equal(result.matched, true);
  assert.deepEqual(result.matchedPrograms, [{
    programId,
    policyId: "jupiter-metis-route",
    policyVersion: "v1.0.0",
    instructionPolicySha256,
    deployedCodeSha256: codeHash,
    upgradeAuthority: authority,
    immutable: false
  }]);
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.verificationScope, "reviewed-upgradeable-deployment-allowlist-only");
});

test("reviewed deployment allowlist rejects any changed program hash, authority, loader, or missing policy", () => {
  const programId = encodeBase58(new Uint8Array(32).fill(32));
  const programDataAddress = encodeBase58(new Uint8Array(32).fill(78));
  const authority = encodeBase58(new Uint8Array(32).fill(89));
  const codeHash = "12".repeat(32);
  const identity = {
    verificationScope: "finalized-program-identity-and-upgradeable-code-hash-evidence-only",
    semanticInstructionVerification: false,
    programs: [{
      programId,
      accountOwner: "BPFLoaderUpgradeab1e11111111111111111111111",
      loaderType: "upgradeable-bpf-loader",
      executable: true,
      programDataAddress,
      upgradeAuthority: authority,
      immutable: false,
      deployedCodeLength: 1024,
      deployedCodeSha256: codeHash
    }]
  };
  const policy = {
    programId,
    loaderType: "upgradeable-bpf-loader",
    deployedCodeSha256: codeHash,
    upgradeAuthority: authority,
    immutable: false,
    policyId: "router-policy",
    policyVersion: "1.2.3",
    instructionPolicySha256: "34".repeat(32)
  };
  const cases = [
    { identity, allowlist: [{ ...policy, deployedCodeSha256: "56".repeat(32) }] },
    { identity, allowlist: [{ ...policy, upgradeAuthority: encodeBase58(new Uint8Array(32).fill(90)) }] },
    { identity, allowlist: [{ ...policy, loaderType: "native-loader" }] },
    { identity, allowlist: [] },
    { identity: { ...identity, semanticInstructionVerification: true }, allowlist: [policy] }
  ];
  for (const item of cases) {
    assert.throws(
      () => verifyUpgradeableProgramDeploymentAllowlist(item.identity, item.allowlist),
      /does not match the reviewed allowlist|allowlist is incomplete|malformed or duplicated/
    );
  }
});

test("reviewed deployment allowlist rejects duplicate and malformed policy entries", () => {
  const programId = encodeBase58(new Uint8Array(32).fill(33));
  const policy = {
    programId,
    loaderType: "upgradeable-bpf-loader",
    deployedCodeSha256: "ab".repeat(32),
    upgradeAuthority: null,
    immutable: true,
    policyId: "router-policy",
    policyVersion: "1.0.0",
    instructionPolicySha256: "cd".repeat(32)
  };
  const identity = {
    verificationScope: "finalized-program-identity-and-upgradeable-code-hash-evidence-only",
    semanticInstructionVerification: false,
    programs: [{
      programId,
      loaderType: "upgradeable-bpf-loader",
      executable: true,
      programDataAddress: encodeBase58(new Uint8Array(32).fill(80)),
      upgradeAuthority: null,
      immutable: true,
      deployedCodeLength: 128,
      deployedCodeSha256: policy.deployedCodeSha256
    }]
  };
  assert.throws(
    () => verifyUpgradeableProgramDeploymentAllowlist(identity, [policy, policy]),
    /malformed or duplicated/
  );
  assert.throws(
    () => verifyUpgradeableProgramDeploymentAllowlist(identity, [{ ...policy, instructionPolicySha256: "not-a-hash" }]),
    /malformed or duplicated/
  );
});

test("native program identity allowlist accepts only reviewed built-ins without semantic approval", () => {
  const nativeOwner = "NativeLoader1111111111111111111111111111111";
  const identity = {
    verificationScope: "finalized-program-identity-and-upgradeable-code-hash-evidence-only",
    semanticInstructionVerification: false,
    programs: [
      {
        programId: "11111111111111111111111111111111",
        accountOwner: nativeOwner,
        loaderType: "native-loader",
        executable: true,
        dataLength: 0
      },
      {
        programId: "ComputeBudget111111111111111111111111111111",
        accountOwner: nativeOwner,
        loaderType: "native-loader",
        executable: true,
        dataLength: 0
      }
    ]
  };
  const result = verifyReviewedNativeProgramIdentities(identity);
  assert.equal(result.matched, true);
  assert.deepEqual(result.matchedPrograms, [
    { programId: "11111111111111111111111111111111", policyId: "solana-system-program" },
    { programId: "ComputeBudget111111111111111111111111111111", policyId: "solana-compute-budget" }
  ]);
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.verificationScope, "reviewed-native-program-identity-only");

  const unknown = encodeBase58(new Uint8Array(32).fill(111));
  assert.throws(() => verifyReviewedNativeProgramIdentities({
    ...identity, programs: [{ ...identity.programs[0], programId: unknown }]
  }), /not in the code-reviewed identity allowlist/);
  assert.throws(() => verifyReviewedNativeProgramIdentities({
    ...identity, programs: [{ ...identity.programs[0], accountOwner: "BPFLoaderUpgradeab1e11111111111111111111111" }]
  }), /malformed or unsupported/);
  assert.throws(() => verifyReviewedNativeProgramIdentities({
    ...identity, programs: [{ ...identity.programs[0], dataLength: 1 }]
  }), /malformed or unsupported/);
});

test("complete outer-program identity requires an exact reviewed set and never approves semantics", () => {
  const nativeOwner = "NativeLoader1111111111111111111111111111111";
  const system = {
    programId: "11111111111111111111111111111111",
    accountOwner: nativeOwner, loaderType: "native-loader",
    executable: true, dataLength: 0
  };
  const compute = {
    programId: "ComputeBudget111111111111111111111111111111",
    accountOwner: nativeOwner, loaderType: "native-loader",
    executable: true, dataLength: 0
  };
  const evidence = {
    verificationScope: "finalized-program-identity-and-upgradeable-code-hash-evidence-only",
    semanticInstructionVerification: false,
    programs: [system, compute]
  };
  const outer = [{ programId: system.programId }, { programId: compute.programId }];
  const result = verifyCompleteOuterProgramIdentity({
    outerInstructionEvidence: outer,
    programIdentityEvidence: evidence
  });
  assert.equal(result.matched, true);
  assert.equal(result.expectedProgramCount, 2);
  assert.deepEqual(result.matchedPrograms.map(item => item.programId),
    [system.programId, compute.programId]);
  assert.equal(result.semanticInstructionVerification, false);
  assert.equal(result.verificationScope, "complete-outer-program-deployment-identity-only");

  // Provider-supplied claims must never upgrade identity evidence into
  // semantic approval, even if an untrusted evidence object says "true".
  assert.throws(() => verifyCompleteOuterProgramIdentity({
    outerInstructionEvidence: outer,
    programIdentityEvidence: {
      ...evidence,
      semanticInstructionVerification: true,
      verificationScope: "semantically-verified"
    }
  }), /Finalized native program identity evidence is incomplete/);

  assert.throws(() => verifyCompleteOuterProgramIdentity({
    outerInstructionEvidence: outer,
    programIdentityEvidence: { ...evidence, programs: [system] }
  }), /does not cover every outer program/);
  assert.throws(() => verifyCompleteOuterProgramIdentity({
    outerInstructionEvidence: outer,
    programIdentityEvidence: { ...evidence, programs: [system, {
      ...compute, programId: encodeBase58(new Uint8Array(32).fill(112))
    }] }
  }), /missing or unexpected programs/);
  assert.throws(() => verifyCompleteOuterProgramIdentity({
    outerInstructionEvidence: [...outer, { programId: system.programId }],
    programIdentityEvidence: evidence
  }), /duplicates or exceeds its limit/);
  assert.throws(() => verifyCompleteOuterProgramIdentity({
    outerInstructionEvidence: outer,
    programIdentityEvidence: { ...evidence, programs: [system, {
      ...compute, loaderType: "legacy-bpf-loader"
    }] }
  }), /unsupported or unreviewed loader type/);
});

test("System Program decoder accepts only correctly authorized native SOL transfers", () => {
  const destination = encodeBase58(new Uint8Array(32).fill(9));
  const encodeTransfer = (lamports = 12345n) => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(lamports, 4);
    return data.toString("base64");
  };
  const transfer = {
    instructionIndex: 2,
    programId: "11111111111111111111111111111111",
    accounts: [
      { pubkey: BOT_WALLET, isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true }
    ],
    dataBase64: encodeTransfer()
  };
  const decoded = decodeReviewedSystemTransfers([transfer]);
  assert.deepEqual(decoded, [{
    instructionIndex: 2, source: BOT_WALLET, destination,
    lamports: "12345",
    verificationScope: "system-program-transfer-instruction-only"
  }]);
  assert.throws(() => decodeReviewedSystemTransfers([{
    ...transfer, accounts: [transfer.accounts[0]]
  }]), /accounts or data are malformed/);
  assert.throws(() => decodeReviewedSystemTransfers([{
    ...transfer, accounts: [
      { ...transfer.accounts[0], isSigner: false },
      transfer.accounts[1]
    ]
  }]), /account roles are invalid/);
  assert.throws(() => decodeReviewedSystemTransfers([{
    ...transfer, accounts: [
      transfer.accounts[0], { ...transfer.accounts[1], isWritable: false }
    ]
  }]), /account roles are invalid/);
  assert.throws(() => decodeReviewedSystemTransfers([{
    ...transfer, dataBase64: Buffer.from([3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]).toString("base64")
  }]), /only Transfer is reviewed/);
  assert.throws(() => decodeReviewedSystemTransfers([{
    ...transfer, dataBase64: encodeTransfer(0n)
  }]), /amount must be positive/);
  assert.throws(() => decodeReviewedSystemTransfers([{
    ...transfer, accounts: [
      transfer.accounts[0], { ...transfer.accounts[1], pubkey: BOT_WALLET }
    ]
  }]), /account roles are invalid/);
});

test("classic SPL Token decoder accepts only Transfer and TransferChecked with strict roles", () => {
  const source = encodeBase58(new Uint8Array(32).fill(21));
  const mint = encodeBase58(new Uint8Array(32).fill(22));
  const destination = encodeBase58(new Uint8Array(32).fill(23));
  const authority = encodeBase58(new Uint8Array(32).fill(24));
  const transferData = Buffer.alloc(9);
  transferData[0] = 3;
  transferData.writeBigUInt64LE(987654321n, 1);
  const transfer = {
    instructionIndex: 4,
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    accounts: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false }
    ],
    dataBase64: transferData.toString("base64")
  };
  assert.deepEqual(decodeReviewedSplTokenTransfers([transfer]), [{
    instructionIndex: 4, transferType: "transfer", source, destination,
    authority, amount: "987654321",
    verificationScope: "classic-spl-token-transfer-instruction-only"
  }]);

  const checkedData = Buffer.alloc(10);
  checkedData[0] = 12;
  checkedData.writeBigUInt64LE(42n, 1);
  checkedData[9] = 6;
  const checked = {
    ...transfer, instructionIndex: 5,
    accounts: [
      transfer.accounts[0],
      { pubkey: mint, isSigner: false, isWritable: false },
      transfer.accounts[1],
      transfer.accounts[2]
    ],
    dataBase64: checkedData.toString("base64")
  };
  assert.deepEqual(decodeReviewedSplTokenTransfers([checked]), [{
    instructionIndex: 5, transferType: "transfer-checked", source, mint,
    decimals: 6, destination, authority, amount: "42",
    verificationScope: "classic-spl-token-transfer-instruction-only"
  }]);
  assert.throws(() => decodeReviewedSplTokenTransfers([{
    ...transfer, dataBase64: Buffer.from([9, ...transferData.subarray(1)]).toString("base64")
  }]), /only Transfer and TransferChecked are reviewed/);
  assert.throws(() => decodeReviewedSplTokenTransfers([{
    ...transfer, programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  }]), /Token-2022 instructions are unsupported/);
  assert.throws(() => decodeReviewedSplTokenTransfers([{
    ...transfer, accounts: [
      { ...transfer.accounts[0], isWritable: false },
      transfer.accounts[1], transfer.accounts[2]
    ]
  }]), /account roles are invalid/);
  assert.throws(() => decodeReviewedSplTokenTransfers([{
    ...transfer, accounts: [
      transfer.accounts[0], transfer.accounts[1],
      { ...transfer.accounts[2], isSigner: false }
    ]
  }]), /account roles are invalid/);
  assert.throws(() => decodeReviewedSplTokenTransfers([{
    ...transfer, dataBase64: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64")
  }]), /amount must be positive/);
  assert.throws(() => decodeReviewedSplTokenTransfers([{
    ...checked, accounts: checked.accounts.slice(0, 3)
  }]), /invalid data or account length/);
});

test("compute-budget verifier decodes bounded legacy/v0 fees with ceiling rounding", () => {
  const programId = "ComputeBudget111111111111111111111111111111";
  const instruction = (variant, value, width = 4) => {
    const payload = Buffer.alloc(1 + width);
    payload[0] = variant;
    if (width === 4) payload.writeUInt32LE(value, 1);
    else payload.writeBigUInt64LE(BigInt(value), 1);
    return { programId, accounts: [], dataBase64: payload.toString("base64") };
  };
  const evidence = [
    instruction(2, 200000),
    instruction(3, 6, 8),
    instruction(1, 65536),
    instruction(4, 1048576)
  ];
  const result = verifyComputeBudgetPriorityFee({
    messageVersion: 0,
    outerInstructionEvidence: evidence,
    maxPriorityFeeLamports: "2"
  });
  assert.equal(result.verified, true);
  assert.equal(result.computeUnitLimit, 200000);
  assert.equal(result.computeUnitPriceMicroLamports, "6");
  assert.equal(result.priorityFeeLamports, "2");
  assert.equal(result.requestedHeapFrameBytes, 65536);
  assert.equal(result.loadedAccountsDataSizeLimit, 1048576);
  assert.throws(() => verifyComputeBudgetPriorityFee({
    messageVersion: 0,
    outerInstructionEvidence: evidence,
    maxPriorityFeeLamports: "1"
  }), /exceeds the configured maximum/);
});

test("compute-budget verifier rejects duplicate, malformed, unknown, and unbounded instructions", () => {
  const programId = "ComputeBudget111111111111111111111111111111";
  const make = (variant, value, width = 4, accounts = []) => {
    const bytes = Buffer.alloc(1 + width);
    bytes[0] = variant;
    if (width === 4) bytes.writeUInt32LE(value, 1);
    else bytes.writeBigUInt64LE(BigInt(value), 1);
    return { programId, accounts, dataBase64: bytes.toString("base64") };
  };
  const limit = make(2, 200000);
  const price = make(3, 10, 8);
  const cap = { messageVersion: "legacy", maxPriorityFeeLamports: "10" };
  assert.throws(() => verifyComputeBudgetPriorityFee({
    ...cap, outerInstructionEvidence: [limit, limit, price]
  }), /Duplicate Compute Budget/);
  assert.throws(() => verifyComputeBudgetPriorityFee({
    ...cap, outerInstructionEvidence: [price]
  }), /must explicitly set/);
  assert.throws(() => verifyComputeBudgetPriorityFee({
    ...cap, outerInstructionEvidence: [limit, make(9, 0)]
  }), /Unsupported Compute Budget/);
  assert.throws(() => verifyComputeBudgetPriorityFee({
    ...cap, outerInstructionEvidence: [make(1, 1000), limit]
  }), /RequestHeapFrame value/);
  assert.throws(() => verifyComputeBudgetPriorityFee({
    ...cap, outerInstructionEvidence: [{ ...limit, accounts: [{ pubkey: BOT_WALLET, isSigner: false, isWritable: false }] }]
  }), /accounts or data are malformed/);
  assert.throws(() => verifyComputeBudgetPriorityFee({
    ...cap, outerInstructionEvidence: [limit], maxPriorityFeeLamports: "not-a-number"
  }), /Priority fee cap/);
});

test("v1 priority fee is read as absolute lamports from message config and bounded", () => {
  const original = Buffer.from(validUnsignedV1Transaction(), "base64");
  const fee = Buffer.alloc(8);
  fee.writeBigUInt64LE(12n, 0);
  const withFee = Buffer.concat([
    original.subarray(0, 106),
    fee,
    original.subarray(106)
  ]);
  withFee[4] |= 0x03; // both priority-fee config bits
  const parsed = validateUnsignedJupiterTransaction(withFee.toString("base64"), BOT_WALLET);
  assert.equal(parsed.priorityFeeLamports, "12");
  assert.equal(parsed.computeUnitLimit, 20000);
  const result = verifyComputeBudgetPriorityFee({
    messageVersion: parsed.messageVersion,
    computeUnitLimit: parsed.computeUnitLimit,
    priorityFeeLamports: parsed.priorityFeeLamports,
    outerInstructionEvidence: [],
    maxPriorityFeeLamports: "12"
  });
  assert.equal(result.priorityFeeLamports, "12");
  assert.equal(result.computeUnitPriceMicroLamports, "0");
  assert.throws(() => verifyComputeBudgetPriorityFee({
    messageVersion: parsed.messageVersion,
    computeUnitLimit: parsed.computeUnitLimit,
    priorityFeeLamports: parsed.priorityFeeLamports,
    outerInstructionEvidence: [],
    maxPriorityFeeLamports: "11"
  }), /exceeds the configured maximum/);
  assert.throws(() => verifyComputeBudgetPriorityFee({
    messageVersion: 1,
    computeUnitLimit: parsed.computeUnitLimit,
    priorityFeeLamports: parsed.priorityFeeLamports,
    outerInstructionEvidence: [{
      programId: "ComputeBudget111111111111111111111111111111",
      accounts: [], dataBase64: "AA=="
    }],
    maxPriorityFeeLamports: "12"
  }), /must use message config/);
});

test("upgradeable ProgramData evidence marks a no-authority deployment immutable", async () => {
  const programId = encodeBase58(new Uint8Array(32).fill(37));
  const programDataAddress = encodeBase58(new Uint8Array(32).fill(79));
  const loaderOwner = "BPFLoaderUpgradeab1e11111111111111111111111";
  const programState = Buffer.alloc(36);
  programState.writeUInt32LE(2, 0);
  Buffer.from(decodeBase58(programDataAddress)).copy(programState, 4);
  const immutableElf = Buffer.alloc(64, 0);
  immutableElf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  immutableElf.writeUInt16LE(3, 16);
  immutableElf[18] = 247;
  immutableElf.writeUInt32LE(1, 20);
  immutableElf.writeUInt16LE(64, 52);
  const programDataState = Buffer.alloc(13 + immutableElf.length);
  programDataState.writeUInt32LE(3, 0);
  programDataState.writeBigUInt64LE(1199n, 4);
  programDataState[12] = 0;
  immutableElf.copy(programDataState, 13);
  let calls = 0;
  const evidence = await fetchProgramAccountIdentityEvidence(
    [{ programId }],
    async (_url, options) => {
      const request = JSON.parse(options.body);
      calls++;
      const program = {
        owner: loaderOwner, executable: true, space: 36,
        data: [programState.toString("base64"), "base64"]
      };
      const programData = {
        owner: loaderOwner, executable: false, space: programDataState.length,
        data: [programDataState.toString("base64"), "base64"]
      };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: {
        context: { slot: 1500 + calls },
        value: calls === 1 ? [program] : [program, programData]
      } });
    }
  );
  assert.equal(evidence.programs[0].upgradeAuthority, null);
  assert.equal(evidence.programs[0].immutable, true);
  assert.equal(evidence.programs[0].deploymentSlot, "1199");
});

test("upgradeable ProgramData evidence fails closed on bad owner, state tag, or changed pointer", async () => {
  const programId = encodeBase58(new Uint8Array(32).fill(35));
  const programDataAddress = encodeBase58(new Uint8Array(32).fill(75));
  const changedAddress = encodeBase58(new Uint8Array(32).fill(76));
  const loaderOwner = "BPFLoaderUpgradeab1e11111111111111111111111";
  const makeProgram = address => {
    const data = Buffer.alloc(36);
    data.writeUInt32LE(2, 0);
    Buffer.from(decodeBase58(address)).copy(data, 4);
    return {
      owner: loaderOwner, executable: true, space: data.length,
      data: [data.toString("base64"), "base64"]
    };
  };
  const makeProgramData = ({ owner = loaderOwner, tag = 3, authorityOption = 0, elfType = 3 } = {}) => {
    const data = Buffer.alloc(77);
    data.writeUInt32LE(tag, 0);
    data.writeBigUInt64LE(1200n, 4);
    data[12] = authorityOption;
    data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 13);
    data.writeUInt16LE(elfType, 29);
    data[31] = 247;
    data.writeUInt32LE(1, 33);
    data.writeUInt16LE(64, 65);
    return {
      owner, executable: false, space: data.length,
      data: [data.toString("base64"), "base64"]
    };
  };
  for (const badData of [
    null,
    makeProgramData({ owner: encodeBase58(new Uint8Array(32).fill(90)) }),
    makeProgramData({ tag: 9 }),
    makeProgramData({ authorityOption: 2 }),
    makeProgramData({ elfType: 2 })
  ]) {
    let calls = 0;
    await assert.rejects(() => fetchProgramAccountIdentityEvidence(
      [{ programId }],
      async (_url, options) => {
        const request = JSON.parse(options.body);
        calls++;
        const value = calls === 1
          ? [makeProgram(programDataAddress)]
          : [makeProgram(programDataAddress), badData];
        return Response.json({ jsonrpc: "2.0", id: request.id, result: {
          context: { slot: 1300 + calls }, value
        } });
      }
    ), /ProgramData account is missing or has invalid owner or encoding|ProgramData account has an invalid state tag|ProgramData upgrade authority option is malformed|not a valid Solana SBF ELF64 payload/);
  }

  let calls = 0;
  await assert.rejects(() => fetchProgramAccountIdentityEvidence(
    [{ programId }],
    async (_url, options) => {
      const request = JSON.parse(options.body);
      calls++;
      const refreshedAddress = calls === 1 ? programDataAddress : changedAddress;
      const value = calls === 1
        ? [makeProgram(programDataAddress)]
        : [makeProgram(refreshedAddress), makeProgramData()];
      return Response.json({ jsonrpc: "2.0", id: request.id, result: {
        context: { slot: 1400 + calls }, value
      } });
    }
  ), /ProgramData pointer or account size changed during resolution/);
});

test("program identity evidence rejects non-executable or malformed program accounts", async () => {
  const programId = encodeBase58(new Uint8Array(32).fill(41));
  const loaderOwner = "BPFLoaderUpgradeab1e11111111111111111111111";
  await assert.rejects(() => fetchProgramAccountIdentityEvidence(
    [{ programId }],
    async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 1235 },
      value: [{
        owner: loaderOwner, executable: false, space: 0,
        data: ["", "base64"]
      }]
    } })
  ), /missing, non-executable, or has malformed identity data/);

  await assert.rejects(() => fetchProgramAccountIdentityEvidence(
    [{ programId }],
    async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 1235 },
      value: [{
        owner: loaderOwner, executable: true, space: 2,
        data: [Buffer.from([1]).toString("base64"), "base64"]
      }]
    } })
  ), /data size does not match RPC metadata/);
});


test("program identity evidence rejects executable accounts owned by unknown loaders", async () => {
  const programId = encodeBase58(new Uint8Array(32).fill(61));
  const unknownOwner = encodeBase58(new Uint8Array(32).fill(62));
  await assert.rejects(() => fetchProgramAccountIdentityEvidence(
    [{ programId }],
    async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 1237 },
      value: [{
        owner: unknownOwner, executable: true, space: 0,
        data: ["", "base64"]
      }]
    } })
  ), /missing, non-executable, or has malformed identity data/);
});

test("program identity evidence rejects non-canonical base64 even when decoded size matches", async () => {
  const programId = encodeBase58(new Uint8Array(32).fill(51));
  const loaderOwner = "BPFLoaderUpgradeab1e11111111111111111111111";
  await assert.rejects(() => fetchProgramAccountIdentityEvidence(
    [{ programId }],
    async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 1236 },
      value: [{
        owner: loaderOwner, executable: true, space: 1,
        // AB== decodes permissively to one byte, but its padding bits are non-canonical.
        data: ["AB==", "base64"]
      }]
    } })
  ), /not valid canonical base64/);
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
            message: { accountKeys: [BOT_WALLET, encodeBase58(new Uint8Array(32).fill(21)), encodeBase58(new Uint8Array(32).fill(22))], instructions: [{ programIdIndex: 1, accounts: [0, 1], data: "1" }] }
          },
          meta: {
            innerInstructions: [],
            err: null,
            fee: 5000,
            preBalances: [100_000_000, 1, 1],
            postBalances: [89_995_000, 1, 1],
            preTokenBalances: [{
              accountIndex: 1,
              mint: "So11111111111111111111111111111111111111112",
              owner: BOT_WALLET, uiTokenAmount: { amount: "10000000", decimals: 9 }
            }, {
              accountIndex: 2,
              mint: outputMint, owner: BOT_WALLET,
              uiTokenAmount: { amount: "0", decimals: 6 }
            }],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: "So11111111111111111111111111111111111111112",
                owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 9 }
              },
              {
                accountIndex: 2,
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
    outputAmount: "12345",
    expectedOwner: BOT_WALLET
  }, fetchImpl);
  assert.equal(proof.verified, true);
  assert.equal(proof.confirmationStatus, "finalized");
  assert.equal(proof.slot, 123);

  for (const corrupt of [
    result => result.meta.postTokenBalances.push({ ...result.meta.postTokenBalances[0] }),
    result => { result.meta.postTokenBalances[1].uiTokenAmount.decimals = 7; },
    result => { result.meta.postTokenBalances[0].accountIndex = 99; },
    // Token-balance rows must refer to a token account, never the wallet fee-payer key.
    result => { result.meta.postTokenBalances[1].accountIndex = 0; }
  ]) {
    const malformedFetch = async (url, options) => {
      const response = await fetchImpl(url, options);
      const body = await response.json();
      if (JSON.parse(options.body).method === "getTransaction") corrupt(body.result);
      return Response.json(body);
    };
    await assert.rejects(() => verifyFinalizedJupiterSettlement({
      signature,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint,
      inputAmount: "10000000",
      outputAmount: "12345",
      expectedOwner: BOT_WALLET
    }, malformedFetch), /malformed or duplicate token balance metadata|inconsistent token decimals/);
  }
});


test("settlement proof resolves finalized address-lookup-table account indexes", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(33));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const loadedInputAccount = encodeBase58(new Uint8Array(32).fill(71));
  const loadedOutputAccount = encodeBase58(new Uint8Array(32).fill(72));
  const loadedProgramAccount = encodeBase58(new Uint8Array(32).fill(73));
  const result = {
    slot: 789,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [BOT_WALLET, encodeBase58(new Uint8Array(32).fill(74))],
        addressTableLookups: [{
          accountKey: encodeBase58(new Uint8Array(32).fill(75)),
          writableIndexes: [0, 1],
          readonlyIndexes: [2]
        }],
        instructions: [{ programIdIndex: 1, accounts: [0, 2, 3], data: "1" }]
      }
    },
    meta: {
      err: null,
      fee: 5000,
      loadedAddresses: { writable: [loadedInputAccount, loadedOutputAccount], readonly: [loadedProgramAccount] },
      innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 4, accounts: [0, 2, 3], data: "1", stackHeight: 2 }]
      }],
      preBalances: [100_000_000, 1, 1, 1, 1],
      postBalances: [89_995_000, 1, 1, 1, 1],
      preTokenBalances: [{
        accountIndex: 2, mint: inputMint, owner: BOT_WALLET,
        uiTokenAmount: { amount: "10000000", decimals: 9 }
      }],
      postTokenBalances: [
        {
          accountIndex: 2, mint: inputMint, owner: BOT_WALLET,
          uiTokenAmount: { amount: "0", decimals: 9 }
        },
        {
          accountIndex: 3, mint: outputMint, owner: BOT_WALLET,
          uiTokenAmount: { amount: "12345", decimals: 6 }
        }
      ]
    }
  };
  const fetchImpl = async (_url, options) => {
    const method = JSON.parse(options.body).method;
    return Response.json({
      jsonrpc: "2.0", id: 1,
      result: method === "getSignatureStatuses"
        ? { value: [{ err: null, confirmationStatus: "finalized" }] }
        : result
    });
  };
  const proof = await verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint,
    inputAmount: "10000000", outputAmount: "12345",
    expectedOwner: BOT_WALLET
  }, fetchImpl);
  assert.equal(proof.verified, true);
  assert.equal(proof.slot, 789);

  for (const corrupt of [
    value => { value.meta.loadedAddresses.writable = "not-an-address-array"; },
    value => { delete value.meta.loadedAddresses; },
    value => {
      value.version = 0;
      delete value.transaction.message.addressTableLookups;
    },
    value => { value.transaction.message.addressTableLookups[0].writableIndexes = "invalid"; },
    value => {
      value.meta.loadedAddresses.writable = Array.from({ length: 255 }, (_, index) =>
        encodeBase58(new Uint8Array(32).fill(index + 1)));
    }
  ]) {
    const malformedFetch = async (_url, options) => {
      const method = JSON.parse(options.body).method;
      const value = structuredClone(result);
      if (method === "getTransaction") corrupt(value);
      return Response.json({
        jsonrpc: "2.0", id: 1,
        result: method === "getSignatureStatuses"
          ? { value: [{ err: null, confirmationStatus: "finalized" }] }
          : value
      });
    };
    await assert.rejects(() => verifyFinalizedJupiterSettlement({
      signature, inputMint, outputMint,
      inputAmount: "10000000", outputAmount: "12345",
      expectedOwner: BOT_WALLET
    }, malformedFetch), /loaded-address metadata is malformed|missing loaded addresses|address-lookup metadata is malformed|missing address-lookup metadata|account key count exceeds/);
  }
});

test("settlement proof rejects absent and malformed finalized CPI execution metadata", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(17));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const owner = BOT_WALLET;
  const accountKeys = [owner, encodeBase58(new Uint8Array(32).fill(61)), encodeBase58(new Uint8Array(32).fill(62))];
  const baseResult = {
    slot: 456,
    transaction: {
      signatures: [signature],
      message: { accountKeys, instructions: [{ programIdIndex: 1, accounts: [0, 1], data: "1" }] }
    },
    meta: {
      err: null, fee: 5000, innerInstructions: [],
      preBalances: [100_000_000, 1, 1], postBalances: [89_995_000, 1, 1],
      preTokenBalances: [
        { accountIndex: 1, mint: inputMint, owner, uiTokenAmount: { amount: "10000000", decimals: 9 } }
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: inputMint, owner, uiTokenAmount: { amount: "0", decimals: 9 } },
        { accountIndex: 2, mint: outputMint, owner, uiTokenAmount: { amount: "12345", decimals: 6 } }
      ]
    }
  };
  const makeFetch = result => async (_url, options) => {
    const method = JSON.parse(options.body).method;
    return Response.json({ jsonrpc: "2.0", id: 1, result: method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] } : result });
  };
  const args = { signature, inputMint, outputMint, inputAmount: "10000000", outputAmount: "12345", expectedOwner: owner };
  const absent = structuredClone(baseResult);
  delete absent.meta.innerInstructions;
  await assert.rejects(() => verifyFinalizedJupiterSettlement(args, makeFetch(absent)), /CPI metadata is missing or malformed/);

  for (const innerInstructions of [
    [{ index: 4, instructions: [{ programIdIndex: 1, accounts: [0], data: "1" }] }],
    [{ index: 0, instructions: [{ programIdIndex: 99, accounts: [0], data: "1" }] }],
    [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [99], data: "1" }] }],
    [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [0], data: "!" }] }],
    [{ index: 0, instructions: [] }],
    [
      { index: 0, instructions: [{ programIdIndex: 1, accounts: [0], data: "1" }] },
      { index: 0, instructions: [{ programIdIndex: 1, accounts: [0], data: "1" }] }
    ],
    [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [0], data: "1", stackHeight: 0 }] }],
    [{ index: 0, instructions: Array.from({ length: 257 }, () => ({ programIdIndex: 1, accounts: [0], data: "1" })) }],
    [{ index: 0, instructions: [{ programIdIndex: 1, accounts: Array(257).fill(0), data: "1" }] }]
  ]) {
    const malformed = structuredClone(baseResult);
    malformed.meta.innerInstructions = innerInstructions;
    await assert.rejects(() => verifyFinalizedJupiterSettlement(args, makeFetch(malformed)), /Finalized CPI metadata/);
  }

  const excessive = structuredClone(baseResult);
  excessive.transaction.message.instructions = Array.from({ length: 5 }, () => ({
    programIdIndex: 1, accounts: [0, 1], data: "1"
  }));
  excessive.meta.innerInstructions = Array.from({ length: 5 }, (_, index) => ({
    index,
    instructions: Array.from({ length: 205 }, () => ({
      programIdIndex: 1, accounts: [0], data: "1", stackHeight: 1
    }))
  }));
  await assert.rejects(() => verifyFinalizedJupiterSettlement(args, makeFetch(excessive)), /CPI metadata exceeds the supported instruction limit/);

  for (const instructions of [
    [{ programIdIndex: 99, accounts: [0], data: "1" }],
    [{ programIdIndex: 1, accounts: [99], data: "1" }],
    [{ programIdIndex: 1, accounts: [0], data: "!" }],
    [{}]
  ]) {
    const malformedOuter = structuredClone(baseResult);
    malformedOuter.transaction.message.instructions = instructions;
    await assert.rejects(
      () => verifyFinalizedJupiterSettlement(args, makeFetch(malformedOuter)),
      /Finalized outer instruction metadata/
    );
  }
});

test("settlement proof requires the connected Phantom owner explicitly", async () => {
  let rpcCalled = false;
  await assert.rejects(() => verifyFinalizedJupiterSettlement({
    signature: encodeBase58(new Uint8Array(64).fill(7)),
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inputAmount: "10000000",
    outputAmount: "12345"
  }, async () => {
    rpcCalled = true;
    throw new Error("RPC must not run without an explicit wallet owner");
  }), /incomplete or invalid/);
  assert.equal(rpcCalled, false);
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
            message: { accountKeys: ["11111111111111111111111111111111", BOT_WALLET, encodeBase58(new Uint8Array(32).fill(41)), encodeBase58(new Uint8Array(32).fill(42))], instructions: [{ programIdIndex: 0, accounts: [1, 2], data: "1" }] }
          },
          meta: {
            innerInstructions: [],
            err: null, fee: 5000,
            preBalances: [5_000, 100_000_000, 1, 1], postBalances: [0, 89_995_000, 1, 1],
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
      signature, inputMint, outputMint, inputAmount: "10000000", outputAmount: "12345",
      expectedOwner: BOT_WALLET
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
          transaction: { signatures: [signature], message: { accountKeys: [BOT_WALLET, encodeBase58(new Uint8Array(32).fill(31)), encodeBase58(new Uint8Array(32).fill(32))], instructions: [{ programIdIndex: 1, accounts: [0, 1], data: "1" }] } },
          meta: {
            innerInstructions: [],
            err: null, fee: 5000, preBalances: [100_000_000, 1, 1], postBalances: [89_995_000, 1, 1],
            preTokenBalances: [{
              accountIndex: 1,
              mint: "So11111111111111111111111111111111111111112",
              owner: BOT_WALLET, uiTokenAmount: { amount: "10000000", decimals: 9 }
            }],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: "So11111111111111111111111111111111111111112",
                owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 9 }
              },
              {
                accountIndex: 2,
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
    outputAmount: "12345",
    expectedOwner: BOT_WALLET
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
    outputAmount: "12345",
    expectedOwner: BOT_WALLET
  }, fetchImpl), /not successfully finalized/);
});


function validBuildResponse(overrides = {}) {
  return {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inAmount: "1000000",
    outAmount: "250000",
    otherAmountThreshold: "240000",
    swapMode: "ExactIn",
    slippageBps: 100,
    routePlan: [{ percent: 100, bps: 10000, swapInfo: {
      ammKey: "11111111111111111111111111111111",
      label: "untrusted-test-label",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000", outAmount: "250000"
    }}],
    transactionVersion: 0,
    computeBudgetInstructions: [],
    setupInstructions: [],
    swapInstruction: {
      programId: "11111111111111111111111111111111",
      accounts: [],
      data: ""
    },
    cleanupInstruction: null,
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: {},
    blockhashWithMetadata: { blockhash: new Array(32).fill(1), lastValidBlockHeight: 123456 },
    ...overrides
  };
}

test("Jupiter /build response envelope is structurally validated without semantic trust", () => {
  const parsed = validateJupiterBuildResponse(validBuildResponse(), {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "1000000"
  });
  assert.equal(parsed.transactionVersion, 0);
  assert.equal(parsed.swapInstruction.programId, "11111111111111111111111111111111");
  assert.equal(parsed.semanticInstructionVerification, false);
  assert.equal(parsed.routeVerification, "build-envelope-only");
});

test("Jupiter /build v1 requires inline-account response shape and compute unit price", () => {
  const parsed = validateJupiterBuildResponse(validBuildResponse({
    transactionVersion: 1,
    computeUnitPrice: "12000"
  }));
  assert.equal(parsed.transactionVersion, 1);
  assert.deepEqual(parsed.addressesByLookupTableAddress, {});
  assert.equal(parsed.computeBudgetInstructions.length, 0);
  assert.equal(parsed.semanticInstructionVerification, false);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    transactionVersion: 1,
    computeBudgetInstructions: [{ programId: "11111111111111111111111111111111", accounts: [], data: "" }],
    computeUnitPrice: "12000"
  })), /v1 build response has invalid/);
});

test("Jupiter /build rejects oversized route, instruction, account, and lookup-table collections", () => {
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    routePlan: new Array(65).fill(validBuildResponse().routePlan[0])
  })), /response envelope/);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    otherInstructions: new Array(65).fill(validBuildResponse().swapInstruction)
  })), /response envelope/);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    swapInstruction: {
      ...validBuildResponse().swapInstruction,
      accounts: new Array(257).fill({
        pubkey: "11111111111111111111111111111111",
        isSigner: false, isWritable: false
      })
    }
  })), /instruction is malformed/);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    addressesByLookupTableAddress: Object.fromEntries(
      new Array(65).fill(0).map((_, index) => [
        encodeBase58(new Uint8Array(32).fill(index + 1)),
        []
      ])
    )
  })), /too many lookup tables/);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    addressesByLookupTableAddress: {
      "11111111111111111111111111111111": new Array(257).fill("11111111111111111111111111111111")
    }
  })), /lookup-table addresses are malformed/);
});

test("Jupiter /build rejects token amounts outside the Solana u64 range", () => {
  for (const field of ["inAmount", "outAmount", "otherAmountThreshold"]) {
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
      [field]: "18446744073709551616"
    })), /response envelope/);
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
      [field]: "9".repeat(100000)
    })), /response envelope/);
  }
});


test("Jupiter /build rejects numeric or non-canonical amount values without coercion", () => {
  for (const field of ["inAmount", "outAmount", "otherAmountThreshold"]) {
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
      [field]: 9007199254740992
    })), /response envelope/);
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
      [field]: "01"
    })), /response envelope/);
  }
});

test("Jupiter route-plan amounts must be exact decimal strings", () => {
  for (const field of ["inAmount", "outAmount", "feeAmount"]) {
    const swapInfo = {
      ...validBuildResponse().routePlan[0].swapInfo,
      ...(field === "feeAmount" ? { feeMint: "So11111111111111111111111111111111111111112" } : {}),
      [field]: 9007199254740992
    };
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
      routePlan: [{ ...validBuildResponse().routePlan[0], swapInfo }]
    })), /routePlan\[0\] is malformed/);
  }
});

test("Jupiter /build validates route-plan entries and swap mode", () => {
  const valid = validBuildResponse();
  assert.equal(validateJupiterBuildResponse(valid).routePlan.length, 1);
  for (const routePlan of [
    [{}],
    [{ ...valid.routePlan[0], percent: 101 }],
    [{ ...valid.routePlan[0], swapInfo: { ...valid.routePlan[0].swapInfo, inputMint: "bad" } }],
    [{ ...valid.routePlan[0], swapInfo: { ...valid.routePlan[0].swapInfo, inAmount: "18446744073709551616" } }]
  ]) {
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({ routePlan })),
      /routePlan\[0\] is malformed/);
  }
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({ swapMode: "Unknown" })),
    /response envelope/);
});

test("Jupiter /build rejects sparse route and instruction collections", () => {
  const sparseRoute = new Array(2);
  sparseRoute[0] = validBuildResponse().routePlan[0];
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    routePlan: sparseRoute
  })), /routePlan\[1\] is malformed/);

  const sparseAccounts = new Array(1);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    swapInstruction: {
      ...validBuildResponse().swapInstruction,
      accounts: sparseAccounts
    }
  })), /instruction account is malformed/);

  const sparseInstructionList = new Array(1);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    otherInstructions: sparseInstructionList
  })), /instruction is malformed/);
});

test("Jupiter /build rejects array-shaped blockhash metadata", () => {
  const metadata = [];
  metadata.blockhash = new Array(32).fill(1);
  metadata.lastValidBlockHeight = 123456;
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    blockhashWithMetadata: metadata
  })), /response envelope/);
});

test("Jupiter /build rejects sparse blockhash and lookup-table arrays", () => {
  const sparseBlockhash = new Array(32).fill(1);
  delete sparseBlockhash[7];
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    blockhashWithMetadata: { blockhash: sparseBlockhash, lastValidBlockHeight: 123456 }
  })), /response envelope/);

  const sparseAddresses = new Array(2);
  sparseAddresses[0] = "11111111111111111111111111111111";
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    addressesByLookupTableAddress: {
      "SysvarRent111111111111111111111111111111111": sparseAddresses
    }
  })), /lookup-table addresses are malformed/);
});

test("Jupiter /build bounds aggregate lookup-table address resources", () => {
  const addresses = Array.from({ length: 256 }, (_, index) =>
    encodeBase58(new Uint8Array(32).fill(index + 1)));
  const tables = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [
    encodeBase58(new Uint8Array(32).fill(index + 100)),
    addresses
  ]));
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    addressesByLookupTableAddress: tables
  })), /lookup-table address bundle exceeds aggregate resource limits/);
});

test("Jupiter /build bounds aggregate instruction bundle resources", () => {
  const valid = validBuildResponse();
  const largeDataInstruction = { ...valid.swapInstruction, data: "A".repeat(4100) };
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    otherInstructions: Array.from({ length: 64 }, () => largeDataInstruction)
  })), /aggregate resource limits/);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    otherInstructions: Array.from({ length: 64 }, () => ({
      ...valid.swapInstruction,
      accounts: Array.from({ length: 65 }, () => ({
        pubkey: "11111111111111111111111111111111",
        isSigner: false,
        isWritable: false
      }))
    }))
  })), /aggregate resource limits/);
});

test("Jupiter /build requires basis points on every route-plan step", () => {
  const step = validBuildResponse().routePlan[0];
  for (const routePlan of [
    [{ ...step, bps: undefined }],
    [{ ...step, bps: null }]
  ]) {
    assert.throws(
      () => validateJupiterBuildResponse(validBuildResponse({ routePlan })),
      /routePlan\[0\] is malformed/
    );
  }
});

test("Jupiter /build enforces route split totals and top-level token mints", () => {
  const step = validBuildResponse().routePlan[0];
  const split = [
    { ...step, percent: 50, bps: 5000 },
    { ...step, percent: 50, bps: 5000 }
  ];
  assert.equal(validateJupiterBuildResponse(validBuildResponse({ routePlan: split })).routePlan.length, 2);

  for (const routePlan of [
    [{ ...step, percent: 99 }],
    [
      { ...step, percent: 50, bps: 4000 },
      { ...step, percent: 50, bps: 4000 }
    ],
    [{ ...step, swapInfo: {
      ...step.swapInfo,
      inputMint: "11111111111111111111111111111111"
    }}]
  ]) {
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({ routePlan })),
      /routePlan totals or token mints are inconsistent/);
  }
});

test("Jupiter /build rejects malformed account metadata and unexpected requested amount", () => {
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    swapInstruction: { programId: "11111111111111111111111111111111", accounts: [{
      pubkey: "11111111111111111111111111111111", isSigner: "false", isWritable: false
    }], data: "" }
  })), /instruction account is malformed/);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse(), { amount: "1000001" }),
    /input amount does not match/);
});

test("trusted evidence rejects oversized declared external responses before JSON parsing", async () => {
  await assert.rejects(
    fetchTrustedSolUsdQuote(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(2 * 1024 * 1024 + 1) }
    })),
    /exceeds the .*byte limit/
  );
});

test("trusted evidence rejects oversized streamed external responses", async () => {
  await assert.rejects(
    fetchTrustedSolUsdQuote(async () => new Response(" ".repeat(2 * 1024 * 1024 + 1), {
      status: 200
    })),
    /exceeds the .*byte limit/
  );
});


test("trusted evidence rejects malformed Content-Length instead of parsing provider JSON", async () => {
  await assert.rejects(
    fetchTrustedSolUsdQuote(async () => new Response(
      JSON.stringify({ data: { base: "SOL", currency: "USD", amount: "150" } }),
      { status: 200, headers: { "content-length": "unknown" } }
    )),
    /exceeds the .*byte limit/
  );
});

test("trusted evidence rejects malformed UTF-8 provider responses", async () => {
  await assert.rejects(
    fetchTrustedSolUsdQuote(async () => new Response(
      new Uint8Array([0x7b, 0x22, 0x64, 0x61, 0x74, 0x61, 0x22, 0x3a, 0xff, 0x7d]),
      { status: 200 }
    )),
    /not valid UTF-8/
  );
});


test("legacy, v0 and v1 structural validators bind to a caller-supplied Phantom public key without claiming semantic approval", async () => {
  const phantomPublicKey = encodeBase58(new Uint8Array(32).fill(99));
  const legacy = validateUnsignedJupiterTransaction(
    validUnsignedTransaction(undefined, 0, phantomPublicKey), phantomPublicKey
  );
  assert.equal(legacy.messageVersion, "legacy");
  assert.equal(legacy.semanticInstructionVerification, false);

  const v0 = await validateAndResolveUnsignedJupiterTransaction(
    validUnsignedV0TransactionWithLookup(phantomPublicKey), phantomPublicKey,
    async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 100 }, value: [mockLookupTableAccount()]
    } })
  );
  assert.equal(v0.messageVersion, 0);
  assert.equal(v0.lookupTableResolution, "finalized-resolved");
  assert.equal(v0.semanticInstructionVerification, false);

  const v1 = validateUnsignedJupiterTransaction(
    validUnsignedV1Transaction(phantomPublicKey), phantomPublicKey
  );
  assert.equal(v1.messageVersion, 1);
  assert.equal(v1.semanticInstructionVerification, false);
});


test("upgradeable ProgramData resolution rejects refreshed Program account size mismatches", async () => {
  const programId = encodeBase58(new Uint8Array(32).fill(37));
  const programDataAddress = encodeBase58(new Uint8Array(32).fill(79));
  const loaderOwner = "BPFLoaderUpgradeab1e11111111111111111111111";
  const makeProgram = (spaceDelta = 0) => {
    const data = Buffer.alloc(36);
    data.writeUInt32LE(2, 0);
    Buffer.from(decodeBase58(programDataAddress)).copy(data, 4);
    return {
      owner: loaderOwner,
      executable: true,
      space: data.length + spaceDelta,
      data: [data.toString("base64"), "base64"]
    };
  };
  const elf = Buffer.alloc(64, 0);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  elf.writeUInt16LE(3, 16);
  elf[18] = 247;
  elf.writeUInt32LE(1, 20);
  elf.writeUInt16LE(64, 52);
  const programDataState = Buffer.alloc(13 + elf.length);
  programDataState.writeUInt32LE(3, 0);
  programDataState.writeBigUInt64LE(1200n, 4);
  programDataState[12] = 0;
  elf.copy(programDataState, 13);
  const programData = {
    owner: loaderOwner,
    executable: false,
    space: programDataState.length,
    data: [programDataState.toString("base64"), "base64"]
  };
  let calls = 0;
  await assert.rejects(() => fetchProgramAccountIdentityEvidence(
    [{ programId }],
    async (_url, options) => {
      const request = JSON.parse(options.body);
      calls++;
      const value = calls === 1
        ? [makeProgram()]
        : [makeProgram(1), programData];
      return Response.json({ jsonrpc: "2.0", id: request.id, result: {
        context: { slot: 1500 + calls }, value
      } });
    }
  ), /ProgramData pointer or account size changed during resolution/);
});


test("priority-fee verifier rejects malformed outer evidence even for v1 message config", () => {
  const valid = {
    programId: "11111111111111111111111111111111",
    accounts: [],
    dataBase64: ""
  };
  const args = { messageVersion: 1, computeUnitLimit: 200000,
    priorityFeeLamports: "1", maxPriorityFeeLamports: "2" };
  assert.equal(verifyComputeBudgetPriorityFee({ ...args, outerInstructionEvidence: [valid] }).verified, true);
  for (const invalid of [
    null,
    { ...valid, programId: "not-a-public-key" },
    { programId: valid.programId, dataBase64: "" },
    { ...valid, dataBase64: "!!!!" },
    { ...valid, accounts: [{ pubkey: valid.programId, isSigner: "false", isWritable: false }] }
  ]) {
    assert.throws(() => verifyComputeBudgetPriorityFee({
      ...args, outerInstructionEvidence: [invalid]
    }), /Outer instruction/);
  }
});
