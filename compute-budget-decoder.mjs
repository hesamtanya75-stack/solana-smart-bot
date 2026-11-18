const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Compute Budget instruction data is not canonical base64");
  }
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) {
    throw new Error("Compute Budget instruction data is not canonical base64");
  }
  return bytes;
}

function readU32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * Decode one explicitly supported Compute Budget instruction.
 * This is a syntax decoder only: it does not attest transaction or route trust.
 */
export function decodeComputeBudgetInstruction(programId, encodedData) {
  if (programId !== COMPUTE_BUDGET_PROGRAM_ID) {
    throw new Error("Compute Budget decoder rejects unknown program IDs");
  }
  const bytes = decodeCanonicalBase64(encodedData);
  if (bytes.length !== 5 && bytes.length !== 9) {
    throw new Error("Compute Budget instruction has an unsupported payload length");
  }
  const tag = bytes[0];
  let decoded;
  if (tag === 1 && bytes.length === 5) {
    const heapFrameBytes = readU32LE(bytes, 1);
    if (heapFrameBytes < 32768 || heapFrameBytes > 262144 || heapFrameBytes % 1024 !== 0) {
      throw new Error("Compute Budget heap-frame size is outside the supported range");
    }
    decoded = { variant: "requestHeapFrame", heapFrameBytes };
  } else if (tag === 2 && bytes.length === 5) {
    const units = readU32LE(bytes, 1);
    if (units < 1 || units > 1400000) {
      throw new Error("Compute Budget unit limit is outside the supported range");
    }
    decoded = { variant: "setComputeUnitLimit", units };
  } else if (tag === 3 && bytes.length === 9) {
    let microLamports = 0n;
    for (let i = 8; i >= 1; i--) microLamports = (microLamports << 8n) | BigInt(bytes[i]);
    decoded = { variant: "setComputeUnitPrice", microLamports };
  } else if (tag === 4 && bytes.length === 5) {
    const bytesLimit = readU32LE(bytes, 1);
    if (bytesLimit < 1 || bytesLimit > 64 * 1024 * 1024) {
      throw new Error("Compute Budget loaded-account-data limit is outside the supported range");
    }
    decoded = { variant: "setLoadedAccountsDataSizeLimit", bytes: bytesLimit };
  } else {
    throw new Error("Compute Budget instruction variant or payload shape is unsupported");
  }
  return Object.freeze({
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    decoderVersion: 1,
    ...decoded
  });
}

/**
 * Enforce transaction-level uniqueness for decoded Compute Budget variants.
 * This does not verify other instruction families or attest the whole transaction.
 */
export function validateComputeBudgetInstructionSet(instructions) {
  if (!Array.isArray(instructions) || instructions.length > 64) {
    throw new Error("Compute Budget instruction collection is invalid");
  }
  const seen = new Set();
  for (const instruction of instructions) {
    if (!instruction || instruction.programId !== COMPUTE_BUDGET_PROGRAM_ID ||
        instruction.decoderVersion !== 1 ||
        typeof instruction.variant !== "string" || seen.has(instruction.variant)) {
      throw new Error("Compute Budget instruction set contains an unknown or duplicate variant");
    }
    seen.add(instruction.variant);
  }
  return Object.freeze([...instructions]);
}

export const COMPUTE_BUDGET_PROGRAM = COMPUTE_BUDGET_PROGRAM_ID;
