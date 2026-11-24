import { isTrustedUnsignedMessageEvidence } from "./trusted-live-evidence.mjs";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const MAX_TOTAL_INNER_INSTRUCTIONS = 4096;

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(record, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw new Error(label + " is missing or accessor-backed");
  }
  return descriptor.value;
}

function assertAllowedDataFields(record, allowed, label) {
  if (!isPlainRecord(record)) throw new Error(label + " is malformed");
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new Error(label + " contains unsupported properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains accessor-backed properties");
    }
  }
}

function readInputArguments(input, allowed, label) {
  assertAllowedDataFields(input, allowed, label);
  const values = Object.create(null);
  for (const key of allowed) {
    values[key] = ownData(input, key, label + " " + key);
  }
  return values;
}

function isCanonicalBase58(value) {
  // Solana UiCompiledInstruction.data is base58, not base64.
  return typeof value === "string" && value.length <= 8192 &&
    /^[1-9A-HJ-NP-Za-km-z]*$/.test(value);
}

function readDenseArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum) throw new Error(label + " is malformed");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw new Error(label + " is sparse or extended");
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(label + " contains accessor-backed entries");
    }
    result.push(descriptor.value);
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length) throw new Error(label + " contains unexpected properties");
  }
  return result;
}

/**
 * Normalize CPI data returned by simulateTransaction.
 * This is diagnostic evidence, not proof of future execution or approval.
 */
function normalizeSimulationObservation(input) {
  const { messageDigest, simulationResult, topLevelInstructionCount, accountKeyCount } =
    readInputArguments(input,
      ["messageDigest", "simulationResult", "topLevelInstructionCount", "accountKeyCount"],
      "Simulation observation input");
  if (typeof messageDigest !== "string" || !HEX_SHA256.test(messageDigest)) {
    throw new Error("Simulation observation requires a canonical message SHA-256 digest");
  }
  if (!Number.isInteger(topLevelInstructionCount) ||
      topLevelInstructionCount < 1 || topLevelInstructionCount > 256 ||
      !Number.isInteger(accountKeyCount) || accountKeyCount < 1 || accountKeyCount > 256) {
    throw new Error("Simulation observation message bounds are invalid");
  }
  if (!isPlainRecord(simulationResult)) throw new Error("Simulation RPC result is malformed");
  const value = ownData(simulationResult, "value", "Simulation RPC value");
  if (!isPlainRecord(value)) throw new Error("Simulation RPC value is unavailable");
  const errorValue = ownData(value, "err", "Simulation error status");
  const groups = readDenseArray(
    ownData(value, "innerInstructions", "Simulation innerInstructions"),
    256, "Simulation innerInstructions"
  );
  const seenTopLevelIndexes = new Set();
  let totalInnerInstructions = 0;
  const normalizedGroups = groups.map(group => {
    assertAllowedDataFields(group, ["index", "instructions"], "Simulation inner instruction group");
    const groupIndex = ownData(group, "index", "Simulation inner instruction group index");
    if (!Number.isInteger(groupIndex) || groupIndex < 0 ||
        groupIndex >= topLevelInstructionCount) {
      throw new Error("Simulation inner instruction group index is invalid");
    }
    if (seenTopLevelIndexes.has(groupIndex)) {
      throw new Error("Simulation contains duplicate inner instruction groups");
    }
    seenTopLevelIndexes.add(groupIndex);
    const instructions = readDenseArray(
      ownData(group, "instructions", "Simulation inner instruction list"),
      512, "Simulation inner instruction list"
    );
    totalInnerInstructions += instructions.length;
    if (totalInnerInstructions > MAX_TOTAL_INNER_INSTRUCTIONS) {
      throw new Error("Simulation inner instruction total exceeds the supported bound");
    }
    const normalizedInstructions = instructions.map(instruction => {
      assertAllowedDataFields(instruction,
        ["programIdIndex", "accounts", "data", "stackHeight"],
        "Simulation inner instruction");
      const programIdIndex = ownData(instruction, "programIdIndex",
        "Simulation inner instruction program index");
      if (!Number.isInteger(programIdIndex) || programIdIndex < 0 ||
          programIdIndex >= accountKeyCount) {
        throw new Error("Simulation inner instruction program index is invalid");
      }
      // RPC inner-instruction account indexes are useful diagnostic evidence,
      // but are not trusted account-key resolution or semantic verification.
      const rawAccountIndexes = Object.hasOwn(instruction, "accounts")
        ? ownData(instruction, "accounts", "Simulation inner instruction account indexes")
        : null;
      let data = null;
      if (Object.hasOwn(instruction, "data")) {
        data = ownData(instruction, "data", "Simulation inner instruction data");
        if (!isCanonicalBase58(data)) {
          throw new Error("Simulation inner instruction data is malformed");
        }
      }
      let stackHeight = null;
      if (Object.hasOwn(instruction, "stackHeight")) {
        stackHeight = ownData(instruction, "stackHeight", "Simulation inner instruction stack height");
        if (!Number.isInteger(stackHeight) || stackHeight < 1 || stackHeight > 256) {
          throw new Error("Simulation inner instruction stack height is invalid");
        }
      }
      let accountIndexes = null;
      if (rawAccountIndexes !== null) {
        const indexes = readDenseArray(rawAccountIndexes, 256,
          "Simulation inner instruction account indexes");
        if (indexes.some(index => !Number.isInteger(index) ||
            index < 0 || index >= accountKeyCount)) {
          throw new Error("Simulation inner instruction account index is invalid");
        }
        accountIndexes = Object.freeze(indexes);
      }
      return Object.freeze({
        programIdIndex,
        accountIndexes,
        data,
        stackHeight
      });
    });
    // When every stack height is present, enforce only the RPC invocation-depth
    // shape: the first CPI is depth 2 and a nested call may increase depth by
    // at most one. This does not establish parent program semantics.
    const stackHeights = normalizedInstructions.map(instruction => instruction.stackHeight);
    const stackHeightStructure = stackHeights.length === 0 || stackHeights.some(height => height === null)
      ? "incomplete"
      : "complete";
    if (stackHeightStructure === "complete") {
      if (stackHeights[0] !== 2 || stackHeights.some((height, index) =>
          height < 2 || (index > 0 && height > stackHeights[index - 1] + 1))) {
        throw new Error("Simulation CPI stack-height sequence is structurally impossible");
      }
    }
    return Object.freeze({
      topLevelInstructionIndex: groupIndex,
      innerInstructionCount: normalizedInstructions.length,
      stackHeightStructure,
      instructions: Object.freeze(normalizedInstructions)
    });
  }).sort((left, right) => left.topLevelInstructionIndex - right.topLevelInstructionIndex);
  const context = ownData(simulationResult, "context", "Simulation context");
  if (!isPlainRecord(context)) throw new Error("Simulation RPC context is unavailable");
  const contextSlot = ownData(context, "slot", "Simulation context slot");
  if (!Number.isSafeInteger(contextSlot) || contextSlot < 0) {
    throw new Error("Simulation RPC context slot is invalid");
  }
  return Object.freeze({
    scope: "simulation-observation-only",
    messageDigest,
    contextSlot,
    simulationSucceeded: errorValue === null,
    simulationErrorPresent: errorValue !== null,
    innerInstructionsObserved: true,
    innerInstructionGroupCount: normalizedGroups.length,
    innerInstructionCount: normalizedGroups.reduce(
      (sum, group) => sum + group.innerInstructionCount, 0
    ),
    groups: Object.freeze(normalizedGroups),
    cpiProgramIdsVerified: false,
    semanticInstructionVerification: false,
    tokenBalanceEffectsVerified: false,
    signingPermitted: false,
    submissionPermitted: false
  });
}

/**
 * Derive the observation digest from a snapshot of the supplied serialized
 * message bytes. This binds the record to those bytes, but does NOT prove that
 * an external RPC simulated the same bytes; the caller must preserve that
 * request/response association. The result remains diagnostic-only.
 */
export async function normalizeSimulationObservationForMessage(input) {
  const { serializedMessage, simulationResult, topLevelInstructionCount, accountKeyCount } =
    readInputArguments(input,
      ["serializedMessage", "simulationResult", "topLevelInstructionCount", "accountKeyCount"],
      "Message-bound simulation observation input");
  if (!(serializedMessage instanceof Uint8Array) ||
      Object.getPrototypeOf(serializedMessage) !== Uint8Array.prototype ||
      serializedMessage.byteLength < 1 || serializedMessage.byteLength > 1232) {
    throw new Error("Serialized simulation message must be a bounded Uint8Array");
  }
  // Copy synchronously before awaiting WebCrypto so later caller mutation
  // cannot change the bytes whose digest is recorded.
  const messageSnapshot = new Uint8Array(serializedMessage);
  if (!globalThis.crypto?.subtle?.digest) {
    throw new Error("WebCrypto SHA-256 is unavailable; simulation observation blocked");
  }
  const digestBuffer = await globalThis.crypto.subtle.digest("SHA-256", messageSnapshot);
  const messageDigest = Array.from(new Uint8Array(digestBuffer), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const observation = normalizeSimulationObservation({
    messageDigest,
    simulationResult,
    topLevelInstructionCount,
    accountKeyCount
  });
  return Object.freeze({
    ...observation,
    messageDigestSource: "sha256-of-supplied-serialized-message",
    simulationInputIdentityVerified: false
  });
}

export { normalizeSimulationObservation };


/**
 * Resolve observed CPI account indexes against a privately branded message
 * parsed from serialized transaction bytes. This is index resolution only:
 * simulateTransaction response identity is not cryptographically attested.
 */
export function resolveSimulationCpiIndexesAgainstTrustedMessage(input) {
  const { observation, trustedMessageEvidence } = readInputArguments(input,
    ["observation", "trustedMessageEvidence"], "CPI resolution input");
  if (!isTrustedUnsignedMessageEvidence(trustedMessageEvidence)) {
    throw new Error("Privately branded trusted unsigned-message evidence is required");
  }
  assertAllowedDataFields(observation, [
    "scope", "messageDigest", "contextSlot", "simulationSucceeded",
    "simulationErrorPresent", "innerInstructionsObserved",
    "innerInstructionGroupCount", "innerInstructionCount", "groups",
    "cpiProgramIdsVerified", "semanticInstructionVerification",
    "tokenBalanceEffectsVerified", "signingPermitted", "submissionPermitted",
    "messageDigestSource", "simulationInputIdentityVerified"
  ], "Simulation observation");
  if (ownData(observation, "scope", "Simulation observation scope") !== "simulation-observation-only") {
    throw new Error("A normalized simulation observation is required");
  }
  const requiredFalseFlags = [
    "cpiProgramIdsVerified",
    "semanticInstructionVerification",
    "tokenBalanceEffectsVerified",
    "signingPermitted",
    "submissionPermitted"
  ];
  for (const key of requiredFalseFlags) {
    if (ownData(observation, key, "Simulation observation " + key) !== false) {
      throw new Error("Simulation observation cannot assert " + key);
    }
  }
  if ((Object.hasOwn(observation, "simulationInputIdentityVerified") &&
       ownData(observation, "simulationInputIdentityVerified",
         "Simulation observation identity status") !== false) ||
      (Object.hasOwn(observation, "messageDigestSource") &&
       ownData(observation, "messageDigestSource", "Simulation observation digest source") !==
         "sha256-of-supplied-serialized-message") ||
      ownData(observation, "innerInstructionsObserved", "Simulation inner-instructions status") !== true) {
    throw new Error("Simulation observation provenance or CPI status is invalid");
  }
  const contextSlot = ownData(observation, "contextSlot", "Simulation observation context slot");
  const simulationSucceeded = ownData(observation, "simulationSucceeded", "Simulation success status");
  const simulationErrorPresent = ownData(observation, "simulationErrorPresent", "Simulation error status");
  if (!Number.isSafeInteger(contextSlot) || contextSlot < 0 ||
      typeof simulationSucceeded !== "boolean" ||
      typeof simulationErrorPresent !== "boolean" ||
      simulationSucceeded === simulationErrorPresent) {
    throw new Error("Simulation observation status metadata is invalid");
  }
  const digest = ownData(observation, "messageDigest", "Simulation observation digest");
  const trustedDigest = trustedMessageEvidence.messageDigest?.value;
  if (typeof digest !== "string" || digest !== trustedDigest ||
      !HEX_SHA256.test(digest)) {
    throw new Error("Simulation observation digest does not match trusted serialized message evidence");
  }
  const accountKeys = trustedMessageEvidence.accountKeys;
  const compiledInstructions = trustedMessageEvidence.compiledInstructions;
  if (!Array.isArray(accountKeys) || accountKeys.length < 1 || accountKeys.length > 256 ||
      !Array.isArray(compiledInstructions) || compiledInstructions.length < 1 ||
      compiledInstructions.length > 256) {
    throw new Error("Trusted message account keys or compiled instructions are unavailable");
  }
  const groups = readDenseArray(
    ownData(observation, "groups", "Simulation observation groups"),
    256, "Simulation observation groups"
  );
  const seenTopLevelIndexes = new Set();
  let resolvedInstructionTotal = 0;
  const resolvedGroups = groups.map(group => {
    assertAllowedDataFields(group,
      ["topLevelInstructionIndex", "innerInstructionCount", "stackHeightStructure", "instructions"],
      "Simulation observation group");
    const topLevelIndex = ownData(group, "topLevelInstructionIndex", "Top-level instruction index");
    if (!Number.isInteger(topLevelIndex) || topLevelIndex < 0 ||
        topLevelIndex >= compiledInstructions.length) {
      throw new Error("Simulation group does not map to a trusted top-level instruction");
    }
    if (seenTopLevelIndexes.has(topLevelIndex)) {
      throw new Error("Simulation observation contains duplicate top-level groups");
    }
    seenTopLevelIndexes.add(topLevelIndex);
    const stackHeightStructure = ownData(group, "stackHeightStructure",
      "Simulation observation stack-height structure");
    if (stackHeightStructure !== "complete" && stackHeightStructure !== "incomplete") {
      throw new Error("Simulation observation stack-height structure is invalid");
    }
    const instructions = readDenseArray(
      ownData(group, "instructions", "Simulation observation instructions"),
      512, "Simulation observation instructions"
    );
    const declaredInstructionCount = ownData(group, "innerInstructionCount",
      "Simulation observation group instruction count");
    if (!Number.isSafeInteger(declaredInstructionCount) ||
        declaredInstructionCount !== instructions.length) {
      throw new Error("Simulation observation group instruction count is inconsistent");
    }
    resolvedInstructionTotal += instructions.length;
    if (resolvedInstructionTotal > MAX_TOTAL_INNER_INSTRUCTIONS) {
      throw new Error("Simulation observation aggregate instruction count exceeds the supported bound");
    }
    const heights = instructions.map(instruction => {
      assertAllowedDataFields(instruction,
        ["programIdIndex", "accountIndexes", "data", "stackHeight"],
        "Simulation CPI instruction");
      const height = ownData(instruction, "stackHeight", "Simulation CPI stack height");
      if (height !== null && (!Number.isInteger(height) || height < 2 || height > 256)) {
        throw new Error("Simulation observation stack-height structure is inconsistent");
      }
      return height;
    });
    const hasMissingStackHeight = heights.some(height => height === null);
    if ((stackHeightStructure === "complete" && hasMissingStackHeight) ||
        (stackHeightStructure === "incomplete" && !hasMissingStackHeight) ||
        (heights.length > 0 && heights[0] !== null && heights[0] !== 2) ||
        heights.some((height, index) => index > 0 && height !== null &&
          heights[index - 1] !== null && height > heights[index - 1] + 1)) {
      throw new Error("Simulation observation stack-height structure is inconsistent");
    }
    const resolvedInstructions = instructions.map(instruction => {
      assertAllowedDataFields(instruction,
        ["programIdIndex", "accountIndexes", "data", "stackHeight"],
        "Simulation CPI instruction");
      const programIndex = ownData(instruction, "programIdIndex", "CPI program index");
      if (!Number.isInteger(programIndex) || programIndex < 0 ||
          programIndex >= accountKeys.length) {
        throw new Error("CPI program index is outside trusted message account keys");
      }
      const rawIndexes = ownData(instruction, "accountIndexes", "CPI account indexes");
      const indexes = rawIndexes === null ? null :
        readDenseArray(rawIndexes, 256, "CPI account indexes");
      if (indexes && indexes.some(index => !Number.isInteger(index) ||
          index < 0 || index >= accountKeys.length)) {
        throw new Error("CPI account index is outside trusted message account keys");
      }
      return Object.freeze({
        ...instruction,
        programIdCandidate: accountKeys[programIndex],
        accountKeyCandidates: indexes === null ? null :
          Object.freeze(indexes.map(index => accountKeys[index]))
      });
    });
    return Object.freeze({ ...group, instructions: Object.freeze(resolvedInstructions) });
  });
  if (ownData(observation, "innerInstructionGroupCount",
      "Simulation observation group count") !== groups.length ||
      ownData(observation, "innerInstructionCount",
        "Simulation observation instruction count") !== resolvedInstructionTotal) {
    throw new Error("Simulation observation aggregate instruction counts are inconsistent");
  }
  return Object.freeze({
    ...observation,
    groups: Object.freeze(resolvedGroups),
    cpiIndexResolution: "resolved-against-trusted-message-candidate-only",
    cpiProgramIdsVerified: false,
    simulationInputIdentityVerified: false,
    semanticInstructionVerification: false,
    tokenBalanceEffectsVerified: false,
    signingPermitted: false,
    submissionPermitted: false
  });
}
