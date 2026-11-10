import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction
} from "@solana/web3.js";
import {
  getJupiterOrder, EXPECTED_BOT_WALLET, SOL_MINT
} from "../live-trading.mjs";
import {
  JUPITER_V6_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID
} from "../solana-metis-validator.mjs";
import { createTrustedSolanaRpc } from "../solana-trusted-rpc.mjs";
import { decodeSolanaTransaction } from "../solana-transaction-decoder.mjs";

const wallet = new PublicKey(EXPECTED_BOT_WALLET);
const outputMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const sourceToken = Keypair.generate().publicKey;
const destinationToken = Keypair.generate().publicKey;
const programAuthority = Keypair.generate().publicKey;
const programSource = Keypair.generate().publicKey;
const programDestination = Keypair.generate().publicKey;
const feeAccount = Keypair.generate().publicKey;
const dexProgram = Keypair.generate().publicKey;
const amm = Keypair.generate().publicKey;
const slippageBps = 50;
const inAmount = 1000000n;
const outAmount = 12345n;

function routeData() {
  const data = Buffer.alloc(8 + 1 + 4 + 4 + 8 + 8 + 2 + 1);
  Buffer.from([123, 141, 210, 115, 241, 229, 15, 101]).copy(data, 0);
  let offset = 8;
  data.writeUInt8(0, offset++); // route id
  data.writeUInt32LE(1, offset); offset += 4;
  data.writeUInt8(0, offset++); // Saber enum variant
  data.writeUInt8(100, offset++); // percent
  data.writeUInt8(0, offset++); // input token index
  data.writeUInt8(1, offset++); // output token index
  data.writeBigUInt64LE(inAmount, offset); offset += 8;
  data.writeBigUInt64LE(outAmount, offset); offset += 8;
  data.writeUInt16LE(slippageBps, offset); offset += 2;
  data.writeUInt8(0, offset);
  return data;
}

function buildTransaction() {
  const keys = [
    { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    { pubkey: programAuthority, isSigner: false, isWritable: false },
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: sourceToken, isSigner: false, isWritable: true },
    { pubkey: programSource, isSigner: false, isWritable: true },
    { pubkey: programDestination, isSigner: false, isWritable: true },
    { pubkey: destinationToken, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(SOL_MINT), isSigner: false, isWritable: false },
    { pubkey: outputMint, isSigner: false, isWritable: false },
    { pubkey: feeAccount, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: false },
    { pubkey: dexProgram, isSigner: false, isWritable: false },
    { pubkey: amm, isSigner: false, isWritable: true }
  ];
  const instruction = new TransactionInstruction({
    programId: new PublicKey(JUPITER_V6_PROGRAM_ID),
    keys,
    data: routeData()
  });
  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [instruction]
  }).compileToLegacyMessage();
  const encoded = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  return encoded;
}

function tokenAccount(mint, amount, isNative = false) {
  return {
    owner: TOKEN_PROGRAM_ID,
    data: { program: "spl-token", parsed: { type: "account", info: {
      mint, owner: EXPECTED_BOT_WALLET, state: "initialized",
      delegate: null, closeAuthority: null, isNative,
      tokenAmount: { amount: String(amount), decimals: 6 }, extensions: []
    } } }
  };
}

test("getJupiterOrder binds Metis route, trusted parsed token accounts, and CPI simulation", async () => {
  const encoded = buildTransaction();
  const decoded = await decodeSolanaTransaction(encoded);
  const dexIndex = decoded.accountKeys.indexOf(dexProgram.toBase58());
  const sourceIndex = decoded.accountKeys.indexOf(sourceToken.toBase58());
  const destinationIndex = decoded.accountKeys.indexOf(destinationToken.toBase58());
  const endpoint = "https://trusted-rpc.example/";
  const trustedRpc = createTrustedSolanaRpc({
    endpoint,
    expectedEndpoint: endpoint,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      let result;
      if (request.method === "getBlockHeight") result = 999999900;
      else if (request.method === "getSlot") result = 1100;
      else if (request.method === "getMultipleAccounts") result = {
        context: { slot: 1100 },
        value: [
          tokenAccount(SOL_MINT, "2000000", true),
          tokenAccount(outputMint.toBase58(), "0")
        ]
      };
      else if (request.method === "simulateTransaction") result = {
        context: { slot: 1100 },
        value: {
          err: null,
          innerInstructions: [{
            index: 0,
            instructions: [{
              programIdIndex: dexIndex,
              accounts: [sourceIndex, destinationIndex, decoded.accountKeys.indexOf(amm.toBase58())]
            }]
          }]
        }
      };
      else throw new Error("unexpected RPC method " + request.method);
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: request.id, result
      }), { status: 200 });
    }
  });
  const env = {
    LIVE_TRADING_ENABLED: "true", LIVE_TRADING_KILL_SWITCH: "false",
    BOT_WALLET_PUBLIC_KEY: EXPECTED_BOT_WALLET,
    LIVE_MAX_TRADE_LAMPORTS: "10000000", LIVE_MAX_DAILY_LAMPORTS: "50000000",
    LIVE_MAX_SLIPPAGE_BPS: "50", LIVE_MIN_LIQUIDITY_USD: "10000",
    LIVE_MIN_VOLUME_24H_USD: "1000", LIVE_MAX_OPEN_POSITIONS: "10",
    JUPITER_API_KEY: "test-only"
  };
  const order = {
    requestId: "metis-integration-test", transaction: encoded, router: "metis",
    mode: "manual", swapMode: "ExactIn", transactionVersion: 0,
    gasless: false, signatureFeePayer: EXPECTED_BOT_WALLET,
    feeBps: 0, feeMint: SOL_MINT, otherAmountThreshold: "12000",
    slippageBps, lastValidBlockHeight: "999999999",
    inputMint: SOL_MINT, outputMint: outputMint.toBase58(),
    inAmount: String(inAmount), outAmount: String(outAmount),
    routePlan: [{
      swapInfo: {
        ammKey: amm.toBase58(), label: "Saber",
        inputMint: SOL_MINT, outputMint: outputMint.toBase58(),
        inAmount: String(inAmount), outAmount: String(outAmount)
      },
      percent: 100, bps: 10000
    }]
  };
  const result = await getJupiterOrder({
    env,
    outputMint: outputMint.toBase58(),
    amountLamports: Number(inAmount),
    eligibility: {
      dailySpentLamports: 0, openPositions: 0, liquidityUsd: 25000, volume24hUsd: 5000,
      riskDataFetchedAtMs: Date.now(), marketDataFetchedAtMs: Date.now(),
      riskChecks: {
        mintAuthoritySafe: true, freezeAuthoritySafe: true,
        token2022ExtensionsSafe: true, holderConcentrationSafe: true,
        sellRouteAvailable: true
      }
    },
    trustedRpc,
    transactionAllowList: {
      allowedRouters: ["metis"],
      requiredAccounts: [EXPECTED_BOT_WALLET, sourceToken.toBase58(), destinationToken.toBase58()],
      allowedProgramIds: [JUPITER_V6_PROGRAM_ID],
      allowedAccountKeys: decoded.accountKeys,
      allowedWritableAccountKeys: decoded.accountMetadata.filter(x => x.isWritable).map(x => x.pubkey),
      instructionValidators: {}
    },
    metisPolicy: {
      dexProgramBySwapVariant: { "0": dexProgram.toBase58() },
      dexLabelsBySwapVariant: { "0": ["Saber"] },
      allowedDexProgramIds: [dexProgram.toBase58()],
      allowedCpiProgramIds: [dexProgram.toBase58()],
      allowedCpiAccountKeys: decoded.accountKeys,
      supportingCpiProgramIds: []
    },
    fetchImpl: async () => new Response(JSON.stringify(order), {
      status: 200, headers: { "Content-Type": "application/json" }
    })
  });
  assert.equal(result.metisInstruction.instructionName, "sharedAccountsRouteV2");
  assert.equal(result.rpcInspection.allowed, true);
  assert.deepEqual(result.rpcInspection.cpi.programIds, [dexProgram.toBase58()]);
  assert.equal("transaction" in result, false);
});

