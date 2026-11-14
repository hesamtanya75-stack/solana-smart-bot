import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const tempDir = await mkdtemp(join(tmpdir(), "worker-auth-routes-"));
const workerPath = join(tempDir, "worker.mjs");
await writeFile(workerPath, workerSource, "utf8");
const { default: worker } = await import(pathToFileURL(workerPath).href);
after(async () => rm(tempDir, { recursive: true, force: true }));

function createEnv() {
  const values = new Map();
  const writes = [];
  return {
    writes,
    BOT_STATE: {
      async get(key) { return values.get(key) ?? null; },
      async put(key, value) { writes.push({ key, value }); values.set(key, value); },
      async delete(key) { values.delete(key); }
    }
  };
}

test("TOTP enrollment setup requires an authenticated session", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://example.test/api/totp/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  }), env);

  assert.equal(response.status, 401);
  assert.deepEqual(env.writes, []);
});

test("TOTP enrollment confirmation requires an authenticated session", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://example.test/api/totp/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "123456" })
  }), env);

  assert.equal(response.status, 401);
  assert.deepEqual(env.writes, []);
});

test("unknown private API routes remain behind session authentication", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://example.test/api/not-a-route", {
    method: "GET"
  }), env);

  assert.equal(response.status, 401);
  assert.deepEqual(env.writes, []);
});
