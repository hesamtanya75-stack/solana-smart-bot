import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const INTERNAL = "profile-route-test-internal-token-which-is-long";

function makeEnvironment() {
  const values = new Map([
    ["session:" + TOKEN, JSON.stringify({ expiresAt: Date.now() + 60_000, authVersion: 0, mfaAuthenticated: false })],
    ["admin_profile", JSON.stringify({ email: "old@example.com", phone: "", emailVerified: true, phoneVerified: false, authVersion: 0 })]
  ]);
  const kv = {
    async get(key, type) {
      const value = values.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); }
  };
  const stub = {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      if (body.operation === "get-profile") {
        return Response.json({ initialized: true, totpEnabled: false });
      }
      return Response.json({ ok: true });
    }
  };
  return {
    values,
    env: {
      BOT_STATE: kv,
      AUTH_GUARD_INTERNAL_TOKEN: INTERNAL,
      AUTH_GUARD: { idFromName: () => "test", get: () => stub }
    }
  };
}

async function profilePut(env, body, contentType = "application/json") {
  return worker.fetch(new Request("https://bot.test/api/profile", {
    method: "PUT",
    headers: { Authorization: "Bearer " + TOKEN, Origin: "https://bot.test", "Content-Type": contentType },
    body
  }), env);
}

test("PUT /api/profile rejects malformed, non-object, oversized and unexpected JSON before changing profile", async () => {
  const cases = [
    "{",
    "null",
    "[]",
    JSON.stringify({ email: "new@example.com", extra: true }),
    JSON.stringify({ email: "x".repeat(3000) })
  ];
  for (const body of cases) {
    const { env, values } = makeEnvironment();
    const before = values.get("admin_profile");
    const response = await profilePut(env, body);
    assert.equal(response.status, 400, "invalid payload should be rejected");
    assert.equal(values.get("admin_profile"), before, "invalid payload must not mutate profile state");
  }
});

test("PUT /api/profile accepts only string email/phone fields and persists valid updates", async () => {
  const { env, values } = makeEnvironment();
  const badType = await profilePut(env, JSON.stringify({ email: 42 }));
  assert.equal(badType.status, 400);
  assert.equal(JSON.parse(values.get("admin_profile")).email, "old@example.com");

  const response = await profilePut(env, JSON.stringify({ email: "new@example.com", phone: "+964 750 123 4567" }));
  assert.equal(response.status, 200);
  const profile = JSON.parse(values.get("admin_profile"));
  assert.equal(profile.email, "new@example.com");
  assert.equal(profile.phone, "+964 750 123 4567");
  assert.equal(profile.emailVerified, false);
});
