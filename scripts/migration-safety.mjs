export function isValidSourceState(state) {
  return !!state && typeof state === "object" &&
    typeof state.balance === "number" &&
    Number.isFinite(state.balance) &&
    state.balance >= 0 &&
    Array.isArray(state.trades);
}

export function isCompatibleWithWorkerState(state) {
  if (!isValidSourceState(state) || state.trades.length > 500) return false;
  const boundedArrays = [
    ["scannedMints", 1000],
    ["deferredMints", 1000],
    ["lastScanReport", 20]
  ];
  for (const [key, maxLength] of boundedArrays) {
    if (Object.hasOwn(state, key) &&
        (!Array.isArray(state[key]) || state[key].length > maxLength)) {
      return false;
    }
  }
  return true;
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
