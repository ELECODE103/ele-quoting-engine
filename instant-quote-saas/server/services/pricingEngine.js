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

class PricingEngine {
  constructor(rules = null) {
    this.rules = rules || DEFAULT_PRICING_RULES;
  }

  /**
   * Calculate the price for a single part configuration.
   *
   * @param {Object} params
   * @param {Object} params.geometry — parsed geometry from fileParser
   * @param {Object} params.material — material record from DB
   * @param {number} params.thicknessMm — selected thickness in mm
   * @param {string} params.grade — selected grade name
   * @param {Object} params.finish — finish record from DB
   * @param {number} params.quantity — number of units
   * @param {number} [params.totalPartsInOrder] — for nesting discount
   * @returns {Object} detailed price breakdown
   */
  calculatePartPrice({
    geometry,
    material,
    thicknessMm,
    grade,
    finish,
    quantity,
    totalPartsInOrder = 1,
  }) {
    const r = this.rules;
    const gradeData = material.grades.find((g) => g.name === grade) || material.grades[0];
    const density = gradeData.density; // lb/in³

    // ─── 1. MATERIAL COST ──────────────────────
    // Convert geometry (in mm) to compute weight
    const flatAreaMm2 = geometry.flatArea || (geometry.flatWidth * geometry.flatHeight);
    const flatAreaIn2 = flatAreaMm2 / 645.16;
    const thicknessIn = thicknessMm / 25.4;
    const volumeIn3 = flatAreaIn2 * thicknessIn;
    const weightLb = volumeIn3 * density;
    const weightKg = weightLb * 0.4536;
    const materialCost = weightKg * material.pricePerKg;

    // ─── 2. LASER CUTTING COST ─────────────────
    const perimeterMm = geometry.estimatedPerimeter || 0;
    const thicknessFactor = Math.pow(thicknessMm, r.laserThicknessExponent);
    const cutCost = perimeterMm * r.laserCutRatePerMm * thicknessFactor;

    // ─── 3. BEND COST ──────────────────────────
    const bends = geometry.estimatedBends || 0;
    const bendCost = bends * (r.bendBaseCost + thicknessMm * r.bendThicknessMultiplier);

    // ─── 4. HOLE/FEATURE COST ──────────────────
    const holes = geometry.estimatedHoles || 0;
    const slots = geometry.estimatedSlots || 0;
    const holeCost = holes * r.holeBaseCost + slots * r.holeBaseCost * 1.5;

    // ─── 5. FINISH COST ────────────────────────
    const surfaceAreaIn2 = (geometry.surfaceArea || flatAreaMm2 * 2) / 645.16;
    const finishCost = finish
      ? finish.pricePerPart + surfaceAreaIn2 * finish.pricePerSqIn
      : 0;

    // ─── PER-UNIT SUBTOTAL ─────────────────────
    const perUnitBase = materialCost + cutCost + bendCost + holeCost + finishCost;

    // ─── 6. VOLUME DISCOUNT ────────────────────
    const discountTier = [...r.volumeDiscounts]
      .reverse()
      .find((t) => quantity >= t.minQty);
    const discountPercent = discountTier ? discountTier.discount : 0;
    const perUnitAfterDiscount = perUnitBase * (1 - discountPercent);

    // ─── 7. NESTING SAVINGS ────────────────────
    const nestingDiscount = totalPartsInOrder > 1 ? r.nestingEfficiencyBonus : 0;
    const perUnitAfterNesting = perUnitAfterDiscount * (1 - nestingDiscount * (materialCost / perUnitBase));

    // ─── 8. APPLY MARGIN ───────────────────────
    const perUnitWithMargin = perUnitAfterNesting / (1 - r.marginPercent);

    // ─── 9. ENFORCE MINIMUM ────────────────────
    const perUnitFinal = Math.max(perUnitWithMargin, r.minimumPartPrice);

    // ─── TOTAL ─────────────────────────────────
    const lineTotal = perUnitFinal * quantity;

    return {
      perUnit: {
        material: materialCost,
        cutting: cutCost,
        bending: bendCost,
        holes: holeCost,
        finish: finishCost,
        subtotal: perUnitBase,
        discount: discountPercent,
        discountAmount: perUnitBase * discountPercent,
        nestingSavings: perUnitAfterDiscount - perUnitAfterNesting,
        margin: perUnitWithMargin - perUnitAfterNesting,
        final: perUnitFinal,
      },
      quantity,
      lineTotal,
      weight: {
        perUnit: weightKg,
        total: weightKg * quantity,
        units: "kg",
      },
      meta: {
        materialSlug: material.slug,
        grade,
        thicknessMm,
        finishSlug: finish?.slug || "raw",
        discountTier: discountTier?.minQty || 1,
      },
    };
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
