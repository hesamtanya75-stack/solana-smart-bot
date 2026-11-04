

const http = require("http");

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.end();
    return;
  }

  if (req.url === "/health") {
    res.end(JSON.stringify({
      ok: true,
      mode: "paper-trading",
      monitoring: "preparing",
      autoSell: {
        takeProfit: 10,
        stopLoss: -5
      }
    })); 
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(process.env.PORT || 3000, "0.0.0.0");
