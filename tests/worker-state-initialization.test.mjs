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
