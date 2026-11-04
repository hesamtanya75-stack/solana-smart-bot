
const http = require("http");

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/health") {
    res.end(JSON.stringify({
      ok: true,
      mode: "paper-trading"
    }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(process.env.PORT || 3000, "0.0.0.0");
