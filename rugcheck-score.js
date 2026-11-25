/**
 * RugCheck score validation for fail-closed token risk inspection.
 * Accept numeric scores and numeric strings; reject missing, NaN, negative,
 * or scores above the configured threshold.
 */
export function isAcceptableRugCheckScore(value, maxScore = 2500) {
  if (value === null || value === undefined || typeof value === "boolean" ||
      (typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && value.trim() === "")) return false;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 &&
    Number.isFinite(maxScore) && maxScore >= 0 && score <= maxScore;
}
