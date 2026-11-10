import test from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import { decodeSolanaTransaction } from "../solana-transaction-decoder.mjs";

const blockhash = Keypair.generate().publicKey.toBase58();

function makeLegacyTransaction() {
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: 1234
    })]
  }).compileToLegacyMessage();
  return { transaction: new VersionedTransaction(message), payer, recipient };
}

test("decodes a legacy transaction and exposes program and account keys", async () => {
  const { transaction, payer, recipient } = makeLegacyTransaction();
  const decoded = await decodeSolanaTransaction(
    Buffer.from(transaction.serialize()).toString("base64")
  );

  assert.equal(decoded.version, "legacy");
  assert.equal(decoded.requiredSignatures, 1);
  assert.deepEqual(decoded.signerPubkeys, [payer.publicKey.toBase58()]);
  assert.equal(decoded.instructions.length, 1);
  assert.equal(decoded.instructions[0].programId, SystemProgram.programId.toBase58());
  assert.ok(decoded.instructions[0].accounts.includes(recipient.toBase58()));
  assert.deepEqual(decoded.signaturesPresent, [false]);
});

test("decodes a v0 transaction after resolving every address lookup table", async () => {
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [recipient]
    }
  });
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: 55
    })]
  }).compileToV0Message([table]);
  const transaction = new VersionedTransaction(message);
  const decoded = await decodeSolanaTransaction(
    Buffer.from(transaction.serialize()).toString("base64"),
    { lookupTableResolver: async (key) => key.equals(table.key) ? table : null }
  );

  assert.equal(decoded.version, 0);
  assert.deepEqual(decoded.lookupTableAddresses, [table.key.toBase58()]);
  assert.ok(decoded.accountKeys.includes(recipient.toBase58()));
  assert.equal(decoded.instructions[0].programId, SystemProgram.programId.toBase58());
});

test("fails closed when a v0 lookup table is not resolved", async () => {
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [recipient]
    }
  });
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: 1
    })]
  }).compileToV0Message([table]);
  const encoded = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

  await assert.rejects(
    () => decodeSolanaTransaction(encoded),
    /resolver is required/
  );
  await assert.rejects(
    () => decodeSolanaTransaction(encoded, {
      lookupTableResolver: async () => null
    }),
    /missing, mismatched, or invalid/
  );
});

test("rejects malformed, non-canonical, oversized, and non-transaction payloads", async () => {
  await assert.rejects(() => decodeSolanaTransaction("%%%="), /canonical Base64/);
  await assert.rejects(() => decodeSolanaTransaction("dGVzdA=="), /valid Solana transaction/);
  await assert.rejects(() => decodeSolanaTransaction("A".repeat(2000)), /canonical Base64|serialized size/);
  await assert.rejects(() => decodeSolanaTransaction(""), /canonical Base64/);
});

test("rejects a transaction with no instructions", async () => {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: []
  }).compileToLegacyMessage();
  const encoded = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

  await assert.rejects(
    () => decodeSolanaTransaction(encoded),
    /instruction count/
  );
});


import { validateDecodedSwapTransaction } from "../solana-instruction-policy.mjs";

test("instruction policy accepts only exact reviewed programs, accounts and signer", () => {
  const signer = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
  const program = "11111111111111111111111111111111";
  const input = "So11111111111111111111111111111111111111112";
  const output = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const decoded = {
    version: "legacy",
    signerPubkeys: [signer],
    signaturesPresent: [false],
    accountKeys: [signer, program, input, output],
    instructions: [{ programId: program, accounts: [signer, input, output] }]
  };
  const result = validateDecodedSwapTransaction({
    decoded, expectedSigner: signer,
    requiredAccounts: [signer, input, output],
    allowedProgramIds: [program],
    allowedAccountKeys: [signer, program, input, output],
    instructionValidators: { [program]: () => ({ allowed: true }) }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.instructionCount, 1);
});

test("instruction policy rejects unknown programs and accounts", () => {
  const signer = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
  const program = "11111111111111111111111111111111";
  const unknownProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const input = "So11111111111111111111111111111111111111112";
  const output = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const base = {
    version: 0, signerPubkeys: [signer], signaturesPresent: [false],
    accountKeys: [signer, program, input, output],
    instructions: [{ programId: program, accounts: [signer, input, output] }]
  };
  const options = {
    expectedSigner: signer, requiredAccounts: [signer, input, output],
    allowedProgramIds: [program],
    allowedAccountKeys: [signer, program, input, output],
    instructionValidators: { [program]: () => ({ allowed: true }) }
  };
  assert.throws(() => validateDecodedSwapTransaction({
    ...options, decoded: { ...base, instructions: [{ ...base.instructions[0], programId: unknownProgram }] }
  }), /unknown or unapproved program/);
  assert.throws(() => validateDecodedSwapTransaction({
    ...options, decoded: { ...base, accountKeys: [...base.accountKeys, unknownProgram] }
  }), /account outside the explicit allow-list/);
});

test("instruction policy rejects signer mismatch, pre-signed orders and empty allow-lists", () => {
  const signer = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
  const program = "11111111111111111111111111111111";
  const input = "So11111111111111111111111111111111111111112";
  const output = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const decoded = {
    version: 0, signerPubkeys: [signer], signaturesPresent: [false],
    accountKeys: [signer, program, input, output],
    instructions: [{ programId: program, accounts: [signer, input, output] }]
  };
  const options = {
    decoded, expectedSigner: signer, requiredAccounts: [signer, input, output],
    allowedProgramIds: [program],
    allowedAccountKeys: [signer, program, input, output]
  };
  assert.throws(() => validateDecodedSwapTransaction({
    ...options, expectedSigner: input
  }), /signer does not exactly match/);
  assert.throws(() => validateDecodedSwapTransaction({
    ...options, decoded: { ...decoded, signaturesPresent: [true] }
  }), /must be unsigned/);
  assert.throws(() => validateDecodedSwapTransaction({
    ...options, allowedProgramIds: []
  }), /allow-list is missing or empty/);
  assert.throws(() => validateDecodedSwapTransaction({
    ...options, instructionValidators: undefined
  }), /protocol-specific instruction validators are required/);
  assert.throws(() => validateDecodedSwapTransaction({
    ...options, instructionValidators: { [program]: () => ({ allowed: false }) }
  }), /semantics were not approved/);
});


test("exposes signer and writable privileges for static and ALT-loaded accounts", async () => {
  const payer = Keypair.generate();
  const writableAltAccount = Keypair.generate().publicKey;
  const readonlyAltAccount = Keypair.generate().publicKey;
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [writableAltAccount, readonlyAltAccount]
    }
  });
  const instruction = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: writableAltAccount, isSigner: false, isWritable: true },
      { pubkey: readonlyAltAccount, isSigner: false, isWritable: false }
    ],
    data: Buffer.alloc(0)
  });
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction]
  }).compileToV0Message([table]);
  const transaction = new VersionedTransaction(message);
  const decoded = await decodeSolanaTransaction(
    Buffer.from(transaction.serialize()).toString("base64"),
    { lookupTableResolver: async (key) => key.equals(table.key) ? table : null }
  );

  const payerMeta = decoded.accountMetadata.find((entry) => entry.pubkey === payer.publicKey.toBase58());
  const writableMeta = decoded.accountMetadata.find((entry) => entry.pubkey === writableAltAccount.toBase58());
  const readonlyMeta = decoded.accountMetadata.find((entry) => entry.pubkey === readonlyAltAccount.toBase58());
  assert.deepEqual(
    { isSigner: payerMeta.isSigner, isWritable: payerMeta.isWritable, source: payerMeta.source.type },
    { isSigner: true, isWritable: true, source: "static" }
  );
  assert.deepEqual(
    { isSigner: writableMeta.isSigner, isWritable: writableMeta.isWritable,
      source: writableMeta.source.type, access: writableMeta.source.access,
      table: writableMeta.source.table, addressIndex: writableMeta.source.addressIndex },
    { isSigner: false, isWritable: true, source: "lookupTable", access: "writable",
      table: table.key.toBase58(), addressIndex: 0 }
  );
  assert.deepEqual(
    { isSigner: readonlyMeta.isSigner, isWritable: readonlyMeta.isWritable,
      source: readonlyMeta.source.type, access: readonlyMeta.source.access,
      table: readonlyMeta.source.table, addressIndex: readonlyMeta.source.addressIndex },
    { isSigner: false, isWritable: false, source: "lookupTable", access: "readonly",
      table: table.key.toBase58(), addressIndex: 1 }
  );
});

test("rejects ALT lookups with out-of-range or duplicate address indexes", async () => {
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [recipient]
    }
  });
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 1
    })]
  }).compileToV0Message([table]);

  const outOfRange = VersionedTransaction.deserialize(
    new VersionedTransaction(message).serialize()
  );
  outOfRange.message.addressTableLookups[0].writableIndexes = [9];
  const outOfRangeEncoded = Buffer.from(outOfRange.serialize()).toString("base64");
  await assert.rejects(
    () => decodeSolanaTransaction(outOfRangeEncoded, {
      lookupTableResolver: async () => table
    }),
    /invalid or duplicate address indexes/
  );

  const duplicate = VersionedTransaction.deserialize(
    new VersionedTransaction(message).serialize()
  );
  duplicate.message.addressTableLookups[0].readonlyIndexes = [
    ...duplicate.message.addressTableLookups[0].writableIndexes
  ];
  const duplicateEncoded = Buffer.from(duplicate.serialize()).toString("base64");
  await assert.rejects(
    () => decodeSolanaTransaction(duplicateEncoded, {
      lookupTableResolver: async () => table
    }),
    /invalid or duplicate address indexes/
  );
});
