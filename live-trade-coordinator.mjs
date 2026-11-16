import { fetchTrustedLiveEvidence, verifyFinalizedJupiterSettlement } from "./trusted-live-evidence.mjs";

const MAX_TRADE_USD_CENTS = 300;
const MAX_DAILY_SPEND_USD_CENTS = 500;
const MAX_OPEN_POSITIONS = 10;
// Preserve idempotency history without allowing unbounded Durable Object state growth.
const MAX_RESERVATIONS = 1000;
const MAX_KILL_SWITCH_AUDIT_EVENTS = 1000;
const MAX_QUOTE_AGE_MS = 30_000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const EXPECTED_BOT_WALLET = "BUDJQYHSefZZzAJLFV26wvpbfLpqkzuVYAYBGXfjGrgy";
const EXPECTED_TOKEN_CHECKS = [
  "mintAuthoritySafe", "freezeAuthoritySafe", "token2022ExtensionsSafe",
  "holderConcentrationSafe", "sellRouteAvailable", "marketLiquiditySafe",
  "marketVolumeSafe", "rugCheckSafe"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function readBoundedJson(request, maxBytes = 16384) {
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
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON object required");
  }
  return value;
}

function emptyState() {
  return { killSwitch: true, reservations: {}, killSwitchAudit: [] };
}

function isUtcDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function readReservationRecords(state) {
  const ledger = state?.reservations;
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    throw new Error("Coordinator reservation ledger is invalid; operator review required");
  }
  const records = Object.entries(ledger);
  for (const [key, item] of records) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        item.idempotencyKey !== key ||
        typeof item.intentFingerprint !== "string" || item.intentFingerprint.length === 0 ||
        !Number.isSafeInteger(item.amountCents) || item.amountCents < 0 ||
        !isUtcDay(item.day) ||
        !["pending", "confirmed", "failed", "closed"].includes(item.status)) {
      throw new Error("Coordinator reservation ledger contains an invalid record; operator review required");
    }
  }
  return records.map(([, item]) => item);
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

function validateAllInCostEvidence(costs, amountLamports, configuredPriorityFeeCap) {
  if (!Number.isSafeInteger(configuredPriorityFeeCap) || configuredPriorityFeeCap < 0) {
    throw new Error("Reviewed maximum priority fee is not configured; reservation blocked");
  }
  const fields = [
    "computeUnitPriceMicroLamports", "computeUnitLimit",
    "maxPriorityFeeLamports", "baseFeeLamports", "tipLamports",
    "rentLamports", "otherOutflowLamports"
  ];
  if (!costs || typeof costs !== "object" || Array.isArray(costs) ||
      fields.some(field => !Object.prototype.hasOwnProperty.call(costs, field))) {
    throw new Error("Trusted all-in transaction cost evidence is missing; reservation blocked");
  }
  const priceText = String(costs.computeUnitPriceMicroLamports);
  if (!/^\d{1,20}$/.test(priceText) ||
      !Number.isSafeInteger(costs.computeUnitLimit) || costs.computeUnitLimit < 1 ||
      costs.computeUnitLimit > 1_400_000) {
    throw new Error("Trusted compute budget evidence is invalid");
  }
  for (const field of ["maxPriorityFeeLamports", "baseFeeLamports", "tipLamports", "rentLamports", "otherOutflowLamports"]) {
    if (!Number.isSafeInteger(costs[field]) || costs[field] < 0) {
      throw new Error("Trusted all-in transaction cost evidence is invalid");
    }
  }
  const calculatedPriority = (BigInt(priceText) * BigInt(costs.computeUnitLimit) + 999_999n) / 1_000_000n;
  if (calculatedPriority > BigInt(Number.MAX_SAFE_INTEGER) ||
      Number(calculatedPriority) !== costs.maxPriorityFeeLamports) {
    throw new Error("Priority fee does not match the verified compute budget");
  }
  if (costs.maxPriorityFeeLamports > configuredPriorityFeeCap) {
    throw new Error("Priority fee exceeds the reviewed maximum");
  }
  const fees = BigInt(costs.maxPriorityFeeLamports) + BigInt(costs.baseFeeLamports) +
    BigInt(costs.tipLamports) + BigInt(costs.rentLamports) + BigInt(costs.otherOutflowLamports);
  const total = BigInt(amountLamports) + fees;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("All-in transaction cost exceeds safe accounting limits");
  }
  return Object.freeze({
    computeUnitPriceMicroLamports: priceText,
    computeUnitLimit: costs.computeUnitLimit,
    maxPriorityFeeLamports: costs.maxPriorityFeeLamports,
    baseFeeLamports: costs.baseFeeLamports,
    tipLamports: costs.tipLamports,
    rentLamports: costs.rentLamports,
    otherOutflowLamports: costs.otherOutflowLamports,
    totalFeeLamports: Number(fees),
    totalLamports: Number(total)
  });
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
      !base58.test(destination) || destination !== EXPECTED_BOT_WALLET ||
      !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 100 ||
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
    this.verifySettlement = env?.VERIFY_FINALIZED_SETTLEMENT || verifyFinalizedJupiterSettlement;
  }

  authorizeOperator(request) {
    const expected = String(this.env?.COORDINATOR_OPERATOR_TOKEN || "");
    const supplied = request.headers.get("X-Operator-Token") || "";
    const internal = String(this.env?.COORDINATOR_INTERNAL_TOKEN || "");
    return expected.length >= 32 && expected !== internal && constantTimeEqual(supplied, expected);
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
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    const suppliedToken = match ? match[1] : "";
    if (expectedToken.length < 32 || !constantTimeEqual(suppliedToken, expectedToken)) {
      return json({ error: "Unauthorized coordinator request" }, 401);
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      try {
        return json(await this.status());
      } catch (error) {
        return json({ error: String(error?.message || error) }, 409);
      }
    }
    if (request.method === "GET" && url.pathname === "/audit") {
      if (!this.authorizeOperator(request)) return json({ error: "Unauthorized operator request" }, 401);
      return json(await this.killSwitchAudit());
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    let body;
    try {
      body = await readBoundedJson(request);
    } catch (error) {
      return json(
        { error: error.status === 413 ? "Request body too large" : "Invalid JSON body" },
        error.status || 400
      );
    }

    try {
      if (url.pathname === "/reserve") return json(await this.reserve(body));
      if (url.pathname === "/confirm") return json(await this.transition(body, "confirmed"));
      if (url.pathname === "/fail") return json(await this.transition(body, "failed"));
      if (url.pathname === "/close") return json(await this.transition(body, "closed"));
      if (url.pathname === "/kill-switch") {
        if (!this.authorizeOperator(request)) return json({ error: "Unauthorized operator request" }, 401);
        return json(await this.setKillSwitch(body));
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = String(error?.message || error);
      const status = /limit|disabled|stale|risk|already|state|idempotency|quote|switch|position|submission|proof|semantic|lookup|history|capacity|ledger|evidence|compute budget|priority fee|reviewed maximum/i.test(message) ? 409 : 400;
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
      // The emergency stop takes precedence over every retry, including an
      // already-reserved idempotent request. A duplicate response must never
      // be mistaken for permission to continue toward signing or submission.
      if (state.killSwitch !== false) throw new Error("Emergency kill switch is active");
      const records = readReservationRecords(state);
      const existing = state.reservations[key];
      if (!existing) {
        if (records.length >= MAX_RESERVATIONS) {
          throw new Error("Coordinator reservation history capacity reached; operator review required");
        }
        return null;
      }
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
    const quote = evidence?.quote;
    const risk = evidence?.risk;
    if (evidence?.passed !== true || risk?.passed !== true ||
        risk?.mint !== body.outputMint ||
        typeof risk?.checks !== "object" || risk.checks === null ||
        EXPECTED_TOKEN_CHECKS.some(name => risk.checks[name] !== true) ||
        Object.values(risk.checks).some(value => value !== true)) {
      throw new Error("Trusted token risk checks are missing, mismatched, or failed; reservation blocked");
    }
    // A boolean risk flag alone is insufficient: require an explicit semantic
    // verification attestation before any reservation can pass the coordinator.
    if (risk.sellRoute?.semanticInstructionVerification !== true ||
        risk.sellRoute?.routeVerification !== "semantically-verified") {
      throw new Error("Jupiter instruction semantics and lookup tables are not verified; reservation blocked");
    }
    const riskTimestamp = risk.fetchedAt;
    if (!Number.isFinite(riskTimestamp) || riskTimestamp > Date.now() + 5000 ||
        Date.now() - riskTimestamp > MAX_QUOTE_AGE_MS) {
      throw new Error("Trusted token risk evidence is stale");
    }
    if (quote?.provider !== "Coinbase" || quote?.pair !== "SOL/USD" ||
        typeof quote.quoteId !== "string" || !quote.quoteId) {
      throw new Error("Trusted SOL/USD quote identity is invalid");
    }
    const quoteTimestamp = quote.fetchedAt;
    const now = Date.now();
    if (!Number.isFinite(quoteTimestamp) || quoteTimestamp > now + 5000 ||
        now - quoteTimestamp > MAX_QUOTE_AGE_MS) {
      throw new Error("Trusted SOL/USD quote is stale");
    }
    // Cost evidence must come from trusted server-side route/build analysis.
    // Never accept fee estimates supplied by the browser.
    const priorityFeeCapText = String(this.env?.LIVE_MAX_PRIORITY_FEE_LAMPORTS ?? "");
    if (!/^\d{1,16}$/.test(priorityFeeCapText) ||
        !Number.isSafeInteger(Number(priorityFeeCapText))) {
      throw new Error("Reviewed maximum priority fee is not configured; reservation blocked");
    }
    const allInCosts = validateAllInCostEvidence(
      evidence.costs, amountLamports, Number(priorityFeeCapText)
    );
    const amountCents = usdCentsFromLamports(allInCosts.totalLamports, quote.price);
    if (amountCents > MAX_TRADE_USD_CENTS) throw new Error("Per-trade all-in USD limit exceeded");

    return this.withState(state => {
      // Recheck after network calls to protect against concurrent reservations
      // and a kill-switch activation while external evidence was being fetched.
      // The stop must also precede the duplicate check here: an in-flight
      // request may reach this transaction after another request reserved the
      // same key and the operator activated the stop.
      if (state.killSwitch !== false) throw new Error("Emergency kill switch is active");
      const existing = state.reservations[key];
      if (existing) {
        if (existing.intentFingerprint !== intentFingerprint) {
          throw new Error("Idempotency key reused with a different order intent");
        }
        return { ok: true, duplicate: true, reservation: existing };
      }

      const records = readReservationRecords(state);
      if (records.length >= MAX_RESERVATIONS) {
        throw new Error("Coordinator reservation history capacity reached; operator review required");
      }
      const day = currentUtcDay(now);
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
        allInCosts,
        inputMint: body.inputMint,
        outputMint: body.outputMint,
        destination: body.destination,
        intentFingerprint,
        quoteProvider: quote.provider,
        quoteId: quote.quoteId,
        quoteFetchedAt: new Date(quoteTimestamp).toISOString(),
        solUsd: quote.price,
        tokenRiskProvider: risk.provider,
        tokenRiskMint: risk.mint,
        tokenRiskFetchedAt: new Date(riskTimestamp).toISOString(),
        tokenRiskChecks: risk.checks,
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
    // Failure/closure require an independently verifiable non-submission or
    // exit proof, which is not implemented. Confirmation requires finalized
    // on-chain signature and exact owner-scoped input/output token deltas.
    if (targetStatus !== "confirmed") {
      throw new Error("Independent failure and close proofs are not implemented; state transitions are disabled");
    }
    const key = validateIdempotencyKey(body?.idempotencyKey);
    const signature = body?.signature;
    const outputAmount = body?.outputAmount;
    // The emergency stop blocks new reservations, not reconciliation of a
    // transaction that may already have been submitted. Confirmation below
    // still requires independent finalized on-chain settlement proof.
    const reservation = await this.withState(state => {
      const item = state.reservations[key];
      if (!item) throw new Error("Reservation does not exist");
      if (item.status === "confirmed") {
        if (item.settlementProof?.signature !== signature) {
          throw new Error("Confirmed reservation cannot be replayed with another signature");
        }
        return { alreadyConfirmed: true, item };
      }
      if (item.status !== "pending") throw new Error("Only a pending reservation can be confirmed");
      return { alreadyConfirmed: false, item };
    });
    if (reservation.alreadyConfirmed) {
      return { ok: true, duplicate: true, reservation: reservation.item };
    }
    const proof = await this.verifySettlement({
      signature,
      inputMint: reservation.item.inputMint,
      outputMint: reservation.item.outputMint,
      inputAmount: String(reservation.item.amountLamports),
      outputAmount,
      expectedOwner: EXPECTED_BOT_WALLET
    }, this.env?.FETCH_IMPL || fetch);
    if (!proof || proof.verified !== true ||
        proof.signature !== signature ||
        proof.inputMint !== reservation.item.inputMint ||
        proof.inputAmount !== String(reservation.item.amountLamports) ||
        proof.outputMint !== reservation.item.outputMint ||
        proof.outputAmount !== outputAmount ||
        proof.owner !== EXPECTED_BOT_WALLET ||
        proof.confirmationStatus !== "finalized") {
      throw new Error("Independent finalized settlement proof is incomplete or mismatched");
    }
    return this.withState(state => {
      const item = state.reservations[key];
      if (!item || item.status !== "pending") {
        throw new Error("Reservation state changed while settlement proof was being verified");
      }
      item.status = "confirmed";
      item.settlementProof = proof;
      item.confirmedAt = new Date().toISOString();
      return { ok: true, duplicate: false, reservation: item };
    });
  }

  async setKillSwitch(body) {
    if (typeof body?.enabled !== "boolean") throw new Error("enabled must be a boolean");
    return this.withState(state => {
      const previous = state.killSwitch !== false;
      const timestamp = new Date().toISOString();
      state.killSwitch = body.enabled;
      state.killSwitchUpdatedAt = timestamp;
      if (!Array.isArray(state.killSwitchAudit)) state.killSwitchAudit = [];
      state.killSwitchAudit.push({
        timestamp,
        action: body.enabled ? "activated" : "deactivated",
        previousKillSwitch: previous,
        killSwitch: body.enabled
      });
      if (state.killSwitchAudit.length > MAX_KILL_SWITCH_AUDIT_EVENTS) {
        state.killSwitchAudit.splice(0, state.killSwitchAudit.length - MAX_KILL_SWITCH_AUDIT_EVENTS);
      }
      return { ok: true, killSwitch: state.killSwitch };
    });
  }

  async killSwitchAudit() {
    return this.withState(state => ({
      events: Array.isArray(state.killSwitchAudit) ? state.killSwitchAudit : []
    }));
  }

  async status() {
    return this.withState(state => {
      const day = currentUtcDay(Date.now());
      const records = readReservationRecords(state);
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
          maxReservations: MAX_RESERVATIONS,
          maxQuoteAgeMs: MAX_QUOTE_AGE_MS
        }
      };
    });
  }
}
