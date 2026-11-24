import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseSupportedInstructionMessage } from "../transaction-instruction-parser.mjs";
import { normalizeSimulationObservation, resolveSimulationCpiIndexesAgainstTrustedMessage } from "../simulation-observation.mjs";
import { fetchTrustedSolUsdQuote, fetchTrustedTokenRisk, fetchTrustedLiveEvidence, validateJupiterBuildResponse, validateUnsignedJupiterTransaction, resolveJupiterAddressLookupTables, resolveExecutableProgramAccounts, validateAndResolveUnsignedJupiterTransaction, verifyFinalizedJupiterSettlement, parseTrustedMintAccount } from "../trusted-live-evidence.mjs";

const BOT_WALLET = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
test("raw mint account parsing requires bounded canonical base64 encoding", () => {
  const classic = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const token2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const baseMint = Buffer.alloc(82).toString("base64");

  assert.deepEqual(parseTrustedMintAccount({
    value: { owner: classic, data: [baseMint, "base64"] }
  }), {
    mintAuthoritySafe: true,
    freezeAuthoritySafe: true,
    token2022ExtensionsSafe: true
  });
  assert.deepEqual(parseTrustedMintAccount({
    value: { owner: token2022, data: [baseMint, "base64"] }
  }), {
    mintAuthoritySafe: true,
    freezeAuthoritySafe: true,
    token2022ExtensionsSafe: true
  });

  for (const data of [
    [baseMint, "base64url"],
    [baseMint + " ", "base64"],
    [baseMint.slice(0, -2) + "B=", "base64"],
    [baseMint, "base64", "unexpected"],
    ["A".repeat(17000), "base64"]
  ]) {
    assert.throws(() => parseTrustedMintAccount({
      value: { owner: classic, data }
    }), /encoding|canonical/);
  }

  const accessorBacked = [baseMint, "base64"];
  let getterCalls = 0;
  Object.defineProperty(accessorBacked, "0", {
    get() { getterCalls++; return baseMint; }
  });
  assert.throws(() => parseTrustedMintAccount({
    value: { owner: classic, data: accessorBacked }
  }), /encoding/);
  assert.equal(getterCalls, 0);
});

test("parsed mint evidence requires explicit authority fields and safe extension metadata", () => {
  const classic = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const token2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const parsed = (owner, info) => ({
    value: { owner, data: { parsed: { type: "mint", info } } }
  });

  assert.deepEqual(parseTrustedMintAccount(parsed(classic, {
    mintAuthority: null, freezeAuthority: null
  })), {
    mintAuthoritySafe: true,
    freezeAuthoritySafe: true,
    token2022ExtensionsSafe: true
  });
  assert.deepEqual(parseTrustedMintAccount(parsed(token2022, {
    mintAuthority: null, freezeAuthority: null, extensions: []
  })), {
    mintAuthoritySafe: true,
    freezeAuthoritySafe: true,
    token2022ExtensionsSafe: true
  });
  assert.equal(parseTrustedMintAccount(parsed(token2022, {
    mintAuthority: null, freezeAuthority: null
  })).token2022ExtensionsSafe, false);

  assert.throws(() => parseTrustedMintAccount(parsed(classic, {
    freezeAuthority: null
  })), /authority metadata is incomplete/);
  assert.throws(() => parseTrustedMintAccount(parsed(classic, {
    mintAuthority: null, freezeAuthority: "not-a-public-key"
  })), /authority metadata is malformed/);

  let getterCalls = 0;
  const hostileInfo = { freezeAuthority: null };
  Object.defineProperty(hostileInfo, "mintAuthority", {
    get() { getterCalls += 1; return null; }
  });
  assert.throws(() => parseTrustedMintAccount(parsed(classic, hostileInfo)),
    /authority metadata is incomplete/);
  assert.equal(getterCalls, 0);

  const sparseExtensions = new Array(1);
  assert.throws(() => parseTrustedMintAccount(parsed(token2022, {
    mintAuthority: null, freezeAuthority: null, extensions: sparseExtensions
  })), /extensions are malformed/);
});

test("raw Token-2022 mint TLV layout is validated and extensions remain unsafe", () => {
  const token2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const makeExtended = (mutate = () => {}) => {
    const bytes = Buffer.alloc(171);
    bytes[165] = 1; // AccountType::Mint
    bytes.writeUInt16LE(1, 166); // TransferFeeConfig extension type
    bytes.writeUInt16LE(1, 168);
    bytes[170] = 7;
    mutate(bytes);
    return bytes.toString("base64");
  };
  const result = parseTrustedMintAccount({
    value: { owner: token2022, data: [makeExtended(), "base64"] }
  });
  assert.equal(result.mintAuthoritySafe, true);
  assert.equal(result.freezeAuthoritySafe, true);
  assert.equal(result.token2022ExtensionsSafe, false);

  for (const encoded of [
    makeExtended(bytes => { bytes[165] = 2; }),
    makeExtended(bytes => { bytes[82] = 1; }),
    makeExtended(bytes => { bytes[168] = 0; bytes[169] = 0; }),
    Buffer.concat([Buffer.from(makeExtended(), "base64"), Buffer.from([1])]).toString("base64")
  ]) {
    assert.throws(() => parseTrustedMintAccount({
      value: { owner: token2022, data: [encoded, "base64"] }
    }), /Token-2022/);
  }

  const truncated = Buffer.alloc(170);
  truncated[165] = 1;
  truncated.writeUInt16LE(1, 166);
  truncated.writeUInt16LE(4, 168);
  assert.throws(() => parseTrustedMintAccount({
    value: { owner: token2022, data: [truncated.toString("base64"), "base64"] }
  }), /TLV record is invalid/);
});

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
  const computeBudget = decodeBase58("ComputeBudget111111111111111111111111111111");
  const instructionData = [2, 0x40, 0x0d, 0x03, 0x00]; // SetComputeUnitLimit(200000)
  const message = Uint8Array.from([
    0x80, 1, 0, 1,
    2, ...signer, ...computeBudget,
    ...new Array(32).fill(0),
    1, 1, 0, instructionData.length, ...instructionData,
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
function mockExecutableProgramRpcResponse(options, slot = 101, mutate = account => account) {
  const request = JSON.parse(options.body);
  const ids = request.params[0];
  return Response.json({
    jsonrpc: "2.0", id: 1,
    result: {
      context: { slot },
      value: ids.map(programId => mutate({
        owner: "NativeLoader1111111111111111111111111111111",
        executable: true,
        data: ["", "base64"]
      }, programId))
    }
  });
}
function mockExecutableProgramFetch(slot = 101, mutate) {
  return async (_url, options) => mockExecutableProgramRpcResponse(options, slot, mutate);
}
function mockAltAndExecutableFetch(slot = 101) {
  return async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.params[1]?.dataSlice) {
      return mockExecutableProgramRpcResponse(options, slot);
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result: {
      context: { slot: 100 }, value: [mockLookupTableAccount()]
    } });
  };
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


test("combined validation binds a SHA-256 digest to the exact unsigned serialized message", async () => {
  const original = validUnsignedTransaction();
  const originalEvidence = await validateAndResolveUnsignedJupiterTransaction(
    original, BOT_WALLET, mockExecutableProgramFetch()
  );
  assert.equal(originalEvidence.messageDigest.algorithm, "SHA-256");
  assert.equal(originalEvidence.messageDigest.encoding, "hex");
  assert.match(originalEvidence.messageDigest.value, /^[a-f0-9]{64}$/);
  assert.equal(originalEvidence.messageDigest.signer, BOT_WALLET);
  assert.equal(originalEvidence.messageDigest.messageVersion, "legacy");
  const originalBytes = Buffer.from(original, "base64");
  assert.equal(
    originalEvidence.messageDigest.value,
    createHash("sha256").update(originalBytes.subarray(65)).digest("hex"),
    "digest must cover the exact serialized message bytes, excluding the signature vector"
  );
  assert.equal(originalEvidence.semanticInstructionVerification, false);
  assert.equal(originalEvidence.programExecutableFlagsVerified, true);
  assert.equal(originalEvidence.programExecutableEvidence.scope,
    "finalized-account-executable-flag-and-loader-owner-only");
  assert.deepEqual(originalEvidence.programExecutableEvidence.programs.map(item => item.programId),
    ["11111111111111111111111111111111"]);

  const changedBytes = Buffer.from(original, "base64");
  // Mutate the recent blockhash byte so the message remains structurally valid.
  // Serialized layout: signature-count + signature + legacy header + key-count + keys.
  changedBytes[65 + 3 + 1 + 64] ^= 1;
  const changedEvidence = await validateAndResolveUnsignedJupiterTransaction(
    changedBytes.toString("base64"), BOT_WALLET, mockExecutableProgramFetch()
  );
  assert.notEqual(
    changedEvidence.messageDigest.value,
    originalEvidence.messageDigest.value,
    "any serialized message change must produce a different digest"
  );
});

test("combined v1 transaction validation binds executable evidence to its inline instruction program", async () => {
  const encoded = validUnsignedV1Transaction();
  const parsed = await validateAndResolveUnsignedJupiterTransaction(
    encoded, BOT_WALLET, mockExecutableProgramFetch()
  );
  assert.equal(parsed.messageVersion, 1);
  assert.equal(parsed.lookupTableResolution, "not-required");
  assert.equal(parsed.programExecutableFlagsVerified, true);
  assert.equal(parsed.programExecutableEvidence.scope,
    "finalized-account-executable-flag-and-loader-owner-only");
  assert.deepEqual(
    parsed.programExecutableEvidence.programs.map(item => item.programId),
    [parsed.staticAccountKeys[1]]
  );
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("combined transaction validation resolves ALT and keeps instruction semantics untrusted", async () => {
  const parsed = await validateAndResolveUnsignedJupiterTransaction(
    validUnsignedV0TransactionWithLookup(), BOT_WALLET,
    mockAltAndExecutableFetch()
  );
  assert.equal(parsed.messageVersion, 0);
  assert.equal(parsed.lookupTableResolution, "finalized-resolved");
  assert.equal(parsed.lookupContextSlot, 100);
  assert.equal(parsed.resolvedWritableAddresses[0], encodeBase58(new Uint8Array(32).fill(7)));
  assert.equal(parsed.resolvedReadonlyAddresses[0], encodeBase58(new Uint8Array(32).fill(8)));
  assert.equal(parsed.messageDigest.algorithm, "SHA-256");
  assert.equal(parsed.messageDigest.encoding, "hex");
  assert.match(parsed.messageDigest.value, /^[a-f0-9]{64}$/);
  assert.equal(parsed.messageDigest.messageVersion, 0);
  assert.equal(parsed.messageDigest.signer, BOT_WALLET);
  const serialized = Buffer.from(validUnsignedV0TransactionWithLookup(), "base64");
  assert.equal(
    parsed.messageDigest.value,
    createHash("sha256").update(serialized.subarray(65)).digest("hex"),
    "v0 digest must cover the exact serialized message, including ALT descriptors"
  );
  assert.equal(parsed.semanticInstructionVerification, false);
});

test("parser consumes only immutable finalized ALT evidence bound to the exact compiled message", async () => {
  const evidence = await validateAndResolveUnsignedJupiterTransaction(
    validUnsignedV0TransactionWithLookup(), BOT_WALLET,
    mockAltAndExecutableFetch()
  );
  assert.equal(evidence.lookupTableResolution, "finalized-resolved");
  assert.equal(evidence.programExecutableFlagsVerified, true);
  assert.equal(evidence.programExecutableEvidence.contextSlot, 101);
  assert.equal(evidence.messageDigest.algorithm, "SHA-256");
  assert.equal(evidence.header.numReadonlyUnsignedAccounts, 1);
  assert.equal(evidence.accountKeys.length, 4);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.accountKeys), true);
  assert.equal(Object.isFrozen(evidence.header), true);
  assert.equal(Object.isFrozen(evidence.compiledInstructions), true);
  assert.equal(Object.isFrozen(evidence.compiledInstructions[0].accountKeyIndexes), true);
  assert.deepEqual(evidence.resolvedAddressTableLookups, [{
    writableAddresses: evidence.resolvedWritableAddresses,
    readonlyAddresses: evidence.resolvedReadonlyAddresses
  }]);

  const parsed = parseSupportedInstructionMessage({
    accountKeys: evidence.accountKeys,
    instructions: evidence.compiledInstructions,
    staticAccountKeys: evidence.staticAccountKeys,
    header: evidence.header,
    resolvedAddressTableLookups: evidence.resolvedAddressTableLookups,
    trustedMessageEvidence: evidence
  });
  assert.equal(parsed.accountPrivilegeAnalysis, "structural-match-only");
  assert.equal(parsed.lookupAddressAuthentication, "finalized-message-digest-bound");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);

  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: evidence.accountKeys,
    instructions: evidence.compiledInstructions.map(item => ({
      ...item, data: Buffer.from([2, 1, 0, 0, 0]).toString("base64")
    })),
    staticAccountKeys: evidence.staticAccountKeys,
    header: evidence.header,
    resolvedAddressTableLookups: evidence.resolvedAddressTableLookups,
    trustedMessageEvidence: evidence
  }), /do not match digest-bound finalized ALT evidence/);

  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: evidence.accountKeys,
    instructions: evidence.compiledInstructions,
    staticAccountKeys: evidence.staticAccountKeys,
    header: { ...evidence.header, numReadonlyUnsignedAccounts: 0 },
    resolvedAddressTableLookups: evidence.resolvedAddressTableLookups,
    trustedMessageEvidence: evidence
  }), /do not match digest-bound finalized ALT evidence/);

  assert.throws(() => parseSupportedInstructionMessage({
    accountKeys: [
      evidence.accountKeys[0], evidence.accountKeys[1],
      evidence.resolvedReadonlyAddresses[0], evidence.resolvedWritableAddresses[0]
    ],
    instructions: evidence.compiledInstructions,
    staticAccountKeys: evidence.staticAccountKeys,
    header: evidence.header,
    resolvedAddressTableLookups: evidence.resolvedAddressTableLookups,
    trustedMessageEvidence: evidence
  }), /do not match digest-bound finalized ALT evidence/);
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
    return { owner: "AddressLookupTab1e1111111111111111111111111", executable: false, data: [data.toString("base64"), "base64"] };
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
  data.set(decodeBase58("ComputeBudget111111111111111111111111111111"), 56); // Duplicate the second inline static account key.
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

test("ALT resolver rejects accessor-backed descriptors and index arrays without invoking getters", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  let getterCalls = 0;
  const descriptor = {
    accountKey: tableKey,
    writableIndexes: [0],
    readonlyIndexes: []
  };
  Object.defineProperty(descriptor, "accountKey", {
    enumerable: true,
    get() { getterCalls++; return tableKey; }
  });
  let rpcCalled = false;
  await assert.rejects(resolveJupiterAddressLookupTables([descriptor], async () => {
    rpcCalled = true;
    throw new Error("RPC should not be called");
  }), /accessor-backed/);
  assert.equal(getterCalls, 0);
  assert.equal(rpcCalled, false);

  const accessorIndexes = [0];
  Object.defineProperty(accessorIndexes, "0", {
    get() { getterCalls++; return 0; }
  });
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: accessorIndexes, readonlyIndexes: []
  }], async () => {
    rpcCalled = true;
    throw new Error("RPC should not be called");
  }), /accessor-backed/);
  assert.equal(getterCalls, 0);
  assert.equal(rpcCalled, false);
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

test("ALT resolver rejects malformed RPC account data tuples", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  const base = mockLookupTableAccount();
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [{ ...base, data: [...base.data, "unexpected"] }]
  } })), /malformed|invalid/i);
});

test("ALT resolver rejects tables not owned by the Address Lookup Table program", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [mockLookupTableAccount({ owner: "TokenkegQfeZyiNwAJNbGKPFXCWuBvf9Ss623VQ5DA" })]
  } })), /unexpected program/);
});

test("ALT resolver rejects executable accounts and noncanonical base64", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  const executable = mockLookupTableAccount();
  executable.executable = true;
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [executable]
  } })), /executable/);

  const malformedBase64 = mockLookupTableAccount();
  malformedBase64.data = [malformedBase64.data[0] + " ", "base64"];
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [malformedBase64]
  } })), /canonical base64/);
});

test("ALT resolver rejects oversized encoded account data before decoding", async () => {
  const tableKey = encodeBase58(new Uint8Array(32).fill(42));
  const oversized = mockLookupTableAccount();
  oversized.data = ["A".repeat(11004), "base64"];
  await assert.rejects(resolveJupiterAddressLookupTables([{
    accountKey: tableKey, writableIndexes: [0], readonlyIndexes: []
  }], async () => Response.json({ jsonrpc: "2.0", id: 1, result: {
    context: { slot: 100 }, value: [oversized]
  } })), /exceeds limits or is not canonical base64/);
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
  } })), /reserved authority bytes/);
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

test("v1 transaction rejects an out-of-range instruction program index", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes[114] = 2;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /instruction header is invalid/
  );
});

test("v1 transaction rejects an out-of-range instruction account index", () => {
  const bytes = Buffer.from(validUnsignedV1Transaction(), "base64");
  bytes[118] = 2;
  assert.throws(
    () => validateUnsignedJupiterTransaction(bytes.toString("base64"), BOT_WALLET),
    /instruction account index is invalid/
  );
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
    for (const transaction of ["unsigned-transaction-string", { message: "not-a-verified-message" }]) {
      jupiterResponseOverride = {
        requestId: "unexpected-transaction-payload",
        transaction,
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
    }
  } finally {
    Date.now = originalNow;
  }
  assert.equal(risk.fetchedAt, 1000);
  assert.ok(clock > risk.fetchedAt);
  // Five full evidence fetches run: one valid quote and four malformed quote regressions.
  // Each must still page both holder-census pages completely.
  assert.equal(holderPages, 10);
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
  assert.equal(risk.sellRoute.analysisOnly, true);
  assert.equal(risk.sellRoute.semanticInstructionVerification, false);
  assert.equal(risk.sellRoute.routeVerification, "quote-only-no-transaction");
  assert.equal(risk.sellRoute.signingPermitted, false);
  assert.equal(risk.sellRoute.submissionPermitted, false);
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
            message: { accountKeys: [BOT_WALLET, "11111111111111111111111111111112", "11111111111111111111111111111113"] }
          },
          meta: {
            err: null,
            fee: 5000,
            preBalances: [100_000_000, 0, 0],
            postBalances: [89_995_000, 0, 0],
            preTokenBalances: [{
              mint: "So11111111111111111111111111111111111111112",
              owner: BOT_WALLET, accountIndex: 1, uiTokenAmount: { amount: "10000000", decimals: 9 }
            }],
            postTokenBalances: [
              {
                mint: "So11111111111111111111111111111111111111112",
                owner: BOT_WALLET, accountIndex: 1, uiTokenAmount: { amount: "0", decimals: 9 }
              },
              {
                mint: outputMint, owner: BOT_WALLET, accountIndex: 2,
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
  assert.equal(proof.proofScope, "finalized-owner-scoped-token-balance-deltas");
  assert.equal(proof.semanticInstructionVerification, false);
  assert.equal(proof.allInCostsVerified, false);
  assert.equal(proof.confirmationStatus, "finalized");
  assert.equal(proof.slot, 123);
  // The native SOL balance delta includes the 10,000,000-lamport wrapped-SOL
  // input and 5,000-lamport base fee in this fixture. The verifier does not
  // yet attest priority fees, rent, tips, or every other native outflow.
  for (const field of [
    "costs", "allInCosts", "nativeSolOutflowLamports",
    "baseFeeLamports", "priorityFeeLamports", "rentLamports",
    "tipLamports", "totalLamports"
  ]) {
    assert.equal(Object.hasOwn(proof, field), false, field);
  }
});

test("settlement proof rejects sparse or accessor-backed native lamport balance metadata", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(8));
  const baseResult = {
    slot: 124,
    transaction: { signatures: [signature], message: { accountKeys: [BOT_WALLET, "11111111111111111111111111111112", "11111111111111111111111111111113"] } },
    meta: {
      err: null, fee: 5000, preBalances: [100000, 0, 0], postBalances: [95000, 0, 0],
      preTokenBalances: [
        { mint: "So11111111111111111111111111111111111111112", owner: BOT_WALLET, accountIndex: 1, uiTokenAmount: { amount: "1" } },
        { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: BOT_WALLET, accountIndex: 2, uiTokenAmount: { amount: "0" } }
      ],
      postTokenBalances: [
        { mint: "So11111111111111111111111111111111111111112", owner: BOT_WALLET, accountIndex: 1, uiTokenAmount: { amount: "0" } },
        { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: BOT_WALLET, accountIndex: 2, uiTokenAmount: { amount: "1" } }
      ]
    }
  };
  let responseResult = baseResult;
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : responseResult;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  const request = {
    signature,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inputAmount: "1",
    outputAmount: "1"
  };

  const sparse = new Array(1);
  responseResult = {
    ...baseResult,
    meta: { ...baseResult.meta, preBalances: sparse }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /metadata is incomplete/);

  responseResult = {
    ...baseResult,
    meta: { ...baseResult.meta, preBalances: [null] }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /metadata is incomplete/);

});

test("settlement proof rejects accessor-backed and sparse finalized account keys without invoking getters", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(8));
  const baseResult = {
    slot: 124,
    transaction: { signatures: [signature], message: { accountKeys: [BOT_WALLET] } },
    meta: {
      err: null, fee: 5000, preBalances: [100000], postBalances: [95000],
      // This test targets malformed account-key containers; keep token rows empty
      // so the stricter accountIndex requirement does not mask the intended failure.
      preTokenBalances: [],
      postTokenBalances: []
    }
  };
  let responseResult = baseResult;
  const fetchImpl = async (_url, options) => {
    const method = JSON.parse(options.body).method;
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : responseResult;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  const request = {
    signature,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inputAmount: "1",
    outputAmount: "1"
  };

  responseResult = {
    ...baseResult,
    transaction: { ...baseResult.transaction, message: { accountKeys: [null] } }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /account keys are malformed/);

  responseResult = {
    ...baseResult,
    transaction: { ...baseResult.transaction, message: { accountKeys: new Array(1) } }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /account keys are malformed/);

  responseResult = {
    ...baseResult,
    transaction: {
      ...baseResult.transaction,
      message: { accountKeys: [{ pubkey: BOT_WALLET, unexpected: true }] }
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /account keys are malformed/);

  responseResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      preTokenBalances: [...baseResult.meta.preTokenBalances, null]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /token balance metadata is malformed/);
});

test("settlement proof requires the requested signature to occupy the fee-payer signature slot", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(7));
  const unrelatedSignature = encodeBase58(new Uint8Array(64).fill(8));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 126,
          transaction: {
            // The requested signature is present, but is not the first
            // signature corresponding to the fee payer account.
            signatures: [unrelatedSignature, signature],
            message: { accountKeys: [BOT_WALLET] }
          },
          meta: {
            err: null, fee: 5000,
            preBalances: [100_000_000], postBalances: [89_995_000],
            preTokenBalances: [{
              mint: inputMint, owner: BOT_WALLET,
              uiTokenAmount: { amount: "10000000", decimals: 9 }
            }],
            postTokenBalances: [
              { mint: inputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "0", decimals: 9 } },
              { mint: outputMint, owner: BOT_WALLET, uiTokenAmount: { amount: "12345", decimals: 6 } }
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
    /metadata is incomplete or indicates failure/
  );
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
            message: { accountKeys: ["11111111111111111111111111111111", BOT_WALLET, encodeBase58(new Uint8Array(32).fill(10)), encodeBase58(new Uint8Array(32).fill(11))] }
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
          transaction: { signatures: [signature], message: { accountKeys: [BOT_WALLET, "11111111111111111111111111111112", "11111111111111111111111111111113"] } },
          meta: {
            err: null, fee: 5000, preBalances: [100_000_000, 0, 0], postBalances: [89_995_000, 0, 0],
            preTokenBalances: [{
              mint: "So11111111111111111111111111111111111111112",
              owner: BOT_WALLET, accountIndex: 1, uiTokenAmount: { amount: "10000000", decimals: 9 }
            }],
            postTokenBalances: [
              {
                mint: "So11111111111111111111111111111111111111112",
                owner: BOT_WALLET, accountIndex: 1, uiTokenAmount: { amount: "0", decimals: 9 }
              },
              {
                mint: outputMint, owner: BOT_WALLET, accountIndex: 2,
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
  assert.equal(parsed.analysisOnly, true);
  assert.equal(parsed.semanticInstructionVerification, false);
  assert.equal(parsed.routeVerification, "build-envelope-only");
  assert.equal(parsed.signingPermitted, false);
  assert.equal(parsed.submissionPermitted, false);
});

test("every Jupiter /build instruction slot remains untrusted regardless of program ID", () => {
  const opaqueInstruction = {
    programId: "11111111111111111111111111111111",
    accounts: [],
    data: ""
  };
  const parsed = validateJupiterBuildResponse(validBuildResponse({
    computeBudgetInstructions: [opaqueInstruction],
    setupInstructions: [opaqueInstruction],
    swapInstruction: opaqueInstruction,
    cleanupInstruction: opaqueInstruction,
    otherInstructions: [opaqueInstruction],
    tipInstruction: opaqueInstruction
  }));

  assert.equal(parsed.semanticInstructionVerification, false);
  assert.equal(parsed.routeVerification, "build-envelope-only");
  assert.equal(parsed.computeBudgetInstructions.length, 1);
  assert.equal(parsed.setupInstructions.length, 1);
  assert.equal(parsed.swapInstruction.programId, opaqueInstruction.programId);
  assert.equal(parsed.cleanupInstruction.programId, opaqueInstruction.programId);
  assert.equal(parsed.otherInstructions.length, 1);
  assert.equal(parsed.tipInstruction.programId, opaqueInstruction.programId);
});

test("Jupiter /build instruction validator rejects getters without invoking them", () => {
  let instructionGetterCalls = 0;
  const accessorInstruction = {
    accounts: [],
    data: ""
  };
  Object.defineProperty(accessorInstruction, "programId", {
    enumerable: true,
    get() { instructionGetterCalls++; return "11111111111111111111111111111111"; }
  });
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    swapInstruction: accessorInstruction
  })), /instruction contains accessor-backed properties/);
  assert.equal(instructionGetterCalls, 0);

  let accountGetterCalls = 0;
  const accessorAccount = { isSigner: false, isWritable: false };
  Object.defineProperty(accessorAccount, "pubkey", {
    enumerable: true,
    get() { accountGetterCalls++; return "11111111111111111111111111111111"; }
  });
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    swapInstruction: {
      programId: "11111111111111111111111111111111",
      accounts: [accessorAccount],
      data: ""
    }
  })), /instruction account contains accessor-backed properties/);
  assert.equal(accountGetterCalls, 0);
});

test("Jupiter /build instruction arrays reject custom iterators and decorated prototypes", () => {
  let iteratorCalls = 0;
  const accounts = [];
  Object.defineProperty(accounts, Symbol.iterator, {
    value() { iteratorCalls++; return [][Symbol.iterator](); }
  });
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    swapInstruction: {
      programId: "11111111111111111111111111111111",
      accounts,
      data: ""
    }
  })), /instruction account.*malformed/);
  assert.equal(iteratorCalls, 0);

  const decorated = [];
  decorated.extra = true;
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    otherInstructions: decorated
  })), /instruction.*malformed/);
});

test("Jupiter /build rejects accessor-backed envelope and route data without invoking getters", () => {
  let envelopeGetterCalls = 0;
  const envelope = validBuildResponse();
  Object.defineProperty(envelope, "inputMint", {
    enumerable: true,
    get() { envelopeGetterCalls++; return "So11111111111111111111111111111111111111112"; }
  });
  assert.throws(() => validateJupiterBuildResponse(envelope), /accessor-backed/);
  assert.equal(envelopeGetterCalls, 0);

  let routeGetterCalls = 0;
  const routeStep = validBuildResponse().routePlan[0];
  Object.defineProperty(routeStep, "percent", {
    enumerable: true,
    get() { routeGetterCalls++; return 100; }
  });
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    routePlan: [routeStep]
  })), /accessor-backed/);
  assert.equal(routeGetterCalls, 0);

  let infoGetterCalls = 0;
  const swapInfo = { ...validBuildResponse().routePlan[0].swapInfo };
  Object.defineProperty(swapInfo, "ammKey", {
    enumerable: true,
    get() { infoGetterCalls++; return "11111111111111111111111111111111"; }
  });
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    routePlan: [{ percent: 100, bps: 10000, swapInfo }]
  })), /accessor-backed/);
  assert.equal(infoGetterCalls, 0);
});

test("Jupiter /build rejects sparse and accessor-backed route and blockhash arrays", () => {
  const sparseRoute = new Array(1);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    routePlan: sparseRoute
  })), /routePlan is malformed/);

  let byteGetterCalls = 0;
  const blockhash = new Array(32).fill(1);
  Object.defineProperty(blockhash, "0", {
    enumerable: true,
    get() { byteGetterCalls++; return 1; }
  });
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    blockhashWithMetadata: { blockhash, lastValidBlockHeight: 123456 }
  })), /response envelope|blockhash metadata.*malformed/);
  assert.equal(byteGetterCalls, 0);
});

test("Jupiter /build rejects accessor-backed lookup map entries without invoking getters", () => {
  let getterCalls = 0;
  const lookupMap = {};
  Object.defineProperty(lookupMap, "11111111111111111111111111111111", {
    enumerable: true,
    get() { getterCalls++; return []; }
  });
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    addressesByLookupTableAddress: lookupMap
  })), /accessor-backed/);
  assert.equal(getterCalls, 0);
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
  })), /response envelope|blockhash metadata.*malformed/);
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    otherInstructions: new Array(65).fill(validBuildResponse().swapInstruction)
  })), /response envelope|blockhash metadata.*malformed/);
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
    })), /response envelope|blockhash metadata.*malformed/);
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
      [field]: "9".repeat(100000)
    })), /response envelope|blockhash metadata.*malformed/);
  }
});


test("Jupiter /build rejects numeric or non-canonical amount values without coercion", () => {
  for (const field of ["inAmount", "outAmount", "otherAmountThreshold"]) {
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
      [field]: 9007199254740992
    })), /response envelope|blockhash metadata.*malformed/);
    assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
      [field]: "01"
    })), /response envelope|blockhash metadata.*malformed/);
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
    })), /routePlan\[0\].*malformed/);
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
      /routePlan\[0\].*malformed/);
  }
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({ swapMode: "Unknown" })),
    /response envelope|blockhash metadata.*malformed/);
});

test("Jupiter /build rejects sparse route and instruction collections", () => {
  const sparseRoute = new Array(2);
  sparseRoute[0] = validBuildResponse().routePlan[0];
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    routePlan: sparseRoute
  })), /routePlan.*malformed/);

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
  })), /response envelope|blockhash metadata.*malformed/);
});

test("Jupiter /build rejects sparse blockhash and lookup-table arrays", () => {
  const sparseBlockhash = new Array(32).fill(1);
  delete sparseBlockhash[7];
  assert.throws(() => validateJupiterBuildResponse(validBuildResponse({
    blockhashWithMetadata: { blockhash: sparseBlockhash, lastValidBlockHeight: 123456 }
  })), /response envelope|blockhash metadata.*malformed/);

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
      /routePlan\[0\].*malformed/
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



test("combined transaction validation fails closed when any referenced program is not executable", async () => {
  await assert.rejects(
    validateAndResolveUnsignedJupiterTransaction(
      validUnsignedTransaction(), BOT_WALLET,
      mockExecutableProgramFetch(102, account => ({ ...account, executable: false }))
    ),
    /not confirmed executable/
  );
});

test("referenced programs require finalized executable flags and recognized loader ownership", async () => {
  const programIds = [
    "11111111111111111111111111111111",
    "ComputeBudget111111111111111111111111111111"
  ];
  let request;
  const evidence = await resolveExecutableProgramAccounts(programIds, async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({
      jsonrpc: "2.0", id: 1,
      result: {
        context: { slot: 250 },
        value: programIds.map(() => ({
          owner: "NativeLoader1111111111111111111111111111111",
          executable: true,
          data: ["", "base64"]
        }))
      }
    });
  });
  assert.equal(request.method, "getMultipleAccounts");
  assert.deepEqual(request.params[0], programIds);
  assert.deepEqual(request.params[1], {
    commitment: "finalized",
    encoding: "base64",
    dataSlice: { offset: 0, length: 0 }
  });
  assert.equal(evidence.scope, "finalized-account-executable-flag-and-loader-owner-only");
  assert.equal(evidence.contextSlot, 250);
  assert.deepEqual(evidence.programs.map(item => item.programId), programIds);
  assert.ok(evidence.programs.every(item =>
    item.executable === true && item.commitment === "finalized" && item.contextSlot === 250));

  await assert.rejects(
    resolveExecutableProgramAccounts(programIds, async () => Response.json({
      jsonrpc: "2.0", id: 1,
      result: { context: { slot: 251 }, value: [null, null] }
    })),
    /missing or malformed/
  );
  await assert.rejects(
    resolveExecutableProgramAccounts(programIds, async () => Response.json({
      jsonrpc: "2.0", id: 1,
      result: {
        context: { slot: 252 },
        value: programIds.map(() => ({
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          executable: false,
          data: ["", "base64"]
        }))
      }
    })),
    /not confirmed executable/
  );
  await assert.rejects(
    resolveExecutableProgramAccounts([programIds[0], programIds[0]], async () => {
      throw new Error("RPC must not be called for duplicate IDs");
    }),
    /duplicated/
  );
});



test("executable program resolver rejects executable accounts owned by non-loader programs", async () => {
  const id = "11111111111111111111111111111111";
  await assert.rejects(
    resolveExecutableProgramAccounts([id], async () => Response.json({
      jsonrpc: "2.0", id: 1,
      result: {
        context: { slot: 253 },
        value: [{
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          executable: true,
          data: ["", "base64"]
        }]
      }
    })),
    /recognized Solana loader/
  );
});

test("executable program resolver bounds RPC batches and pins later batches to prior finalized context", async () => {
  const ids = Array.from({ length: 101 }, (_, index) =>
    encodeBase58(Uint8Array.from({ length: 32 }, (_, byte) => (index + byte + 1) % 256))
  );
  assert.equal(new Set(ids).size, ids.length);
  const requests = [];
  const evidence = await resolveExecutableProgramAccounts(ids, async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const slot = requests.length === 1 ? 500 : 501;
    return Response.json({
      jsonrpc: "2.0", id: 1,
      result: {
        context: { slot },
        value: request.params[0].map(() => ({
          owner: "BPFLoaderUpgradeab1e11111111111111111111111",
          executable: true,
          data: ["", "base64"]
        }))
      }
    });
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params[0].length, 100);
  assert.equal(requests[1].params[0].length, 1);
  assert.equal(requests[0].params[1].commitment, "finalized");
  assert.equal(requests[1].params[1].minContextSlot, 500);
  assert.equal(evidence.contextSlot, 501);
  assert.equal(evidence.programs.length, 101);
  assert.ok(evidence.programs.every(item => item.executable === true));
});

test("executable program resolver rejects malformed finalized context and account metadata", async () => {
  const id = "11111111111111111111111111111111";
  for (const result of [
    { context: { slot: 0 }, value: [{ owner: "NativeLoader1111111111111111111111111111111", executable: true }] },
    { context: { slot: 10 }, value: [] },
    { context: { slot: 10 }, value: [{ owner: "NativeLoader1111111111111111111111111111111" }] },
    { context: { slot: 10 }, value: [Object.defineProperty({ executable: true }, "owner", { get() { throw new Error("owner getter must not run"); } })] }
  ]) {
    await assert.rejects(resolveExecutableProgramAccounts([id], async () =>
      Response.json({ jsonrpc: "2.0", id: 1, result })
    ));
  }
});


test("CPI indexes resolve only against privately branded exact-message evidence", async () => {
  const encoded = validUnsignedTransaction();
  const evidence = await validateAndResolveUnsignedJupiterTransaction(
    encoded, BOT_WALLET, mockExecutableProgramFetch()
  );
  const serialized = Buffer.from(encoded, "base64");
  const messageBytes = serialized.subarray(65);
  const messageDigest = createHash("sha256").update(messageBytes).digest("hex");
  const observation = normalizeSimulationObservation({
    messageDigest,
    simulationResult: {
      context: { slot: 1234 },
      value: { err: null, innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 1, accounts: [0] }]
      }] }
    },
    topLevelInstructionCount: evidence.compiledInstructions.length,
    accountKeyCount: evidence.accountKeys.length
  });
  const resolved = resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation,
    trustedMessageEvidence: evidence
  });
  assert.equal(resolved.groups[0].instructions[0].programIdCandidate, evidence.accountKeys[1]);
  assert.deepEqual(resolved.groups[0].instructions[0].accountKeyCandidates, [evidence.accountKeys[0]]);
  assert.equal(resolved.cpiIndexResolution, "resolved-against-trusted-message-candidate-only");
  assert.equal(resolved.cpiProgramIdsVerified, false);
  assert.equal(resolved.simulationInputIdentityVerified, false);
  assert.equal(resolved.semanticInstructionVerification, false);
  assert.equal(resolved.signingPermitted, false);
  assert.equal(resolved.submissionPermitted, false);
});

test("CPI index resolution rejects unbranded or digest-mismatched evidence", () => {
  const observation = {
    scope: "simulation-observation-only",
    messageDigest: "a".repeat(64),
    groups: []
  };
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation,
    trustedMessageEvidence: { accountKeys: ["11111111111111111111111111111111"] }
  }), /privately branded/i);
});


test("CPI index resolution rejects a digest mismatch even with privately branded evidence", async () => {
  const evidence = await validateAndResolveUnsignedJupiterTransaction(
    validUnsignedTransaction(), BOT_WALLET, mockExecutableProgramFetch()
  );
  const observation = normalizeSimulationObservation({
    messageDigest: "a".repeat(64),
    simulationResult: {
      context: { slot: 1234 },
      value: { err: null, innerInstructions: [] }
    },
    topLevelInstructionCount: evidence.compiledInstructions.length,
    accountKeyCount: evidence.accountKeys.length
  });
  const completeObservation = Object.freeze({
    ...observation,
    messageDigestSource: "sha256-of-supplied-serialized-message",
    simulationInputIdentityVerified: false
  });
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: completeObservation,
    trustedMessageEvidence: evidence
  }), /digest does not match/);
});

test("CPI index resolution preserves v0 loaded writable/readonly account-key ordering", async () => {
  const encoded = validUnsignedV0TransactionWithLookup();
  const evidence = await validateAndResolveUnsignedJupiterTransaction(
    encoded, BOT_WALLET, mockAltAndExecutableFetch()
  );
  assert.equal(evidence.accountKeys.length, 4);
  const serialized = Buffer.from(encoded, "base64");
  const messageDigest = createHash("sha256")
    .update(serialized.subarray(65))
    .digest("hex");
  const observation = normalizeSimulationObservation({
    messageDigest,
    simulationResult: {
      context: { slot: 1235 },
      value: { err: null, innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 3, accounts: [2] }]
      }] }
    },
    topLevelInstructionCount: evidence.compiledInstructions.length,
    accountKeyCount: evidence.accountKeys.length
  });
  const resolved = resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation,
    trustedMessageEvidence: evidence
  });
  assert.equal(resolved.groups[0].instructions[0].programIdCandidate, evidence.accountKeys[3]);
  assert.deepEqual(resolved.groups[0].instructions[0].accountKeyCandidates, [evidence.accountKeys[2]]);
  assert.equal(resolved.semanticInstructionVerification, false);
  assert.equal(resolved.simulationInputIdentityVerified, false);
  assert.equal(resolved.signingPermitted, false);
  assert.equal(resolved.submissionPermitted, false);
});


test("CPI index resolution rejects forged status flags and inconsistent aggregate counts", async () => {
  const encoded = validUnsignedTransaction();
  const evidence = await validateAndResolveUnsignedJupiterTransaction(
    encoded, BOT_WALLET, mockExecutableProgramFetch()
  );
  const serialized = Buffer.from(encoded, "base64");
  const digest = createHash("sha256").update(serialized.subarray(65)).digest("hex");
  const observation = normalizeSimulationObservation({
    messageDigest: digest,
    simulationResult: {
      context: { slot: 1236 },
      value: { err: null, innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 1, accounts: [0] }]
      }] }
    },
    topLevelInstructionCount: evidence.compiledInstructions.length,
    accountKeyCount: evidence.accountKeys.length
  });
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: { ...observation, signingPermitted: true },
    trustedMessageEvidence: evidence
  }), /cannot assert signingPermitted/);
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: { ...observation, innerInstructionCount: 2 },
    trustedMessageEvidence: evidence
  }), /aggregate instruction counts are inconsistent/);
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: {
      ...observation,
      groups: [observation.groups[0], observation.groups[0]],
      innerInstructionGroupCount: 2,
      innerInstructionCount: 2
    },
    trustedMessageEvidence: evidence
  }), /duplicate top-level groups/);
});

test("CPI index resolution rejects root and group accessors without invoking getters", async () => {
  const encoded = validUnsignedTransaction();
  const evidence = await validateAndResolveUnsignedJupiterTransaction(
    encoded, BOT_WALLET, mockExecutableProgramFetch()
  );
  const serialized = Buffer.from(encoded, "base64");
  const digest = createHash("sha256").update(serialized.subarray(65)).digest("hex");
  const base = normalizeSimulationObservation({
    messageDigest: digest,
    simulationResult: {
      context: { slot: 1237 },
      value: { err: null, innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 1, accounts: [0] }]
      }] }
    },
    topLevelInstructionCount: evidence.compiledInstructions.length,
    accountKeyCount: evidence.accountKeys.length
  });
  let getterCalls = 0;
  const hostileRoot = { ...base };
  Object.defineProperty(hostileRoot, "contextSlot", {
    enumerable: true,
    get() { getterCalls += 1; return 1237; }
  });
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: hostileRoot,
    trustedMessageEvidence: evidence
  }), /accessor-backed/);
  assert.equal(getterCalls, 0);

  const hostileGroup = { ...base.groups[0] };
  Object.defineProperty(hostileGroup, "topLevelInstructionIndex", {
    enumerable: true,
    get() { getterCalls += 1; return 0; }
  });
  const hostileGroups = Object.freeze({
    ...base,
    groups: Object.freeze([hostileGroup])
  });
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: hostileGroups,
    trustedMessageEvidence: evidence
  }), /accessor-backed/);
  assert.equal(getterCalls, 0);
});

test("CPI index resolution rejects accessor-backed observation fields without invoking getters", async () => {
  const evidence = await validateAndResolveUnsignedJupiterTransaction(
    validUnsignedTransaction(), BOT_WALLET, mockExecutableProgramFetch()
  );
  const serialized = Buffer.from(validUnsignedTransaction(), "base64");
  const digest = createHash("sha256").update(serialized.subarray(65)).digest("hex");
  let getterCalls = 0;
  const hostileInstruction = { programIdIndex: 1, data: null, stackHeight: null };
  Object.defineProperty(hostileInstruction, "accountIndexes", {
    enumerable: true,
    get() { getterCalls += 1; return [0]; }
  });
  const observation = {
    scope: "simulation-observation-only",
    messageDigest: digest,
    groups: [{
      topLevelInstructionIndex: 0,
      innerInstructionCount: 1,
      instructions: [hostileInstruction]
    }]
  };
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation,
    trustedMessageEvidence: evidence
  }), /accessor-backed/);
  assert.equal(getterCalls, 0);
});


test("CPI resolution revalidates complete and incomplete stack-height declarations", async () => {
  const encoded = validUnsignedTransaction();
  const evidence = await validateAndResolveUnsignedJupiterTransaction(
    encoded, BOT_WALLET, mockExecutableProgramFetch()
  );
  const serialized = Buffer.from(encoded, "base64");
  const digest = createHash("sha256").update(serialized.subarray(65)).digest("hex");
  const makeObservation = instructions => normalizeSimulationObservation({
    messageDigest: digest,
    simulationResult: {
      context: { slot: 1240 },
      value: { err: null, innerInstructions: [{ index: 0, instructions }] }
    },
    topLevelInstructionCount: evidence.compiledInstructions.length,
    accountKeyCount: evidence.accountKeys.length
  });

  const complete = makeObservation([
    { programIdIndex: 1, stackHeight: 2 },
    { programIdIndex: 1, stackHeight: 3 },
    { programIdIndex: 1, stackHeight: 2 }
  ]);
  const completeResolved = resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: complete,
    trustedMessageEvidence: evidence
  });
  assert.equal(completeResolved.groups[0].stackHeightStructure, "complete");
  assert.equal(completeResolved.semanticInstructionVerification, false);
  assert.equal(completeResolved.signingPermitted, false);
  assert.equal(completeResolved.submissionPermitted, false);

  const incomplete = makeObservation([
    { programIdIndex: 1, stackHeight: 2 },
    { programIdIndex: 1 }
  ]);
  const incompleteResolved = resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: incomplete,
    trustedMessageEvidence: evidence
  });
  assert.equal(incompleteResolved.groups[0].stackHeightStructure, "incomplete");
  assert.equal(incompleteResolved.semanticInstructionVerification, false);
  assert.equal(incompleteResolved.signingPermitted, false);
  assert.equal(incompleteResolved.submissionPermitted, false);

  const forgedComplete = Object.freeze({
    ...incomplete,
    groups: Object.freeze([Object.freeze({
      ...incomplete.groups[0],
      stackHeightStructure: "complete"
    })])
  });
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: forgedComplete,
    trustedMessageEvidence: evidence
  }), /stack-height structure is inconsistent/);

  const forgedIncomplete = Object.freeze({
    ...complete,
    groups: Object.freeze([Object.freeze({
      ...complete.groups[0],
      stackHeightStructure: "incomplete"
    })])
  });
  assert.throws(() => resolveSimulationCpiIndexesAgainstTrustedMessage({
    observation: forgedIncomplete,
    trustedMessageEvidence: evidence
  }), /stack-height structure is inconsistent/);
});


test("settlement proof rejects noncanonical or out-of-u64 reserved amounts before RPC", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(10));
  const fetchImpl = async () => {
    throw new Error("RPC must not be called for invalid reserved amounts");
  };
  const base = {
    signature,
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inputAmount: "1",
    outputAmount: "1"
  };
  for (const inputAmount of ["01", "18446744073709551616", "0", "-1"]) {
    await assert.rejects(verifyFinalizedJupiterSettlement({
      ...base, inputAmount
    }, fetchImpl), /incomplete or invalid/);
  }
  for (const outputAmount of ["01", "18446744073709551616", "0", "-1"]) {
    await assert.rejects(verifyFinalizedJupiterSettlement({
      ...base, outputAmount
    }, fetchImpl), /incomplete or invalid/);
  }
});


test("settlement proof rejects an owned finalized token balance above u64", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(11));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
          slot: 125,
          transaction: { signatures: [signature], message: { accountKeys: [BOT_WALLET, "11111111111111111111111111111112", "11111111111111111111111111111113"] } },
          meta: {
            err: null, fee: 5000, preBalances: [100000, 0, 0], postBalances: [95000, 0, 0],
            preTokenBalances: [{
              mint: inputMint, owner: BOT_WALLET, accountIndex: 1,
              uiTokenAmount: { amount: "18446744073709551616", decimals: 9 }
            }],
            postTokenBalances: [{
              mint: inputMint, owner: BOT_WALLET, accountIndex: 1,
              uiTokenAmount: { amount: "0", decimals: 9 }
            }, {
              mint: outputMint, owner: BOT_WALLET, accountIndex: 2,
              uiTokenAmount: { amount: "1", decimals: 6 }
            }]
          }
        };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  await assert.rejects(verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "1", outputAmount: "1"
  }, fetchImpl), /token balance exceeds u64/);
});


test("settlement proof rejects malformed supplied token account indexes and program IDs", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(12));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const baseResult = {
    slot: 127,
    transaction: { signatures: [signature], message: { accountKeys: [
      BOT_WALLET, "11111111111111111111111111111112", "11111111111111111111111111111113"
    ] } },
    meta: {
      err: null, fee: 5000, preBalances: [100000, 0, 0], postBalances: [95000, 0, 0],
      preTokenBalances: [{
        mint: inputMint, owner: BOT_WALLET, accountIndex: 1,
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: { amount: "1", decimals: 9 }
      }],
      postTokenBalances: [{
        mint: inputMint, owner: BOT_WALLET, accountIndex: 1,
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: { amount: "0", decimals: 9 }
      }, {
        mint: outputMint, owner: BOT_WALLET, accountIndex: 2,
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        uiTokenAmount: { amount: "1", decimals: 6 }
      }]
    }
  };
  let transactionResult = baseResult;
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : transactionResult;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  const request = { signature, inputMint, outputMint, inputAmount: "1", outputAmount: "1" };

  // Fail closed when a metadata row omits accountIndex entirely.
  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      preTokenBalances: [
        { mint: outputMint, owner: BOT_WALLET,
          uiTokenAmount: { amount: "1", decimals: 6 } }
      ]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /account index is malformed/);
  transactionResult = baseResult;

  transactionResult = {
    ...baseResult,
    transaction: { signatures: [signature], message: { accountKeys: [
      BOT_WALLET, "11111111111111111111111111111112", "11111111111111111111111111111112"
    ] } }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /duplicate account keys/);
  transactionResult = baseResult;

  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      preTokenBalances: [{ ...baseResult.meta.preTokenBalances[0], accountIndex: -1 }]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /account index is malformed/);

  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      preTokenBalances: [{ ...baseResult.meta.preTokenBalances[0], accountIndex: 3 }]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /account index is malformed/);

  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      postTokenBalances: [
        { ...baseResult.meta.postTokenBalances[1] },
        { ...baseResult.meta.postTokenBalances[0], accountIndex: 2 }
      ]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /duplicate token account indexes/);

  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      postTokenBalances: [
        { ...baseResult.meta.postTokenBalances[0], uiTokenAmount: { amount: "0", decimals: 8 } },
        baseResult.meta.postTokenBalances[1]
      ]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /identity changed across pre\/post balances/);

  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      postTokenBalances: [
        { ...baseResult.meta.postTokenBalances[0], mint: outputMint },
        baseResult.meta.postTokenBalances[1]
      ]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /identity changed across pre\/post balances/);

  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      postTokenBalances: [
        { ...baseResult.meta.postTokenBalances[0], owner: "11111111111111111111111111111112" },
        baseResult.meta.postTokenBalances[1]
      ]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /identity changed across pre\/post balances/);

  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      postTokenBalances: [
        { ...baseResult.meta.postTokenBalances[0],
          programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" },
        baseResult.meta.postTokenBalances[1]
      ]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /identity changed across pre\/post balances/);

  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      preTokenBalances: [{ ...baseResult.meta.preTokenBalances[0], programId: "11111111111111111111111111111111" }]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /program ID is unsupported/);

  transactionResult = {
    ...baseResult,
    meta: {
      ...baseResult.meta,
      preTokenBalances: [{ ...baseResult.meta.preTokenBalances[0], uiTokenAmount: { amount: "1", decimals: 256 } }]
    }
  };
  await assert.rejects(verifyFinalizedJupiterSettlement(request, fetchImpl),
    /decimals are malformed/);
});


test("finalized settlement maps v0 token balance indexes after writable then readonly lookup addresses", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(13));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const result = {
    slot: 128,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          BOT_WALLET,
          "11111111111111111111111111111112",
          "11111111111111111111111111111113"
        ],
        addressTableLookups: [{
          accountKey: "11111111111111111111111111111114",
          writableIndexes: [0],
          readonlyIndexes: [1]
        }]
      }
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [100000, 0, 0, 0, 0],
      postBalances: [95000, 0, 0, 0, 0],
      loadedAddresses: {
        writable: ["11111111111111111111111111111115"],
        readonly: ["11111111111111111111111111111116"]
      },
      preTokenBalances: [
        { mint: inputMint, owner: BOT_WALLET, accountIndex: 3,
          uiTokenAmount: { amount: "10", decimals: 9 } },
        { mint: outputMint, owner: BOT_WALLET, accountIndex: 4,
          uiTokenAmount: { amount: "2", decimals: 6 } }
      ],
      postTokenBalances: [
        { mint: inputMint, owner: BOT_WALLET, accountIndex: 3,
          uiTokenAmount: { amount: "7", decimals: 9 } },
        { mint: outputMint, owner: BOT_WALLET, accountIndex: 4,
          uiTokenAmount: { amount: "5", decimals: 6 } }
      ]
    }
  };
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const value = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : result;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: value }), { status: 200 });
  };
  const proof = await verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "3", outputAmount: "3"
  }, fetchImpl);
  assert.equal(proof.verified, true);
  assert.equal(proof.proofScope, "finalized-owner-scoped-token-balance-deltas");
  assert.equal(proof.semanticInstructionVerification, false);
  assert.equal(proof.allInCostsVerified, false);
});

test("finalized settlement rejects v0 transactions missing loaded-address metadata", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(14));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const result = {
    slot: 129,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [BOT_WALLET],
        addressTableLookups: [{
          accountKey: "11111111111111111111111111111112",
          writableIndexes: [0],
          readonlyIndexes: []
        }]
      }
    },
    meta: {
      err: null, fee: 5000, preBalances: [100000], postBalances: [95000],
      preTokenBalances: [], postTokenBalances: []
    }
  };
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const value = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : result;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: value }), { status: 200 });
  };
  await assert.rejects(verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "1", outputAmount: "1"
  }, fetchImpl), /missing loaded address metadata/);
});


test("finalized v0 settlement rejects loaded-address counts inconsistent with lookup indexes", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(15));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const result = {
    slot: 130,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [BOT_WALLET],
        addressTableLookups: [{
          accountKey: "11111111111111111111111111111112",
          writableIndexes: [0, 1],
          readonlyIndexes: [2]
        }]
      }
    },
    meta: {
      err: null, fee: 5000,
      preBalances: [100000, 0, 0], postBalances: [95000, 0, 0],
      loadedAddresses: {
        writable: ["11111111111111111111111111111113"],
        readonly: ["11111111111111111111111111111114"]
      },
      preTokenBalances: [], postTokenBalances: []
    }
  };
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const value = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : result;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: value }), { status: 200 });
  };
  await assert.rejects(verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "1", outputAmount: "1"
  }, fetchImpl), /do not match address-table lookup indexes/);
});


test("settlement proof rejects owned token balances without an account index", async () => {
  const signature = encodeBase58(new Uint8Array(64).fill(16));
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const result = {
    slot: 131,
    transaction: {
      signatures: [signature],
      message: { accountKeys: [
        BOT_WALLET,
        "11111111111111111111111111111112",
        "11111111111111111111111111111113"
      ] }
    },
    meta: {
      err: null, fee: 5000, preBalances: [100000, 0, 0], postBalances: [95000, 0, 0],
      preTokenBalances: [{
        mint: inputMint, owner: BOT_WALLET,
        uiTokenAmount: { amount: "2", decimals: 9 }
      }],
      postTokenBalances: [{
        mint: inputMint, owner: BOT_WALLET, accountIndex: 1,
        uiTokenAmount: { amount: "1", decimals: 9 }
      }, {
        mint: outputMint, owner: BOT_WALLET, accountIndex: 2,
        uiTokenAmount: { amount: "1", decimals: 6 }
      }]
    }
  };
  const fetchImpl = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const value = method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : result;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: value }), { status: 200 });
  };
  await assert.rejects(verifyFinalizedJupiterSettlement({
    signature, inputMint, outputMint, inputAmount: "1", outputAmount: "1"
  }, fetchImpl), /missing its account index/);
});
