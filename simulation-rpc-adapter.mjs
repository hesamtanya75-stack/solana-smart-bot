const MAX_SERIALIZED_TRANSACTION_BYTES = 1232;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

function encodeBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Build a read-only simulateTransaction JSON-RPC envelope from one immutable
 * serialized-transaction snapshot. This does not send the request, verify the
 * RPC response, or authorize signing/submission.
 */
export async function createSimulationRpcRequest({
  serializedTransaction,
  endpoint,
  requestId = 1
}) {
  if (!(serializedTransaction instanceof Uint8Array) ||
      Object.getPrototypeOf(serializedTransaction) !== Uint8Array.prototype ||
      serializedTransaction.byteLength < 1 ||
      serializedTransaction.byteLength > MAX_SERIALIZED_TRANSACTION_BYTES) {
    throw new Error("Serialized transaction must be a bounded Uint8Array");
  }
  if (typeof endpoint !== "string" || endpoint.length > 2048) {
    throw new Error("A valid HTTPS simulation RPC endpoint is required");
  }
  let url;
  try { url = new URL(endpoint); } catch {
    throw new Error("A valid HTTPS simulation RPC endpoint is required");
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.hash || url.hostname.length === 0) {
    throw new Error("Simulation RPC endpoint must be HTTPS without embedded credentials or fragment");
  }
  if (!Number.isSafeInteger(requestId) || requestId < 1) {
    throw new Error("Simulation RPC request id must be a positive safe integer");
  }

  // Snapshot before any asynchronous digest work. The same snapshot is encoded
  // into the RPC request and hashed below.
  const snapshot = new Uint8Array(serializedTransaction);
  if (!globalThis.crypto?.subtle?.digest) {
    throw new Error("WebCrypto SHA-256 is unavailable; simulation request blocked");
  }
  const digestBuffer = await globalThis.crypto.subtle.digest("SHA-256", snapshot);
  const transactionDigest = Array.from(new Uint8Array(digestBuffer), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  if (!HEX_SHA256.test(transactionDigest)) {
    throw new Error("Simulation transaction digest could not be derived");
  }

  const params = [
    encodeBase64(snapshot),
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed"
    }
  ];
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "simulateTransaction",
    params
  });

  return Object.freeze({
    method: "POST",
    endpoint: url.origin + url.pathname,
    requestId,
    transactionDigest,
    digestSource: "sha256-of-exact-base64-rpc-transaction-bytes",
    body,
    simulationOnly: true,
    responseIdentityVerified: false,
    signingPermitted: false,
    submissionPermitted: false
  });
}
