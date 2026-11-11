/**
 * CNC pricing — milling on the Tormach PCNC 1100 and turning on the manual
 * lathe, built bottom-up from the part's features (server/geometry/SCHEMA.md)
 * or, when the geometry module has not supplied them, from what the legacy
 * fields honestly give (see ../featureAdapter.js).
 *
 * MILLING, per part (minutes), then × mill rate:
 *   saw blank
 *   + per setup: load/unload
 *   + skim: (stock − bounding box) ÷ facing MRR            — facing the blank
 *   + rough: feature removal ÷ roughing MRR(material)      — adaptive clearing
 *       (pockets with small corner radii / deep ratios are slowed individually)
 *   + profile (flat parts): outline × passes ÷ feed         — plate is profiled, not pocketed
 *   + finish: machined surface ÷ finish rate(finish class)  — walls and floors
 *   + holes: Σ approach + depth ÷ drill feed(dia) × peck, hand tap, c'bore
 *   + tool changes, inspection
 *   thin / tall walls inflate the finishing and feature-roughing terms
 *   floor: surface area × min minutes per cm² (not a flat 15 min)
 * Per lot: setups (first + each additional, 4th-axis when it fits), inspection.
 * Material: plate at thickness when the part matches a standard plate, else a
 * padded block; × density × $/kg × (1 + waste).
 *
 * TURNING, per part: load, face ends, OD passes (bar → diameter at DOC and
 * feed for the material class), drill the bore (peck past 3×D), bore past the
 * largest drill, chamfers, part off or saw, inspect. Per lot: lathe setup.
 * Material: next standard bar above the diameter × (length + end allowance).
 *
 * Output keeps the shared line-item shape: perUnit{…}, quantity, lineTotal,
 * weight, meta (machineTimeHours, geometrySummary, costBuildup[], confidence).
 */
const { clampNumber, costBuildup, round, tableValue, nextStandard, applyCommercialTerms, finishCost } = require("../shared");
const { resolveFeatures, materialClassOf } = require("../featureAdapter");

const LB_IN3_TO_G_CM3 = 27.6799;
const MM3_PER_CM3 = 1000;

function gradeDensityGcm3(material, grade) {
  const grades = material.grades || [];
  const g = grades.find((x) => x.name === grade) || grades[0] || {};
  const lbIn3 = Number(g.density);
  if (Number.isFinite(lbIn3) && lbIn3 > 0) return lbIn3 * LB_IN3_TO_G_CM3;
  const gcm3 = Number(material.density);
  return Number.isFinite(gcm3) && gcm3 > 0 ? gcm3 : 1.4;
}

function drillBand(dia) {
  return dia <= 3 ? "upTo3" : dia <= 10 ? "upTo10" : dia <= 20 ? "upTo20" : "over20";
}
function latheDrillBand(dia) {
  return dia <= 6 ? "upTo6" : dia <= 13 ? "upTo13" : dia <= 25 ? "upTo25" : "over25";
}

/** Peck-drilling multiplier for a hole `depth` deep at `dia`. */
function peckFactor(depth, dia, r) {
  const ratio = Math.min(12, dia > 0 ? depth / dia : 0); // beyond 12×D the hole is drilled from both ends
  const threshold = clampNumber(r.cncPeckDepthRatio, 1, 20, 3);
  if (ratio <= threshold) return 1;
  return 1 + (ratio - threshold) * clampNumber(r.cncPeckPenaltyPerDia, 0, 2, 0.25);
}

// ─────────────────────────────────────────────────────────────────────────────
// MILLING
// ─────────────────────────────────────────────────────────────────────────────
function priceMilling({ f, derived, confidence, notes }, params, r) {
  const { material, grade, finish, quantity, totalPartsInOrder = 1 } = params;
  const qty = Math.max(1, Number(quantity) || 1);
  const mach = clampNumber(material.machinability, 0.05, 5, 1.0);
  const cls = materialClassOf(material);
  const densityGcm3 = gradeDensityGcm3(material, grade);
  const pricePerKg = Number(material.pricePerKg || material.costPerKg) || 1.0;
  const waste = clampNumber(material.wasteFactor, 0, 2, clampNumber(r.materialDefaultWasteFactor, 0, 2, 0.15));
  const millRate = clampNumber(r.cncMachineRatePerHour, 1, 1e4, 95);
  const laborRate = clampNumber(r.laborRatePerHour, 1, 1e4, 65);
  const cb = costBuildup();

  const dims = { a: f.obb.w, b: f.obb.h, c: f.obb.d }; // a ≥ b ≥ c
  const bboxVol = derived.bboxVolumeMm3;
  const isFlat = f.shape.kind === "flat";
  const surfaceCm2 = f.surfaceArea / 100;

  // ─── 1. STOCK ─────────────────────────────────────────────────────────────
  const pad = clampNumber(r.stockPaddingMm, 0, 25, 3);
  const plateTol = clampNumber(r.plateThicknessMatchMm, 0, 5, 0.6);
  const plates = (Array.isArray(r.standardPlateThicknessesMm) ? r.standardPlateThicknessesMm : []).filter((v) => Number.isFinite(v));
  const forms = Array.isArray(material.stockForms) && material.stockForms.length ? material.stockForms : ["plate", "rod"];
  let stock;
  // Flat parts and blocks alike are bought as plate when the thickness is a
  // standard plate size (no Z padding, at most one face skimmed); otherwise a
  // padded block is sawn and faced.
  const plateMatch = forms.includes("plate") ? plates.find((s) => dims.c <= s + 0.1 && s - dims.c <= plateTol) : null;
  if (plateMatch) {
    stock = { form: "plate", w: dims.a + 2 * pad, h: dims.b + 2 * pad, d: plateMatch, facesMachined: plateMatch - dims.c > 0.1 ? 1 : 0 };
  } else {
    stock = { form: "block", w: dims.a + 2 * pad, h: dims.b + 2 * pad, d: dims.c + 2 * pad, facesMachined: 2 };
  }
  stock.volume = stock.w * stock.h * stock.d;
  const stockKg = (stock.volume / MM3_PER_CM3) * densityGcm3 / 1000;
  const materialCost = cb.add("material", {
    dollars: stockKg * (1 + waste) * pricePerKg,
    basis: `${stock.form} ${round(stock.w, 1)}×${round(stock.h, 1)}×${round(stock.d, 2)} mm = ${round(stockKg * 1000, 0)} g × $${pricePerKg}/kg + ${round(waste * 100, 0)}% waste`,
  });

  // ─── 2. SETUPS (per lot) ──────────────────────────────────────────────────
  let setups = Math.max(1, Math.round(f.access?.minSetups3Axis || 1));
  const travelX = clampNumber(r.cncMaxTravelXMm, 50, 5000, 457);
  if (dims.a > travelX) setups += Math.ceil(dims.a / travelX) - 1; // indexed along X
  let fourthAxis = false;
  if (setups > 2 && dims.b <= clampNumber(r.cnc4thAxisMaxDiameterMm, 0, 1e4, 150) && dims.a <= clampNumber(r.cnc4thAxisMaxLengthMm, 0, 1e4, 300)) {
    fourthAxis = true;
    setups = 2;
  }
  const setupMinutes = clampNumber(r.cncSetupMinutesFirst, 0, 480, 28)
    + (setups - 1) * clampNumber(r.cncSetupMinutesAdditional, 0, 480, 15)
    + (fourthAxis ? clampNumber(r.cnc4thAxisSetupMinutes, 0, 480, 20) : 0)
    + clampNumber(r.cncInspectionMinutesPerLot, 0, 120, 3);
  const setupPerUnit = cb.add("setup", {
    minutes: setupMinutes / qty,
    dollars: (setupMinutes / 60) * millRate / qty,
    basis: `${setups} setup${setups > 1 ? "s" : ""}${fourthAxis ? " + 4th axis" : ""} + lot inspection = ${round(setupMinutes, 0)} min ÷ ${qty} pcs`,
  });

  // ─── 3. MACHINE TIME (per part) ───────────────────────────────────────────
  const minutes = {};
  minutes.saw = clampNumber(r.cncSawMinutesPerPart, 0, 60, 1);
  minutes.handling = setups * clampNumber(r.cncHandlingMinutesPerSetup, 0, 60, 2);

  // Wall penalties (apply to finishing and feature roughing)
  let wallPenalty = 0;
  const walls = f.walls;
  if (walls && Number.isFinite(walls.minThickness) && walls.minThickness < clampNumber(r.cncThinWallMm, 0, 20, 2)) {
    wallPenalty += clampNumber(r.cncThinWallPenalty, 0, 5, 0.4);
  }
  if (walls && Number.isFinite(walls.tallThinMaxAspect) && walls.tallThinMaxAspect > clampNumber(r.cncTallWallAspect, 1, 50, 8)) {
    wallPenalty += clampNumber(r.cncTallWallPenalty, 0, 5, 0.3);
  }

  // 3a. face the blank to thickness (Z); the padding skin on the four sides
  //     is cut away by the profile / side-cleanup pass below, not faced off
  const facingMrr = clampNumber(r.cncFacingMrrCm3PerMin, 0.1, 1000, 35) * mach;
  const skimCm3 = Math.max(0, stock.w * stock.h * (stock.d - dims.c)) / MM3_PER_CM3;
  minutes.skim = skimCm3 / facingMrr;

  // 3b. rough the features
  const roughMrr = tableValue(r.cncRoughingMrrCm3PerMin, cls, 13) * mach;
  const refR = clampNumber(r.cncPocketCornerRefRadiusMm, 0.5, 25, 4.8);
  const cornerExp = clampNumber(r.cncPocketCornerPenaltyExponent, 0, 3, 1);
  let pocketCm3 = 0, pocketMinutes = 0;
  for (const pk of f.pockets) {
    const vol = (pk.area * pk.depth) / MM3_PER_CM3;
    let factor = 1;
    const rad = Number(pk.minCornerRadius);
    if (Number.isFinite(rad) && rad > 0 && rad < refR) factor *= Math.pow(refR / rad, cornerExp);
    const dw = Number(pk.depthToWidthRatio);
    if (Number.isFinite(dw) && dw > clampNumber(r.cncPocketDeepRatio, 1, 20, 3)) factor *= 1 + clampNumber(r.cncPocketDeepPenalty, 0, 5, 0.5);
    pocketCm3 += vol;
    pocketMinutes += (vol / roughMrr) * factor;
  }
  let featureCm3;
  if (isFlat) {
    // Plate is profiled around, not pocketed: only blind removal is roughed.
    featureCm3 = Math.max(0, (derived.blindRemovalMm3 ?? 0) / MM3_PER_CM3 - pocketCm3);
  } else {
    featureCm3 = Math.max(0, derived.envelopeRemovalMm3 / MM3_PER_CM3 - pocketCm3);
  }
  minutes.rough = (featureCm3 / roughMrr + pocketMinutes) * (1 + wallPenalty);

  // 3c. profile: flat parts are cut around (outline + inner contours through
  //     the plate); blocks get their four sawn sides cleaned up the same way
  const millFeed = clampNumber(r.cncMillFeedMmPerMin, 10, 1e4, 1000) * mach;
  const t = isFlat ? (f.shape.stockThickness || dims.c) : dims.c;
  const passes = Math.max(1, Math.ceil(t / clampNumber(r.cncMillDocMm, 0.5, 50, 9.6) - 1e-6));
  const profileMm = isFlat
    ? (f.shape.profile.perimeter || 0) + (f.shape.profile.innerPerimeter || 0)
    : 2 * (dims.a + dims.b);
  minutes.profile = (profileMm * passes) / millFeed;

  // 3d. finishing: the surfaces the cutter made
  const finishClass = f.shape.kind === "freeform" ? "freeform" : "prismatic";
  const finishRate = tableValue(r.cncFinishCm2PerMin, finishClass, finishClass === "freeform" ? 10 : 45) * mach;
  let finishCm2;
  if (isFlat) {
    // Faces come from the plate; edges (outer + inner walls) are machined.
    const topArea = Math.min(derived.topAreaEstimateMm2 || 0, dims.a * dims.b);
    finishCm2 = Math.max(0, f.surfaceArea - 2 * topArea) / 100;
  } else {
    finishCm2 = surfaceCm2;
  }
  minutes.finish = (finishCm2 / finishRate) * (1 + wallPenalty);

  // 3e. holes
  minutes.drill = 0; minutes.tap = 0; minutes.bore = 0;
  const helicalMin = clampNumber(r.cncHelicalBoreMinDiaMm, 1, 100, 13);
  const drillTools = new Set();
  let tapped = 0, cbores = 0;
  for (const h of f.holes) {
    const dia = h.diameter, depth = Number.isFinite(h.depth) && h.depth > 0 ? h.depth : dims.c;
    minutes.drill += clampNumber(r.cncDrillApproachMinutes, 0, 5, 0.2);
    if (dia > helicalMin) {
      // helical bore with an endmill: wall area ÷ finish rate, plus the core
      const wall = (Math.PI * dia * depth) / 100;
      minutes.bore += wall / finishRate + ((Math.PI / 4) * dia * dia * depth) / MM3_PER_CM3 / roughMrr;
    } else {
      const feed = tableValue(r.cncDrillMmPerMin, drillBand(dia), 250) * mach;
      minutes.drill += (depth / feed) * peckFactor(depth, dia, r);
      drillTools.add(round(dia, 1));
    }
    if (h.kind === "tapped-candidate") { tapped++; minutes.tap += clampNumber(r.cncTapMinutesPerHole, 0, 20, 1); }
    if (h.kind === "counterbored" || h.kind === "countersunk") { cbores++; minutes.drill += clampNumber(r.cncCounterboreMinutes, 0, 10, 0.3); }
  }

  // 3f. tool changes: rough + finish + each drill size + chamfer (+ c'bore)
  const tools = 2 + drillTools.size + ((f.chamfers && f.chamfers.count) || isFlat ? 1 : 0) + (cbores ? 1 : 0);
  minutes.toolChanges = tools * clampNumber(r.cncToolChangeMinutes, 0, 10, 0.25);
  minutes.inspect = clampNumber(r.cncInspectionMinutesPerPart, 0, 30, 0.5);

  // 3g. unknown-feature allowance when there is no feature list:
  //   blocks — holes, threads and small pockets are invisible, so add a
  //            visible percentage instead of silently under-pricing;
  //   flat parts — inner contours are seen as edge length but a drilled hole
  //            costs a tool start, not just its edge: charge one approach per
  //            hole-sized contour (contour length ÷ π × plate thickness).
  const legacyHoles = confidence.fields.holes === "legacy";
  const legacyBlock = !isFlat && legacyHoles;
  const legacyAllowance = legacyBlock ? clampNumber(r.cncLegacyFeatureAllowance, 0, 2, 0.3) : 0;
  minutes.allowance = legacyAllowance * (minutes.skim + minutes.profile + minutes.finish);
  let contourStarts = 0;
  if (isFlat && legacyHoles && t > 0) {
    contourStarts = Math.round((f.shape.profile.innerPerimeter || 0) / (Math.PI * t));
    minutes.allowance += contourStarts * clampNumber(r.cncDrillApproachMinutes, 0, 5, 0.2);
  }

  // Machine-side minutes (lathe-free); hand tapping is labor, not spindle
  const modelMinutes = minutes.saw + minutes.handling + minutes.skim + minutes.rough + minutes.profile
    + minutes.finish + minutes.drill + minutes.bore + minutes.toolChanges + minutes.inspect + minutes.allowance;
  // Floor that scales with the part: minutes per cm² of MACHINED surface (plus
  // a handling constant), instead of a flat 15-minute floor.
  const areaFloor = minutes.saw + minutes.handling + finishCm2 * clampNumber(r.cncMinMinutesPerCm2, 0, 1, 0.01);
  const floorApplied = modelMinutes < areaFloor;
  const machineMinutes = floorApplied ? areaFloor : modelMinutes;

  // Record the build-up
  cb.add("saw blank", { minutes: minutes.saw, dollars: (minutes.saw / 60) * millRate, basis: "cut blank from bar/plate" });
  cb.add("load/unload", { minutes: minutes.handling, dollars: (minutes.handling / 60) * millRate, basis: `${setups} setup(s) × ${clampNumber(r.cncHandlingMinutesPerSetup, 0, 60, 2)} min` });
  if (minutes.skim > 0) cb.add("face blank", { minutes: minutes.skim, dollars: (minutes.skim / 60) * millRate, basis: `${round(skimCm3, 1)} cm³ skim ÷ ${round(facingMrr, 1)} cm³/min` });
  if (minutes.rough > 0) cb.add("rough features", { minutes: minutes.rough, dollars: (minutes.rough / 60) * millRate, basis: `${round(featureCm3 + pocketCm3, 1)} cm³ ÷ ${round(roughMrr, 1)} cm³/min (${cls}, machinability ${mach})${f.pockets.length ? `, ${f.pockets.length} pocket(s) with corner/depth factors` : ""}${wallPenalty ? `, +${round(wallPenalty * 100, 0)}% walls` : ""}` });
  if (minutes.profile > 0) cb.add(isFlat ? "profile outline" : "side cleanup", { minutes: minutes.profile, dollars: (minutes.profile / 60) * millRate, basis: `${round(profileMm, 0)} mm × ${passes} pass(es) ÷ ${round(millFeed, 0)} mm/min` });
  cb.add("finish surfaces", { minutes: minutes.finish, dollars: (minutes.finish / 60) * millRate, basis: `${round(finishCm2, 0)} cm² ÷ ${round(finishRate, 1)} cm²/min (${finishClass})${wallPenalty ? `, +${round(wallPenalty * 100, 0)}% walls` : ""}` });
  if (f.holes.length) cb.add("holes", { minutes: minutes.drill + minutes.bore, dollars: ((minutes.drill + minutes.bore) / 60) * millRate, basis: `${f.holes.length} hole(s): ${drillTools.size} drill size(s)${cbores ? `, ${cbores} c'bore/csk` : ""}, peck past ${clampNumber(r.cncPeckDepthRatio, 1, 20, 3)}×D` });
  cb.add("tool changes", { minutes: minutes.toolChanges, dollars: (minutes.toolChanges / 60) * millRate, basis: `${tools} tools × ${clampNumber(r.cncToolChangeMinutes, 0, 10, 0.25)} min` });
  cb.add("inspect", { minutes: minutes.inspect, dollars: (minutes.inspect / 60) * millRate, basis: "per-part check" });
  if (minutes.allowance > 0) cb.add("unknown-feature allowance", { minutes: minutes.allowance, dollars: (minutes.allowance / 60) * millRate, basis: legacyBlock ? `+${round(legacyAllowance * 100, 0)}% on facing/profile/finish time: no feature list, holes and threads not seen` : `${contourStarts} hole-sized contour(s) × ${clampNumber(r.cncDrillApproachMinutes, 0, 5, 0.2)} min tool start: no feature list` });
  if (floorApplied) cb.add("surface-area minimum", { minutes: areaFloor - modelMinutes, dollars: ((areaFloor - modelMinutes) / 60) * millRate, basis: `machine time raised to ${round(areaFloor, 2)} min (handling + ${round(finishCm2, 0)} cm² machined × ${clampNumber(r.cncMinMinutesPerCm2, 0, 1, 0.01)} min/cm²)` });

  const machineCost = (machineMinutes / 60) * millRate;
  const handCost = cb.add("hand work", { minutes: minutes.tap, dollars: (minutes.tap / 60) * laborRate, basis: tapped ? `${tapped} tapped hole(s) × ${clampNumber(r.cncTapMinutesPerHole, 0, 20, 1)} min at $${laborRate}/h (no rigid tapping)` : "none" });

  // ─── 4. TOOLING (per machine hour, harder materials wear faster) ──────────
  const toolingCost = cb.add("tooling", {
    dollars: (machineMinutes / 60) * clampNumber(r.cncToolingPerMachineHour, 0, 200, 6) / mach,
    basis: `$${clampNumber(r.cncToolingPerMachineHour, 0, 200, 6)}/h ÷ machinability ${mach}`,
  });

  // ─── 5. FINISH (surface finishing from the finish record) ─────────────────
  const finishDollars = cb.add("surface finish", { dollars: finishCost(finish, f.surfaceArea), basis: finish ? `${finish.name || finish.slug}: per part + per area` : "as machined" });

  // ─── 6. COMMERCIAL TERMS ──────────────────────────────────────────────────
  const perUnitBase = materialCost + machineCost + handCost + toolingCost + setupPerUnit + finishDollars;
  const terms = applyCommercialTerms({ perUnitBase, materialCost, quantity: qty, totalPartsInOrder, minimum: r.minimumPartPrice }, r);
  const partKg = (f.volume / MM3_PER_CM3) * densityGcm3 / 1000;

  return {
    perUnit: {
      material: materialCost,
      machining: machineCost,
      labor: handCost,
      tooling: toolingCost,
      setup: setupPerUnit,
      finish: finishDollars,
      ...terms.perUnit,
    },
    quantity: qty,
    lineTotal: terms.perUnit.final * qty,
    weight: { perUnit: partKg, total: partKg * qty, units: "kg" },
    meta: {
      process: "cnc",
      subProcess: "milling",
      materialSlug: material.slug,
      grade,
      machinability: mach,
      materialClass: cls,
      machineTimeHours: machineMinutes / 60,
      timeFloorApplied: floorApplied,
      setupMinutes,
      setups,
      fourthAxis,
      finishSlug: finish?.slug || "raw",
      discountTier: terms.discountTier,
      floorApplied: terms.floorApplied,
      geometrySummary: {
        stockMm: { w: round(stock.w, 1), h: round(stock.h, 1), d: round(stock.d, 2) },
        stockForm: stock.form,
        removalCm3: round((stock.volume - f.volume) / MM3_PER_CM3, 1),
        volumeRatio: round(derived.volumeRatio, 3),
        surfaceCm2: round(surfaceCm2, 1),
        shape: f.shape.kind,
        holes: f.holes.length,
        pockets: f.pockets.length,
        minWallMm: walls && Number.isFinite(walls.minThickness) ? round(walls.minThickness, 2) : null,
      },
      costBuildup: cb.steps,
      confidence,
      notes,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TURNING
// ─────────────────────────────────────────────────────────────────────────────
function priceTurning({ f, derived, confidence, notes }, params, r) {
  const { material, grade, finish, quantity, totalPartsInOrder = 1 } = params;
  const qty = Math.max(1, Number(quantity) || 1);
  const cls = materialClassOf(material);
  const mach = clampNumber(material.machinability, 0.05, 5, 1.0);
  const densityGcm3 = gradeDensityGcm3(material, grade);
  const pricePerKg = Number(material.pricePerKg || material.costPerKg) || 1.0;
  const waste = clampNumber(material.wasteFactor, 0, 2, clampNumber(r.materialDefaultWasteFactor, 0, 2, 0.15));
  const latheRate = clampNumber(r.latheRatePerHour, 1, 1e4, 85);
  const cb = costBuildup();

  const rv = f.shape.revolved;
  const D = Math.max(1, rv.maxDiameter);
  const L = Math.max(0.5, rv.length);
  const bore = Number.isFinite(rv.boreDiameter) && rv.boreDiameter > 0 ? rv.boreDiameter : 0;
  const minD = Number.isFinite(rv.minDiameter) && rv.minDiameter > 0 ? Math.min(rv.minDiameter, D) : D;

  // ─── 1. STOCK: next standard bar ──────────────────────────────────────────
  const barDia = nextStandard(r.standardBarDiametersMm, D + 2 * clampNumber(r.latheBarPaddingMm, 0, 20, 1));
  const partOff = L <= clampNumber(r.lathePartOffMaxLengthMm, 0, 1000, 100);
  const barLen = L + clampNumber(r.latheBarEndAllowanceMm, 0, 50, 4);
  const barVol = (Math.PI / 4) * barDia * barDia * barLen;
  const barKg = (barVol / MM3_PER_CM3) * densityGcm3 / 1000;
  const materialCost = cb.add("material", {
    dollars: barKg * (1 + waste) * pricePerKg,
    basis: `Ø${round(barDia, 1)} bar × ${round(barLen, 1)} mm = ${round(barKg * 1000, 0)} g × $${pricePerKg}/kg + ${round(waste * 100, 0)}% waste`,
  });

  // ─── 2. SETUP (per lot) ───────────────────────────────────────────────────
  const setupMinutes = clampNumber(r.latheSetupMinutes, 0, 240, 15);
  const setupPerUnit = cb.add("setup", { minutes: setupMinutes / qty, dollars: (setupMinutes / 60) * latheRate / qty, basis: `tooling + stops ${setupMinutes} min ÷ ${qty} pcs` });

  // ─── 3. CYCLE (per part) ──────────────────────────────────────────────────
  const feed = tableValue(r.latheFeedMmPerMin, cls, 150) * mach;
  const doc = tableValue(r.latheDocMm, cls, 1.5);
  const m = {};
  m.load = clampNumber(r.latheLoadMinutesPerPart, 0, 30, 0.4);
  const facedEnds = partOff ? 1 : 2; // bar work against a stop: the part-off face is the next piece's face
  m.face = facedEnds * clampNumber(r.latheFaceMinutes, 0, 30, 0.4);
  // OD: bar → D, plus any step down to minD over half the length
  const odPasses = Math.ceil(Math.max(0, (barDia - D) / 2) / doc) + 1;
  m.od = (odPasses * L) / feed;
  if (minD < D - 0.2) m.od += (Math.ceil((D - minD) / 2 / doc) * (L / 2)) / feed;
  // bore: drill (peck past 3×D), then bore if bigger than the largest drill
  m.drill = 0; m.bore = 0;
  let drillDia = 0, pilot = false;
  if (bore > 0) {
    drillDia = Math.min(bore, clampNumber(r.latheMaxDrillMm, 1, 100, 25));
    const dFeed = tableValue(r.latheDrillMmPerMin, latheDrillBand(drillDia), 80) * mach;
    m.drill = (L / dFeed) * peckFactor(L, drillDia, r);
    if (drillDia > 12) {
      // a big drill follows a centre drill and a pilot on a manual lathe
      pilot = true;
      const pFeed = tableValue(r.latheDrillMmPerMin, "upTo13", 100) * mach;
      m.drill += 0.3 + (L / pFeed) * peckFactor(L, 10, r);
    }
    if (bore > drillDia + 0.2) {
      const borePasses = Math.ceil((bore - drillDia) / 2 / doc) + 1;
      m.bore = (borePasses * L) / (feed * 0.8);
    }
  }
  const flip = !partOff || L > clampNumber(r.latheNoFlipMaxLengthMm, 0, 1000, 12);
  const edges = (flip ? 2 : 1) * (bore > 0 ? 2 : 1);
  const chamferEach = clampNumber(r.latheChamferMinutes, 0, 30, 0.1) + (D / 10) * clampNumber(r.latheChamferMinutesPer10mmDia, 0, 5, 0.05);
  m.chamfer = edges * chamferEach + (flip ? 0 : 0.15);
  m.flip = flip ? clampNumber(r.latheFlipMinutes, 0, 30, 0.5) : 0;
  // Operation changes on a manual lathe: face, turn, drill, bore, chamfer, part off
  const ops = 1 + (odPasses > 0 ? 1 : 0) + (bore > 0 ? 1 : 0) + (pilot ? 2 : 0) + (m.bore > 0 ? 1 : 0) + 1 + (partOff ? 1 : 0);
  m.opChanges = ops * clampNumber(r.latheToolChangeMinutes, 0, 10, 0.25);
  m.partOff = partOff ? barDia / clampNumber(r.lathePartOffMmPerMin, 1, 500, 30) : clampNumber(r.cncSawMinutesPerPart, 0, 60, 1);
  m.inspect = clampNumber(r.latheInspectionMinutesPerPart, 0, 30, 0.4);
  const cycle = Object.values(m).reduce((s, v) => s + v, 0);

  cb.add("load", { minutes: m.load, dollars: (m.load / 60) * latheRate, basis: "chuck / collet" });
  cb.add("face", { minutes: m.face, dollars: (m.face / 60) * latheRate, basis: `${facedEnds} end(s)` });
  cb.add("turn OD", { minutes: m.od, dollars: (m.od / 60) * latheRate, basis: `${odPasses} pass(es) × ${round(L, 0)} mm ÷ ${round(feed, 0)} mm/min (Ø${round(barDia, 1)} → Ø${round(D, 1)}${minD < D - 0.2 ? ` → Ø${round(minD, 1)}` : ""})` });
  if (bore > 0) cb.add("drill bore", { minutes: m.drill, dollars: (m.drill / 60) * latheRate, basis: `${pilot ? "centre + pilot + " : ""}Ø${round(drillDia, 1)} × ${round(L, 0)} mm, peck factor ${round(peckFactor(L, drillDia, r), 2)}` });
  if (m.bore > 0) cb.add("bore to size", { minutes: m.bore, dollars: (m.bore / 60) * latheRate, basis: `Ø${round(drillDia, 1)} → Ø${round(bore, 1)}` });
  cb.add("chamfer", { minutes: m.chamfer, dollars: (m.chamfer / 60) * latheRate, basis: `${edges} edges × ${round(chamferEach, 2)} min (Ø${round(D, 0)})${flip ? "" : " + hand deburr of the parted end"}` });
  cb.add("operation changes", { minutes: m.opChanges, dollars: (m.opChanges / 60) * latheRate, basis: `${ops} operations × ${clampNumber(r.latheToolChangeMinutes, 0, 10, 0.25)} min` });
  if (flip) cb.add("flip", { minutes: m.flip, dollars: (m.flip / 60) * latheRate, basis: "second end" });
  cb.add(partOff ? "part off" : "saw blank", { minutes: m.partOff, dollars: (m.partOff / 60) * latheRate, basis: partOff ? `Ø${round(barDia, 1)} ÷ ${clampNumber(r.lathePartOffMmPerMin, 1, 500, 30)} mm/min` : "too long to part off" });
  cb.add("inspect", { minutes: m.inspect, dollars: (m.inspect / 60) * latheRate, basis: "check diameters" });

  const machineCost = (cycle / 60) * latheRate;
  const toolingCost = cb.add("tooling", { dollars: (cycle / 60) * clampNumber(r.latheToolingPerMachineHour, 0, 200, 3) / mach, basis: `$${clampNumber(r.latheToolingPerMachineHour, 0, 200, 3)}/h ÷ machinability ${mach}` });
  const finishDollars = cb.add("surface finish", { dollars: finishCost(finish, f.surfaceArea), basis: finish ? `${finish.name || finish.slug}` : "as turned" });

  const perUnitBase = materialCost + machineCost + toolingCost + setupPerUnit + finishDollars;
  const terms = applyCommercialTerms({ perUnitBase, materialCost, quantity: qty, totalPartsInOrder, minimum: r.minimumPartPrice }, r);
  const partKg = (f.volume / MM3_PER_CM3) * densityGcm3 / 1000;

  return {
    perUnit: { material: materialCost, machining: machineCost, labor: 0, tooling: toolingCost, setup: setupPerUnit, finish: finishDollars, ...terms.perUnit },
    quantity: qty,
    lineTotal: terms.perUnit.final * qty,
    weight: { perUnit: partKg, total: partKg * qty, units: "kg" },
    meta: {
      process: "cnc",
      subProcess: "turning",
      materialSlug: material.slug,
      grade,
      machinability: mach,
      materialClass: cls,
      machineTimeHours: cycle / 60,
      setupMinutes,
      setups: 1,
      fourthAxis: false,
      finishSlug: finish?.slug || "raw",
      discountTier: terms.discountTier,
      floorApplied: terms.floorApplied,
      geometrySummary: {
        stockMm: { w: round(barDia, 1), h: round(barDia, 1), d: round(barLen, 1) },
        stockForm: "bar",
        removalCm3: round((barVol - f.volume) / MM3_PER_CM3, 1),
        volumeRatio: round(derived.volumeRatio, 3),
        surfaceCm2: round(f.surfaceArea / 100, 1),
        shape: "revolved",
        revolved: { diameterMm: round(D, 2), lengthMm: round(L, 2), boreMm: bore ? round(bore, 2) : null },
        holes: f.holes.length,
        pockets: f.pockets.length,
        minWallMm: null,
      },
      costBuildup: cb.steps,
      confidence,
      notes,
    },
  };
}

/**
 * @param {Object} params — { geometry, material, grade, finish, quantity, subProcess, totalPartsInOrder }
 * @param {Object} rules
 */
function calculate(params, rules) {
  const r = rules || {};
  const subProcess = String(params.subProcess || "milling").toLowerCase() === "turning" ? "turning" : "milling";
  const view = resolveFeatures(params.geometry || {}, { subProcess });
  if (subProcess === "turning" && view.f.shape.revolved) return priceTurning(view, params, r);
  return priceMilling(view, params, r);
}

module.exports = { calculate };
