/**
 * Isolated SQLite Durable Object for verified evidence idempotency.
 * Internal Worker binding only; this object cannot sign or submit swaps.
 */
import { LiveOrderLedger } from "./live-order-ledger.js";
import { reservePreparedEvidence } from "./live-order-evidence-reservation.js";

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export class LiveOrderLedgerObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ledger = new LiveOrderLedger(ctx.storage);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/reserve-evidence" || request.method !== "POST") {
      return reply({ error: "Not found" }, 404);
    }
    const secret = this.env.LIVE_ORDER_EVIDENCE_HMAC_SECRET;
    if (typeof secret !== "string" || secret.length < 32) {
      return reply({ error: "Ledger evidence verification is not configured" }, 503);
    }
    const length = request.headers.get("Content-Length");
    if (length !== null && (!/^\\d+$/.test(length) || Number(length) > 8192)) {
      return reply({ error: "Reservation request is too large" }, 413);
    }
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 8192) return reply({ error: "Reservation request is too large" }, 413);
      if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        return reply({ error: "JSON content type required" }, 415);
      }
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "attestation,binding") {
        return reply({ error: "Invalid reservation payload" }, 400);
      }
      const result = await reservePreparedEvidence({
        binding: body.binding,
        attestation: body.attestation,
        ledger: this.ledger,
        secret
      });
      if (!result.ok) return reply(result, result.conflict ? 409 : 400);
      return reply({ ok: true, reservation: result });
    } catch {
      return reply({ error: "Reservation failed closed" }, 400);
    }
  }
}
