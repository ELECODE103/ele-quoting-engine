/**
 * Shared leaf helpers used by per-process pricing/DFM modules.
 *
 * This module has NO dependencies on the pricing engine, file parser, or
 * registry — it is a pure leaf so process folders can require it without
 * introducing cycles.
 */

/**
 * Coerce a value to a finite number within [min, max]; return `fallback`
 * (unclamped) when the input is missing, non-numeric, or non-finite.
 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const PRINT_SUBPROCESSES = ["fdm", "sla", "sls"];

/**
 * Two-tier DFM summary.
 *
 * Severity tiers:
 *   - "pass"  — meets the guideline.
 *   - "info"  — advisory/capability note. NOT a problem; excluded from the score.
 *   - "warn"  — makeable, but affects cost/quality/lead time. Never blocks.
 *   - "fail"  — genuinely un-manufacturable as-is. BLOCKS (manufacturable=false).
 *
 * Score is computed over scored checks only (info excluded), with warnings counted
 * at half weight, so a clean part with advisory notes still scores ~100%.
 */
function summarizeChecks(checks) {
  const passCount = checks.filter((c) => c.severity === "pass").length;
  const infoCount = checks.filter((c) => c.severity === "info").length;
  const warnCount = checks.filter((c) => c.severity === "warn").length;
  const failCount = checks.filter((c) => c.severity === "fail").length;
  const scored = passCount + warnCount + failCount;
  const score = scored === 0 ? 100 : Math.round((100 * (passCount + 0.5 * warnCount)) / scored);
  return {
    passCount,
    infoCount,
    warnCount,
    failCount,
    totalChecks: checks.length,
    manufacturable: failCount === 0,
    score,
  };
}

module.exports = { clampNumber, PRINT_SUBPROCESSES, summarizeChecks };
