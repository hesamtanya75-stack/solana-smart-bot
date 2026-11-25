import test from "node:test";
import assert from "node:assert/strict";
import { isAcceptableRugCheckScore } from "../rugcheck-score.js";

test("accepts finite RugCheck scores at or below the safety threshold", () => {
  assert.equal(isAcceptableRugCheckScore(0), true);
  assert.equal(isAcceptableRugCheckScore(2500), true);
  assert.equal(isAcceptableRugCheckScore("1250"), true);
  assert.equal(isAcceptableRugCheckScore(2501), false);
});

test("rejects missing, nonnumeric, negative, and non-finite RugCheck scores", () => {
  for (const value of [null, undefined, "", "   ", "not-a-score", -1, NaN, Infinity, -Infinity, true, {}]) {
    assert.equal(isAcceptableRugCheckScore(value), false, `expected rejection for ${String(value)}`);
  }
});

test("invalid configured threshold fails closed", () => {
  assert.equal(isAcceptableRugCheckScore(10, NaN), false);
  assert.equal(isAcceptableRugCheckScore(10, -1), false);
});
