import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { isShareAbovePercent } from "../worker.js";

const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const dashboardSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const privateApiStart = workerSource.indexOf('if (url.pathname.startsWith("/api/"))');
const authGuard = workerSource.indexOf(
  'if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);',
  privateApiStart
);
const totpSetupRoute = workerSource.indexOf('if (url.pathname === "/api/totp/setup"');
const totpConfirmRoute = workerSource.indexOf('if (url.pathname === "/api/totp/confirm"');

test("all dashboard inline JavaScript parses without syntax errors", () => {
  const scripts = [...dashboardSource.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, "dashboard must contain its application scripts");
  scripts.forEach((match, index) => {
    new vm.Script(match[1], { filename: "index.html:inline-script-" + index });
  });
});

test("server polling timers are replaced on login and stopped on logout", () => {
  assert.ok(dashboardSource.includes("let serverSyncTimer = null;"));
  assert.ok(dashboardSource.includes("let serverPriceTimer = null;"));
  assert.ok(dashboardSource.includes("function clearServerPolling()"));
  const login = dashboardSource.indexOf("async function finishServerLogin(token)");
  const clearAtLogin = dashboardSource.indexOf("clearServerPolling();", login);
  const syncTimer = dashboardSource.indexOf("serverSyncTimer = setInterval", login);
  const priceTimer = dashboardSource.indexOf("serverPriceTimer = setInterval", login);
  assert.ok(clearAtLogin > login && syncTimer > clearAtLogin && priceTimer > syncTimer);
  const logout = dashboardSource.indexOf('document.getElementById("profileLogout").onclick');
  const clearAtLogout = dashboardSource.indexOf("clearServerPolling();", logout);
  assert.ok(logout >= 0 && clearAtLogout > logout);
  assert.ok(dashboardSource.includes("clearServerPolling();\n    serverModeReady = false;"));
});

test("server logout permanently blocks local paper-buy fallback until a fresh server login", () => {
  assert.ok(dashboardSource.includes('let serverLogoutLocked = localStorage.getItem("solanaBotServerLogoutLocked") === "1";'));
  const buy = dashboardSource.indexOf('document.getElementById("demoBuy").onclick = async function ()');
  const localLock = dashboardSource.indexOf("if (serverLogoutLocked)", buy);
  const localPurchase = dashboardSource.indexOf("demoBalance -= 5;", buy);
  assert.ok(buy >= 0 && localLock > buy && localPurchase > localLock);
  const login = dashboardSource.indexOf("async function finishServerLogin(token)");
  const unlock = dashboardSource.indexOf('localStorage.removeItem("solanaBotServerLogoutLocked");', login);
  assert.ok(unlock > login, "only a successful server login/state load may clear the logout lock");
  const logout = dashboardSource.indexOf('document.getElementById("profileLogout").onclick');
  const lockAtLogout = dashboardSource.indexOf('localStorage.setItem("solanaBotServerLogoutLocked", "1");', logout);
  assert.ok(lockAtLogout > logout);
});

test("worker session authorization requires one exact Bearer token without whitespace", () => {
  assert.ok(workerSource.includes(String.raw`const match = /^Bearer ([^\s]+)$/i.exec(authorization);`));
  assert.ok(workerSource.includes("if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token))"));
});

test("paper-buy rate limit scope extracts the exact Bearer token before provider inspection", () => {
  assert.ok(workerSource.includes(String.raw`const sessionToken = authorization.replace(/^Bearer\s+/i, "");`));
  const route = workerSource.indexOf('if (url.pathname === "/api/paper/buy"');
  const limiter = workerSource.indexOf("consumeApiRateLimit(env, buyScope, 5, 60000)", route);
  const inspect = workerSource.indexOf("await inspectMint(mint, env)", route);
  assert.ok(route >= 0 && limiter > route && inspect > limiter);
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

test("failed manual server-state initialization clears the received session and stays fail-closed", () => {
  const handler = dashboardSource.indexOf("async function submitServerLogin()");
  const handlerEnd = dashboardSource.indexOf('document.getElementById("serverLoginButton").addEventListener', handler);
  const loginHandler = dashboardSource.slice(handler, handlerEnd);
  assert.ok(handler >= 0 && handlerEnd > handler);
  assert.ok(loginHandler.includes("let receivedSessionToken = false;"));
  assert.ok(loginHandler.includes("if (receivedSessionToken)"));
  assert.ok(loginHandler.includes("clearServerPolling();"));
  assert.ok(loginHandler.includes("serverModeReady = false;"));
  assert.ok(loginHandler.includes('serverToken = "";'));
  assert.ok(loginHandler.includes('localStorage.setItem("solanaBotServerLogoutLocked", "1");'));
  assert.ok(loginHandler.includes('localStorage.removeItem("solanaBotSession");'));
  assert.ok(loginHandler.includes('serverLogin.style.display = "flex";'));
  assert.ok(loginHandler.indexOf("receivedSessionToken = true;") < loginHandler.indexOf("await finishServerLogin("));
});

test("legacy paper-trading migration refuses to consume malformed local snapshots", () => {
  const login = dashboardSource.indexOf("async function finishServerLogin(token)");
  const read = dashboardSource.indexOf('const legacyRaw = localStorage.getItem("demoTradingData");', login);
  const parseGuard = dashboardSource.indexOf("catch (_) { throw new Error(", read);
  const shapeGuard = dashboardSource.indexOf("!Array.isArray(old.trades)", read);
  const balanceGuard = dashboardSource.indexOf("typeof old.balance !== \"number\"", read);
  const tradeLimitGuard = dashboardSource.indexOf("old.trades.length > 500", read);
  const tradeValidation = dashboardSource.indexOf("const invalidTrade = old.trades.some", read);
  const tradeValueGuard = dashboardSource.indexOf("typeof trade.sold !== \"boolean\"", read);
  const enableServerMode = dashboardSource.indexOf("serverModeReady = true;", login);
  const migrateWrite = dashboardSource.indexOf("await saveServerState();", login);
  assert.ok(login >= 0 && read > login);
  assert.ok(parseGuard > read && shapeGuard > parseGuard && tradeLimitGuard > shapeGuard && balanceGuard > tradeLimitGuard);
  assert.ok(tradeValidation > balanceGuard && tradeValueGuard > tradeValidation);
  assert.ok(enableServerMode > tradeValueGuard, "server mode must not start before every legacy trade is validated");
  assert.ok(migrateWrite > enableServerMode);
  const stateSync = dashboardSource.indexOf("await syncServerState();", login);
  const persistSession = dashboardSource.indexOf('localStorage.setItem("solanaBotSession", token);', login);
  assert.ok(stateSync > migrateWrite);
  assert.ok(persistSession > stateSync, "session token must not persist before paper-state migration and sync succeed");
  assert.ok(dashboardSource.includes("داتاکە مەسڕەوە"));
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

test("live coordinator exposes only authenticated status and one-way emergency stop while trade gates remain incomplete", () => {
  assert.ok(workerSource.includes('export { LiveTradeCoordinator } from "./live-trade-coordinator.mjs";'));
  assert.ok(workerSource.includes('url.pathname === "/api/live/status"'));
  assert.ok(workerSource.includes('url.pathname === "/api/live/kill-switch"'));
  assert.ok(workerSource.includes('body.enabled !== true'));
  assert.ok(workerSource.includes('COORDINATOR_INTERNAL_TOKEN'));
  assert.ok(workerSource.includes('COORDINATOR_OPERATOR_TOKEN'));
  for (const route of ["/api/live/reserve", "/api/live/confirm", "/api/live/fail", "/api/live/close", "/api/live/execute"]) {
    assert.equal(workerSource.includes('url.pathname === "' + route + '"'), false);
  }
  assert.equal(workerSource.includes("executeLiveOrder("), false);
  assert.ok(workerSource.includes('if (!isDashboardHtml) return json({ error: "Not found" }, 404);'));
});


test("holder concentration thresholds use exact integer arithmetic at the boundary", () => {
  const supply = 10_000n;
  assert.equal(isShareAbovePercent(3_000n, supply, 30n), false);
  assert.equal(isShareAbovePercent(3_001n, supply, 30n), true);
  assert.equal(isShareAbovePercent(5_000n, supply, 50n), false);
  assert.equal(isShareAbovePercent(5_001n, supply, 50n), true);
  assert.equal(isShareAbovePercent(3_000_000_000_000_000_001n, 10_000_000_000_000_000_000n, 30n), true);
});

test("missing Solana market pair uses the same marker for the five-minute defer path", () => {
  assert.ok(workerSource.includes('throw new Error("No verified Solana market pair for the requested mint")'));
  assert.ok(workerSource.includes('message.startsWith("No verified Solana market pair")'));
  assert.ok(workerSource.includes("retryAt: Date.now() + 5 * 60 * 1000"));
});


test("trusted token scans are authenticated and rate-limited before provider RPC work", () => {
  const auth = workerSource.indexOf('if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);');
  const scan = workerSource.indexOf('if (url.pathname === "/api/scan" && request.method === "POST")');
  const limiter = workerSource.indexOf("consumeApiRateLimit(env, scanScope, 10, 60000)", scan);
  const inspect = workerSource.indexOf("await inspectMint(mint, env)", scan);
  assert.ok(auth >= 0 && scan > auth, "scan route must remain behind session authorization");
  assert.ok(limiter > scan && inspect > limiter, "rate limit must be consumed before expensive provider calls");
  assert.ok(workerSource.includes('operation: "consume-rate-limit"'));
  assert.ok(workerSource.includes("retryAfterSeconds"));
  assert.ok(workerSource.includes('{ "Retry-After": String(retryAfterSeconds) }'));
});
