import test from "node:test";
import assert from "node:assert/strict";
import {
  denoKvConnectUrl,
  isDefaultLookingState
} from "../scripts/export-deno-kv-paper-state.mjs";

test("builds only the official HTTPS KV Connect URL from a database ID", () => {
  assert.equal(
    denoKvConnectUrl("db_123456"),
    "https://api.deno.com/v2/databases/db_123456/connect"
  );
  assert.throws(() => denoKvConnectUrl("../other"), /actual database ID/);
  assert.throws(() => denoKvConnectUrl(""), /actual database ID/);
});

test("identifies default-looking state without treating it as confirmed", () => {
  assert.equal(isDefaultLookingState({ balance: 100, trades: [] }), true);
  assert.equal(isDefaultLookingState({ balance: 98, trades: [] }), false);
  assert.equal(isDefaultLookingState({ balance: 100, trades: [{ mint: "x" }] }), false);
});
