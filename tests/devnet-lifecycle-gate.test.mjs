import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const workflow = readFileSync(
  new URL("../.github/workflows/devnet-preflight.yml", import.meta.url),
  "utf8"
);

function getStep(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow step not found: ${name}`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test("funded Devnet lifecycle is manual-dispatch only and exposes no ephemeral secret", () => {
  const manualWorkflow = readFileSync(
    new URL("../.github/workflows/devnet-manual-lifecycle.yml", import.meta.url),
    "utf8"
  );
  assert.match(manualWorkflow, /workflow_dispatch:/);
  assert.match(manualWorkflow, /confirmation:/);
  assert.match(manualWorkflow, /inputs\\.confirmation == 'DEVNET_ONLY'/);
  assert.match(manualWorkflow, /name: Verify ephemeral signing and submit a manually funded Devnet test transfer/);
  assert.match(manualWorkflow, /node scripts\\/devnet-signed-lifecycle\\.mjs/);
  assert.match(manualWorkflow, /DEVNET_MANUAL_FUNDING: '1'/);
  assert.match(manualWorkflow, /inputs\\.confirmation != 'DEVNET_ONLY'/);
  assert.match(manualWorkflow, /No signing or transaction submission was attempted/);

  const script = readFileSync(
    new URL("../scripts/devnet-signed-lifecycle.mjs", import.meta.url),
    "utf8"
  );
  assert.ok(script.includes("DEVNET_MANUAL_FUNDING_ADDRESS="));
  assert.ok(script.includes("Date.now() + 8 * 60 * 1000"));
  assert.ok(script.includes('connection.getBalance(payer.publicKey, "confirmed")'));
  assert.ok(script.includes("userPrivateKeysUsed: false"));
  assert.doesNotMatch(script, /console\\.log\\([^\\n]*(?:secretKey|secret key|private key)/i);
});
test("Devnet preflight retries transient network failures without exposing the RPC URL", async () => {
  const script = readFileSync(
    new URL("../scripts/devnet-preflight.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /catch \(error\)[\s\S]*networkFailures\.push[\s\S]*network request failed for all Devnet RPC endpoints after retries/);
  assert.match(script, /AbortSignal\.timeout\(15000\)/);
  assert.match(script, /mismatched JSON-RPC envelope/);
  assert.match(script, /payload\.jsonrpc !== "2\.0" \|\| payload\.id !== 1/);
  assert.doesNotMatch(script, /console\.(?:log|error)\([^\n]*DEVNET_RPC/);
});

test("Devnet airdrop confirmation uses its signature and never repeats a submitted request", () => {
  const script = readFileSync(
    new URL("../scripts/devnet-signed-lifecycle.mjs", import.meta.url),
    "utf8"
  );
  const helperStart = script.indexOf("async function requestDevnetAirdrop");
  const helperEnd = script.indexOf("\nasync function main()", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = script.slice(helperStart, helperEnd);
  assert.match(helper, /signature = await connection\.requestAirdrop/);
  assert.match(helper, /connection\.confirmTransaction\(signature, "confirmed"\)/);
  assert.doesNotMatch(helper, /getLatestBlockhash/);
  assert.match(helper, /Retry only the faucet request itself/);
  assert.match(helper, /if \(!signature\)/);
});

test("Devnet RPC retryable HTTP responses honor bounded Retry-After and release the body", () => {
  const script = readFileSync(
    new URL("../scripts/devnet-preflight.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /function retryDelayMs\(response, attempt\)/);
  assert.match(script, /Math\.min\(dateDelay, 10_000\)/);
  assert.match(script, /response\.body\?\.cancel\(\)/);
  assert.match(script, /setTimeout\(resolve, retryDelayMs\(response, attempt\)\)/);
});

test("funded Devnet lifecycle verifies the finalized transaction's recipient balance delta", () => {
  const script = readFileSync(
    new URL("../scripts/devnet-signed-lifecycle.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /transactionInfo\.transaction\?\.message/);
  assert.match(script, /transactionInfo\.meta\?\.preBalances/);
  assert.match(script, /transactionInfo\.meta\?\.postBalances/);
  assert.match(script, /transactionSignatures\[0\] !== signature/);
  assert.match(script, /payer\.publicKey\.toBase58\(\)/);
  assert.match(script, /postBalances\[recipientIndex\] - preBalances\[recipientIndex\] < TRANSFER_LAMPORTS/);
});

test("funded Devnet lifecycle verifies cluster identity before creating signers", () => {
  const script = readFileSync(
    new URL("../scripts/devnet-signed-lifecycle.mjs", import.meta.url),
    "utf8"
  );
  const mainStart = script.indexOf("async function main()");
  assert.notEqual(mainStart, -1);
  const main = script.slice(mainStart);
  const genesisCheck = main.indexOf("candidateGenesis !== EXPECTED_DEVNET_GENESIS");
  const payerCreation = main.indexOf("const payer = Keypair.generate()");
  const recipientCreation = main.indexOf("const recipient = Keypair.generate()");
  assert.notEqual(genesisCheck, -1);
  assert.ok(payerCreation > genesisCheck, "payer must not be created before Devnet identity is checked");
  assert.ok(recipientCreation > genesisCheck, "recipient must not be created before Devnet identity is checked");
  assert.match(main, /Refusing to sign: RPC is not official Solana Devnet/);
  assert.match(main, /error\?\.name !== "TypeError"/);
});


test("Devnet preflight falls back only to the official Devnet RPC after network failures", () => {
  const script = readFileSync(
    new URL("../scripts/devnet-preflight.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /configuredDevnetRpc/);
  assert.match(script, /"https:\/\/api\.devnet\.solana\.com"/);
  assert.match(script, /new Set\(\[/);
  assert.match(script, /if \(endpointFailed\) continue/);
  assert.match(script, /EXPECTED_DEVNET_GENESIS/);
  assert.doesNotMatch(script, /api\.mainnet-beta\.solana\.com/);
});


test("signed Devnet lifecycle uses only a configured endpoint or official Devnet fallback", () => {
  const script = readFileSync(
    new URL("../scripts/devnet-signed-lifecycle.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /"https:\/\/api\.devnet\.solana\.com"/);
  assert.match(script, /new Set\(\[/);
  assert.match(script, /candidateGenesis !== EXPECTED_DEVNET_GENESIS/);
  assert.doesNotMatch(script, /api\.mainnet-beta\.solana\.com/);
});


test("Devnet scripts ignore malformed or insecure configured RPC URLs without exposing them", () => {
  for (const path of ["../scripts/devnet-preflight.mjs", "../scripts/devnet-signed-lifecycle.mjs"]) {
    const script = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(script, /function isSecureDevnetRpcEndpoint\(value\)/);
    assert.match(script, /parsed\.protocol === "https:"/);
    assert.match(script, /!parsed\.username && !parsed\.password/);
    assert.match(script, /filter\(value => value && isSecureDevnetRpcEndpoint\(value\)\)/);
    assert.match(script, /"https:\/\/api\.devnet\.solana\.com"/);
  }
});
