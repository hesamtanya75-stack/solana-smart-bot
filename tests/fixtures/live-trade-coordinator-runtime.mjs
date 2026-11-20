import { LiveTradeCoordinator as BaseLiveTradeCoordinator } from "../../live-trade-coordinator.mjs";

export class LiveTradeCoordinator extends BaseLiveTradeCoordinator {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__test/seed-pending") {
      const expected = String(this.env?.COORDINATOR_INTERNAL_TOKEN || "");
      if (!expected || request.headers.get("Authorization") !== "Bearer " + expected) {
        return new Response("Unauthorized", { status: 401 });
      }
      const day = new Date().toISOString().slice(0, 10);
      await this.ctx.storage.put("coordinator_state", {
        killSwitch: false,
        reservations: {
          "rpc-outage-pending-01": {
            idempotencyKey: "rpc-outage-pending-01",
            intentFingerprint: "test-only-immutable-intent",
            amountCents: 200,
            day,
            status: "pending",
            createdAt: new Date().toISOString()
          }
        },
        killSwitchAudit: []
      });
      return Response.json({ seeded: true });
    }
    return super.fetch(request);
  }
}

export default {
  async fetch() {
    return new Response("LiveTradeCoordinator runtime test worker");
  }
};
