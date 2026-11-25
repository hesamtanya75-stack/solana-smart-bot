const MAX_BODY_BYTES = 2048;
const ALLOWED_FIELDS = new Set(["idempotencyKey", "inputMint", "outputMint", "amountAtomic"]);

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function parseLiveOrderEvidenceRequest({ rawBody, contentType, contentLength }) {
  if (typeof rawBody !== "string") throw badRequest("Evidence body is invalid");
  if (!/^application\/json(?:\s*;|$)/i.test(contentType || "")) {
    throw badRequest("Evidence request must use application/json", 415);
  }
  const actualBytes = new TextEncoder().encode(rawBody).byteLength;
  if (actualBytes > MAX_BODY_BYTES) throw badRequest("Evidence request is too large", 413);
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^\d+$/.test(String(contentLength)) || Number(contentLength) !== actualBytes) {
      throw badRequest("Evidence Content-Length is malformed or mismatched", 400);
    }
  }
  let body;
  try { body = JSON.parse(rawBody); }
  catch { throw badRequest("Evidence request JSON is malformed"); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !ALLOWED_FIELDS.has(key))) {
    throw badRequest("Invalid evidence request fields");
  }
  return Object.freeze({
    idempotencyKey: body.idempotencyKey,
    inputMint: body.inputMint,
    outputMint: body.outputMint,
    amountAtomic: body.amountAtomic
  });
}
