import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("closed-PR cleanup workflow is strictly report-only", async () => {
  const workflow = await read("../.github/workflows/cloudflare-closed-preview-cleanup.yml");
  assert.match(workflow, /REPORT ONLY/i);
  assert.doesNotMatch(workflow, /wrangler[^\n]*\bpreview\s+delete/i);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
});

test("closed-PR cleanup job in preview workflow cannot delete or change Cloudflare resources", async () => {
  const workflow = await read("../.github/workflows/cloudflare-preview.yml");
  const cleanup = workflow.split("  cleanup:")[1]?.split("  preview:")[0] ?? "";
  assert.ok(cleanup, "cleanup job must exist");
  assert.match(cleanup, /REPORT ONLY/i);
  assert.doesNotMatch(cleanup, /wrangler[^\n]*\bpreview\s+delete/i);
  assert.doesNotMatch(cleanup, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(cleanup, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(cleanup, /wrangler[^\n]*\bdeploy/i);
});

test("Preview build path remains explicitly dry-run for Worker deployment validation", async () => {
  const workflow = await read("../.github/workflows/cloudflare-preview.yml");
  const preview = workflow.split("  preview:")[1] ?? "";
  assert.match(preview, /wrangler[^\n]*deploy\s+--dry-run/);
});
