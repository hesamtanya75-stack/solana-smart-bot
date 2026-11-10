import { fetchTrustedLiveEvidence } from "./trusted-live-evidence.mjs";

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

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function orderIntentFingerprint(body, amountLamports) {
  const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const inputMint = String(body?.inputMint || "");
  const outputMint = String(body?.outputMint || "");
  const destination = String(body?.destination || "");
  const slippageBps = Number(body?.slippageBps);
  if (!base58.test(inputMint) || !base58.test(outputMint) || inputMint === outputMint ||
      !base58.test(destination) || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 100 ||
      inputMint !== "So11111111111111111111111111111111111111112") {
    throw new Error("Complete immutable order intent is required");
  }
  return JSON.stringify({ amountLamports, inputMint, outputMint, destination, slippageBps });
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
    // Injectable only in isolated unit tests; production Worker bindings cannot carry functions.
    this.fetchLiveEvidence = env?.FETCH_TRUSTED_LIVE_EVIDENCE || fetchTrustedLiveEvidence;
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
    const expectedToken = String(this.env?.COORDINATOR_INTERNAL_TOKEN || "");
    const authorization = request.headers.get("Authorization") || "";
    const suppliedToken = authorization.replace(/^Bearer\s+/i, "");
    if (expectedToken.length < 32 || !constantTimeEqual(suppliedToken, expectedToken)) {
      return json({ error: "Unauthorized coordinator request" }, 401);
    }
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
    const intentFingerprint = orderIntentFingerprint(body, amountLamports);

    // Fast idempotent retry path: do not require a still-fresh quote for an
    // order that has already been reserved with exactly the same immutable intent.
    const previous = await this.withState(state => {
      const existing = state.reservations[key];
      if (!existing) return null;
      if (existing.intentFingerprint !== intentFingerprint) {
        throw new Error("Idempotency key reused with a different order intent");
      }
      return { ok: true, duplicate: true, reservation: existing };
    });
    if (previous) return previous;

    // Recheck the kill switch before making external requests.
    const stopped = await this.withState(state => state.killSwitch !== false);
    if (stopped) throw new Error("Emergency kill switch is active");

    // All price and risk evidence is fetched by trusted server code. Any
    // browser-supplied solUsd, quoteTimestamp, quoteId, or riskPassed is ignored.
    const evidence = await this.fetchLiveEvidence(
      body.outputMint,
      this.env?.FETCH_IMPL || fetch,
      this.env?.ALCHEMY_API_KEY || "",
      this.env?.JUPITER_API_KEY || ""
    );
    if (!evidence.passed) {
      throw new Error("Trusted token risk checks did not all pass; reservation blocked");
    }
    const quoteTimestamp = evidence.quote.fetchedAt;
    const now = Date.now();
    if (!Number.isFinite(quoteTimestamp) || quoteTimestamp > now + 5000 ||
        now - quoteTimestamp > MAX_QUOTE_AGE_MS) {
      throw new Error("Trusted SOL/USD quote is stale");
    }
    const amountCents = usdCentsFromLamports(amountLamports, evidence.quote.price);
    if (amountCents > MAX_TRADE_USD_CENTS) throw new Error("Per-trade USD limit exceeded");

    return this.withState(state => {
      // Recheck after network calls to protect against concurrent reservations
      // and a kill-switch activation while external evidence was being fetched.
      const existing = state.reservations[key];
      if (existing) {
        if (existing.intentFingerprint !== intentFingerprint) {
          throw new Error("Idempotency key reused with a different order intent");
        }
        return { ok: true, duplicate: true, reservation: existing };
      }
      if (state.killSwitch !== false) throw new Error("Emergency kill switch is active");

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
        intentFingerprint,
        quoteProvider: evidence.quote.provider,
        quoteId: evidence.quote.quoteId,
        quoteFetchedAt: new Date(quoteTimestamp).toISOString(),
        solUsd: evidence.quote.price,
        tokenRiskProvider: evidence.risk.provider,
        tokenRiskFetchedAt: new Date(evidence.risk.fetchedAt).toISOString(),
        tokenRiskChecks: evidence.risk.checks,
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
