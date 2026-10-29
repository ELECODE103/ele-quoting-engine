/**
 * 3D printing pricing — FDM, SLA and SLS, from the part's volume, surface
 * area, height and overhang.
 *
 * FDM:  shell = surface area × shell thickness (capped at the part volume),
 *       infill = (volume − shell) × infill%, supports = overhang support
 *       volume × support density. Time = shell ÷ wall deposition + infill ÷
 *       infill deposition + layers × per-layer overhead. Post-process minutes
 *       grow with surface area (support removal, cleanup).
 * SLA:  layers = height ÷ layer height; time = layers × (fixed exposure/peel
 *       + scan per cm² × MEAN cross-section), mean cross-section = volume ÷
 *       height — so a thin-walled box is not charged for its footprint.
 *       Plus wash + cure minutes.
 * SLS:  same layer model at SLS rates; powder = part + the un-fused share
 *       that is not reclaimed; plus depowder/blast minutes.
 * Each sub-process keeps its own price floor (Shop group).
 */
const { clampNumber, PRINT_SUBPROCESSES, costBuildup, round, applyCommercialTerms, finishCost } = require("../shared");
const { resolveFeatures } = require("../featureAdapter");

function calculate(params, rules) {
  const { geometry, material, finish, quantity, layerHeight, infill, totalPartsInOrder = 1 } = params;
  const r = rules || {};
  const qty = Math.max(1, Number(quantity) || 1);
  const cb = costBuildup();
  const materialDensity = clampNumber(material.density, 0.1, 25, 1.2); // g/cm³
  const pricePerCm3 = Number(material.pricePerCm3) || 0.1;
  const laborRate = clampNumber(r.laborRatePerHour, 1, 1e4, 65);

  const layerHeightMm = clampNumber(layerHeight > 0 ? layerHeight : material.defaultLayerHeight, 0.02, 1.0, 0.2);
  let subProcess = String(material.subProcess || "fdm").toLowerCase();
  if (!PRINT_SUBPROCESSES.includes(subProcess)) subProcess = "fdm";

  const view = resolveFeatures(geometry || {}, {});
  const { f, confidence, notes } = view;
  const partVolumeCm3 = f.volume / 1000;
  const surfaceCm2 = f.surfaceArea / 100;
  // Print height: the part lies flat on its largest face (shortest extent up).
  const heightMm = Math.max(0.1, f.obb.d);
  const layers = Math.max(1, Math.ceil(heightMm / layerHeightMm));
  const meanSectionCm2 = (f.volume / heightMm) / 100;

  let materialVolumeCm3 = 0, supportVolumeCm3 = 0, printMinutes = 0, machineRate = 0, postMinutes = 0;

  if (subProcess === "fdm") {
    const infillPct = clampNumber(infill, 0.05, 1.0, clampNumber(r.fdmInfillPercent, 0.05, 1, 0.2));
    const shellMm = clampNumber(r.fdmShellThicknessMm, 0.2, 10, 1.2);
    const shellCm3 = Math.min(partVolumeCm3, surfaceCm2 * (shellMm / 10));
    const infillCm3 = Math.max(0, partVolumeCm3 - shellCm3) * infillPct;
    const supportCm3 = ((f.overhang?.supportVolumeEstimate || 0) / 1000) * clampNumber(r.fdmSupportDensity, 0, 1, 0.15);
    materialVolumeCm3 = shellCm3 + infillCm3;
    supportVolumeCm3 = supportCm3;
    const wallRate = clampNumber(r.fdmDepositionMm3PerSec, 0.1, 100, 3.5);
    const infillRate = clampNumber(r.fdmInfillDepositionMm3PerSec, 0.1, 100, 8);
    const shellMin = (shellCm3 * 1000) / wallRate / 60;
    const infillMin = (infillCm3 * 1000) / infillRate / 60;
    const supportMin = (supportCm3 * 1000) / infillRate / 60;
    const layerMin = (layers * clampNumber(r.fdmLayerOverheadSec, 0, 60, 2)) / 60;
    printMinutes = shellMin + infillMin + supportMin + layerMin;
    machineRate = clampNumber(r.fdmMachineRatePerHour, 0, 200, 4);
    postMinutes = clampNumber(r.fdmPostProcessMinutesBase, 0, 60, 2) + (surfaceCm2 / 100) * clampNumber(r.fdmPostProcessMinutesPer100Cm2, 0, 30, 1);
    cb.add("print shell", { minutes: shellMin, dollars: (shellMin / 60) * machineRate, basis: `${round(shellCm3, 1)} cm³ (${round(surfaceCm2, 0)} cm² × ${shellMm} mm) ÷ ${wallRate} mm³/s` });
    cb.add("print infill", { minutes: infillMin, dollars: (infillMin / 60) * machineRate, basis: `${round(infillCm3, 1)} cm³ at ${round(infillPct * 100, 0)}% ÷ ${infillRate} mm³/s` });
    if (supportCm3 > 0) cb.add("print supports", { minutes: supportMin, dollars: (supportMin / 60) * machineRate, basis: `${round(supportCm3, 1)} cm³ (overhang ${round((f.overhang?.areaFraction45 || 0) * 100, 0)}% of surface)` });
    cb.add("layer changes", { minutes: layerMin, dollars: (layerMin / 60) * machineRate, basis: `${layers} layers × ${clampNumber(r.fdmLayerOverheadSec, 0, 60, 2)} s` });
  } else if (subProcess === "sla") {
    materialVolumeCm3 = partVolumeCm3;
    supportVolumeCm3 = partVolumeCm3 * clampNumber(r.slaSupportMaterialRatio, 0, 1, 0.1);
    const perLayer = clampNumber(r.slaLayerTimeSec, 0, 120, 7) + clampNumber(r.slaScanTimeSecPerCm2, 0, 20, 0.3) * meanSectionCm2;
    printMinutes = (layers * perLayer) / 60;
    machineRate = clampNumber(r.slaMachineRatePerHour, 0, 200, 15);
    postMinutes = clampNumber(r.slaPostProcessMinutes, 0, 120, 12);
    cb.add("print layers", { minutes: printMinutes, dollars: (printMinutes / 60) * machineRate, basis: `${layers} layers × (${clampNumber(r.slaLayerTimeSec, 0, 120, 7)} s + ${clampNumber(r.slaScanTimeSecPerCm2, 0, 20, 0.3)} s/cm² × ${round(meanSectionCm2, 1)} cm² mean section)` });
  } else {
    const packingEff = clampNumber(r.slsPackingEfficiency, 0.01, 1.0, 0.08);
    const reuse = clampNumber(r.slsPowderReuseRatio, 0, 0.95, 0.5);
    const unfusedShare = 1 / packingEff - 1;
    materialVolumeCm3 = partVolumeCm3 * (1 + unfusedShare * (1 - reuse));
    const perLayer = clampNumber(r.slsLayerTimeSec, 0, 120, 12) + clampNumber(r.slsScanTimeSecPerCm2, 0, 20, 2) * meanSectionCm2;
    printMinutes = (layers * perLayer) / 60;
    machineRate = clampNumber(r.slsMachineRatePerHour, 0, 500, 35);
    postMinutes = clampNumber(r.slsPostProcessMinutes, 0, 120, 8);
    cb.add("print layers", { minutes: printMinutes, dollars: (printMinutes / 60) * machineRate, basis: `${layers} layers × (${clampNumber(r.slsLayerTimeSec, 0, 120, 12)} s + ${clampNumber(r.slsScanTimeSecPerCm2, 0, 20, 2)} s/cm² × ${round(meanSectionCm2, 1)} cm² mean section)` });
  }

  const totalMaterialVolume = materialVolumeCm3 + supportVolumeCm3;
  const materialCost = cb.add("material", { dollars: totalMaterialVolume * pricePerCm3, basis: `${round(materialVolumeCm3, 1)} cm³ part + ${round(supportVolumeCm3, 1)} cm³ support × $${pricePerCm3}/cm³` });
  const machineCost = (printMinutes / 60) * machineRate;
  const postCost = cb.add("post-process", { minutes: postMinutes, dollars: (postMinutes / 60) * laborRate, basis: subProcess === "fdm" ? "remove from bed, pull supports, check" : subProcess === "sla" ? "wash, cure, remove supports" : "depowder, bead blast" });
  const setupMinutes = clampNumber(r.printSetupMinutes, 0, 120, 5);
  const setupPerUnit = cb.add("setup", { minutes: setupMinutes / qty, dollars: (setupMinutes / 60) * laborRate / qty, basis: `slice + start ${setupMinutes} min ÷ ${qty} pcs` });
  const finishDollars = cb.add("surface finish", { dollars: finishCost(finish, f.surfaceArea), basis: finish ? `${finish.name || finish.slug}` : "as printed" });

  const perUnitBase = materialCost + machineCost + postCost + setupPerUnit + finishDollars;
  const minimum = { fdm: r.fdmMinimumPartPrice, sla: r.slaMinimumPartPrice, sls: r.slsMinimumPartPrice }[subProcess] ?? r.minimumPartPrice ?? 5;
  const terms = applyCommercialTerms({ perUnitBase, materialCost, quantity: qty, totalPartsInOrder, minimum }, r);
  const weightKg = (totalMaterialVolume * materialDensity) / 1000;

  return {
    perUnit: {
      material: materialCost,
      machineTime: machineCost,
      labor: postCost,
      setup: setupPerUnit,
      support: supportVolumeCm3 * pricePerCm3,
      finish: finishDollars,
      ...terms.perUnit,
    },
    quantity: qty,
    lineTotal: terms.perUnit.final * qty,
    weight: { perUnit: weightKg, total: weightKg * qty, units: "kg" },
    meta: {
      process: "3d-printing",
      materialSlug: material.slug,
      density: materialDensity,
      layerHeightMm,
      layers,
      printTimeHours: printMinutes / 60,
      postProcessMinutes: postMinutes,
      subProcess,
      finishSlug: finish?.slug || "raw",
      discountTier: terms.discountTier,
      floorApplied: terms.floorApplied,
      geometrySummary: { volumeCm3: round(partVolumeCm3, 2), surfaceCm2: round(surfaceCm2, 1), heightMm: round(heightMm, 1), meanSectionCm2: round(meanSectionCm2, 2), materialCm3: round(totalMaterialVolume, 2) },
      costBuildup: cb.steps,
      confidence,
      notes,
    },
  };
}

module.exports = { calculate };
