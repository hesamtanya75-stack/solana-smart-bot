import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const dashboardSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const privateApiStart = workerSource.indexOf('if (url.pathname.startsWith("/api/"))');
const authGuard = workerSource.indexOf(
  'if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);',
  privateApiStart
);
const totpSetupRoute = workerSource.indexOf('if (url.pathname === "/api/totp/setup"');
const totpConfirmRoute = workerSource.indexOf('if (url.pathname === "/api/totp/confirm"');

test("worker session authorization requires one exact Bearer token without whitespace", () => {
  assert.ok(workerSource.includes(String.raw`const match = /^Bearer ([^\s]+)$/i.exec(authorization);`));
  assert.ok(workerSource.includes("if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token))"));
});

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

test("TOTP replay protection is delegated to transactional AuthGuard state", () => {
  assert.ok(workerSource.includes("async function matchingTotpCounter("));
  assert.ok(workerSource.includes("totpCounter: matchedCounter"));
  assert.ok(workerSource.includes('operation: "complete-challenge"'));
  assert.equal(workerSource.includes("profile.lastTotpCounter = matchedCounter"), false);
  assert.equal(workerSource.includes('await env.BOT_STATE.put("admin_profile", JSON.stringify(profile))'), false);
});

test("legacy state migration rejects a stale client revision", () => {
  const migrationRoute = workerSource.indexOf('if (url.pathname === "/api/state" && request.method === "PUT")');
  const revisionCheck = workerSource.indexOf("body.expectedRevision !== current.__revision", migrationRoute);
  const migrationCall = workerSource.indexOf('operation: "migrate-legacy"', migrationRoute);
  assert.ok(migrationRoute >= 0);
  assert.ok(revisionCheck > migrationRoute);
  assert.ok(migrationCall > revisionCheck);
});

test("state-changing API requests reject cross-origin browser requests", () => {
  assert.ok(workerSource.includes("function sameOriginApiRequest(request, url)"));
  assert.ok(workerSource.includes('new URL(origin).origin !== url.origin'));
  assert.ok(workerSource.includes('request.headers.get("Sec-Fetch-Site") !== "cross-site"'));
  assert.ok(workerSource.includes('request.headers.get("Sec-Fetch-Site") !== "same-origin"'));
  assert.ok(workerSource.includes("Reject requests where both Origin and Fetch Metadata are absent."));
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
  assert.ok(workerSource.includes("async function migrateLegacyFailure(env, scope, legacyKey)"));
  assert.ok(workerSource.includes('"mfa_challenge:"') === false);
  assert.ok(workerSource.includes('"totp_fail:"'));
  assert.ok(workerSource.includes('"login_fail:"'));
});

test("AuthGuard calls fail closed when the dedicated binding or secret is absent", () => {
  assert.ok(workerSource.includes('if (!namespace || token.length < 32) throw new Error("Authentication guard is not configured")'));
  assert.ok(workerSource.includes('"AUTH_GUARD_INTERNAL_TOKEN"') || workerSource.includes("env.AUTH_GUARD_INTERNAL_TOKEN"));
});


test("temporary public diagnostic routes are not exposed by the Worker", () => {
  for (const route of ["/asset-check", "/dashboard-test", "/screen-test"]) {
    assert.equal(workerSource.includes('url.pathname === "' + route + '"'), false, route + " must not be public");
  }
});

test("security panel escapes untrusted RPC token program metadata before HTML rendering", () => {
  assert.ok(dashboardSource.includes('row("Token Program",safe(programOwner||"داتا نییە"))+'));
  assert.equal(dashboardSource.includes('row("Token Program",programOwner||"داتا نییە")+'), false);
});

test("static asset fallback exposes only the self-contained dashboard routes", () => {
  const dashboardGate = workerSource.indexOf(
    'if (!isDashboardHtml) return json({ error: "Not found" }, 404);'
  );
  const assetFetch = workerSource.indexOf("const assetResponse = await env.ASSETS.fetch(assetRequest);");
  assert.ok(dashboardGate >= 0, "all non-dashboard paths must be denied before static asset lookup");
  assert.ok(assetFetch > dashboardGate, "the asset binding must only be reached after the dashboard allowlist");
});

test("Jupiter live quote preview is authenticated, bounded, and quote-only", () => {
  const route = workerSource.indexOf('if (url.pathname === "/api/live/quote-preview" && request.method === "POST")');
  const auth = workerSource.indexOf('if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);');
  const nextRoute = workerSource.indexOf('if (url.pathname === "/api/market-prices" && request.method === "POST")', route);
  assert.ok(route > auth, "quote preview must remain behind session authentication");
  assert.ok(nextRoute > route, "quote preview route must be registered");
  const source = workerSource.slice(route, nextRoute);
  assert.ok(source.includes('inputMint: "So11111111111111111111111111111111111111112"'));
  assert.ok(source.includes('outputMint,\n            amount: amountLamports'));
  assert.ok(source.includes('"x-api-key": apiKey'));
  assert.ok(source.includes('order.transaction !== null'));
  assert.ok(source.includes('quoteOnly: true'));
  assert.ok(source.includes('transactionAvailable: false'));
  assert.equal(source.includes('taker:'), false, "preview must not request an assembled transaction");
  assert.equal(source.includes('signedTransaction'), false, "preview must never sign or submit");
  assert.ok(source.includes('BigInt(amountLamports) > 18446744073709551615n'));
  assert.ok(workerSource.includes('https://api.jup.ag; img-src'), "CSP must permit the Jupiter API");
});
