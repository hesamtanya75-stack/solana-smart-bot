import { parseRpcResponse, readBoundedJsonResponse } from "./rpc-response.mjs";

const MAX_SIMULATION_RESPONSE_BYTES = 2 * 1024 * 1024;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > 4 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Simulation request transaction encoding is malformed");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function deepFreezeJson(value) {
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        pending.push(descriptor.value);
      }
    }
    Object.freeze(current);
  }
  return value;
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle?.digest) {
    throw new Error("WebCrypto SHA-256 is unavailable; simulation transport blocked");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function snapshotArguments(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error("Simulation transport input must be a plain data record");
  }
  const allowed = ["request", "endpoint", "fetchImpl"];
  const values = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new Error("Simulation transport input contains unsupported properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error("Simulation transport input contains accessor-backed properties");
    }
    values[key] = descriptor.value;
  }
  if (!Object.hasOwn(values, "request") || !Object.hasOwn(values, "endpoint")) {
    throw new Error("Simulation transport input is missing required fields");
  }
  return values;
}

/**
 * Send a previously built simulateTransaction request and bind the bounded
 * JSON-RPC response to its request id and sanitized endpoint identity.
 * This records RPC observations only; it does not attest future execution,
 * semantic CPI effects, signing, or transaction submission.
 */
export async function performReadOnlySimulation(input) {
  const args = snapshotArguments(input);
  let { request, endpoint, fetchImpl = fetch } = args;
  if (!request || typeof request !== "object" || Object.getPrototypeOf(request) !== Object.prototype &&
      Object.getPrototypeOf(request) !== null) {
    throw new Error("A plain simulation RPC request record is required");
  }
  const expectedRequestFields = [
    "method", "endpoint", "requestId", "transactionDigest", "digestSource",
    "body", "simulationOnly", "responseIdentityVerified",
    "signingPermitted", "submissionPermitted"
  ];
  const requestKeys = Reflect.ownKeys(request);
  if (requestKeys.length !== expectedRequestFields.length ||
      requestKeys.some(key => typeof key !== "string" || !expectedRequestFields.includes(key))) {
    throw new Error("Simulation RPC request metadata is invalid");
  }
  const requestSnapshot = Object.create(null);
  for (const key of expectedRequestFields) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error("Simulation RPC request metadata must contain own data properties");
    }
    requestSnapshot[key] = descriptor.value;
  }
  request = requestSnapshot;
  if (request.method !== "POST" || request.simulationOnly !== true ||
      request.responseIdentityVerified !== false ||
      request.signingPermitted !== false || request.submissionPermitted !== false ||
      request.digestSource !== "sha256-of-exact-base64-rpc-transaction-bytes" ||
      !Number.isSafeInteger(request.requestId) || request.requestId < 1 ||
      typeof request.body !== "string" || request.body.length > 16 * 1024 ||
      typeof request.transactionDigest !== "string" || !HEX_SHA256.test(request.transactionDigest) ||
      typeof request.endpoint !== "string") {
    throw new Error("Simulation RPC request metadata is invalid");
  }
  if (typeof endpoint !== "string" || endpoint.length > 2048 ||
      typeof fetchImpl !== "function") {
    throw new Error("Simulation RPC endpoint or transport is invalid");
  }
  let url;
  try { url = new URL(endpoint); } catch {
    throw new Error("Simulation RPC endpoint is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.origin + url.pathname !== request.endpoint) {
    throw new Error("Simulation RPC endpoint identity does not match the immutable request");
  }

  let envelope;
  try { envelope = JSON.parse(request.body); } catch {
    throw new Error("Simulation RPC request body is invalid JSON");
  }
  const expectedEnvelopeKeys = ["jsonrpc", "id", "method", "params"];
  const expectedOptionKeys = [
    "encoding", "sigVerify", "replaceRecentBlockhash",
    "innerInstructions", "innerInstructionsEncoding", "commitment"
  ];
  const optionKeys = envelope?.params?.[1] && typeof envelope.params[1] === "object" &&
    !Array.isArray(envelope.params[1]) ? Object.keys(envelope.params[1]) : [];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      Object.keys(envelope).length !== expectedEnvelopeKeys.length ||
      Object.keys(envelope).some(key => !expectedEnvelopeKeys.includes(key)) ||
      envelope.jsonrpc !== "2.0" ||
      envelope.id !== request.requestId ||
      envelope.method !== "simulateTransaction" ||
      !Array.isArray(envelope.params) || envelope.params.length !== 2 ||
      typeof envelope.params[0] !== "string" ||
      optionKeys.length !== expectedOptionKeys.length ||
      optionKeys.some(key => !expectedOptionKeys.includes(key)) ||
      envelope.params[1].encoding !== "base64" ||
      envelope.params[1].sigVerify !== false ||
      envelope.params[1].replaceRecentBlockhash !== true ||
      envelope.params[1].innerInstructions !== true ||
      envelope.params[1].innerInstructionsEncoding !== "json" ||
      envelope.params[1].commitment !== "confirmed") {
    throw new Error("Simulation RPC request envelope failed validation");
  }

  const transactionBytes = decodeBase64(envelope.params[0]);
  if (transactionBytes.byteLength < 1 || transactionBytes.byteLength > 1232 ||
      await sha256(transactionBytes) !== request.transactionDigest) {
    throw new Error("Simulation RPC request bytes do not match the recorded transaction digest");
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: request.body,
    redirect: "error"
  });
  if (!response?.ok) {
    try { await response?.body?.cancel(); } catch {}
    throw new Error("Simulation RPC returned HTTP " + (Number.isInteger(response?.status) ? response.status : "failure"));
  }
  const payload = await readBoundedJsonResponse(response, MAX_SIMULATION_RESPONSE_BYTES);
  const result = parseRpcResponse(payload, request.requestId);
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      !result.context || typeof result.context !== "object" ||
      !Number.isSafeInteger(result.context.slot) || result.context.slot < 0) {
    throw new Error("Simulation RPC result or context slot is malformed");
  }

  deepFreezeJson(result);

  return Object.freeze({
    scope: "read-only-simulation-response",
    transactionDigest: request.transactionDigest,
    digestSource: request.digestSource,
    endpointIdentity: request.endpoint,
    requestId: request.requestId,
    contextSlot: result.context.slot,
    simulationResult: result,
    responseRequestIdMatched: true,
    requestEndpointMatched: true,
    simulationInputIdentityVerified: false,
    signingPermitted: false,
    submissionPermitted: false
  });
}
