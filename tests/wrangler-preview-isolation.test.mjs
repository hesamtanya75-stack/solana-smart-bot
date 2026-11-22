import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("Preview uses a distinct Workers KV namespace", () => {
  const production = config.kv_namespaces?.find(binding => binding.binding === "BOT_STATE");
  const preview = config.previews?.kv_namespaces?.find(binding => binding.binding === "BOT_STATE");
  assert.ok(production?.id, "production BOT_STATE namespace must be configured");
  assert.ok(preview?.id, "Preview BOT_STATE namespace must be configured");
  assert.notEqual(preview.id, production.id, "Preview must not share production paper-state KV");
});

test("Preview binds the paper-state Durable Object coordinator", () => {
  const production = config.durable_objects?.bindings?.find(binding => binding.name === "PAPER_STATE_COORDINATOR");
  const preview = config.previews?.durable_objects?.bindings?.find(binding => binding.name === "PAPER_STATE_COORDINATOR");
  assert.equal(production?.class_name, "PaperStateCoordinator");
  assert.equal(preview?.class_name, "PaperStateCoordinator", "Preview must route paper state through its own DO binding");
});

test("Preview binds the dedicated authentication rate limiter Durable Object", () => {
  const production = config.durable_objects?.bindings?.find(binding => binding.name === "AUTH_RATE_LIMITER");
  const preview = config.previews?.durable_objects?.bindings?.find(binding => binding.name === "AUTH_RATE_LIMITER");
  assert.equal(production?.class_name, "MfaRateLimiter");
  assert.equal(preview?.class_name, "MfaRateLimiter", "Preview must bind the authentication limiter");
});

test("already-provisioned Durable Object classes use declarative SQLite exports, not a replayed create migration", () => {
  assert.deepEqual(config.exports?.PaperStateCoordinator, {
    type: "durable-object",
    storage: "sqlite"
  });
  assert.deepEqual(config.exports?.MfaRateLimiter, {
    type: "durable-object",
    storage: "sqlite"
  });
  assert.equal("migrations" in config, false, "do not replay first-create migrations against existing DO namespaces");
  assert.equal(config.durable_objects?.bindings?.filter(binding => binding.name === "PAPER_STATE_COORDINATOR").length, 1);
  assert.equal(config.durable_objects?.bindings?.filter(binding => binding.name === "AUTH_RATE_LIMITER").length, 1);
});

test("Preview asset diagnostics are routed through the Worker", () => {
  assert.ok(config.assets?.run_worker_first === true || config.assets?.run_worker_first?.includes("/asset-check"));
});

test("Worker exposes Cloudflare-generated version metadata instead of a stale hardcoded build hash", () => {
  assert.equal(config.version_metadata?.binding, "CF_VERSION_METADATA");
});
test("Worker health and version routes use the runtime version ID", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  assert.match(worker, /const buildId = env\.BUILD_ID \|\| env\.CF_VERSION_METADATA\?\.id \|\| "local-unversioned"/);
  assert.match(worker, /storage: "Durable Object \(paper state\) \+ Workers KV \(sessions\/cache\)", build: buildId/);
  assert.match(worker, /build: buildId, frontend: "premium-dashboard-v2"/);
  assert.doesNotMatch(worker, /59ef112/);
});

test("root asset publishing excludes repository internals and diagnostic pages", async () => {
  const ignore = await readFile(new URL("../.assetsignore", import.meta.url), "utf8");
  const requiredPatterns = [
    ".git", ".git/**",
    ".wrangler", ".wrangler/**",
    ".github", ".github/**",
    "docs", "docs/**",
    "scripts", "scripts/**",
    "tests", "tests/**",
    "display-*.html",
    "worker.js",
    "paper-state-coordinator.js",
    "mfa-rate-limiter.js",
    "wrangler.jsonc",
    "package.json",
    "*.js", "*.mjs", "*.map",
    "*.json", "*.jsonc",
    "*.sqlite", "*.sqlite-*", "*.db", "*.db-*",
    "*backup*",
    ".env*", ".dev.vars*"
  ];
  const lines = new Set(ignore.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  for (const pattern of requiredPatterns) {
    assert.ok(lines.has(pattern), `public assets must ignore ${pattern}`);
  }
});

test("Preview CI performs read-only runtime and public asset boundary checks", async () => {
  const workflow = await readFile(new URL("../.github/workflows/cloudflare-preview.yml", import.meta.url), "utf8");
  const smoke = await readFile(new URL("../scripts/preview-smoke-check.mjs", import.meta.url), "utf8");
  const extractor = await readFile(new URL("../scripts/extract-preview-url.mjs", import.meta.url), "utf8");
  assert.ok(workflow.includes("Verify Preview runtime and public asset boundary (read-only)"));
  assert.ok(workflow.includes("run: node scripts/preview-smoke-check.mjs"));
  assert.ok(workflow.includes("scripts/extract-preview-url.mjs"));
  assert.ok(extractor.includes("payload?.deployment?.urls?.[0]"));
  assert.ok(extractor.includes("Captured the exact immutable Wrangler Preview deployment URL."));
  assert.match(smoke, /Refusing to smoke-test a non-Preview URL/);
  assert.match(smoke, /EXPECTED_BUILD_ID/);
  for (const path of ["/.git/config", "/.wrangler/", "/worker.js", "/display-test.html", "/wrangler.jsonc", "/.dev.vars"]) {
    assert.ok(smoke.includes(path), `Preview smoke check must test ${path}`);
  }
});

test("closed PRs clean up only their isolated Preview and are not redeployed", async () => {
  const workflow = await readFile(new URL("../.github/workflows/cloudflare-preview.yml", import.meta.url), "utf8");
  assert.match(workflow, /- closed/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /preview_pr_number:/);
  assert.match(workflow, /github\.event\.action != 'closed'/);
  assert.match(workflow, /github\.event\.action == 'closed'/);
  assert.ok(workflow.includes('preview delete --name "$preview_name"'));
  assert.match(workflow, /inputs\.preview_pr_number/);
  assert.match(workflow, /github\.event\.pull_request\.number/);
  assert.match(workflow, /Check whether the selected pull request is closed/);
});

test("Preview namespace quota cannot be reported as a runtime validation pass", async () => {
  const workflow = await readFile(new URL("../.github/workflows/cloudflare-preview.yml", import.meta.url), "utf8");
  assert.match(workflow, /Preview runtime validation did not run/);
  assert.match(workflow, /exit 1/);
});
