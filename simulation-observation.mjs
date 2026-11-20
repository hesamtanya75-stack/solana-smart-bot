const HEX_SHA256 = /^[a-f0-9]{64}$/;

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
    if (typeof key !== "string" || !/^(0|[1-9]\\d*)$/.test(key) ||
        Number(key) >= value.length) throw new Error(label + " contains unexpected properties");
  }
  return result;
}

/**
 * Normalize CPI data returned by simulateTransaction.
 * This is diagnostic evidence, not proof of future execution or approval.
 */
function normalizeSimulationObservation({
  messageDigest, simulationResult, topLevelInstructionCount, accountKeyCount
}) {
  if (typeof messageDigest !== "string" || !HEX_SHA256.test(messageDigest)) {
    throw new Error("Simulation observation requires a canonical message SHA-256 digest");
  }
  if (!Number.isInteger(topLevelInstructionCount) ||
      topLevelInstructionCount < 1 || topLevelInstructionCount > 256 ||
      !Number.isInteger(accountKeyCount) || accountKeyCount < 1 || accountKeyCount > 256) {
    throw new Error("Simulation observation message bounds are invalid");
  }
  if (!isPlainRecord(simulationResult)) throw new Error("Simulation RPC result is malformed");
  const meta = ownData(simulationResult, "meta", "Simulation metadata");
  if (!isPlainRecord(meta)) throw new Error("Simulation RPC result metadata is unavailable");
  const errorValue = ownData(meta, "err", "Simulation error status");
  const groups = readDenseArray(
    ownData(meta, "innerInstructions", "Simulation innerInstructions"),
    256, "Simulation innerInstructions"
  );
  const seenTopLevelIndexes = new Set();
  const normalizedGroups = groups.map(group => {
    if (!isPlainRecord(group)) throw new Error("Simulation inner instruction group is malformed");
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
    const normalizedInstructions = instructions.map(instruction => {
      if (!isPlainRecord(instruction)) {
        throw new Error("Simulation inner instruction is malformed");
      }
      const programIdIndex = ownData(instruction, "programIdIndex",
        "Simulation inner instruction program index");
      if (!Number.isInteger(programIdIndex) || programIdIndex < 0 ||
          programIdIndex >= accountKeyCount) {
        throw new Error("Simulation inner instruction program index is invalid");
      }
      return Object.freeze({ programIdIndex });
    });
    return Object.freeze({
      topLevelInstructionIndex: groupIndex,
      innerInstructionCount: normalizedInstructions.length,
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

export { normalizeSimulationObservation };
