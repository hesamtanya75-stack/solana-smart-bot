import test from "node:test";
import assert from "node:assert/strict";
import { validateDecodedSwapTransaction } from "../solana-instruction-policy.mjs";

const signer = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const writableAccount = "11111111111111111111111111111112";
const program = "11111111111111111111111111111111";

function fixture() {
  return {
    version: "legacy",
    signerPubkeys: [signer],
    signaturesPresent: [false],
    accountKeys: [signer, writableAccount, program],
    accountMetadata: [
      { pubkey: signer, index: 0, isSigner: true, isWritable: true, source: { type: "static", index: 0 } },
      { pubkey: writableAccount, index: 1, isSigner: false, isWritable: true, source: { type: "static", index: 1 } },
      { pubkey: program, index: 2, isSigner: false, isWritable: false, source: { type: "static", index: 2 } }
    ],
    instructions: [{ programId: program, accounts: [signer, writableAccount] }]
  };
}

function policy(allowedWritableAccountKeys) {
  return {
    decoded: fixture(),
    expectedSigner: signer,
    requiredAccounts: [signer, writableAccount],
    allowedProgramIds: [program],
    allowedAccountKeys: [signer, writableAccount, program],
    allowedWritableAccountKeys,
    instructionValidators: { [program]: () => ({ allowed: true }) }
  };
}

test("writable-account policy requires every writable key to be explicitly approved", () => {
  assert.equal(validateDecodedSwapTransaction(policy([signer, writableAccount])).allowed, true);
  assert.throws(
    () => validateDecodedSwapTransaction(policy([signer])),
    /unapproved writable account/
  );
});

test("writable-account policy rejects missing or inconsistent privilege metadata", () => {
  const decoded = fixture();
  delete decoded.accountMetadata;
  assert.throws(
    () => validateDecodedSwapTransaction({ ...policy([signer, writableAccount]), decoded }),
    /privilege metadata is missing or inconsistent/
  );
});
