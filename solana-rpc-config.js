const PUBLIC_RPC_ENDPOINTS = [
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com"
];

function isPublicHttpsRpc(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") ||
        host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") ||
        host.endsWith(".test") || host.endsWith(".invalid")) return false;
    // RPC providers use HTTPS/443. Reject custom ports and literal IP hosts so
    // a misconfigured secret cannot turn the Worker into a private-network proxy.
    if (url.port || /^\d+(?:\.\d+){3}$/.test(host) || host.startsWith("[") || host.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}

export function resolveSolanaRpcEndpoints(env = {}) {
  const endpoints = [];
  const errors = [];
  const custom = String(env.SOLANA_RPC_URL || "").trim();

  if (custom) {
    if (isPublicHttpsRpc(custom)) {
      endpoints.push({ url: custom, label: "Configured Solana RPC", fallback: false });
    } else {
      errors.push("SOLANA_RPC_URL invalid: provide a public HTTPS RPC endpoint on port 443 without URL credentials");
    }
  }

  const alchemyConfig = String(env.ALCHEMY_API_KEY || "").trim();
  if (alchemyConfig) {
    const url = /^https:\/\//i.test(alchemyConfig)
      ? alchemyConfig.replace(/\/+$/, "")
      : "https://solana-mainnet.g.alchemy.com/v2/" + alchemyConfig;
    let valid = false;
    try {
      const parsed = new URL(url);
      valid = parsed.protocol === "https:" &&
        parsed.hostname === "solana-mainnet.g.alchemy.com" &&
        parsed.pathname.startsWith("/v2/") &&
        parsed.pathname.length > 4;
    } catch {}
    if (valid) {
      endpoints.push({ url, label: "Alchemy Solana RPC", fallback: false });
    } else {
      errors.push("ALCHEMY_API_KEY invalid: expected a Solana Mainnet key or Alchemy HTTPS endpoint");
    }
  }

  for (const url of PUBLIC_RPC_ENDPOINTS) {
    endpoints.push({ url, label: new URL(url).hostname, fallback: true });
  }

  const unique = [];
  const seen = new Set();
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.url)) continue;
    seen.add(endpoint.url);
    unique.push(endpoint);
  }
  return { endpoints: unique, errors };
}
