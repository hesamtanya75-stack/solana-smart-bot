import test from "node:test";
import assert from "node:assert/strict";
import { parseLiveOrderEvidenceRequest } from "../live-order-evidence-request.js";

const request = {
  idempotencyKey: "safe-order-key-123456",
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amountAtomic: "12000000"
};
const raw = JSON.stringify(request);
const parse = overrides => parseLiveOrderEvidenceRequest({
  rawBody: raw, contentType: "application/json", contentLength: String(new TextEncoder().encode(raw).length),
  ...overrides
});

test("parses strict JSON allowlist and permits missing Content-Length", () => {
  assert.deepEqual(parse(), request);
  assert.deepEqual(parse({ contentLength: null }), request);
});

test("rejects incorrect content type, malformed length, and mismatched length", () => {
  assert.throws(() => parse({ contentType: "text/plain" }), e => e.status === 415);
  assert.throws(() => parse({ contentLength: "chunked" }), e => e.status === 400);
  assert.throws(() => parse({ contentLength: "2" }), e => e.status === 400);
});

test("rejects oversized actual UTF-8 body even without a length header", () => {
  assert.throws(() => parseLiveOrderEvidenceRequest({
    rawBody: " ".repeat(2049), contentType: "application/json", contentLength: null
  }), e => e.status === 413);
});

test("rejects malformed JSON, arrays, and unexpected fields", () => {
  for (const rawBody of ["{", "[]", JSON.stringify({ ...request, secret: "should-not-be-accepted" })]) {
    assert.throws(() => parseLiveOrderEvidenceRequest({
      rawBody, contentType: "application/json", contentLength: null
    }), e => e.status === 400);
  }
});
