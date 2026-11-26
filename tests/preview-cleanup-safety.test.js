import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const reportWorkflowPath = new URL("../.github/workflows/cloudflare-closed-preview-cleanup.yml", import.meta.url);
const previewWorkflowPath = new URL("../.github/workflows/cloudflare-preview.yml", import.meta.url);

test("closed-preview cleanup remains report-only and has no Cloudflare deletion credentials", async () => {
  const workflow = await readFile(reportWorkflowPath, "utf8");
  assert.match(workflow, /REPORT ONLY: no Cloudflare resources or namespaces will be deleted/i);
  assert.doesNotMatch(workflow, /wrangler[^\n]*\bpreview\s+delete/i);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflow, /pulls\?state=closed/i);
  assert.match(workflow, /pulls\?state=open/i);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read\s*\n\s*pull-requests:\s*read/i);
  assert.doesNotMatch(workflow, /wrangler[^\n]*\bdeploy\s+(?!--dry-run)/i);
});

test("closed-PR Preview cleanup workflow is report-only", async () => {
  const workflow = await readFile(previewWorkflowPath, "utf8");
  assert.match(workflow, /REPORT ONLY: no Preview deployment or Durable Object namespace was deleted/i);
  assert.doesNotMatch(workflow, /wrangler[^\n]*\bpreview\s+delete/i);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(workflow, /wrangler[^\n]*\bdeploy\s+(?!--dry-run)/i);
});
