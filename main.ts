Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return Response.json({
      ok: true,
      mode: "paper-trading",
      storage: "Deno KV",
      apiConfigured: Boolean(Deno.env.get("BOT_API_KEY"))
    });
  }

  return Response.json({
    message: "بۆتی تاقیکردنەوەی Solana کار دەکات",
    mode: "paper-trading"
  });
});
