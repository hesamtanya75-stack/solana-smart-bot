import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("all inline browser scripts in index.html parse as JavaScript", () => {
  const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi))
    .filter((match) => !/\bsrc\s*=/.test(match[1]))
    .map((match) => match[2])
    .filter((source) => source.trim().length > 0);

  assert.ok(scripts.length > 0, "expected at least one inline script");
  for (let index = 0; index < scripts.length; index += 1) {
    assert.doesNotThrow(
      () => new Script(scripts[index], { filename: `index.html:inline-script-${index + 1}` }),
      `inline script ${index + 1} must parse`
    );
  }
});

test("Phantom connection remains read-only and clearly disclaims trading integration", () => {
  const start = html.indexOf("// Read-only Phantom connection.");
  assert.notEqual(start, -1, "read-only Phantom connector should exist");
  const source = html.slice(start, html.indexOf("\n})();", start));
  assert.match(source, /provider\.connect\(\)/);
  assert.match(source, /observePhantomProvider\(provider\)/);
  assert.doesNotMatch(source, /signTransaction|signAndSendTransaction|sendTransaction|signAllTransactions|signMessage|signIn/);
  assert.match(html, /هێشتا بە ڕێڕەوی داواکاریی کڕینەوە نەبەستراوە/);
  assert.match(html, /هیچ مامەڵەیەک واژۆ ناکات و هیچ پارەیەک نانێرێت/);
  assert.match(html, /Seed Phrase و Private Key مەنووسە/);
});


test("Phantom SOL balance is read-only and ignores stale wallet responses", () => {
  const start = html.indexOf("// Read-only Phantom connection.");
  const source = html.slice(start, html.indexOf("\n})();", start));
  assert.match(source, /rpcRequest\("getBalance"/);
  assert.match(source, /commitment: "confirmed"/);
  assert.match(source, /requestId !== walletBalanceRequestId/);
  assert.match(source, /connectedPhantomProvider !== provider/);
  assert.match(source, /lamports \/ 1_000_000_000/);
  assert.doesNotMatch(source, /signTransaction|signAndSendTransaction|sendTransaction/);
});

test("demo trade mint is HTML-escaped before rendering", () => {
  const start = html.indexOf("function makeCards(items)");
  const end = html.indexOf("\n  const totalProfit", start);
  assert.notEqual(start, -1, "demo trade card renderer should exist");
  assert.notEqual(end, -1, "demo trade card renderer should have a stable boundary");
  const renderer = html.slice(start, end);
  assert.match(renderer, /safe\(t\.mint\)/);
  assert.equal(renderer.includes("t.mint).replace"), false);
});
