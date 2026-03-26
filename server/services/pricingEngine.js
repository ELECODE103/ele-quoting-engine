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
   * Router for calculatePartPrice — dispatches to the appropriate process.
   *
   * @param {Object} params
   * @param {string} [params.process] — manufacturing process: 'sheetmetal', 'cnc', '3d-printing'
   * @returns {Object} detailed price breakdown
   */
  calculatePartPrice(params) {
    const process = params.process || 'sheetmetal';
    switch (process) {
      case 'cnc':
        return this.calculateCNCPrice(params);
      case '3d-printing':
        return this.calculatePrintPrice(params);
      default:
        return this.calculateSheetMetalPrice(params);
    }
  }

  /**
   * Calculate the price for a sheet metal part configuration.
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
  calculateSheetMetalPrice({
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
        process: 'sheetmetal',
        materialSlug: material.slug,
        grade,
        thicknessMm,
        finishSlug: finish?.slug || "raw",
        discountTier: discountTier?.minQty || 1,
      },
    };
  }

  /**
   * Calculate the price for a CNC machined part.
   *
   * @param {Object} params
   * @param {Object} params.geometry — parsed geometry (volume in mm³, bounding box)
   * @param {Object} params.material — CNC material record with machinability, pricePerKg, grades[]
   * @param {string} params.grade — selected grade name
   * @param {Object} params.finish — finish record from DB
   * @param {number} params.quantity — number of units
   * @param {string} [params.subProcess] — 'turning' or 'milling' (affects timing)
   * @param {number} [params.totalPartsInOrder] — for discount calculation
   * @returns {Object} detailed price breakdown
   */
  calculateCNCPrice({
    geometry,
    material,
    grade,
    finish,
    quantity,
    subProcess = 'milling',
    totalPartsInOrder = 1,
  }) {
    const r = this.rules;
    const gradeData = material.grades.find((g) => g.name === grade) || material.grades[0];
    const density = gradeData.density; // lb/in³
    const machinability = material.machinability || 1.0;

    // ─── 1. STOCK VOLUME & WEIGHT ──────────────
    // Bounding box from geometry
    const bbox = {
      width: geometry.width || 100, // mm
      height: geometry.height || 100,
      depth: geometry.depth || 50,
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

    const materialCost = weightKg * material.pricePerKg;

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
    const finishCost = finish
      ? finish.pricePerPart + surfaceAreaIn2 * finish.pricePerSqIn
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

  /**
   * Calculate the price for a 3D printed part.
   *
   * @param {Object} params
   * @param {Object} params.geometry — parsed geometry (volume in mm³, bounding box)
   * @param {Object} params.material — 3D printing material record with density, pricePerCm3, layerHeights, defaultLayerHeight, subProcess
   * @param {Object} params.finish — finish record from DB
   * @param {number} params.quantity — number of units
   * @param {number} [params.layerHeight] — layer height in mm (overrides default)
   * @param {number} [params.infill] — infill percentage for FDM (0.0–1.0)
   * @param {number} [params.totalPartsInOrder] — for discount calculation
   * @returns {Object} detailed price breakdown
   */
  calculatePrintPrice({
    geometry,
    material,
    finish,
    quantity,
    layerHeight,
    infill,
    totalPartsInOrder = 1,
  }) {
    const r = this.rules;
    const materialDensity = material.density || 1.2; // g/cm³
    const layerHeightMm = layerHeight || material.defaultLayerHeight || 0.2;
    const subProcess = material.subProcess || 'fdm';

    // Bounding box from geometry
    const bbox = {
      width: geometry.width || 100, // mm
      height: geometry.height || 100,
      depth: geometry.depth || 50,
    };

    const partVolumeMm3 = geometry.volume || (bbox.width * bbox.height * bbox.depth * 0.4); // estimate
    const partVolumeCm3 = partVolumeMm3 / 1000;
    const bboxVolumeCm3 = (bbox.width * bbox.height * bbox.depth) / 1000;

    let materialVolumeCm3;
    let supportVolumeCm3 = 0;
    let printTimeHours = 0;
    let machineRatePerHour;

    // ─── PROCESS-SPECIFIC LOGIC ────────────────
    if (subProcess === 'fdm') {
      // FDM: infill + shells
      const fdmInfillPercent = infill !== undefined ? infill : (r.fdmInfillPercent || 0.2);
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

      const numberOfLayers = bbox.depth / layerHeightMm;
      const slaLayerTime = r.slaLayerTimeSec || 8;
      printTimeHours = (numberOfLayers * slaLayerTime) / 3600;
      machineRatePerHour = r.slaMachineRatePerHour || 20.0;
    } else if (subProcess === 'sls') {
      // SLS: fully sintered, powder-supported, packing efficiency
      const packingEff = r.slsPackingEfficiency || 0.08;
      materialVolumeCm3 = partVolumeCm3 / packingEff; // accounts for unfused powder cost

      const numberOfLayers = bbox.depth / layerHeightMm;
      const slsLayerTime = r.slsLayerTimeSec || 12;
      printTimeHours = (numberOfLayers * slsLayerTime) / 3600;
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
    const finishCost = finish
      ? finish.pricePerPart + surfaceAreaIn2 * finish.pricePerSqIn
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
    const perUnitWithMargin = perUnitAfterNesting / (1 - r.marginPercent);

    // ─── 9. ENFORCE MINIMUM ────────────────────
    const perUnitFinal = Math.max(perUnitWithMargin, r.minimumPartPrice);

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