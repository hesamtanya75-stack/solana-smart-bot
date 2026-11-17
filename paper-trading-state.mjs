const DEFAULT_STATE = {
  balance: 100,
  trades: [],
  autoEnabled: false,
  paused: false,
  scannedMints: [],
  deferredMints: [],
  lastRunAt: null,
  lastMessage: "بۆتی سێرڤەر ئامادەیە؛ کڕینی خۆکار ناچالاکە.",
  lastScanReport: [],
  updatedAt: null
};

function hasNoMigrationMetadata(value) {
  return ["scannedMints", "deferredMints", "lastScanReport"].every(key =>
    value?.[key] === undefined || (Array.isArray(value[key]) && value[key].length === 0)
  );
}

function cleanState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Paper trading state integrity error: state must be an object");
  }
  const s = value;
  if (typeof s.balance !== "number" || !Number.isFinite(s.balance) || s.balance < 0) {
    throw new Error("Paper trading state integrity error: invalid balance");
  }
  if (s.trades !== undefined && !Array.isArray(s.trades)) {
    throw new Error("Paper trading state integrity error: trades must be an array");
  }
  const sourceTrades = s.trades || [];
  if (sourceTrades.length > 500) {
    throw new Error("Paper trading state integrity error: trade history exceeds the supported limit");
  }
  const finite = (value, fallback = 0) =>
    value === undefined ? fallback :
    typeof value === "number" && Number.isFinite(value) ? value : NaN;
  const trades = sourceTrades.map(trade => {
    if (!trade || typeof trade !== "object" || Array.isArray(trade) ||
        typeof trade.mint !== "string" || !trade.mint.trim() || trade.mint.length > 64) {
      throw new Error("Paper trading state integrity error: malformed trade record");
    }
    const amount = finite(trade.amount), buyPrice = finite(trade.buyPrice), tokens = finite(trade.tokens);
    const currentPrice = finite(trade.currentPrice, buyPrice);
    const sellPrice = finite(trade.sellPrice), saleValue = finite(trade.saleValue);
    if (![amount, buyPrice, tokens, currentPrice, sellPrice, saleValue].every(Number.isFinite) ||
        amount <= 0 || buyPrice <= 0 || tokens <= 0 || currentPrice < 0 ||
        sellPrice < 0 || saleValue < 0 || (trade.sold !== undefined && typeof trade.sold !== "boolean")) {
      throw new Error("Paper trading state integrity error: invalid trade values");
    }
    return {
      mint: trade.mint.trim(), amount, buyPrice,
      currentPrice: currentPrice || buyPrice, tokens,
      sold: trade.sold === true, sellPrice, saleValue,
      boughtAt: typeof trade.boughtAt === "string" ? trade.boughtAt.slice(0, 64) : null,
      soldAt: typeof trade.soldAt === "string" ? trade.soldAt.slice(0, 64) : null
    };
  });
  return {
    balance: s.balance,
    trades,
    autoEnabled: s.autoEnabled === true,
    paused: s.paused === true,
    scannedMints: Array.isArray(s.scannedMints) ? s.scannedMints.filter(x => typeof x === "string" && x.length <= 64).slice(-1000) : [],
    deferredMints: Array.isArray(s.deferredMints) ? s.deferredMints.slice(-1000).flatMap(x =>
      x && typeof x === "object" && !Array.isArray(x) && typeof x.mint === "string" &&
      x.mint.length <= 64 && Number.isFinite(Number(x.retryAt))
        ? [{ mint: x.mint, retryAt: Number(x.retryAt) }] : []) : [],
    lastRunAt: typeof s.lastRunAt === "string" ? s.lastRunAt.slice(0, 64) : null,
    lastMessage: typeof s.lastMessage === "string" ? s.lastMessage.slice(0, 2000) : DEFAULT_STATE.lastMessage,
    lastScanReport: Array.isArray(s.lastScanReport) ? s.lastScanReport.slice(-20).flatMap(x =>
      x && typeof x === "object" && !Array.isArray(x) ? [{
        mint: typeof x.mint === "string" ? x.mint.slice(0, 64) : "",
        status: typeof x.status === "string" ? x.status.slice(0, 40) : "",
        reasons: Array.isArray(x.reasons) ? x.reasons.filter(v => typeof v === "string").slice(0, 10).map(v => v.slice(0, 300)) : []
      }] : []) : [],
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt.slice(0, 64) : null
  };
}

async function readBoundedJson(request, maxBytes = 262144) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Request body required");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON object required");
  }
  return value;
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      !Array.isArray(record.recentOperations) || record.recentOperations.length > 500 ||
      (record.migrationOpen !== undefined && typeof record.migrationOpen !== "boolean") ||
      (record.migrationMarkerPending !== undefined && typeof record.migrationMarkerPending !== "boolean")) {
    throw new Error("Paper trading state integrity error: invalid ledger record envelope");
  }
  cleanState(record.state);
  const seen = new Set();
  for (const item of record.recentOperations) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        typeof item.id !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(item.id) ||
        seen.has(item.id) || !["paper-buy", "clear-history"].includes(item.operation) ||
        typeof item.intent !== "string") {
      throw new Error("Paper trading state integrity error: invalid idempotency record");
    }
    seen.add(item.id);
    if (item.operation === "clear-history") {
      if (item.intent !== "") throw new Error("Paper trading state integrity error: invalid clear-history intent");
    } else {
      let intent;
      try { intent = JSON.parse(item.intent); }
      catch { throw new Error("Paper trading state integrity error: malformed paper-buy intent"); }
      if (!intent || typeof intent !== "object" || Array.isArray(intent) ||
          typeof intent.mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(intent.mint) ||
          typeof intent.price !== "number" || !Number.isFinite(intent.price) || intent.price <= 0 ||
          Object.keys(intent).some(key => !["mint", "price"].includes(key))) {
        throw new Error("Paper trading state integrity error: invalid paper-buy intent");
      }
    }
  }
  return record;
}
export class PaperTradingState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async ensureRecord() {
    const migrationKey = "paper_state_do_migration_v1";
    let record = await this.ctx.storage.get("paper_state_v1");
    if (record) {
      // Validate persisted ledger data before returning it or allowing any later
      // compare-and-set write. Corruption must fail closed, never normalize to $100.
      validateRecord(record);
      // If the DO record committed but the KV completion marker write failed,
      // finish that marker before ever allowing recovery from the legacy snapshot.
      if (record.migrationMarkerPending !== false) {
        const marker = await this.env.BOT_STATE.get(migrationKey);
        if (marker !== "complete") await this.env.BOT_STATE.put(migrationKey, "complete");
        record = await this.ctx.storage.transaction(async txn => {
          const current = await txn.get("paper_state_v1");
          if (!current) return current;
          validateRecord(current);
          if (current.migrationMarkerPending === false) return current;
          const completed = { ...current, migrationMarkerPending: false };
          await txn.put("paper_state_v1", completed);
          return completed;
        });
      }
      return record;
    }
    const marker = await this.env.BOT_STATE.get(migrationKey);
    if (marker === "complete") {
      // Never re-import an old KV snapshot if the Durable Object's own storage
      // was reset after a completed migration; fail closed instead of resurrecting stale trades.
      record = await this.ctx.storage.get("paper_state_v1");
      if (record) return validateRecord(record);
      throw new Error("PaperTradingState storage is missing after its one-time KV migration");
    }
    // An "initializing" marker is recoverable: a prior isolate may have stopped
    // after writing the marker but before committing the Durable Object record.
    // If a record had committed, the first storage.get above would have returned it.
    const legacy = await this.env.BOT_STATE.get("bot_state", "json");
    await this.env.BOT_STATE.put(migrationKey, "initializing");
    const initialState = cleanState(legacy || DEFAULT_STATE);
    // cleanState intentionally filters malformed optional metadata for normal
    // operation. During the one-time migration decision, however, malformed or
    // non-empty legacy metadata must count as prior activity and close migration.
    const noLegacyDeferredActivity = legacy?.deferredMints === undefined ||
      (Array.isArray(legacy.deferredMints) && legacy.deferredMints.length === 0);
    const noLegacyScanReportActivity = legacy?.lastScanReport === undefined ||
      (Array.isArray(legacy.lastScanReport) && legacy.lastScanReport.length === 0);
    const noLegacyScannedMintActivity = legacy?.scannedMints === undefined ||
      (Array.isArray(legacy.scannedMints) && legacy.scannedMints.length === 0);
    const migrationOpen = initialState.balance === 100 && initialState.trades.length === 0 &&
      initialState.autoEnabled === false && initialState.paused === false &&
      initialState.scannedMints.length === 0 && initialState.deferredMints.length === 0 &&
      initialState.lastScanReport.length === 0 &&
      noLegacyDeferredActivity && noLegacyScanReportActivity && noLegacyScannedMintActivity;
    const candidate = { state: initialState, revision: 0, recentOperations: [], migrationOpen, migrationMarkerPending: true };
    record = await this.ctx.storage.transaction(async txn => {
      const existing = await txn.get("paper_state_v1");
      if (existing) return validateRecord(existing);
      await txn.put("paper_state_v1", candidate);
      return candidate;
    });
    await this.env.BOT_STATE.put(migrationKey, "complete");
    record = await this.ctx.storage.transaction(async txn => {
      const current = await txn.get("paper_state_v1");
      if (!current) return current;
      validateRecord(current);
      if (current.migrationMarkerPending === false) return current;
      const completed = { ...current, migrationMarkerPending: false };
      await txn.put("paper_state_v1", completed);
      return completed;
    });
    return record;
  }

  async transact(mutator) {
    await this.ensureRecord();
    return this.ctx.storage.transaction(async txn => {
      const record = validateRecord(await txn.get("paper_state_v1"));
      const result = await mutator(record);
      if (result?.write) await txn.put("paper_state_v1", result.record);
      return result?.value;
    });
  }

  async fetch(request) {
    if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);
    let body;
    try { body = await readBoundedJson(request); }
    catch (error) {
      return response({ error: error.status === 413 ? "Request body too large" : "Invalid JSON" }, error.status || 400);
    }

    try {
      if (body.operation === "get") {
        const record = await this.ensureRecord();
        return response({ state: record.state, revision: record.revision, migrationOpen: record.migrationOpen === true });
      }

      if (body.operation === "compare-and-set") {
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
            !body.state || typeof body.state !== "object" || Array.isArray(body.state)) {
          return response({ error: "Invalid state update" }, 400);
        }
        const result = await this.transact(record => {
          if (record.revision !== body.expectedRevision) {
            return { value: { conflict: true, revision: record.revision, state: record.state } };
          }
          const nextState = cleanState(body.state);
          const migrationStillOpen = record.migrationOpen === true &&
            nextState.balance === 100 && nextState.trades.length === 0 &&
            nextState.autoEnabled === false && nextState.paused === false &&
            nextState.scannedMints.length === 0 && nextState.deferredMints.length === 0 &&
            nextState.lastScanReport.length === 0 && hasNoMigrationMetadata(body.state);
          const next = {
            ...record,
            state: nextState,
            migrationOpen: migrationStillOpen,
            revision: record.revision + 1
          };
          next.state.updatedAt = new Date().toISOString();
          return { write: true, record: next, value: { ok: true, state: next.state, revision: next.revision } };
        });
        return response(result, result.conflict ? 409 : 200);
      }

      if (body.operation === "migrate-legacy") {
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
            !body.state || typeof body.state !== "object" || Array.isArray(body.state)) {
          return response({ error: "Invalid migration" }, 400);
        }
        const result = await this.transact(record => {
          if (record.revision !== body.expectedRevision) {
            return { value: { conflict: true, revision: record.revision, state: record.state } };
          }
          const current = record.state;
          const canMigrate = record.migrationOpen === true &&
            current.balance === 100 && current.trades.length === 0 &&
            current.autoEnabled === false && current.paused === false &&
            current.scannedMints.length === 0 && current.deferredMints.length === 0 &&
            current.lastScanReport.length === 0;
          if (!canMigrate) {
            return { value: { conflict: true, revision: record.revision, state: current } };
          }
          const next = {
            ...record, state: cleanState(body.state),
            migrationOpen: false, revision: record.revision + 1
          };
          next.state.updatedAt = new Date().toISOString();
          return { write: true, record: next, value: { ok: true, state: next.state, revision: next.revision } };
        });
        return response(result, result.conflict ? 409 : 200);
      }

      if (body.operation === "automation") {
        if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings) ||
            !Object.keys(body.settings).length ||
            Object.keys(body.settings).some(key => !["enabled", "paused"].includes(key)) ||
            (body.settings.enabled !== undefined && typeof body.settings.enabled !== "boolean") ||
            (body.settings.paused !== undefined && typeof body.settings.paused !== "boolean")) {
          return response({ error: "Invalid automation settings" }, 400);
        }
        const result = await this.transact(record => {
          const state = { ...record.state };
          if (typeof body.settings.enabled === "boolean") state.autoEnabled = body.settings.enabled;
          if (typeof body.settings.paused === "boolean") state.paused = body.settings.paused;
          state.updatedAt = new Date().toISOString();
          const next = { ...record, state, migrationOpen: false, revision: record.revision + 1 };
          return { write: true, record: next, value: { ok: true, state, revision: next.revision } };
        });
        return response(result);
      }

      if (body.operation === "clear-history" || body.operation === "paper-buy") {
        const requestId = String(body.requestId || "");
        if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) return response({ error: "Invalid request id" }, 400);
        const result = await this.transact(record => {
          const intent = body.operation === "paper-buy" ? JSON.stringify({ mint: String(body.mint || ""), price: Number(body.price) }) : "";
          const previous = record.recentOperations.find(item => item.id === requestId);
          if (previous) {
            if (previous.operation !== body.operation || previous.intent !== intent) {
              return { value: { error: "Idempotency key was reused for a different operation" } };
            }
            return { value: { ok: true, state: record.state, revision: record.revision, replayed: true } };
          }
          const state = { ...record.state, trades: [...record.state.trades] };
          if (body.operation === "clear-history") {
            state.trades = [];
          } else {
            const mint = String(body.mint || "");
            const price = Number(body.price);
            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || !(price > 0) || !Number.isFinite(price)) {
              return { value: { error: "Invalid paper-trade details" } };
            }
            if (state.balance < 5) return { value: { error: "Insufficient paper balance" } };
            if (state.trades.filter(trade => !trade.sold).length >= 10) return { value: { error: "Open paper-trade limit reached" } };
            if (state.trades.some(trade => trade.mint.toLowerCase() === mint.toLowerCase() && !trade.sold)) {
              return { value: { error: "An open paper trade already exists for this mint" } };
            }
            state.balance = Number((state.balance - 5).toFixed(2));
            state.trades.push({
              mint, amount: 5, buyPrice: price, currentPrice: price,
              tokens: 5 / price, sold: false, boughtAt: new Date().toISOString(),
              mode: "paper", riskChecks: "server-verified"
            });
          }
          state.updatedAt = new Date().toISOString();
          const next = { ...record, state, migrationOpen: false, revision: record.revision + 1 };
          const value = { ok: true, state, revision: next.revision };
          next.recentOperations = [...record.recentOperations, { id: requestId, operation: body.operation, intent }].slice(-500);
          return { write: true, record: next, value };
        });
        if (result?.error) return response(result, 409);
        return response(result);
      }

      return response({ error: "Unknown operation" }, 400);
    } catch (error) {
      console.error("PaperTradingState error", String(error?.message || error));
      return response({ error: "Paper trading state operation failed" }, 503);
    }
  }
}
