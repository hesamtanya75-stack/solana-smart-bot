const U64_MAX = (1n << 64n) - 1n;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

function readU64(value, name) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(name + " must be a canonical unsigned integer string");
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new Error(name + " exceeds the Solana u64 range");
  return parsed;
}

/**
 * Calculates transaction costs only from independently decoded evidence bound
 * to one exact compiled message. This helper does not decode or authenticate
 * that evidence; callers must provide the verifier's explicit success flags.
 */
export function calculateVerifiedTransactionCosts(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("Verified transaction cost evidence is required");
  }
  const prototype = Object.getPrototypeOf(evidence);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Transaction cost evidence must be a plain data record");
  }
  const allowedFields = new Set([
    "semanticInstructionVerification", "messageAccountEffectsVerified",
    "feeQuoteBoundToMessage", "messageDigest", "computeUnitPriceMicroLamports",
    "computeUnitLimit", "baseFeeLamports", "tipLamports", "rentLamports",
    "otherOutflowLamports"
  ]);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(evidence)) {
    if (typeof key !== "string" || !allowedFields.has(key)) {
      throw new Error("Transaction cost evidence contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(evidence, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error("Transaction cost evidence must not contain accessor-backed fields");
    }
    snapshot[key] = descriptor.value;
  }
  if (Reflect.ownKeys(snapshot).length !== allowedFields.size) {
    throw new Error("Transaction cost evidence is incomplete");
  }
  if (snapshot.semanticInstructionVerification !== true ||
      snapshot.messageAccountEffectsVerified !== true ||
      snapshot.feeQuoteBoundToMessage !== true) {
    throw new Error("Transaction cost evidence is not semantically verified");
  }
  if (typeof snapshot.messageDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(snapshot.messageDigest)) {
    throw new Error("A canonical compiled-message digest is required");
  }

  const computeUnitPriceMicroLamports = readU64(
    snapshot.computeUnitPriceMicroLamports, "computeUnitPriceMicroLamports"
  );
  const computeUnitLimit = readU64(snapshot.computeUnitLimit, "computeUnitLimit");
  const baseFeeLamports = readU64(snapshot.baseFeeLamports, "baseFeeLamports");
  const tipLamports = readU64(snapshot.tipLamports, "tipLamports");
  const rentLamports = readU64(snapshot.rentLamports, "rentLamports");
  const otherOutflowLamports = readU64(
    snapshot.otherOutflowLamports, "otherOutflowLamports"
  );

  if (computeUnitLimit === 0n) throw new Error("computeUnitLimit must be greater than zero");
  const priorityProduct = computeUnitPriceMicroLamports * computeUnitLimit;
  const maxPriorityFeeLamports =
    (priorityProduct + MICRO_LAMPORTS_PER_LAMPORT - 1n) /
    MICRO_LAMPORTS_PER_LAMPORT;

  const totalFeeLamports = baseFeeLamports + maxPriorityFeeLamports +
    tipLamports + rentLamports + otherOutflowLamports;
  if (totalFeeLamports > U64_MAX || maxPriorityFeeLamports > U64_MAX) {
    throw new Error("Calculated transaction costs exceed the Solana u64 range");
  }

  return Object.freeze({
    // Cost arithmetic is evidence output, never transaction authorization.
    analysisOnly: true,
    semanticVerification: "incomplete",
    signingPermitted: false,
    submissionPermitted: false,
    messageDigest: snapshot.messageDigest,
    computeUnitPriceMicroLamports: computeUnitPriceMicroLamports.toString(),
    computeUnitLimit: computeUnitLimit.toString(),
    maxPriorityFeeLamports: maxPriorityFeeLamports.toString(),
    baseFeeLamports: baseFeeLamports.toString(),
    tipLamports: tipLamports.toString(),
    rentLamports: rentLamports.toString(),
    otherOutflowLamports: otherOutflowLamports.toString(),
    totalFeeLamports: totalFeeLamports.toString()
  });
}
