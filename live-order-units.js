/**
 * Exact decimal <-> integer atomic-unit conversion for future live orders.
 * This module performs no wallet access or transaction execution.
 */
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

export function decimalToAtomicUnits(value, decimals) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError("Amount must be a bounded decimal string");
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("Decimals must be an integer from 0 through 255");
  }
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new TypeError("Amount must be a non-negative plain decimal");
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new RangeError("Amount has more fractional digits than the mint supports");
  }
  const scale = 10n ** BigInt(decimals);
  const fractionalUnits = fraction.length
    ? BigInt(fraction.padEnd(decimals, "0"))
    : 0n;
  return BigInt(whole) * scale + fractionalUnits;
}

export function atomicUnitsToDecimal(units, decimals) {
  if (typeof units !== "bigint" || units < 0n) {
    throw new TypeError("Atomic units must be a non-negative bigint");
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("Decimals must be an integer from 0 through 255");
  }
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  if (decimals === 0) return whole.toString();
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function solToLamports(value) {
  return decimalToAtomicUnits(value, 9);
}

export function lamportsToSol(lamports) {
  return atomicUnitsToDecimal(lamports, 9);
}
