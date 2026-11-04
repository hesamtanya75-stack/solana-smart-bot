const corsHeaders = {
  "Access-Control-Allow-Origin": "https://hesamtanya75-stack.github.io",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

const kv = await Deno.openKv();
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function authorized(req: Request) {
  const token = req.headers
    .get("Authorization")
    ?.replace(/^Bearer\s+/i, "");

  if (!token) return false;

  const session = await kv.get<{ expiresAt: number }>([
    "sessions",
    token,
  ]);

  return Boolean(
    session.value && session.value.expiresAt > Date.now()
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (url.pathname === "/health" && req.method === "GET") {
    return json({
      ok: true,
      mode: "paper-trading",
      storage: "Deno KV",
    });
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    try {
      const body = await req.json();
      const password = Deno.env.get("BOT_LOGIN_PASSWORD");

      if (!password || body.password !== password) {
        return json({ error: "وشەی نهێنی هەڵەیە" }, 401);
      }

      const token = crypto.randomUUID();
      const expiresAt = Date.now() + SESSION_MS;

      await kv.set(
        ["sessions", token],
        { expiresAt },
        { expireIn: SESSION_MS }
      );

      return json({ ok: true, token });
    } catch {
      return json({ error: "داواکاری هەڵەیە" }, 400);
    }
  }

  if (url.pathname !== "/api/state") {
    return json({ error: "Not found" }, 404);
  }

  if (!(await authorized(req))) {
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

      if (
        !Number.isFinite(balance) ||
        balance < 0 ||
        !Array.isArray(trades) ||
        trades.length > 500
      ) {
        return json({ error: "Invalid data" }, 400);
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
