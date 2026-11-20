import { normalizeSimulationObservation } from "./simulation-observation.mjs";
import { normalizeSimulationBalanceObservation } from "./simulation-balance-observation.mjs";

const HEX_SHA256 = /^[a-f0-9]{64}$/;

/**
 * Build CPI and balance diagnostics from one read-only RPC response envelope.
 *
 * This binds the two local observations to the same captured response, request
 * metadata and context slot. It does NOT prove that the remote RPC executed the
 * supplied transaction bytes, authenticate the provider, or authorize execution.
 */
export function normalizeBoundSimulationDiagnostics(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error("Bound simulation diagnostics input must be a plain record");
  }
  const allowedInput = ["response", "messageDigest", "topLevelInstructionCount", "accountKeyCount"];
  const args = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedInput.includes(key)) {
      throw new Error("Bound simulation diagnostics input contains unsupported properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error("Bound simulation diagnostics input contains accessor-backed properties");
    }
    args[key] = descriptor.value;
  }
  if (!Object.hasOwn(args, "response") || !Object.hasOwn(args, "messageDigest") ||
      !Object.hasOwn(args, "topLevelInstructionCount") || !Object.hasOwn(args, "accountKeyCount")) {
    throw new Error("Bound simulation diagnostics input is incomplete");
  }

  const response = args.response;
  if (!response || typeof response !== "object" || Array.isArray(response) ||
      (Object.getPrototypeOf(response) !== Object.prototype && Object.getPrototypeOf(response) !== null)) {
    throw new Error("A read-only simulation response envelope is required");
  }
  const allowedResponse = [
    "scope", "transactionDigest", "digestSource", "endpointIdentity", "requestId",
    "contextSlot", "simulationResult", "responseRequestIdMatched", "requestEndpointMatched",
    "simulationInputIdentityVerified", "signingPermitted", "submissionPermitted"
  ];
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(response)) {
    if (typeof key !== "string" || !allowedResponse.includes(key)) {
      throw new Error("Simulation response envelope contains unsupported properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(response, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error("Simulation response envelope contains accessor-backed properties");
    }
    snapshot[key] = descriptor.value;
  }

  if (Reflect.ownKeys(snapshot).length !== allowedResponse.length ||
      snapshot.scope !== "read-only-simulation-response" ||
      typeof snapshot.transactionDigest !== "string" || !HEX_SHA256.test(snapshot.transactionDigest) ||
      snapshot.digestSource !== "sha256-of-exact-base64-rpc-transaction-bytes" ||
      typeof snapshot.endpointIdentity !== "string" ||
      !/^https:\/\//.test(snapshot.endpointIdentity) ||
      !Number.isSafeInteger(snapshot.requestId) || snapshot.requestId < 1 ||
      !Number.isSafeInteger(snapshot.contextSlot) || snapshot.contextSlot < 0 ||
      snapshot.responseRequestIdMatched !== true ||
      snapshot.requestEndpointMatched !== true ||
      snapshot.simulationInputIdentityVerified !== false ||
      snapshot.signingPermitted !== false || snapshot.submissionPermitted !== false) {
    throw new Error("Simulation response envelope failed provenance validation");
  }
  if (typeof args.messageDigest !== "string" || !HEX_SHA256.test(args.messageDigest)) {
    throw new Error("A canonical SHA-256 message digest is required for diagnostic labeling");
  }
  if (!Number.isInteger(args.topLevelInstructionCount) || args.topLevelInstructionCount < 1 ||
      args.topLevelInstructionCount > 256 ||
      !Number.isInteger(args.accountKeyCount) || args.accountKeyCount < 1 ||
      args.accountKeyCount > 256) {
    throw new Error("Simulation message bounds are invalid");
  }
  const result = snapshot.simulationResult;
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      !result.context || result.context.slot !== snapshot.contextSlot) {
    throw new Error("Simulation response context slot does not match its envelope");
  }

  const cpiObservation = normalizeSimulationObservation({
    messageDigest: args.messageDigest,
    simulationResult: result,
    topLevelInstructionCount: args.topLevelInstructionCount,
    accountKeyCount: args.accountKeyCount
  });
  const balanceObservation = normalizeSimulationBalanceObservation({
    simulationResult: result,
    accountKeyCount: args.accountKeyCount
  });
  if (cpiObservation.contextSlot !== snapshot.contextSlot ||
      balanceObservation.contextSlot !== snapshot.contextSlot ||
      cpiObservation.simulationSucceeded !== balanceObservation.simulationSucceeded) {
    throw new Error("CPI and balance diagnostics do not describe the same simulation context");
  }

  return Object.freeze({
    scope: "same-response-diagnostic-bundle",
    transactionDigest: snapshot.transactionDigest,
    messageDigest: args.messageDigest,
    endpointIdentity: snapshot.endpointIdentity,
    requestId: snapshot.requestId,
    contextSlot: snapshot.contextSlot,
    cpiObservation,
    balanceObservation,
    simulationInputIdentityVerified: false,
    remoteSimulationIdentityVerified: false,
    cpiProgramIdsVerified: false,
    semanticInstructionVerification: false,
    tokenBalanceEffectsVerified: false,
    signingPermitted: false,
    submissionPermitted: false
  });
}
