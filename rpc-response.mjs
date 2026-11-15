export function parseRpcResponse(payload, expectedId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.id !== expectedId || !Object.prototype.hasOwnProperty.call(payload, "result")) {
    throw new Error("RPC response missing a valid id or result");
  }
  if (payload.error) throw new Error(payload.error.message || "RPC error");
  return payload.result;
}

export function parseRpcBatchResponse(payload, count) {
  if (!Array.isArray(payload) || payload.length !== count) {
    throw new Error("RPC batch response invalid or incomplete");
  }
  const byId = new Map();
  for (const item of payload) {
    if (!item || typeof item !== "object" || !Number.isSafeInteger(item.id) ||
        byId.has(item.id) || !Object.prototype.hasOwnProperty.call(item, "result")) {
      throw new Error("RPC batch item missing, duplicated, or malformed");
    }
    if (item.error) throw new Error(item.error.message || "RPC batch error");
    byId.set(item.id, item.result);
  }
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    if (!byId.has(id)) throw new Error("RPC batch item missing");
    return byId.get(id);
  });
}
