export function isValidSourceState(state) {
  return !!state && typeof state === "object" &&
    Number.isFinite(Number(state.balance)) &&
    Number(state.balance) >= 0 &&
    Array.isArray(state.trades);
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
  return Number(imported?.balance) === Number(source?.balance) &&
    JSON.stringify(imported?.trades) === JSON.stringify(source?.trades);
}
