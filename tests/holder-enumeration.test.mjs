import test from "node:test";
import assert from "node:assert/strict";
import { buildCompleteHolderEnumeration } from "../holder-enumeration.js";

const mint = "So11111111111111111111111111111111111111112";
const splProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const t22Program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const owner = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pubkeys = [
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112"
];
function decode58(s) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(alphabet.indexOf(ch));
  const bytes = [];
  while (n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return Uint8Array.from([...Array(zeros).fill(0), ...bytes]);
}
function account(program, amount, pubkey) {
  const bytes = new Uint8Array(40);
  bytes.set(decode58(owner).slice(-32), 0);
  let value = BigInt(amount);
  for (let i = 0; i < 8; i++) { bytes[32+i] = Number(value & 255n); value >>= 8n; }
  return { pubkey, account: { owner: program, data: [btoa(String.fromCharCode(...bytes)), "base64"] } };
}
function rpc(value, slot=777) { return { context: { slot }, value }; }
function fixture() {
  return {
    mint,
    splResult: rpc([account(splProgram, "70", pubkeys[0])]),
    token2022Result: rpc([account(t22Program, "30", pubkeys[1])]),
    supplyResult: rpc({ amount: "100" })
  };
}
test("enumerates both token programs and reconciles supply at one finalized slot", () => {
  const result = buildCompleteHolderEnumeration(fixture());
  assert.equal(result.slot, 777);
  assert.equal(result.supplyAtomic, "100");
  assert.equal(result.largestAccounts.length, 2);
  assert.equal(result.largestAccounts[0].amount, "70");
  assert.equal(result.accountDetails.value[0].data.parsed.info.owner, owner);
});
test("fails closed when RPC contexts are not the same slot", () => {
  const f = fixture();
  f.token2022Result.context.slot = 778;
  assert.throws(() => buildCompleteHolderEnumeration(f), /consistent slot/);
});
test("fails closed when provider response does not reconcile complete supply", () => {
  const f = fixture();
  f.token2022Result.value = [];
  assert.throws(() => buildCompleteHolderEnumeration(f), /reconcile/);
});
test("rejects invalid data slices and duplicate account addresses", () => {
  const invalid = fixture();
  invalid.splResult.value[0].account.data = ["AA==", "base64"];
  assert.throws(() => buildCompleteHolderEnumeration(invalid), /slice length/);
  const duplicate = fixture();
  duplicate.token2022Result.value[0].pubkey = duplicate.splResult.value[0].pubkey;
  assert.throws(() => buildCompleteHolderEnumeration(duplicate), /duplicate/);
});
