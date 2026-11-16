import { LiveTradeCoordinator } from "../../live-trade-coordinator.mjs";

export { LiveTradeCoordinator };

export default {
  async fetch() {
    return new Response("LiveTradeCoordinator runtime test worker");
  }
};
