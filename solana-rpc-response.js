/**
 * Strict JSON-RPC response validation shared by batched and fallback requests.
 * Reject mismatched IDs, malformed envelopes, duplicate/missing batch items,
 * and provider errors before results are used by risk inspection.
 */
export function parseRpcSingleResponse(item, expectedId) {
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      item.jsonrpc !== "2.0" || item.id !== expectedId || item.error ||
      !Object.prototype.hasOwnProperty.call(item, "result")) {
    throw new Error("RPC single response envelope invalid");
  }
  return item.result;
}

export function parseRpcBatchResponse(data, expectedCount) {
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error("RPC batch response invalid");
  }
  const byId = new Map();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        item.jsonrpc !== "2.0" || !Number.isInteger(item.id) ||
        item.id < 1 || item.id > expectedCount || byId.has(item.id) ||
        item.error || !Object.prototype.hasOwnProperty.call(item, "result")) {
      throw new Error("RPC batch response envelope invalid");
    }
    byId.set(item.id, item);
  }
  if (byId.size !== expectedCount) throw new Error("RPC batch response IDs incomplete");
  return Array.from({ length: expectedCount }, (_, index) => byId.get(index + 1).result);
}
