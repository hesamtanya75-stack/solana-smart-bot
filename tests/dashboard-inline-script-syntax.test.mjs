import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("dashboard inline scripts parse as valid JavaScript", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)[<][/]script\s*>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);

  assert.ok(scripts.length > 0, "expected at least one inline dashboard script");
  assert.match(
    html,
    /response\.status === 401[\s\S]*?!path\.startsWith\("\/api\/login"\)[\s\S]*?path !== "\/api\/totp\/confirm"/,
    "an incorrect TOTP setup code must not be treated as an expired admin session"
  );
  const mfaConfirmStart = html.indexOf('document.getElementById("totpConfirm").onclick');
  const mfaConfirmEnd = html.indexOf('})();', mfaConfirmStart);
  const mfaConfirmHandler = html.slice(mfaConfirmStart, mfaConfirmEnd);
  assert.ok(mfaConfirmStart >= 0 && mfaConfirmEnd > mfaConfirmStart, "expected the MFA setup confirmation handler");
  assert.ok(
    mfaConfirmHandler.indexOf('document.getElementById("totpBackupCode").textContent=p.backupCode') <
      mfaConfirmHandler.indexOf('localStorage.removeItem("solanaBotSession")'),
    "show the one-time backup code before invalidating the setup session"
  );
  assert.match(
    html,
    /if\(!serverModeReady\)\s*\{\s*serverLogin\.style\.display="flex"/,
    "closing the admin profile after MFA activation must reopen the login panel"
  );
  for (const [index, source] of scripts.entries()) {
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: "index.html:inline-script-" + (index + 1) }),
      "inline script " + (index + 1) + " should parse"
    );
  }
});
