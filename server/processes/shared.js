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

/**
 * Cost build-up accumulator. Every pricing model records each step as
 * { step, minutes, dollars, basis } so the admin order view and the RFQ queue
 * can show WHY a price is what it is. `minutes` is per part unless the basis
 * says otherwise; `dollars` is always per part.
 */
function costBuildup() {
  const steps = [];
  return {
    add(step, { minutes = 0, dollars = 0, basis = "" } = {}) {
      if (!Number.isFinite(dollars)) dollars = 0;
      if (!Number.isFinite(minutes)) minutes = 0;
      steps.push({ step, minutes: round(minutes, 3), dollars: round(dollars, 4), basis });
      return dollars;
    },
    steps,
    minutes: () => steps.reduce((s, x) => s + x.minutes, 0),
    dollars: () => steps.reduce((s, x) => s + x.dollars, 0),
  };
}

function round(v, d = 2) {
  return Number.isFinite(v) ? Number(v.toFixed(d)) : 0;
}

/** Lookup in a map-table rule with a safe fallback. */
function tableValue(table, key, fallback) {
  const v = table && typeof table === "object" ? Number(table[key]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Smallest standard size at or above `value` from a numeric list (or value itself). */
function nextStandard(list, value) {
  const sizes = (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  for (const s of sizes) if (s >= value - 1e-9) return s;
  return value;
}

/**
 * The commercial tail every process shares: quantity discount → multi-part
 * nesting savings → margin → floor. Returns the per-unit block in the shape
 * the client, the harness and the admin view already read.
 *
 * @param {Object} p
 * @param {number} p.perUnitBase — cost per unit before discounts (material + machine + labor + setup + finish + tooling)
 * @param {number} p.materialCost — the material share (nesting savings apply to it only)
 * @param {number} p.quantity
 * @param {number} p.totalPartsInOrder
 * @param {number} p.minimum — per-unit floor
 * @param {Object} rules
 */
function applyCommercialTerms({ perUnitBase, materialCost, quantity, totalPartsInOrder = 1, minimum = 0 }, rules) {
  const qty = Math.max(1, Number(quantity) || 1);
  const tiers = Array.isArray(rules.volumeDiscounts) ? rules.volumeDiscounts : [];
  const discountTier = [...tiers].sort((a, b) => a.minQty - b.minQty).reverse().find((t) => qty >= t.minQty);
  const discountPercent = discountTier ? clampNumber(discountTier.discount, 0, 0.9, 0) : 0;
  const perUnitAfterDiscount = perUnitBase * (1 - discountPercent);
  const nestingDiscount = totalPartsInOrder > 1 ? clampNumber(rules.nestingEfficiencyBonus, 0, 0.9, 0) : 0;
  const materialRatio = perUnitBase > 0 ? materialCost / perUnitBase : 0;
  const perUnitAfterNesting = perUnitAfterDiscount * (1 - nestingDiscount * materialRatio);
  const margin = clampNumber(rules.marginPercent, 0, 0.95, 0.3);
  const perUnitWithMargin = perUnitAfterNesting / (1 - margin);
  const perUnitFinal = Math.max(perUnitWithMargin, clampNumber(minimum, 0, 1e9, 0));
  return {
    discountTier: discountTier?.minQty || 1,
    perUnit: {
      subtotal: perUnitBase,
      discount: discountPercent,
      discountAmount: perUnitBase * discountPercent,
      nestingSavings: perUnitAfterDiscount - perUnitAfterNesting,
      margin: perUnitWithMargin - perUnitAfterNesting,
      final: perUnitFinal,
    },
    floorApplied: perUnitFinal > perUnitWithMargin + 1e-9,
  };
}

/** Finish-record cost: per part + per area, in the units the finish table uses. */
function finishCost(finish, surfaceAreaMm2) {
  if (!finish) return 0;
  const surfaceAreaIn2 = (surfaceAreaMm2 || 0) / 645.16;
  const surfaceAreaDm2 = surfaceAreaIn2 * 0.064516;
  return (finish.pricePerPart || finish.minCost || 0) + surfaceAreaIn2 * (finish.pricePerSqIn || 0) + surfaceAreaDm2 * (finish.costPerDm2 || 0);
}

module.exports = {
  clampNumber, PRINT_SUBPROCESSES, summarizeChecks,
  costBuildup, round, tableValue, nextStandard, applyCommercialTerms, finishCost,
};
