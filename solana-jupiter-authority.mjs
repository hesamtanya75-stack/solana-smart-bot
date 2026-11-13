import { PublicKey } from "@solana/web3.js";

export const JUPITER_V6_PROGRAM_ID =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const JUPITER_AUTHORITY_COUNT = 16;

const AUTHORITY_SEED = Buffer.from("authority");

export function deriveJupiterProgramAuthorityId(id) {
  if (!Number.isInteger(id) || id < 0 || id >= JUPITER_AUTHORITY_COUNT) {
    throw new Error("Jupiter program authority index is outside the pinned source range");
  }
  return PublicKey.findProgramAddressSync(
    [AUTHORITY_SEED, Buffer.from([id])],
    new PublicKey(JUPITER_V6_PROGRAM_ID)
  )[0].toBase58();
}

export function identifyJupiterProgramAuthority(address) {
  if (typeof address !== "string") return null;
  for (let id = 0; id < JUPITER_AUTHORITY_COUNT; id += 1) {
    if (deriveJupiterProgramAuthorityId(id) === address) return id;
  }
  return null;
}
