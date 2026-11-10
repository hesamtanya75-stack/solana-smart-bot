const MAX_TRADE_USD_CENTS = 300;
const MAX_DAILY_SPEND_USD_CENTS = 500;
const MAX_OPEN_POSITIONS = 10;
const MAX_QUOTE_AGE_MS = 30_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function emptyState() {
  return { killSwitch: true, reservations: {} };
}

function validateIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new Error("A valid idempotency key is required");
  }
  return value;
}

function usdCentsFromLamports(amountLamports, solUsd) {
  if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0) {
    throw new Error("Amount must be a positive safe integer in lamports");
  }
  if (!Number.isFinite(solUsd) || solUsd <= 0) {
    throw new Error("A positive trusted SOL/USD quote is required");
  }
  return Math.ceil((amountLamports / LAMPORTS_PER_SOL) * solUsd * 100);
}

function currentUtcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * SQLite-backed Durable Object coordinator.
 *
 * This class is an isolated safety primitive only. The current Worker does not
 * call it, and it does not request quotes, build transactions, sign, or submit.
 * Its namespace must be bound only to trusted server-side Worker code.
 */
export class LiveTradeCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async withState(operation) {
    let result;
    await this.ctx.storage.transaction(async () => {
      const state = (await this.ctx.storage.get("coordinator_state")) || emptyState();
      result = await operation(state);
      await this.ctx.storage.put("coordinator_state", state);
    });
    return result;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return json(await this.status());
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    try {
      if (url.pathname === "/reserve") return json(await this.reserve(body));
      if (url.pathname === "/confirm") return json(await this.transition(body, "confirmed"));
      if (url.pathname === "/fail") return json(await this.transition(body, "failed"));
      if (url.pathname === "/close") return json(await this.transition(body, "closed"));
      if (url.pathname === "/kill-switch") return json(await this.setKillSwitch(body));
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = String(error?.message || error);
      const status = /limit|disabled|stale|risk|already|state|idempotency|quote|switch|position|submission|proof/i.test(message) ? 409 : 400;
      return json({ error: message }, status);
    }
  }

  async reserve(body) {
    const key = validateIdempotencyKey(body?.idempotencyKey);
    const amountLamports = Number(body?.amountLamports);
    if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0) {
      throw new Error("Amount must be a positive safe integer in lamports");
    }

    const now = Date.now();
    return this.withState(state => {
      // Resolve retries before checking the kill switch or quote freshness.
      // A retry must never create a second reservation or be blocked merely
      // because the original quote has since expired.
      const existing = state.reservations[key];
      if (existing) {
        if (existing.amountLamports !== amountLamports) {
          throw new Error("Idempotency key reused with a different amount");
        }
        return { ok: true, duplicate: true, reservation: existing };
      }

      if (state.killSwitch !== false) throw new Error("Emergency kill switch is active");

      const quoteTimestamp = Number(body?.quoteTimestamp);
      if (!Number.isFinite(quoteTimestamp) || quoteTimestamp > now + 5_000 ||
          now - quoteTimestamp > MAX_QUOTE_AGE_MS) {
        throw new Error("SOL/USD quote is missing, stale, or from the future");
      }
      if (body?.riskPassed !== true) {
        throw new Error("All server-side risk checks must pass");
      }

      const amountCents = usdCentsFromLamports(amountLamports, Number(body?.solUsd));
      if (amountCents > MAX_TRADE_USD_CENTS) throw new Error("Per-trade USD limit exceeded");

      const day = currentUtcDay(now);
      const records = Object.values(state.reservations);
      const dailySpend = records
        .filter(item => item.day === day && item.status !== "failed")
        .reduce((sum, item) => sum + item.amountCents, 0);
      if (dailySpend + amountCents > MAX_DAILY_SPEND_USD_CENTS) {
        throw new Error("Daily USD spend limit exceeded");
      }

      const openPositions = records.filter(item =>
        item.status === "pending" || item.status === "confirmed"
      ).length;
      if (openPositions >= MAX_OPEN_POSITIONS) throw new Error("Maximum open positions reached");

      const reservation = {
        idempotencyKey: key,
        amountLamports,
        amountCents,
        day,
        status: "pending",
        createdAt: new Date(now).toISOString()
      };
      state.reservations[key] = reservation;
      return { ok: true, duplicate: false, reservation };
    });
  }

  async transition(body, targetStatus) {
    const key = validateIdempotencyKey(body?.idempotencyKey);
    return this.withState(state => {
      const reservation = state.reservations[key];
      if (!reservation) throw new Error("Reservation not found");
      if (reservation.status === targetStatus) return { ok: true, duplicate: true, reservation };
      if (targetStatus === "confirmed" && reservation.status !== "pending") {
        throw new Error("Only pending reservations can be confirmed");
      }
      if (targetStatus === "failed" && reservation.status !== "pending") {
        throw new Error("Only pending reservations can be failed");
      }
      if (targetStatus === "failed" &&
          (body?.definitelyNotSubmitted !== true ||
           typeof body?.resolutionReason !== "string" ||
           body.resolutionReason.trim().length < 12)) {
        throw new Error("Fail resolution requires explicit proof of non-submission and a reason of at least 12 characters");
      }
      if (targetStatus === "closed" && reservation.status !== "confirmed") {
        throw new Error("Only confirmed positions can be closed");
      }
      reservation.status = targetStatus;
      reservation.updatedAt = new Date().toISOString();
      return { ok: true, duplicate: false, reservation };
    });
  }

  async setKillSwitch(body) {
    if (typeof body?.enabled !== "boolean") throw new Error("enabled must be a boolean");
    return this.withState(state => {
      state.killSwitch = body.enabled;
      state.killSwitchUpdatedAt = new Date().toISOString();
      return { ok: true, killSwitch: state.killSwitch };
    });
  }

  async status() {
    return this.withState(state => {
      const day = currentUtcDay(Date.now());
      const records = Object.values(state.reservations);
      return {
        killSwitch: state.killSwitch !== false,
        dailySpendUsdCents: records
          .filter(item => item.day === day && item.status !== "failed")
          .reduce((sum, item) => sum + item.amountCents, 0),
        openPositions: records.filter(item =>
          item.status === "pending" || item.status === "confirmed"
        ).length,
        limits: {
          maxTradeUsdCents: MAX_TRADE_USD_CENTS,
          maxDailySpendUsdCents: MAX_DAILY_SPEND_USD_CENTS,
          maxOpenPositions: MAX_OPEN_POSITIONS,
          maxQuoteAgeMs: MAX_QUOTE_AGE_MS
        }
      };
    });
  }
}
