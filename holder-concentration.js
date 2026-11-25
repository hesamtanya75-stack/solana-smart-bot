const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);

function atomic(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(label + " must be a canonical integer string");
  }
  return BigInt(value);
}

/**
 * Computes owner-level concentration only when the supplied token-account set
 * demonstrably covers the entire mint supply. A top-20 sample is otherwise
 * incomplete and must not be used as live-risk evidence.
 */
export function calculateCompleteHolderConcentration({ mint, supplyAtomic, largestAccounts, accountDetails }) {
  if (!BASE58.test(mint || "")) throw new TypeError("Mint address is invalid");
  const supply = atomic(supplyAtomic, "Mint supply");
  if (supply <= 0n) throw new TypeError("Mint supply must be positive");
  if (!Array.isArray(largestAccounts) || largestAccounts.length < 1 || largestAccounts.length > 20 ||
      !accountDetails || !Array.isArray(accountDetails.value) ||
      accountDetails.value.length !== largestAccounts.length) {
    throw new Error("Holder account sample is incomplete");
  }

  const owners = new Map();
  const accountAddresses = new Set();
  let sampled = 0n;
  for (let index = 0; index < largestAccounts.length; index++) {
    const largest = largestAccounts[index];
    const account = accountDetails.value[index];
    const info = account?.data?.parsed?.info;
    const owner = info?.owner;
    const accountMint = info?.mint;
    const amount = atomic(info?.tokenAmount?.amount, "Parsed token amount");
    const listedAmount = atomic(largest?.amount, "Largest-account amount");

    if (!BASE58.test(largest?.address || "") || accountAddresses.has(largest.address) ||
        !BASE58.test(owner || "") || accountMint !== mint || !TOKEN_PROGRAMS.has(account?.owner) ||
        account.data.parsed.type !== "account" || amount !== listedAmount || amount <= 0n) {
      throw new Error("Holder account identity or amount could not be verified");
    }
    accountAddresses.add(largest.address);
    sampled += amount;
    owners.set(owner, (owners.get(owner) || 0n) + amount);
  }

  if (sampled !== supply) {
    throw new Error("Holder concentration sample does not cover the full mint supply");
  }

  const percentagesBps = [...owners.values()]
    .map(amount => Number((amount * 1000000n) / supply))
    .sort((a, b) => b - a);
  return {
    complete: true,
    sampledSupplyAtomic: sampled.toString(),
    largestOwnerPpm: percentagesBps[0] || 0,
    topTenOwnersPpm: percentagesBps.slice(0, 10).reduce((sum, value) => sum + value, 0)
  };
}
