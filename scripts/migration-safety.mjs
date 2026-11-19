export function isValidSourceState(state) {
  return !!state && typeof state === "object" &&
    typeof state.balance === "number" &&
    Number.isFinite(state.balance) &&
    state.balance >= 0 &&
    Array.isArray(state.trades);
}

export function isCompatibleWithWorkerState(state) {
  if (!isValidSourceState(state) || state.trades.length > 500) return false;
  // The legacy Deno API persists only balance, trades, and updatedAt.
  // Missing Worker-only fields are supplied by the Durable Object's
  // validated DEFAULT_STATE during the atomic import.
  const allowedKeys = new Set([
    "balance", "trades", "autoEnabled", "paused", "scannedMints",
    "deferredMints", "lastRunAt", "lastMessage", "lastScanReport", "updatedAt"
  ]);
  if (Object.keys(state).some(key => !allowedKeys.has(key))) return false;
  for (const key of ["autoEnabled", "paused"]) {
    if (state[key] !== undefined && typeof state[key] !== "boolean") return false;
  }
  const boundedArrays = [
    ["scannedMints", 1000],
    ["deferredMints", 1000],
    ["lastScanReport", 20]
  ];
  for (const [key, maxLength] of boundedArrays) {
    if (state[key] !== undefined &&
        (!Array.isArray(state[key]) || state[key].length > maxLength)) return false;
  }
  for (const key of ["lastRunAt", "lastMessage", "updatedAt"]) {
    if (state[key] !== undefined && state[key] !== null && typeof state[key] !== "string") return false;
  }
  return true;
}

export function normalizeLegacySourceState(state) {
  if (!isCompatibleWithWorkerState(state)) {
    throw new TypeError("Source state is not compatible with the Worker schema");
  }
  return {
    autoEnabled: false,
    paused: false,
    scannedMints: [],
    deferredMints: [],
    lastRunAt: null,
    lastMessage: "بۆتی سێرڤەر ئامادەیە؛ کڕینی خۆکار ناچالاکە.",
    lastScanReport: [],
    ...state
  };
}

export function isUninitializedTargetState(state) {
  return !!state &&
    state.updatedAt === null &&
    Number(state.balance) === 100 &&
    Array.isArray(state.trades) && state.trades.length === 0 &&
    state.autoEnabled === false &&
    state.paused === false &&
    Array.isArray(state.scannedMints) && state.scannedMints.length === 0 &&
    Array.isArray(state.deferredMints) && state.deferredMints.length === 0 &&
    Array.isArray(state.lastScanReport) && state.lastScanReport.length === 0;
}

export function statesMatch(source, imported) {
  if (!source || !imported || typeof source !== "object" || typeof imported !== "object") return false;
  return Object.keys(source)
    .filter(key => key !== "updatedAt")
    .every(key => {
      if (key === "balance") return Number(imported.balance) === Number(source.balance);
      return JSON.stringify(imported[key]) === JSON.stringify(source[key]);
    });
}

export function isDefaultLikeSourceState(state) {
  return !!state &&
    Number(state.balance) === 100 &&
    Array.isArray(state.trades) && state.trades.length === 0;
}
