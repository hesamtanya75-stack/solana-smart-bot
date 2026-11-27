import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .filter(match => !/\bsrc\s*=/.test(match[1]))
  .map(match => match[2]);

test("all inline dashboard scripts parse without syntax errors", () => {
  assert.ok(scripts.length > 0, "dashboard should contain its inline application scripts");
  scripts.forEach((source, index) => {
    assert.doesNotThrow(() => new vm.Script(source, { filename: "index.html:inline-script-" + index }));
  });
});


test("dashboard logout always clears local session and locks local trading in finally", () => {
  const start = html.indexOf('document.getElementById("profileLogout").onclick=async()=>{');
  const end = html.indexOf('document.getElementById("profileSave").onclick=async()=>{', start);
  assert.ok(start >= 0 && end > start, "profile logout handler should exist");
  const handler = html.slice(start, end);
  const finallyStart = handler.indexOf("finally{");
  assert.ok(finallyStart >= 0, "logout must have an unconditional finally cleanup");
  const cleanup = handler.slice(finallyStart);
  for (const required of [
    "clearServerPolling()",
    'serverToken=""',
    "serverModeReady=false",
    "serverLogoutLocked=true",
    'localStorage.removeItem("solanaBotSession")',
    'serverLogin.style.display="flex"',
    'try{\n        localStorage.setItem("solanaBotServerLogoutLocked", "1");\n      }catch(storageError)',
    'try{\n        localStorage.removeItem("solanaBotSession");\n      }catch(storageError)'
  ]) {
    assert.ok(cleanup.includes(required), "logout finally must include " + required);
  }
  assert.match(handler, /serverRevoked\s*\?\s*"چوونەژوورەوە هەڵوەشێندرایەوە\."/);
});
