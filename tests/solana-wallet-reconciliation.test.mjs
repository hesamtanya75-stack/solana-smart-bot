import test from "node:test";
import assert from "node:assert/strict";
import { isValidSolanaPublicKey, reconcileWalletReadOnly } from "../solana-wallet-reconciliation.js";

const owner = "11111111111111111111111111111111";
const mint = "So11111111111111111111111111111111111111112";
const classicProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const token2022Program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
function account(program, accountOwner, tokenMint, amount, decimals) {
  return { account: { owner: program, data: { parsed: { info: {
    mint: tokenMint, owner: accountOwner, tokenAmount: { amount, decimals }
  } } } } };
}

test("validates public keys as 32-byte base58 values", () => {
  assert.equal(isValidSolanaPublicKey(owner), true);
  assert.equal(isValidSolanaPublicKey(mint), true);
  assert.equal(isValidSolanaPublicKey("not-a-wallet-address"), false);
  assert.equal(isValidSolanaPublicKey("111111111111111111111111111111111111111111111111"), false);
  assert.equal(isValidSolanaPublicKey("0OIl"), false);
});

test("reports finalized native balance and aggregates token accounts exactly", async () => {
  const result = await reconcileWalletReadOnly({
    owner,
    getBalance: async (_, config) => {
      assert.equal(config.commitment, "finalized");
      return { context: { slot: 300 }, value: 1_234_567_890 };
    },
    getTokenAccountsByOwner: async (_, program, config) => {
      assert.equal(config.commitment, "finalized");
      const isClassic = program === classicProgram;
      return {
        context: { slot: isClassic ? 301 : 302 },
        value: isClassic ? [
          account(program, owner, mint, "9007199254740993", 9),
          account(program, owner, mint, "7", 9)
        ] : [
          account(program, owner, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "1000", 6)
        ]
      };
    }
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.native.amountAtomic, "1234567890");
  assert.equal(result.native.amount, "1.234567890");
  assert.equal(result.positions.find(x => x.mint === mint).amountAtomic, "9007199254741000");
  assert.equal(result.positions.length, 2);
  assert.equal(result.execution, "not-authorized");
  assert.equal(result.slots.token2022, 302);
});

test("fails closed on malformed token account and never returns partial snapshot", async () => {
  const result = await reconcileWalletReadOnly({
    owner,
    getBalance: async () => ({ context: { slot: 1 }, value: 5 }),
    getTokenAccountsByOwner: async () => ({ context: { slot: 1 }, value: [
      account(classicProgram, owner, mint, "NaN", 9)
    ] })
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /parsing failed/);
});

test("rejects token account with wrong owner or token program", async () => {
  const result = await reconcileWalletReadOnly({
    owner,
    getBalance: async () => ({ context: { slot: 1 }, value: 5 }),
    getTokenAccountsByOwner: async (_, program) => ({
      context: { slot: 1 },
      value: [account(program, "SysvarRent111111111111111111111111111111111", mint, "5", 9)]
    })
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /parsing failed/);
});

test("rejects invalid owner before making RPC calls", async () => {
  let calls = 0;
  const result = await reconcileWalletReadOnly({
    owner: "bad",
    getBalance: async () => { calls++; },
    getTokenAccountsByOwner: async () => { calls++; }
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});
