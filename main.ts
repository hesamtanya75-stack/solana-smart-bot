const corsHeaders = {
  "Access-Control-Allow-Origin": "https://hesamtanya75-stack.github.io",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
};

const kv = await Deno.openKv();

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function authorized(req: Request) {
  const key = Deno.env.get("BOT_API_KEY");
  const supplied = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(key && supplied && key === supplied);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (url.pathname === "/health") {
    return json({
      ok: true,
      mode: "paper-trading",
      storage: "Deno KV",
      apiConfigured: Boolean(Deno.env.get("BOT_API_KEY")),
    });
  }

  if (url.pathname !== "/api/state") {
    return json({ error: "Not found" }, 404);
  }

  if (!authorized(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const key = ["bot_state"];

  if (req.method === "GET") {
    const result = await kv.get(key);
    return json(result.value ?? {
      balance: 100,
      trades: [],
      updatedAt: new Date().toISOString(),
    });
  }

  if (req.method === "PUT") {
    try {
      const body = await req.json();
      const balance = Number(body.balance);
      const trades = body.trades;

      if (!Number.isFinite(balance) || balance < 0 ||
          !Array.isArray(trades) || trades.length > 500) {
        return json({ error: "Invalid balance or trades" }, 400);
      }

      const state = {
        balance,
        trades,
        updatedAt: new Date().toISOString(),
      };

      await kv.set(key, state);
      return json({ ok: true, updatedAt: state.updatedAt });
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
  }

  return json({ error: "Method not allowed" }, 405);
});
