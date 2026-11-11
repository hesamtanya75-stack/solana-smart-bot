import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createTrustedAltResolver } from "./solana-trusted-alt-resolver.mjs";
import { validateParsedTokenAccount } from "./solana-token-account-validator.mjs";
import { validateSimulatedCpi } from "./solana-instruction-policy.mjs";
import { decodeSolanaTransaction } from "./solana-transaction-decoder.mjs";
import { inspectUpgradeableProgramAccounts } from "./solana-upgradeable-program.mjs";
import { validateSaberStableSwapCpi, SABER_STABLE_SWAP_PROGRAM_ID, SABER_TOKEN_PROGRAM_ID } from "./solana-saber-validator.mjs";
import { JUPITER_V6_PROGRAM_ID } from "./solana-jupiter-authority.mjs";
import { identifyJupiterProgramAuthority } from "./solana-jupiter-authority.mjs";

const MAX_RPC_RESPONSE_BYTES = 2_000_000;
const MAX_TOKEN_ACCOUNTS = 16;
const MAX_CPI_TRANSACTION_BYTES = 1232;
const trustedRpcClients = new WeakSet();

function assertPublicKey(value, name) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw new Error(name + " must be a canonical Solana public key");
  }
}

async function readLimitedResponseBody(response, maxBytes) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    throw new Error("Trusted RPC response body is unavailable");
  }
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > maxBytes) {
      throw new Error("Trusted RPC response exceeds size limit");
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Trusted RPC response body is malformed");
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Trusted RPC response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Trusted RPC response is not valid UTF-8");
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
      redirect: "error",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response || response.status !== 200) {
      throw new Error("Trusted Solana RPC request failed");
    }
    const raw = await readLimitedResponseBody(response, MAX_RPC_RESPONSE_BYTES);
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error("Trusted RPC returned malformed JSON"); }
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== id ||
        payload.error || !Object.prototype.hasOwnProperty.call(payload, "result")) {
      throw new Error("Trusted Solana RPC returned an invalid or failed JSON-RPC response");
    }
    return payload.result;
  }

  const client = Object.freeze({
    endpoint: parsed.href,
    rpcEndpoint: parsed.href,
    commitment,
    async getAccountInfoAndContext(publicKey, { commitment: requestedCommitment = commitment, minContextSlot = 0 } = {}) {
      if (!publicKey || typeof publicKey.toBase58 !== "function" ||
          !Number.isSafeInteger(minContextSlot) || minContextSlot < 0) {
        throw new Error("Trusted ALT account request is invalid");
      }
      const result = await call("getAccountInfo", [
        publicKey.toBase58(),
        { encoding: "base64", commitment: requestedCommitment, minContextSlot }
      ]);
      if (!result || !result.context || !Number.isSafeInteger(result.context.slot) ||
          !result.value || typeof result.value.executable !== "boolean" ||
          !Number.isSafeInteger(result.value.lamports) || result.value.lamports < 0 ||
          !Array.isArray(result.value.data) ||
          result.value.data.length !== 2 || typeof result.value.data[0] !== "string" ||
          result.value.data[1] !== "base64" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(result.value.data[0])) {
        throw new Error("Trusted RPC returned an invalid ALT account response");
      }
      const data = Buffer.from(result.value.data[0], "base64");
      if (data.toString("base64") !== result.value.data[0] || data.length < 56 || data.length > 56 + 256 * 32) {
        throw new Error("Trusted RPC ALT account data is malformed");
      }
      return {
        context: result.context,
        value: {
          owner: new PublicKey(result.value.owner),
          data,
          executable: result.value.executable === true,
          lamports: result.value.lamports,
          rentEpoch: result.value.rentEpoch
        }
      };
    },
    async resolveAddressLookupTable(tableKey, { minContextSlot = 0, maxSlotLag = 32 } = {}) {
      const resolver = createTrustedAltResolver({
        connection: client,
        trustedRpcEndpoint: parsed.href,
        commitment,
        minContextSlot,
        maxSlotLag
      });
      return resolver(tableKey);
    },
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
    async getMultipleRawAccountInfos(pubkeys, { minContextSlot = 0 } = {}) {
      const MAX_RAW_ACCOUNT_READS = 16;
      const MAX_RAW_ACCOUNT_DATA_BYTES = 1_000_000;
      if (!Array.isArray(pubkeys) || pubkeys.length < 1 || pubkeys.length > MAX_RAW_ACCOUNT_READS ||
          pubkeys.some((key) => { try { assertPublicKey(key, "Raw account"); return false; } catch { return true; } }) ||
          new Set(pubkeys).size !== pubkeys.length ||
          !Number.isSafeInteger(minContextSlot) || minContextSlot < 0) {
        throw new Error("Trusted raw-account request is invalid");
      }
      const result = await call("getMultipleAccounts", [
        pubkeys, { encoding: "base64", commitment, minContextSlot }
      ]);
      if (!result || !result.context || !Number.isSafeInteger(result.context.slot) ||
          result.context.slot < minContextSlot ||
          !Array.isArray(result.value) || result.value.length !== pubkeys.length) {
        throw new Error("Trusted RPC raw-account response is incomplete or stale");
      }
      const values = result.value.map((account) => {
        if (account === null) return null;
        if (!account || typeof account !== "object" ||
            typeof account.executable !== "boolean" ||
            !Number.isSafeInteger(account.lamports) || account.lamports < 0 ||
            !Array.isArray(account.data) || account.data.length !== 2 ||
            typeof account.data[0] !== "string" || account.data[1] !== "base64") {
          throw new Error("Trusted RPC returned an invalid raw-account response");
        }
        assertPublicKey(account.owner, "Raw account owner");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(account.data[0])) {
          throw new Error("Trusted RPC raw-account data is not canonical base64");
        }
        const data = Buffer.from(account.data[0], "base64");
        if (data.toString("base64") !== account.data[0] || data.length > MAX_RAW_ACCOUNT_DATA_BYTES) {
          throw new Error("Trusted RPC raw-account data exceeds limits or is malformed");
        }
        return Object.freeze({
          owner: new PublicKey(account.owner),
          data,
          executable: account.executable,
          lamports: account.lamports,
          rentEpoch: account.rentEpoch
        });
      });
      return Object.freeze({
        context: Object.freeze({ slot: result.context.slot }),
        value: Object.freeze(values)
      });
    },
    async inspectUpgradeableProgram(programId, { minContextSlot = 0 } = {}) {
      assertPublicKey(programId, "Upgradeable program ID");
      const first = await client.getMultipleRawAccountInfos([programId], { minContextSlot });
      const programAccount = first.value[0];
      const loaderId = "BPFLoaderUpgradeab1e11111111111111111111111";
      if (!programAccount || programAccount.owner.toBase58() !== loaderId ||
          programAccount.executable !== true || programAccount.data.length !== 36 ||
          programAccount.data.readUInt32LE(0) !== 2) {
        throw new Error("Trusted RPC program account is not a valid upgradeable-loader Program");
      }
      const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36)).toBase58();
      const snapshot = await client.getMultipleRawAccountInfos(
        [programId, programDataAddress],
        { minContextSlot: first.context.slot }
      );
      if (snapshot.context.slot < first.context.slot ||
          snapshot.value[0]?.data?.length !== 36 ||
          snapshot.value[0].data.readUInt32LE(0) !== 2 ||
          new PublicKey(snapshot.value[0].data.subarray(4, 36)).toBase58() !== programDataAddress) {
        throw new Error("Trusted RPC upgradeable Program pointer changed or snapshot is inconsistent");
      }
      const inspected = inspectUpgradeableProgramAccounts({
        programId,
        programAccount: snapshot.value[0],
        programDataAccount: snapshot.value[1]
      });
      return Object.freeze({
        ...inspected,
        contextSlot: snapshot.context.slot,
        rpcEndpoint: endpoint
      });
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
          replaceRecentBlockhash: false,
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
  trustedRpcClients.add(client);
  return client;
}

/**
 * Performs trusted RPC reads for the exact source/destination token accounts,
 * validates their parsed identity and freshness, then simulates the exact
 * unsigned transaction and validates the returned CPI trace.
 *
 * Expectations and allow-lists must be constructed by trusted server code.
 * No values are accepted from browser input or Jupiter routePlan.
 */
async function inspectSaberCpiAfterSimulation({
  rpc,
  decoded,
  cpiInstructions,
  simulationContextSlot,
  expectedOuterInstructionIndexes,
  expectedPoolKeys
} = {}) {
  if (!rpc || !trustedRpcClients.has(rpc) ||
      typeof rpc.getMultipleRawAccountInfos !== "function" ||
      !decoded || !Array.isArray(decoded.instructions) ||
      !Array.isArray(decoded.accountMetadata) ||
      !Array.isArray(cpiInstructions) ||
      !Number.isSafeInteger(simulationContextSlot) || simulationContextSlot < 0 ||
      !Array.isArray(expectedOuterInstructionIndexes) ||
      expectedOuterInstructionIndexes.length !== 1 ||
      !Number.isInteger(expectedOuterInstructionIndexes[0]) ||
      !Array.isArray(expectedPoolKeys) || expectedPoolKeys.length > 16 ||
      expectedPoolKeys.some((key) => typeof key !== "string") ||
      new Set(expectedPoolKeys).size !== expectedPoolKeys.length) {
    throw new Error("Post-simulation Saber validation inputs are incomplete or invalid");
  }

  const allSaberCalls = cpiInstructions.filter((item) =>
    item?.programId === SABER_STABLE_SWAP_PROGRAM_ID
  );
  if (expectedPoolKeys.length === 0) {
    if (allSaberCalls.length !== 0) {
      throw new Error("Simulated Saber CPI is present without a trusted quote-bound Saber pool");
    }
    return Object.freeze([]);
  }

  const outerIndex = expectedOuterInstructionIndexes[0];
  const outer = decoded.instructions[outerIndex];
  if (!outer || outer.programId !== JUPITER_V6_PROGRAM_ID ||
      !Array.isArray(outer.accounts) || outer.accounts.length < 3 ||
      !Array.isArray(outer.accountIndexes) || outer.accountIndexes.length < 3) {
    throw new Error("Saber CPI is not bound to the exact pinned Jupiter shared-route instruction");
  }
  const programAuthority = outer.accounts[1];
  const programAuthorityMeta = decoded.accountMetadata[outer.accountIndexes[1]];
  if (!programAuthorityMeta ||
      programAuthorityMeta.pubkey !== programAuthority ||
      programAuthorityMeta.isSigner === true ||
      identifyJupiterProgramAuthority(programAuthority) === null) {
    throw new Error("Jupiter shared-route program authority is not a verified PDA from the pinned derivation set");
  }

  if (allSaberCalls.some((item) => item.outerInstructionIndex !== outerIndex) ||
      allSaberCalls.length !== expectedPoolKeys.length) {
    throw new Error("Simulated Saber CPI count or outer-instruction binding differs from the trusted route");
  }

  const validations = [];
  for (const expectedPoolKey of expectedPoolKeys) {
    assertPublicKey(expectedPoolKey, "Expected Saber pool");
    const matching = allSaberCalls.filter((item) =>
      Array.isArray(item.accounts) && item.accounts[0] === expectedPoolKey
    );
    if (matching.length !== 1) {
      throw new Error("Expected Saber pool does not map to exactly one simulated Saber CPI");
    }
    const cpi = matching[0];
    if (cpi.accounts.length !== 9 || cpi.accounts[2] !== programAuthority ||
        typeof cpi.data !== "string") {
      throw new Error("Saber CPI account order or Jupiter program-authority binding is invalid");
    }

    const firstRead = await rpc.getMultipleRawAccountInfos(
      [expectedPoolKey],
      { minContextSlot: simulationContextSlot }
    );
    const pool = firstRead.value[0];
    if (!pool ||
        pool.owner.toBase58() !== SABER_STABLE_SWAP_PROGRAM_ID ||
        pool.executable === true ||
        pool.data.length !== 395 ||
        pool.data[0] !== 1 ||
        pool.data[1] !== 0) {
      throw new Error("Simulated Saber pool account is missing, wrongly owned, or has invalid SwapInfo state");
    }
    const mintA = new PublicKey(pool.data.subarray(203, 235)).toBase58();
    const mintB = new PublicKey(pool.data.subarray(235, 267)).toBase58();
    const addresses = [...new Set([...cpi.accounts, mintA, mintB])];
    if (addresses.length > 11) {
      throw new Error("Saber raw-account snapshot exceeds the bounded account set");
    }
    const snapshot = await rpc.getMultipleRawAccountInfos(
      addresses,
      { minContextSlot: firstRead.context.slot }
    );
    if (snapshot.context.slot < firstRead.context.slot ||
        snapshot.context.slot < simulationContextSlot) {
      throw new Error("Saber raw-account snapshot is older than the simulation or pool-state read");
    }
    const rawAccounts = new Map(
      addresses.map((address, index) => [address, snapshot.value[index]])
    );
    const result = validateSaberStableSwapCpi({
      programId: SABER_STABLE_SWAP_PROGRAM_ID,
      accounts: cpi.accounts,
      data: cpi.data,
      expectedUserAuthority: programAuthority,
      decoded,
      rawAccounts
    });
    if (result.swapKey !== expectedPoolKey) {
      throw new Error("Saber validator returned a pool different from the trusted route quote");
    }

    const [swapKey, swapAuthority, userAuthority, userSource, swapSource,
      swapDestination, userDestination, adminDestination] = cpi.accounts;
    const relevantTokenTransfers = cpiInstructions.filter((item) =>
      item?.outerInstructionIndex === outerIndex &&
      item.programId === SABER_TOKEN_PROGRAM_ID &&
      Array.isArray(item.accounts) && item.accounts.length === 3 &&
      item.accounts.some((key) => [
        userSource, swapSource, swapDestination, userDestination, adminDestination
      ].includes(key))
    );
    const decodeTransferAmount = (item) => {
      if (typeof item.data !== "string") {
        throw new Error("Saber simulated token transfer data is missing");
      }
      let bytes;
      try { bytes = Buffer.from(bs58.decode(item.data)); } catch {
        throw new Error("Saber simulated token transfer data is malformed");
      }
      if (bytes.length !== 9 || bytes[0] !== 3) {
        throw new Error("Saber simulated CPI is not an exact SPL Token Transfer instruction");
      }
      return bytes.readBigUInt64LE(1);
    };
    const matchesTransfer = (item, source, destination, authority) =>
      item.accounts[0] === source &&
      item.accounts[1] === destination &&
      item.accounts[2] === authority;
    const inputTransfers = relevantTokenTransfers.filter((item) =>
      matchesTransfer(item, userSource, swapSource, userAuthority)
    );
    const outputTransfers = relevantTokenTransfers.filter((item) =>
      matchesTransfer(item, swapDestination, userDestination, swapAuthority)
    );
    const feeTransfers = relevantTokenTransfers.filter((item) =>
      matchesTransfer(item, swapDestination, adminDestination, swapAuthority)
    );
    if (relevantTokenTransfers.length !== 3 ||
        inputTransfers.length !== 1 ||
        outputTransfers.length !== 1 ||
        feeTransfers.length !== 1) {
      throw new Error("Saber CPI must contain exactly the three source, output, and admin-fee token transfers");
    }
    const simulatedAmountIn = decodeTransferAmount(inputTransfers[0]);
    const simulatedAmountOut = decodeTransferAmount(outputTransfers[0]);
    const simulatedAdminFee = decodeTransferAmount(feeTransfers[0]);
    if (simulatedAmountIn !== BigInt(result.amountIn) ||
        simulatedAmountOut < BigInt(result.minimumAmountOut) ||
        simulatedAmountOut + simulatedAdminFee > BigInt(result.destinationReserveAmount)) {
      throw new Error("Saber simulated token-transfer amounts do not satisfy Swap input, slippage, or reserve bounds");
    }

    validations.push(Object.freeze({
      ...result,
      simulatedAmountIn: simulatedAmountIn.toString(),
      simulatedAmountOut: simulatedAmountOut.toString(),
      simulatedAdminFee: simulatedAdminFee.toString(),
      accountContextSlot: snapshot.context.slot,
      simulationContextSlot
    }));
  }
  return Object.freeze(validations);
}

async function inspectMetisOrderWithTrustedRpc({
  rpc,
  encodedTransaction,
  decoded,
  tokenAccountExpectations,
  allowedCpiProgramIds,
  allowedCpiAccountKeys,
  minContextSlot = 0,
  maxSlotLag = 32,
  requiredCpiProgramIds = [],
  expectedCpiProgramIds = [],
  expectedCpiOuterInstructionIndexes,
  expectedSaberPoolKeys = []
} = {}) {
  if (!rpc || !trustedRpcClients.has(rpc) || typeof rpc.getSlot !== "function" ||
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

  const verifiedDecoded = await decodeSolanaTransaction(encodedTransaction, {
    lookupTableResolver: (tableKey) => rpc.resolveAddressLookupTable(tableKey, { minContextSlot })
  });
  if (JSON.stringify(verifiedDecoded) !== JSON.stringify(decoded)) {
    throw new Error("Decoded transaction does not match the exact serialized transaction being simulated");
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
    decoded: verifiedDecoded,
    simulationMeta: simulation.value,
    allowedCpiProgramIds,
    allowedCpiAccountKeys,
    expectedOuterInstructionIndexes: expectedCpiOuterInstructionIndexes
  });
  if (!Array.isArray(requiredCpiProgramIds) ||
      requiredCpiProgramIds.some((programId) => !cpi.programIds.includes(programId))) {
    throw new Error("Trusted CPI trace does not contain every DEX program in the Metis route");
  }
  if (!Array.isArray(expectedCpiProgramIds) || expectedCpiProgramIds.length === 0 ||
      cpi.programIds.some((programId) => !expectedCpiProgramIds.includes(programId)) ||
      expectedCpiProgramIds.some((programId) => !cpi.programIds.includes(programId))) {
    throw new Error("Trusted CPI trace differs from the exact expected DEX/supporting-program set");
  }

  const saberCpiValidations = await inspectSaberCpiAfterSimulation({
    rpc,
    decoded: verifiedDecoded,
    cpiInstructions: cpi.instructions,
    simulationContextSlot: simulation.context.slot,
    expectedOuterInstructionIndexes: expectedCpiOuterInstructionIndexes,
    expectedPoolKeys: expectedSaberPoolKeys
  });

  return Object.freeze({
    allowed: true,
    rpcEndpoint: rpc.endpoint,
    accountContextSlot: accountResponse.context.slot,
    simulationContextSlot: simulation.context.slot,
    tokenAccounts: Object.freeze(tokenAccounts),
    cpi,
    saberCpiValidations
  });
}

export { createTrustedSolanaRpc, inspectMetisOrderWithTrustedRpc, inspectSaberCpiAfterSimulation };
