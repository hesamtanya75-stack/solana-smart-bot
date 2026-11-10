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

export function validateUnsignedJupiterTransaction(encoded, expectedSigner) {
  if (typeof encoded !== "string" || encoded.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(encoded)) {
    throw new Error("Jupiter transaction is empty or not canonical base64");
  }
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
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
  if (requiredSignatures !== signatureCount || requiredSignatures < 1 ||
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
      if (bytes[cursor++] >= keyCount) throw new Error("Jupiter instruction account index is invalid");
    }
    const dataHeader = readShortVector(bytes, cursor);
    cursor = dataHeader.offset;
    if (dataHeader.value > 1232 || cursor + dataHeader.value > bytes.length) {
      throw new Error("Jupiter instruction data is invalid");
    }
    cursor += dataHeader.value;
  }
  if (messageVersion === 0) {
    const lookupHeader = readShortVector(bytes, cursor);
    cursor = lookupHeader.offset;
    if (lookupHeader.value > 64) throw new Error("Jupiter address lookup count is invalid");
    for (let i = 0; i < lookupHeader.value; i++) {
      if (cursor + 32 > bytes.length) throw new Error("Jupiter address lookup is truncated");
      cursor += 32;
      const writable = readShortVector(bytes, cursor);
      cursor = writable.offset;
      if (cursor + writable.value > bytes.length) throw new Error("Jupiter writable lookup indexes are truncated");
      cursor += writable.value;
      const readonly = readShortVector(bytes, cursor);
      cursor = readonly.offset;
      if (cursor + readonly.value > bytes.length) throw new Error("Jupiter readonly lookup indexes are truncated");
      cursor += readonly.value;
    }
  }
  if (cursor !== bytes.length) throw new Error("Jupiter transaction contains trailing or unparsed bytes");
  return {
    signatureCount,
    staticAccountCount: keyCount,
    instructionCount,
    addressLookupCount: messageVersion === 0 ? lookupHeader.value : 0,
    messageVersion,
    // Wire structure is validated, but lookup tables and instruction semantics are not.
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
    if (payload.error) throw new Error("Alchemy getTokenAccounts failed");
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
    throw new Error("A $3 sell-route probe would exceed 1% of token supply or is below token precision");
  }
  const walletAccounts = await rpc(fetchImpl, "getTokenAccountsByOwner", [
    EXPECTED_BOT_WALLET,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" }
  ]);
  if (!Array.isArray(walletAccounts?.value) || walletAccounts.value.length === 0) {
    throw new Error("Expected bot wallet has no verified token accounts for this mint");
  }
  let walletTokenBalance = 0n;
  for (const account of walletAccounts.value) {
    const info = account?.account?.data?.parsed?.info;
    if (!EXPECTED_TOKEN_PROGRAMS.has(account?.account?.owner) ||
        info?.mint !== mint || info?.owner !== EXPECTED_BOT_WALLET ||
        !/^\d+$/.test(String(info?.tokenAmount?.amount ?? ""))) {
      throw new Error("Bot wallet token account ownership or balance data is invalid");
    }
    walletTokenBalance += BigInt(info.tokenAmount.amount);
  }
  if (amount > walletTokenBalance) {
    throw new Error("Expected bot wallet does not own enough tokens for the sell-route probe");
  }
  const params = new URLSearchParams({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: amount.toString(),
    taker: EXPECTED_BOT_WALLET,
    slippageBps: "50"
  });
  const order = await fetchJson(fetchImpl, JUPITER_ORDER_URL + "?" + params.toString(), {
    headers: { "x-api-key": jupiterApiKey.trim(), Accept: "application/json" }
  });
  if (!order || typeof order !== "object" ||
      typeof order.requestId !== "string" || !order.requestId ||
      typeof order.transaction !== "string" ||
      order.inputMint !== mint || order.outputMint !== SOL_MINT ||
      String(order.inAmount) !== amount.toString() ||
      !/^\d+$/.test(String(order.outAmount || "")) || BigInt(order.outAmount) <= 0n ||
      !Array.isArray(order.routePlan) || order.routePlan.length === 0 ||
      order.errorCode != null) {
    throw new Error("Jupiter did not return a complete sell-order quote response");
  }
  const decodedTransaction = validateUnsignedJupiterTransaction(order.transaction, EXPECTED_BOT_WALLET);
  return Object.freeze({
    provider: "Jupiter Swap API V2",
    requestId: order.requestId,
    inputAmount: amount.toString(),
    outputLamports: String(order.outAmount),
    router: String(order.router || "unknown"),
    routePlanCount: order.routePlan.length,
    signatureCount: decodedTransaction.signatureCount,
    staticAccountCount: decodedTransaction.staticAccountCount,
    messageVersion: decodedTransaction.messageVersion,
    walletTokenBalance: walletTokenBalance.toString(),
    semanticInstructionVerification: false,
    routeVerification: "unsigned-transaction-structure-only"
  });
}

async function rpc(fetchImpl, method, params) {
  const payload = await fetchJson(fetchImpl, DEVNET_OR_MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (payload.error || !("result" in payload)) {
    throw new Error(method + " RPC response is incomplete");
  }
  return payload.result;
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
  if (typeof mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || mint === SOL_MINT) {
    throw new Error("A valid non-SOL output mint is required for risk inspection");
  }
  const [dex, rug, mintAccount, supply, holderAccounts] = await Promise.all([
    fetchJson(fetchImpl, DEX_TOKEN_URL + encodeURIComponent(mint)),
    fetchJson(fetchImpl, RUGCHECK_URL + encodeURIComponent(mint) + "/report"),
    rpc(fetchImpl, "getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]),
    rpc(fetchImpl, "getTokenSupply", [mint, { commitment: "confirmed" }]),
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
    fetchedAt: Date.now(),
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
