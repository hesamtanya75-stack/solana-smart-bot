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
  assert.doesNotMatch(source, /signTransaction|signAndSendTransaction|sendTransaction/);
  assert.match(html, /هێشتا بە ڕێڕەوی داواکاریی کڕینەوە نەبەستراوە/);
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


test("Jupiter preview UI requests authenticated quote-only data with a bounded SOL amount", () => {
  assert.match(html, /id="jupiterQuotePanel"/);
  assert.match(html, /id="jupiterQuoteButton"/);
  assert.match(html, /serverRequest\("\/api\/live\/quote-preview"/);
  assert.match(html, /amountLamports: lamports\.toString\(\)/);
  assert.match(html, /lamports > 1000000000n/);
  assert.match(html, /quote\.quoteOnly !== true/);
  assert.match(html, /transactionAvailable !== false/);
  assert.match(html, /raw token units/);
  assert.match(html, /otherAmountThreshold/);
  assert.match(html, /outUsdValue/);
  assert.match(html, /slippageBps/);
  assert.match(html, /platformFeeAmount/);
  const start = html.indexOf('const jupiterQuoteButton');
  const end = html.indexOf('function renderServerControls', start);
  const source = html.slice(start, end);
  assert.doesNotMatch(source, /signTransaction|signAndSendTransaction|sendTransaction/);
});
