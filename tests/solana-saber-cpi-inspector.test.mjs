import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  createTrustedSolanaRpc,
  inspectSaberCpiAfterSimulation
} from "../solana-trusted-rpc.mjs";
import {
  SABER_STABLE_SWAP_PROGRAM_ID,
  SABER_TOKEN_PROGRAM_ID
} from "../solana-saber-validator.mjs";
import {
  JUPITER_V6_PROGRAM_ID,
  deriveJupiterProgramAuthorityId
} from "../solana-jupiter-authority.mjs";

const endpoint = "https://trusted-rpc.example/";

function makeFixture({ missingAccountIndex = null, slot = 1300 } = {}) {
  const pool = Keypair.generate().publicKey;
  const programAuthority = deriveJupiterProgramAuthorityId(0);
  const wallet = Keypair.generate().publicKey;
  const reserveA = Keypair.generate().publicKey;
  const reserveB = Keypair.generate().publicKey;
  const mintA = Keypair.generate().publicKey;
  const mintB = Keypair.generate().publicKey;
  const feeA = Keypair.generate().publicKey;
  const feeB = Keypair.generate().publicKey;
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const tokenProgram = new PublicKey(SABER_TOKEN_PROGRAM_ID);

  let nonce;
  let saberAuthority;
  for (let candidate = 0; candidate < 256; candidate += 1) {
    try {
      saberAuthority = PublicKey.createProgramAddressSync(
        [pool.toBuffer(), Buffer.from([candidate])],
        new PublicKey(SABER_STABLE_SWAP_PROGRAM_ID)
      );
      nonce = candidate;
      break;
    } catch {}
  }
  assert.ok(saberAuthority);

  const accounts = [
    pool.toBase58(), saberAuthority.toBase58(), programAuthority,
    source.toBase58(), reserveA.toBase58(), reserveB.toBase58(),
    destination.toBase58(), feeB.toBase58(), tokenProgram.toBase58()
  ];
  const state = Buffer.alloc(395);
  state[0] = 1;
  state[1] = 0;
  state[2] = nonce;
  state.writeBigUInt64LE(100n, 3);
  state.writeBigUInt64LE(100n, 11);
  reserveA.toBuffer().copy(state, 107);
  reserveB.toBuffer().copy(state, 139);
  Keypair.generate().publicKey.toBuffer().copy(state, 171);
  mintA.toBuffer().copy(state, 203);
  mintB.toBuffer().copy(state, 235);
  feeA.toBuffer().copy(state, 267);
  feeB.toBuffer().copy(state, 299);
  for (let i = 0; i < 8; i += 2) state.writeBigUInt64LE(0n, 331 + i * 8);
  for (let i = 1; i < 8; i += 2) state.writeBigUInt64LE(10000n, 331 + i * 8);

  const mintData = () => {
    const data = Buffer.alloc(82);
    data[44] = 6;
    data[45] = 1;
    return data;
  };
  const tokenData = (mint, owner, amount) => {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data, 0);
    new PublicKey(owner).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(BigInt(amount), 64);
    data[108] = 1;
    return data;
  };

  const raw = new Map([
    [accounts[0], { owner: new PublicKey(SABER_STABLE_SWAP_PROGRAM_ID), data: state, executable: false }],
    [accounts[3], { owner: tokenProgram, data: tokenData(mintA, programAuthority, 1000), executable: false }],
    [accounts[4], { owner: tokenProgram, data: tokenData(mintA, saberAuthority, 5000), executable: false }],
    [accounts[5], { owner: tokenProgram, data: tokenData(mintB, saberAuthority, 6000), executable: false }],
    [accounts[6], { owner: tokenProgram, data: tokenData(mintB, programAuthority, 0), executable: false }],
    [accounts[7], { owner: tokenProgram, data: tokenData(mintB, Keypair.generate().publicKey, 0), executable: false }],
    [mintA.toBase58(), { owner: tokenProgram, data: mintData(), executable: false }],
    [mintB.toBase58(), { owner: tokenProgram, data: mintData(), executable: false }]
  ]);
  if (Number.isInteger(missingAccountIndex)) raw.delete(accounts[missingAccountIndex]);

  const outerAccounts = [
    tokenProgram.toBase58(), programAuthority, wallet.toBase58(), source.toBase58(),
    reserveA.toBase58(), reserveB.toBase58(), destination.toBase58(),
    mintA.toBase58(), mintB.toBase58(), feeB.toBase58(),
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  ];
  const accountKeys = [...new Set([...outerAccounts, ...accounts, mintA.toBase58(), mintB.toBase58()])];
  const writable = new Set([accounts[3], accounts[4], accounts[5], accounts[6], accounts[7]]);
  const metadata = accountKeys.map((pubkey, index) => ({
    pubkey, index, isSigner: pubkey === wallet.toBase58(), isWritable: writable.has(pubkey)
  }));
  const outer = {
    index: 0,
    programId: JUPITER_V6_PROGRAM_ID,
    accounts: outerAccounts,
    accountIndexes: outerAccounts.map((key) => accountKeys.indexOf(key)),
    dataBase64: ""
  };
  const instructionData = Buffer.alloc(17);
  instructionData[0] = 1;
  instructionData.writeBigUInt64LE(50n, 1);
  instructionData.writeBigUInt64LE(40n, 9);
  const transferData = (amount) => {
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(BigInt(amount), 1);
    return bs58.encode(data);
  };

  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.method, "getMultipleAccounts");
    assert.equal(request.params[1].encoding, "base64");
    requests.push(request);
    const values = request.params[0].map((key) => {
      const account = raw.get(key);
      if (!account) return null;
      return {
        owner: account.owner.toBase58(),
        executable: account.executable,
        lamports: 1,
        rentEpoch: 0,
        data: [account.data.toString("base64"), "base64"]
      };
    });
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      result: { context: { slot }, value: values }
    }), { status: 200 });
  };
  const rpc = createTrustedSolanaRpc({ endpoint, expectedEndpoint: endpoint, fetchImpl });
  const cpiInstructions = [
    {
      outerInstructionIndex: 0,
      programId: SABER_STABLE_SWAP_PROGRAM_ID,
      accounts,
      data: bs58.encode(instructionData)
    },
    {
      outerInstructionIndex: 0,
      programId: SABER_TOKEN_PROGRAM_ID,
      accounts: [accounts[3], accounts[4], accounts[2]],
      data: transferData(50)
    },
    {
      outerInstructionIndex: 0,
      programId: SABER_TOKEN_PROGRAM_ID,
      accounts: [accounts[5], accounts[6], accounts[1]],
      data: transferData(45)
    },
    {
      outerInstructionIndex: 0,
      programId: SABER_TOKEN_PROGRAM_ID,
      accounts: [accounts[5], accounts[7], accounts[1]],
      data: transferData(1)
    }
  ];
  const decoded = { instructions: [outer], accountKeys, accountMetadata: metadata };
  return {
    rpc, decoded, cpiInstructions, accounts, pool: pool.toBase58(),
    programAuthority, requests, mintA: mintA.toBase58(), mintB: mintB.toBase58()
  };
}

test("post-simulation Saber inspector binds CPI pool, Jupiter PDA, and one consistent raw-account snapshot", async () => {
  const f = makeFixture();
  const result = await inspectSaberCpiAfterSimulation({
    rpc: f.rpc,
    decoded: f.decoded,
    cpiInstructions: f.cpiInstructions,
    simulationContextSlot: 1200,
    expectedOuterInstructionIndexes: [0],
    expectedPoolKeys: [f.pool]
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].allowed, true);
  assert.equal(result[0].direction, "A_TO_B");
  assert.equal(result[0].simulatedAmountIn, "50");
  assert.equal(result[0].simulatedAmountOut, "45");
  assert.equal(result[0].simulatedAdminFee, "1");
  assert.equal(result[0].simulationContextSlot, 1200);
  assert.equal(result[0].accountContextSlot, 1300);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].params[0][0], f.pool);
  assert.equal(f.requests[1].params[1].minContextSlot, 1300);
});

test("post-simulation Saber inspector rejects a CPI authority other than the Jupiter program PDA", async () => {
  const f = makeFixture();
  const altered = f.cpiInstructions.map((item) => ({
    ...item, accounts: [...item.accounts]
  }));
  altered[0].accounts[2] = f.decoded.instructions[0].accounts[2];
  await assert.rejects(() => inspectSaberCpiAfterSimulation({
    rpc: f.rpc, decoded: f.decoded, cpiInstructions: altered,
    simulationContextSlot: 1200,
    expectedOuterInstructionIndexes: [0],
    expectedPoolKeys: [f.pool]
  }), /Jupiter program-authority binding/);
});

test("post-simulation Saber inspector rejects quote pool mismatch and missing raw vault data", async () => {
  const f = makeFixture();
  await assert.rejects(() => inspectSaberCpiAfterSimulation({
    rpc: f.rpc, decoded: f.decoded, cpiInstructions: f.cpiInstructions,
    simulationContextSlot: 1200,
    expectedOuterInstructionIndexes: [0],
    expectedPoolKeys: [Keypair.generate().publicKey.toBase58()]
  }), /exactly one simulated Saber CPI/);

  const missing = makeFixture({ missingAccountIndex: 5 });
  await assert.rejects(() => inspectSaberCpiAfterSimulation({
    rpc: missing.rpc, decoded: missing.decoded,
    cpiInstructions: missing.cpiInstructions,
    simulationContextSlot: 1200,
    expectedOuterInstructionIndexes: [0],
    expectedPoolKeys: [missing.pool]
  }), /raw account data is missing/);
});

test("post-simulation Saber inspector rejects stale raw-account snapshots", async () => {
  const f = makeFixture({ slot: 1199 });
  await assert.rejects(() => inspectSaberCpiAfterSimulation({
    rpc: f.rpc, decoded: f.decoded, cpiInstructions: f.cpiInstructions,
    simulationContextSlot: 1200,
    expectedOuterInstructionIndexes: [0],
    expectedPoolKeys: [f.pool]
  }), /incomplete or stale/);
});

test("post-simulation Saber inspector rejects incorrect input, output, or admin-fee token transfers", async () => {
  const belowMinimum = makeFixture();
  const badOutput = belowMinimum.cpiInstructions.map((item) => ({ ...item, accounts: [...item.accounts] }));
  const outputData = Buffer.alloc(9);
  outputData[0] = 3;
  outputData.writeBigUInt64LE(39n, 1);
  badOutput[2].data = bs58.encode(outputData);
  await assert.rejects(() => inspectSaberCpiAfterSimulation({
    rpc: belowMinimum.rpc, decoded: belowMinimum.decoded,
    cpiInstructions: badOutput, simulationContextSlot: 1200,
    expectedOuterInstructionIndexes: [0], expectedPoolKeys: [belowMinimum.pool]
  }), /do not satisfy Swap input, slippage, or reserve bounds/);

  const wrongAuthority = makeFixture();
  const badFee = wrongAuthority.cpiInstructions.map((item) => ({ ...item, accounts: [...item.accounts] }));
  badFee[3].accounts[2] = wrongAuthority.decoded.instructions[0].accounts[2];
  await assert.rejects(() => inspectSaberCpiAfterSimulation({
    rpc: wrongAuthority.rpc, decoded: wrongAuthority.decoded,
    cpiInstructions: badFee, simulationContextSlot: 1200,
    expectedOuterInstructionIndexes: [0], expectedPoolKeys: [wrongAuthority.pool]
  }), /exactly the three source, output, and admin-fee token transfers/);
});
