import { isValidSolanaPublicKey } from "./solana-wallet-reconciliation.js";

/**
 * Server-only HMAC attestation for binding an order request to its evidence.
 * Call only after the Worker has independently fetched/validated quote and risk data.
 * This module does not sign or submit Solana transactions.
 */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const AMOUNT_PATTERN = /^[1-9][0-9]{0,39}$/;

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (!value || typeof value !== "object" ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Evidence must contain only plain JSON values");
  }
  const keys = Object.keys(value).sort();
  if (keys.some(key => value[key] === undefined)) throw new TypeError("Evidence contains undefined fields");
  return "{" + keys.map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}

function riskMetricsAreSafe(risk) {
  const metrics = risk?.riskSummary;
  return metrics &&
    Number.isFinite(metrics.rugScore) && metrics.rugScore >= 0 && metrics.rugScore <= 2500 &&
    Number.isFinite(metrics.largestHolderPct) && metrics.largestHolderPct >= 0 && metrics.largestHolderPct <= 30 &&
    Number.isFinite(metrics.topTenHolderPct) && metrics.topTenHolderPct >= 0 && metrics.topTenHolderPct <= 50;
}

function validateBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      !KEY_PATTERN.test(binding.idempotencyKey || "") ||
      !isValidSolanaPublicKey(binding.inputMint) ||
      !isValidSolanaPublicKey(binding.outputMint) ||
      binding.inputMint === binding.outputMint ||
      typeof binding.amountAtomic !== "string" || !AMOUNT_PATTERN.test(binding.amountAtomic)) {
    throw new TypeError("Attestation order binding is invalid");
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError("Attestation signature format is invalid");
  }
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  // Reject non-canonical Base64URL encodings (unused trailing bits must be zero).
  if (bytesToBase64Url(bytes) !== value) {
    throw new TypeError("Attestation signature encoding is not canonical");
  }
  return bytes;
}

async function importHmacKey(secret) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 4096) {
    throw new TypeError("Evidence signing secret must be configured server-side");
  }
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createOrderEvidenceAttestation({ binding, quote, risk, secret, now = Date.now(), ttlMs = 15000 }) {
  validateBinding(binding);
  if (!Number.isSafeInteger(now) || now <= 0 ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60000) {
    throw new TypeError("Attestation clock or lifetime is invalid");
  }
  if (!quote || quote.provider !== "jupiter-swap-v2" ||
      quote.inputMint !== binding.inputMint || quote.outputMint !== binding.outputMint ||
      quote.inputAmountAtomic !== binding.amountAtomic ||
      typeof quote.outputAmountAtomic !== "string" || !AMOUNT_PATTERN.test(quote.outputAmountAtomic) ||
      !Number.isSafeInteger(quote.fetchedAt) || quote.fetchedAt > now ||
      now - quote.fetchedAt > ttlMs ||
      quote.evidenceClass !== "provider-response-unverified") {
    throw new TypeError("Quote does not bind to this order or has an unsupported provenance class");
  }
  if (!risk || risk.passed !== true || risk.mint !== binding.outputMint ||
      !riskMetricsAreSafe(risk) || !Number.isSafeInteger(risk.checkedAt) || risk.checkedAt > now ||
      now - risk.checkedAt > ttlMs) {
    throw new TypeError("Risk evidence is missing, failed, or stale");
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new TypeError("Attestation expiry overflow");
  const payload = { version: 1, issuedAt: now, expiresAt, binding: { ...binding }, quote: { ...quote }, risk: { ...risk } };
  const encoded = new TextEncoder().encode(canonical(payload));
  const signature = await crypto.subtle.sign("HMAC", await importHmacKey(secret), encoded);
  return Object.freeze({ payload, signature: bytesToBase64Url(new Uint8Array(signature)) });
}

export async function verifyOrderEvidenceAttestation({ attestation, expectedBinding, secret, now = Date.now() }) {
  try {
    validateBinding(expectedBinding);
    if (!attestation || typeof attestation !== "object" || !attestation.payload ||
        !Number.isSafeInteger(now) || now <= 0) return { ok: false, reason: "Attestation is malformed" };
    const payload = attestation.payload;
    if (payload.version !== 1 || !Number.isSafeInteger(payload.issuedAt) ||
        !Number.isSafeInteger(payload.expiresAt) || payload.issuedAt > now ||
        payload.expiresAt <= now || payload.expiresAt - payload.issuedAt > 60000) {
      return { ok: false, reason: "Attestation is expired or has invalid timestamps" };
    }
    if (canonical(payload.binding) !== canonical(expectedBinding)) {
      return { ok: false, reason: "Attestation does not match the requested order" };
    }
    const valid = await crypto.subtle.verify("HMAC", await importHmacKey(secret),
      base64UrlToBytes(attestation.signature), new TextEncoder().encode(canonical(payload)));
    if (!valid) return { ok: false, reason: "Attestation signature is invalid" };
    if (!payload.risk || payload.risk.passed !== true || payload.risk.mint !== expectedBinding.outputMint ||
        !riskMetricsAreSafe(payload.risk)) {
      return { ok: false, reason: "Attested risk metrics are missing or unsafe" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "Attestation verification failed closed" };
  }
}
