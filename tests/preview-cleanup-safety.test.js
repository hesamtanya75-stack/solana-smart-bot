import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowPath = new URL("../.github/workflows/cloudflare-closed-preview-cleanup.yml", import.meta.url);

test("closed-preview workflow remains report-only and preserves Cloudflare state", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /SAFE MODE/i, "workflow must announce safe mode");
  assert.match(workflow, /No API deletion issued/i, "candidate report must explicitly state no deletion");

  // This workflow must never acquire credentials or issue resource-deletion commands.
  assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/i);
  assert.doesNotMatch(workflow, /wrangler(?:@[^\s]+)?\s+preview\s+delete/i);
  assert.doesNotMatch(workflow, /gh\s+api[^\n]*(?:--method|-X)\s*DELETE/i);
  assert.doesNotMatch(workflow, /(?:--method|-X)\s*DELETE[^\n]*/i);
  assert.doesNotMatch(workflow, /cloudflare[^\n]*(?:api[_ -]?token|account[_ -]?id)/i);
  assert.doesNotMatch(workflow, /\b(?:curl|gh)\s+[^\n]*\s-X\s*DELETE\b/i);
  assert.doesNotMatch(workflow, /cloudflare[^\n]*(?:delete|destroy)|(?:delete|destroy)[^\n]*cloudflare/i);

  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read\s*\n\s*pull-requests:\s*read/i);
  assert.doesNotMatch(workflow, /contents:\s*write|pull-requests:\s*write/i);
});
