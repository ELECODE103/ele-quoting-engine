/**
 * Pricing Engine — calculates instant quotes from geometry + configuration.
 *
 * Each process folder (server/processes/<slug>/pricing.js) builds a line item
 * bottom-up from the part's features — stock, setups, roughing, finishing,
 * holes, pockets, walls, handling, inspection — using the rate card declared
 * in server/config/ruleSchema.js (see docs/pricing-models.md). This class
 * dispatches to those models, builds quantity-break tables and rolls line
 * items into an order (shipping, lead-time surcharge, order minimum).
 *
 * Rules are a plain object keyed by rule name; pass `ruleSchema.mergeRules(stored)`
 * so a stored (admin-tuned) blob is always complete and clamped.
 */

const { DEFAULT_PRICING_RULES } = require("../config/defaults");
const { resolveProcess } = require("../processes/registry");
const dxf = require("../geometry/dxf");
const shipping = require("./shipping");

// Back-compat map from legacy PricingEngine method names to the standalone
// pricing module `calculate` functions. Used to dispatch process definitions
// that were registered with a `priceMethod` name string (no `pricing.calculate`).
const PRICE_METHOD_CALCULATORS = {
  calculateSheetMetalPrice: require("../processes/sheetmetal/pricing").calculate,
  calculateCNCPrice: require("../processes/cnc/pricing").calculate,
  calculatePrintPrice: require("../processes/3d-printing/pricing").calculate,
};

/**
 * Inspection paperwork the customer asks for on the quote (owner, 2026-11-11):
 * a first-article inspection report per part number and one certificate of
 * conformance per order.
 *
 *   fee = paperworkFeePerPart × part numbers (quote lines, not pieces) + paperworkFeePerOrder
 *
 * Charged at face value: it is added after margin, after the lead-time
 * surcharge and after the order minimum, so none of them scales or absorbs it,
 * and quantity breaks never touch it.
 *
 * @returns {{ perPart:number, perOrder:number, parts:number, fee:number }} what the option costs for this many lines
 */
function paperworkCharge(lineCount, rules = {}) {
  const dollars = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
  const parts = Math.max(0, Math.floor(Number(lineCount) || 0));
  const perPart = dollars(rules.paperworkFeePerPart);
  const perOrder = dollars(rules.paperworkFeePerOrder);
  return { perPart, perOrder, parts, fee: parts > 0 ? Math.round((perPart * parts + perOrder) * 100) / 100 : 0 };
}

/** A dollar amount in whole cents (NaN and Infinity pass through for the sanity guard to catch). */
function cents(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}

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
    // No process, or one the registry does not know, is refused (resolveProcess throws): a part
    // is never priced by a model picked for it by default.
    const def = resolveProcess(params.process);
    const calculate =
      (def.pricing && def.pricing.calculate) ||
      PRICE_METHOD_CALCULATORS[def.priceMethod];
    if (typeof calculate !== "function") throw new Error(`Process ${def.slug} has no pricing model`);
    // 2D input (DXF): extrude the profile to the selected stock thickness so
    // the routing model sees the same features a STEP plate gives it.
    if (dxf.is2D(params.geometry)) {
      if (def.slug !== "routing") throw new Error("A DXF is a 2D profile and can only be priced for CNC routing");
      if (!(Number(params.thicknessMm) > 0)) throw new Error("A DXF part needs a stock thickness before it can be priced");
      params = { ...params, geometry: dxf.materialize(params.geometry, params.thicknessMm) };
    }
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
   * `paperwork: true` adds the inspection-paperwork fee (see paperworkCharge)
   * as its own line; `paperworkOffer` says what the option costs either way.
   */
  calculateOrderQuote({ parts, leadTimeMultiplier = 1.0, paperwork = false }) {
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
        // A model's line total can carry a fraction of a cent. The customer is shown, and
        // charged, whole cents, so the line is settled to the cent here and the subtotal is
        // the sum of those lines.
        lineTotal: cents(price.lineTotal),
        quantityBreaks: this.quantityPriceBreaks({ ...part, totalPartsInOrder }),
      };
    });

    const subtotal = cents(lineItems.reduce((sum, li) => sum + li.lineTotal, 0));
    const totalWeight = lineItems.reduce((sum, li) => sum + li.weight.total, 0);

    // Shipping: how the "we ship it" line is charged is a setting (services/shipping.js). The default,
    // "formula", is r.shippingBaseRate + totalWeight * r.shippingPerKg, the same expression this
    // line always held. A manual result (oversize, overweight, weight unknown) carries no amount.
    const shippingQuote = shipping.forQuote({ parts, totalWeightKg: totalWeight, subtotal }, r);
    const shippingEstimate = shippingQuote.amount;

    // Lead time surcharge
    const leadTimeSurcharge = subtotal * (leadTimeMultiplier - 1);

    // Inspection paperwork, when asked for: its own line, at face value.
    const paperworkOffer = paperworkCharge(lineItems.length, r);
    const paperworkOn = paperwork === true;
    const paperworkFee = paperworkOn ? paperworkOffer.fee : 0;

    // Order total: the sum of the amounts as the customer sees them, each in
    // whole cents, so the figures on the quote, the checkout page, the order,
    // the emails and the documents add up to the total exactly (added first
    // and rounded after, three printed figures could miss the printed total
    // by a cent). The order minimum applies to the parts, the lead-time fee
    // and shipping; the paperwork fee is added after it, so ticking the box
    // always adds exactly the fee shown.
    const orderTotal = cents(Math.max(
      subtotal + cents(leadTimeSurcharge) + cents(shippingEstimate),
      r.minimumOrderTotal
    ) + paperworkFee);

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
      shipping: shippingQuote,
      paperwork: paperworkOn,
      paperworkFee,
      paperworkOffer,
      totalWeight,
      orderTotal,
      partCount: parts.length,
      totalUnits: parts.reduce((sum, p) => sum + p.quantity, 0),
      nestingApplied: totalPartsInOrder > 1,
    };
  }
}

module.exports = { PricingEngine, paperworkCharge };
