export function parseRpcResponse(payload, expectedId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.id !== expectedId) {
    throw new Error("RPC response missing a valid id");
  }
  if (payload.jsonrpc !== "2.0") {
    throw new Error("RPC response has an invalid JSON-RPC version");
  }
  if (payload.error) throw new Error(payload.error.message || "RPC error");
  if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
    throw new Error("RPC response missing a result");
  }
  return payload.result;
}

export function parseRpcBatchResponse(payload, count) {
  if (!Array.isArray(payload) || payload.length !== count) {
    throw new Error("RPC batch response invalid or incomplete");
  }
  const byId = new Map();
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !Number.isSafeInteger(item.id) || byId.has(item.id)) {
      throw new Error("RPC batch item missing, duplicated, or malformed");
    }
    if (item.jsonrpc !== "2.0") {
      throw new Error("RPC batch item has an invalid JSON-RPC version");
    }
    if (item.error) throw new Error(item.error.message || "RPC batch error");
    if (!Object.prototype.hasOwnProperty.call(item, "result")) {
      throw new Error("RPC batch item missing, duplicated, or malformed");
    }
    byId.set(item.id, item.result);
  }
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    if (!byId.has(id)) throw new Error("RPC batch item missing");
    return byId.get(id);
  });
}


export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function readBoundedJsonResponse(response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
  if (!response || !response.body || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Provider response is missing a readable body or valid size limit");
  }
  const declaredLength = response.headers?.get?.("Content-Length");
  if (declaredLength != null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes) {
      throw new Error("Provider response exceeds the " + maxBytes + "-byte limit");
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel("Provider response size limit exceeded"); } catch {}
        throw new Error("Provider response exceeds the " + maxBytes + "-byte limit");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Provider response is not valid UTF-8");
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("Provider response contains invalid JSON");
  }
}
