import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("dashboard inline scripts parse as valid JavaScript", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script\\s*>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);

  assert.ok(scripts.length > 0, "expected at least one inline dashboard script");
  for (const [index, source] of scripts.entries()) {
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: `index.html:inline-script-${index + 1}` }),
      `inline script ${index + 1} should parse`
    );
  }
});
