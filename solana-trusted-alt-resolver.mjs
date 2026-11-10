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
  if (typeof trustedRpcEndpoint !== "string" ||
      !trustedRpcEndpoint.trim() ||
      connection.rpcEndpoint !== trustedRpcEndpoint) {
    throw new Error("RPC endpoint does not match the explicitly trusted endpoint");
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

    let state;
    try {
      state = deserializeLookupTable(accountInfo.data);
    } catch {
      throw new Error("ALT account data could not be decoded");
    }
    if (!state || !Array.isArray(state.addresses)) {
      throw new Error("ALT account state is invalid");
    }
    if (BigInt(state.deactivationSlot) !== MAX_U64) {
      throw new Error("Deactivated ALT tables are not accepted");
    }

    const currentSlot = await connection.getSlot(commitment);
    if (!Number.isInteger(currentSlot) || currentSlot < responseSlot ||
        currentSlot - responseSlot > maxSlotLag) {
      throw new Error("ALT RPC context is stale or inconsistent");
    }
    if (!Number.isInteger(state.lastExtendedSlot) ||
        state.lastExtendedSlot < 0 ||
        state.lastExtendedSlot >= currentSlot) {
      throw new Error("ALT table was extended too recently to use safely");
    }

    return new AddressLookupTableAccount({ key: tableKey, state });
  };
}
