import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const reportWorkflowPath = new URL("../.github/workflows/cloudflare-closed-preview-cleanup.yml", import.meta.url);
const previewWorkflowPath = new URL("../.github/workflows/cloudflare-preview.yml", import.meta.url);

test("closed-preview report workflow remains read-only and preserves Cloudflare state", async () => {
  const workflow = await readFile(reportWorkflowPath, "utf8");

  assert.match(workflow, /SAFE MODE/i);
  assert.match(workflow, /No API deletion issued/i);
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

test("actual Preview deletion is opt-in and limited to a closed PR Preview alias", async () => {
  const workflow = await readFile(previewWorkflowPath, "utf8");

  assert.match(workflow, /vars\.CLOUDFLARE_PREVIEW_ENABLED\s*==\s*'true'/);
  assert.match(workflow, /github\.event\.action\s*==\s*'closed'/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/);
  assert.match(workflow, /state.*!=.*closed/i);
  assert.match(workflow, /preview_name="pr-\$\{\{ github\.event\.pull_request\.number \}\}"/);
  assert.match(workflow, /wrangler@4\.135\.0\s+preview\s+delete\s+--name\s+"\$preview_name"/);
  assert.doesNotMatch(workflow, /wrangler[^\n]*\bdeploy\s+(?!--dry-run)/i);
});
