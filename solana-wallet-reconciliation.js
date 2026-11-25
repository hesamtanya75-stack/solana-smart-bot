const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TOKEN_PROGRAMS = Object.freeze([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);

export function isValidSolanaPublicKey(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (number > 0n) { bytes++; number >>= 8n; }
  for (const char of value) {
    if (char !== "1") break;
    bytes++;
  }
  return bytes === 32;
}

function formatAtomic(amount, decimals) {
  const value = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0");
  return decimals ? whole.toString() + "." + fraction : whole.toString();
}

function positiveSlot(context) {
  return Number.isSafeInteger(context?.slot) && context.slot >= 0 ? context.slot : null;
}

export async function reconcileWalletReadOnly({ owner, getBalance, getTokenAccountsByOwner }) {
  if (!isValidSolanaPublicKey(owner)) return { ok: false, reason: "Invalid Solana public address" };
  if (typeof getBalance !== "function" || typeof getTokenAccountsByOwner !== "function") {
    return { ok: false, reason: "Read-only RPC functions are not configured" };
  }

  const [native, classic, token2022] = await Promise.all([
    getBalance(owner, { commitment: "finalized" }),
    getTokenAccountsByOwner(owner, TOKEN_PROGRAMS[0], { encoding: "jsonParsed", commitment: "finalized" }),
    getTokenAccountsByOwner(owner, TOKEN_PROGRAMS[1], { encoding: "jsonParsed", commitment: "finalized" })
  ]);
  if (!native || !Number.isSafeInteger(native.value) || native.value < 0) {
    return { ok: false, reason: "Finalized native balance response is invalid" };
  }

  const accountSets = [classic, token2022];
  const positions = new Map();
  let accountCount = 0;
  for (const response of accountSets) {
    const accounts = response?.value;
    if (!Array.isArray(accounts)) return { ok: false, reason: "Finalized token-account response is invalid" };
    accountCount += accounts.length;
    if (accountCount > 2000) return { ok: false, reason: "Wallet token account count exceeds safe response limit" };
    for (const item of accounts) {
      const info = item?.account?.data?.parsed?.info;
      const mint = info?.mint;
      const amount = info?.tokenAmount?.amount;
      const decimals = info?.tokenAmount?.decimals;
      if (!isValidSolanaPublicKey(mint) ||
          info.owner !== owner || item?.account?.owner !== TOKEN_PROGRAMS[accountSets.indexOf(response)] ||
          typeof amount !== "string" || !/^\d+$/.test(amount) ||
          !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        return { ok: false, reason: "Token account parsing failed; refusing partial wallet snapshot" };
      }
      const atomic = BigInt(amount);
      if (atomic === 0n) continue;
      const existing = positions.get(mint);
      if (existing && existing.decimals !== decimals) {
        return { ok: false, reason: "Token mint returned inconsistent decimals" };
      }
      positions.set(mint, {
        mint, decimals,
        amountAtomic: ((existing ? BigInt(existing.amountAtomic) : 0n) + atomic).toString(),
        tokenAccounts: (existing?.tokenAccounts || 0) + 1
      });
    }
  }
  return {
    ok: true,
    mode: "read-only-wallet-reconciliation",
    execution: "not-authorized",
    owner,
    commitment: "finalized",
    native: {
      asset: "SOL",
      symbol: "SOL",
      decimals: 9,
      amountAtomic: String(native.value),
      amount: formatAtomic(String(native.value), 9)
    },
    positions: [...positions.values()].sort((a, b) => a.mint.localeCompare(b.mint)),
    tokenAccountCount: accountCount,
    slots: {
      native: positiveSlot(native.context),
      classicToken: positiveSlot(classic.context),
      token2022: positiveSlot(token2022.context)
    },
    consistency: "separate finalized RPC reads; slots reported, not claimed atomic",
    observedAt: new Date().toISOString()
  };
}
