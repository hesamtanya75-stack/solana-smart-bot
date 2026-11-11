import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const nodeCompatibleWorkerSource =
  "class DurableObject { constructor(ctx) { this.ctx = ctx; } }\\n" +
  workerSource.replace('import { DurableObject } from "cloudflare:workers";\\n', "");
const workerModuleUrl = "data:text/javascript;base64," + Buffer.from(nodeCompatibleWorkerSource).toString("base64");
const { default: worker } = await import(workerModuleUrl);

class MemoryKV {
  constructor(entries = []) {
    this.values = new Map(entries);
  }
  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.values.set(key, value);
  }
  async delete(key) {
    this.values.delete(key);
  }
}

test("POST /api/logout revokes the bearer session", async () => {
  const token = "test-session-token";
  const kv = new MemoryKV([
    ["session:" + token, JSON.stringify({ expiresAt: Date.now() + 60_000 })]
  ]);
  const env = { BOT_STATE: kv };
  const logout = await worker.fetch(new Request("https://worker.test/api/logout", {
    method: "POST",
    headers: { Authorization: "Bearer " + token }
  }), env);

  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).ok, true);
  assert.equal(kv.values.has("session:" + token), false);

  const protectedRequest = await worker.fetch(new Request("https://worker.test/api/profile", {
    headers: { Authorization: "Bearer " + token }
  }), env);
  assert.equal(protectedRequest.status, 401);
});

test("POST /api/logout rejects requests without an authenticated session", async () => {
  const kv = new MemoryKV();
  const response = await worker.fetch(new Request("https://worker.test/api/logout", {
    method: "POST"
  }), { BOT_STATE: kv });

  assert.equal(response.status, 401);
  assert.equal(kv.values.size, 0);
});
