import {
  AddressLookupTableAccount,
  AddressLookupTableProgram
} from "@solana/web3.js";

const MAX_U64 = (1n << 64n) - 1n;
const DEFAULT_MAX_SLOT_LAG = 32;

/**
 * Build a fail-closed ALT resolver around one explicitly trusted RPC connection.
 *
 * This helper is intentionally not wired into Worker/live execution. The caller
 * must supply the exact trusted RPC endpoint from server-side configuration.
 */
export function createTrustedAltResolver({
  connection,
  trustedRpcEndpoint,
  commitment = "confirmed",
  maxSlotLag = DEFAULT_MAX_SLOT_LAG,
  minContextSlot = 0,
  deserializeLookupTable = AddressLookupTableAccount.deserialize
} = {}) {
  if (!connection ||
      typeof connection.getAccountInfoAndContext !== "function" ||
      typeof connection.getSlot !== "function") {
    throw new Error("A trusted Solana RPC connection is required");
  }
  let endpoint;
  try {
    endpoint = new URL(trustedRpcEndpoint);
  } catch {
    throw new Error("An explicit HTTPS trusted RPC endpoint is required");
  }
  if (endpoint.protocol !== "https:" ||
      connection.rpcEndpoint !== trustedRpcEndpoint) {
    throw new Error("RPC endpoint does not match the explicitly trusted HTTPS endpoint");
  }
  if (!Number.isInteger(maxSlotLag) || maxSlotLag < 0 ||
      !Number.isInteger(minContextSlot) || minContextSlot < 0) {
    throw new Error("ALT slot freshness settings are invalid");
  }
  if (typeof deserializeLookupTable !== "function") {
    throw new Error("ALT account decoder is invalid");
  }

  return async function resolveTrustedAddressLookupTable(tableKey) {
    if (!tableKey || typeof tableKey.toBase58 !== "function") {
      throw new Error("ALT lookup key is invalid");
    }

    const accountResponse = await connection.getAccountInfoAndContext(
      tableKey,
      { commitment, minContextSlot }
    );
    const accountInfo = accountResponse?.value;
    const responseSlot = accountResponse?.context?.slot;
    if (!accountInfo || !Number.isInteger(responseSlot) || responseSlot < minContextSlot) {
      throw new Error("ALT account is missing or its RPC context is invalid");
    }
    if (!accountInfo.owner?.equals?.(AddressLookupTableProgram.programId)) {
      throw new Error("ALT account is not owned by the canonical Address Lookup Table Program");
    }
    if (accountInfo.executable !== false) {
      throw new Error("ALT account must be a non-executable data account");
    }

    let state;
    try {
      state = deserializeLookupTable(accountInfo.data);
    } catch (error) {
      throw new Error("ALT account data could not be decoded: " + (error?.message || "unknown decoder error"));
    }
    if (!state || !Array.isArray(state.addresses) ||
        state.addresses.length > 256 ||
        state.addresses.some((address) => !address || typeof address.toBase58 !== "function") ||
        !Number.isInteger(state.lastExtendedSlotStartIndex) ||
        state.lastExtendedSlotStartIndex < 0 ||
        state.lastExtendedSlotStartIndex > state.addresses.length) {
      throw new Error("ALT account state is invalid");
    }
    let deactivationSlot;
    try {
      deactivationSlot = BigInt(state.deactivationSlot);
    } catch {
      throw new Error("ALT deactivation slot is invalid");
    }
    if (deactivationSlot !== MAX_U64) {
      throw new Error("Deactivated ALT tables are not accepted");
    }

    const currentSlot = await connection.getSlot(commitment);
    if (!Number.isInteger(currentSlot) || currentSlot < responseSlot ||
        currentSlot - responseSlot > maxSlotLag) {
      throw new Error("ALT RPC context is stale or inconsistent");
    }
    let lastExtendedSlot;
    try {
      lastExtendedSlot = BigInt(state.lastExtendedSlot);
    } catch {
      throw new Error("ALT last extension slot is invalid");
    }
    if (lastExtendedSlot < 0n || lastExtendedSlot >= BigInt(currentSlot)) {
      throw new Error("ALT table was extended too recently to use safely");
    }

    return new AddressLookupTableAccount({ key: tableKey, state });
  };
}
