const DEVNET_RPC = "https://api.devnet.solana.com";
const EXPECTED_DEVNET_GENESIS = "EtWTRABZaY6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

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

async function main() {
  const genesis = String(await rpc("getGenesisHash")).trim();
  if (genesis !== EXPECTED_DEVNET_GENESIS) {
    throw new Error("Wrong cluster: expected Devnet genesis hash " + EXPECTED_DEVNET_GENESIS + " (" + EXPECTED_DEVNET_GENESIS.length + " chars), received " + JSON.stringify(genesis) + " (" + genesis.length + " chars)");
  }

  const health = await rpc("getHealth");
  if (health !== "ok") throw new Error("Devnet RPC health is not ok: " + health);

  const slot = await rpc("getSlot", [{ commitment: "confirmed" }]);
  if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error("Devnet returned an invalid confirmed slot");

  const mintAccount = await rpc("getAccountInfo", [
    DEVNET_USDC_MINT,
    { encoding: "base64", commitment: "confirmed" }
  ]);
  if (!mintAccount?.value?.owner || !Array.isArray(mintAccount.value.data)) {
    throw new Error("Devnet reference token mint account is unavailable or malformed");
  }

  const supply = await rpc("getTokenSupply", [DEVNET_USDC_MINT, { commitment: "confirmed" }]);
  if (!supply?.value?.amount || !Number.isFinite(Number(supply.value.amount))) {
    throw new Error("Devnet reference token supply is unavailable");
  }

  const largest = await rpc("getTokenLargestAccounts", [DEVNET_USDC_MINT, { commitment: "confirmed" }]);
  if (!Array.isArray(largest?.value)) throw new Error("Devnet largest-token-account response is malformed");

  console.log(JSON.stringify({
    ok: true,
    cluster: "devnet",
    genesisHash: genesis,
    health,
    confirmedSlot: slot,
    referenceMint: DEVNET_USDC_MINT,
    mintOwnerProgram: mintAccount.value.owner,
    supplyAvailable: true,
    largestAccountRows: largest.value.length,
    signing: "not performed",
    transactionsSubmitted: 0
  }, null, 2));
}

main().catch(error => {
  console.error("Devnet preflight failed:", error.message);
  process.exitCode = 1;
});
