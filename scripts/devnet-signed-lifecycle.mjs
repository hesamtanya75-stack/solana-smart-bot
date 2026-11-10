import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction
} from "@solana/web3.js";

const DEVNET_RPC = "https://api.devnet.solana.com";
const TRANSFER_LAMPORTS = 1_000_000; // 0.001 SOL; Devnet only
const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL / 2;

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function requestDevnetAirdrop(connection, publicKey) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const signature = await connection.requestAirdrop(publicKey, AIRDROP_LAMPORTS);
      const latest = await connection.getLatestBlockhash("confirmed");
      const confirmation = await connection.confirmTransaction({
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight
      }, "confirmed");
      if (confirmation.value.err) {
        throw new Error("Devnet airdrop transaction failed: " + JSON.stringify(confirmation.value.err));
      }
      return signature;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await wait(1500 * (attempt + 1));
    }
  }
  throw new Error("Devnet airdrop failed after retries: " + String(lastError?.message || lastError));
}

async function main() {
  const connection = new Connection(DEVNET_RPC, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000
  });
  const genesis = await connection.getGenesisHash();
  const expectedGenesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  if (genesis !== expectedGenesis) throw new Error("Refusing to sign: RPC is not official Solana Devnet");

  // Fresh ephemeral keys exist only in this CI process; no user wallet or secret is used.
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  // Verify local signing first; this does not submit anything to a cluster.
  const offlineBlockhash = await connection.getLatestBlockhash("confirmed");
  const offlineTransaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: offlineBlockhash.blockhash
  }).add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient.publicKey,
    lamports: TRANSFER_LAMPORTS
  }));
  offlineTransaction.sign(payer);
  if (!offlineTransaction.verifySignatures()) {
    throw new Error("Ephemeral Devnet transaction signature failed local verification");
  }

  let airdropSignature;
  try {
    airdropSignature = await requestDevnetAirdrop(connection, payer.publicKey);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("410 Gone") || message.includes("RPC faucet is closed")) {
      console.log("::warning::Devnet RPC faucet is closed; offline signature verified but no on-chain transaction was submitted.");
      console.log(JSON.stringify({
        ok: true,
        status: "blocked",
        cluster: "devnet",
        genesisHash: genesis,
        offlineSignatureVerified: true,
        onChainSubmission: "blocked: public Devnet RPC faucet returned HTTP 410",
        userPrivateKeysUsed: false,
        mainnetTouched: false,
        swapExecuted: false
      }, null, 2));
      return;
    }
    throw error;
  }

  const payerBalance = await connection.getBalance(payer.publicKey, "confirmed");
  if (payerBalance < TRANSFER_LAMPORTS + 10_000) {
    throw new Error("Devnet airdrop balance is insufficient for the test transfer and fee");
  }

  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: latest.blockhash
  }).add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient.publicKey,
    lamports: TRANSFER_LAMPORTS
  }));
  transaction.sign(payer);
  if (!transaction.verifySignatures()) {
    throw new Error("Ephemeral Devnet transaction signature failed local verification");
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight
  }, "finalized");
  if (confirmation.value.err) {
    throw new Error("Signed Devnet transaction failed: " + JSON.stringify(confirmation.value.err));
  }

  const [status, transactionInfo, recipientBalance] = await Promise.all([
    connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
    connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0
    }),
    connection.getBalance(recipient.publicKey, "finalized")
  ]);
  const signatureStatus = status.value?.[0];
  if (!signatureStatus || signatureStatus.err || signatureStatus.confirmationStatus !== "finalized") {
    throw new Error("Devnet signature did not reach finalized status");
  }
  if (!transactionInfo || transactionInfo.meta?.err ||
      recipientBalance < TRANSFER_LAMPORTS) {
    throw new Error("Finalized Devnet transaction could not be independently verified");
  }

  console.log(JSON.stringify({
    ok: true,
    cluster: "devnet",
    genesisHash: genesis,
    airdropSignature,
    transactionSignature: signature,
    confirmationStatus: signatureStatus.confirmationStatus,
    recipientBalanceLamports: recipientBalance,
    transferLamports: TRANSFER_LAMPORTS,
    signer: "ephemeral CI keypair generated in memory",
    userPrivateKeysUsed: false,
    mainnetTouched: false,
    swapExecuted: false
  }, null, 2));
}

main().catch(error => {
  console.error("Signed Devnet lifecycle test failed:", error.message);
  process.exitCode = 1;
});
