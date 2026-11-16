import test from "node:test";
import assert from "node:assert/strict";
import { fetchTrustedSolUsdQuote, fetchTrustedTokenRisk, fetchTrustedLiveEvidence, validateJupiterBuildResponse, validateUnsignedJupiterTransaction, resolveJupiterAddressLookupTables, validateAndResolveUnsignedJupiterTransaction, verifyFinalizedJupiterSettlement } from "../trusted-live-evidence.mjs";

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

test("v1 transaction enforces the currently active 64-address limit", () => {
  for (const addressCount of [65, 96]) {
    const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
    // SIMD-0596 is still a draft without a feature gate; 96 is not active.
    bytes[41] = addressCount;
    assert.throws(
      () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
      /instruction or address count is invalid/
    );
  }
});

test("v1 transaction rejects instruction account indexes outside the inline address table", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  // The fixture has two inline addresses (indexes 0 and 1); index 2 is invalid.
  bytes[118] = 2;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /V1 Jupiter instruction account index is invalid/
  );
});

test("v1 parser retains instruction program, ordered accounts, privileges, and raw data", () => {
  const parsed = validateUnsignedJupiterTransaction(validUnsignedV1Transaction(), BOT_WALLET);
  assert.equal(parsed.messageVersion, 1);
  assert.equal(parsed.instructionCount, 1);
  assert.equal(parsed.instructions.length, 1);
  assert.equal(parsed.instructions[0].programIdIndex, 1);
  assert.equal(parsed.instructions[0].programId, encodeBase58(new Uint8Array(32).fill(17)));
  assert.deepEqual(parsed.instructions[0].accountIndexes, [0]);
  assert.deepEqual(parsed.instructions[0].accounts, [{
    index: 0, address: BOT_WALLET, isSigner: true, isWritable: true
  }]);
  assert.equal(parsed.instructions[0].dataBase64, "AA==");
  assert.equal(parsed.semanticInstructionVerification, false);
  assert.equal(parsed.routeVerification, undefined);
});

test("legacy parser retains compiled instruction structure but never semantically trusts it", () => {
  const parsed = validateUnsignedJupiterTransaction(validUnsignedTransaction(), BOT_WALLET);
  assert.equal(parsed.instructions.length, 1);
  assert.equal(parsed.instructions[0].programIdIndex, 1);
  assert.equal(parsed.instructions[0].programId, encodeBase58(new Uint8Array(32)));
  assert.deepEqual(parsed.instructions[0].accountIndexes, [0]);
  assert.deepEqual(parsed.instructions[0].accounts, [{
    index: 0, address: BOT_WALLET, isSigner: true, isWritable: true
  }]);
  assert.equal(parsed.instructions[0].dataBase64, "");
  assert.equal(parsed.semanticInstructionVerification, false);
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
  assert.deepEqual(parsed.instructions[0].accounts, [{
    index: 2,
    address: encodeBase58(new Uint8Array(32).fill(7)),
    isSigner: false,
    isWritable: true
  }]);
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
  assert.equal(parsed.instructions.length, 1);
  assert.equal(parsed.instructions[0].programId, encodeBase58(new Uint8Array(32).fill(17)));
  assert.deepEqual(parsed.instructions[0].accountIndexes, [2]);
  assert.deepEqual(parsed.instructions[0].accounts, [{
    index: 2, address: null, isSigner: false, isWritable: null
  }]);
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
            message: {
              accountKeys: [BOT_WALLET],
              instructions: [{
                programIdIndex: 0,
                accounts: [0],
                data: "1"
              }]
            }
          },
          meta: {
            err: null,
            fee: 5000,
            loadedAddresses: {
              writable: [encodeBase58(new Uint8Array(32).fill(11))],
              readonly: [encodeBase58(new Uint8Array(32).fill(12))]
            },
            innerInstructions: [{
              index: 0,
              instructions: [{
                programIdIndex: 1,
                accounts: [0, 2],
                data: "2",
                stackHeight: 2
              }]
            }],
            preBalances: [100_000_000, 1, 2],
            postBalances: [89_995_000, 1, 2],
            preTokenBalances: [{ accountIndex: 0, mint: "So11111111111111111111111111111111111111112",
              owner: BOT_WALLET, uiTokenAmount: { amount: "10000000", decimals: 9 }
            }],
            postTokenBalances: [
              { accountIndex: 0, mint: "So11111111111111111111111111111111111111112",
                owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 9 }
              },
              { accountIndex: 0, mint: outputMint, owner: BOT_WALLET,
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
  assert.equal(proof.outerInstructionsRecorded, true);
  assert.deepEqual(proof.outerInstructionEvidence, [{
    programIdIndex: 0,
    programId: BOT_WALLET,
    accountIndexes: [0],
    accounts: [{ index: 0, address: BOT_WALLET }],
    dataBase58: "1",
    stackHeight: null
  }]);
  assert.equal(proof.innerInstructionsRecorded, true);
  assert.equal(proof.semanticInstructionVerification, false);
  assert.deepEqual(proof.innerInstructionEvidence, [{
    index: 0,
    instructions: [{
      programIdIndex: 1,
      programId: encodeBase58(new Uint8Array(32).fill(11)),
      accountIndexes: [0, 2],
      accounts: [
        { index: 0, address: BOT_WALLET },
        { index: 2, address: encodeBase58(new Uint8Array(32).fill(12)) }
      ],
      dataBase58: "2",
      stackHeight: 2
    }]
  }]);
  // The fixture's native SOL balance delta differs from the wrapped-SOL
  // token input. This verifier proves token settlement only.
  // It must not be mistaken for native SOL fee/rent/tip or all-in cost proof.
  assert.equal(Object.hasOwn(proof, "costs"), false);
  assert.equal(Object.hasOwn(proof, "allInCosts"), false);
  assert.equal(Object.hasOwn(proof, "nativeSolOutflowLamports"), false);
  assert.equal(Object.hasOwn(proof, "totalLamports"), false);
});

test("settlement proof rejects CPI groups that reference a nonexistent outer instruction", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(6));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 126,
          transaction: {
            signatures: [signature],
            message: {
              accountKeys: [BOT_WALLET],
              instructions: [{ programIdIndex: 0, accounts: [0], data: "1" }]
            }
          },
          meta: {
            err: null,
            fee: 5000,
            preBalances: [100_000_000],
            postBalances: [99_995_000],
            innerInstructions: [{
              index: 1,
              instructions: [{
                programIdIndex: 0,
                accounts: [0],
                data: "2",
                stackHeight: 2
              }]
            }]
          }
        };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  await assert.rejects(() => verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "100", outputAmount: "200"
  }, fetchImpl), /invalid parent index or shape/);
});

test("settlement proof marks missing inner-instruction metadata as unavailable, not CPI-free", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(5));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 127,
          transaction: {
            signatures: [signature],
            message: {
              accountKeys: [BOT_WALLET],
              instructions: [{ programIdIndex: 0, accounts: [0], data: "1" }]
            }
          },
          meta: {
            err: null,
            fee: 5000,
            preBalances: [100_000_000],
            postBalances: [99_995_000],
            preTokenBalances: [
              { accountIndex: 0, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "100", decimals: 0 } },
              { accountIndex: 0, mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 0 } }
            ],
            postTokenBalances: [
              { accountIndex: 0, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 0 } },
              { accountIndex: 0, mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "200", decimals: 0 } }
            ]
          }
        };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  const proof = await verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "100", outputAmount: "200"
  }, fetchImpl);
  assert.equal(proof.verified, true);
  assert.equal(proof.innerInstructionsRecorded, false);
  assert.equal(proof.innerInstructionEvidence, null);
  assert.equal(proof.semanticInstructionVerification, false);
});

test("settlement proof rejects duplicate CPI parent instruction groups", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(4));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 128,
          transaction: {
            signatures: [signature],
            message: {
              accountKeys: [BOT_WALLET],
              instructions: [{ programIdIndex: 0, accounts: [0], data: "1" }]
            }
          },
          meta: {
            err: null,
            fee: 5000,
            preBalances: [100_000_000],
            postBalances: [99_995_000],
            innerInstructions: [
              { index: 0, instructions: [] },
              { index: 0, instructions: [] }
            ]
          }
        };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  await assert.rejects(() => verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "100", outputAmount: "200"
  }, fetchImpl), /invalid parent index or shape/);
});

test("settlement proof rejects non-base58 compiled instruction data", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(3));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 129,
          transaction: {
            signatures: [signature],
            message: {
              accountKeys: [BOT_WALLET],
              instructions: [{ programIdIndex: 0, accounts: [0], data: "0" }]
            }
          },
          meta: {
            err: null,
            fee: 5000,
            preBalances: [100_000_000],
            postBalances: [99_995_000],
            innerInstructions: [],
            preTokenBalances: [
              { accountIndex: 0, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "100", decimals: 0 } },
              { accountIndex: 0, mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 0 } }
            ],
            postTokenBalances: [
              { accountIndex: 0, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 0 } },
              { accountIndex: 0, mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "200", decimals: 0 } }
            ]
          }
        };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  await assert.rejects(() => verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "100", outputAmount: "200"
  }, fetchImpl), /invalid compiled account indexes or data/);
});

test("settlement proof rejects incomplete loaded-address balance metadata", async () => {
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
            loadedAddresses: {
              writable: [encodeBase58(new Uint8Array(32).fill(11))],
              readonly: [encodeBase58(new Uint8Array(32).fill(12))]
            },
            preBalances: [100_000_000, 1, 2],
            postBalances: [89_995_000, 1],
            preTokenBalances: [{ accountIndex: 0, mint: "So11111111111111111111111111111111111111112",
              owner: BOT_WALLET, uiTokenAmount: { amount: "10000000", decimals: 9 }
            }],
            postTokenBalances: [
              { accountIndex: 0, mint: "So11111111111111111111111111111111111111112",
                owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 9 }
              },
              { accountIndex: 0, mint: outputMint, owner: BOT_WALLET,
                uiTokenAmount: { amount: "12345", decimals: 6 }
              }
            ]
          }
        };
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, result
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await assert.rejects(
    verifyFinalizedJupiterSettlement({
    signature,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint,
    inputAmount: "10000000",
    outputAmount: "12345"
    }, fetchImpl),
    /loaded-address balance metadata is inconsistent/
  );});

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
            message: { accountKeys: [encodeBase58(new Uint8Array(32).fill(1)), BOT_WALLET, encodeBase58(new Uint8Array(32).fill(2)), encodeBase58(new Uint8Array(32).fill(3))] }
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
            preTokenBalances: [{ accountIndex: 0, mint: "So11111111111111111111111111111111111111112",
              owner: BOT_WALLET, uiTokenAmount: { amount: "10000000", decimals: 9 }
            }],
            postTokenBalances: [
              { accountIndex: 0, mint: "So11111111111111111111111111111111111111112",
                owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 9 }
              },
              { accountIndex: 0, mint: outputMint, owner: BOT_WALLET,
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

test("settlement proof rejects noncanonical or out-of-range owned token balances", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(10));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 130,
          transaction: {
            signatures: [signature],
            message: { accountKeys: [BOT_WALLET] }
          },
          meta: {
            err: null,
            fee: 5000,
            preBalances: [100_000_000],
            postBalances: [99_995_000],
            preTokenBalances: [
              { accountIndex: 0, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "100", decimals: 0 } },
              { accountIndex: 0, mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 0 } }
            ],
            postTokenBalances: [
              { accountIndex: 0, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 0 } },
              { accountIndex: 0, mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "01", decimals: 0 } }
            ]
          }
        };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  await assert.rejects(() => verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "100", outputAmount: "1"
  }, fetchImpl), /invalid owned token balance/);
});

test("settlement proof rejects duplicate and out-of-range owned token account indexes", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(13));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const inputAccount = encodeBase58(new Uint8Array(32).fill(21));
  const outputAccount = encodeBase58(new Uint8Array(32).fill(22));
  const base = {
    slot: 131,
    transaction: {
      signatures: [signature],
      message: { accountKeys: [BOT_WALLET, inputAccount, outputAccount] }
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [100_000_000, 1, 1],
      postBalances: [99_995_000, 1, 1],
      preTokenBalances: [
        { accountIndex: 1, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "100", decimals: 0 } },
        { accountIndex: 2, mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 0 } }
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 0 } },
        { accountIndex: 2, mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "200", decimals: 0 } }
      ]
    }
  };
  for (const [label, mutate] of [
    ["duplicate", rows => rows.push({ ...rows[1], uiTokenAmount: { amount: "0", decimals: 0 } })],
    ["out-of-range", rows => { rows[1].accountIndex = 3; }]
  ]) {
    const result = structuredClone(base);
    mutate(result.meta.postTokenBalances);
    const fetchImpl = async (_url, options) => {
      const { method } = JSON.parse(options.body);
      const payload = method === "getSignatureStatuses"
        ? { value: [{ err: null, confirmationStatus: "finalized" }] }
        : result;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    };
    await assert.rejects(() => verifyFinalizedJupiterSettlement({
      signature, inputMint, outputMint, inputAmount: "100", outputAmount: "200"
    }, fetchImpl), label === "duplicate" ? /duplicate owned token account indexes/ : /invalid or duplicate owned token account indexes/);
  }
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


test("production trusted evidence integration never claims semantic trust or all-in costs", async () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const solMint = "So11111111111111111111111111111111111111112";
  const owner = "11111111111111111111111111111111";
  const mockFetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("coinbase.com/v2/prices/SOL-USD/spot")) {
      return Response.json({ data: { base: "SOL", currency: "USD", amount: "150" } });
    }
    if (value.includes("dexscreener.com/latest/dex/tokens/")) {
      return Response.json({ pairs: [{
        chainId: "solana", baseToken: { address: mint },
        liquidity: { usd: 50000 }, volume: { h24: 5000 },
        priceUsd: "1", txns: { h24: { sells: 20 } }
      }] });
    }
    if (value.includes("rugcheck.xyz/v1/tokens/")) {
      return Response.json({ score: 100 });
    }
    if (value.includes("api.jup.ag/swap/v2/order")) {
      const params = new URL(value).searchParams;
      assert.equal(params.has("taker"), false);
      assert.equal(params.get("inputMint"), mint);
      assert.equal(params.get("outputMint"), solMint);
      return Response.json({
        requestId: "integration-quote-only",
        transaction: null,
        inputMint: mint,
        outputMint: solMint,
        inAmount: params.get("amount"),
        outAmount: "1000000",
        routePlan: [{ swapInfo: { label: "mock-route" } }]
      });
    }
    const request = JSON.parse(options.body);
    if (value.includes("solana-mainnet.g.alchemy.com")) {
      assert.equal(request.method, "getTokenAccounts");
      assert.equal(request.params.mintAddress, mint);
      return Response.json({
        jsonrpc: "2.0", id: request.id,
        result: { token_accounts: [{
          address: "TokenAccountAddress111111111111111111111",
          mint, owner, amount: "1001"
        }], errors: [] }
      });
    }
    if (request.method === "getAccountInfo") {
      return Response.json({
        jsonrpc: "2.0", id: request.id,
        result: { value: {
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } }
        } }
      });
    }
    if (request.method === "getTokenSupply") {
      return Response.json({
        jsonrpc: "2.0", id: request.id,
        result: { value: { amount: "1001", decimals: 0 } }
      });
    }
    throw new Error("Unexpected integration mock request: " + value);
  };

  const evidence = await fetchTrustedLiveEvidence(
    mint, mockFetch, "test-alchemy-api-key-123456", "test-jupiter-api-key-123456"
  );

  assert.equal(evidence.quote.provider, "Coinbase");
  assert.equal(evidence.quote.pair, "SOL/USD");
  assert.equal(evidence.risk.mint, mint);
  assert.equal(evidence.risk.sellRoute.semanticInstructionVerification, false);
  assert.equal(evidence.risk.sellRoute.routeVerification, "quote-only-no-transaction");
  assert.equal(evidence.risk.checks.sellRouteAvailable, false);
  assert.equal(evidence.risk.passed, false);
  assert.equal(evidence.passed, false);
  assert.equal(Object.hasOwn(evidence, "costs"), false);
});
