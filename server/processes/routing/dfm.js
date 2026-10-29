/**
 * CNC routing DFM — flat / plate parts on the Techno router (59" × 96" bed, 12" Z, 12-tool ATC).
 * Signature: run(geometry, options) → { checks, summary }
 *   options.thicknessMm   selected stock thickness
 *   options.materialSlug / materialName / material / materialType
 *
 * Rules consume `features` (server/geometry/SCHEMA.md) via the feature adapter. Severity
 * tiers follow server/processes/shared.js: only a part that cannot be cut (bigger than the
 * bed, non-manifold mesh, zero-thickness geometry) FAILS; everything else informs or warns
 * with a cost hint. Thresholds and sources: docs/dfm-standards.md §Routing.
 */
const { summarizeChecks } = require("../shared");
const { check, COST, mm, dia, ratio, num, materialProfile, isLegacy, meshIntegrity } = require("../dfmKit");
const { getFeatures, extents } = require("../featureAdapter");

// Techno: 59" × 96" bed, 12" under the gantry. Usable sheet is 48" × 96".
const BED_X_MM = 2438;   // 96"
const BED_Y_MM = 1499;   // 59"
const BED_Z_MM = 300;    // 12"
const SHEET_W_MM = 1219; // 48" stock
const SHEET_H_MM = 2438; // 96" stock
const SHEET_PLATE_LIMIT_MM = 25.4;   // over 1" the part is really a milling job

// Tool table: diameter, flute length (max full-depth cut) — profile tools run ≤ 3× dia deep in plastics
const TOOLS = [
  { name: '1/16"', dia: 1.5875, maxDepth: 6.0 },
  { name: '1/8"', dia: 3.175, maxDepth: 12.7 },
  { name: '1/4"', dia: 6.35, maxDepth: 25.4 },   // default profile tool
  { name: '3/8"', dia: 9.525, maxDepth: 38.0 },
];
const STD_TOOL = TOOLS[2];

const T = {
  minWeb: { abs: 1.5, frac: 0.5, fracCap: 3.0, pref: 1.0, prefMin: 2.5, prefCap: 6.35 }, // SendCutSend: ≥50% t minimum, 1–1.5× t preferred; capped for thick plastic plate (a 3 mm web in 19 mm stock cuts fine)
  legacyMinWeb: 2.5,
  smallPart: { tab: 40, min: 25.4, tiny: 10 },     // < 40 mm tabs; < 1" (SendCutSend 1" × 2" min) hand work; < 10 mm not holdable
  removal: { warn: 0.5, major: 0.75 },             // SendCutSend max 50% removal
  holeEdge: 1.0,                                   // ≥ 1× dia from an edge (SendCutSend)
  slotEdge: 1.5,
  text: { minStroke: 0.8, rec: 1.6 },              // 1/32" V-bit practical floor; 1/16" clean
  pocket: { rec: 4 },
  acrylicCornerR: 3.175,                           // acrylic: inside corners ≥ 1/8" R to avoid crazing
  zero: 0.05,
};

function smallestToolReaching(thickness) {
  return TOOLS.find((t) => t.maxDepth >= thickness) || TOOLS[TOOLS.length - 1];
}

function run(geometry, options = {}) {
  const { features: f, conf } = getFeatures(geometry, { ...options, subProcess: "sheet" });
  const checks = [];
  const mat = materialProfile(options);
  const ext = extents(f);
  const { long, mid, thin } = ext;
  const selectedThickness = Number(options.thicknessMm) || 0;
  const flatW = num(f.shape.profile.bboxW) || long;
  const flatH = num(f.shape.profile.bboxH) || mid;
  const thickness = selectedThickness > 0 ? selectedThickness : thin;
  const reachTool = smallestToolReaching(thickness);
  const minR = reachTool.dia / 2;

  checks.push(...meshIntegrity("rt", f, conf));

  // 1. Fits the bed (hard limit — either orientation)
  const fitsBed = (Math.max(flatW, flatH) <= BED_X_MM && Math.min(flatW, flatH) <= BED_Y_MM) && thin <= BED_Z_MM;
  checks.push(check({ id: "rt-bed-size", label: "Router Bed Size", severity: fitsBed ? "pass" : "fail", cost: fitsBed ? COST.NONE : COST.MAJOR, confidence: conf.extents, measured: { w: flatW, h: flatH }, threshold: { x: BED_X_MM, y: BED_Y_MM },
    detail: fitsBed
      ? `Part footprint ${flatW.toFixed(0)} × ${flatH.toFixed(0)} mm fits the 59" × 96" bed`
      : `Part footprint ${flatW.toFixed(0)} × ${flatH.toFixed(0)} mm exceeds the 59" × 96" (${BED_Y_MM} × ${BED_X_MM} mm) bed. Split the part with a joint we can rout, or send it as an RFQ` }));

  // 2. Is this a sheet/plate part?
  const isSheetPart = thin > 0 && thin <= SHEET_PLATE_LIMIT_MM && mid >= thin * 1.5; // plate or strip (a 25 × 12.7 rail is a router part)
  const measured25D = f.shape.is25D;
  const not25D = measured25D === false && !isLegacy(conf.shape);
  checks.push(check({ id: "rt-sheet-geometry", label: "Sheet / Plate Geometry", severity: isSheetPart && !not25D ? "pass" : "warn", cost: isSheetPart && !not25D ? COST.NONE : COST.MAJOR, confidence: conf.shape, measured: thin, threshold: SHEET_PLATE_LIMIT_MM,
    detail: isSheetPart && !not25D
      ? `Thickness ${thin.toFixed(1)} mm with a ${mid.toFixed(0)} × ${long.toFixed(0)} mm footprint — good router part`
      : thin > SHEET_PLATE_LIMIT_MM
        ? `Smallest dimension is ${thin.toFixed(1)} mm (over 1"). This is a milling job — select CNC Machining for a better price and finish`
        : not25D
          ? `Part has faces that are not parallel or perpendicular to the sheet (3D surfaces). Routing is 2.5D: pockets, profiles and through-cuts. Select CNC Machining, or flatten the design`
          : `Part is not clearly flat (${thin.toFixed(1)} × ${mid.toFixed(1)} × ${long.toFixed(1)} mm). Routing works for 2.5D parts; 3D surfaces should go to CNC Machining` }));

  // 3. Selected thickness vs. model thickness
  if (selectedThickness > 0 && thin > 0) {
    const delta = Math.abs(selectedThickness - thin);
    const ok = delta <= Math.max(0.6, thin * 0.12);
    checks.push(check({ id: "rt-thickness-match", label: "Stock Thickness Match", severity: ok ? "pass" : "warn", cost: ok ? COST.NONE : COST.MINOR, confidence: conf.extents, measured: thin, threshold: selectedThickness,
      detail: ok
        ? `Selected ${selectedThickness.toFixed(2)} mm stock matches the model (${thin.toFixed(2)} mm)`
        : `Model is ${thin.toFixed(2)} mm thick but ${selectedThickness.toFixed(2)} mm stock is selected. Pockets or a facing pass may be needed — pick the closest stock or confirm in the notes` }));
  }

  // 4. Inside-corner radius vs. the tool that reaches full depth
  const r = num(f.shape.profile.minInternalRadius);
  if (r == null) {
    checks.push(check({ id: "rt-corner-radius", label: "Inside Corner Radius", severity: "info", confidence: conf.profile, threshold: minR, ref: "SendCutSend (R = tool radius)",
      detail: `Inside corners carry the tool radius: ${(STD_TOOL.dia / 2).toFixed(2)} mm with the standard 1/4" tool, ${(TOOLS[1].dia / 2).toFixed(2)} mm with 1/8", ${(TOOLS[0].dia / 2).toFixed(1)} mm with 1/16" on stock ≤ ${TOOLS[0].maxDepth} mm. In ${thickness.toFixed(1)} mm stock the smallest tool that reaches is ${reachTool.name} (R ${minR.toFixed(2)} mm). Square inside corners need a dog-bone or overcut` }));
  } else {
    const sharp = r < 0.1;
    const acrylicTight = mat.brittle && r < T.acrylicCornerR;
    let severity = "pass", cost = COST.NONE, detail;
    if (sharp || r < minR) {
      severity = "warn"; cost = COST.MAJOR;
      detail = `${sharp ? "A square inside corner" : `Inside corner R ${r.toFixed(2)} mm`} is tighter than any tool that reaches ${thickness.toFixed(1)} mm deep (${reachTool.name}, R ${minR.toFixed(2)} mm). Options: open the corner to R ≥ ${minR.toFixed(2)} mm, add a dog-bone/T-bone relief where a square part must seat, or accept that we leave R ${minR.toFixed(2)} mm — tell us which in the notes`;
    } else if (r < STD_TOOL.dia / 2) {
      severity = "pass"; cost = COST.MINOR;
      const tool = TOOLS.find((t) => t.dia / 2 <= r && t.maxDepth >= thickness) || reachTool;
      detail = `Inside corner R ${r.toFixed(2)} mm needs the ${tool.name} tool (slower feed than the standard 1/4") — small adder. R ≥ ${(STD_TOOL.dia / 2).toFixed(2)} mm runs at full speed`;
    } else {
      detail = `Smallest inside corner R ${r.toFixed(2)} mm is cut with the standard 1/4" tool`;
    }
    if (acrylicTight && severity !== "warn") {
      severity = "warn"; cost = COST.MINOR;
      detail += `. In ${mat.label} an inside corner under R ${T.acrylicCornerR.toFixed(1)} mm is a crack starter — open it up where you can`;
    }
    checks.push(check({ id: "rt-corner-radius", label: "Inside Corner Radius", severity, cost, detail, confidence: conf.profile, measured: r, threshold: minR, unit: "mm", ref: "SendCutSend / shop tooling" }));
  }

  // 5. Narrow slots / minimum feature = tool diameter
  let minSlot = num(f.shape.profile.minSlotWidth);
  for (const s of f.slots) { const w = num(s.width); if (w != null && (minSlot == null || w < minSlot)) minSlot = w; }
  if (minSlot == null) {
    const n = f.legacy ? f.legacy.estimatedSlots : 0;
    if (n > 0) {
      checks.push(check({ id: "rt-slot-width", label: "Slot Width", severity: "info", cost: COST.MINOR, confidence: conf.slots, measured: n, ref: "SendCutSend (min = bit dia)",
        detail: `${n} slot(s) estimated. Slots narrower than ${STD_TOOL.dia.toFixed(2)} mm (1/4") are cut with a smaller tool at lower feed — small cost adder; nothing narrower than ${reachTool.dia.toFixed(2)} mm (${reachTool.name}) can be cut through ${thickness.toFixed(1)} mm stock` }));
    }
  } else {
    let severity = "pass", cost = COST.NONE, detail;
    if (minSlot < reachTool.dia) {
      severity = "warn"; cost = COST.MAJOR;
      detail = `Narrowest slot is ${mm(minSlot, 2)}; the smallest tool that reaches through ${thickness.toFixed(1)} mm stock is ${reachTool.name} (${reachTool.dia.toFixed(2)} mm). Widen the slot to ≥ ${reachTool.dia.toFixed(2)} mm, reduce the stock thickness, or we mill it as a secondary operation (hand quote)`;
    } else if (minSlot < STD_TOOL.dia) {
      severity = "pass"; cost = COST.MINOR;
      detail = `Narrowest slot ${mm(minSlot, 2)} is under the 1/4" standard tool — cut with a ${reachTool.name} tool at reduced feed (small adder)`;
    } else {
      detail = `Narrowest slot ${mm(minSlot, 2)} clears the standard 1/4" tool`;
    }
    checks.push(check({ id: "rt-slot-width", label: "Slot Width", severity, cost, detail, confidence: conf.slots, measured: minSlot, threshold: reachTool.dia, unit: "mm", ref: "SendCutSend (min = bit dia)" }));
  }

  // 6. Thin webs — in-plane material between cuts
  const web = num(f.walls.minThickness);
  const legacyWalls = isLegacy(conf.walls);
  if (web != null && (legacyWalls ? web < thin : true)) {
    const minAbs = legacyWalls ? T.legacyMinWeb : Math.max(T.minWeb.abs, Math.min(thickness * T.minWeb.frac, T.minWeb.fracCap));
    const pref = Math.max(T.minWeb.prefMin, Math.min(thickness * T.minWeb.pref, T.minWeb.prefCap));
    let severity = "pass", cost = COST.NONE, detail;
    if (!legacyWalls && web <= T.zero) {
      severity = "fail"; cost = COST.MAJOR;
      detail = `A web measures ${mm(web, 2)} — zero-thickness geometry (two cuts touch). Fix the model`;
    } else if (web < minAbs) {
      severity = "warn"; cost = COST.MAJOR;
      detail = `Smallest web ≈ ${mm(web, 2)}; the floor is ${minAbs.toFixed(1)} mm (${legacyWalls ? "plastics flex and tear out below it" : `≥ 50% of ${thickness.toFixed(1)} mm stock, up to ${T.minWeb.fracCap} mm`}). Webs this thin ${mat.brittle ? "crack in " + mat.label : "flex into the cutter and tear out"} — widen to ≥ ${pref.toFixed(1)} mm (1× thickness) or expect a note from us`;
    } else if (!legacyWalls && web < pref) {
      severity = "warn"; cost = COST.MINOR;
      detail = `Smallest web ≈ ${mm(web, 2)} is between the ${minAbs.toFixed(1)} mm floor and the preferred ${pref.toFixed(1)} mm (1× thickness). Cuttable with a finishing pass at lower feed; widen it if you can`;
    } else {
      detail = `Smallest web ≈ ${mm(web, 2)} — rigid enough to cut cleanly`;
    }
    checks.push(check({ id: "rt-thin-web", label: "Thin Webs", severity, cost, detail, confidence: conf.walls, measured: web, threshold: minAbs, unit: "mm", ref: "SendCutSend (≥50% t, prefer 1–1.5× t)" }));
  }

  // 7. Small-part retention and minimum part size
  const footprint = Math.max(flatW, flatH);
  const minPlanar = Math.min(flatW, flatH);
  if (footprint > 0 && minPlanar < T.smallPart.tiny) {
    checks.push(check({ id: "rt-small-part", label: "Small Part Retention", severity: "warn", cost: COST.MAJOR, confidence: conf.extents, measured: minPlanar, threshold: T.smallPart.tiny, unit: "mm", ref: "SendCutSend min 1\" × 2\"",
      detail: `Part is only ${minPlanar.toFixed(1)} mm across. Under ${T.smallPart.tiny} mm a part cannot be tabbed or held on the vacuum table; it is cut from a strip on the mill instead — quoted by hand or as a batch` }));
  } else if (footprint > 0 && footprint < T.smallPart.tab) {
    const tiny = minPlanar < T.smallPart.min;
    checks.push(check({ id: "rt-small-part", label: "Small Part Retention", severity: tiny ? "warn" : "info", cost: COST.MINOR, confidence: conf.extents, measured: footprint, threshold: T.smallPart.tab, unit: "mm", ref: "SendCutSend tabs ≈ 4.8 mm wide, ½ t deep",
      detail: `Footprint under ${T.smallPart.tab} mm — parts are held with tabs (≈ 4.8 mm wide, half the thickness deep) or an onion-skin and de-tabbed by hand. Expect a small witness mark on one edge; tell us if a face must be mark-free${tiny ? `. Under ${T.smallPart.min} mm the de-tab time exceeds the cut time, so the minimum charge applies` : ""}` }));
  }

  // 8. Holes
  if (f.holes.length > 0) {
    let tiny = null, drilled = 0, csk = 0, deepSmall = 0;
    for (const h of f.holes) {
      const d = num(h.diameter);
      if (d == null) continue;
      if (d < TOOLS[0].dia && (tiny == null || d < tiny)) tiny = d;
      if (d < STD_TOOL.dia) drilled++;
      if (h.kind === "countersunk" || h.kind === "counterbored") csk++;
      if (d < thickness * 0.5) deepSmall++;
    }
    let severity = "pass", cost = drilled > 0 || csk > 0 ? COST.MINOR : COST.NONE, detail;
    if (tiny != null) {
      severity = "warn"; cost = COST.MAJOR;
      detail = `Smallest hole ${dia(tiny, 2)} is under ${TOOLS[0].dia.toFixed(2)} mm (1/16"). Through ${thickness.toFixed(1)} mm stock that is a ${ratio(thickness / tiny)} deep micro hole; open it to ≥ ${TOOLS[0].dia.toFixed(1)} mm (or a tap-drill size you can tell us) or we drill it offline by hand`;
    } else if (deepSmall > 0) {
      severity = "warn"; cost = COST.MINOR;
      detail = `${f.holes.length} hole(s); ${deepSmall} are narrower than half the ${thickness.toFixed(1)} mm stock thickness, so they are drilled (not interpolated) with a peck cycle — small per-hole adder${csk ? `; ${csk} countersink/counterbore(s) are a second tool pass` : ""}`;
    } else {
      detail = `${f.holes.length} hole(s). Holes ≥ ${STD_TOOL.dia.toFixed(2)} mm are interpolated to size; ${drilled} smaller hole(s) are drilled${csk ? `; ${csk} countersink/counterbore(s) add a tool change` : ""}. Keep holes ≥ 1× diameter from an edge (slots ≥ 1.5× width). Tapped holes are done offline — note the thread size`;
    }
    checks.push(check({ id: "rt-holes", label: "Holes", severity, cost, detail, confidence: conf.holes, measured: f.holes.length, threshold: TOOLS[0].dia, ref: "SendCutSend (hole ≥ bit; ≥1× dia from edge)" }));
  } else if (f.legacy && f.legacy.estimatedHoles > 0) {
    const n = f.legacy.estimatedHoles;
    checks.push(check({ id: "rt-holes", label: "Holes", severity: "info", cost: COST.MINOR, confidence: conf.holes, measured: n, ref: "SendCutSend",
      detail: `${n} hole(s) detected. Holes ≥ ${STD_TOOL.dia.toFixed(2)} mm are interpolated to size; smaller holes are drilled. Keep holes ≥ 1× diameter from an edge. Tapped holes are done offline — note the thread size` }));
  }

  // 9. Pockets (partial-depth features in a plate)
  if (f.pockets.length > 0) {
    let worst = null;
    for (const p of f.pockets) { const rr = num(p.depthToWidthRatio); if (rr != null && (worst == null || rr > worst.rr)) worst = { rr, p }; }
    const deep = worst && worst.rr > T.pocket.rec;
    const floorLeft = f.pockets.map((p) => thickness - (num(p.depth) || 0)).filter((x) => Number.isFinite(x));
    const thinFloor = floorLeft.length ? Math.min(...floorLeft) : null;
    const floorBad = thinFloor != null && thinFloor > 0 && thinFloor < Math.max(1.5, thickness * 0.15);
    checks.push(check({ id: "rt-pockets", label: "Pockets", severity: deep || floorBad ? "warn" : "pass", cost: deep || floorBad ? COST.MAJOR : COST.MINOR, confidence: conf.pockets, measured: f.pockets.length, ref: "Hubs 4:1; shop",
      detail: deep
        ? `${f.pockets.length} pocket(s); the deepest is ${ratio(worst.rr)} deeper than it is wide (guideline ≤ ${T.pocket.rec}:1). On the router that means a long small tool at low feed — widen the pocket or move the part to CNC Machining`
        : floorBad
          ? `${f.pockets.length} pocket(s) leave a ${mm(thinFloor, 2)} floor in ${thickness.toFixed(1)} mm stock. Floors under ${Math.max(1.5, thickness * 0.15).toFixed(1)} mm lift on the vacuum table and cut through; leave ≥ 1.5 mm or make it a through-cut`
          : `${f.pockets.length} pocket(s) — routed with a flat end mill, corners carry the tool radius, floors run slightly rougher than the top face (adds pocketing time)` }));
  }

  // 10. Material removal (SendCutSend max 50%)
  const profileArea = num(f.shape.profile.area);
  const blank = flatW * flatH;
  const removed = profileArea != null && blank > 0 ? 1 - profileArea / blank : null;
  if (removed != null && removed > T.removal.warn) {
    checks.push(check({ id: "rt-material-removal", label: "Material Removal", severity: "warn", cost: removed > T.removal.major ? COST.MAJOR : COST.MINOR, confidence: conf.profile, measured: removed, threshold: T.removal.warn, ref: "SendCutSend max 50%",
      detail: `${(removed * 100).toFixed(0)}% of the blank is cut away (guideline ≤ ${T.removal.warn * 100}%). Lacy parts lose vacuum hold and vibrate; expect tabs on the cut-outs and more cutting time per part. A denser design or a thicker web between windows cuts the cost` }));
  }

  // 11. Material notes
  if (mat.brittle) {
    checks.push(check({ id: "rt-material-note", label: `Edge Quality (${mat.label})`, severity: "info", cost: COST.MINOR, confidence: "n/a", ref: "Biesse/Toolstoday acrylic routing",
      detail: `${mat.label} routs with a single-flute O-flute at full depth for the cleanest edge. Cast acrylic gives a clear edge; extruded melts and chips. Edges are as-routed (frosted) unless you order flame or diamond polishing, and inside corners under R 3 mm craze` }));
  } else if (mat.family === "polycarbonate") {
    checks.push(check({ id: "rt-material-note", label: "Edge Quality (polycarbonate)", severity: "info", confidence: "n/a",
      detail: `Polycarbonate is gummy: chips weld to the tool at low feed, so we run sharp O-flutes at high feed; edges are satin, not clear. Protective film stays on until de-tabbing` }));
  } else if (mat.soft) {
    checks.push(check({ id: "rt-material-note", label: `Edge Quality (${mat.label})`, severity: "info", confidence: "n/a", ref: "Quadrant 0.1–0.2%",
      detail: `${mat.label} leaves a small fuzz/burr on the exit edge that we knock off by hand; large parts move ~${(long * 0.0015).toFixed(1)} mm across ${long.toFixed(0)} mm with temperature, so critical dimensions are checked at 68 °F` }));
  } else if (mat.abrasive) {
    checks.push(check({ id: "rt-material-note", label: `Tool Wear (${mat.label})`, severity: "info", cost: COST.MINOR, confidence: "n/a",
      detail: `${mat.label} is abrasive and dusty: carbide or diamond tooling, extra tool changes and extraction are in the price; the edge is matte` }));
  }

  // 12. Engraved text
  if (f.text && f.text.present) {
    const stroke = num(f.text.minStroke);
    const ok = stroke == null || stroke >= T.text.minStroke;
    checks.push(check({ id: "rt-text", label: "Engraved Text", severity: ok ? "pass" : "warn", cost: ok ? COST.MINOR : COST.MAJOR, confidence: conf.text, measured: stroke, threshold: T.text.minStroke, unit: "mm",
      detail: ok
        ? `Text stroke ${stroke != null ? mm(stroke, 2) : "(not measured)"} is engravable with a V-bit or 1/16" end mill — adds an engraving pass`
        : `Text stroke ${mm(stroke, 2)} is finer than the ${T.text.minStroke} mm a V-bit holds in plastic; use ≥ ${T.text.rec} mm strokes (bold sans-serif, 20 pt+) or move it to a label` }));
  }

  // 13. Tolerance capability
  const tol = mat.soft ? "±0.25 mm (±0.010\")" : "±0.13 mm (±0.005\")";
  checks.push(check({ id: "rt-tolerance", label: "Tolerance Capability", severity: "info", confidence: "n/a", ref: "SendCutSend ±0.005\"; Quadrant 0.1–0.2%",
    detail: `Profile tolerance ${tol} typical on ${mat.label}. Large HDPE/UHMW parts move with temperature — call out critical dimensions on the drawing and we hold them at 68 °F` }));

  // 14. Nesting
  const kerf = 6;
  const pw = flatW + kerf, ph = flatH + kerf;
  const perSheet = pw > 0 && ph > 0
    ? Math.max(Math.floor(SHEET_W_MM / pw) * Math.floor(SHEET_H_MM / ph), Math.floor(SHEET_W_MM / ph) * Math.floor(SHEET_H_MM / pw))
    : 0;
  checks.push(check({ id: "rt-nesting", label: "Nesting", severity: "info", confidence: conf.extents, measured: perSheet,
    detail: perSheet > 0
      ? `About ${perSheet} part(s) per 48" × 96" sheet. Quantities that fill whole sheets price best`
      : `Part is larger than a single 48" × 96" sheet footprint — oversize stock or a split is needed` }));

  return { checks, summary: summarizeChecks(checks) };
}

module.exports = { run, TOOLS, THRESHOLDS: T, BED_X_MM, BED_Y_MM, BED_Z_MM };
