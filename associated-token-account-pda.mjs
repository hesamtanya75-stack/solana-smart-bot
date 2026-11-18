import { getAddressEncoder, getProgramDerivedAddress } from "@solana/addresses";
import { isDecodedAssociatedTokenInstruction } from "./associated-token-account-decoder.mjs";

export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const CLASSIC_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const SUPPORTED_TOKEN_PROGRAMS = new Set([
  CLASSIC_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
]);
const encodeAddress = getAddressEncoder();

/**
 * Derive the canonical Associated Token Account address and bump.
 * This uses Solana's SDK implementation; it does not inspect chain state.
 */
export async function deriveAssociatedTokenAddress({ owner, mint, tokenProgramId }) {
  if (!SUPPORTED_TOKEN_PROGRAMS.has(tokenProgramId)) {
    throw new Error("Unsupported token program for ATA derivation");
  }

  let ownerBytes;
  let mintBytes;
  let tokenProgramBytes;
  try {
    ownerBytes = encodeAddress.encode(owner);
    mintBytes = encodeAddress.encode(mint);
    tokenProgramBytes = encodeAddress.encode(tokenProgramId);
  } catch {
    throw new Error("ATA owner, mint, and token program must be valid Solana addresses");
  }

  const [address, bump] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    seeds: [ownerBytes, tokenProgramBytes, mintBytes]
  });

  return Object.freeze({ address, bump });
}

/**
 * Verify the derived ATA address for a previously decoded ATA instruction.
 * A successful result verifies only the PDA relationship, not on-chain
 * existence, ownership, initialization, balances, or transaction validity.
 */
export async function verifyAssociatedTokenInstructionPda(record) {
  if (!isDecodedAssociatedTokenInstruction(record)) {
    throw new Error("ATA PDA verification requires a trusted decoded instruction record");
  }

  const { address: expectedAddress, bump } = await deriveAssociatedTokenAddress({
    owner: record.ownerAddress,
    mint: record.mintAddress,
    tokenProgramId: record.tokenProgramId
  });
  const actualAddress = record.associatedAccountAddress;

  return Object.freeze({
    performed: true,
    verified: actualAddress === expectedAddress,
    expectedAddress,
    actualAddress,
    bump,
    tokenProgramId: record.tokenProgramId,
    scope: "pda-only"
  });
}
