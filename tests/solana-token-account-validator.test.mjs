import test from "node:test";
import assert from "node:assert/strict";
import { validateParsedTokenAccount } from "../solana-token-account-validator.mjs";

const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const authority = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const otherMint = "So11111111111111111111111111111111111111112";
const otherAuthority = "11111111111111111111111111111112";

function fixture(overrides = {}) {
  return {
    context: { slot: 1000 },
    value: {
      owner: tokenProgram,
      data: {
        program: "spl-token",
        parsed: {
          type: "account",
          info: {
            mint,
            owner: authority,
            state: "initialized",
            delegate: null,
            closeAuthority: null,
            isNative: false,
            tokenAmount: { amount: "1000000", decimals: 6 },
            extensions: []
          }
        }
      }
    },
    ...overrides
  };
}

function validate(response = fixture(), overrides = {}) {
  return validateParsedTokenAccount({
    response,
    expectedTokenProgramId: overrides.expectedTokenProgramId || tokenProgram,
    expectedMint: mint,
    expectedAuthority: authority,
    currentSlot: 1010,
    minContextSlot: 990,
    maxSlotLag: 32,
    minimumAmount: "100",
    ...overrides
  });
}

test("token account validator accepts matching initialized account and fresh RPC context", () => {
  const result = validate();
  assert.equal(result.allowed, true);
  assert.equal(result.mint, mint);
  assert.equal(result.authority, authority);
  assert.equal(result.amount, "1000000");
  assert.equal(result.slot, 1000);
});

test("token account validator rejects token program, mint, and authority mismatches", () => {
  const wrongProgram = fixture();
  wrongProgram.value.owner = otherAuthority;
  assert.throws(() => validate(wrongProgram), /unapproved token program/);

  const wrongMint = fixture();
  wrongMint.value.data.parsed.info.mint = otherMint;
  assert.throws(() => validate(wrongMint), /mint does not match/);

  const wrongAuthority = fixture();
  wrongAuthority.value.data.parsed.info.owner = otherAuthority;
  assert.throws(() => validate(wrongAuthority), /authority does not match/);
});

test("token account validator rejects frozen, delegated, or closable accounts", () => {
  const frozen = fixture();
  frozen.value.data.parsed.info.state = "frozen";
  assert.throws(() => validate(frozen), /not initialized or is frozen/);

  const delegated = fixture();
  delegated.value.data.parsed.info.delegate = otherAuthority;
  assert.throws(() => validate(delegated), /unexpected delegate or close authority/);

  const closable = fixture();
  closable.value.data.parsed.info.closeAuthority = otherAuthority;
  assert.throws(() => validate(closable), /unexpected delegate or close authority/);
});

test("token account validator rejects stale slots, insufficient balance, and native accounts by default", () => {
  assert.throws(() => validate(fixture({ context: { slot: 900 } })), /RPC context is stale or inconsistent/);
  assert.throws(() => validate(fixture({ context: { slot: 1011 } })), /RPC context is stale or inconsistent/);

  const lowBalance = fixture();
  lowBalance.value.data.parsed.info.tokenAmount.amount = "99";
  assert.throws(() => validate(lowBalance), /below the required minimum/);

  const native = fixture();
  native.value.data.parsed.info.isNative = true;
  assert.throws(() => validate(native), /Native token account is not permitted/);
  assert.equal(validate(native, { allowNative: true }).allowed, true);
});

test("token account validator rejects malformed amounts and unknown Token-2022 extensions", () => {
  const malformed = fixture();
  malformed.value.data.parsed.info.tokenAmount.amount = "-1";
  assert.throws(() => validate(malformed), /amount or decimals are invalid/);

  const token2022Program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const extended = fixture();
  extended.value.owner = token2022Program;
  extended.value.data.program = "spl-token-2022";
  extended.value.data.parsed.info.extensions = [{ extension: "transferFeeAmount" }];
  assert.throws(() => validate(extended, { expectedTokenProgramId: token2022Program }), /unapproved Token-2022 extension/);
  assert.equal(validate(extended, {
    expectedTokenProgramId: token2022Program,
    allowedExtensions: ["transferFeeAmount"]
  }).allowed, true);

  const missingExtensions = fixture();
  missingExtensions.value.owner = token2022Program;
  missingExtensions.value.data.program = "spl-token-2022";
  delete missingExtensions.value.data.parsed.info.extensions;
  assert.throws(
    () => validate(missingExtensions, { expectedTokenProgramId: token2022Program }),
    /extension metadata is missing/
  );

  const mismatchedLabel = fixture();
  mismatchedLabel.value.data.program = "spl-token-2022";
  assert.throws(() => validate(mismatchedLabel), /program label does not match/);
});
