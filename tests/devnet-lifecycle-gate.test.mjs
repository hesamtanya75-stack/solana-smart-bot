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
