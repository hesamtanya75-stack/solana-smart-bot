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

async function decodedTransferFixture() {
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 1
    })]
  }).compileToLegacyMessage();
  const encodedTransaction = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  return { encodedTransaction, decoded: await decodeSolanaTransaction(encodedTransaction) };
}

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
    assert.equal(options.redirect, "error");
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

test("trusted RPC rejects oversized response bodies before unbounded buffering", async () => {
  const oversized = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1_000_001));
      controller.enqueue(new Uint8Array(1_000_001));
      controller.close();
    }
  }), { status: 200 });
  const rpc = createTrustedSolanaRpc({
    endpoint, expectedEndpoint: endpoint,
    fetchImpl: async () => oversized
  });
  await assert.rejects(() => rpc.getSlot(), /exceeds size limit/);

  const declaredOversized = {
    status: 200,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? "2000001" : null },
    body: new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
    })
  };
  const rpcWithDeclaredLength = createTrustedSolanaRpc({
    endpoint, expectedEndpoint: endpoint,
    fetchImpl: async () => declaredOversized
  });
  await assert.rejects(() => rpcWithDeclaredLength.getSlot(), /exceeds size limit/);
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
  const { encodedTransaction, decoded } = await decodedTransferFixture();
  const result = await inspectMetisOrderWithTrustedRpc({
    rpc: fixture.rpc,
    encodedTransaction,
    decoded,
    tokenAccountExpectations: [
      { address: fixture.keys[0], expectedTokenProgramId: fixture.tokenProgram, expectedMint: fixture.mintA, expectedAuthority: fixture.owner, minimumAmount: "1" },
      { address: fixture.keys[1], expectedTokenProgramId: fixture.tokenProgram, expectedMint: fixture.mintB, expectedAuthority: fixture.owner, minimumAmount: "1" }
    ],
    allowedCpiProgramIds: ["11111111111111111111111111111111"],
    allowedCpiAccountKeys: decoded.accountKeys,
    requiredCpiProgramIds: [decoded.accountKeys[2]],
    expectedCpiProgramIds: [decoded.accountKeys[2]],
    expectedCpiOuterInstructionIndexes: [0]
  });
  assert.equal(result.allowed, true);
  assert.equal(result.tokenAccounts.length, 2);
  assert.equal(result.cpi.instructionCount, 1);
  const simulationCall = fixture.requests.find(item => item.body.method === "simulateTransaction");
  assert.ok(simulationCall);
  assert.equal(simulationCall.body.params[1].replaceRecentBlockhash, false);
});

test("trusted order inspection rejects decoded metadata that differs from serialized transaction", async () => {
  const fixture = rpcFixture();
  const { encodedTransaction, decoded } = await decodedTransferFixture();
  const altered = { ...decoded, accountKeys: [...decoded.accountKeys].reverse() };
  await assert.rejects(() => inspectMetisOrderWithTrustedRpc({
    rpc: fixture.rpc, encodedTransaction, decoded: altered,
    tokenAccountExpectations: [
      { address: fixture.keys[0], expectedTokenProgramId: fixture.tokenProgram, expectedMint: fixture.mintA, expectedAuthority: fixture.owner, minimumAmount: "1" },
      { address: fixture.keys[1], expectedTokenProgramId: fixture.tokenProgram, expectedMint: fixture.mintB, expectedAuthority: fixture.owner, minimumAmount: "1" }
    ],
    allowedCpiProgramIds: [decoded.accountKeys[2]],
    allowedCpiAccountKeys: decoded.accountKeys,
    requiredCpiProgramIds: [decoded.accountKeys[2]],
    expectedCpiProgramIds: [decoded.accountKeys[2]],
    expectedCpiOuterInstructionIndexes: [0]
  }), /does not match the exact serialized transaction/);
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
  const { encodedTransaction, decoded } = await decodedTransferFixture();
  const expectations = [
    { address: bad.keys[0], expectedTokenProgramId: bad.tokenProgram, expectedMint: bad.mintA, expectedAuthority: bad.owner },
    { address: bad.keys[1], expectedTokenProgramId: bad.tokenProgram, expectedMint: bad.mintB, expectedAuthority: bad.owner }
  ];
  await assert.rejects(() => inspectMetisOrderWithTrustedRpc({
    rpc: bad.rpc, encodedTransaction, decoded,
    tokenAccountExpectations: expectations,
    allowedCpiProgramIds: [decoded.accountKeys[2]],
    allowedCpiAccountKeys: decoded.accountKeys,
    requiredCpiProgramIds: [decoded.accountKeys[2]],
    expectedCpiProgramIds: [decoded.accountKeys[2]],
    expectedCpiOuterInstructionIndexes: [0]
  }), /stale or inconsistent|authority does not match|not found|mint does not match/);
});

test("trusted RPC rejects ALT account responses with missing executable or invalid lamports metadata", async () => {
  for (const value of [
    { owner: AddressLookupTableProgram.programId.toBase58(), data: [Buffer.alloc(56).toString("base64"), "base64"], lamports: 1 },
    { owner: AddressLookupTableProgram.programId.toBase58(), data: [Buffer.alloc(56).toString("base64"), "base64"], executable: false, lamports: -1 }
  ]) {
    const rpc = createTrustedSolanaRpc({
      endpoint, expectedEndpoint: endpoint,
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: request.id,
          result: { context: { slot: 100 }, value }
        }), { status: 200 });
      }
    });
    await assert.rejects(
      () => rpc.getAccountInfoAndContext(Keypair.generate().publicKey),
      /invalid ALT account response/
    );
  }
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
  // Solana ALT account data starts with the u32 LookupTable enum tag;
  // the metadata fields therefore begin at byte offset 4.
  tableData.writeUInt32LE(1, 0);
  tableData.writeBigUInt64LE((1n << 64n) - 1n, 4);
  tableData.writeBigUInt64LE(1000n, 12);
  tableData.writeUInt8(0, 20);
  tableData.writeUInt8(0, 21);
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


test("trusted RPC reads bounded raw account data at the requested context slot", async () => {
  const keys = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  const owner = SystemProgram.programId.toBase58();
  let request;
  const rpc = createTrustedSolanaRpc({
    endpoint, expectedEndpoint: endpoint,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        result: {
          context: { slot: 1200 },
          value: [
            { owner, data: [Buffer.from([1, 2, 3]).toString("base64"), "base64"], executable: false, lamports: 1000, rentEpoch: 4 },
            null
          ]
        }
      }), { status: 200 });
    }
  });
  const result = await rpc.getMultipleRawAccountInfos(keys, { minContextSlot: 1190 });
  assert.equal(request.method, "getMultipleAccounts");
  assert.equal(request.params[1].encoding, "base64");
  assert.equal(request.params[1].minContextSlot, 1190);
  assert.equal(result.context.slot, 1200);
  assert.deepEqual([...result.value[0].data], [1, 2, 3]);
  assert.equal(result.value[0].owner.toBase58(), owner);
  assert.equal(result.value[1], null);
});

test("trusted RPC raw account reader rejects stale context, invalid metadata, and malformed base64", async () => {
  const key = Keypair.generate().publicKey.toBase58();
  const owner = SystemProgram.programId.toBase58();
  for (const result of [
    { context: { slot: 99 }, value: [{ owner, data: ["AQ==", "base64"], executable: false, lamports: 1 }] },
    { context: { slot: 100 }, value: [{ owner, data: ["%%%=", "base64"], executable: false, lamports: 1 }] },
    { context: { slot: 100 }, value: [{ owner, data: ["AQ==", "base64"], executable: "false", lamports: 1 }] },
    { context: { slot: 100 }, value: [{ owner, data: ["AQ==", "base64"], executable: false, lamports: -1 }] }
  ]) {
    const rpc = createTrustedSolanaRpc({
      endpoint, expectedEndpoint: endpoint,
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
      }
    });
    await assert.rejects(() => rpc.getMultipleRawAccountInfos([key], { minContextSlot: 100 }));
  }
});

test("trusted RPC raw account reader rejects oversized account lists before network access", async () => {
  let called = false;
  const rpc = createTrustedSolanaRpc({
    endpoint, expectedEndpoint: endpoint,
    fetchImpl: async () => { called = true; throw new Error("unexpected request"); }
  });
  const keys = Array.from({ length: 17 }, () => Keypair.generate().publicKey.toBase58());
  await assert.rejects(() => rpc.getMultipleRawAccountInfos(keys), /request is invalid/);
  assert.equal(called, false);
});


test("trusted RPC inspects upgradeable Program and large ProgramData in a consistent context", async () => {
  const programId = Keypair.generate().publicKey;
  const programDataAddress = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const loader = "BPFLoaderUpgradeab1e11111111111111111111111";
  const programData = Buffer.alloc(45 + 610_000);
  programData.writeUInt32LE(3, 0);
  programData.writeBigUInt64LE(119721738n, 4);
  programData[12] = 1;
  authority.toBuffer().copy(programData, 13);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(programData, 45);
  const program = Buffer.alloc(36);
  program.writeUInt32LE(2, 0);
  programDataAddress.toBuffer().copy(program, 4);
  const makeRaw = (data, executable) => ({
    owner: loader, executable, lamports: 1,
    data: [data.toString("base64"), "base64"]
  });
  const requests = [];
  const rpc = createTrustedSolanaRpc({
    endpoint, expectedEndpoint: endpoint,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      assert.equal(request.method, "getMultipleAccounts");
      const keys = request.params[0];
      const value = keys.length === 1
        ? [makeRaw(program, true)]
        : [makeRaw(program, true), makeRaw(programData, false)];
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        result: { context: { slot: keys.length === 1 ? 1200 : 1201 }, value }
      }), { status: 200 });
    }
  });
  const result = await rpc.inspectUpgradeableProgram(programId.toBase58(), { minContextSlot: 1190 });
  assert.equal(result.programDataAddress, programDataAddress.toBase58());
  assert.equal(result.deploymentSlot, "119721738");
  assert.equal(result.upgradeAuthority, authority.toBase58());
  assert.equal(result.contextSlot, 1201);
  assert.equal(result.executableLength, 610_000);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].params[1].minContextSlot, 1200);
});

test("trusted RPC upgradeable program inspection rejects a changed ProgramData pointer", async () => {
  const programId = Keypair.generate().publicKey;
  const firstData = Keypair.generate().publicKey;
  const changedData = Keypair.generate().publicKey;
  const loader = "BPFLoaderUpgradeab1e11111111111111111111111";
  const makeProgram = (dataAddress) => {
    const data = Buffer.alloc(36);
    data.writeUInt32LE(2, 0);
    dataAddress.toBuffer().copy(data, 4);
    return { owner: loader, executable: true, lamports: 1, data: [data.toString("base64"), "base64"] };
  };
  const rpc = createTrustedSolanaRpc({
    endpoint, expectedEndpoint: endpoint,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const value = request.params[0].length === 1
        ? [makeProgram(firstData)]
        : [makeProgram(changedData), null];
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        result: { context: { slot: 2000 }, value }
      }), { status: 200 });
    }
  });
  await assert.rejects(
    () => rpc.inspectUpgradeableProgram(programId.toBase58()),
    /pointer changed or snapshot is inconsistent/
  );
});
