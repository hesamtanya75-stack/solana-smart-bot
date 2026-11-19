import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const workerModuleUrl = "data:text/javascript;base64," + Buffer.from(workerSource).toString("base64");
const { default: worker } = await import(workerModuleUrl);

function makeContext() {
  let pending;
  return {
    waitUntil(promise) { pending = promise; },
    async drain() { await pending; }
  };
}

test("scheduled cycle does not create default state before first login or import", async () => {
  const writes = [];
  const env = {
    BOT_STATE: {
      async get(key) {
        assert.equal(key, "bot_state");
        return null;
      },
      async put(...args) { writes.push(args); }
    }
  };
  const ctx = makeContext();

  await worker.scheduled({}, env, ctx);
  await ctx.drain();

  assert.deepEqual(writes, [], "an uninitialized namespace must remain untouched by Cron");
});

test("scheduled cycle continues safely after state has been initialized", async () => {
  const writes = [];
  const initial = {
    balance: 100,
    trades: [],
    autoEnabled: false,
    paused: false,
    scannedMints: [],
    deferredMints: [],
    lastScanReport: [],
    updatedAt: "2026-11-18T00:00:00.000Z"
  };
  const env = {
    BOT_STATE: {
      async get(key) {
        assert.equal(key, "bot_state");
        return initial;
      },
      async put(key, value) { writes.push({ key, value: JSON.parse(value) }); }
    }
  };
  const ctx = makeContext();

  await worker.scheduled({}, env, ctx);
  await ctx.drain();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, "bot_state");
  assert.equal(writes[0].value.autoEnabled, false);
  assert.ok(writes[0].value.updatedAt);
});

test("frontend blocks sync only when local history exists and remote history is timestamped but empty", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/function hasLegacyEmptyServerConflict\(local, remote\) \{[\s\S]*?\n\}/);
  assert.ok(match, "frontend conflict guard helper must exist");
  const vm = await import("node:vm");
  const guard = vm.runInNewContext("(" + match[0].replace(/^function hasLegacyEmptyServerConflict/, "function") + ")");
  assert.equal(guard({ trades: [{ mint: "local" }] }, { trades: [], updatedAt: "2026-11-19T00:00:00.000Z" }), true);
  assert.equal(guard({ trades: [] }, { trades: [], updatedAt: "2026-11-19T00:00:00.000Z" }), false);
  assert.equal(guard({ trades: [{ mint: "local" }] }, { trades: [{ mint: "remote" }], updatedAt: "2026-11-19T00:00:00.000Z" }), false);
  assert.equal(guard({ trades: [{ mint: "local" }] }, { trades: [] }), false);
});
