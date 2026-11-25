/**
 * Server-side Jupiter Swap API v2 quote fetcher.
 *
 * Quote-only: deliberately omits the taker wallet, so Jupiter returns pricing
 * data without an unsigned transaction. This module never signs or submits.
 * Its output is observation data, not authenticated risk evidence or an
 * execution authorization.
 */
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AMOUNT_PATTERN = /^[1-9][0-9]{0,39}$/;
const BASE_URL = "https://api.jup.ag/swap/v2/order";

export async function fetchJupiterQuote({
  inputMint,
  outputMint,
  amountAtomic,
  apiKey,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = 8000
}) {
  if (!MINT_PATTERN.test(inputMint || "") || !MINT_PATTERN.test(outputMint || "") ||
      inputMint === outputMint) {
    throw new TypeError("Distinct valid-looking Solana mint addresses are required");
  }
  if (typeof amountAtomic !== "string" || !AMOUNT_PATTERN.test(amountAtomic)) {
    throw new TypeError("Input amount must be a positive integer atomic-unit string");
  }
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 || timeoutMs > 30000 || !Number.isFinite(now())) {
    throw new TypeError("Quote client configuration is invalid");
  }

  const url = new URL(BASE_URL);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountAtomic);
  // No taker parameter: quote only, no transaction assembly.
  const headers = { Accept: "application/json" };
  if (apiKey) {
    if (typeof apiKey !== "string" || apiKey.length > 512 || /[\r\n]/.test(apiKey)) {
      throw new TypeError("Jupiter API key format is invalid");
    }
    headers["x-api-key"] = apiKey;
  }

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error"
    });
  } catch {
    throw new Error("Jupiter quote request failed or timed out");
  }
  if (!response || !response.ok) {
    const status = Number(response?.status);
    throw new Error("Jupiter quote service returned HTTP " +
      (Number.isInteger(status) ? status : "unknown"));
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Jupiter quote response was not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Jupiter quote response shape is invalid");
  }
  if (body.errorCode || body.errorMessage || body.transaction) {
    throw new Error("Jupiter did not return a quote-only response");
  }
  if (body.inAmount !== amountAtomic ||
      typeof body.outAmount !== "string" || !AMOUNT_PATTERN.test(body.outAmount) ||
      body.inputMint && body.inputMint !== inputMint ||
      body.outputMint && body.outputMint !== outputMint) {
    throw new Error("Jupiter quote does not match the requested mints and amount");
  }

  const fetchedAt = now();
  return Object.freeze({
    provider: "jupiter-swap-v2",
    inputMint,
    outputMint,
    inputAmountAtomic: body.inAmount,
    outputAmountAtomic: body.outAmount,
    router: typeof body.router === "string" ? body.router : null,
    requestId: typeof body.requestId === "string" ? body.requestId : null,
    feeBps: Number.isSafeInteger(body.feeBps) && body.feeBps >= 0 ? body.feeBps : null,
    priceImpactPct: typeof body.priceImpactPct === "string" ? body.priceImpactPct : null,
    fetchedAt,
    // Explicitly not a "trusted" flag; downstream must independently verify.
    evidenceClass: "provider-response-unverified"
  });
}
