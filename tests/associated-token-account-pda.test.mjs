import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeAssociatedTokenInstruction
} from "../associated-token-account-decoder.mjs";
import {
  deriveAssociatedTokenAddress,
  verifyAssociatedTokenInstructionPda,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CLASSIC_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
} from "../associated-token-account-pda.mjs";

const OWNER = "CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CLASSIC_ATA = "3EjekkZPxiKdDB91mdJjUcjFjRmyWjP1Y4ySvfwSaQ4b";
const TOKEN_2022_ATA = "J1AgP9czKVx1tHY2TrQxMd73tguFUE7rVYynxEWsq8nr";
const SYSTEM = "11111111111111111111111111111111";
const encoded = tag => Buffer.from([tag]).toString("base64");

test("derives the pinned Classic Token ATA address and canonical bump", async () => {
  const result = await deriveAssociatedTokenAddress({
    owner: OWNER, mint: MINT, tokenProgramId: CLASSIC_TOKEN_PROGRAM_ID
  });
  assert.deepEqual(result, { address: CLASSIC_ATA, bump: 251 });
});

test("derives the pinned Token-2022 ATA address and canonical bump", async () => {
  const result = await deriveAssociatedTokenAddress({
    owner: OWNER, mint: MINT, tokenProgramId: TOKEN_2022_PROGRAM_ID
  });
  assert.deepEqual(result, { address: TOKEN_2022_ATA, bump: 254 });
});

test("changes ATA when only the token program changes", async () => {
  const classic = await deriveAssociatedTokenAddress({
    owner: OWNER, mint: MINT, tokenProgramId: CLASSIC_TOKEN_PROGRAM_ID
  });
  const token2022 = await deriveAssociatedTokenAddress({
    owner: OWNER, mint: MINT, tokenProgramId: TOKEN_2022_PROGRAM_ID
  });
  assert.notEqual(classic.address, token2022.address);
});

test("rejects malformed owner and mint and unsupported token program", async () => {
  await assert.rejects(
    deriveAssociatedTokenAddress({ owner: "bad", mint: MINT, tokenProgramId: CLASSIC_TOKEN_PROGRAM_ID }),
    /valid Solana addresses/
  );
  await assert.rejects(
    deriveAssociatedTokenAddress({ owner: OWNER, mint: "bad", tokenProgramId: CLASSIC_TOKEN_PROGRAM_ID }),
    /valid Solana addresses/
  );
  await assert.rejects(
    deriveAssociatedTokenAddress({ owner: OWNER, mint: MINT, tokenProgramId: SYSTEM }),
    /Unsupported token program/
  );
});

test("verifies a decoded ATA instruction against the canonical PDA", async () => {
  const keys = [OWNER, CLASSIC_ATA, OWNER, MINT, SYSTEM, CLASSIC_TOKEN_PROGRAM_ID];
  const record = decodeAssociatedTokenInstruction(
    ASSOCIATED_TOKEN_PROGRAM_ID, encoded(1), [0,1,2,3,4,5], keys
  );
  const result = await verifyAssociatedTokenInstructionPda(record, keys);
  assert.equal(result.performed, true);
  assert.equal(result.verified, true);
  assert.equal(result.expectedAddress, CLASSIC_ATA);
  assert.equal(result.bump, 251);
  assert.equal(result.scope, "pda-only");
});

test("rejects a wrong ATA address, wrong owner, and wrong mint", async () => {
  const keys = [OWNER, TOKEN_2022_ATA, OWNER, MINT, SYSTEM, TOKEN_2022_PROGRAM_ID];
  const record = decodeAssociatedTokenInstruction(
    ASSOCIATED_TOKEN_PROGRAM_ID, encoded(1), [0,1,2,3,4,5], keys
  );
  const wrongAta = [...keys];
  wrongAta[1] = CLASSIC_ATA;
  assert.equal((await verifyAssociatedTokenInstructionPda(record, wrongAta)).verified, false);

  const wrongOwner = [...keys];
  wrongOwner[2] = "11111111111111111111111111111112";
  assert.equal((await verifyAssociatedTokenInstructionPda(record, wrongOwner)).verified, false);

  const wrongMint = [...keys];
  wrongMint[3] = "11111111111111111111111111111113";
  assert.equal((await verifyAssociatedTokenInstructionPda(record, wrongMint)).verified, false);
});

test("rejects forged decoder records", async () => {
  await assert.rejects(
    verifyAssociatedTokenInstructionPda({}, []),
    /trusted decoded instruction record/
  );
});
