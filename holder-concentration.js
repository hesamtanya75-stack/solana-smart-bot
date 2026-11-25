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

  const ownerAmounts = [...owners.values()].sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  const largestOwner = ownerAmounts[0] || 0n;
  const topTenOwnerAmount = ownerAmounts.slice(0, 10).reduce((sum, amount) => sum + amount, 0n);
  return {
    complete: true,
    sampledSupplyAtomic: sampled.toString(),
    largestOwnerPpm: Number((largestOwner * 1000000n) / supply),
    topTenOwnersPpm: Number((topTenOwnerAmount * 1000000n) / supply),
    largestOwnerAbove30Percent: largestOwner * 100n > supply * 30n,
    topTenOwnersAbove50Percent: topTenOwnerAmount * 100n > supply * 50n
  };
}
