/**
 * Pricing Engine — calculates instant quotes from geometry + configuration.
 *
 * Factors:
 *  1. Material cost (weight × price/kg)
 *  2. Laser cutting cost (perimeter × rate, scaled by thickness)
 *  3. Bend cost (count × rate)
 *  4. Hole/feature cost
 *  5. Finish cost (per-part + per-area)
 *  6. Volume discounts
 *  7. Nesting savings (multi-part orders)
 *  8. Margin
 *  9. Lead time multiplier
 */

const { DEFAULT_PRICING_RULES } = require("../config/defaults");
const { resolveProcess } = require("../processes/registry");

// Back-compat map from legacy PricingEngine method names to the standalone
// pricing module `calculate` functions. Used to dispatch process definitions
// that were registered with a `priceMethod` name string (no `pricing.calculate`).
const PRICE_METHOD_CALCULATORS = {
  calculateSheetMetalPrice: require("../processes/sheetmetal/pricing").calculate,
  calculateCNCPrice: require("../processes/cnc/pricing").calculate,
  calculatePrintPrice: require("../processes/3d-printing/pricing").calculate,
};

class PricingEngine {
  constructor(rules = null) {
    this.rules = rules || DEFAULT_PRICING_RULES;
  }

  /**
   * Router for calculatePartPrice — dispatches via the process registry.
   * Each process folder owns its pricing logic (def.pricing.calculate); a
   * process registered by legacy method-name (def.priceMethod) is resolved via
   * the back-compat map. Adding a process needs no edit to this dispatch.
   *
   * @param {Object} params
   * @param {string} [params.process] — process slug ('sheetmetal', 'cnc', '3d-printing', …)
   * @returns {Object} detailed price breakdown
   */
  calculatePartPrice(params) {
    const def = resolveProcess(params.process || 'sheetmetal');
    const calculate =
      (def.pricing && def.pricing.calculate) ||
      PRICE_METHOD_CALCULATORS[def.priceMethod] ||
      PRICE_METHOD_CALCULATORS.calculateSheetMetalPrice;
    return calculate(params, this.rules);
  }

  /**
   * Per-unit price at a set of quantities, for a "quantity breaks" table.
   * Reuses calculatePartPrice so it always tracks the live pricing model.
   *
   * @returns {Array<{qty:number, perUnit:number, lineTotal:number}>}
   */
  quantityPriceBreaks(part, breakpoints = [1, 5, 10, 25, 50, 100]) {
    return breakpoints.map((qty) => {
      const price = this.calculatePartPrice({ ...part, quantity: qty });
      return {
        qty,
        perUnit: price.perUnit.final,
        lineTotal: price.lineTotal,
      };
    });
  }

  /**
   * Calculate a full order quote (multiple parts).
   */
  calculateOrderQuote({ parts, leadTimeMultiplier = 1.0 }) {
    const r = this.rules;
    const totalPartsInOrder = parts.length;

    const lineItems = parts.map((part) => {
      const price = this.calculatePartPrice({
        ...part,
        totalPartsInOrder,
      });
      return {
        partId: part.partId,
        fileName: part.fileName,
        ...price,
        quantityBreaks: this.quantityPriceBreaks({ ...part, totalPartsInOrder }),
      };
    });

    const subtotal = lineItems.reduce((sum, li) => sum + li.lineTotal, 0);
    const totalWeight = lineItems.reduce((sum, li) => sum + li.weight.total, 0);

    // Shipping estimate
    const shippingEstimate = r.shippingBaseRate + totalWeight * r.shippingPerKg;

    // Lead time surcharge
    const leadTimeSurcharge = subtotal * (leadTimeMultiplier - 1);

    // Order total
    const orderTotal = Math.max(
      subtotal + leadTimeSurcharge + shippingEstimate,
      r.minimumOrderTotal
    );

    // ─── SANITY GUARD ──────────────────────────
    // Never let a NaN/Infinity/negative price be persisted or reach checkout.
    const badLine = lineItems.find(
      (li) => !Number.isFinite(li.lineTotal) || li.lineTotal < 0
    );
    if (badLine) {
      throw new Error(
        `Pricing produced an invalid line total for part ${badLine.partId || badLine.fileName || "?"}`
      );
    }
    if (!Number.isFinite(orderTotal) || orderTotal < 0) {
      throw new Error("Pricing produced an invalid order total");
    }

    return {
      lineItems,
      subtotal,
      leadTimeMultiplier,
      leadTimeSurcharge,
      shippingEstimate,
      totalWeight,
      orderTotal,
      partCount: parts.length,
      totalUnits: parts.reduce((sum, p) => sum + p.quantity, 0),
      nestingApplied: totalPartsInOrder > 1,
    };
  }
}

module.exports = { PricingEngine };
