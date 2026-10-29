/**
 * CNC routing pricing — flat / plate parts nested and cut from sheet on the
 * Techno RG 5996 (59" × 96", 18–24k RPM, ATC).
 *
 * Per part (minutes), then × router rate:
 *   cut      = (outer + inner profile) × passes ÷ feed(material class, cutter)
 *              cutter: 1/4" by default, 3/8" over 1/4" stock (faster), 1/8"
 *              when internal corners demand it (slower); passes = thickness ÷
 *              max depth per pass for that cutter (aluminum stays shallow)
 *   pockets  = blind removal volume ÷ pocket rate(material class)
 *   plunges  = each hole / inner contour × seconds per plunge
 *   de-tab + handling per part
 *   per sheet (shared by every part on it): sheet handling + tool changes
 * Per lot: setup (nest, CAM, first article).
 * Material: blank (part + kerf margin each side) × thickness ÷ nest yield.
 * Tool wear: $/m of cut × class factor.
 *
 * Feeds come from chip load × flutes × 18,000 RPM (fusion-cam-programmer
 * references/feeds-speeds.md): 1/4" O-flute in HDPE 0.006" × 18k = 2,740 mm/min;
 * 2-flute acetal 0.003" × 2 × 18k = 2,740; cast acrylic 0.002" × 2 × 18k = 1,830;
 * aluminum 0.002" × 2 × 18k = 1,830 but DOC ≤ 1.5 mm. Those are the defaults
 * in ruleSchema.routerFeedMmPerMin.
 */
const { clampNumber, costBuildup, round, tableValue, applyCommercialTerms, finishCost } = require("../shared");
const { resolveFeatures } = require("../featureAdapter");

const LB_IN3_TO_G_CM3 = 27.6799;

function calculate(params, rules) {
  const { geometry, material, thicknessMm: thicknessIn = 0, grade, finish, quantity, totalPartsInOrder = 1 } = params;
  const r = rules || {};
  const qty = Math.max(1, Number(quantity) || 1);
  const cb = costBuildup();

  const gradeData = (material.grades || []).find((g) => g.name === grade) || (material.grades || [])[0] || { density: 0.04 };
  const densityGcm3 = (Number(gradeData.density) || 0.04) * LB_IN3_TO_G_CM3;
  const pricePerKg = Number(material.pricePerKg || material.costPerKg) || 6.0;
  const feedClass = material.feedClass || "medium";
  const routerRate = clampNumber(r.routerMachineRatePerHour, 1, 1e4, 95);

  const view = resolveFeatures(geometry || {}, { thicknessMm: thicknessIn });
  const { f, derived, confidence, notes } = view;
  const dims = { a: f.obb.w, b: f.obb.h, c: f.obb.d };
  // Stock thickness: the one the customer picked, else the model's own, else 1/4".
  const thicknessMm = thicknessIn > 0 ? thicknessIn : dims.c > 0 ? dims.c : 6.35;
  const flatWidth = f.shape.profile.bboxW || dims.a;
  const flatHeight = f.shape.profile.bboxH || dims.b;

  // ─── 1. MATERIAL: blank + nest waste ──────────────────────────────────────
  const kerf = clampNumber(r.routerKerfMarginMm, 0, 50, 6);
  const nestYield = clampNumber(r.routerNestYield, 0.1, 1, 0.85);
  const blankAreaMm2 = (flatWidth + 2 * kerf) * (flatHeight + 2 * kerf);
  const blankKg = (blankAreaMm2 * thicknessMm / 1000) * densityGcm3 / 1000;
  const waste = clampNumber(material.wasteFactor, 0, 2, 0);
  const materialCost = cb.add("material", {
    dollars: (blankKg / nestYield) * (1 + waste) * pricePerKg,
    basis: `blank ${round(flatWidth + 2 * kerf, 0)}×${round(flatHeight + 2 * kerf, 0)}×${thicknessMm} mm = ${round(blankKg * 1000, 0)} g ÷ ${round(nestYield * 100, 0)}% nest yield × $${pricePerKg}/kg`,
  });
  const partKg = (f.volume / 1000) * densityGcm3 / 1000;

  // ─── 2. CUTTER + PASSES ───────────────────────────────────────────────────
  const baseFeed = tableValue(r.routerFeedMmPerMin, feedClass, 2700);
  let cutter, feed, doc;
  const minR = f.shape.profile.minInternalRadius;
  if (feedClass === "aluminum") {
    cutter = '1/4" (aluminum)'; feed = baseFeed; doc = tableValue(r.routerMaxDocMm, "aluminum", 1.5);
  } else if (Number.isFinite(minR) && minR !== null && minR < clampNumber(r.routerSmallToolRadiusMm, 0.5, 10, 3.2)) {
    cutter = '1/8"'; feed = baseFeed * clampNumber(r.routerSmallToolFeedFactor, 0.05, 1, 0.55); doc = tableValue(r.routerMaxDocMm, "eighth", 3.2);
  } else if (thicknessMm > tableValue(r.routerMaxDocMm, "quarter", 6.5)) {
    cutter = '3/8"'; feed = baseFeed * clampNumber(r.routerThickToolFeedFactor, 0.1, 3, 1.25); doc = tableValue(r.routerMaxDocMm, "threeEighths", 9.6);
  } else {
    cutter = '1/4"'; feed = baseFeed; doc = tableValue(r.routerMaxDocMm, "quarter", 6.5);
  }
  const passes = Math.max(1, Math.ceil(thicknessMm / doc));

  // ─── 3. CYCLE (per part) ──────────────────────────────────────────────────
  const outerMm = f.shape.profile.perimeter || 2 * (flatWidth + flatHeight);
  const innerMm = f.shape.profile.innerPerimeter || 0;
  const cutLengthMm = (outerMm + innerMm) * passes;
  const m = {};
  m.cut = cutLengthMm / feed;

  const pocketCm3 = Math.max(0, derived.blindRemovalMm3 ?? 0) / 1000;
  const pocketRate = tableValue(r.routerPocketCm3PerMin, feedClass, 25);
  m.pocket = pocketCm3 / pocketRate;

  // Plunges: one per hole / inner contour. Without a feature list, estimate
  // contours from the inner edge length (capped — pockets inflate it).
  let plunges;
  if (confidence.fields.holes !== "legacy") {
    plunges = f.holes.length + (f.slots?.length || 0) + f.pockets.length;
  } else {
    plunges = Math.min(12, Math.round(innerMm / 40));
  }
  m.plunge = (plunges * clampNumber(r.routerHoleSeconds, 0, 60, 4)) / 60;
  m.detab = clampNumber(r.routerTabMinutesPerPart, 0, 30, 0.4);
  m.handling = clampNumber(r.routerHandlingMinutesPerPart, 0, 30, 0.3);

  // Per-sheet work shared by the parts on that sheet
  const sheetW = clampNumber(r.routerSheetWMm, 100, 3000, 1219), sheetH = clampNumber(r.routerSheetHMm, 100, 4000, 2438);
  const pw = flatWidth + kerf, ph = flatHeight + kerf;
  const perSheet = Math.max(1, Math.floor(sheetW / pw) * Math.floor(sheetH / ph), Math.floor(sheetW / ph) * Math.floor(sheetH / pw));
  const partsOnSheet = Math.min(perSheet, qty);
  const toolsPerJob = clampNumber(r.routerToolsPerJob, 1, 12, 2);
  const sheetMinutes = clampNumber(r.routerSheetHandlingMinutes, 0, 120, 6) + (toolsPerJob * clampNumber(r.routerToolChangeSeconds, 0, 300, 12)) / 60;
  m.sheet = sheetMinutes / partsOnSheet;

  const cycleMinutes = m.cut + m.pocket + m.plunge + m.detab + m.handling + m.sheet;
  const machineCost = (cycleMinutes / 60) * routerRate;

  cb.add("cut profile", { minutes: m.cut, dollars: (m.cut / 60) * routerRate, basis: `${round(outerMm, 0)} outer + ${round(innerMm, 0)} inner mm × ${passes} pass(es) ÷ ${round(feed, 0)} mm/min (${cutter}, ${feedClass})` });
  if (m.pocket > 0) cb.add("pockets", { minutes: m.pocket, dollars: (m.pocket / 60) * routerRate, basis: `${round(pocketCm3, 1)} cm³ ÷ ${pocketRate} cm³/min` });
  if (plunges > 0) cb.add("plunges", { minutes: m.plunge, dollars: (m.plunge / 60) * routerRate, basis: `${plunges} hole(s)/contour(s) × ${clampNumber(r.routerHoleSeconds, 0, 60, 4)} s${confidence.fields.holes === "legacy" ? " (estimated from inner edge length)" : ""}` });
  cb.add("de-tab", { minutes: m.detab, dollars: (m.detab / 60) * routerRate, basis: "snap tabs, clean edge" });
  cb.add("handle", { minutes: m.handling, dollars: (m.handling / 60) * routerRate, basis: "unload, inspect, pack" });
  cb.add("sheet share", { minutes: m.sheet, dollars: (m.sheet / 60) * routerRate, basis: `${round(sheetMinutes, 1)} min per sheet ÷ ${partsOnSheet} part(s) on it (${perSheet} fit)` });

  // ─── 4. TOOL WEAR ─────────────────────────────────────────────────────────
  const wearMult = feedClass === "abrasive" ? clampNumber(r.routerAbrasiveWearFactor, 1, 20, 3) : feedClass === "aluminum" ? clampNumber(r.routerAluminumWearFactor, 1, 20, 1.5) : 1;
  const toolingCost = cb.add("tooling", { dollars: (cutLengthMm / 1000) * clampNumber(r.routerToolWearPerMeter, 0, 50, 0.35) * wearMult, basis: `${round(cutLengthMm / 1000, 2)} m × $${clampNumber(r.routerToolWearPerMeter, 0, 50, 0.35)}/m × ${wearMult}` });

  // ─── 5. SETUP (per lot) ───────────────────────────────────────────────────
  const setupMinutes = clampNumber(r.routerSetupMinutes, 0, 240, 20);
  const setupPerUnit = cb.add("setup", { minutes: setupMinutes / qty, dollars: (setupMinutes / 60) * routerRate / qty, basis: `nest + CAM + first article ${setupMinutes} min ÷ ${qty} pcs` });

  // ─── 6. FINISH ────────────────────────────────────────────────────────────
  const finishDollars = cb.add("surface finish", { dollars: finishCost(finish, f.surfaceArea), basis: finish ? `${finish.name || finish.slug}` : "as cut" });

  // ─── 7. COMMERCIAL TERMS ──────────────────────────────────────────────────
  const perUnitBase = materialCost + machineCost + toolingCost + setupPerUnit + finishDollars;
  const terms = applyCommercialTerms({ perUnitBase, materialCost, quantity: qty, totalPartsInOrder, minimum: r.routerMinimumPartPrice ?? r.minimumPartPrice ?? 6 }, r);

  return {
    perUnit: { material: materialCost, cutting: machineCost, tooling: toolingCost, setup: setupPerUnit, finish: finishDollars, ...terms.perUnit },
    quantity: qty,
    lineTotal: terms.perUnit.final * qty,
    weight: { perUnit: partKg, total: partKg * qty, units: "kg" },
    meta: {
      process: "routing",
      subProcess: "sheet",
      materialSlug: material.slug,
      grade,
      thicknessMm,
      feedClass,
      cutter,
      passes,
      cutLengthMm: Math.round(cutLengthMm),
      cycleMinutes: Number(cycleMinutes.toFixed(2)),
      setupMinutes,
      partsPerSheet: perSheet,
      pocketCm3: round(pocketCm3, 1),
      finishSlug: finish?.slug || "rt-as-cut",
      discountTier: terms.discountTier,
      floorApplied: terms.floorApplied,
      geometrySummary: {
        blankMm: { w: round(flatWidth + 2 * kerf, 1), h: round(flatHeight + 2 * kerf, 1), t: thicknessMm },
        outerPerimeterMm: round(outerMm, 0),
        innerPerimeterMm: round(innerMm, 0),
        volumeRatio: round(derived.volumeRatio, 3),
        shape: f.shape.kind,
        modelThicknessMm: round(dims.c, 2),
      },
      costBuildup: cb.steps,
      confidence,
      notes,
    },
  };
}

module.exports = { calculate };
