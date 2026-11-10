import { PublicKey } from "@solana/web3.js";

function isPublicKey(value) {
  try {
    return typeof value === "string" && new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

/**
 * Validate a parsed SPL Token / Token-2022 account response from a trusted RPC.
 * This checks account identity and basic authority state only; it does not
 * replace mint-extension policy or DEX instruction semantic validation.
 */
function validateParsedTokenAccount({
  response,
  expectedTokenProgramId,
  expectedMint,
  expectedAuthority,
  currentSlot,
  minContextSlot = 0,
  maxSlotLag = 32,
  minimumAmount = "0",
  allowNative = false,
  allowedExtensions = []
} = {}) {
  for (const [name, value] of Object.entries({
    expectedTokenProgramId, expectedMint, expectedAuthority
  })) {
    if (!isPublicKey(value)) {
      throw new Error(name + " must be a valid public key");
    }
  }
  if (!Number.isSafeInteger(currentSlot) || currentSlot < 0 ||
      !Number.isSafeInteger(minContextSlot) || minContextSlot < 0 ||
      !Number.isSafeInteger(maxSlotLag) || maxSlotLag < 0) {
    throw new Error("RPC slot policy is invalid");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(String(minimumAmount))) {
    throw new Error("Minimum token amount must be a non-negative integer string");
  }
  if (!Array.isArray(allowedExtensions) ||
      allowedExtensions.some((item) => typeof item !== "string" || !item)) {
    throw new Error("Token extension allow-list is invalid");
  }

  const contextSlot = response?.context?.slot;
  const value = response?.value;
  if (!Number.isSafeInteger(contextSlot) || contextSlot < minContextSlot ||
      contextSlot > currentSlot || currentSlot - contextSlot > maxSlotLag) {
    throw new Error("Token account RPC context is stale or inconsistent");
  }
  if (!value || value.owner !== expectedTokenProgramId) {
    throw new Error("Token account is owned by an unapproved token program");
  }

  const parsed = value.data?.parsed;
  const expectedProgramName = expectedTokenProgramId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    ? "spl-token"
    : expectedTokenProgramId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
      ? "spl-token-2022"
      : null;
  if (!expectedProgramName || value.data?.program !== expectedProgramName) {
    throw new Error("Token account RPC program label does not match the expected token program");
  }
  if (!parsed || parsed.type !== "account" || !parsed.info) {
    throw new Error("Token account parsed data is missing or malformed");
  }

  const info = parsed.info;
  if (info.mint !== expectedMint) {
    throw new Error("Token account mint does not match the expected mint");
  }
  if (info.owner !== expectedAuthority) {
    throw new Error("Token account authority does not match the expected wallet");
  }
  if (info.state !== "initialized") {
    throw new Error("Token account is not initialized or is frozen");
  }
  if (info.delegate !== null || info.closeAuthority !== null) {
    throw new Error("Token account has an unexpected delegate or close authority");
  }
  if (info.isNative === true && allowNative !== true) {
    throw new Error("Native token account is not permitted by this policy");
  }
  if (info.isNative !== true && info.isNative !== false) {
    throw new Error("Token account native-state metadata is missing");
  }

  const tokenAmount = info.tokenAmount;
  if (!tokenAmount || !/^(0|[1-9][0-9]*)$/.test(String(tokenAmount.amount)) ||
      !Number.isInteger(tokenAmount.decimals) || tokenAmount.decimals < 0 ||
      tokenAmount.decimals > 255) {
    throw new Error("Token account amount or decimals are invalid");
  }
  if (BigInt(tokenAmount.amount) < BigInt(minimumAmount)) {
    throw new Error("Token account balance is below the required minimum");
  }

  const extensions = info.extensions;
  if (expectedProgramName === "spl-token-2022" && !Array.isArray(extensions)) {
    throw new Error("Token-2022 account extension metadata is missing");
  }
  if (extensions === undefined && expectedProgramName === "spl-token") {
    // Classic SPL Token accounts have no Token-2022 extension metadata.
  } else if (!Array.isArray(extensions)) {
    throw new Error("Token account extension metadata is malformed");
  }
  for (const extension of extensions) {
    const name = typeof extension === "string" ? extension : extension?.extension;
    if (typeof name !== "string" || !allowedExtensions.includes(name)) {
      throw new Error("Token account contains an unapproved Token-2022 extension");
    }
  }

  return Object.freeze({
    allowed: true,
    tokenProgramId: value.owner,
    mint: info.mint,
    authority: info.owner,
    amount: tokenAmount.amount,
    decimals: tokenAmount.decimals,
    slot: contextSlot,
    extensions: Object.freeze((extensions ?? []).map((item) =>
      typeof item === "string" ? item : item.extension
    ))
  });
}

export { validateParsedTokenAccount };
