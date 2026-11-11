import { PublicKey } from "@solana/web3.js";
import { inspectUpgradeableProgramAccounts } from "../solana-upgradeable-program.mjs";

const PROGRAM_ID = "SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ";
const LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";
const endpoint = process.env.SOLANA_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";

function assertHttpsEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Mainnet RPC URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Mainnet RPC endpoint must be HTTPS and must not contain credentials or a fragment");
  }
  return url.href;
}

async function readBoundedText(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxBytes)) {
    throw new Error("HTTP response exceeds configured size limit");
  }
  if (!response.body) throw new Error("HTTP response body is unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("HTTP response exceeds configured size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function rpcGetMultipleAccounts(pubkeys, minContextSlot = 0) {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [pubkeys, { encoding: "base64", commitment: "finalized", minContextSlot }]
    })
  });
  if (!response.ok) throw new Error("Mainnet RPC HTTP status " + response.status);
  const body = await readBoundedText(response, 2_000_000);
  let json;
  try { json = JSON.parse(body); } catch { throw new Error("Mainnet RPC returned invalid JSON"); }
  if (json.error || !json.result || !json.result.context ||
      !Number.isSafeInteger(json.result.context.slot) ||
      json.result.context.slot < minContextSlot ||
      !Array.isArray(json.result.value) || json.result.value.length !== pubkeys.length) {
    throw new Error("Mainnet RPC account response is incomplete, stale, or contains an RPC error");
  }
  const values = json.result.value.map((account) => {
    if (account === null) return null;
    if (!account || typeof account.owner !== "string" ||
        typeof account.executable !== "boolean" ||
        !Array.isArray(account.data) || account.data.length !== 2 ||
        account.data[1] !== "base64" || typeof account.data[0] !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(account.data[0])) {
      throw new Error("Mainnet RPC returned malformed account metadata");
    }
    const data = Buffer.from(account.data[0], "base64");
    if (data.toString("base64") !== account.data[0] || data.length > 1_000_000) {
      throw new Error("Mainnet RPC account data is malformed or too large");
    }
    return {
      owner: new PublicKey(account.owner),
      executable: account.executable,
      data
    };
  });
  return { slot: json.result.context.slot, values };
}

async function main() {
  const rpcUrl = assertHttpsEndpoint(endpoint);
  const first = await rpcGetMultipleAccounts([PROGRAM_ID]);
  const program = first.values[0];
  if (!program || program.owner.toBase58() !== LOADER_ID ||
      program.executable !== true || program.data.length !== 36 ||
      program.data.readUInt32LE(0) !== 2) {
    throw new Error("Saber Mainnet Program account is not a valid upgradeable-loader Program");
  }
  const programDataAddress = new PublicKey(program.data.subarray(4, 36)).toBase58();
  const snapshot = await rpcGetMultipleAccounts([PROGRAM_ID, programDataAddress], first.slot);
  if (snapshot.values[0]?.data?.length !== 36 ||
      snapshot.values[0].data.readUInt32LE(0) !== 2 ||
      new PublicKey(snapshot.values[0].data.subarray(4, 36)).toBase58() !== programDataAddress) {
    throw new Error("Saber ProgramData pointer changed during the Mainnet snapshot");
  }
  const result = inspectUpgradeableProgramAccounts({
    programId: PROGRAM_ID,
    programAccount: snapshot.values[0],
    programDataAccount: snapshot.values[1]
  });
  let verificationService = { available: false };
  try {
    const verifyResponse = await fetch(
      "https://verify.osec.io/status/" + PROGRAM_ID,
      { redirect: "error", signal: AbortSignal.timeout(12_000) }
    );
    const text = await readBoundedText(verifyResponse, 200_000);
    {
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { raw: text.slice(0, 1000) }; }
      verificationService = {
        available: verifyResponse.ok,
        httpStatus: verifyResponse.status,
        payload
      };
    } else {
      verificationService = { available: false, reason: "verification response exceeded size limit" };
    }
  } catch (error) {
    verificationService = { available: false, reason: String(error).slice(0, 300) };
  }
  process.stdout.write(JSON.stringify({
    network: "mainnet-beta",
    rpcEndpoint: rpcUrl,
    contextSlot: snapshot.slot,
    program: result,
    verificationService,
    note: "The raw ELF SHA-256 is diagnostic only. Use solana-verify canonical hash and reproducible source build to establish source-to-binary equivalence. This script is read-only and does not sign or submit transactions."
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write("Saber Mainnet audit failed closed: " + String(error) + "\n");
  process.exitCode = 1;
});
