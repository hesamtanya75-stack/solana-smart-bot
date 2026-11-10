const DEVNET_RPC = "https://api.devnet.solana.com";
const EXPECTED_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);

async function rpc(method, params = []) {
  const response = await fetch(DEVNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(method + " returned HTTP " + response.status);
  const payload = await response.json();
  if (payload.error) throw new Error(method + " RPC error: " + (payload.error.message || "unknown"));
  if (!("result" in payload)) throw new Error(method + " response missing result");
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

  const topOwnerSamplePct = [...owners.values()].sort((a, b) => b - a)
    .slice(0, 10).reduce((sum, amount) => sum + amount, 0) / supplyAmount * 100;
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
    largestAccountRows: largest.value.length,
    uniqueOwnersInLargestAccountSample: owners.size,
    topTenOwnerShareOfSupplyInSamplePct: Number(topOwnerSamplePct.toFixed(4)),
    holderMetricNote: "Largest-account sample only; not a complete holder census or a pass/fail token safety verdict.",
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
