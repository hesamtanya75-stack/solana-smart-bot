import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction
} from "@solana/web3.js";

// A dedicated Devnet RPC may be supplied through GitHub Actions secrets.
// On a network failure only, retry the official public Devnet endpoint. Every
// candidate must pass the exact Devnet genesis-hash guard before key creation.
const configuredDevnetRpc = process.env.DEVNET_RPC_URL?.trim();
function isSecureDevnetRpcEndpoint(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) &&
      !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
const DEVNET_RPCS = [...new Set([
  configuredDevnetRpc,
  "https://api.devnet.solana.com"
].filter(value => value && isSecureDevnetRpcEndpoint(value)))];
const EXPECTED_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TRANSFER_LAMPORTS = 1_000_000; // 0.001 SOL; Devnet only
const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL / 2;

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function requestDevnetAirdrop(connection, publicKey) {
  let signature;
  let lastError;
  // Retry only the faucet request itself. Once a signature exists, never
  // request another airdrop just because confirmation is delayed or fails.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      signature = await connection.requestAirdrop(publicKey, AIRDROP_LAMPORTS);
      break;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      // HTTP 410 is a permanent faucet shutdown response, not a transient
      // rate limit or network error; retrying cannot make this request succeed.
      if (message.includes("410 Gone") || message.includes("RPC faucet is closed")) {
        throw new Error("Devnet RPC faucet is closed: " + message);
      }
      if (attempt === 3) break;
      await wait(1500 * (attempt + 1));
    }
  }
  if (!signature) {
    throw new Error("Devnet airdrop request failed after retries: " + String(lastError?.message || lastError));
  }
  // requestAirdrop does not return the transaction's blockhash metadata.
  // Confirm by signature rather than pairing it with an unrelated later blockhash.
  const confirmation = await connection.confirmTransaction(signature, "confirmed");
  if (confirmation.value.err) {
    throw new Error("Devnet airdrop transaction failed: " + JSON.stringify(confirmation.value.err));
  }
  return signature;
}

async function main() {
  let connection;
  let genesis;
  const endpointFailures = [];
  for (let endpointIndex = 0; endpointIndex < DEVNET_RPCS.length; endpointIndex++) {
    const candidate = new Connection(DEVNET_RPCS[endpointIndex], {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000
    });
    try {
      const candidateGenesis = await candidate.getGenesisHash();
      if (candidateGenesis !== EXPECTED_DEVNET_GENESIS) {
        throw new Error("Refusing to sign: RPC is not official Solana Devnet");
      }
      connection = candidate;
      genesis = candidateGenesis;
      break;
    } catch (error) {
      // A responding endpoint on the wrong cluster is a hard failure. Only a
      // transport failure may fall through to the official public Devnet RPC.
      if (String(error?.message || error).includes("Refusing to sign")) throw error;
      if (error?.name !== "TypeError" || endpointIndex === DEVNET_RPCS.length - 1) throw error;
      endpointFailures.push("endpoint " + (endpointIndex + 1) + ": network failure");
    }
  }
  if (!connection || genesis !== EXPECTED_DEVNET_GENESIS) {
    throw new Error("No RPC endpoint passed the official Solana Devnet identity check: " +
      endpointFailures.join("; "));
  }

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
      console.log("::error::Devnet RPC faucet is closed; offline signature verification is NOT an on-chain lifecycle pass.");
      console.log(JSON.stringify({
        ok: false,
        status: "blocked",
        cluster: "devnet",
        genesisHash: genesis,
        offlineSignatureVerified: true,
        onChainSubmission: "blocked: public Devnet RPC faucet returned HTTP 410",
        userPrivateKeysUsed: false,
        mainnetTouched: false,
        swapExecuted: false
      }, null, 2));
      // Fail the required CI step so a faucet outage cannot be mistaken for
      // a successful signed, submitted, finalized, and independently verified transaction.
      process.exitCode = 2;
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

  // Verify the finalized transaction itself credited this ephemeral recipient,
  // rather than relying only on a separate balance RPC response.
  const message = transactionInfo.transaction?.message;
  const accountKeys = message?.accountKeys;
  const preBalances = transactionInfo.meta?.preBalances;
  const postBalances = transactionInfo.meta?.postBalances;
  const recipientIndex = Array.isArray(accountKeys)
    ? accountKeys.findIndex(key =>
        (typeof key?.toBase58 === "function" ? key.toBase58() :
          typeof key?.pubkey?.toBase58 === "function" ? key.pubkey.toBase58() :
            String(key?.pubkey ?? key)) === recipient.publicKey.toBase58())
    : -1;
  const transactionSignatures = transactionInfo.transaction?.signatures;
  if (!Array.isArray(transactionSignatures) ||
      transactionSignatures[0] !== signature ||
      !accountKeys.some(key =>
        (typeof key?.toBase58 === "function" ? key.toBase58() :
          typeof key?.pubkey?.toBase58 === "function" ? key.pubkey.toBase58() :
            String(key?.pubkey ?? key)) === payer.publicKey.toBase58()) ||
      recipientIndex < 0 ||
      !Array.isArray(preBalances) || !Array.isArray(postBalances) ||
      recipientIndex >= preBalances.length || recipientIndex >= postBalances.length ||
      postBalances[recipientIndex] - preBalances[recipientIndex] < TRANSFER_LAMPORTS) {
    throw new Error("Finalized transaction metadata does not prove the expected recipient credit");
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
