import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const INTERNAL_TOKEN = "runtime-test-token-that-is-longer-than-thirty-two-characters";

test("AuthGuard runs on the Miniflare Durable Objects runtime with transactional storage", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: "./tests/fixtures/auth-guard-runtime.mjs",
    compatibilityDate: "2026-05-03",
    durableObjects: {
      AUTH_GUARD: "AuthGuard"
    },
    bindings: {
      AUTH_GUARD_INTERNAL_TOKEN: INTERNAL_TOKEN
    }
  }));

  try {
    const namespace = await mf.getDurableObjectNamespace("AUTH_GUARD");
    const id = namespace.idFromName("auth-guard-runtime-integration");
    const stub = namespace.get(id);

    const call = async (body, token = INTERNAL_TOKEN) => {
      const response = await stub.fetch("https://auth-guard.internal/", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      return { response, body: await response.json() };
    };

    const unauthorized = await call({ operation: "record-failure", scope: "login:runtime" }, "wrong-token");
    assert.equal(unauthorized.response.status, 401);

    const initialized = await call({
      operation: "initialize-legacy",
      totpEnabled: true,
      totpSecret: "JBSWY3DPEHPK3PXP",
      backupHash: "a".repeat(64),
      lastTotpCounter: 123
    });
    assert.equal(initialized.response.status, 200);
    assert.equal(initialized.body.initialized, true);

    const attempts = await Promise.all(Array.from({ length: 20 }, () =>
      call({ operation: "consume-backup", hash: "a".repeat(64) })
    ));
    assert.equal(attempts.filter(item => item.response.status === 200 && item.body.ok).length, 1);
    assert.equal(attempts.filter(item => item.response.status === 200 && !item.body.ok).length, 19);

    const profile = await call({ operation: "get-profile" });
    assert.equal(profile.response.status, 200);
    assert.equal(profile.body.initialized, true);
    assert.equal(profile.body.totpEnabled, true);
    assert.equal(profile.body.totpSecret, "JBSWY3DPEHPK3PXP");

    const failures = await Promise.all(Array.from({ length: 20 }, () =>
      call({ operation: "record-failure", scope: "totp:runtime" })
    ));
    assert.equal(failures.every(item => item.response.status === 200), true);
    assert.equal(Math.max(...failures.map(item => item.body.count)), 5);
    assert.equal(failures.filter(item => item.body.limited).length, 16);

    const limited = await call({ operation: "is-rate-limited", scope: "totp:runtime" });
    assert.deepEqual(limited.body, { limited: true });

    // A retried legacy import must merge upward, never discard a stronger
    // legacy lockout when a weaker bucket already exists in AuthGuard.
    await call({ operation: "import-legacy-failure", scope: "login:migration", count: 2 });
    await call({ operation: "import-legacy-failure", scope: "login:migration", count: 5 });
    const migratedLimit = await call({ operation: "is-rate-limited", scope: "login:migration" });
    assert.deepEqual(migratedLimit.body, { limited: true });
  } finally {
    await mf.dispose();
  }
});
