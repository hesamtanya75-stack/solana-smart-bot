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

function cleanState(value) {
  const s = value && typeof value === "object" ? value : {};
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const trades = Array.isArray(s.trades) ? s.trades.slice(-500).flatMap(trade => {
    if (!trade || typeof trade !== "object" || Array.isArray(trade) ||
        typeof trade.mint !== "string" || !trade.mint.trim() || trade.mint.length > 64) return [];
    const amount = finite(trade.amount), buyPrice = finite(trade.buyPrice), tokens = finite(trade.tokens);
    if (amount <= 0 || buyPrice <= 0 || tokens <= 0) return [];
    return [{
      mint: trade.mint.trim(), amount, buyPrice,
      currentPrice: finite(trade.currentPrice) || buyPrice, tokens,
      sold: trade.sold === true, sellPrice: finite(trade.sellPrice),
      saleValue: finite(trade.saleValue),
      boughtAt: typeof trade.boughtAt === "string" ? trade.boughtAt.slice(0, 64) : null,
      soldAt: typeof trade.soldAt === "string" ? trade.soldAt.slice(0, 64) : null
    }];
  }) : [];
  return {
    balance: Number.isFinite(Number(s.balance)) && Number(s.balance) >= 0 ? Number(s.balance) : DEFAULT_STATE.balance,
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

function isPristineMigrationState(state) {
  // Migration may replace the destination only while every persisted field is
  // still at its untouched default. Include deferred work and activity metadata
  // so preflight, initialization, and the transactional guard agree.
  return state.balance === DEFAULT_STATE.balance &&
    state.trades.length === 0 &&
    state.autoEnabled === DEFAULT_STATE.autoEnabled &&
    state.paused === DEFAULT_STATE.paused &&
    state.scannedMints.length === 0 &&
    state.deferredMints.length === 0 &&
    state.lastRunAt === null &&
    state.lastMessage === DEFAULT_STATE.lastMessage &&
    state.lastScanReport.length === 0 &&
    state.updatedAt === null;
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

export class PaperTradingState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async ensureRecord() {
    const migrationKey = "paper_state_do_migration_v1";
    let record = await this.ctx.storage.get("paper_state_v1");
    if (record) {
      // If the DO record committed but the KV completion marker write failed,
      // finish that marker before ever allowing recovery from the legacy snapshot.
      if (record.migrationMarkerPending !== false) {
        const marker = await this.env.BOT_STATE.get(migrationKey);
        if (marker !== "complete") await this.env.BOT_STATE.put(migrationKey, "complete");
        record = await this.ctx.storage.transaction(async txn => {
          const current = await txn.get("paper_state_v1");
          if (!current || current.migrationMarkerPending === false) return current;
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
      if (record) return record;
      throw new Error("PaperTradingState storage is missing after its one-time KV migration");
    }
    // An "initializing" marker is recoverable: a prior isolate may have stopped
    // after writing the marker but before committing the Durable Object record.
    // If a record had committed, the first storage.get above would have returned it.
    const legacy = await this.env.BOT_STATE.get("bot_state", "json");
    await this.env.BOT_STATE.put(migrationKey, "initializing");
    const initialState = cleanState(legacy || DEFAULT_STATE);
    const migrationOpen = isPristineMigrationState(initialState);
    const candidate = { state: initialState, revision: 0, recentOperations: [], migrationOpen, migrationMarkerPending: true };
    record = await this.ctx.storage.transaction(async txn => {
      const existing = await txn.get("paper_state_v1");
      if (existing) return existing;
      await txn.put("paper_state_v1", candidate);
      return candidate;
    });
    await this.env.BOT_STATE.put(migrationKey, "complete");
    record = await this.ctx.storage.transaction(async txn => {
      const current = await txn.get("paper_state_v1");
      if (!current || current.migrationMarkerPending === false) return current;
      const completed = { ...current, migrationMarkerPending: false };
      await txn.put("paper_state_v1", completed);
      return completed;
    });
    return record;
  }

  async transact(mutator) {
    await this.ensureRecord();
    return this.ctx.storage.transaction(async txn => {
      const record = await txn.get("paper_state_v1");
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
      if (body.operation === "migration-status") {
        // Strictly read-only preflight: never call ensureRecord(), which may
        // initialize the DO and write the legacy migration marker to KV.
        const record = await this.ctx.storage.get("paper_state_v1");
        const marker = await this.env.BOT_STATE.get("paper_state_do_migration_v1");
        if (record) {
          return response({
            state: record.state, revision: record.revision,
            migrationOpen: record.migrationOpen === true,
            canMigrateLegacy: record.migrationOpen === true && marker === null,
            initialized: true, marker
          });
        }
        // Any persisted marker without its DO record is inconsistent. Do not
        // treat unknown marker values as a fresh migration opportunity.
        if (marker !== null) {
          return response({ stateMissing: true, revision: null, migrationOpen: false,
            canMigrateLegacy: false, initialized: false, marker });
        }
        const legacy = await this.env.BOT_STATE.get("bot_state", "json");
        const state = cleanState(legacy || DEFAULT_STATE);
        const migrationOpen = isPristineMigrationState(state);
        return response({ state, revision: 0, migrationOpen,
          canMigrateLegacy: migrationOpen, initialized: false, marker: null,
          legacyKeyPresent: legacy !== null });
      }

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
            isPristineMigrationState(nextState);
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
            isPristineMigrationState(current);
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
          const intent = body.operation === "paper-buy" ? String(body.mint || "") : "";
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
