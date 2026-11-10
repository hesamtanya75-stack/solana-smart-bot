import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const SABER_STABLE_SWAP_PROGRAM_ID = "SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SWAP_INFO_LEN = 395;
const SWAP_INSTRUCTION_TAG = 1;

function keyAt(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function readCOptionKey(data, offset, name) {
  const tag = data.readUInt32LE(offset);
  if (tag === 0) return null;
  if (tag !== 1) throw new Error("Saber " + name + " COption tag is invalid");
  return keyAt(data, offset + 4);
}

function readSwapInfo(account) {
  if (!account || account.executable === true ||
      account.owner?.toBase58?.() !== SABER_STABLE_SWAP_PROGRAM_ID ||
      !Buffer.isBuffer(account.data) || account.data.length !== SWAP_INFO_LEN) {
    throw new Error("Saber SwapInfo account owner or exact data length is invalid");
  }
  const data = account.data;
  if ((data[0] !== 0 && data[0] !== 1) || (data[1] !== 0 && data[1] !== 1)) {
    throw new Error("Saber SwapInfo initialization or pause flag is invalid");
  }
  const fees = Array.from({ length: 8 }, (_, i) => data.readBigUInt64LE(331 + i * 8));
  for (let i = 0; i < 8; i += 2) {
    if (fees[i + 1] === 0n || fees[i] > fees[i + 1]) {
      throw new Error("Saber SwapInfo fee fraction is invalid");
    }
  }
  const state = {
    initialized: data[0] === 1,
    paused: data[1] === 1,
    nonce: data[2],
    initialAmpFactor: data.readBigUInt64LE(3),
    targetAmpFactor: data.readBigUInt64LE(11),
    reserveA: keyAt(data, 107),
    reserveB: keyAt(data, 139),
    mintA: keyAt(data, 203),
    mintB: keyAt(data, 235),
    adminFeeA: keyAt(data, 267),
    adminFeeB: keyAt(data, 299),
    fees
  };
  if (!state.initialized || state.paused ||
      state.initialAmpFactor === 0n || state.targetAmpFactor === 0n ||
      state.mintA === state.mintB || state.reserveA === state.reserveB) {
    throw new Error("Saber pool is uninitialized, paused, or internally inconsistent");
  }
  return Object.freeze(state);
}

function readTokenAccount(account, expectedMint, expectedAuthority, name) {
  if (!account || account.executable === true ||
      account.owner?.toBase58?.() !== TOKEN_PROGRAM_ID ||
      !Buffer.isBuffer(account.data) || account.data.length !== 165) {
    throw new Error("Saber " + name + " is not a classic SPL Token account");
  }
  const data = account.data;
  const mint = keyAt(data, 0);
  const authority = keyAt(data, 32);
  const amount = data.readBigUInt64LE(64);
  const delegate = readCOptionKey(data, 72, name + " delegate");
  const state = data[108];
  const closeAuthority = readCOptionKey(data, 129, name + " close authority");
  if (mint !== expectedMint || authority !== expectedAuthority ||
      delegate !== null || closeAuthority !== null || state !== 1) {
    throw new Error("Saber " + name + " mint, authority, delegate, close authority, or state is invalid");
  }
  return Object.freeze({ mint, authority, amount, state });
}

function readMint(account, expectedKey, name) {
  if (!account || account.executable === true ||
      account.owner?.toBase58?.() !== TOKEN_PROGRAM_ID ||
      !Buffer.isBuffer(account.data) || account.data.length !== 82) {
    throw new Error("Saber " + name + " is not a classic SPL Token mint");
  }
  const data = account.data;
  if (data[45] !== 1) throw new Error("Saber " + name + " mint is not initialized");
  readCOptionKey(data, 0, name + " mint authority");
  readCOptionKey(data, 46, name + " freeze authority");
  return Object.freeze({ address: expectedKey, decimals: data[44] });
}

/**
 * Source-derived Saber StableSwap CPI validation against the published Rust
 * SwapInfo packing and the official nine-account Swap instruction order.
 * This does not verify the deployed executable; callers must keep Saber blocked
 * until deployed-binary provenance and reproducible-build equivalence pass.
 */
function validateSaberStableSwapCpi({
  programId,
  accounts,
  data,
  expectedUserAuthority,
  decoded,
  rawAccounts
} = {}) {
  if (programId !== SABER_STABLE_SWAP_PROGRAM_ID ||
      !Array.isArray(accounts) || accounts.length !== 9 ||
      !Array.isArray(decoded?.accountMetadata) ||
      !(rawAccounts instanceof Map) ||
      typeof expectedUserAuthority !== "string") {
    throw new Error("Saber CPI validation inputs are incomplete or not trusted");
  }
  const instructionData = Buffer.from(bs58.decode(data || ""));
  if (instructionData.length !== 17 || instructionData[0] !== SWAP_INSTRUCTION_TAG) {
    throw new Error("Saber CPI is not the exact 17-byte Swap instruction");
  }
  const amountIn = instructionData.readBigUInt64LE(1);
  const minimumAmountOut = instructionData.readBigUInt64LE(9);
  if (amountIn === 0n || minimumAmountOut === 0n) {
    throw new Error("Saber Swap amount or minimum output is zero");
  }

  const [swapKey, authorityKey, userAuthority, sourceKey, reserveAKey, reserveBKey,
    destinationKey, adminFeeKey, tokenProgramKey] = accounts;
  if (userAuthority !== expectedUserAuthority || tokenProgramKey !== TOKEN_PROGRAM_ID ||
      new Set(accounts).size !== accounts.length) {
    throw new Error("Saber CPI signer, token program, or account uniqueness is invalid");
  }

  for (let i = 0; i < accounts.length; i += 1) {
    const meta = decoded.accountMetadata.find((item) => item.pubkey === accounts[i]);
    if (!meta) throw new Error("Saber CPI account is absent from decoded transaction metadata");
    const shouldWrite = i >= 3 && i <= 7;
    if ((i !== 2 && meta.isSigner === true) ||
        (shouldWrite && meta.isWritable !== true)) {
      throw new Error("Saber CPI account signer or writable privilege does not match the official instruction");
    }
  }

  const get = (key) => {
    const account = rawAccounts.get(key);
    if (!account) throw new Error("Saber required raw account data is missing: " + key);
    return account;
  };
  const state = readSwapInfo(get(swapKey));
  const derivedAuthority = PublicKey.createProgramAddressSync(
    [new PublicKey(swapKey).toBuffer(), Buffer.from([state.nonce])],
    new PublicKey(SABER_STABLE_SWAP_PROGRAM_ID)
  ).toBase58();
  if (authorityKey !== derivedAuthority ||
      reserveAKey !== state.reserveA || reserveBKey !== state.reserveB) {
    throw new Error("Saber swap authority PDA or reserve account keys do not match SwapInfo");
  }

  const mintA = readMint(get(state.mintA), state.mintA, "token A");
  const mintB = readMint(get(state.mintB), state.mintB, "token B");
  if (mintA.decimals !== mintB.decimals) {
    throw new Error("Saber pool token mint decimals do not match");
  }
  const reserveA = readTokenAccount(get(reserveAKey), state.mintA, derivedAuthority, "reserve A");
  const reserveB = readTokenAccount(get(reserveBKey), state.mintB, derivedAuthority, "reserve B");
  const sourceRaw = get(sourceKey);
  if (!Buffer.isBuffer(sourceRaw.data) || sourceRaw.data.length !== 165) {
    throw new Error("Saber user source token account data is invalid");
  }
  const sourceMint = keyAt(sourceRaw.data, 0);
  const source = readTokenAccount(sourceRaw, sourceMint, expectedUserAuthority, "user source");
  const destinationRaw = get(destinationKey);
  if (!Buffer.isBuffer(destinationRaw.data) || destinationRaw.data.length !== 165) {
    throw new Error("Saber user destination token account data is invalid");
  }
  const destinationMint = keyAt(destinationRaw.data, 0);
  const destination = readTokenAccount(destinationRaw, destinationMint, expectedUserAuthority, "user destination");
  if (source.amount < amountIn ||
      ![state.mintA, state.mintB].includes(source.mint) ||
      ![state.mintA, state.mintB].includes(destination.mint) ||
      source.mint === destination.mint) {
    throw new Error("Saber user token accounts or input amount do not match the pool mints");
  }

  const aToB = source.mint === state.mintA && destination.mint === state.mintB;
  const bToA = source.mint === state.mintB && destination.mint === state.mintA;
  const expectedAdminFee = aToB ? state.adminFeeB : state.adminFeeA;
  if ((!aToB && !bToA) || adminFeeKey !== expectedAdminFee) {
    throw new Error("Saber direction or destination admin-fee account does not match SwapInfo");
  }
  const adminFee = readTokenAccount(get(adminFeeKey), destination.mint, derivedAuthority, "admin fee destination");

  return Object.freeze({
    allowed: true,
    programId: SABER_STABLE_SWAP_PROGRAM_ID,
    swapKey,
    authority: derivedAuthority,
    direction: aToB ? "A_TO_B" : "B_TO_A",
    amountIn: amountIn.toString(),
    minimumAmountOut: minimumAmountOut.toString(),
    reserveAAmount: reserveA.amount.toString(),
    reserveBAmount: reserveB.amount.toString(),
    adminFeeMint: adminFee.mint
  });
}

export {
  SABER_STABLE_SWAP_PROGRAM_ID,
  TOKEN_PROGRAM_ID as SABER_TOKEN_PROGRAM_ID,
  validateSaberStableSwapCpi
};
