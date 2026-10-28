/**
 * CNC routing pricing — flat / plate parts nested and cut from sheet on the
 * 59" × 96" router.
 *
 * Model (per part):
 *   material  = blank (bbox + kerf margin each side) × thickness × density,
 *               divided by nest yield so sheet waste is paid for
 *   cut time  = profile length × passes ÷ feed (feed by material class)
 *               + hole plunges + tool changes + handling
 *   machine   = cut time × router rate
 *   tool wear = $/meter of cut (× 3 for abrasive stock)
 *   setup     = per-job setup amortized over quantity
 *   finish    = per-part + per-area, from the finish record
 * then the shared volume-discount / nesting / margin / minimum steps the other
 * processes use, so a routing line item has the same shape as any other.
 *
 * @param {Object} params
 * @param {Object} params.geometry   — parsed geometry (mm): flatWidth, flatHeight,
 *                                     flatArea, estimatedPerimeter, estimatedHoles, surfaceArea
 * @param {Object} params.material   — routing material record (feedClass, pricePerKg, grades[])
 * @param {number} params.thicknessMm
 * @param {string} params.grade
 * @param {Object} params.finish
 * @param {number} params.quantity
 * @param {number} [params.totalPartsInOrder]
 * @param {Object} rules — pricing rules
 */
function calculate(params, rules) {
  const {
    geometry,
    material,
    thicknessMm: thicknessIn = 0,
    grade,
    finish,
    quantity,
    totalPartsInOrder = 1,
  } = params;
  const r = rules;
  const qty = Math.max(1, Number(quantity) || 1);

  const gradeData = (material.grades || []).find((g) => g.name === grade) || (material.grades || [])[0] || { density: 0.04 };
  const density = gradeData.density; // lb/in³

  // Thickness: use the selected one, else the part's own smallest dimension, else 1/4".
  const bb = geometry.boundingBox || {};
  const smallestDim = Math.min(bb.width || Infinity, bb.height || Infinity, bb.depth || Infinity);
  const thicknessMm = thicknessIn > 0 ? thicknessIn : (Number.isFinite(smallestDim) && smallestDim > 0 ? smallestDim : 6.35);

  const flatWidth = geometry.flatWidth || bb.width || 100;
  const flatHeight = geometry.flatHeight || bb.height || 100;
  const flatAreaMm2 = geometry.flatArea || flatWidth * flatHeight;

  // ─── 1. MATERIAL (blank + nest waste) ──────────
  const kerf = r.routerKerfMarginMm || 6.0;
  const blankAreaMm2 = (flatWidth + 2 * kerf) * (flatHeight + 2 * kerf);
  const blankVolumeIn3 = (blankAreaMm2 * thicknessMm) / 16387.064;
  const blankWeightLb = blankVolumeIn3 * density;
  const blankWeightKg = blankWeightLb * 0.4536;
  const nestYield = r.routerNestYield || 0.85;
  const materialCost = (blankWeightKg / nestYield) * (material.pricePerKg || material.costPerKg || 6.0);

  // Shipped weight is the part itself, not the blank.
  const partWeightKg = ((flatAreaMm2 * thicknessMm) / 16387.064) * density * 0.4536;

  // ─── 2. CUT TIME ───────────────────────────────
  const feedClass = material.feedClass || "medium";
  const feedTable = r.routerFeedMmPerMin || {};
  const feed = feedTable[feedClass] || feedTable.medium || 3800; // mm/min
  const maxPass = feedClass === "aluminum" ? 1.5 : (r.routerMaxPassDepthMm || 6.0);
  const passes = Math.max(1, Math.ceil(thicknessMm / maxPass));

  const profileMm = geometry.estimatedPerimeter || 2 * (flatWidth + flatHeight);
  const holes = geometry.estimatedHoles || 0;
  const slots = geometry.estimatedSlots || 0;
  // Interpolated holes/slots add cut length too (assume ~Ø10 mm average).
  const featureCutMm = (holes + slots) * Math.PI * 10;
  const cutLengthMm = (profileMm + featureCutMm) * passes;

  const cutMinutes = cutLengthMm / feed;
  const holeMinutes = (holes * (r.routerHoleSeconds || 4)) / 60;
  const toolChangeMinutes = (2 * (r.routerToolChangeSeconds || 12)) / 60;
  const handlingMinutes = r.routerHandlingMinutesPerPart || 0.5;
  const cycleMinutes = cutMinutes + holeMinutes + toolChangeMinutes + handlingMinutes;

  const machineCost = (cycleMinutes / 60) * (r.routerMachineRatePerHour || 95.0);

  // ─── 3. TOOL WEAR ──────────────────────────────
  const wearMult = feedClass === "abrasive" ? 3 : feedClass === "aluminum" ? 1.5 : 1;
  const toolingCost = (cutLengthMm / 1000) * (r.routerToolWearPerMeter || 0.35) * wearMult;

  // ─── 4. SETUP (amortized) ──────────────────────
  const setupPerUnit = (r.routerSetupCost || 60.0) / qty;

  // ─── 5. FINISH ─────────────────────────────────
  const surfaceAreaIn2 = (geometry.surfaceArea || flatAreaMm2 * 2) / 645.16;
  const surfaceAreaDm2 = surfaceAreaIn2 * 0.064516;
  const finishCost = finish
    ? (finish.pricePerPart || finish.minCost || 0) + surfaceAreaIn2 * (finish.pricePerSqIn || 0) + surfaceAreaDm2 * (finish.costPerDm2 || 0)
    : 0;

  // ─── PER-UNIT SUBTOTAL ─────────────────────────
  const perUnitBase = materialCost + machineCost + toolingCost + setupPerUnit + finishCost;

  // ─── 6. VOLUME DISCOUNT ────────────────────────
  const discountTier = [...(r.volumeDiscounts || [])].reverse().find((t) => qty >= t.minQty);
  const discountPercent = discountTier ? discountTier.discount : 0;
  const perUnitAfterDiscount = perUnitBase * (1 - discountPercent);

  // ─── 7. NESTING SAVINGS (multi-part orders share sheets) ──
  const nestingDiscount = totalPartsInOrder > 1 ? (r.nestingEfficiencyBonus || 0) : 0;
  const materialRatio = perUnitBase > 0 ? materialCost / perUnitBase : 0;
  const perUnitAfterNesting = perUnitAfterDiscount * (1 - nestingDiscount * materialRatio);

  // ─── 8. MARGIN ─────────────────────────────────
  const perUnitWithMargin = perUnitAfterNesting / (1 - (r.marginPercent || 0.3));

  // ─── 9. MINIMUM ────────────────────────────────
  const perUnitFinal = Math.max(perUnitWithMargin, r.routerMinimumPartPrice || r.minimumPartPrice || 5);

  const lineTotal = perUnitFinal * qty;

  // Parts per 48" × 96" sheet (either orientation), for the admin/meta view.
  const sheetW = 1219, sheetH = 2438;
  const pw = flatWidth + kerf, ph = flatHeight + kerf;
  const perSheet = Math.max(
    Math.floor(sheetW / pw) * Math.floor(sheetH / ph),
    Math.floor(sheetW / ph) * Math.floor(sheetH / pw),
    0
  );

  return {
    perUnit: {
      material: materialCost,
      cutting: machineCost,
      tooling: toolingCost,
      setup: setupPerUnit,
      finish: finishCost,
      subtotal: perUnitBase,
      discount: discountPercent,
      discountAmount: perUnitBase * discountPercent,
      nestingSavings: perUnitAfterDiscount - perUnitAfterNesting,
      margin: perUnitWithMargin - perUnitAfterNesting,
      final: perUnitFinal,
    },
    quantity: qty,
    lineTotal,
    weight: { perUnit: partWeightKg, total: partWeightKg * qty, units: "kg" },
    meta: {
      process: "routing",
      subProcess: "sheet",
      materialSlug: material.slug,
      grade,
      thicknessMm,
      feedClass,
      passes,
      cutLengthMm: Math.round(cutLengthMm),
      cycleMinutes: Number(cycleMinutes.toFixed(2)),
      partsPerSheet: perSheet,
      finishSlug: finish?.slug || "rt-as-cut",
      discountTier: discountTier?.minQty || 1,
    },
  };
}

module.exports = { calculate };
