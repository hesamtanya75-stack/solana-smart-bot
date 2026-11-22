import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_STATE_BYTES = 1_000_000;

export function isValidSourceState(state) {
  return !!state && typeof state === "object" &&
    typeof state.balance === "number" &&
    Number.isFinite(state.balance) &&
    state.balance >= 0 &&
    Array.isArray(state.trades);
}

export function isCompatibleWithWorkerState(state) {
  if (!isValidSourceState(state) || state.trades.length > 500) return false;
  if (new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_STATE_BYTES) return false;
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
  for (const key of ["lastRunAt", "updatedAt"]) {
    if (state[key] !== undefined && state[key] !== null &&
        (typeof state[key] !== "string" || state[key].length > 64)) return false;
  }
  if (state.lastMessage !== undefined &&
      (typeof state.lastMessage !== "string" || state.lastMessage.length > 2000)) return false;
  if (state.trades.some(trade =>
    !trade || typeof trade !== "object" || Array.isArray(trade) ||
    typeof trade.mint !== "string" || !trade.mint || trade.mint.length > 64 ||
    (trade.buyPrice !== undefined &&
      (typeof trade.buyPrice !== "number" || !Number.isFinite(trade.buyPrice) || trade.buyPrice <= 0)) ||
    (trade.tokens !== undefined &&
      (typeof trade.tokens !== "number" || !Number.isFinite(trade.tokens) || trade.tokens < 0)) ||
    (trade.sold !== undefined && typeof trade.sold !== "boolean")
  )) return false;
  if (state.scannedMints?.some(mint => typeof mint !== "string" || !mint || mint.length > 64)) return false;
  if (state.deferredMints?.some(item =>
    !item || typeof item !== "object" || Array.isArray(item) ||
    typeof item.mint !== "string" || !item.mint || item.mint.length > 64 ||
    !Number.isFinite(item.retryAt) || item.retryAt < 0
  )) return false;
  if (state.lastScanReport?.some(item =>
    !item || typeof item !== "object" || Array.isArray(item) ||
    typeof item.mint !== "string" || !item.mint || item.mint.length > 64 ||
    typeof item.status !== "string" || !item.status || item.status.length > 64 ||
    !Array.isArray(item.reasons) || item.reasons.length > 12 ||
    item.reasons.some(reason => typeof reason !== "string" || reason.length > 500)
  )) return false;
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
    ...state,
    // Never carry forward an enabled auto-buy flag during a runtime cutover.
    // Preserve the imported paper history, but require the operator to
    // re-enable automation deliberately after validating the new runtime.
    autoEnabled: false
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

export function isSafeBackupPath(path, cwd = process.cwd()) {
  const root = resolve(cwd);
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  const isInsideRepository = rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  // The sole in-repository backup path is explicitly gitignored. Custom paths
  // must live outside the checkout to avoid accidentally committing private state.
  return !isInsideRepository || destination === resolve(root, "deno-bot-state-backup.json");
}
