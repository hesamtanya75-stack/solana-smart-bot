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

test("funded Devnet lifecycle is isolated to an explicit manual job and never receives a public-RPC fallback", () => {
  assert.match(workflow, /workflow_dispatch:[\s\S]*run_funded_devnet_lifecycle:[\s\S]*default: false/);
  const readOnlyJob = workflow.slice(workflow.indexOf("  devnet-read-only:"), workflow.indexOf("  funded-devnet-lifecycle:"));
  const fundedJob = workflow.slice(workflow.indexOf("  funded-devnet-lifecycle:"));

  assert.match(readOnlyJob, /DEVNET_RPC_URL:\s*\$\{\{\s*secrets\.DEVNET_RPC_URL\s*\}\}/);
  assert.match(readOnlyJob, /ALCHEMY_API_KEY:\s*\$\{\{\s*secrets\.ALCHEMY_API_KEY\s*\}\}/);
  assert.doesNotMatch(readOnlyJob, /https:\/\/api\.devnet\.solana\.com/);
  assert.match(fundedJob, /if:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*github\.ref\s*==\s*'refs\/heads\/security\/pr33-safety-transplant-4678a20'\s*&&\s*inputs\.run_funded_devnet_lifecycle\s*==\s*true\s*\}\}/);
  assert.match(fundedJob, /environment:\s*devnet-funded/);
  assert.doesNotMatch(fundedJob, /^\s{4}env:\s*\n\s{6}DEVNET_RPC_URL:/m);
  const fundedTransferStep = getStep("Verify dedicated RPC and submit faucet-funded Devnet test transfer");
  assert.match(fundedTransferStep, /env:\s*\n\s{10}DEVNET_RPC_URL:\s*\$\{\{\s*secrets\.DEVNET_RPC_URL\s*\}\}/);
  assert.match(fundedTransferStep, /node scripts\/devnet-signed-lifecycle\.mjs/);

  const skippedStep = getStep("Report funded Devnet lifecycle as skipped without explicit opt-in");
  assert.match(skippedStep, /status: "skipped"/);
  assert.match(skippedStep, /signing: "not performed"/);
  assert.match(skippedStep, /transactionsSubmitted: 0/);
  assert.match(skippedStep, /explicit workflow_dispatch opt-in is required/);

  const script = readFileSync(
    new URL("../scripts/devnet-signed-lifecycle.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /DEVNET_RPC_URL is required for funded Devnet lifecycle/);
  assert.doesNotMatch(script, /process\.env\.DEVNET_RPC_URL\s*\|\|\s*["']https:\/\/api\.devnet\.solana\.com/);
});
test("Devnet preflight retries transient network failures without exposing the RPC URL", async () => {
  const script = readFileSync(
    new URL("../scripts/devnet-preflight.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /catch \(error\)[\s\S]*network request failed after 6 attempts/);
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
  assert.match(script, /Math\.min\(dateDelay, 30_000\)/);
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
  const genesisCheck = main.indexOf('if (genesis !== expectedGenesis)');
  const payerCreation = main.indexOf("const payer = Keypair.generate()");
  const recipientCreation = main.indexOf("const recipient = Keypair.generate()");
  assert.notEqual(genesisCheck, -1);
  assert.ok(payerCreation > genesisCheck, "payer must not be created before Devnet identity is checked");
  assert.ok(recipientCreation > genesisCheck, "recipient must not be created before Devnet identity is checked");
  assert.match(main, /Refusing to sign: RPC is not official Solana Devnet/);
});
