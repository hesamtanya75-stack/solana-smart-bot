const TOKEN_PROGRAMS = {
  spl: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
};
const MAX_ENUMERATED_ACCOUNTS = 50000;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidPublicKey(value) {
  if (typeof value !== "string" || !BASE58_ADDRESS.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let byteLength = 0;
  while (decoded > 0n) {
    byteLength++;
    decoded >>= 8n;
  }
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === "1") {
    leadingZeroBytes++;
  }
  return leadingZeroBytes + byteLength === 32;
}

function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + encoded;
}

function decodeAccount(account, program) {
  if (!account || account.owner !== program || !Array.isArray(account.data) ||
      account.data[1] !== "base64" || typeof account.data[0] !== "string") {
    throw new Error("Full holder enumeration account format is invalid");
  }
  const binary = atob(account.data[0]);
  if (binary.length !== 40) throw new Error("Holder data slice length is invalid");
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const owner = base58(bytes.slice(0, 32));
  let amount = 0n;
  for (let i = 7; i >= 0; i--) amount = (amount << 8n) | BigInt(bytes[32 + i]);
  return { owner, amount };
}

/**
 * Verifies both token-program account enumerations and mint supply came from
 * the same finalized RPC slot. A bounded/truncated provider response is rejected
 * unless all returned atomic balances reconcile exactly to mint supply.
 */
export function buildCompleteHolderEnumeration({ mint, splResult, token2022Result, supplyResult }) {
  const splSlot = splResult?.context?.slot;
  const t22Slot = token2022Result?.context?.slot;
  const supplySlot = supplyResult?.context?.slot;
  if (!Number.isSafeInteger(splSlot) || splSlot <= 0 ||
      splSlot !== t22Slot || splSlot !== supplySlot) {
    throw new Error("Holder enumeration and mint supply are not from one consistent slot");
  }
  const spl = splResult.value;
  const t22 = token2022Result.value;
  if (!Array.isArray(spl) || !Array.isArray(t22) ||
      spl.length + t22.length < 1 ||
      spl.length + t22.length > MAX_ENUMERATED_ACCOUNTS) {
    throw new Error("Full holder enumeration is incomplete or exceeds safety limit");
  }
  const largestAccounts = [];
  const details = [];
  const seen = new Set();
  let total = 0n;
  for (const [entries, program] of [[spl, TOKEN_PROGRAMS.spl], [t22, TOKEN_PROGRAMS.token2022]]) {
    for (const entry of entries) {
      if (!isValidPublicKey(entry?.pubkey) || seen.has(entry.pubkey)) {
        throw new Error("Holder enumeration contains invalid or duplicate account");
      }
      seen.add(entry.pubkey);
      const parsed = decodeAccount(entry.account, program);
      total += parsed.amount;
      if (parsed.amount === 0n) continue;
      largestAccounts.push({ address: entry.pubkey, amount: parsed.amount.toString() });
      details.push({
        owner: program,
        data: { parsed: { type: "account", info: {
          mint, owner: parsed.owner, tokenAmount: { amount: parsed.amount.toString() }
        } } }
      });
    }
  }
  const supply = supplyResult?.value?.amount;
  if (typeof supply !== "string" || !/^[1-9][0-9]*$/.test(supply) || total !== BigInt(supply)) {
    throw new Error("Enumerated token accounts do not reconcile to full mint supply");
  }
  // Keep the largest-account helper's expected positional pairing.
  const ranked = largestAccounts.map((account, i) => ({ account, detail: details[i] }))
    .sort((a, b) => BigInt(a.account.amount) > BigInt(b.account.amount) ? -1 :
      BigInt(a.account.amount) < BigInt(b.account.amount) ? 1 : 0);
  return {
    slot: splSlot,
    supplyAtomic: supply,
    largestAccounts: ranked.map(item => item.account),
    accountDetails: { value: ranked.map(item => item.detail) }
  };
}
