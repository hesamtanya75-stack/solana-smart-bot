import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const reportWorkflowPath = new URL("../.github/workflows/cloudflare-closed-preview-cleanup.yml", import.meta.url);
const previewWorkflowPath = new URL("../.github/workflows/cloudflare-preview.yml", import.meta.url);

test("closed-preview cleanup is report-only by default and narrowly guarded when enabled", async () => {
  const workflow = await readFile(reportWorkflowPath, "utf8");

  // Manual runs must explicitly opt in; missing Cloudflare credentials must never delete.
  assert.match(workflow, /execute_cleanup:[\s\S]*default:\s*false/i);
  assert.match(workflow, /inputs\.execute_cleanup\s*==\s*true/);
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflow, /credentials are not configured; no Preview deletion will run/i);
  assert.match(workflow, /REPORT ONLY: no Cloudflare resources were deleted/i);

  // Only same-repository, closed-PR Preview aliases are eligible; open PR branches are protected.
  assert.match(workflow, /pulls\?state=closed/i);
  assert.match(workflow, /pulls\?state=open/i);
  assert.match(workflow, /\[ "\$source_repo" = "\$GITHUB_REPOSITORY" \] \|\| continue/);
  assert.match(workflow, /grep -Fxq "\$source_repo \$branch"/);
  assert.match(workflow, /for preview_name in "\$branch" "pr-\$number"/);
  assert.match(workflow, /wrangler@4\.135\.0 preview delete --name "\$preview_name"/);
  assert.match(workflow, /state.*!=.*closed/i);

  // Read-only GitHub permissions; no production deploy, KV deletion, or direct API deletion.
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read\s*\n\s*pull-requests:\s*read/i);
  assert.doesNotMatch(workflow, /contents:\s*write|pull-requests:\s*write/i);
  assert.doesNotMatch(workflow, /wrangler[^\n]*\bdeploy\s+(?!--dry-run)/i);
  assert.doesNotMatch(workflow, /gh\s+api[^\n]*(?:--method|-X)\s*DELETE/i);
  assert.doesNotMatch(workflow, /(?:--method|-X)\s*DELETE[^\n]*/i);
});

test("Preview deployment workflow remains guarded and only deploys the isolated PR Preview", async () => {
  const workflow = await readFile(previewWorkflowPath, "utf8");

  assert.match(workflow, /vars\.CLOUDFLARE_PREVIEW_ENABLED\s*==\s*'true'/);
  assert.match(workflow, /github\.event\.action\s*==\s*'closed'/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/);
  assert.match(workflow, /state.*!=.*closed/i);
  assert.match(workflow, /preview_name="pr-\$\{\{ github\.event\.pull_request\.number \}\}"/);
  assert.match(workflow, /wrangler@4\.135\.0\s+preview\s+delete\s+--name\s+"\$preview_name"/);
  assert.doesNotMatch(workflow, /wrangler[^\n]*\bdeploy\s+(?!--dry-run)/i);
});
