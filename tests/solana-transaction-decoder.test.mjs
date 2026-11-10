import test from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount,
  Keypair,
  SystemProgram,
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
