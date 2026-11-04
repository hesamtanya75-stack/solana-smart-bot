
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.BOT_API_KEY || "";
const allowedOrigin = process.env.FRONTEND_ORIGIN ||
  "https://hesamtanya75-stack.github.io";

const databasePath = process.env.DATABASE_PATH ||
  path.join(__dirname, "data", "bot.sqlite");

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance REAL NOT NULL,
    trades_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

db.prepare(`
  INSERT OR IGNORE INTO bot_state
  (id, balance, trades_json, updated_at)
  VALUES (1, 100, '[]', ?)
`).run(new Date().toISOString());

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

function authorized(req) {
  if (!apiKey || !req.headers.authorization) return false;

  const supplied = req.headers.authorization.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(apiKey);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const pathname = new URL(req.url, "http://localhost").pathname;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, {
      ok: true,
      mode: "paper-trading",
      storage: "sqlite",
      apiConfigured: Boolean(apiKey)
    });
  }

  if (pathname === "/api/state") {
    if (!apiKey) {
      return send(res, 503, { error: "BOT_API_KEY is not configured" });
    }

    if (!authorized(req)) {
      return send(res, 401, { error: "Unauthorized" });
    }

    if (req.method === "GET") {
      const row = db.prepare(
        "SELECT balance, trades_json, updated_at FROM bot_state WHERE id = 1"
      ).get();

      return send(res, 200, {
        balance: row.balance,
        trades: JSON.parse(row.trades_json),
        updatedAt: row.updated_at
      });
    }

    if (req.method === "PUT") {
      try {
        const body = await readBody(req);
        const balance = Number(body.balance);
        const trades = body.trades;

        if (!Number.isFinite(balance) || balance < 0 ||
            !Array.isArray(trades) || trades.length > 500) {
          return send(res, 400, { error: "Invalid balance or trades" });
        }

        const updatedAt = new Date().toISOString();

        db.prepare(`
          UPDATE bot_state
          SET balance = ?, trades_json = ?, updated_at = ?
          WHERE id = 1
        `).run(balance, JSON.stringify(trades), updatedAt);

        return send(res, 200, { ok: true, updatedAt });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }

    return send(res, 405, { error: "Method not allowed" });
  }

  return send(res, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log("Paper-trading API listening on port " + port);
});

function shutdown() {
  db.close();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
