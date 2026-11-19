import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");

test("canonical paper state access is routed through the Durable Object", () => {
  assert.match(worker, /env\.PAPER_STATE_COORDINATOR/);
  assert.match(worker, /coordinatorRequest\(env, "snapshot"/);
  assert.match(worker, /coordinatorRequest\(env, "commit"/);
  assert.match(worker, /coordinatorRequest\(env, "import"/);
  assert.match(worker, /coordinatorRequest\(env, "patch"/);
  assert.doesNotMatch(worker, /env\.BOT_STATE\.(?:get|put|delete)\(["'`]bot_state["'`]/);
});
