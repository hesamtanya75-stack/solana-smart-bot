// Prefer an explicitly configured Devnet RPC, then Alchemy Devnet when its
// API key is available. The public endpoint is a last-resort read-only fallback.
const DEVNET_RPC = process.env.DEVNET_RPC_URL ||
  (process.env.ALCHEMY_API_KEY
    ? "https://solana-devnet.g.alchemy.com/v2/" + encodeURIComponent(process.env.ALCHEMY_API_KEY)
    : "https://api.devnet.solana.com");
const EXPECTED_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);

function retryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const dateDelay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay >= 0) {
      return Math.min(dateDelay, 30_000);
    }
  }
  return Math.min(1000 * (2 ** attempt), 30_000);
}

async function rpc(method, params = []) {
  let response;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      response = await fetch(DEVNET_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      // Retry transient network failures/timeouts as well as retryable HTTP
      // responses; never print the RPC URL because it may contain a key.
      if (attempt === 5) {
        // Keep credentials and the RPC URL out of logs. Node's fetch commonly
        // wraps DNS, TLS, socket, and timeout failures in TypeError; expose only
        // the stable low-level error code when the runtime provides one.
        const causeCode = error?.cause?.code;
        const causeName = error?.cause?.name;
        const diagnostic = typeof causeCode === "string" && /^[A-Z0-9_]{2,40}$/.test(causeCode)
          ? causeCode
          : (typeof causeName === "string" && /^[A-Za-z0-9]{2,40}$/.test(causeName)
            ? causeName : "no-cause-code");
        throw new Error(method + " network request failed after 6 attempts (" +
          String(error?.name || "network error") + "; cause=" + diagnostic + ")");
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * (2 ** attempt), 30_000)));
      continue;
    }
    if (response.ok) break;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 5) {
      throw new Error(method + " returned HTTP " + response.status);
    }
    // Release the retryable response before waiting, and respect a bounded
    // Retry-After hint so public Devnet RPC rate limits are not amplified.
    try { await response.body?.cancel(); } catch {}
    await new Promise(resolve => setTimeout(resolve, retryDelayMs(response, attempt)));
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(method + " returned invalid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.jsonrpc !== "2.0" || payload.id !== 1) {
    throw new Error(method + " returned a mismatched JSON-RPC envelope");
  }
  if (payload.error) throw new Error(method + " RPC error: " + (payload.error.message || "unknown"));
  if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
    throw new Error(method + " response missing result");
  }
  return payload.result;
}

async function fetchSolUsdSpot() {
  const response = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("Coinbase SOL/USD spot returned HTTP " + response.status);
  const payload = await response.json();
  const amount = Number(payload?.data?.amount);
  if (payload?.data?.base !== "SOL" || payload?.data?.currency !== "USD" ||
      !Number.isFinite(amount) || amount <= 0) {
    throw new Error("Coinbase SOL/USD response failed schema or positive-price validation");
  }
  return { provider: "Coinbase spot API", base: payload.data.base, quote: payload.data.currency,
    price: amount, observedAt: new Date().toISOString() };
}

async function main() {
  const genesis = String(await rpc("getGenesisHash")).trim();
  if (genesis !== EXPECTED_DEVNET_GENESIS) {
    throw new Error("Wrong cluster: expected Devnet genesis hash " + EXPECTED_DEVNET_GENESIS +
      " (" + EXPECTED_DEVNET_GENESIS.length + " chars), received " + JSON.stringify(genesis) +
      " (" + genesis.length + " chars)");
  }

  const health = await rpc("getHealth");
  if (health !== "ok") throw new Error("Devnet RPC health is not ok: " + health);
  const slot = await rpc("getSlot", [{ commitment: "confirmed" }]);
  if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error("Devnet returned an invalid confirmed slot");

  const mintAccount = await rpc("getAccountInfo", [
    DEVNET_USDC_MINT, { encoding: "jsonParsed", commitment: "confirmed" }
  ]);
  const parsedMint = mintAccount?.value?.data?.parsed?.info;
  const tokenProgram = mintAccount?.value?.owner;
  if (!parsedMint || mintAccount.value.data.parsed.type !== "mint" || !TOKEN_PROGRAMS.has(tokenProgram)) {
    throw new Error("Devnet reference mint failed parsed mint/token-program validation");
  }

  const supply = await rpc("getTokenSupply", [DEVNET_USDC_MINT, { commitment: "confirmed" }]);
  const supplyAmount = Number(supply?.value?.amount);
  if (!Number.isFinite(supplyAmount) || supplyAmount <= 0) {
    throw new Error("Devnet reference token supply is unavailable or invalid");
  }

  let largestAccountRows = null;
  let uniqueOwnersInLargestAccountSample = null;
  let topTenOwnerShareOfSupplyInSamplePct = null;
  let holderDataWarning = null;
  try {
    const largest = await rpc("getTokenLargestAccounts", [DEVNET_USDC_MINT, { commitment: "confirmed" }]);
    if (!Array.isArray(largest?.value) || largest.value.length === 0) {
      throw new Error("Devnet largest-token-account data is unavailable");
    }
    const accountDetails = await rpc("getMultipleAccounts", [
      largest.value.map(item => item.address),
      { encoding: "jsonParsed", commitment: "confirmed" }
    ]);
    if (!Array.isArray(accountDetails?.value) || accountDetails.value.length !== largest.value.length) {
      throw new Error("Devnet holder-owner lookup returned incomplete data");
    }

    const owners = new Map();
    for (let i = 0; i < accountDetails.value.length; i++) {
      const info = accountDetails.value[i]?.data?.parsed?.info;
      const owner = info?.owner;
      const amount = Number(info?.tokenAmount?.amount ?? largest.value[i]?.amount);
      if (owner && Number.isFinite(amount) && amount >= 0) {
        owners.set(owner, (owners.get(owner) || 0) + amount);
      }
    }
    if (owners.size === 0) throw new Error("Devnet holder-owner aggregation returned no usable owners");
    largestAccountRows = largest.value.length;
    uniqueOwnersInLargestAccountSample = owners.size;
    topTenOwnerShareOfSupplyInSamplePct = Number(
      ([...owners.values()].sort((a, b) => b - a).slice(0, 10)
        .reduce((sum, amount) => sum + amount, 0) / supplyAmount * 100).toFixed(4)
    );
  } catch (error) {
    const message = String(error?.message || error);
    if (!message.includes("HTTP 429")) throw error;
    holderDataWarning = "Devnet public RPC rate-limited holder enumeration; holder concentration was not validated.";
  }

  const quote = await fetchSolUsdSpot();

  console.log(JSON.stringify({
    ok: true,
    cluster: "devnet",
    genesisHash: genesis,
    health,
    confirmedSlot: slot,
    referenceMint: DEVNET_USDC_MINT,
    tokenProgram,
    mintAuthorityPresent: Boolean(parsedMint.mintAuthority),
    freezeAuthorityPresent: Boolean(parsedMint.freezeAuthority),
    supplyAvailable: true,
    largestAccountRows,
    uniqueOwnersInLargestAccountSample,
    topTenOwnerShareOfSupplyInSamplePct,
    holderMetricNote: "Largest-account sample only; not a complete holder census or a pass/fail token safety verdict.",
    holderDataWarning,
    solUsdQuote: quote,
    marketRiskFeeds: "DexScreener/RugCheck mainnet market data is not treated as Devnet validation.",
    signing: "not performed",
    transactionsSubmitted: 0
  }, null, 2));
}

main().catch(error => {
  console.error("Devnet preflight failed:", error.message);
  process.exitCode = 1;
});
