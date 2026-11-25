import test from "node:test";
import assert from "node:assert/strict";
import {
  decimalToAtomicUnits,
  atomicUnitsToDecimal,
  solToLamports,
  lamportsToSol
} from "../live-order-units.js";

test("SOL decimal strings convert exactly to lamports", () => {
  assert.equal(solToLamports("1"), 1_000_000_000n);
  assert.equal(solToLamports("0.000000001"), 1n);
  assert.equal(solToLamports("12.340000005"), 12_340_000_005n);
  assert.equal(lamportsToSol(12_340_000_005n), "12.340000005");
  assert.equal(lamportsToSol(1_000_000_000n), "1");
});

test("token amounts use explicit mint decimals and preserve exact units", () => {
  assert.equal(decimalToAtomicUnits("3.125", 6), 3_125_000n);
  assert.equal(atomicUnitsToDecimal(3_125_000n, 6), "3.125");
  assert.equal(decimalToAtomicUnits("9", 0), 9n);
  assert.equal(atomicUnitsToDecimal(9n, 0), "9");
});

test("rejects floating point, exponent, sign, whitespace, and excess precision", () => {
  for (const value of [0.1, "", " 1", "1 ", "-1", "+1", "1e-3", ".5", "01.2"]) {
    assert.throws(() => decimalToAtomicUnits(value, 9));
  }
  assert.throws(() => solToLamports("0.0000000001"), RangeError);
});

test("rejects invalid decimal configuration and negative atomic values", () => {
  for (const decimals of [-1, 256, 1.5, NaN]) {
    assert.throws(() => decimalToAtomicUnits("1", decimals));
    assert.throws(() => atomicUnitsToDecimal(1n, decimals));
  }
  assert.throws(() => atomicUnitsToDecimal(-1n, 9));
  assert.throws(() => atomicUnitsToDecimal(1, 9));
});

test("large exact integer amounts round-trip without Number precision loss", () => {
  const original = "9007199254740993.000000001";
  assert.equal(lamportsToSol(solToLamports(original)), original);
});

test("supports decimals in full uint8 range with bounded input", () => {
  const atomic = decimalToAtomicUnits("1.01", 255);
  assert.equal(atomicUnitsToDecimal(atomic, 255), "1.01");
  assert.throws(() => decimalToAtomicUnits("1".repeat(257), 9), TypeError);
});
