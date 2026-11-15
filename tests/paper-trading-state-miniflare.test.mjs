import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("PaperTradingState uses real Durable Object transactions and imports KV once", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: "./tests/fixtures/paper-trading-state-runtime.mjs",
    compatibilityDate: "2026-05-03",
    durableObjects: { PAPER_TRADING_STATE: "PaperTradingState" },
    kvNamespaces: ["BOT_STATE"]
  }));

  try {
    const kv = await mf.getKVNamespace("BOT_STATE");
    await kv.put("bot_state", JSON.stringify({ balance: 12, trades: [], updatedAt: "2026-11-01T00:00:00.000Z" }));
    const namespace = await mf.getDurableObjectNamespace("PAPER_TRADING_STATE");
    const stub = namespace.get(namespace.idFromName("paper-state-runtime"));
    const call = async body => {
      const response = await stub.fetch("https://paper-trading.internal/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };

    const initial = await call({ operation: "get" });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.state.balance, 12);
    assert.equal(initial.body.revision, 0);

    const buys = await Promise.all([
      call({ operation: "paper-buy", mint: "So11111111111111111111111111111111111111112", price: 2, requestId: "runtime-paper-buy-0001" }),
      call({ operation: "paper-buy", mint: "So11111111111111111111111111111111111111112", price: 2, requestId: "runtime-paper-buy-0002" })
    ]);
    assert.equal(buys.filter(item => item.status === 200).length, 1);
    assert.equal(buys.filter(item => item.status === 409).length, 1);

    const final = await call({ operation: "get" });
    assert.equal(final.body.state.balance, 7);
    assert.equal(final.body.state.trades.length, 1);
    assert.equal(await kv.get("paper_state_do_migration_v1"), "complete");
  } finally {
    await mf.dispose();
  }
});
