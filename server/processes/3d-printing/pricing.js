/**
 * 3D printing pricing. Moved verbatim from PricingEngine.calculatePrintPrice.
 *
 * @param {Object} params
 * @param {Object} params.geometry — parsed geometry (volume in mm³, bounding box)
 * @param {Object} params.material — 3D printing material record with density, pricePerCm3, layerHeights, defaultLayerHeight, subProcess
 * @param {Object} params.finish — finish record from DB
 * @param {number} params.quantity — number of units
 * @param {number} [params.layerHeight] — layer height in mm (overrides default)
 * @param {number} [params.infill] — infill percentage for FDM (0.0–1.0)
 * @param {number} [params.totalPartsInOrder] — for discount calculation
 * @param {Object} rules — pricing rules
 * @returns {Object} detailed price breakdown
 */
const { clampNumber, PRINT_SUBPROCESSES } = require("../shared");

function calculate(params, rules) {
  const {
    geometry,
    material,
    finish,
    quantity,
    layerHeight,
    infill,
    totalPartsInOrder = 1,
  } = params;
  const r = rules;
  const materialDensity = clampNumber(material.density, 0.1, 25, 1.2); // g/cm³

  // Layer height: honor a valid override, else material default, else 0.2mm.
  // Clamped to a printable band so it can never be 0 (divide-by-zero in time calc).
  const layerHeightMm = clampNumber(
    layerHeight > 0 ? layerHeight : material.defaultLayerHeight,
    0.02, 1.0, 0.2
  );

  // Normalize sub-process so an unknown/typo value can never fall through the
  // branch below and leave material/time undefined → NaN quote.
  let subProcess = String(material.subProcess || 'fdm').toLowerCase();
  if (!PRINT_SUBPROCESSES.includes(subProcess)) subProcess = 'fdm';

  // Bounding box from geometry (handle nested boundingBox structure from parser)
  const bb = geometry.boundingBox || {};
  const bbox = {
    width: clampNumber(bb.width || geometry.flatWidth || geometry.width, 0.01, 1e6, 100), // mm
    height: clampNumber(bb.height || geometry.flatHeight || geometry.height, 0.01, 1e6, 100),
    depth: clampNumber(bb.depth || geometry.estimatedThickness || geometry.depth, 0.01, 1e6, 50),
  };

  // Volume must be a positive finite number. A non-manifold mesh can yield a
  // negative signed volume (truthy → would flow straight through), so guard it.
  let partVolumeMm3 = Number(geometry.volume);
  if (!Number.isFinite(partVolumeMm3) || partVolumeMm3 <= 0) {
    partVolumeMm3 = bbox.width * bbox.height * bbox.depth * 0.4; // fallback estimate
  }
  const partVolumeCm3 = partVolumeMm3 / 1000;
  // Cross-sectional area proxy (mm² → cm²) for layer-based scan/exposure time.
  const layerAreaCm2 = (bbox.width * bbox.height) / 100;

  let materialVolumeCm3;
  let supportVolumeCm3 = 0;
  let printTimeHours = 0;
  let machineRatePerHour;

  // ─── PROCESS-SPECIFIC LOGIC ────────────────
  // subProcess is normalized to one of fdm/sla/sls above, so the chain is total.
  if (subProcess === 'fdm') {
    // FDM: infill + shells. A missing/0/NaN infill falls back to the default
    // (the old `infill || 0` path silently priced every part at 0% infill).
    const fdmInfillPercent = clampNumber(infill, 0.05, 1.0, (r.fdmInfillPercent || 0.2));
    const effectiveVolume = partVolumeCm3 * (fdmInfillPercent + 0.3); // 0.3 = shell/perimeter estimate
    supportVolumeCm3 = effectiveVolume * (r.fdmSupportMaterialRatio || 0.15);
    materialVolumeCm3 = effectiveVolume;

    // Print time: simplified from material volume
    const fdmPrintSpeed = r.fdmPrintSpeedMmPerSec || 60;
    printTimeHours = (materialVolumeCm3 * 1000) / (fdmPrintSpeed * layerHeightMm * 0.4 * 3600);
    machineRatePerHour = r.fdmMachineRatePerHour || 8.0;
  } else if (subProcess === 'sla') {
    // SLA: fully cured parts + supports
    materialVolumeCm3 = partVolumeCm3;
    supportVolumeCm3 = partVolumeCm3 * (r.slaSupportMaterialRatio || 0.1);

    // Time = layers × (fixed peel/exposure + area-dependent scan). The area term
    // means a wide cross-section costs more than a thin pin of equal height.
    const numberOfLayers = bbox.depth / layerHeightMm;
    const slaLayerTime = r.slaLayerTimeSec || 8;
    const slaScanPerCm2 = r.slaScanTimeSecPerCm2 || 1.5;
    printTimeHours = (numberOfLayers * (slaLayerTime + slaScanPerCm2 * layerAreaCm2)) / 3600;
    machineRatePerHour = r.slaMachineRatePerHour || 20.0;
  } else { // 'sls'
    // SLS: powder cost = fused part volume + the un-fused powder that can't be
    // reclaimed (most loose powder is recycled into the next build, ~50% for PA12).
    const packingEff = clampNumber(r.slsPackingEfficiency, 0.01, 1.0, 0.08);
    const reuse = clampNumber(r.slsPowderReuseRatio, 0, 0.95, 0.5);
    const unfusedShare = (1 / packingEff) - 1;
    materialVolumeCm3 = partVolumeCm3 * (1 + unfusedShare * (1 - reuse));

    const numberOfLayers = bbox.depth / layerHeightMm;
    const slsLayerTime = r.slsLayerTimeSec || 12;
    const slsScanPerCm2 = r.slsScanTimeSecPerCm2 || 2.0;
    printTimeHours = (numberOfLayers * (slsLayerTime + slsScanPerCm2 * layerAreaCm2)) / 3600;
    machineRatePerHour = r.slsMachineRatePerHour || 35.0;
  }

  // ─── COST CALCULATIONS ─────────────────────
  const totalMaterialVolume = materialVolumeCm3 + supportVolumeCm3;
  const materialCost = totalMaterialVolume * (material.pricePerCm3 || 0.1);
  const machineCost = printTimeHours * machineRatePerHour;

  // ─── 4. SETUP COST (amortized) ─────────────
  const setupPerUnit = (r.printSetupCost || 5.0) / quantity;

  // ─── 5. FINISH COST ────────────────────────
  const surfaceAreaIn2 = (geometry.surfaceArea || (bbox.width * bbox.height * 2)) / 645.16;
  const surfaceAreaDm2 = surfaceAreaIn2 * 0.064516; // in² to dm²
  const finishCost = finish
    ? (finish.pricePerPart || finish.minCost || 0) + surfaceAreaIn2 * (finish.pricePerSqIn || 0) + surfaceAreaDm2 * (finish.costPerDm2 || 0)
    : 0;

  // ─── PER-UNIT SUBTOTAL ─────────────────────
  const perUnitBase = materialCost + machineCost + setupPerUnit + finishCost;

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
  // Clamp margin to [0, 0.95) so a misconfigured rule can't divide-by-zero or
  // produce a negative price.
  const margin = clampNumber(r.marginPercent, 0, 0.95, 0.30);
  const perUnitWithMargin = perUnitAfterNesting / (1 - margin);

  // ─── 9. ENFORCE MINIMUM ────────────────────
  // Per-sub-process floor reflects handling/post-processing labor (FDM support
  // removal, SLA wash+cure, SLS depowder+blast); falls back to the global min.
  const processMinPrice = {
    fdm: r.fdmMinimumPartPrice,
    sla: r.slaMinimumPartPrice,
    sls: r.slsMinimumPartPrice,
  }[subProcess] || r.minimumPartPrice || 5.0;
  const perUnitFinal = Math.max(perUnitWithMargin, processMinPrice);

  // ─── TOTAL ─────────────────────────────────
  const lineTotal = perUnitFinal * quantity;

  // ─── WEIGHT CALCULATION ────────────────────
  const weightKg = totalMaterialVolume * materialDensity / 1000;

  return {
    perUnit: {
      material: materialCost,
      machineTime: machineCost,
      setup: setupPerUnit,
      support: supportVolumeCm3 * (material.pricePerCm3 || 0.1),
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
      process: '3d-printing',
      materialSlug: material.slug,
      density: materialDensity,
      layerHeightMm,
      printTimeHours,
      subProcess,
      finishSlug: finish?.slug || 'raw',
      discountTier: discountTier?.minQty || 1,
    },
  };
}

module.exports = { calculate };
