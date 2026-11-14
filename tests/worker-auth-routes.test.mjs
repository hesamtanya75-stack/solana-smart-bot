import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const privateApiStart = workerSource.indexOf('if (url.pathname.startsWith("/api/"))');
const authGuard = workerSource.indexOf(
  'if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);',
  privateApiStart
);
const totpSetupRoute = workerSource.indexOf('if (url.pathname === "/api/totp/setup"');
const totpConfirmRoute = workerSource.indexOf('if (url.pathname === "/api/totp/confirm"');

test("private API authentication guard precedes private route handlers", () => {
  assert.notEqual(privateApiStart, -1, "private API router must exist");
  assert.ok(authGuard > privateApiStart, "session guard must be inside the private API router");
  assert.ok(totpSetupRoute > authGuard, "TOTP setup must remain behind the session guard");
  assert.ok(totpConfirmRoute > authGuard, "TOTP confirmation must remain behind the session guard");
});

test("unknown private API paths cannot bypass the shared session guard", () => {
  assert.notEqual(privateApiStart, -1);
  assert.ok(authGuard > privateApiStart);
  assert.ok(workerSource.indexOf('return json({ error: "Not found" }, 404);', privateApiStart) > authGuard);
});

test("TOTP codes cannot be reused in an already accepted time step", () => {
  assert.ok(workerSource.includes("async function matchingTotpCounter("));
  assert.ok(workerSource.includes("matchedCounter > Number(profile.lastTotpCounter ?? -1)"));
  assert.ok(workerSource.includes("matchedCounter <= Number(p.lastTotpCounter ?? -1)"));
  assert.ok(workerSource.includes("profile.lastTotpCounter = matchedCounter"));
  assert.ok(workerSource.includes("p.lastTotpCounter = matchedCounter"));
});

test("state-changing API requests reject cross-origin browser requests", () => {
  assert.ok(workerSource.includes("function sameOriginApiRequest(request, url)"));
  assert.ok(workerSource.includes('new URL(origin).origin !== url.origin'));
  assert.ok(workerSource.includes('request.headers.get("Sec-Fetch-Site") !== "cross-site"'));
  assert.ok(workerSource.includes('if (!sameOriginApiRequest(request, url))'));
});

test("origin protection runs before login and private API route handling", () => {
  const fetchHandler = workerSource.indexOf("async fetch(request, env)");
  const originGuard = workerSource.indexOf("if (!sameOriginApiRequest(request, url))", fetchHandler);
  const loginRoute = workerSource.indexOf('if (url.pathname === "/api/login"', fetchHandler);
  const privateApiRouter = workerSource.indexOf('if (url.pathname.startsWith("/api/"))', fetchHandler);
  assert.ok(fetchHandler >= 0);
  assert.ok(originGuard > fetchHandler);
  assert.ok(loginRoute > originGuard);
  assert.ok(privateApiRouter > originGuard);
  assert.ok(workerSource.includes('["POST", "PUT", "PATCH", "DELETE"]'));
});

test("authentication JSON bodies are size-bounded and must be JSON objects", () => {
  assert.ok(workerSource.includes("async function readBoundedJson(request, maxBytes = 8192)"));
  assert.ok(workerSource.includes("const reader = request.body?.getReader();"));
  assert.ok(workerSource.includes("if (total > maxBytes)"));
  assert.ok(workerSource.includes("await reader.cancel();"));
  assert.ok(workerSource.includes('if (!value || typeof value !== "object" || Array.isArray(value))'));
  assert.ok(workerSource.includes("readBoundedJson(request, 4096)"));
  assert.equal(workerSource.includes("const { code } = await request.json();"), false);
  assert.equal(workerSource.includes("const { password } = await request.json();"), false);
  assert.equal(workerSource.includes("const { challengeId, code } = await request.json();"), false);
});


test("login and TOTP routes delegate MFA state and rate limits to AuthGuard", () => {
  assert.ok(workerSource.includes("async function authGuardCall(env, body)"));
  assert.ok(workerSource.includes('namespace.idFromName("admin")'));
  assert.ok(workerSource.includes('operation: "initialize-legacy"'));
  assert.ok(workerSource.includes('operation: "get-profile"'));
  assert.ok(workerSource.includes('operation: "create-challenge"'));
  assert.ok(workerSource.includes('operation: "complete-challenge"'));
  assert.ok(workerSource.includes('operation: "begin-totp-setup"'));
  assert.ok(workerSource.includes('operation: "confirm-totp-setup"'));
  assert.equal(workerSource.includes('"mfa_challenge:"'), false);
  assert.equal(workerSource.includes('"totp_fail:"'), false);
  assert.equal(workerSource.includes('"login_fail:"'), false);
});

test("AuthGuard calls fail closed when the dedicated binding or secret is absent", () => {
  assert.ok(workerSource.includes('if (!namespace || token.length < 32) throw new Error("Authentication guard is not configured")'));
  assert.ok(workerSource.includes('"AUTH_GUARD_INTERNAL_TOKEN"') || workerSource.includes("env.AUTH_GUARD_INTERNAL_TOKEN"));
});
