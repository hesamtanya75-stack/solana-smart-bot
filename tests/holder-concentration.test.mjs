import test from "node:test";
import assert from "node:assert/strict";
import { calculateCompleteHolderConcentration } from "../holder-concentration.js";

const mint = "So11111111111111111111111111111111111111112";
const ownerA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ownerB = "11111111111111111111111111111111";
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
function fixture(amounts = ["60", "25", "15"], owners = [ownerA, ownerA, ownerB], program = tokenProgram) {
  const largestAccounts = amounts.map((amount, i) => ({ address: "1".repeat(31) + String(i + 1), amount }));
  const accountDetails = { value: amounts.map((amount, i) => ({
    owner: program,
    data: { parsed: { type: "account", info: {
      mint, owner: owners[i], tokenAmount: { amount }
    } } }
  })) };
  return { mint, supplyAtomic: amounts.reduce((sum, n) => sum + BigInt(n), 0n).toString(), largestAccounts, accountDetails };
}

test("aggregates multiple token accounts by wallet owner and checks complete supply", () => {
  const result = calculateCompleteHolderConcentration(fixture());
  assert.equal(result.complete, true);
  assert.equal(result.largestOwnerPpm, 850000);
  assert.equal(result.topTenOwnersPpm, 1000000);
  assert.equal(result.largestOwnerAbove30Percent, true);
  assert.equal(result.topTenOwnersAbove50Percent, true);
});

test("supports Token-2022 account program when evidence is complete", () => {
  const program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  assert.equal(calculateCompleteHolderConcentration(fixture(["100"], [ownerA], program)).complete, true);
});

test("fails closed when top-account sample omits supply", () => {
  const input = fixture(["60", "25"], [ownerA, ownerB]);
  input.supplyAtomic = "100";
  assert.throws(() => calculateCompleteHolderConcentration(input), /full mint supply/);
});

test("rejects missing account details and mismatched mint", () => {
  const input = fixture();
  input.accountDetails.value.pop();
  assert.throws(() => calculateCompleteHolderConcentration(input), /incomplete/);
  const mismatch = fixture();
  mismatch.accountDetails.value[0].data.parsed.info.mint = ownerB;
  assert.throws(() => calculateCompleteHolderConcentration(mismatch), /identity/);
});

test("rejects duplicate account addresses, unrecognized token program, and changed amounts", () => {
  const duplicate = fixture();
  duplicate.largestAccounts[1].address = duplicate.largestAccounts[0].address;
  assert.throws(() => calculateCompleteHolderConcentration(duplicate), /identity/);
  const program = fixture();
  program.accountDetails.value[0].owner = ownerB;
  assert.throws(() => calculateCompleteHolderConcentration(program), /identity/);
  const amount = fixture();
  amount.accountDetails.value[0].data.parsed.info.tokenAmount.amount = "59";
  assert.throws(() => calculateCompleteHolderConcentration(amount), /identity/);
});
test("risk limits use exact integer ratios at and just above boundaries", () => {
  const atThirty = fixture(["30", "25", "25", "20"], [ownerA, ownerB, mint, "11111111111111111111111111111112"]);
  assert.equal(calculateCompleteHolderConcentration(atThirty).largestOwnerAbove30Percent, false);
  const amounts = ["6", "4", ...Array(18).fill("5")];
  const owners = [ownerA, ownerA, ...Array.from({ length: 18 }, (_, i) => "1".repeat(31) + "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"[i])];
  const aboveFifty = fixture(amounts, owners);
  assert.equal(calculateCompleteHolderConcentration(aboveFifty).topTenOwnersAbove50Percent, true);
});
