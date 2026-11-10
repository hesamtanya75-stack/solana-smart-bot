import test from "node:test";
import assert from "node:assert/strict";
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
      context: { slot: 1099 }, value: [makeAccount(mintA), makeAccount(mintB)]
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
    allowedCpiAccountKeys: decoded.accountKeys
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
    allowedCpiAccountKeys: decoded.accountKeys
  }), /authority does not match|not found|mint does not match/);
});
