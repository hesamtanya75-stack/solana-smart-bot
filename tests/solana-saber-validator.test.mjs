import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  SABER_STABLE_SWAP_PROGRAM_ID,
  SABER_TOKEN_PROGRAM_ID,
  validateSaberStableSwapCpi
} from "../solana-saber-validator.mjs";

function fixture(overrides = {}) {
  const swapKey = Keypair.generate().publicKey;
  const program = new PublicKey(SABER_STABLE_SWAP_PROGRAM_ID);
  let nonce, authority;
  for (let candidate = 0; candidate < 256; candidate += 1) {
    try {
      authority = PublicKey.createProgramAddressSync(
        [swapKey.toBuffer(), Buffer.from([candidate])], program
      );
      nonce = candidate;
      break;
    } catch {}
  }
  assert.ok(authority);
  const wallet = Keypair.generate().publicKey;
  const reserveAKey = Keypair.generate().publicKey;
  const reserveBKey = Keypair.generate().publicKey;
  const mintAKey = Keypair.generate().publicKey;
  const mintBKey = Keypair.generate().publicKey;
  const adminFeeAKey = Keypair.generate().publicKey;
  const adminFeeBKey = Keypair.generate().publicKey;
  const sourceKey = Keypair.generate().publicKey;
  const destinationKey = Keypair.generate().publicKey;
  const tokenProgram = new PublicKey(SABER_TOKEN_PROGRAM_ID);
  const accounts = [
    swapKey.toBase58(), authority.toBase58(), wallet.toBase58(), sourceKey.toBase58(),
    reserveAKey.toBase58(), reserveBKey.toBase58(), destinationKey.toBase58(),
    adminFeeBKey.toBase58(), tokenProgram.toBase58()
  ];

  const state = Buffer.alloc(395);
  state[0] = 1;
  state[1] = 0;
  state[2] = nonce;
  state.writeBigUInt64LE(100n, 3);
  state.writeBigUInt64LE(100n, 11);
  reserveAKey.toBuffer().copy(state, 107);
  reserveBKey.toBuffer().copy(state, 139);
  Keypair.generate().publicKey.toBuffer().copy(state, 171);
  mintAKey.toBuffer().copy(state, 203);
  mintBKey.toBuffer().copy(state, 235);
  adminFeeAKey.toBuffer().copy(state, 267);
  adminFeeBKey.toBuffer().copy(state, 299);
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
    owner.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(BigInt(amount), 64);
    data[108] = 1;
    return data;
  };
  const rawAccounts = new Map([
    [accounts[0], { owner: program, data: state, executable: false }],
    [accounts[3], { owner: tokenProgram, data: tokenData(mintAKey, wallet, 1000), executable: false }],
    [accounts[4], { owner: tokenProgram, data: tokenData(mintAKey, authority, 5000), executable: false }],
    [accounts[5], { owner: tokenProgram, data: tokenData(mintBKey, authority, 6000), executable: false }],
    [accounts[6], { owner: tokenProgram, data: tokenData(mintBKey, wallet, 0), executable: false }],
    [accounts[7], { owner: tokenProgram, data: tokenData(mintBKey, authority, 0), executable: false }],
    [mintAKey.toBase58(), { owner: tokenProgram, data: mintData(), executable: false }],
    [mintBKey.toBase58(), { owner: tokenProgram, data: mintData(), executable: false }]
  ]);
  const metadata = accounts.map((pubkey, index) => ({
    pubkey, isSigner: index === 2, isWritable: index >= 3 && index <= 7
  }));
  const data = Buffer.alloc(17);
  data[0] = 1;
  data.writeBigUInt64LE(50n, 1);
  data.writeBigUInt64LE(40n, 9);
  const args = {
    programId: SABER_STABLE_SWAP_PROGRAM_ID,
    accounts,
    data: bs58.encode(data),
    expectedUserAuthority: wallet.toBase58(),
    decoded: { accountMetadata: metadata },
    rawAccounts
  };
  return { args, state, accounts, rawAccounts, mintAKey, mintBKey, wallet, authority, tokenData };
}

test("Saber validator accepts official Swap ABI and matching SwapInfo, PDA, vaults, mints and fee account", () => {
  const f = fixture();
  const result = validateSaberStableSwapCpi(f.args);
  assert.equal(result.allowed, true);
  assert.equal(result.direction, "A_TO_B");
  assert.equal(result.amountIn, "50");
  assert.equal(result.minimumAmountOut, "40");
  assert.equal(result.reserveAAmount, "5000");
  assert.equal(result.reserveBAmount, "6000");
});

test("Saber validator rejects malformed instruction data and zero swap amounts", () => {
  const f = fixture();
  assert.throws(() => validateSaberStableSwapCpi({ ...f.args, data: bs58.encode(Buffer.from([1, 2])) }), /17-byte Swap/);
  const zero = Buffer.alloc(17);
  zero[0] = 1;
  zero.writeBigUInt64LE(10n, 9);
  assert.throws(() => validateSaberStableSwapCpi({ ...f.args, data: bs58.encode(zero) }), /amount or minimum output is zero/);
});

test("Saber validator rejects paused pools, altered reserves, and a mismatched authority PDA", () => {
  const paused = fixture();
  paused.state[1] = 1;
  assert.throws(() => validateSaberStableSwapCpi(paused.args), /uninitialized, paused/);

  const badReserve = fixture();
  const substitutedReserve = Keypair.generate().publicKey.toBase58();
  badReserve.args.accounts[4] = substitutedReserve;
  badReserve.args.decoded.accountMetadata[4].pubkey = substitutedReserve;
  assert.throws(() => validateSaberStableSwapCpi(badReserve.args), /reserve account keys/);

  const badAuthority = fixture();
  badAuthority.args.accounts[1] = Keypair.generate().publicKey.toBase58();
  assert.throws(() => validateSaberStableSwapCpi(badAuthority.args), /authority PDA/);
});

test("Saber validator rejects wrong vault ownership, mint relationships, fee destination and insufficient source balance", () => {
  const badOwner = fixture();
  badOwner.rawAccounts.get(badOwner.accounts[4]).owner = new PublicKey(SABER_STABLE_SWAP_PROGRAM_ID);
  assert.throws(() => validateSaberStableSwapCpi(badOwner.args), /classic SPL Token account/);

  const badMint = fixture();
  const wrongMint = Keypair.generate().publicKey;
  wrongMint.toBuffer().copy(badMint.rawAccounts.get(badMint.accounts[4]).data, 0);
  assert.throws(() => validateSaberStableSwapCpi(badMint.args), /reserve A mint/);

  const badFee = fixture();
  badFee.args.accounts[7] = badFee.accounts[4];
  assert.throws(() => validateSaberStableSwapCpi(badFee.args), /account uniqueness|admin-fee/);

  const lowBalance = fixture();
  lowBalance.rawAccounts.get(lowBalance.accounts[3]).data.writeBigUInt64LE(1n, 64);
  assert.throws(() => validateSaberStableSwapCpi(lowBalance.args), /input amount/);
});

test("Saber validator rejects privilege mismatches and missing raw account data", () => {
  const badPrivilege = fixture();
  badPrivilege.args.decoded.accountMetadata[4].isWritable = false;
  assert.throws(() => validateSaberStableSwapCpi(badPrivilege.args), /privilege/);

  const missing = fixture();
  missing.rawAccounts.delete(missing.accounts[5]);
  assert.throws(() => validateSaberStableSwapCpi(missing.args), /raw account data is missing/);
});
