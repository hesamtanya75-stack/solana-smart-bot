import test from "node:test";
import assert from "node:assert/strict";
import {
  JUPITER_V6_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  validateMetisJupiterV6Instruction
} from "../solana-metis-validator.mjs";

const wallet = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const source = "11111111111111111111111111111112";
const destination = "11111111111111111111111111111113";
const sourceMint = "So11111111111111111111111111111111111111112";
const destinationMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const dexProgram = "11111111111111111111111111111111";
const amm = "11111111111111111111111111111114";

function fixture(overrides = {}) {
  const data = Buffer.from([
    123, 141, 210, 115, 241, 229, 15, 101, // sharedAccountsRouteV2
    0, // id
    1, 0, 0, 0, // one RoutePlanStep
    0, 100, 0, 1, // Saber, 100%, token indexes 0 -> 1
    64, 66, 15, 0, 0, 0, 0, 0, // 1,000,000 input
    57, 48, 0, 0, 0, 0, 0, 0, // 12,345 output
    50, 0, // slippage 50 bps
    0 // no platform fee
  ]);
  const instruction = {
    index: 0, programId: JUPITER_V6_PROGRAM_ID,
    accounts: [TOKEN_PROGRAM_ID, "11111111111111111111111111111115", wallet, source,
      "11111111111111111111111111111116", "11111111111111111111111111111117",
      destination, sourceMint, destinationMint, "11111111111111111111111111111118",
      TOKEN_2022_PROGRAM_ID, dexProgram, amm],
    accountIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    dataBase64: data.toString("base64")
  };
  const decoded = {
    instructions: [instruction],
    accountMetadata: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: instruction.accounts[1], isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: instruction.accounts[4], isSigner: false, isWritable: true },
      { pubkey: instruction.accounts[5], isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: sourceMint, isSigner: false, isWritable: false },
      { pubkey: destinationMint, isSigner: false, isWritable: false },
      { pubkey: instruction.accounts[9], isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }
    ]
  };
  Object.assign(instruction, overrides.instruction || {});
  return {
    decoded, instruction,
    args: {
      expectedSigner: wallet, inputMint: sourceMint, outputMint: destinationMint,
      inAmount: "1000000", outAmount: "12345", slippageBps: 50,
      platformFeeBps: 0,
      routePlan: [{ swapInfo: { label: "TestDEX", ammKey: amm }, percent: 100 }],
      dexProgramBySwapVariant: { "0": dexProgram },
      dexLabelsBySwapVariant: { "0": ["TestDEX"] },
      dexSemanticValidatorsBySwapVariant: {
        "0": ({ dexProgramId, ammKey, routeStep, quoteStep }) => ({
          allowed: dexProgramId === dexProgram && ammKey === amm &&
            routeStep.inputIndex === 0 && routeStep.outputIndex === 1 &&
            quoteStep.swapInfo.label === "TestDEX"
        })
      },
      allowedDexProgramIds: [dexProgram],
      ...overrides.args
    }
  };
}

test("Metis validator binds Jupiter V6 route data, mints, signer, and token accounts", () => {
  const f = fixture();
  const result = validateMetisJupiterV6Instruction({
    decoded: f.decoded, instruction: f.instruction, ...f.args
  });
  assert.equal(result.allowed, true);
  assert.equal(result.instructionName, "sharedAccountsRouteV2");
  assert.equal(result.tokenAccountExpectations[0].address, source);
  assert.equal(result.tokenAccountExpectations[1].expectedMint, destinationMint);
  assert.deepEqual(result.requiredCpiProgramIds, [dexProgram]);
});

test("Metis validator rejects an instruction object not taken from the decoded transaction", () => {
  const f = fixture();
  const substitutedInstruction = { ...f.instruction };
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: f.decoded,
    instruction: substitutedInstruction,
    ...f.args
  }), /exact decoded Jupiter V6/);
});

test("Metis validator rejects non-Metis instruction variants, account mismatches, and quote drift", () => {
  const f = fixture();
  const malformedInstruction = {
    ...f.instruction,
    dataBase64: Buffer.from([1,2,3]).toString("base64")
  };
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: { ...f.decoded, instructions: [malformedInstruction] },
    instruction: malformedInstruction,
    ...f.args
  }), /not the reviewed sharedAccountsRouteV2/);
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: f.decoded, instruction: f.instruction, ...f.args, inAmount: "1000001"
  }), /do not match the quote/);
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: f.decoded, instruction: f.instruction, ...f.args, inputMint: destinationMint
  }), /do not match the pinned signer/);
});

test("Metis validator blocks Saber until deployed binary and CPI semantics are independently verified", () => {
  const f = fixture();
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: f.decoded,
    instruction: f.instruction,
    ...f.args,
    routePlan: [{ ...f.args.routePlan[0], swapInfo: { ...f.args.routePlan[0].swapInfo, label: "Saber" } }]
  }), /Saber StableSwap is blocked/);
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: f.decoded,
    instruction: f.instruction,
    ...f.args,
    dexProgramBySwapVariant: { "0": "SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ" },
    allowedDexProgramIds: ["SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ"]
  }), /Saber StableSwap is blocked/);
});

test("Metis validator rejects unknown swap variants, route percentage drift, and unapproved DEX programs", () => {
  const f = fixture();
  const unknown = Buffer.from(f.instruction.dataBase64, "base64");
  unknown[13] = 250;
  const unknownVariantInstruction = {
    ...f.instruction,
    dataBase64: unknown.toString("base64")
  };
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: { ...f.decoded, instructions: [unknownVariantInstruction] },
    instruction: unknownVariantInstruction,
    ...f.args
  }), /unknown swap variant/);
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: f.decoded, instruction: f.instruction,
    ...f.args, routePlan: [{ ...f.args.routePlan[0], percent: 99 }]
  }), /does not match/);
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: f.decoded, instruction: f.instruction,
    ...f.args, allowedDexProgramIds: []
  }), /Pinned Metis DEX/);
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: f.decoded, instruction: f.instruction,
    ...f.args, dexSemanticValidatorsBySwapVariant: {}
  }), /No reviewed DEX-specific CPI account semantic validator/);
  assert.throws(() => validateMetisJupiterV6Instruction({
    decoded: f.decoded, instruction: f.instruction,
    ...f.args, dexSemanticValidatorsBySwapVariant: {
      "0": () => ({ allowed: false })
    }
  }), /DEX-specific CPI account semantics were not approved/);
});
