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

test("paper-state coordinator is configured as a SQLite Durable Object class", () => {
  assert.equal(config.exports?.PaperStateCoordinator?.type, "durable-object");
  assert.equal(config.exports?.PaperStateCoordinator?.storage, "sqlite");
  assert.equal(config.durable_objects?.bindings?.filter(binding => binding.name === "PAPER_STATE_COORDINATOR").length, 1);
});

test("Preview asset diagnostics are routed through the Worker", () => {
  assert.ok(config.assets?.run_worker_first?.includes("/asset-check"));
});


test("Worker exposes Cloudflare-generated version metadata instead of a stale hardcoded build hash", () => {
  assert.equal(config.version_metadata?.binding, "CF_VERSION_METADATA");
});
test("Worker health and version routes use the runtime version ID", async () => {
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  assert.match(worker, /const buildId = env\.CF_VERSION_METADATA\?\.id \|\| "local-unversioned"/);
  assert.match(worker, /storage: "Durable Object \(paper state\) \+ Workers KV \(sessions\/cache\)", build: buildId/);
  assert.match(worker, /build: buildId, frontend: "premium-dashboard-v2"/);
  assert.doesNotMatch(worker, /59ef112/);
});
