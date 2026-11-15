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

test("funded Devnet lifecycle requires a dedicated RPC and is explicitly skipped otherwise", () => {
  const fundedStep = getStep("Verify ephemeral signing and submit a faucet-funded Devnet test transfer");
  assert.match(fundedStep, /if:\s*\$\{\{\s*env\.DEVNET_RPC_URL\s*!=\s*''\s*\}\}/);
  assert.match(fundedStep, /node scripts\/devnet-signed-lifecycle\.mjs/);

  const skippedStep = getStep("Report funded Devnet lifecycle as skipped without a dedicated RPC");
  assert.match(skippedStep, /if:\s*\$\{\{\s*env\.DEVNET_RPC_URL\s*==\s*''\s*\}\}/);
  assert.match(skippedStep, /status: "skipped"/);
  assert.match(skippedStep, /signing: "not performed"/);
  assert.match(skippedStep, /transactionsSubmitted: 0/);
  assert.doesNotMatch(skippedStep, /`DEVNET_RPC_URL`/);
});

test("Devnet preflight retries transient network failures without exposing the RPC URL", async () => {
  const script = readFileSync(
    new URL("../scripts/devnet-preflight.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /catch \(error\)[\s\S]*network request failed after 4 attempts/);
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
