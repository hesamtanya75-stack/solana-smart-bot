const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTa4";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SHARED_ACCOUNTS_ROUTE_V2 = [123, 141, 210, 115, 241, 229, 15, 101];
const SWAP_VARIANT_COUNT = 44;
const SWAP_VARIANT_SIDE = new Set([29, 30, 41]);
const SWAP_VARIANT_BOOL = new Set([23]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function readUInt(data, offset, bytes) {
  if (offset + bytes > data.length) throw new Error("Metis instruction data is truncated");
  let value = 0n;
  for (let i = 0; i < bytes; i += 1) value |= BigInt(data[offset + i]) << BigInt(i * 8);
  return value;
}

function readRoutePlan(data, offset, expectedSteps) {
  const count = Number(readUInt(data, offset, 4));
  offset += 4;
  if (!Number.isInteger(count) || count < 1 || count > 16 || count !== expectedSteps) {
    throw new Error("Metis on-chain route plan count does not match the quote");
  }
  const steps = [];

  for (let i = 0; i < count; i += 1) {
    if (offset >= data.length) throw new Error("Metis route plan is truncated");
    const swapVariant = data[offset++];
    if (swapVariant >= SWAP_VARIANT_COUNT) throw new Error("Metis route contains an unknown swap variant");
    if (SWAP_VARIANT_SIDE.has(swapVariant)) {
      if (offset >= data.length || data[offset] > 1) throw new Error("Metis route side enum is invalid");
      offset += 1;
    } else if (SWAP_VARIANT_BOOL.has(swapVariant)) {
      if (offset >= data.length || data[offset] > 1) throw new Error("Metis route boolean argument is invalid");
      offset += 1;
    }
    if (offset + 3 > data.length) throw new Error("Metis route step is truncated");
    const percent = data[offset++];
    const inputIndex = data[offset++];
    const outputIndex = data[offset++];
    if (percent < 1 || percent > 100 || inputIndex === outputIndex) {
      throw new Error("Metis route step has invalid percent or token indexes");
    }

    steps.push(Object.freeze({ swapVariant, percent, inputIndex, outputIndex }));
  }

  return { steps, offset };
}

/**
 * Strict Jupiter V6 Metis-route validator for the reviewed
 * sharedAccountsRouteV2 instruction layout. Other instruction variants are
 * intentionally rejected until their account/data layouts are separately
 * reviewed and tested against the deployed program.
 *
 * The per-variant DEX program and display-label maps must be pinned in trusted
 * server configuration; never derive them from the order response.
 */
function validateMetisJupiterV6Instruction({
  decoded,
  instruction,
  expectedSigner,
  inputMint,
  outputMint,
  inAmount,
  outAmount,
  slippageBps,
  platformFeeBps = 0,
  routePlan,
  dexProgramBySwapVariant,
  dexLabelsBySwapVariant,
  allowedDexProgramIds
} = {}) {
  if (!decoded || !Array.isArray(decoded.instructions) ||
      decoded.instructions.filter((item) => item.programId === JUPITER_V6_PROGRAM_ID).length !== 1 ||
      !instruction || instruction.programId !== JUPITER_V6_PROGRAM_ID ||
      !Array.isArray(instruction.accounts) || instruction.accounts.length < 11) {
    throw new Error("Metis order must contain exactly one supported Jupiter V6 sharedAccountsRouteV2 instruction");
  }
  for (const [name, value] of Object.entries({ expectedSigner, inputMint, outputMint })) {
    if (typeof value !== "string" || !BASE58.test(value)) {
      throw new Error(name + " is not a valid public key");
    }
  }
  if (!/^(0|[1-9][0-9]*)$/.test(String(inAmount)) ||
      !/^(0|[1-9][0-9]*)$/.test(String(outAmount)) ||
      BigInt(inAmount) <= 0n || BigInt(outAmount) <= 0n ||
      !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 65535 ||
      !Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 255 ||
      !Array.isArray(routePlan) || routePlan.length < 1 || routePlan.length > 16) {
    throw new Error("Metis quote amounts, slippage, fee, or route plan are invalid");
  }
  const accounts = instruction.accounts;
  const [tokenProgram, , authority, sourceTokenAccount, , , destinationTokenAccount, sourceMint, destinationMint, , token2022Program] = accounts;
  if (tokenProgram !== TOKEN_PROGRAM_ID ||
      token2022Program !== TOKEN_2022_PROGRAM_ID ||
      authority !== expectedSigner ||
      sourceMint !== inputMint || destinationMint !== outputMint ||
      sourceTokenAccount === destinationTokenAccount) {
    throw new Error("Metis route accounts do not match the pinned signer, token programs, and requested mints");
  }
  const authorityIndex = instruction.accountIndexes?.[2];
  const sourceIndex = instruction.accountIndexes?.[3];
  const destinationIndex = instruction.accountIndexes?.[6];
  const metadata = decoded.accountMetadata;
  if (!Array.isArray(metadata) ||
      metadata[authorityIndex]?.pubkey !== expectedSigner ||
      metadata[authorityIndex]?.isSigner !== true ||
      metadata[sourceIndex]?.pubkey !== sourceTokenAccount ||
      metadata[sourceIndex]?.isWritable !== true ||
      metadata[destinationIndex]?.pubkey !== destinationTokenAccount ||
      metadata[destinationIndex]?.isWritable !== true) {
    throw new Error("Metis signer or source/destination token-account privileges are invalid");
  }

  let bytes;
  try { bytes = Buffer.from(instruction.dataBase64, "base64"); } catch {
    throw new Error("Metis instruction data is invalid");
  }
  if (bytes.length < 8 || !SHARED_ACCOUNTS_ROUTE_V2.every((byte, i) => bytes[i] === byte)) {
    throw new Error("Metis instruction is not the reviewed sharedAccountsRouteV2 variant");
  }
  let offset = 8;
  if (offset >= bytes.length) throw new Error("Metis instruction data is truncated");
  offset += 1; // Route id.
  const parsed = readRoutePlan(bytes, offset, routePlan.length);
  offset = parsed.offset;
  const encodedIn = readUInt(bytes, offset, 8); offset += 8;
  const encodedOut = readUInt(bytes, offset, 8); offset += 8;
  const encodedSlippage = Number(readUInt(bytes, offset, 2)); offset += 2;
  const encodedFee = Number(readUInt(bytes, offset, 1)); offset += 1;
  if (offset !== bytes.length ||
      encodedIn !== BigInt(inAmount) ||
      encodedOut !== BigInt(outAmount) ||
      encodedSlippage !== slippageBps ||
      encodedFee !== platformFeeBps) {
    throw new Error("Metis on-chain amounts, slippage, fee, or instruction length do not match the quote");
  }

  if (!dexProgramBySwapVariant || typeof dexProgramBySwapVariant !== "object" ||
      !dexLabelsBySwapVariant || typeof dexLabelsBySwapVariant !== "object" ||
      !Array.isArray(allowedDexProgramIds) || allowedDexProgramIds.length === 0) {
    throw new Error("Pinned Metis DEX program and label policy is required");
  }
  const allowed = new Set(allowedDexProgramIds);
  const requiredCpiProgramIds = [];
  for (let i = 0; i < parsed.steps.length; i += 1) {
    const step = parsed.steps[i];
    const programId = dexProgramBySwapVariant[String(step.swapVariant)];
    const labels = dexLabelsBySwapVariant[String(step.swapVariant)];
    const quoteStep = routePlan[i];
    if (typeof programId !== "string" || !BASE58.test(programId) ||
        !allowed.has(programId) || !instruction.accounts.slice(11).includes(programId) || !Array.isArray(labels) ||
        !labels.includes(quoteStep?.swapInfo?.label) ||
        !Number.isInteger(quoteStep?.percent) ||
        quoteStep.percent !== step.percent ||
        !quoteStep.swapInfo || !BASE58.test(String(quoteStep.swapInfo.ammKey || "")) ||
        !instruction.accounts.slice(11).includes(quoteStep.swapInfo.ammKey)) {
      throw new Error("Metis on-chain DEX route does not match the pinned program/label policy and Jupiter quote");
    }
    requiredCpiProgramIds.push(programId);
  }

  return Object.freeze({
    allowed: true,
    instructionName: "sharedAccountsRouteV2",
    sourceTokenAccount,
    destinationTokenAccount,
    sourceMint,
    destinationMint,
    tokenProgramId: tokenProgram,
    tokenAccountExpectations: Object.freeze([
      Object.freeze({
        address: sourceTokenAccount,
        expectedTokenProgramId: tokenProgram,
        expectedMint: inputMint,
        expectedAuthority: expectedSigner,
        minimumAmount: String(inAmount),
        allowNative: inputMint === "So11111111111111111111111111111111111111112",
        allowedExtensions: Object.freeze([])
      }),
      Object.freeze({
        address: destinationTokenAccount,
        expectedTokenProgramId: tokenProgram,
        expectedMint: outputMint,
        expectedAuthority: expectedSigner,
        minimumAmount: "0",
        allowNative: outputMint === "So11111111111111111111111111111111111111112",
        allowedExtensions: Object.freeze([])
      })
    ]),
    requiredCpiProgramIds: Object.freeze([...new Set(requiredCpiProgramIds)]),
    routeSteps: Object.freeze(parsed.steps)
  });
}

export {
  JUPITER_V6_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  validateMetisJupiterV6Instruction
};
