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
