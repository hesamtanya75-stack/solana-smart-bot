import { LiveTradeCoordinator as BaseLiveTradeCoordinator } from "../../live-trade-coordinator.mjs";

const INPUT_MINT = "So11111111111111111111111111111111111111112";
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function runtimeTestEvidence() {
  const fetchedAt = Date.now();
  return {
    passed: true,
    quote: { provider: "Coinbase", pair: "SOL/USD", price: 200, fetchedAt, quoteId: "runtime-restart-test-quote" },
    costs: {
      computeUnitPriceMicroLamports: "10000",
      computeUnitLimit: 200000,
      maxPriorityFeeLamports: 2000,
      baseFeeLamports: 5000,
      tipLamports: 0,
      rentLamports: 0,
      otherOutflowLamports: 0
    },
    risk: {
      passed: true, provider: "test-fixture", mint: OUTPUT_MINT, fetchedAt,
      checks: {
        mintAuthoritySafe: true, freezeAuthoritySafe: true, token2022ExtensionsSafe: true,
        holderConcentrationSafe: true, sellRouteAvailable: true, marketLiquiditySafe: true,
        marketVolumeSafe: true, rugCheckSafe: true
      },
      sellRoute: { semanticInstructionVerification: true, routeVerification: "semantically-verified" }
    }
  };
}

export class LiveTradeCoordinator extends BaseLiveTradeCoordinator {
  constructor(ctx, env) {
    super(ctx, {
      ...env,
      FETCH_TRUSTED_LIVE_EVIDENCE: async () => runtimeTestEvidence(),
      VERIFY_FINALIZED_SETTLEMENT: async () => {
        throw new Error("Simulated settlement RPC outage");
      }
    });
  }
}

export default {
  async fetch() {
    return new Response("LiveTradeCoordinator runtime test worker");
  }
};
