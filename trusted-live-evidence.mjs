const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const EXPECTED_BOT_WALLET = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const JUPITER_ORDER_URL = "https://api.jup.ag/swap/v2/order";
const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/SOL-USD/spot";
const DEX_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens/";
const RUGCHECK_URL = "https://api.rugcheck.xyz/v1/tokens/";
const DEVNET_OR_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const EXPECTED_TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

function decodeBase58(value) {
  let number = 0n;
  for (const char of value) {
    const digit = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".indexOf(char);
    if (digit < 0) throw new Error("Invalid base58 address");
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (let i = 0; i < value.length && value[i] === "1"; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

function encodeBase58(bytes) {
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[remainder] + encoded;
    number /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) encoded = "1" + encoded;
  return encoded || "1";
}

function readShortVector(bytes, offset) {
  let value = 0, shift = 0, cursor = offset;
  for (let i = 0; i < 3; i++) {
    if (cursor >= bytes.length) throw new Error("Jupiter transaction is truncated");
    const byte = bytes[cursor++];
    const digit = byte & 0x7f;
    if (i === 2 && (digit > 3 || (byte & 0x80) !== 0)) {
      throw new Error("Jupiter transaction compact length exceeds u16");
    }
    value += digit * (2 ** shift);
    if ((byte & 0x80) === 0) {
      if (i > 0 && digit === 0) {
        throw new Error("Jupiter transaction compact length is non-canonical");
      }
      return { value, offset: cursor };
    }
    shift += 7;
  }
  throw new Error("Jupiter transaction has an invalid compact length");
}

function validateUnsignedJupiterV1(bytes, expectedSigner) {
  // Solana v1 uses fixed-width counts, inline addresses, config values after
  // the address vector, split instruction headers/payloads, and tail signatures.
  // It has no Address Lookup Tables.
  if (bytes.length > 4096) {
    throw new Error("V1 Jupiter transaction exceeds the 4,096-byte size limit");
  }
  let cursor = 1;
  if (cursor + 3 + 4 + 32 + 2 > bytes.length) {
    throw new Error("V1 Jupiter transaction message is truncated");
  }
  const requiredSignatures = bytes[cursor++];
  const readonlySigned = bytes[cursor++];
  const readonlyUnsigned = bytes[cursor++];
  if (requiredSignatures !== 1 || readonlySigned > requiredSignatures) {
    throw new Error("V1 Jupiter transaction signer header is inconsistent");
  }
  const configMask = (bytes[cursor] | (bytes[cursor + 1] << 8) |
    (bytes[cursor + 2] << 16) | (bytes[cursor + 3] << 24)) >>> 0;
  cursor += 4;
  if ((configMask & ~0x1f) !== 0 ||
      ((configMask & 0x3) !== 0 && (configMask & 0x3) !== 0x3)) {
    throw new Error("V1 Jupiter transaction config mask is unsupported");
  }
  cursor += 32; // recent blockhash
  const instructionCount = bytes[cursor++];
  const addressCount = bytes[cursor++];
  if (instructionCount < 1 || instructionCount > 64 ||
      addressCount < requiredSignatures || addressCount > 64 ||
      readonlyUnsigned > addressCount - requiredSignatures) {
    throw new Error("V1 Jupiter transaction instruction or address count is invalid");
  }
  const addressesStart = cursor;
  if (cursor + addressCount * 32 > bytes.length) {
    throw new Error("V1 Jupiter transaction addresses are truncated");
  }
  const expectedBytes = decodeBase58(expectedSigner);
  if (expectedBytes.length !== 32 ||
      bytes.slice(addressesStart, addressesStart + 32).some((byte, i) => byte !== expectedBytes[i])) {
    throw new Error("Jupiter transaction is not pinned to the expected bot wallet");
  }
  cursor += addressCount * 32;
  const configBytes = ((configMask & 0x3) ? 8 : 0) +
    ((configMask & 0x4) ? 4 : 0) +
    ((configMask & 0x8) ? 4 : 0) +
    ((configMask & 0x10) ? 4 : 0);
  if (cursor + configBytes > bytes.length) {
    throw new Error("V1 Jupiter transaction config values are truncated");
  }
  cursor += configBytes;
  const headers = [];
  for (let i = 0; i < instructionCount; i++) {
    if (cursor + 4 > bytes.length) {
      throw new Error("V1 Jupiter instruction headers are truncated");
    }
    const programIdIndex = bytes[cursor++];
    const accountCount = bytes[cursor++];
    const dataLength = bytes[cursor] | (bytes[cursor + 1] << 8);
    cursor += 2;
    if (programIdIndex >= addressCount || accountCount > addressCount ||
        dataLength > 4096) {
      throw new Error("V1 Jupiter instruction header is invalid");
    }
    headers.push({ programIdIndex, accountCount, dataLength });
  }
  for (const header of headers) {
    if (cursor + header.accountCount + header.dataLength > bytes.length) {
      throw new Error("V1 Jupiter instruction payload is truncated");
    }
    for (let i = 0; i < header.accountCount; i++) {
      if (bytes[cursor++] >= addressCount) {
        throw new Error("V1 Jupiter instruction account index is invalid");
      }
    }
    cursor += header.dataLength;
  }
  const signaturesLength = requiredSignatures * 64;
  if (cursor + signaturesLength !== bytes.length) {
    throw new Error("V1 Jupiter transaction signature section or trailing bytes are invalid");
  }
  for (let i = cursor; i < bytes.length; i++) {
    if (bytes[i] !== 0) throw new Error("Jupiter order transaction must be unsigned");
  }
  return {
    signatureCount: requiredSignatures,
    staticAccountCount: addressCount,
    instructionCount,
    addressLookupCount: 0,
    messageVersion: 1,
    semanticInstructionVerification: false
  };
}

export function validateUnsignedJupiterTransaction(encoded, expectedSigner) {
  if (typeof encoded !== "string" || encoded.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Jupiter transaction is empty or not canonical base64");
  }
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  // Bound decoded input before canonicalization; v1 has a larger protocol limit.
  if (bytes.length > 4096) {
    throw new Error("Jupiter transaction exceeds the 4,096-byte size limit");
  }
  if (btoa(String.fromCharCode(...bytes)) !== encoded) {
    throw new Error("Jupiter transaction base64 encoding is non-canonical");
  }
  if (bytes[0] === 0x81) return validateUnsignedJupiterV1(bytes, expectedSigner);
  if (bytes.length > 1232) {
    throw new Error("Legacy/v0 Jupiter transaction exceeds the 1,232-byte size limit");
  }
  const sigHeader = readShortVector(bytes, 0);
  const signatureCount = sigHeader.value;
  if (signatureCount < 1 || signatureCount > 64 ||
      sigHeader.offset + signatureCount * 64 >= bytes.length) {
    throw new Error("Jupiter transaction signature section is invalid");
  }
  const signaturesEnd = sigHeader.offset + signatureCount * 64;
  for (let i = sigHeader.offset; i < signaturesEnd; i++) {
    if (bytes[i] !== 0) throw new Error("Jupiter order transaction must be unsigned");
  }
  const messageStart = signaturesEnd;
  let cursor = messageStart;
  let messageVersion = "legacy";
  if ((bytes[cursor] & 0x80) !== 0) {
    if ((bytes[cursor] & 0x7f) !== 0) throw new Error("Unsupported Jupiter transaction message version");
    messageVersion = 0;
    cursor++;
  }
  if (cursor + 3 > bytes.length) throw new Error("Jupiter transaction message is truncated");
  const requiredSignatures = bytes[cursor++];
  const readonlySigned = bytes[cursor++];
  const readonlyUnsigned = bytes[cursor++];
  // The coordinator pins exactly one signer: the dedicated bot wallet.
  // Additional required signers are outside the reviewed authorization model.
  if (requiredSignatures !== 1 || requiredSignatures !== signatureCount ||
      readonlySigned > requiredSignatures) {
    throw new Error("Jupiter transaction signer header is inconsistent");
  }
  const keysHeader = readShortVector(bytes, cursor);
  const keyCount = keysHeader.value;
  cursor = keysHeader.offset;
  if (keyCount < requiredSignatures || keyCount > 256 ||
      readonlyUnsigned > keyCount - requiredSignatures ||
      readonlySigned + readonlyUnsigned > keyCount ||
      cursor + keyCount * 32 + 32 > bytes.length) {
    throw new Error("Jupiter transaction account keys or blockhash are invalid");
  }
  const signerBytes = bytes.slice(cursor, cursor + 32);
  const expectedBytes = decodeBase58(expectedSigner);
  if (expectedBytes.length !== 32 || signerBytes.some((byte, i) => byte !== expectedBytes[i])) {
    throw new Error("Jupiter transaction is not pinned to the expected bot wallet");
  }
  cursor += keyCount * 32;
  cursor += 32; // recent blockhash
  const instructionHeader = readShortVector(bytes, cursor);
  const instructionCount = instructionHeader.value;
  cursor = instructionHeader.offset;
  const instructionAccountIndexes = [];
  if (instructionCount < 1 || instructionCount > 256) {
    throw new Error("Jupiter transaction has no instructions or an invalid instruction count");
  }
  for (let i = 0; i < instructionCount; i++) {
    if (cursor >= bytes.length) throw new Error("Jupiter instruction is truncated");
    const programIdIndex = bytes[cursor++];
    if (programIdIndex >= keyCount) throw new Error("Jupiter instruction program index is invalid");
    const accountHeader = readShortVector(bytes, cursor);
    cursor = accountHeader.offset;
    if (accountHeader.value > 256 || cursor + accountHeader.value > bytes.length) {
      throw new Error("Jupiter instruction account list is invalid");
    }
    for (let j = 0; j < accountHeader.value; j++) {
      instructionAccountIndexes.push(bytes[cursor++]);
    }
    const dataHeader = readShortVector(bytes, cursor);
    cursor = dataHeader.offset;
    if (dataHeader.value > 1232 || cursor + dataHeader.value > bytes.length) {
      throw new Error("Jupiter instruction data is invalid");
    }
    cursor += dataHeader.value;
  }
  let addressLookupCount = 0;
  let loadedAddressCount = 0;
  const addressLookups = [];
  if (messageVersion === 0) {
    const lookupHeader = readShortVector(bytes, cursor);
    addressLookupCount = lookupHeader.value;
    cursor = lookupHeader.offset;
    if (lookupHeader.value > 64) throw new Error("Jupiter address lookup count is invalid");
    for (let i = 0; i < lookupHeader.value; i++) {
      if (cursor + 32 > bytes.length) throw new Error("Jupiter address lookup is truncated");
      const tableAddress = encodeBase58(bytes.slice(cursor, cursor + 32));
      cursor += 32;
      const writable = readShortVector(bytes, cursor);
      cursor = writable.offset;
      if (writable.value > 256 || cursor + writable.value > bytes.length) {
        throw new Error("Jupiter writable lookup indexes are truncated or invalid");
      }
      const writableIndexes = Array.from(bytes.slice(cursor, cursor + writable.value));
      loadedAddressCount += writable.value;
      cursor += writable.value;
      const readonly = readShortVector(bytes, cursor);
      cursor = readonly.offset;
      if (readonly.value > 256 || cursor + readonly.value > bytes.length) {
        throw new Error("Jupiter readonly lookup indexes are truncated or invalid");
      }
      const readonlyIndexes = Array.from(bytes.slice(cursor, cursor + readonly.value));
      loadedAddressCount += readonly.value;
      cursor += readonly.value;
      addressLookups.push({ accountKey: tableAddress, writableIndexes, readonlyIndexes });
    }
  }
  // Compiled instruction account indexes address static keys followed by
  // writable and readonly ALT-loaded keys. Validate against the complete key space.
  if (instructionAccountIndexes.some(index => index >= keyCount + loadedAddressCount)) {
    throw new Error("Jupiter instruction account index is invalid");
  }
  if (cursor !== bytes.length) throw new Error("Jupiter transaction contains trailing or unparsed bytes");
  return {
    signatureCount,
    staticAccountCount: keyCount,
    instructionCount,
    addressLookupCount,
    addressLookups,
    messageVersion,
    // Lookup descriptors are retained for independent RPC resolution; semantics stay untrusted.
    semanticInstructionVerification: false
  };
}
function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(label + " is missing or invalid");
  return number;
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(new URL(url).hostname + " returned HTTP " + response.status);
  return response.json();
}

/** Fetches and timestamps the quote on the trusted server; caller timestamps are never used. */
export async function fetchTrustedSolUsdQuote(fetchImpl = fetch) {
  const fetchedAt = Date.now();
  const payload = await fetchJson(fetchImpl, COINBASE_SPOT_URL, {
    headers: { Accept: "application/json" }
  });
  const price = positive(payload?.data?.amount, "Coinbase SOL/USD price");
  if (payload?.data?.base !== "SOL" || payload?.data?.currency !== "USD") {
    throw new Error("Coinbase returned an unexpected SOL/USD quote");
  }
  return Object.freeze({
    provider: "Coinbase",
    pair: "SOL/USD",
    price,
    fetchedAt,
    quoteId: "coinbase-sol-usd-" + fetchedAt
  });
}

async function fetchCompleteMintTokenAccounts(mint, fetchImpl, alchemyApiKey) {
  if (typeof alchemyApiKey !== "string" || alchemyApiKey.length < 16) {
    throw new Error("Alchemy API key is required for complete paginated holder verification");
  }
  const endpoint = "https://solana-mainnet.g.alchemy.com/v2/" + encodeURIComponent(alchemyApiKey);
  const limit = 100;
  const accounts = [];
  const seenAccounts = new Set();
  for (let page = 1; page <= 100; page++) {
    const payload = await fetchJson(fetchImpl, endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: page,
        method: "getTokenAccounts",
        params: { mintAddress: mint, page, limit, options: { showZeroBalance: false } }
      })
    });
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        payload.jsonrpc !== "2.0" || payload.id !== page || payload.error ||
        !payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) {
      throw new Error("Alchemy getTokenAccounts response envelope is invalid");
    }
    const result = payload.result;
    const rows = result?.token_accounts;
    if (!Array.isArray(rows)) throw new Error("Alchemy holder page has an invalid response shape");
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      throw new Error("Alchemy holder page reported indexing errors");
    }
    for (const row of rows) {
      const rawAmount = String(row.amount);
      const accountAddress = row.address || row.pubkey;
      if (row.mint !== mint || typeof row.owner !== "string" ||
          typeof accountAddress !== "string" || accountAddress.length < 32 ||
          seenAccounts.has(accountAddress) || !/^\d+$/.test(rawAmount) || BigInt(rawAmount) <= 0n) {
        throw new Error("Alchemy holder page contains incomplete, duplicate, or mismatched account data");
      }
      seenAccounts.add(accountAddress);
      accounts.push({ address: accountAddress, owner: row.owner, amount: BigInt(rawAmount) });    }
    if (rows.length < limit) {
      if (accounts.length === 0) throw new Error("No positive-balance token accounts were found");
      return accounts;
    }
  }
  throw new Error("Holder pagination exceeded the 100-page safety limit");
}

async function fetchTrustedSellRoute(mint, priceUsd, supplyAmount, decimals, fetchImpl, jupiterApiKey) {
  if (typeof jupiterApiKey !== "string" || jupiterApiKey.trim().length < 16) {
    throw new Error("Jupiter API key is required for server-side sell-route verification");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Token decimals are unavailable for sell-route verification");
  }
  const priceText = String(priceUsd);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(priceText);
  if (!match) throw new Error("Token USD price format is unsupported for sell-route verification");
  const priceScale = 24;
  const priceScaled = BigInt(match[1] + (match[2] || "").padEnd(priceScale, "0").slice(0, priceScale));
  if (priceScaled <= 0n) throw new Error("Token USD price is invalid for sell-route verification");
  const amount = (3n * (10n ** BigInt(decimals)) * (10n ** BigInt(priceScale))) / priceScaled;
  const maxProbeAmount = supplyAmount / 100n;
  if (amount <= 0n || maxProbeAmount <= 0n || amount > maxProbeAmount) {
    throw new Error("A $3 sell-route quote would exceed 1% of token supply or is below token precision");
  }

  // A quote-only request deliberately omits taker. It verifies that Jupiter
  // currently sees a route without requiring the bot wallet to own tokens
  // before its first purchase. It does not create an executable transaction.
  const params = new URLSearchParams({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: amount.toString()
  });
  const order = await fetchJson(fetchImpl, JUPITER_ORDER_URL + "?" + params.toString(), {
    headers: { "x-api-key": jupiterApiKey.trim(), Accept: "application/json" }
  });
  if (!order || typeof order !== "object" ||
      typeof order.requestId !== "string" || order.requestId.length === 0 ||
      order.transaction !== null ||
      order.inputMint !== mint || order.outputMint !== SOL_MINT ||
      String(order.inAmount) !== amount.toString() ||
      !/^\d+$/.test(String(order.outAmount || "")) || BigInt(order.outAmount) <= 0n ||
      !Array.isArray(order.routePlan) || order.routePlan.length === 0 ||
      order.errorCode != null) {
    throw new Error("Jupiter did not return a complete quote-only sell-route response");
  }
  return Object.freeze({
    provider: "Jupiter Swap API V2",
    requestId: order.requestId || null,
    inputAmount: amount.toString(),
    outputLamports: String(order.outAmount),
    router: String(order.router || "unknown"),
    routePlanCount: order.routePlan.length,
    signatureCount: null,
    staticAccountCount: null,
    messageVersion: null,
    semanticInstructionVerification: false,
    routeVerification: "quote-only-no-transaction"
  });
}

const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = "AddressLookupTab1e1111111111111111111111111";
const ALT_DEACTIVATION_SLOT_NEVER = 18446744073709551615n;

/**
 * Resolves v0 lookup descriptors against finalized mainnet account state.
 * Any missing, malformed, foreign-owned, deactivated, or not-yet-warmed table
 * fails closed. This establishes address resolution only, not instruction safety.
 */
export async function resolveJupiterAddressLookupTables(lookups, fetchImpl = fetch) {
  if (!Array.isArray(lookups) || lookups.length === 0 || lookups.length > 64) {
    throw new Error("Jupiter address lookup descriptors are missing or invalid");
  }
  const keys = lookups.map(item => item?.accountKey);
  if (keys.some(key => typeof key !== "string" || decodeBase58(key).length !== 32) ||
      new Set(keys).size !== keys.length) {
    throw new Error("Jupiter address lookup table keys are invalid or duplicated");
  }
  const result = await rpc(fetchImpl, "getMultipleAccounts", [
    keys, { commitment: "finalized", encoding: "base64" }
  ]);
  const contextSlot = result?.context?.slot;
  const accounts = result?.value;
  if (!Number.isSafeInteger(contextSlot) || contextSlot < 1 ||
      !Array.isArray(accounts) || accounts.length !== lookups.length) {
    throw new Error("Address lookup RPC response context or account count is invalid");
  }
  const resolved = [];
  for (let i = 0; i < lookups.length; i++) {
    const account = accounts[i];
    if (!account || account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ID ||
        !Array.isArray(account.data) || typeof account.data[0] !== "string" ||
        account.data[1] !== "base64") {
      throw new Error("Address lookup table is missing, malformed, or owned by an unexpected program");
    }
    const data = Uint8Array.from(atob(account.data[0]), char => char.charCodeAt(0));
    if (data.length < 56 || (data.length - 56) % 32 !== 0 ||
        data.length > 56 + 256 * 32) {
      throw new Error("Address lookup table account data length is invalid");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== 1) {
      throw new Error("Address lookup table account state is not initialized");
    }
    const deactivationSlot = view.getBigUint64(4, true);
    const lastExtendedSlot = view.getBigUint64(12, true);
    const lastExtendedStartIndex = data[20];
    const authorityOption = data[21];
    if (authorityOption > 1 || data[54] !== 0 || data[55] !== 0 ||
        lastExtendedStartIndex > (data.length - 56) / 32) {
      throw new Error("Address lookup table metadata is invalid");
    }
    if (deactivationSlot !== ALT_DEACTIVATION_SLOT_NEVER) {
      throw new Error("Deactivated address lookup tables are not trusted");
    }
    if (lastExtendedSlot > BigInt(contextSlot)) {
      throw new Error("Address lookup table extension slot is ahead of RPC context");
    }
    const addresses = [];
    for (let offset = 56; offset < data.length; offset += 32) {
      addresses.push(encodeBase58(data.slice(offset, offset + 32)));
    }
    const table = lookups[i];
    const allIndexes = [...table.writableIndexes, ...table.readonlyIndexes];
    if (!Array.isArray(table.writableIndexes) || !Array.isArray(table.readonlyIndexes) ||
        allIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= addresses.length)) {
      throw new Error("Address lookup table index is outside the resolved address range");
    }
    const usableCount = lastExtendedSlot === BigInt(contextSlot)
      ? lastExtendedStartIndex
      : addresses.length;
    if (allIndexes.some(index => index >= usableCount)) {
      throw new Error("Address lookup table contains an address that is not warmed up");
    }
    resolved.push({
      accountKey: table.accountKey,
      writable: table.writableIndexes.map(index => addresses[index]),
      readonly: table.readonlyIndexes.map(index => addresses[index])
    });
  }
  // Solana compiles loaded account keys as all writable addresses first,
  // followed by all readonly addresses, preserving table order within each set.
  const writableAddresses = resolved.flatMap(table => table.writable);
  const readonlyAddresses = resolved.flatMap(table => table.readonly);
  return Object.freeze({
    contextSlot,
    writableAddresses: Object.freeze(writableAddresses),
    readonlyAddresses: Object.freeze(readonlyAddresses),
    tables: Object.freeze(resolved.map(table => Object.freeze({
      ...table,
      writable: Object.freeze(table.writable),
      readonly: Object.freeze(table.readonly)
    })))
  });
}

/**
 * Validates the unsigned message and resolves every v0 ALT against finalized
 * RPC state. The result remains structurally trusted only; instruction
 * semantics are deliberately never promoted by address resolution alone.
 */
export async function validateAndResolveUnsignedJupiterTransaction(
  encoded, expectedSigner, fetchImpl = fetch
) {
  const parsed = validateUnsignedJupiterTransaction(encoded, expectedSigner);
  if (parsed.addressLookupCount === 0) {
    return Object.freeze({
      ...parsed,
      lookupTableResolution: "not-required",
      resolvedWritableAddresses: Object.freeze([]),
      resolvedReadonlyAddresses: Object.freeze([])
    });
  }
  if (!Array.isArray(parsed.addressLookups) ||
      parsed.addressLookups.length !== parsed.addressLookupCount) {
    throw new Error("Jupiter address lookup descriptors are incomplete");
  }
  const resolution = await resolveJupiterAddressLookupTables(parsed.addressLookups, fetchImpl);
  return Object.freeze({
    ...parsed,
    lookupTableResolution: "finalized-resolved",
    lookupContextSlot: resolution.contextSlot,
    resolvedWritableAddresses: resolution.writableAddresses,
    resolvedReadonlyAddresses: resolution.readonlyAddresses,
    semanticInstructionVerification: false
  });
}

async function rpc(fetchImpl, method, params) {
  const payload = await fetchJson(fetchImpl, DEVNET_OR_MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.jsonrpc !== "2.0" || payload.id !== 1 ||
      payload.error || !Object.prototype.hasOwnProperty.call(payload, "result")) {
    throw new Error(method + " RPC response envelope or result is invalid");
  }
  return payload.result;
}

function sumOwnedTokenBalance(rows, mint, owner) {
  if (!Array.isArray(rows)) throw new Error("Finalized transaction token balance metadata is unavailable");
  let total = 0n;
  for (const row of rows) {
    if (row?.mint !== mint || row?.owner !== owner) continue;
    const amount = row?.uiTokenAmount?.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
      throw new Error("Finalized transaction contains an invalid owned token balance");
    }
    total += BigInt(amount);
  }
  return total;
}

/**
 * Independently verifies a finalized swap using signature status and the
 * transaction's owner-scoped pre/post balances. It never trusts caller-supplied
 * success flags. All input and output mints, including wrapped SOL, are
 * verified through exact owner-scoped SPL token balance deltas.
 */
export async function verifyFinalizedJupiterSettlement({
  signature, inputMint, outputMint, inputAmount, outputAmount,
  expectedOwner = EXPECTED_BOT_WALLET
}, fetchImpl = fetch) {
  const validAddress = value => typeof value === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && decodeBase58(value).length === 32;
  const validAmount = value => typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n;
  if (typeof signature !== "string" || decodeBase58(signature).length !== 64 ||
      !validAddress(inputMint) || !validAddress(outputMint) || inputMint === outputMint ||
      !validAddress(expectedOwner) || expectedOwner !== EXPECTED_BOT_WALLET ||
      !validAmount(inputAmount) || !validAmount(outputAmount)) {
    throw new Error("Settlement proof request is incomplete or invalid");
  }

  const statusResult = await rpc(fetchImpl, "getSignatureStatuses", [
    [signature], { searchTransactionHistory: true }
  ]);
  const status = statusResult?.value?.[0];
  if (!status || status.err !== null || status.confirmationStatus !== "finalized") {
    throw new Error("Swap signature is not successfully finalized");
  }

  const transaction = await rpc(fetchImpl, "getTransaction", [
    signature, {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: 0
    }
  ]);
  const meta = transaction?.meta;
  const message = transaction?.transaction?.message;
  const signatures = transaction?.transaction?.signatures;
  const accountKeys = message?.accountKeys;
  if (!transaction || !Number.isSafeInteger(transaction.slot) || transaction.slot < 1 ||
      !meta || meta.err !== null || !Array.isArray(signatures) || !signatures.includes(signature) ||
      !Array.isArray(accountKeys) || !Array.isArray(meta.preBalances) ||
      !Array.isArray(meta.postBalances) || meta.preBalances.length !== accountKeys.length ||
      meta.postBalances.length !== accountKeys.length ||
      !Number.isSafeInteger(meta.fee) || meta.fee < 0) {
    throw new Error("Finalized transaction metadata is incomplete or indicates failure");
  }
  const keyStrings = accountKeys.map(key => typeof key === "string" ? key : key?.pubkey);
  const ownerIndex = keyStrings.indexOf(expectedOwner);
  // Solana's first required signer is the fee payer. Require the pinned bot
  // wallet in that position so a third-party transaction cannot settle an order.
  if (ownerIndex !== 0) throw new Error("Expected bot wallet is not the finalized transaction fee payer");

  const preOutput = sumOwnedTokenBalance(meta.preTokenBalances, outputMint, expectedOwner);
  const postOutput = sumOwnedTokenBalance(meta.postTokenBalances, outputMint, expectedOwner);
  if (postOutput - preOutput !== BigInt(outputAmount)) {
    throw new Error("Finalized output token balance delta does not match the reserved amount");
  }

  // Jupiter's SOL mint is wrapped SOL (an SPL token), not the wallet's
  // native lamport balance. Verify the exact token-account delta for every
  // input mint; native lamport deltas also include fees and account rent.
  const preInput = sumOwnedTokenBalance(meta.preTokenBalances, inputMint, expectedOwner);
  const postInput = sumOwnedTokenBalance(meta.postTokenBalances, inputMint, expectedOwner);
  if (preInput - postInput !== BigInt(inputAmount)) {
    throw new Error("Finalized input token balance delta does not match the reserved amount");
  }

  return Object.freeze({
    verified: true,
    signature,
    slot: transaction.slot,
    confirmationStatus: "finalized",
    inputMint,
    inputAmount,
    outputMint,
    outputAmount,
    owner: expectedOwner
  });
}


function parseMintAccount(account) {
  const value = account?.value;
  if (!value) throw new Error("Mint account is unavailable");
  const parsed = value.data?.parsed?.info;
  if (parsed) {
    const tokenProgram = value.owner;
    if (!EXPECTED_TOKEN_PROGRAMS.has(tokenProgram)) {
      throw new Error("Mint account is owned by an unsupported token program");
    }
    const token2022ExtensionsSafe =
      tokenProgram === TOKEN_PROGRAM_ID ||
      (tokenProgram === TOKEN_2022_PROGRAM_ID &&
        Array.isArray(parsed.extensions) && parsed.extensions.length === 0);
    return {
      mintAuthoritySafe: parsed.mintAuthority == null,
      freezeAuthoritySafe: parsed.freezeAuthority == null,
      token2022ExtensionsSafe
    };
  }
  if (!EXPECTED_TOKEN_PROGRAMS.has(value.owner)) {
    throw new Error("Mint account is owned by an unsupported token program");
  }
  const raw = value.data;
  if (!Array.isArray(raw) || typeof raw[0] !== "string") {
    throw new Error("Mint account encoding is unsupported");
  }
  const bytes = Uint8Array.from(atob(raw[0]), char => char.charCodeAt(0));
  if (bytes.length < 82) throw new Error("Mint account data is truncated");
  const u32 = offset => (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  const mintOption = u32(0);
  const freezeOption = u32(46);
  if (mintOption > 1 || freezeOption > 1) throw new Error("Mint authority layout is invalid");
  const extensions = [];
  if (bytes.length >= 166) {
    let offset = 166;
    while (offset + 4 <= bytes.length) {
      const type = bytes[offset] | (bytes[offset + 1] << 8);
      const length = bytes[offset + 2] | (bytes[offset + 3] << 8);
      if (type === 0 && length === 0) break;
      if (offset + 4 + length > bytes.length) throw new Error("Token-2022 extension data is truncated");
      extensions.push(type);
      offset += 4 + length;
    }
  }
  return {
    mintAuthoritySafe: mintOption === 0,
    freezeAuthoritySafe: freezeOption === 0,
    // Without a trusted Token-2022 TLV/account-type decoder, accept only
    // the exact 82-byte base mint. Any extended/raw layout fails closed.
    token2022ExtensionsSafe: value.owner === TOKEN_PROGRAM_ID
      ? bytes.length === 82
      : bytes.length === 82 && extensions.length === 0
  };
}

/**
 * Risk evidence is generated from server-fetched feeds for the exact mint.
 * Holder concentration is accepted only after all paginated token accounts
 * reconcile exactly to on-chain supply. Jupiter V2 order responses are
 * inspected structurally only; semantic instruction verification is not
 * implemented, so sell-route safety remains false and reservations fail closed.
 */
export async function fetchTrustedTokenRisk(mint, fetchImpl = fetch, alchemyApiKey = "", jupiterApiKey = "") {
  // Timestamp evidence before the slowest upstream request begins. Recording it
  // only after holder pagination and the Jupiter probe could make old market,
  // RugCheck, RPC, or holder data appear freshly fetched.
  const fetchedAt = Date.now();
  if (typeof mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || mint === SOL_MINT) {
    throw new Error("A valid non-SOL output mint is required for risk inspection");
  }
  const [dex, rug, mintAccount, supply, holderAccounts] = await Promise.all([
    fetchJson(fetchImpl, DEX_TOKEN_URL + encodeURIComponent(mint)),
    fetchJson(fetchImpl, RUGCHECK_URL + encodeURIComponent(mint) + "/report"),
    rpc(fetchImpl, "getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "finalized" }]),
    rpc(fetchImpl, "getTokenSupply", [mint, { commitment: "finalized" }]),
    fetchCompleteMintTokenAccounts(mint, fetchImpl, alchemyApiKey)
  ]);
  const pair = (dex?.pairs || [])
    .filter(item => item.chainId === "solana" && item.baseToken?.address === mint)
    .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  if (!pair) throw new Error("No verified Solana market pair for the requested mint");
  const liquidityUsd = positive(pair.liquidity?.usd, "Solana pair liquidity");
  const volume24hUsd = positive(pair.volume?.h24, "Solana pair 24-hour volume");
  const priceUsd = positive(pair.priceUsd, "Solana pair price");
  const sells24h = Number(pair.txns?.h24?.sells);
  if (!Number.isFinite(sells24h)) throw new Error("Solana pair sell-count data is unavailable");
  if (rug?.score == null || !Number.isFinite(Number(rug.score))) {
    throw new Error("RugCheck score is unavailable");
  }
  const mintSafety = parseMintAccount(mintAccount);
  const rawSupplyAmount = String(supply?.value?.amount ?? "");
  if (!/^\d+$/.test(rawSupplyAmount) || BigInt(rawSupplyAmount) <= 0n || holderAccounts.length === 0) {
    throw new Error("Holder account data is incomplete");
  }

  // Alchemy DAS pages every positive-balance token account for this mint.
  // Aggregate multiple token accounts belonging to the same wallet owner.
  const supplyAmount = BigInt(rawSupplyAmount);
  const ownerBalances = new Map();
  let totalAccountBalance = 0n;
  for (const account of holderAccounts) {
    ownerBalances.set(account.owner, (ownerBalances.get(account.owner) || 0n) + account.amount);
    totalAccountBalance += account.amount;
  }
  if (ownerBalances.size === 0 || totalAccountBalance !== supplyAmount) {
    throw new Error("Complete holder census does not reconcile to on-chain token supply");
  }
  const topTenBalance = [...ownerBalances.values()].sort((a, b) => a > b ? -1 : a < b ? 1 : 0)
    .slice(0, 10).reduce((sum, amount) => sum + amount, 0n);
  const concentrationScaled = (topTenBalance * 1_000_000n) / supplyAmount;
  const top10OwnerConcentrationPct = Number(concentrationScaled) / 10_000;
  const sellRoute = await fetchTrustedSellRoute(
    mint,
    pair.priceUsd,
    supplyAmount,
    supply?.value?.decimals,
    fetchImpl,
    jupiterApiKey
  );

  const checks = {
    mintAuthoritySafe: mintSafety.mintAuthoritySafe,
    freezeAuthoritySafe: mintSafety.freezeAuthoritySafe,
    token2022ExtensionsSafe: mintSafety.token2022ExtensionsSafe,
    holderConcentrationSafe: top10OwnerConcentrationPct <= 50,
    // Structure alone does not verify programs, recipients, or lookup-table addresses.
    sellRouteAvailable: sellRoute.semanticInstructionVerification === true,
    marketLiquiditySafe: liquidityUsd >= 10000,
    marketVolumeSafe: volume24hUsd >= 1000 && sells24h > 0,
    rugCheckSafe: Number(rug.score) <= 2500
  };
  return Object.freeze({
    mint,
    provider: "DexScreener + RugCheck + Alchemy DAS + Solana mainnet RPC + Jupiter Swap API V2",
    fetchedAt,
    priceUsd,
    liquidityUsd,
    volume24hUsd,
    sells24h,
    rugScore: Number(rug.score),
    holderAccountCount: holderAccounts.length,
    holderOwnerCount: ownerBalances.size,
    holderSampleOnly: false,
    top10OwnerConcentrationPct,
    sellRoute,
    checks,
    passed: Object.values(checks).every(value => value === true)
  });
}

export async function fetchTrustedLiveEvidence(mint, fetchImpl = fetch, alchemyApiKey = "", jupiterApiKey = "") {
  const [quote, risk] = await Promise.all([
    fetchTrustedSolUsdQuote(fetchImpl),
    fetchTrustedTokenRisk(mint, fetchImpl, alchemyApiKey, jupiterApiKey)
  ]);
  return Object.freeze({ quote, risk, passed: risk.passed });
}
