/**
 * CNC DFM — milling on the Tormach 1100 / CNC Bridgeport (3-axis + 4th), turning on
 * the manual lathes. Signature: run(geometry, options) → { checks, summary }.
 *
 *   options.subProcess   "milling" | "turning"
 *   options.materialType "plastic" | "metal"
 *   options.materialSlug / materialName / material  (optional — material-aware thresholds)
 *
 * Rules consume `features` (server/geometry/SCHEMA.md) through the feature adapter, so
 * they work on the legacy geometry summary today (confidence "legacy") and sharpen
 * automatically when the geometry module lands. Thresholds and sources are tabulated in
 * docs/dfm-standards.md. Two-tier philosophy (shared.js): only genuine un-makeability
 * FAILS — exceeds every machine, zero-thickness geometry, non-manifold mesh, sharp
 * internal corner measured on a B-rep. Everything else WARNS with a cost hint, and a
 * low-confidence feature never blocks (dfmKit.gate degrades it to info + "verify").
 */
const { summarizeChecks } = require("../shared");
const { check, COST, mm, dia, ratio, num, materialProfile, isLegacy, meshIntegrity, toleranceNote } = require("../dfmKit");
const { getFeatures, extents } = require("../featureAdapter");
const turning = require("./turning");

// ─── shop capacity ──────────────────────────────────────────────────────────
const MILL = { x: 457, y: 241, z: 300 };          // Tormach 1100 / CNC Bridgeport travel, mm
const MILL_INDEX_FACTOR = 2;                     // long parts can be indexed once along X (two setups)
const ROUTER_BED = { x: 2438, y: 1499, z: 300 };  // flat parts can go to the Techno router instead
const SMALLEST_ENDMILL_MM = 1.5875;              // 1/16" — smallest tool we run in production
const MIN_CORNER_RADIUS_MM = SMALLEST_ENDMILL_MM / 2; // 0.79 mm

// ─── thresholds (see docs/dfm-standards.md §CNC) ───────────────────────────
const T = {
  wall: {                          // Hubs / Xometry / Fictiv
    plastic: { rec: 1.5, feasible: 1.0 },
    brittle: { rec: 2.0, feasible: 1.5 },   // shop rule for acrylic / G-10 / phenolic
    metal: { rec: 0.8, feasible: 0.5 },
    zero: 0.05,                    // ≤ this = zero-thickness geometry (FAIL at high confidence)
  },
  tallWall: { plastic: 3, metal: 4, major: 8, majorMetal: 10 },  // Protolabs H<4W; Xometry 10:1 cost ceiling
  cornerRadius: { depthFraction: 1 / 3, sharp: 0.1 },            // Hubs / Protolabs R ≥ depth/3
  pocket: { rec: 4, deep: 6, extreme: 10 },                      // Hubs 4×, Xometry 6× deep
  hole: { rec: 4, reliable: 6, peck: 10, extended: 12, minDia: 1.0, smallDia: 2.5 }, // Hubs/Fictiv/Xometry
  thread: { maxDepth: 3, minDepth: 1.5, blindRelief: 0.5 },      // Protolabs / Hubs
  feature: { micro: 1.0, small: 2.5 },                           // Protolabs 0.5 mm floor; Xometry 2.5 mm tool
  setups: { minor: 3, major: 5 },
  undercut: { minor: 0.0001, major: 0.05 },
  removal: { warn: 0.3, major: 0.12 },                           // volume / bbox — gate uses 0.12 too
  text: { minStroke: 0.5 },                                      // Protolabs 0.020"
  smallPart: 10,                                                 // two dims under this → fixturing
  thinPlate: { thickness: 3, footprint: 100 },                   // clamping distortion in plastics
};

function run(geometry, options = {}) {
  const subProcess = options.subProcess || "milling";
  const { features, conf } = getFeatures(geometry, { ...options, subProcess });
  if (subProcess === "turning") {
    const checks = turning.rules(features, conf, options);
    return { checks, summary: summarizeChecks(checks) };
  }
  const checks = millingRules(features, conf, options);
  return { checks, summary: summarizeChecks(checks) };
}

function millingRules(f, conf, options) {
  const checks = [];
  const mat = materialProfile(options);
  const ext = extents(f);
  const { long, mid, thin } = ext;
  const wallT = mat.isMetal ? T.wall.metal : mat.brittle ? T.wall.brittle : T.wall.plastic;

  // 0. Mesh integrity — only when the geometry module measured it.
  checks.push(...meshIntegrity("cnc", f, conf));

  // 1. Minimum wall thickness
  const minWall = num(f.walls.minThickness);
  if (minWall != null) {
    const legacy = isLegacy(conf.walls);
    let severity, detail, cost = COST.NONE;
    if (minWall <= T.wall.zero && !legacy) {
      severity = "fail"; cost = COST.MAJOR;
      detail = `Thinnest wall measures ${mm(minWall, 2)} — zero-thickness geometry (two faces touch). Fix the model so every wall is ≥ ${wallT.rec} mm`;
    } else if (minWall < wallT.feasible) {
      severity = "warn"; cost = COST.MAJOR;
      detail = `Thinnest wall ${mm(minWall, 2)} is below the ${wallT.feasible} mm floor for ${mat.isMetal ? "metal" : mat.label}. Walls this thin break out or chatter; thicken to ≥ ${wallT.rec} mm or expect a finishing-pass surcharge and a yield risk`;
    } else if (minWall < wallT.rec) {
      severity = "warn"; cost = COST.MINOR;
      detail = `Thinnest wall ${mm(minWall, 2)} is under the ${wallT.rec} mm guideline for ${mat.isMetal ? "metal" : mat.label} (${wallT.feasible} mm is the floor). Makeable with light finishing passes; thicken to ≥ ${wallT.rec} mm to avoid a small adder`;
    } else {
      severity = "pass";
      detail = legacy
        ? `Smallest extent ${mm(minWall, 2)} clears the ${wallT.rec} mm wall guideline (bounding-box proxy — individual walls not yet measured)`
        : `Thinnest wall ${mm(minWall, 2)} clears the ${wallT.rec} mm guideline for ${mat.label}`;
    }
    checks.push(check({ id: "cnc-min-wall-thickness", label: "Minimum Wall Thickness", severity, detail, cost, confidence: conf.walls, measured: minWall, threshold: wallT.rec, unit: "mm", ref: "Hubs/Xometry/Fictiv" }));
  }
  const thinFrac = num(f.walls.thinAreaFraction);
  if (thinFrac != null && thinFrac > 0.2) {
    checks.push(check({ id: "cnc-thin-area", label: "Thin-Section Area", severity: "warn", cost: COST.MAJOR, confidence: conf.walls, measured: thinFrac, threshold: 0.2,
      detail: `${(thinFrac * 100).toFixed(0)}% of the surface sits on sections under 1 mm. Plastics this thin flex under the cutter and lose tolerance; thicken or expect a hand-finished, slower job` }));
  }

  // 2. Machine envelope (any orientation). Escalates: fits → reroute to router → indexed two-setup → FAIL.
  const fitsMill = long <= MILL.x && mid <= MILL.y && thin <= MILL.z;
  const isFlatish = thin <= 25.4 && mid >= thin * 1.5; // plate or strip stock
  const fitsRouter = isFlatish && long <= ROUTER_BED.x && mid <= ROUTER_BED.y;
  const indexable = long <= MILL.x * MILL_INDEX_FACTOR && mid <= MILL.y && thin <= MILL.z;
  const size = `${long.toFixed(0)} × ${mid.toFixed(0)} × ${thin.toFixed(0)} mm`;
  if (fitsMill) {
    checks.push(check({ id: "cnc-max-size", label: "Machine Envelope", severity: "pass", confidence: conf.extents, measured: { long, mid, thin }, threshold: MILL,
      detail: `Part (${size}) fits the mill travel (${MILL.x} × ${MILL.y} × ${MILL.z} mm) in at least one orientation` }));
  } else if (fitsRouter) {
    checks.push(check({ id: "cnc-max-size", label: "Machine Envelope", severity: "warn", cost: COST.MAJOR, confidence: conf.extents, measured: { long, mid, thin }, threshold: MILL,
      detail: `Part (${size}) is longer than the mill travel (${MILL.x} × ${MILL.y} × ${MILL.z} mm) but is a flat plate that fits the 59" × 96" router — select CNC Routing for an instant price, or we reposition it on the mill as an RFQ` }));
  } else if (indexable) {
    checks.push(check({ id: "cnc-max-size", label: "Machine Envelope", severity: "warn", cost: COST.MAJOR, confidence: conf.extents, measured: { long, mid, thin }, threshold: MILL,
      detail: `Part (${size}) exceeds the mill travel (${MILL.x} × ${MILL.y} × ${MILL.z} mm) along its length. It can be indexed in two setups (≤ ${MILL.x * MILL_INDEX_FACTOR} mm) with a witness line at the join — quoted by a person` }));
  } else {
    checks.push(check({ id: "cnc-max-size", label: "Machine Envelope", severity: "fail", cost: COST.MAJOR, confidence: conf.extents, measured: { long, mid, thin }, threshold: MILL,
      detail: `Part (${size}) exceeds every machine in the shop (mill ${MILL.x} × ${MILL.y} × ${MILL.z} mm, even indexed; router bed ${ROUTER_BED.x} × ${ROUTER_BED.y} mm for flat stock). Split the part or send it as an RFQ with a drawing` }));
  }

  // 3. Internal corner radius (vertical walls) vs. tool radius and cavity depth
  checks.push(...cornerRadiusRules(f, conf, mat));

  // 4. Pocket depth-to-width
  checks.push(...pocketRules(f, conf, mat, ext));

  // 5. Holes: diameter, depth, threads
  checks.push(...holeRules(f, conf, mat));

  // 6. Small features / narrow slots
  checks.push(...featureSizeRules(f, conf, mat));

  // 7. Tool access: setups and undercuts
  checks.push(...accessRules(f, conf));

  // 8. Tall thin walls
  const aspect = num(f.walls.tallThinMaxAspect);
  if (aspect != null) {
    const legacy = isLegacy(conf.walls);
    const rec = mat.isMetal ? T.tallWall.metal : T.tallWall.plastic;
    const major = mat.isMetal ? T.tallWall.majorMetal : T.tallWall.major;
    // Legacy aspect = overall part proportions (a 300 × 40 × 10 strip is 30:1 but not a "wall"), so use the
    // old envelope-proportion threshold (5:1 on depth / min horizontal) rather than the wall thresholds.
    let severity = "pass", cost = COST.NONE, detail;
    if (legacy) {
      const dep = f.aabb.d || 0, minHor = Math.max(Math.min(f.aabb.w || 0, f.aabb.h || 0), 0.1);
      const bboxAspect = dep / minHor;
      severity = bboxAspect > 5 ? "warn" : "pass";
      cost = bboxAspect > 5 ? COST.MINOR : COST.NONE;
      detail = bboxAspect > 5
        ? `Overall proportions are ${ratio(bboxAspect)} tall relative to the narrowest footprint (guideline ≤ 5:1 for rigid clamping). Tall, thin parts chatter and deflect; expect a slower finishing pass or add a clamping foot`
        : `Overall proportions ${ratio(bboxAspect)} are rigid enough for standard clamping (individual walls not yet measured)`;
      checks.push(check({ id: "cnc-thin-tall-features", label: "Thin Tall Features", severity, detail, cost, confidence: conf.walls, measured: bboxAspect, threshold: 5, ref: "shop" }));
    } else {
      if (aspect > major) { severity = "warn"; cost = COST.MAJOR; }
      else if (aspect > rec) { severity = "warn"; cost = COST.MINOR; }
      detail = severity === "pass"
        ? `Tallest thin wall is ${ratio(aspect)} its thickness — within the ${rec}:1 guideline for ${mat.isMetal ? "metal" : "plastic"}`
        : `Tallest thin wall is ${ratio(aspect)} its thickness; guideline is ≤ ${rec}:1 for ${mat.isMetal ? "metal" : "plastic"}${aspect > major ? ` and above ${major}:1 it needs step-down finishing with a long-reach tool` : ""}. Options: thicken the wall, shorten it, add a rib, or accept a slower finishing pass`;
      checks.push(check({ id: "cnc-thin-tall-features", label: "Thin Tall Features", severity, detail, cost, confidence: conf.walls, measured: aspect, threshold: rec, ref: "Protolabs/Xometry" }));
    }
  }

  // 9. Material removal (stock efficiency) + stress relief for plastics
  const vol = num(f.volume);
  const bboxVol = (f.aabb.w || 0) * (f.aabb.h || 0) * (f.aabb.d || 0);
  const volumeRatio = vol != null && bboxVol > 0 ? vol / bboxVol : null;
  if (volumeRatio != null) {
    const ok = volumeRatio >= T.removal.warn;
    const heavy = volumeRatio < T.removal.major;
    checks.push(check({ id: "cnc-removal-efficiency", label: "Material Removal Efficiency", severity: ok ? "pass" : "warn", cost: ok ? COST.NONE : heavy ? COST.MAJOR : COST.MINOR, confidence: conf.extents, measured: volumeRatio, threshold: T.removal.warn,
      detail: ok
        ? `Part volume is ${(volumeRatio * 100).toFixed(0)}% of its bounding box — efficient stock use`
        : heavy
          ? `Part volume is only ${(volumeRatio * 100).toFixed(0)}% of its bounding box (under ${T.removal.major * 100}%): most of the block becomes chips, which usually means multiple setups or a 4th-axis job. Consider a near-net blank, a split design, or 3D printing if it is an enclosure`
          : `Part volume is ${(volumeRatio * 100).toFixed(0)}% of its bounding box (guideline ≥ ${T.removal.warn * 100}%). Heavy roughing adds machine time; a near-net blank or thinner starting stock trims it` }));
  }
  // Removal measured against the part's own box (stock padding would dominate small parts); only parts
  // with real section (> 10 cm³) hold enough locked-in stress to move.
  const removalRatio = volumeRatio != null ? 1 - volumeRatio : null;
  if (mat.isPlastic && mat.stressRelief && removalRatio != null && removalRatio > 0.6 && vol > 10000) {
    checks.push(check({ id: "cnc-stress-relief", label: "Stress Relief (Plastics)", severity: "warn", cost: COST.MINOR, confidence: conf.extents, measured: removalRatio, threshold: 0.6, ref: "Boedeker/Curbell/Quadrant",
      detail: `${(removalRatio * 100).toFixed(0)}% of the ${mat.label} block is removed. Asymmetric heavy removal releases locked-in stress and the part moves after machining; for flatness or ±0.13 mm we rough, stress-relieve (anneal) and finish in a second pass — adds a day and a small adder. Call out which faces matter` }));
  }

  // 10. Clamping distortion on thin plastic plates
  if (mat.isPlastic && f.shape.kind === "flat" && num(f.shape.stockThickness) != null && f.shape.stockThickness < T.thinPlate.thickness && long > T.thinPlate.footprint) {
    checks.push(check({ id: "cnc-clamping-distortion", label: "Clamping Distortion", severity: "warn", cost: COST.MINOR, confidence: conf.shape, measured: f.shape.stockThickness, threshold: T.thinPlate.thickness, ref: "Boedeker",
      detail: `A ${mm(f.shape.stockThickness, 1)} ${mat.label} plate ${long.toFixed(0)} mm long bows under vise pressure and springs back after the cut. We hold it on a vacuum or tape fixture — flatness is best-effort unless called out. Thicker stock (≥ ${T.thinPlate.thickness} mm) or routing avoids it` }));
  }

  // 11. Small parts
  if (long > 0 && mid < T.smallPart && thin < T.smallPart) {
    checks.push(check({ id: "cnc-small-part", label: "Small Part Fixturing", severity: "warn", cost: COST.MINOR, confidence: conf.extents, measured: { mid, thin }, threshold: T.smallPart, ref: "Protolabs turning min 4 mm",
      detail: `Two dimensions are under ${T.smallPart} mm (${mid.toFixed(1)} × ${thin.toFixed(1)} mm). Parts this small are machined on a strip or from bar and parted off, so the minimum charge and batch size dominate the price` }));
  }

  // 12. Text
  if (f.text && f.text.present) {
    const stroke = num(f.text.minStroke);
    const ok = stroke == null || stroke >= T.text.minStroke;
    checks.push(check({ id: "cnc-text", label: "Engraved Text", severity: ok ? "pass" : "warn", cost: ok ? COST.MINOR : COST.MAJOR, confidence: conf.text, measured: stroke, threshold: T.text.minStroke, ref: "Protolabs",
      detail: ok
        ? `Text stroke ${stroke != null ? mm(stroke, 2) : "(not measured)"} meets the ${T.text.minStroke} mm minimum. Engraved (recessed) text is machined with a small engraving cutter — adds a short operation`
        : `Text stroke ${mm(stroke, 2)} is under the ${T.text.minStroke} mm minimum (20 pt sans-serif). It will fill in; enlarge the font or move the text to a label. Raised text costs far more than recessed` }));
  }

  // 13. Material notes (moisture, brittleness, cost, coolant)
  checks.push(...materialNotes(f, conf, mat));

  // 14. Tolerance capability — material aware
  checks.push(toleranceNote(mat, long, "cnc-tolerance"));

  return checks;
}

// ─── rule groups (shared with turning where noted) ──────────────────────────

function cornerRadiusRules(f, conf, mat) {
  const out = [];
  const rv = num(f.cornerRadii.minInternalVertical);
  const pocketsWithCorners = f.pockets.filter((p) => num(p.minCornerRadius) != null);
  if (rv == null && pocketsWithCorners.length === 0) {
    out.push(check({ id: "cnc-corner-radius", label: "Internal Corner Radius", severity: "info", confidence: conf.cornerRadii, threshold: MIN_CORNER_RADIUS_MM, ref: "Hubs/Protolabs/Quadrant",
      detail: `Internal vertical corners carry the cutter radius: ≥ ${MIN_CORNER_RADIUS_MM.toFixed(1)} mm with our smallest 1/16" tool, and ideally ≥ 1/3 of the cavity depth (R ≥ 1 mm per Quadrant for plastics). Square inside corners need a dog-bone relief or a broach — call them out` }));
    return out;
  }
  // worst pocket: smallest radius relative to its depth
  // Prefer a pocket entry (it carries depth); fall back to the global minimum radius.
  let worst = null;
  for (const p of pocketsWithCorners) {
    if (worst == null || p.minCornerRadius < worst.radius) worst = { radius: p.minCornerRadius, depth: num(p.depth) };
  }
  if (worst == null || (rv != null && rv < worst.radius)) worst = { radius: rv, depth: worst && rv === worst.radius ? worst.depth : null };
  const r = worst.radius;
  const depth = worst.depth;
  const recForDepth = depth != null ? depth * T.cornerRadius.depthFraction : null;
  const brittleMin = mat.brittle ? 3.0 : null;
  if (r < T.cornerRadius.sharp) {
    const deep = depth == null || depth > 2;
    out.push(check({ id: "cnc-corner-radius", label: "Internal Corner Radius", severity: deep ? "fail" : "warn", cost: COST.MAJOR, confidence: conf.cornerRadii, measured: r, threshold: MIN_CORNER_RADIUS_MM, unit: "mm", ref: "Hubs/Protolabs",
      detail: `An internal vertical corner is sharp (R ${r.toFixed(2)} mm)${depth != null ? ` in a ${mm(depth, 1)} deep cavity` : ""}. No rotating cutter makes a sharp inside corner. Add R ≥ ${Math.max(MIN_CORNER_RADIUS_MM, recForDepth || 0).toFixed(1)} mm${recForDepth ? ` (1/3 of depth)` : ""}, or a dog-bone / T-bone relief if a square part must seat there. If the sharp corner is functional we quote broaching or EDM by hand` }));
  } else if (r < MIN_CORNER_RADIUS_MM) {
    out.push(check({ id: "cnc-corner-radius", label: "Internal Corner Radius", severity: "warn", cost: COST.MAJOR, confidence: conf.cornerRadii, measured: r, threshold: MIN_CORNER_RADIUS_MM, unit: "mm", ref: "shop tooling",
      detail: `Smallest internal corner R ${r.toFixed(2)} mm is below the ${MIN_CORNER_RADIUS_MM.toFixed(2)} mm our 1/16" end mill leaves. Open the corner to R ≥ ${MIN_CORNER_RADIUS_MM.toFixed(1)} mm${recForDepth ? ` (R ≥ ${recForDepth.toFixed(1)} mm is ideal at this depth)` : ""} or add a dog-bone; micro tooling is slow and fragile` }));
  } else if (brittleMin != null && r < brittleMin) {
    out.push(check({ id: "cnc-corner-radius", label: "Internal Corner Radius", severity: "warn", cost: COST.MINOR, confidence: conf.cornerRadii, measured: r, threshold: brittleMin, unit: "mm", ref: "Boedeker (notch sensitivity)",
      detail: `Smallest internal corner R ${r.toFixed(2)} mm in ${mat.label}: tight inside corners are stress risers in brittle stock and start cracks. Open to R ≥ ${brittleMin.toFixed(1)} mm where you can` }));
  } else if (recForDepth != null && r < recForDepth) {
    out.push(check({ id: "cnc-corner-radius", label: "Internal Corner Radius", severity: "warn", cost: COST.MINOR, confidence: conf.cornerRadii, measured: r, threshold: recForDepth, unit: "mm", ref: "Hubs/Protolabs",
      detail: `Internal corner R ${r.toFixed(2)} mm in a ${mm(depth, 1)} deep cavity forces a ${dia(r * 2, 1)} cutter at ${ratio(depth / (r * 2))} its diameter. Guideline is R ≥ 1/3 of depth (${recForDepth.toFixed(1)} mm); a larger radius lets a stiffer tool finish it faster` }));
  } else {
    out.push(check({ id: "cnc-corner-radius", label: "Internal Corner Radius", severity: "pass", confidence: conf.cornerRadii, measured: r, threshold: recForDepth || MIN_CORNER_RADIUS_MM, unit: "mm",
      detail: `Smallest internal corner R ${r.toFixed(2)} mm is reachable with standard tooling${recForDepth ? ` and meets the 1/3-of-depth guideline` : ""}` }));
  }
  const rf = num(f.cornerRadii.minInternalFloor);
  if (rf != null && rf > 0 && rf < 0.5) {
    out.push(check({ id: "cnc-floor-radius", label: "Floor Radius", severity: "warn", cost: COST.MINOR, confidence: conf.cornerRadii, measured: rf, threshold: 0.5, ref: "Hubs",
      detail: `A floor fillet of R ${rf.toFixed(2)} mm needs a matching ball or corner-radius end mill. Use 0.5 mm, 1 mm or no floor radius (a sharp floor corner is free with a flat end mill)` }));
  }
  return out;
}

function pocketRules(f, conf, mat, ext) {
  const out = [];
  if (f.pockets.length === 0) {
    // Legacy proxy: overall bbox proportions (advisory only).
    if (isLegacy(conf.pockets)) {
      const avgHor = Math.max(((f.aabb.w || 0) + (f.aabb.h || 0)) / 2, 0.1);
      const r = (f.aabb.d || 0) / avgHor;
      out.push(check({ id: "cnc-pocket-ratio", label: "Pocket Depth-to-Width Ratio", severity: r <= T.pocket.rec ? "pass" : "info", confidence: conf.pockets, measured: r, threshold: T.pocket.rec,
        detail: r <= T.pocket.rec
          ? `Overall depth-to-width ${ratio(r, 2)} is within the ${T.pocket.rec}:1 guideline (pockets not yet measured individually)`
          : `Overall depth-to-width ${ratio(r, 2)} exceeds ${T.pocket.rec}:1. Deep narrow cavities need long tools that deflect and chatter — keep pocket depth ≤ ${T.pocket.rec}× width` }));
    }
    return out;
  }
  let worst = null;
  for (const p of f.pockets) {
    const r = num(p.depthToWidthRatio);
    if (r != null && (worst == null || r > worst.r)) worst = { r, p };
  }
  if (!worst) return out;
  const { r, p } = worst;
  const width = Math.sqrt(num(p.area) || 0);
  let severity = "pass", cost = COST.NONE, detail;
  if (r > T.pocket.extreme) { severity = "warn"; cost = COST.MAJOR; }
  else if (r > T.pocket.deep) { severity = "warn"; cost = COST.MAJOR; }
  else if (r > T.pocket.rec) { severity = "warn"; cost = COST.MINOR; }
  detail = severity === "pass"
    ? `Deepest pocket is ${mm(p.depth, 1)} deep for ~${width.toFixed(0)} mm across (${ratio(r)}) — within the ${T.pocket.rec}:1 guideline`
    : `Deepest pocket is ${mm(p.depth, 1)} deep for ~${width.toFixed(0)} mm across (${ratio(r)}); guideline ≤ ${T.pocket.rec}:1, over ${T.pocket.deep}:1 is a deep cavity${r > T.pocket.extreme ? " beyond standard tool reach" : ""}. Options: reduce depth, widen the pocket, open one side, or accept long-reach tooling at lower feed${mat.isPlastic ? " (plastics also pack chips in deep pockets — air blast and pecking)" : ""}`;
  out.push(check({ id: "cnc-pocket-ratio", label: "Pocket Depth-to-Width Ratio", severity, detail, cost, confidence: conf.pockets, measured: r, threshold: T.pocket.rec, ref: "Hubs/Xometry/Fictiv" }));
  return out;
}

function holeRules(f, conf, mat) {
  const out = [];
  if (f.holes.length === 0) {
    const n = f.legacy ? f.legacy.estimatedHoles : 0;
    if (n > 0 && isLegacy(conf.holes)) {
      out.push(check({ id: "cnc-holes", label: "Holes", severity: "info", cost: COST.MINOR, confidence: conf.holes, measured: n, ref: "Hubs/Fictiv",
        detail: `About ${n} hole feature(s) estimated. Standard drills to 4× diameter are routine, 6× is the reliable limit, 10× needs peck drilling. Tapped holes: thread depth ≤ 3× diameter; note the thread size on the drawing` }));
    }
    return out;
  }
  // Depth-to-diameter: worst hole
  let worst = null, tiny = null, small = 0, tapped = [];
  for (const h of f.holes) {
    const d = num(h.diameter), depth = num(h.depth);
    const r = num(h.depthToDiaRatio) != null ? h.depthToDiaRatio : d && depth != null ? depth / d : null;
    if (r != null && (worst == null || r > worst.r)) worst = { r, h };
    if (d != null && d < T.hole.minDia && (tiny == null || d < tiny.diameter)) tiny = h;
    if (d != null && d >= T.hole.minDia && d < T.hole.smallDia) small++;
    if (h.kind === "tapped-candidate") tapped.push(h);
  }
  if (worst) {
    const { r, h } = worst;
    let severity = "pass", cost = COST.NONE;
    if (r > T.hole.extended) { severity = "warn"; cost = COST.MAJOR; }
    else if (r > T.hole.reliable) { severity = "warn"; cost = COST.MINOR; }
    else if (r > T.hole.rec) { severity = "pass"; cost = COST.MINOR; }
    const open = (h.depth / T.hole.reliable);
    out.push(check({ id: "cnc-hole-depth", label: "Hole Depth-to-Diameter", severity, cost, confidence: conf.holes, measured: r, threshold: T.hole.reliable, ref: "Hubs/Fictiv/Xometry",
      detail: severity === "pass"
        ? `Deepest hole ${dia(h.diameter)} × ${mm(h.depth, 1)} is ${ratio(r)} diameter — ${r > T.hole.rec ? `above the ${T.hole.rec}× guideline but within the ${T.hole.reliable}× reliable limit (small time adder)` : `within the ${T.hole.rec}× guideline`}`
        : `Hole ${dia(h.diameter)} × ${mm(h.depth, 1)} deep is ${ratio(r)} diameter; standard drills reach ${T.hole.reliable}× reliably, ${T.hole.peck}× with peck cycles${r > T.hole.extended ? `, and beyond ${T.hole.extended}× needs extended drills or drilling from both sides` : ""}. Options: reduce depth, open the hole to ${dia(open, 1)} (${T.hole.reliable}×), drill from both ends, or accept a per-hole peck-drilling adder${mat.isPlastic ? ". Plastics pack chips, so we peck every ~1.5× diameter (Quadrant)" : ""}` }));
  }
  if (tiny) {
    out.push(check({ id: "cnc-hole-diameter", label: "Minimum Hole Diameter", severity: "warn", cost: COST.MAJOR, confidence: conf.holes, measured: tiny.diameter, threshold: T.hole.minDia, unit: "mm", ref: "Hubs/Protolabs",
      detail: `Hole ${dia(tiny.diameter, 2)} is under the ${T.hole.minDia} mm minimum for drilling on our spindles (10k rpm). Micro drills break and wander; open it to ≥ ${T.hole.minDia} mm, or ≥ ${T.hole.smallDia} mm to use a standard drill. Otherwise we quote it by hand` }));
  } else if (small > 0) {
    out.push(check({ id: "cnc-hole-diameter", label: "Minimum Hole Diameter", severity: "pass", cost: COST.MINOR, confidence: conf.holes, measured: small, threshold: T.hole.smallDia, ref: "Xometry",
      detail: `${small} hole(s) between ${T.hole.minDia} and ${T.hole.smallDia} mm. Drillable, but small drills run slow and break — expect a small per-hole adder` }));
  }
  if (tapped.length > 0) {
    let deep = null;
    for (const h of tapped) {
      const d = num(h.diameter), depth = num(h.depth);
      const r = d && depth != null ? depth / d : null;
      if (r != null && (deep == null || r > deep.r)) deep = { r, h };
    }
    const r = deep ? deep.r : null;
    const over = r != null && r > T.thread.maxDepth;
    out.push(check({ id: "cnc-thread-depth", label: "Thread Depth", severity: over ? "warn" : "pass", cost: over ? COST.MINOR : COST.MINOR, confidence: conf.holes, measured: r, threshold: T.thread.maxDepth, ref: "Protolabs/Hubs",
      detail: over
        ? `Tap-drill ${dia(deep.h.diameter)} × ${mm(deep.h.depth, 1)} suggests a thread ${ratio(r)} diameter deep; guideline ≤ ${T.thread.maxDepth}× (no extra strength past 1.5×, and taps break beyond 3×). Shorten the thread to ${mm(deep.h.diameter * T.thread.maxDepth, 1)} and leave ≥ ${T.thread.blindRelief}× diameter unthreaded at the bottom of a blind hole${mat.brittle ? `. Threads in ${mat.label} crack — use inserts` : ""}`
        : `${tapped.length} tap-drill-sized hole(s). Threads are tapped offline (≤ ${T.thread.maxDepth}× diameter, blind holes keep ${T.thread.blindRelief}× unthreaded at the bottom) — note the thread size and we include it${mat.brittle ? `. ${mat.label} is brittle: threaded inserts are safer than cut threads` : ""}` }));
  }
  return out;
}

function featureSizeRules(f, conf, mat) {
  const out = [];
  let minW = num(f.shape.profile.minSlotWidth);
  for (const s of f.slots) {
    const w = num(s.width);
    if (w != null && (minW == null || w < minW)) minW = w;
  }
  if (minW == null) {
    const n = f.legacy ? f.legacy.estimatedSlots : 0;
    if (n > 0 && isLegacy(conf.slots)) {
      out.push(check({ id: "cnc-tool-access", label: "Tool Access", severity: "info", confidence: conf.slots, measured: n,
        detail: `About ${n} slot feature(s) estimated. Slots narrower than ${T.feature.small} mm need small tooling at reduced feed; anything under ${T.feature.micro} mm is micro-machining. Keep slot width ≥ 2× its depth / 6 where you can` }));
    } else if (isLegacy(conf.slots)) {
      out.push(check({ id: "cnc-tool-access", label: "Tool Access", severity: "info", confidence: conf.slots,
        detail: `Verify every cavity admits a standard end mill (≥ ${T.feature.small} mm wide); narrower features need micro tooling and slower feeds` }));
    } else {
      out.push(check({ id: "cnc-min-feature", label: "Minimum Feature Size", severity: "pass", confidence: conf.slots, threshold: T.feature.small, unit: "mm",
        detail: `No slots or narrow features under ${T.feature.small} mm found — standard tooling throughout` }));
    }
    return out;
  }
  if (minW < T.feature.micro) {
    out.push(check({ id: "cnc-min-feature", label: "Minimum Feature Size", severity: "warn", cost: COST.MAJOR, confidence: conf.slots, measured: minW, threshold: T.feature.micro, unit: "mm", ref: "Protolabs 0.5 mm / shop 1.0 mm",
      detail: `Narrowest slot/feature is ${mm(minW, 2)}; our practical floor is ${T.feature.micro} mm (Protolabs' absolute floor is 0.5 mm). Widen to ≥ ${T.feature.small} mm, or it becomes a micro-tool job quoted by hand` }));
  } else if (minW < T.feature.small) {
    out.push(check({ id: "cnc-min-feature", label: "Minimum Feature Size", severity: "warn", cost: COST.MINOR, confidence: conf.slots, measured: minW, threshold: T.feature.small, unit: "mm", ref: "Xometry 2.5 mm tool",
      detail: `Narrowest slot/feature is ${mm(minW, 2)} — under the ${T.feature.small} mm standard-tool minimum. Cut with a ${dia(Math.min(minW, 2), 1)} end mill at reduced feed; widen to ≥ ${T.feature.small} mm to avoid the adder${mat.soft ? ` (${mat.label} also flexes away from small cutters)` : ""}` }));
  } else {
    out.push(check({ id: "cnc-min-feature", label: "Minimum Feature Size", severity: "pass", confidence: conf.slots, measured: minW, threshold: T.feature.small, unit: "mm",
      detail: `Narrowest slot/feature ${mm(minW, 2)} admits standard tooling (≥ ${T.feature.small} mm)` }));
  }
  return out;
}

function accessRules(f, conf) {
  const out = [];
  const setups = num(f.access.minSetups3Axis);
  const undercut = num(f.access.undercutAreaFraction);
  if (setups == null && undercut == null) {
    // Legacy heuristic (informational): many bends/slots → complex geometry.
    const L = f.legacy || {};
    const complex = (L.estimatedBends || 0) > 2 || (L.estimatedSlots || 0) > 1;
    out.push(check({ id: "cnc-undercut", label: "Undercut Detection", severity: complex ? "info" : "pass", confidence: conf.access,
      detail: complex
        ? `Complex geometry estimated (${L.estimatedBends || 0} bends, ${L.estimatedSlots || 0} slots). Verify no undercuts block tool access; features not visible from a flat face need a 4th axis or a second setup`
        : `Geometry appears to have low undercut risk` }));
    return out;
  }
  if (setups != null) {
    let severity = "pass", cost = COST.NONE;
    if (setups >= T.setups.major) { severity = "warn"; cost = COST.MAJOR; }
    else if (setups >= T.setups.minor) { severity = "warn"; cost = COST.MINOR; }
    out.push(check({ id: "cnc-tool-access", label: "Tool Access / Setups", severity, cost, confidence: conf.access, measured: setups, threshold: T.setups.minor, ref: "Protolabs (top/bottom only > 254 mm)",
      detail: severity === "pass"
        ? `All faces are reachable in ${setups} setup${setups > 1 ? "s" : ""} on a 3-axis mill`
        : `Faces need ${setups} setups on a 3-axis mill (guideline ≤ 2). Each setup adds fixturing time and a tolerance stack; move features to two opposite faces, or we use the 4th axis where the part fits` }));
  }
  if (undercut != null) {
    let severity = "pass", cost = COST.NONE;
    if (undercut > T.undercut.major) { severity = "warn"; cost = COST.MAJOR; }
    else if (undercut > T.undercut.minor) { severity = "warn"; cost = COST.MINOR; }
    out.push(check({ id: "cnc-undercut", label: "Undercut Detection", severity, cost, confidence: conf.access, measured: undercut, threshold: T.undercut.major, ref: "Hubs (T-slot/dovetail tooling)",
      detail: severity === "pass"
        ? `No undercut faces — every surface is visible from an axis-aligned direction`
        : `${(undercut * 100).toFixed(1)}% of the surface is undercut (hidden from every axis direction). Needs T-slot/dovetail cutters, a 4th-axis setup or a split part; standard undercut widths (whole mm) with ≥ 4× depth clearance to the next wall keep it tool-friendly` }));
  }
  return out;
}

function materialNotes(f, conf, mat) {
  const out = [];
  if (mat.hygroscopic) {
    out.push(check({ id: "cnc-moisture", label: "Moisture (Nylon)", severity: "info", confidence: "n/a", ref: "Boedeker/Quadrant",
      detail: `${mat.label} absorbs moisture and grows (dimensions move ~0.5–2% between dry and saturated). We machine from conditioned stock; hold ±0.13 mm only on features called out, and expect ±0.25 mm on the rest. Drying takes ≥ 24 h per 3 mm of thickness if you need dry-as-machined` }));
  }
  if (mat.brittle) {
    const thinWall = num(f.walls.minThickness);
    const risky = thinWall != null && thinWall < 3 && !isLegacy(conf.walls);
    out.push(check({ id: "cnc-brittle-material", label: `Brittle Material (${mat.label})`, severity: risky ? "warn" : "info", cost: risky ? COST.MINOR : COST.NONE, confidence: risky ? conf.walls : "n/a", ref: "Boedeker",
      detail: risky
        ? `${mat.label} walls under 3 mm (${mm(thinWall, 2)} here) chip and crack at the cutter exit. Thicken, add generous radii, and avoid tapped holes — we run sharp carbide and climb cuts, but yield loss is on the quote`
        : `${mat.label} is notch-sensitive: use generous inside radii, avoid threads (inserts instead), and expect polished rather than as-machined edges on clear parts. Water-based coolant only — petroleum coolants craze it` }));
  } else if (mat.amorphous) {
    out.push(check({ id: "cnc-coolant", label: "Coolant Compatibility", severity: "info", confidence: "n/a", ref: "Boedeker/Quadrant",
      detail: `${mat.label} stress-cracks with petroleum cutting fluids; we machine it dry or with air/water. Anneal before machining if the part has tight tolerances` }));
  }
  if (mat.abrasive) {
    out.push(check({ id: "cnc-abrasive-material", label: "Abrasive Material", severity: "info", cost: COST.MINOR, confidence: "n/a", ref: "Curbell",
      detail: `${mat.label} wears tools fast (glass/fiber filler) and sheds dust. Carbide tooling, extra tool changes and dust extraction are built into the price; expect a slightly rougher edge than on unfilled plastics` }));
  }
  if (mat.highCost) {
    const rr = num(f.stock.removalRatioBlock);
    out.push(check({ id: "cnc-material-cost", label: "High-Cost Stock", severity: "info", cost: COST.NONE, confidence: conf.stock, measured: rr,
      detail: `${mat.label} stock is the dominant cost${rr != null ? ` — ${(rr * 100).toFixed(0)}% of the block becomes chips` : ""}. Start from the nearest rod or plate size, keep the envelope compact, or split the part into a ${mat.label} wear face on a cheaper body` }));
  }
  if (mat.soft) {
    out.push(check({ id: "cnc-soft-material", label: `Soft Material (${mat.label})`, severity: "info", confidence: "n/a", ref: "Quadrant 0.1–0.2% / Boedeker",
      detail: `${mat.label} flexes under the cutter and clamp and moves ~0.1–0.2% with temperature. Realistic tolerance is ±0.25 mm (±0.13 mm on called-out features at 68 °F). Thin walls and small holes come out slightly undersize; tell us the mating part and we fit to it` }));
  }
  return out;
}

module.exports = { run, millingRules, holeRules, THRESHOLDS: T, MILL, ROUTER_BED, MIN_CORNER_RADIUS_MM };
