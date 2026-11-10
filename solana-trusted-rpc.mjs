import { validateParsedTokenAccount } from "./solana-token-account-validator.mjs";
import { validateSimulatedCpi } from "./solana-instruction-policy.mjs";

const MAX_RPC_RESPONSE_BYTES = 2_000_000;
const MAX_TOKEN_ACCOUNTS = 16;
const MAX_CPI_TRANSACTION_BYTES = 1232;

function assertPublicKey(value, name) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw new Error(name + " must be a canonical Solana public key");
  }
}

function parseTrustedEndpoint(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error("Trusted RPC endpoint is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.hash || parsed.search) {
    throw new Error("Trusted RPC endpoint must be a pinned HTTPS URL without credentials, query, or fragment");
  }
  return parsed;
}

/**
 * JSON-RPC client pinned to one explicitly configured HTTPS endpoint.
 * No public fallback is permitted: changing providers changes the trust root.
 */
function createTrustedSolanaRpc({
  endpoint,
  expectedEndpoint,
  fetchImpl = fetch,
  commitment = "confirmed",
  timeoutMs = 8000
} = {}) {
  const parsed = parseTrustedEndpoint(endpoint);
  const expected = parseTrustedEndpoint(expectedEndpoint);
  if (parsed.href.replace(/\/$/, "") !== expected.href.replace(/\/$/, "")) {
    throw new Error("RPC endpoint does not match the explicitly pinned trusted endpoint");
  }
  if (typeof fetchImpl !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 20000 ||
      !["processed", "confirmed", "finalized"].includes(commitment)) {
    throw new Error("Trusted RPC client configuration is invalid");
  }

  let nextId = 1;
  async function call(method, params) {
    const id = nextId++;
    const response = await fetchImpl(parsed.href, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response || response.status !== 200) {
      throw new Error("Trusted Solana RPC request failed");
    }
    const raw = await response.text();
    if (raw.length > MAX_RPC_RESPONSE_BYTES) throw new Error("Trusted RPC response exceeds size limit");
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error("Trusted RPC returned malformed JSON"); }
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== id ||
        payload.error || !Object.prototype.hasOwnProperty.call(payload, "result")) {
      throw new Error("Trusted Solana RPC returned an invalid or failed JSON-RPC response");
    }
    return payload.result;
  }

  return Object.freeze({
    endpoint: parsed.href,
    commitment,
    async getSlot() {
      const slot = await call("getSlot", [{ commitment }]);
      if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("Trusted RPC returned an invalid slot");
      return slot;
    },
    async getBlockHeight() {
      const height = await call("getBlockHeight", [{ commitment }]);
      if (!Number.isSafeInteger(height) || height < 0) throw new Error("Trusted RPC returned an invalid block height");
      return height;
    },
    async getMultipleParsedTokenAccounts(pubkeys, { minContextSlot = 0 } = {}) {
      if (!Array.isArray(pubkeys) || pubkeys.length < 1 || pubkeys.length > MAX_TOKEN_ACCOUNTS ||
          pubkeys.some((key) => { try { assertPublicKey(key, "Token account"); return false; } catch { return true; } }) ||
          new Set(pubkeys).size !== pubkeys.length ||
          !Number.isSafeInteger(minContextSlot) || minContextSlot < 0) {
        throw new Error("Trusted token-account request is invalid");
      }
      const result = await call("getMultipleAccounts", [
        pubkeys, { encoding: "jsonParsed", commitment, minContextSlot }
      ]);
      if (!result || !result.context || !Number.isSafeInteger(result.context.slot) ||
          !Array.isArray(result.value) || result.value.length !== pubkeys.length) {
        throw new Error("Trusted RPC token-account response is incomplete");
      }
      return result;
    },
    async simulateUnsignedTransaction(encodedTransaction, { minContextSlot = 0 } = {}) {
      if (typeof encodedTransaction !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(encodedTransaction) ||
          Buffer.from(encodedTransaction, "base64").length < 1 ||
          Buffer.from(encodedTransaction, "base64").length > MAX_CPI_TRANSACTION_BYTES ||
          Buffer.from(encodedTransaction, "base64").toString("base64") !== encodedTransaction ||
          !Number.isSafeInteger(minContextSlot) || minContextSlot < 0) {
        throw new Error("Unsigned transaction simulation request is invalid");
      }
      const result = await call("simulateTransaction", [
        encodedTransaction,
        {
          encoding: "base64",
          commitment,
          sigVerify: false,
          replaceRecentBlockhash: true,
          innerInstructions: true,
          minContextSlot
        }
      ]);
      if (!result || !result.context || !Number.isSafeInteger(result.context.slot) ||
          !result.value || !Object.prototype.hasOwnProperty.call(result.value, "err") ||
          !Array.isArray(result.value.innerInstructions)) {
        throw new Error("Trusted RPC simulation did not return a complete CPI trace");
      }
      return result;
    }
  });
}

/**
 * Performs trusted RPC reads for the exact source/destination token accounts,
 * validates their parsed identity and freshness, then simulates the exact
 * unsigned transaction and validates the returned CPI trace.
 *
 * Expectations and allow-lists must be constructed by trusted server code.
 * No values are accepted from browser input or Jupiter routePlan.
 */
async function inspectMetisOrderWithTrustedRpc({
  rpc,
  encodedTransaction,
  decoded,
  tokenAccountExpectations,
  allowedCpiProgramIds,
  allowedCpiAccountKeys,
  minContextSlot = 0,
  maxSlotLag = 32
} = {}) {
  if (!rpc || typeof rpc.getSlot !== "function" ||
      typeof rpc.getMultipleParsedTokenAccounts !== "function" ||
      typeof rpc.simulateUnsignedTransaction !== "function") {
    throw new Error("Pinned trusted Solana RPC client is required");
  }
  if (!Array.isArray(tokenAccountExpectations) ||
      tokenAccountExpectations.length < 2 ||
      tokenAccountExpectations.length > MAX_TOKEN_ACCOUNTS ||
      tokenAccountExpectations.some((item) => !item || typeof item.address !== "string")) {
    throw new Error("Trusted source and destination token-account expectations are required");
  }
  const addresses = tokenAccountExpectations.map((item) => item.address);
  if (new Set(addresses).size !== addresses.length) {
    throw new Error("Token-account expectations contain duplicate addresses");
  }

  const slotBefore = await rpc.getSlot();
  if (slotBefore < minContextSlot) throw new Error("Trusted RPC slot is behind the required minimum context");
  const accountResponse = await rpc.getMultipleParsedTokenAccounts(addresses, {
    minContextSlot: Math.max(minContextSlot, slotBefore)
  });
  const slotAfter = await rpc.getSlot();
  if (!Number.isSafeInteger(accountResponse?.context?.slot) ||
      accountResponse.context.slot < slotBefore ||
      accountResponse.context.slot > slotAfter ||
      slotAfter - accountResponse.context.slot > maxSlotLag) {
    throw new Error("Trusted RPC token-account context is stale or inconsistent");
  }

  const tokenAccounts = tokenAccountExpectations.map((expectation, index) =>
    validateParsedTokenAccount({
      response: { context: accountResponse.context, value: accountResponse.value[index] },
      expectedTokenProgramId: expectation.expectedTokenProgramId,
      expectedMint: expectation.expectedMint,
      expectedAuthority: expectation.expectedAuthority,
      currentSlot: slotAfter,
      minContextSlot: Math.max(minContextSlot, slotBefore),
      maxSlotLag,
      minimumAmount: expectation.minimumAmount ?? "0",
      allowNative: expectation.allowNative === true,
      allowedExtensions: expectation.allowedExtensions ?? []
    })
  );

  const simulation = await rpc.simulateUnsignedTransaction(encodedTransaction, {
    minContextSlot: accountResponse.context.slot
  });
  if (simulation.context.slot < accountResponse.context.slot ||
      simulation.context.slot > await rpc.getSlot()) {
    throw new Error("Trusted RPC simulation context is stale or inconsistent");
  }
  const cpi = validateSimulatedCpi({
    decoded,
    simulationMeta: simulation.value,
    allowedCpiProgramIds,
    allowedCpiAccountKeys
  });

  return Object.freeze({
    allowed: true,
    rpcEndpoint: rpc.endpoint,
    accountContextSlot: accountResponse.context.slot,
    simulationContextSlot: simulation.context.slot,
    tokenAccounts: Object.freeze(tokenAccounts),
    cpi
  });
}

export { createTrustedSolanaRpc, inspectMetisOrderWithTrustedRpc };
