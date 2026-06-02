/**
 * CNC pricing. Moved verbatim from PricingEngine.calculateCNCPrice.
 *
 * @param {Object} params
 * @param {Object} params.geometry — parsed geometry (volume in mm³, bounding box)
 * @param {Object} params.material — CNC material record with machinability, pricePerKg, grades[]
 * @param {string} params.grade — selected grade name
 * @param {Object} params.finish — finish record from DB
 * @param {number} params.quantity — number of units
 * @param {string} [params.subProcess] — 'turning' or 'milling' (affects timing)
 * @param {number} [params.totalPartsInOrder] — for discount calculation
 * @param {Object} rules — pricing rules
 * @returns {Object} detailed price breakdown
 */
function calculate(params, rules) {
  const {
    geometry,
    material,
    grade,
    finish,
    quantity,
    subProcess = 'milling',
    totalPartsInOrder = 1,
  } = params;
  const r = rules;
  const gradeData = material.grades.find((g) => g.name === grade) || material.grades[0];
  const density = gradeData.density; // lb/in³
  const machinability = material.machinability || 1.0;

  // ─── 1. STOCK VOLUME & WEIGHT ──────────────
  // Bounding box from geometry (handle nested boundingBox structure from parser)
  const bb = geometry.boundingBox || {};
  const bbox = {
    width: bb.width || geometry.flatWidth || geometry.width || 100, // mm
    height: bb.height || geometry.flatHeight || geometry.height || 100,
    depth: bb.depth || geometry.estimatedThickness || geometry.depth || 50,
  };
  const padding = r.cncStockPaddingMm || 3.0;

  // Stock dimensions in mm, then convert to cm
  const stockWidthMm = bbox.width + 2 * padding;
  const stockHeightMm = bbox.height + 2 * padding;
  const stockDepthMm = bbox.depth + 2 * padding;

  const stockVolumeMm3 = stockWidthMm * stockHeightMm * stockDepthMm;
  const stockVolumeIn3 = stockVolumeMm3 / 16387.064;
  const weightLb = stockVolumeIn3 * density;
  const weightKg = weightLb * 0.4536;

  const materialCost = weightKg * (material.pricePerKg || material.costPerKg || 1.0);

  // ─── 2. MATERIAL REMOVAL & MACHINE TIME ────
  const partVolumeMm3 = geometry.volume || (bbox.width * bbox.height * bbox.depth * 0.5); // estimate if not provided
  const partVolumeCm3 = partVolumeMm3 / 1000;
  const stockVolumeCm3 = stockVolumeMm3 / 1000;
  const removalVolumeCm3 = stockVolumeCm3 - partVolumeCm3;

  const cncRoughingRate = r.cncRoughingRate || 25.0; // cm³/hr
  const cncFinishingRate = r.cncFinishingRate || 8.0;
  const cncFinishingPassRatio = r.cncFinishingPassRatio || 0.15;

  let machineTimeRoughing = removalVolumeCm3 / (cncRoughingRate * machinability);
  let machineTimeFinishing = (stockVolumeCm3 * cncFinishingPassRatio) / (cncFinishingRate * machinability);
  let totalMachineTime = machineTimeRoughing + machineTimeFinishing;

  // Apply turning multiplier if applicable
  if (subProcess === 'turning') {
    const turningMult = r.cncTurningMultiplier || 0.85;
    totalMachineTime *= turningMult;
  }

  // Enforce minimum machine time
  const minimumTime = r.cncMinimumMachineTime || 0.25;
  totalMachineTime = Math.max(totalMachineTime, minimumTime);

  const machineCost = totalMachineTime * (r.cncMachineRatePerHour || 85.0);

  // ─── 3. TOOLING COST ───────────────────────
  const toolingCostBase = r.cncToolingCostBase || 5.0;
  const toolingScaleFactor = r.cncToolingMachinabilityScale || 2.0;
  const toolingCost = toolingCostBase * (toolingScaleFactor / machinability);

  // ─── 4. SETUP COST (amortized) ─────────────
  const setupPerUnit = (r.cncSetupCost || 35.0) / quantity;

  // ─── 5. FINISH COST ────────────────────────
  const surfaceAreaIn2 = (geometry.surfaceArea || (bbox.width * bbox.height * 2)) / 645.16;
  const surfaceAreaDm2 = surfaceAreaIn2 * 0.064516; // in² to dm²
  const finishCost = finish
    ? (finish.pricePerPart || finish.minCost || 0) + surfaceAreaIn2 * (finish.pricePerSqIn || 0) + surfaceAreaDm2 * (finish.costPerDm2 || 0)
    : 0;

  // ─── PER-UNIT SUBTOTAL ─────────────────────
  const perUnitBase = materialCost + machineCost + toolingCost + setupPerUnit + finishCost;

  // ─── 6. VOLUME DISCOUNT ────────────────────
  const discountTier = [...r.volumeDiscounts]
    .reverse()
    .find((t) => quantity >= t.minQty);
  const discountPercent = discountTier ? discountTier.discount : 0;
  const perUnitAfterDiscount = perUnitBase * (1 - discountPercent);

  // ─── 7. NESTING/BATCHING SAVINGS ───────────
  const nestingDiscount = totalPartsInOrder > 1 ? r.nestingEfficiencyBonus : 0;
  const materialRatio = perUnitBase > 0 ? materialCost / perUnitBase : 0;
  const perUnitAfterNesting = perUnitAfterDiscount * (1 - nestingDiscount * materialRatio);

  // ─── 8. APPLY MARGIN ───────────────────────
  const perUnitWithMargin = perUnitAfterNesting / (1 - r.marginPercent);

  // ─── 9. ENFORCE MINIMUM ────────────────────
  const perUnitFinal = Math.max(perUnitWithMargin, r.minimumPartPrice);

  // ─── TOTAL ─────────────────────────────────
  const lineTotal = perUnitFinal * quantity;

  return {
    perUnit: {
      material: materialCost,
      machining: machineCost,
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
    quantity,
    lineTotal,
    weight: {
      perUnit: weightKg,
      total: weightKg * quantity,
      units: 'kg',
    },
    meta: {
      process: 'cnc',
      materialSlug: material.slug,
      grade,
      machinability,
      machineTimeHours: totalMachineTime,
      finishSlug: finish?.slug || 'raw',
      subProcess,
      discountTier: discountTier?.minQty || 1,
    },
  };
}

module.exports = { calculate };
