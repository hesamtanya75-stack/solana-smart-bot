import test from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount, AddressLookupTableProgram, Keypair,
  PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import { decodeSolanaTransaction } from "../solana-transaction-decoder.mjs";
import { createTrustedSolanaRpc, inspectMetisOrderWithTrustedRpc } from "../solana-trusted-rpc.mjs";

const endpoint = "https://trusted-rpc.example/";

function rpcFixture(overrides = {}) {
  let id = 0;
  const requests = [];
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const mintA = "So11111111111111111111111111111111111111112";
  const mintB = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const owner = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
  const keys = ["11111111111111111111111111111112", "11111111111111111111111111111113"];
  const makeAccount = (mint) => ({
    owner: tokenProgram,
    data: { program: "spl-token", parsed: { type: "account", info: {
      mint, owner, state: "initialized", delegate: null, closeAuthority: null,
      isNative: false, tokenAmount: { amount: "1000000", decimals: 6 }, extensions: []
    } } }
  });
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const request = requests.at(-1).body;
    let result;
    if (request.method === "getSlot" || request.method === "getBlockHeight") result = 1100;
    else if (request.method === "getMultipleAccounts") result = {
      context: { slot: 1100 }, value: [makeAccount(mintA), makeAccount(mintB)]
    };
    else if (request.method === "simulateTransaction") result = {
      context: { slot: 1100 },
      value: { err: null, innerInstructions: [{ index: 0, instructions: [{
        programIdIndex: 2, accounts: [0, 1]
      }] }] }
    };
    else throw new Error("unexpected method");
    const payload = overrides[request.method] ?? result;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: payload }), { status: 200 });
  };
  return { rpc: createTrustedSolanaRpc({ endpoint, expectedEndpoint: endpoint, fetchImpl }), requests, keys, tokenProgram, mintA, mintB, owner };
}

test("trusted RPC client pins exact HTTPS endpoint and rejects endpoint substitution", () => {
  assert.throws(() => createTrustedSolanaRpc({
    endpoint: "https://attacker.example", expectedEndpoint: endpoint
  }), /does not match/);
  assert.throws(() => createTrustedSolanaRpc({
    endpoint: "http://trusted-rpc.example", expectedEndpoint: "http://trusted-rpc.example"
  }), /HTTPS/);
});

test("trusted RPC calls validate JSON-RPC and request token accounts with minContextSlot", async () => {
  const fixture = rpcFixture();
  const slot = await fixture.rpc.getSlot();
  assert.equal(slot, 1100);
  await fixture.rpc.getMultipleParsedTokenAccounts(fixture.keys, { minContextSlot: 1080 });
  const call = fixture.requests.find(item => item.body.method === "getMultipleAccounts");
  assert.equal(call.body.params[1].minContextSlot, 1080);
  assert.equal(call.body.params[1].encoding, "jsonParsed");
});

test("trusted order inspection validates source/destination accounts and exact-transaction CPI trace", async () => {
  const fixture = rpcFixture();
  const decoded = {
    instructions: [{ programId: "11111111111111111111111111111111", accounts: [] }],
    accountKeys: [
      "11111111111111111111111111111112",
      "11111111111111111111111111111113",
      "11111111111111111111111111111111"
    ]
  };
  const result = await inspectMetisOrderWithTrustedRpc({
    rpc: fixture.rpc,
    encodedTransaction: "AQ==",
    decoded,
    tokenAccountExpectations: [
      { address: fixture.keys[0], expectedTokenProgramId: fixture.tokenProgram, expectedMint: fixture.mintA, expectedAuthority: fixture.owner, minimumAmount: "1" },
      { address: fixture.keys[1], expectedTokenProgramId: fixture.tokenProgram, expectedMint: fixture.mintB, expectedAuthority: fixture.owner, minimumAmount: "1" }
    ],
    allowedCpiProgramIds: ["11111111111111111111111111111111"],
    allowedCpiAccountKeys: decoded.accountKeys,
    requiredCpiProgramIds: [decoded.accountKeys[2]],
    expectedCpiProgramIds: [decoded.accountKeys[2]]
  });
  assert.equal(result.allowed, true);
  assert.equal(result.tokenAccounts.length, 2);
  assert.equal(result.cpi.instructionCount, 1);
  assert.equal(fixture.requests.some(item => item.body.method === "simulateTransaction"), true);
});

test("trusted order inspection fails closed on account identity mismatch and failed simulation", async () => {
  const wrongAccount = {
    context: { slot: 1099 },
    value: [{
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: { program: "spl-token", parsed: { type: "account", info: {
        mint: "So11111111111111111111111111111111111111112",
        owner: "11111111111111111111111111111112", state: "initialized",
        delegate: null, closeAuthority: null, isNative: false,
        tokenAmount: { amount: "1000", decimals: 9 }, extensions: []
      } } }
    }, null]
  };
  const bad = rpcFixture({ getMultipleAccounts: wrongAccount });
  const decoded = { instructions: [{ programId: "11111111111111111111111111111111", accounts: [] }], accountKeys: ["11111111111111111111111111111112", "11111111111111111111111111111113", "11111111111111111111111111111111"] };
  const expectations = [
    { address: bad.keys[0], expectedTokenProgramId: bad.tokenProgram, expectedMint: bad.mintA, expectedAuthority: bad.owner },
    { address: bad.keys[1], expectedTokenProgramId: bad.tokenProgram, expectedMint: bad.mintB, expectedAuthority: bad.owner }
  ];
  await assert.rejects(() => inspectMetisOrderWithTrustedRpc({
    rpc: bad.rpc, encodedTransaction: "AQ==", decoded,
    tokenAccountExpectations: expectations,
    allowedCpiProgramIds: [decoded.accountKeys[2]],
    allowedCpiAccountKeys: decoded.accountKeys,
    requiredCpiProgramIds: [decoded.accountKeys[2]],
    expectedCpiProgramIds: [decoded.accountKeys[2]]
  }), /stale or inconsistent|authority does not match|not found|mint does not match/);
});

test("trusted RPC ALT resolver loads the exact v0 lookup table and decoder records loaded account provenance", async () => {
  const payer = Keypair.generate();
  const tableKey = Keypair.generate().publicKey;
  const loadedAddress = Keypair.generate().publicKey;
  const state = {
    deactivationSlot: (1n << 64n) - 1n,
    lastExtendedSlot: 1000n,
    lastExtendedSlotStartIndex: 0,
    authority: undefined,
    addresses: [loadedAddress]
  };
  const table = new AddressLookupTableAccount({ key: tableKey, state });
  const instruction = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: loadedAddress,
    lamports: 55
  });
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instruction]
  }).compileToV0Message([table]);
  const encoded = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

  const tableData = Buffer.alloc(56 + 32);
  tableData.writeBigUInt64LE((1n << 64n) - 1n, 0);
  tableData.writeBigUInt64LE(1000n, 8);
  tableData.writeUInt8(0, 16);
  tableData.writeUInt8(0, 17);
  loadedAddress.toBuffer().copy(tableData, 56);
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    let result;
    if (request.method === "getSlot") result = 1100;
    else if (request.method === "getAccountInfo") {
      assert.equal(request.params[0], tableKey.toBase58());
      assert.equal(request.params[1].encoding, "base64");
      assert.equal(request.params[1].minContextSlot, 1090);
      result = {
      context: { slot: 1098 },
      value: {
        owner: AddressLookupTableProgram.programId.toBase58(),
        data: [tableData.toString("base64"), "base64"],
        executable: false, lamports: 1000000, rentEpoch: 0
      }
      };
    } else throw new Error("unexpected RPC method " + request.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
  };
  const rpc = createTrustedSolanaRpc({ endpoint, expectedEndpoint: endpoint, fetchImpl });
  const decoded = await decodeSolanaTransaction(encoded, {
    lookupTableResolver: (key) => rpc.resolveAddressLookupTable(key, { minContextSlot: 1090 })
  });
  assert.ok(decoded.accountKeys.includes(loadedAddress.toBase58()));
  const metadata = decoded.accountMetadata.find((item) => item.pubkey === loadedAddress.toBase58());
  assert.equal(metadata.source.type, "lookupTable");
  assert.equal(metadata.source.table, tableKey.toBase58());
  assert.equal(metadata.source.access, "writable");
  assert.equal(metadata.isWritable, true);
});
