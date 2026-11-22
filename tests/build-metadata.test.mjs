import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Preview version endpoint falls back to the checked-out PR commit SHA", () => {
  const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/cloudflare-preview.yml", import.meta.url), "utf8");

  assert.match(
    worker,
    /env\.CF_VERSION_METADATA\?\.id\s*\|\|\s*env\.BUILD_ID\s*\|\|\s*"local-unversioned"/,
    "use Cloudflare version metadata first, then the injected preview commit id"
  );
  assert.match(
    workflow,
    /wrangler@4\.135\.0 preview[^\n]*--var BUILD_ID:\$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
    "preview CI must inject the exact PR head SHA without changing production deployment configuration"
  );
});
