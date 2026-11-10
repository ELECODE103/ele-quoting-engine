/**
 * DXF input tests (no framework). Run: `node server/geometry/dxf/dxf.test.js`
 *
 * Every fixture is generated here with ./writer.js, so each has a perimeter
 * and area known analytically; measured values must be within 0.1 %.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const w = require("./writer");
const { parseDXF, materialize, featuresFromProfile, is2D } = require("./index");
const { readDxf, resolveUnits } = require("./parse");
const { parseFile, runDFMAnalysis } = require("../../parsers/fileParser");
const { PricingEngine } = require("../../services/pricingEngine");
const quoteGate = require("../../services/quoteGate");
const routingDfm = require("../../processes/routing/dfm");
const { calculate } = require("../../processes/routing/pricing");
const { validateFileContent } = require("../../middleware/fileValidator");
const { DEFAULT_PRICING_RULES, ROUTING_MATERIALS, CNC_MATERIALS } = require("../../config/defaults");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const pending = [];
function testAsync(name, fn) {
  pending.push(fn().then(() => { passed++; console.log(`  ok   ${name}`); }, (err) => { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }));
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${what || ""} expected ${b} ±${tol * 100}% got ${a}`);
const TOL = 0.001; // 0.1 %
const PI = Math.PI;
const hdpe = ROUTING_MATERIALS.find((m) => m.slug === "rt-hdpe");
const acrylic = ROUTING_MATERIALS.find((m) => m.slug === "rt-acrylic");
const find = (dfm, id) => dfm.checks.find((c) => c.id === id);
const rtDfm = (g, t = 6.35, extra = {}) => runDFMAnalysis(g, { process: "routing", thicknessMm: t, materialSlug: "rt-hdpe", materialName: "HDPE Sheet", ...extra });

// ─── fixtures ────────────────────────────────────────────────────────────────
const HOLES = [[25, 25], [75, 25], [125, 25], [25, 75], [75, 75], [125, 75]];
const FX = {
  // 150 × 100 plate, six Ø6.6 holes (the harness's plate_hole_pattern)
  plateHoles: () => w.dxf({ insunits: 4, measurement: 1, entities: [w.rect(0, 0, 150, 100), ...HOLES.map(([x, y]) => w.circle(x, y, 3.3))] }),
  // 200 × 80 plate with R10 corners (bulged polyline) and a 60 × 12 stadium slot (bulge 1 ends)
  bulgedSlot: () => w.dxf({ insunits: 4, entities: [w.roundRect(0, 0, 200, 80, 10), w.slot(100, 40, 60, 12)] }),
  // 6 × 4 inch plate with a Ø0.5 in hole, declared in inches
  inchPlate: () => w.dxf({ insunits: 1, measurement: 0, entities: [w.rect(0, 0, 6, 4), w.circle(3, 2, 0.25)] }),
  // the same numbers with no header at all
  unitless: () => w.dxf({ entities: [w.rect(0, 0, 6, 4), w.circle(3, 2, 0.25)] }),
  // rectangle drawn as four LINEs, the last one stops 0.5 mm short of the corner
  openContour: () => w.dxf({ insunits: 4, entities: [w.line(0, 0, 120, 0), w.line(120, 0, 120, 80), w.line(120, 80, 0, 80), w.line(0, 80, 0, 0.5)] }),
  // plate → window → a smaller part drawn inside the window
  nested: () => w.dxf({ insunits: 4, entities: [w.rect(0, 0, 200, 150), w.rect(40, 40, 120, 70), w.rect(70, 55, 60, 40)] }),
  // two separate outlines side by side
  twoParts: () => w.dxf({ insunits: 4, entities: [w.rect(0, 0, 80, 60), w.rect(100, 0, 80, 60), w.circle(140, 30, 5)] }),
  // Ø80 disc drawn as a NURBS (exact rational circle) with an elliptical window 30 × 16
  splineProfile: () => w.dxf({ insunits: 4, entities: [w.circleSpline(40, 40, 40), w.ellipse(40, 40, 15, 0, 8 / 15)] }),
};

console.log("DXF — reading and units");

test("$INSUNITS = 4 is millimetres from the file, no confirmation needed", () => {
  const u = parseDXF(FX.plateHoles()).profile2d.units;
  assert.strictEqual(u.unit, "mm"); assert.strictEqual(u.source, "file"); assert.strictEqual(u.needsConfirmation, false);
});

test("inch file: geometry is converted to mm (6 × 4 in → 152.4 × 101.6 mm, Ø0.5 in → Ø12.7)", () => {
  const g = parseDXF(FX.inchPlate());
  const p = g.profile2d;
  assert.strictEqual(p.units.unit, "in"); assert.strictEqual(p.units.needsConfirmation, false);
  near(p.bbox.w, 152.4, 1e-6); near(p.bbox.h, 101.6, 1e-6);
  near(p.perimeter, 20 * 25.4, TOL, "perimeter");
  near(p.area, (24 - PI * 0.0625) * 645.16, TOL, "area");
  assert.strictEqual(p.holes.length, 1); near(p.holes[0].diameter, 12.7, TOL);
});

test("unitless file: needs confirmation, shows the size under both readings, and the customer's choice rescales it", () => {
  const g = parseDXF(FX.unitless());
  const u = g.profile2d.units;
  assert.strictEqual(u.needsConfirmation, true); assert.strictEqual(u.source, "assumed"); assert.strictEqual(u.unit, "mm");
  assert.deepStrictEqual(u.sizeIfMm, { w: 6, h: 4 });
  assert.deepStrictEqual(u.sizeIfInch, { w: 152.4, h: 101.6 });
  const dfm = rtDfm(g);
  assert.strictEqual(find(dfm, "rt-dxf-units").severity, "warn");
  const inch = parseDXF(FX.unitless(), { units: "in" });
  assert.strictEqual(inch.profile2d.units.needsConfirmation, false); assert.strictEqual(inch.profile2d.units.source, "customer");
  near(inch.profile2d.bbox.w, 152.4, 1e-6); near(inch.profile2d.holes[0].diameter, 12.7, TOL);
  assert.strictEqual(find(rtDfm(inch), "rt-dxf-units").severity, "info");
});

test("unit rules: $MEASUREMENT only suggests; inches + metric flag is a conflict; cm/ft/m convert", () => {
  assert.deepStrictEqual([resolveUnits({ $MEASUREMENT: "0" }).unit, resolveUnits({ $MEASUREMENT: "0" }).needsConfirmation], ["in", true]);
  assert.deepStrictEqual([resolveUnits({ $MEASUREMENT: "1" }).unit, resolveUnits({ $MEASUREMENT: "1" }).needsConfirmation], ["mm", true]);
  assert.strictEqual(resolveUnits({ $INSUNITS: "0" }).needsConfirmation, true);
  assert.strictEqual(resolveUnits({ $INSUNITS: "1", $MEASUREMENT: "1" }).needsConfirmation, true);
  assert.strictEqual(resolveUnits({ $INSUNITS: "4", $MEASUREMENT: "0" }).needsConfirmation, false);
  assert.strictEqual(resolveUnits({ $INSUNITS: "5" }).scale, 10);
  assert.strictEqual(resolveUnits({ $INSUNITS: "2" }).scale, 304.8);
  assert.strictEqual(resolveUnits({ $INSUNITS: "1", $MEASUREMENT: "1" }, "mm").needsConfirmation, false);
});

test("CRLF line endings, a BOM and padded group codes read the same", () => {
  const text = "﻿" + FX.plateHoles().replace(/\n/g, "\r\n").replace(/^10\r\n/gm, " 10\r\n");
  near(parseDXF(Buffer.from(text, "utf8")).profile2d.perimeter, 500, 1e-9);
});

test("binary DXF, empty file and a file with no ENTITIES are refused with a message that says what to do", () => {
  assert.throws(() => parseDXF(Buffer.from("AutoCAD Binary DXF\r\n\x1a\x00rest")), /binary DXF.*ASCII/);
  assert.throws(() => parseDXF("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n"), /no ENTITIES section/);
  assert.throws(() => parseDXF(w.dxf({ insunits: 4, entities: [] })), /No cut geometry/);
});

console.log("DXF — known-truth perimeter and area (±0.1 %)");

test("rectangle with holes: perimeter 500, inner 6·π·6.6, area 15000 − 6·π·3.3², six Ø6.6 holes with centres", () => {
  const p = parseDXF(FX.plateHoles()).profile2d;
  near(p.perimeter, 500, TOL, "outer"); near(p.innerPerimeter, 6 * PI * 6.6, TOL, "inner"); near(p.area, 15000 - 6 * PI * 3.3 ** 2, TOL, "area");
  assert.strictEqual(p.holes.length, 6); assert.strictEqual(p.cutoutCount, 6); assert.strictEqual(p.slots.length, 0);
  for (const h of p.holes) near(h.diameter, 6.6, TOL);
  assert.deepStrictEqual(p.holes.map((h) => h.center).sort((a, b) => a[1] - b[1] || a[0] - b[0]), HOLES);
  assert.strictEqual(p.minInternalRadius, null, "a rectangle has no inside corner");
  near(p.minWeb, 25 - 3.3, 0.01, "web hole → edge");
  assert.strictEqual(p.problems.length, 0);
});

test("bulged polyline: R10 corners and a 60 × 12 stadium slot", () => {
  const p = parseDXF(FX.bulgedSlot()).profile2d;
  near(p.perimeter, 2 * (180 + 60) + 2 * PI * 10, TOL, "outer");
  near(p.innerPerimeter, 2 * 48 + PI * 12, TOL, "slot perimeter");
  near(p.area, 200 * 80 - (4 - PI) * 100 - (48 * 12 + PI * 36), TOL, "area");
  near(p.bbox.w, 200, 1e-6); near(p.bbox.h, 80, 1e-6);
  assert.strictEqual(p.holes.length, 0); assert.strictEqual(p.slots.length, 1);
  near(p.slots[0].width, 12, 0.005); near(p.slots[0].length, 60, 0.005); assert.strictEqual(p.slots[0].shape, "stadium");
  near(p.minInternalRadius, 6, TOL, "slot end radius is the smallest inside corner");
  near(p.minSlotWidth, 12, 0.005);
});

test("spline profile: NURBS disc Ø80 with an elliptical window (flattened within 0.1 %)", () => {
  const p = parseDXF(FX.splineProfile()).profile2d;
  near(p.perimeter, PI * 80, TOL, "disc circumference");
  const a = 15, b = 8, hh = ((a - b) / (a + b)) ** 2;
  const ellipsePerimeter = PI * (a + b) * (1 + (3 * hh) / (10 + Math.sqrt(4 - 3 * hh))); // Ramanujan II, exact to 1e-7 here
  near(p.innerPerimeter, ellipsePerimeter, TOL, "ellipse perimeter");
  near(p.area, PI * 1600 - PI * a * b, TOL, "area");
  near(p.bbox.w, 80, TOL); near(p.bbox.h, 80, TOL);
  assert.strictEqual(p.approxCurves, 2);
  near(p.minInternalRadius, (b * b) / a, 0.03, "tightest curvature of the ellipse");
});

test("LINE + ARC entities in any order and direction chain into one loop (D-shape)", () => {
  // 60 wide, straight left side, semicircle R30 on the right; entities shuffled and reversed
  const p = parseDXF(w.dxf({ insunits: 4, entities: [w.arc(40, 30, 30, 270, 90), w.line(40, 60, 0, 60), w.line(0, 0, 40, 0), w.line(0, 0, 0, 60)] })).profile2d;
  near(p.perimeter, 40 + 60 + 40 + PI * 30, TOL); near(p.area, 40 * 60 + (PI * 900) / 2, TOL);
  near(p.bbox.w, 70, 1e-6); assert.strictEqual(p.openCount, 0);
});

test("old-style POLYLINE/VERTEX/SEQEND reads like LWPOLYLINE", () => {
  const p = parseDXF(w.dxf({ insunits: 4, entities: [w.polyline([[0, 0], [50, 0, 1], [50, 20], [0, 20, 1]], true)] })).profile2d;
  near(p.perimeter, 100 + PI * 20, TOL); near(p.area, 50 * 20 + PI * 100, TOL);
});

test("INSERT: block of a hole pattern, rotated, scaled and arrayed", () => {
  const blocks = [{ name: "HOLE", base: [0, 0], entities: [w.circle(0, 0, 2)] }, { name: "PAIR", entities: [w.insert("HOLE", -10, 0), w.insert("HOLE", 10, 0, { sx: 1.5, sy: 1.5 })] }];
  const p = parseDXF(w.dxf({ insunits: 4, blocks, entities: [
    w.rect(0, 0, 200, 100),
    w.insert("PAIR", 50, 50, { rot: 90 }),                       // holes at (50,40) Ø4 and (50,60) Ø6
    w.insert("HOLE", 120, 20, { cols: 3, rows: 2, dc: 20, dr: 60 }), // 6 × Ø4 on a 20 × 60 grid
  ] })).profile2d;
  assert.strictEqual(p.holes.length, 8);
  const byPos = Object.fromEntries(p.holes.map((h) => [`${Math.round(h.center[0])},${Math.round(h.center[1])}`, h.diameter]));
  near(byPos["50,40"], 4, TOL); near(byPos["50,60"], 6, TOL);
  for (const k of ["120,20", "140,20", "160,20", "120,80", "140,80", "160,80"]) near(byPos[k], 4, TOL, k);
  near(p.innerPerimeter, PI * (7 * 4 + 6), TOL);
});

test("non-uniform block scale turns a circle into an ellipse (flattened, area exact to 0.1 %)", () => {
  const p = parseDXF(w.dxf({ insunits: 4, blocks: [{ name: "C", entities: [w.circle(0, 0, 10)] }], entities: [w.rect(0, 0, 100, 60), w.insert("C", 50, 30, { sx: 2, sy: 1 })] })).profile2d;
  near(p.area, 6000 - PI * 20 * 10, TOL); assert.strictEqual(p.holes.length, 0); assert.strictEqual(p.cutoutCount, 1);
});

test("mirrored entity (extrusion 0,0,−1): arc is flipped in X, loop still closes", () => {
  // In OCS the arc is centred at (−40, 30); in the world it is at (+40, 30) sweeping the right-hand side
  const p = parseDXF(w.dxf({ insunits: 4, entities: [w.arc(-40, 30, 30, 90, 270, { flipZ: true }), w.line(40, 60, 0, 60), w.line(0, 0, 40, 0), w.line(0, 0, 0, 60)] })).profile2d;
  assert.strictEqual(p.openCount, 0); near(p.bbox.w, 70, 1e-6); near(p.area, 2400 + (PI * 900) / 2, TOL);
});

console.log("DXF — layers, annotation and construction geometry");

test("dimensions, text, DEFPOINTS, a centre-line layer, a frozen layer and paper space are ignored and reported", () => {
  const layers = [{ name: "0" }, { name: "DIM" }, { name: "CL", linetype: "CENTER" }, { name: "OLD", flags: 1 }, { name: "Defpoints" }];
  const g = parseDXF(w.dxf({ insunits: 4, layers, entities: [
    w.rect(0, 0, 100, 60), w.circle(50, 30, 5),
    w.line(-20, 70, 120, 70, { layer: "DIM" }), w.dimension({ layer: "DIM" }), w.text(0, -10, 3, "PART 123 REV B"),
    w.line(50, -10, 50, 70, { layer: "CL" }),                 // centre line by layer linetype
    w.line(0, 30, 100, 30, { linetype: "HIDDEN" }),           // hidden line by entity linetype
    w.rect(10, 10, 20, 20, { layer: "OLD" }),                 // frozen layer
    w.circle(0, 0, 1, { layer: "Defpoints" }),
    w.rect(-50, -50, 300, 200, { paper: true }),              // title-block border in paper space
  ] }));
  const p = g.profile2d;
  near(p.perimeter, 320, TOL); near(p.area, 6000 - PI * 25, TOL); assert.strictEqual(p.holes.length, 1);
  assert.strictEqual(p.problems.length, 0);
  assert.strictEqual(p.ignored.entityTypes.DIMENSION, 1); assert.strictEqual(p.ignored.entityTypes.TEXT, 1);
  assert.deepStrictEqual(p.ignored.layers.map((l) => l.name).sort(), ["0", "CL", "DIM", "Defpoints", "OLD"]);
  assert.strictEqual(p.ignored.paperSpace, 1);
  const scope = find(rtDfm(g), "rt-dxf-scope");
  assert.strictEqual(scope.severity, "info"); assert.ok(/Not cut: .*DIMENSION.*"DIM"/.test(scope.detail), scope.detail);
});

test("a file whose geometry is all on annotation layers is refused, naming the layers", () => {
  assert.throws(() => parseDXF(w.dxf({ insunits: 4, entities: [w.rect(0, 0, 100, 60, { layer: "TITLE-BLOCK" }), w.line(0, 0, 5, 5, { layer: "DIMS" })] })), /No cut geometry.*"TITLE-BLOCK".*own layer/);
});

test("hostile names from the file (a layer called __proto__) cannot pollute anything", () => {
  const g = parseDXF(w.dxf({ insunits: 4, layers: [{ name: "__proto__" }, { name: "constructor" }], entities: [
    w.rect(0, 0, 50, 30, { layer: "constructor" }), w.circle(10, 10, 2, { layer: "__proto__" }), "0\n__proto__\n8\n0\n",
  ] }));
  assert.strictEqual(g.profile2d.holes.length, 1); assert.deepStrictEqual(g.profile2d.layers.sort(), ["__proto__", "constructor"]);
  assert.strictEqual({}.count, undefined); assert.strictEqual({}.frozen, undefined);
});

test("3D-only DXF is refused and points to STEP", () => {
  assert.throws(() => parseDXF(w.dxf({ insunits: 4, entities: ["0\n3DSOLID\n8\n0\n"] })), /3D solids.*STEP/);
});

console.log("DXF — one part per file");

test("two separate outlines: refused with the count and what to do", () => {
  assert.throws(() => parseDXF(FX.twoParts()), /contains 2 separate parts.*one part per file/);
});

test("a part drawn inside a cutout: refused (also hints at a leftover border)", () => {
  assert.throws(() => parseDXF(FX.nested()), /closed shape inside a cutout.*border/);
});

console.log("DXF — drawing problems (2D DFM)");

test("open contour: FAIL with the gap size and its location; the quote is gated to RFQ", () => {
  const g = parseDXF(FX.openContour());
  const p = g.profile2d;
  assert.strictEqual(p.openCount, 1);
  const prob = p.problems.find((x) => x.code === "open-contour");
  near(prob.gap, 0.5, 1e-6); assert.deepStrictEqual(prob.at, [0, 0.25]);
  const dfm = rtDfm(g);
  const c = find(dfm, "rt-dxf-contours");
  assert.strictEqual(c.severity, "fail"); assert.ok(/0\.50 mm at X 0\.0, Y 0\.3 mm/.test(c.detail), c.detail);
  assert.deepStrictEqual(c.locations[0], { x: 0, y: 0.25, note: "gap 0.50 mm" });
  assert.strictEqual(dfm.summary.manufacturable, false);
  // still priced (budgetary), from the outline's own length and bounding size
  const line = new PricingEngine(DEFAULT_PRICING_RULES).calculatePartPrice({ geometry: g, material: hdpe, thicknessMm: 6.35, grade: hdpe.grades[0].name, quantity: 5, process: "routing" });
  assert.ok(line.perUnit.final > 0);
  const gate = quoteGate.evaluate([{ partId: "p", quantity: 5, lineTotal: line.lineTotal, meta: line.meta }], { p: dfm }, DEFAULT_PRICING_RULES);
  assert.strictEqual(gate.requiresRfq, true); assert.strictEqual(gate.reasons[0].code, "dfm-fail");
});

test("endpoints within 0.02 mm are welded; a 0.05 mm gap is reported, not hidden", () => {
  const sq = (gap) => parseDXF(w.dxf({ insunits: 4, entities: [w.line(0, 0, 50, 0), w.line(50, 0, 50, 50), w.line(50, 50, 0, 50), w.line(0, 50, 0, gap)] })).profile2d;
  assert.strictEqual(sq(0.015).openCount, 0); near(sq(0.015).area, 2500, TOL);
  assert.strictEqual(sq(0.05).openCount, 1); near(sq(0.05).problems[0].gap, 0.05, 1e-6);
});

test("self-intersecting contour (bow-tie): FAIL at the crossing point", () => {
  const g = parseDXF(w.dxf({ insunits: 4, entities: [w.lwpolyline([[0, 0], [100, 60], [100, 0], [0, 60]], true)] }));
  const c = find(rtDfm(g), "rt-dxf-intersections");
  assert.strictEqual(c.severity, "fail"); assert.deepStrictEqual(c.locations[0], { x: 50, y: 30, note: "crosses itself" });
});

test("a cutout that crosses the outer profile: FAIL (contours cross)", () => {
  const g = parseDXF(w.dxf({ insunits: 4, entities: [w.rect(0, 0, 100, 60), w.circle(100, 30, 10)] }));
  const c = find(rtDfm(g), "rt-dxf-intersections");
  assert.strictEqual(c.severity, "fail"); assert.ok(/two contours cross/.test(c.detail)); assert.strictEqual(c.locations.length, 2);
});

test("duplicate and overlapping entities: removed for pricing, WARN minor with a location", () => {
  const clean = parseDXF(FX.plateHoles());
  const g = parseDXF(w.dxf({ insunits: 4, entities: [
    w.rect(0, 0, 150, 100), ...HOLES.map(([x, y]) => w.circle(x, y, 3.3)),
    w.circle(25, 25, 3.3),            // hole drawn twice
    w.line(0, 0, 150, 0),             // line on top of the bottom edge
    w.line(150, 20, 150, 60),         // shorter line lying on the right edge
  ] }));
  const p = g.profile2d;
  assert.strictEqual(p.cleaned.duplicates, 2); assert.strictEqual(p.cleaned.overlaps, 1);
  near(p.perimeter, clean.profile2d.perimeter, 1e-9); near(p.innerPerimeter, clean.profile2d.innerPerimeter, 1e-9); assert.strictEqual(p.holes.length, 6);
  const dfm = rtDfm(g);
  const c = find(dfm, "rt-dxf-duplicates");
  assert.strictEqual(c.severity, "warn"); assert.strictEqual(c.cost, "minor"); assert.strictEqual(c.locations.length, 3);
  assert.strictEqual(dfm.summary.manufacturable, true);
});

test("zero-area sliver loop: WARN, left out of the cut length", () => {
  const g = parseDXF(w.dxf({ insunits: 4, entities: [w.rect(0, 0, 100, 60), w.lwpolyline([[20, 30], [60, 30], [60, 30.005], [20, 30.005]], true)] }));
  assert.strictEqual(g.profile2d.cleaned.slivers, 1); near(g.profile2d.innerPerimeter + 1, 1, 1e-9); near(g.profile2d.area, 6000, TOL);
  const c = find(rtDfm(g), "rt-dxf-slivers");
  assert.strictEqual(c.severity, "warn"); assert.deepStrictEqual(c.locations[0].note, "zero-area loop");
});

test("three lines meeting at a point: FAIL (ambiguous contour) at the junction", () => {
  const g = parseDXF(w.dxf({ insunits: 4, entities: [w.line(0, 0, 80, 0), w.line(80, 0, 80, 50), w.line(80, 50, 0, 50), w.line(0, 50, 0, 0), w.line(80, 50, 110, 70)] }));
  const c = find(rtDfm(g), "rt-dxf-contours");
  assert.strictEqual(c.severity, "fail"); assert.ok(/three or more lines meet \(first at X 80\.0, Y 50\.0 mm\)/.test(c.detail), c.detail);
});

console.log("DXF — routing DFM on the extruded profile (shared rules, unchanged)");

// L-shaped bracket with a square window, a Ø1 hole, a 3 mm slot and a hole 1.5 mm from the edge
const bracket = () => w.dxf({ insunits: 4, entities: [
  w.lwpolyline([[0, 0], [160, 0], [160, 50], [60, 50], [60, 120], [0, 120]], true), // sharp inside corner at (60, 50)
  w.rect(15, 70, 30, 30),          // square window: four sharp inside corners
  w.circle(100, 25, 0.5),          // Ø1 hole
  w.slot(120, 12, 40, 3),          // 3 mm wide slot
  w.circle(30, 5, 3.5),            // Ø7 hole, 1.5 mm of material to the bottom edge
] });

test("internal corners sharper than the tool: WARN naming the radius we will leave, with every corner located", () => {
  const dfm = rtDfm(parseDXF(bracket()), 6.35);
  const c = find(dfm, "rt-corner-radius");
  assert.strictEqual(c.severity, "warn"); assert.ok(/square inside corner.*we leave R 1\.59 mm/.test(c.detail), c.detail);
  assert.strictEqual(c.locations.length, 5);
  assert.ok(c.locations.some((l) => l.x === 60 && l.y === 50));
});

test("features smaller than the cutter: a 3 mm slot is fine in 1/8\" stock and WARNs in 1/2\" (bigger tool needed to reach)", () => {
  const g = parseDXF(bracket());
  near(g.profile2d.minSlotWidth, 3, 0.01);
  const thin = find(rtDfm(g, 3.2), "rt-slot-width");                               // 1/16" tool reaches 3.2 mm stock
  assert.strictEqual(thin.severity, "pass"); assert.strictEqual(thin.cost, "minor");
  const thick = find(rtDfm(g, 12.7), "rt-slot-width");                             // 1/8" (3.175) is the smallest that reaches 12.7
  assert.strictEqual(thick.severity, "warn"); assert.ok(/1\/8" \(3\.1[78] mm\)/.test(thick.detail), thick.detail);
  assert.strictEqual(thick.locations.length, 1);
  near(thick.locations[0].y, 12, 0.01);
});

test("hole diameter vs thickness: Ø1 hole is a micro hole (WARN major) and is marked", () => {
  const c = find(rtDfm(parseDXF(bracket()), 6.35), "rt-holes");
  assert.strictEqual(c.severity, "warn"); assert.strictEqual(c.cost, "major"); assert.ok(/Ø1\.00/.test(c.detail));
  assert.deepStrictEqual(c.locations, [{ x: 100, y: 25, note: "Ø1.00 mm" }]);
});

test("web width between a feature and the edge: 1.5 mm web in 6.35 stock WARNs at its location", () => {
  const g = parseDXF(bracket());
  near(g.profile2d.minWeb, 1.5, 0.02);
  const c = find(rtDfm(g, 6.35), "rt-thin-web");
  assert.strictEqual(c.severity, "warn"); assert.strictEqual(c.locations.length, 1);
  near(c.locations[0].x, 30, 0.05); near(c.locations[0].y, 0.75, 0.05);
});

test("two cuts that touch (zero web): FAIL from the shared thin-web rule", () => {
  const g = parseDXF(w.dxf({ insunits: 4, entities: [w.rect(0, 0, 100, 60), w.circle(30, 30, 10), w.circle(50, 30, 10)] }));
  assert.ok(g.profile2d.minWeb <= 0.05, `web ${g.profile2d.minWeb}`);
  assert.strictEqual(find(rtDfm(g), "rt-thin-web").severity, "fail");
});

test("part larger than the bed: FAIL and gated; tiny part that cannot be held: WARN", () => {
  const big = rtDfm(parseDXF(w.dxf({ insunits: 1, entities: [w.rect(0, 0, 100, 60)] })), 12.7); // 100 × 60 in
  assert.strictEqual(find(big, "rt-bed-size").severity, "fail");
  const tiny = rtDfm(parseDXF(w.dxf({ insunits: 4, entities: [w.rect(0, 0, 30, 8)] })), 3.2);
  assert.strictEqual(find(tiny, "rt-small-part").severity, "warn"); assert.strictEqual(find(tiny, "rt-small-part").cost, "major");
});

test("acrylic: a tight (not sharp) inside corner is flagged as a crack starter", () => {
  const g = parseDXF(w.dxf({ insunits: 4, entities: [w.rect(0, 0, 120, 80), w.roundRect(30, 20, 60, 40, 2)] }));
  near(g.profile2d.minInternalRadius, 2, TOL);
  const c = runDFMAnalysis(g, { process: "routing", thicknessMm: 6.35, materialSlug: acrylic.slug, materialName: acrylic.name }).checks.find((x) => x.id === "rt-corner-radius");
  assert.strictEqual(c.severity, "warn"); assert.ok(/crack starter/.test(c.detail));
});

test("a clean plate passes every scored rule; the thickness-match rule does not run for a drawing", () => {
  const dfm = rtDfm(parseDXF(FX.plateHoles()), 6.35);
  assert.strictEqual(dfm.summary.failCount, 0); assert.strictEqual(dfm.summary.warnCount, 0); assert.strictEqual(dfm.summary.score, 100);
  assert.strictEqual(find(dfm, "rt-thickness-match"), undefined);
  assert.strictEqual(find(dfm, "rt-dxf-contours").severity, "pass");
});

test("before a thickness is chosen the DFM says so instead of guessing", () => {
  const dfm = runDFMAnalysis(parseDXF(FX.plateHoles()), { process: "routing" });
  assert.ok(/Select a stock thickness/.test(find(dfm, "rt-dxf-scope").detail));
});

test("a DXF on CNC machining or 3D printing: one FAIL that offers routing", () => {
  for (const process of ["cnc", "3d-printing"]) {
    const dfm = runDFMAnalysis(parseDXF(FX.plateHoles()), { process });
    assert.strictEqual(dfm.checks.length, 1); assert.strictEqual(dfm.checks[0].severity, "fail");
    assert.ok(/only be quoted for CNC routing/.test(dfm.checks[0].detail));
  }
});

console.log("DXF — features (SCHEMA.md) and pricing");

test("features follow the schema: flat plate at the selected thickness, source dxf, through holes, honest confidence", () => {
  const g = materialize(parseDXF(FX.plateHoles()), 6.35);
  const f = g.features;
  assert.strictEqual(f.schemaVersion, 1); assert.strictEqual(f.source, "dxf"); assert.strictEqual(f.confidence.source, "dxf");
  assert.strictEqual(f.shape.kind, "flat"); assert.strictEqual(f.shape.is25D, true); assert.strictEqual(f.shape.stockThickness, 6.35);
  assert.deepStrictEqual(f.aabb, { w: 150, h: 100, d: 6.35 }); assert.deepStrictEqual([f.obb.w, f.obb.h, f.obb.d], [150, 100, 6.35]);
  const area = 15000 - 6 * PI * 3.3 ** 2;
  near(f.volume, area * 6.35, TOL); near(f.surfaceArea, 2 * area + (500 + 6 * PI * 6.6) * 6.35, TOL);
  near(f.shape.profile.area, area, TOL); near(f.shape.profile.perimeter, 500, TOL); near(f.shape.profile.innerPerimeter, 6 * PI * 6.6, TOL);
  assert.strictEqual(f.holes.length, 6);
  assert.deepStrictEqual(f.holes[0], { diameter: 6.6, depth: 6.35, through: true, axis: [0, 0, 1], center: [25, 25, 3.175], blind: false, kind: "round", depthToDiaRatio: 0.962 });
  assert.deepStrictEqual(f.pockets, []); assert.strictEqual(f.stock.sheet.thickness, 6.35);
  assert.ok(f.confidence.holes === 1 && f.confidence.shape === 1);
  assert.strictEqual(g.boundingBox.depth, 6.35); near(g.volume, area * 6.35, TOL);
  assert.strictEqual(f.provisionalThickness, undefined);
  assert.strictEqual(featuresFromProfile(g.profile2d, null).provisionalThickness, true);
});

test("the stored geometry is not mutated by a quote (materialize returns a copy)", () => {
  const g = parseDXF(FX.plateHoles());
  const before = JSON.stringify(g);
  materialize(g, 12.7);
  new PricingEngine(DEFAULT_PRICING_RULES).calculatePartPrice({ geometry: g, material: hdpe, thicknessMm: 12.7, grade: hdpe.grades[0].name, quantity: 1, process: "routing" });
  assert.strictEqual(JSON.stringify(g), before);
});

test("pricing: a DXF plate prices exactly like the same plate described by STEP-style features", () => {
  // The features a STEP of this plate yields (as in routing.test.js): same profile, six B-rep holes
  const area = 15000 - 6 * PI * 3.3 ** 2, t = 6.35;
  const step = {
    boundingBox: { width: 150, height: 100, depth: t }, volume: area * t, surfaceArea: 2 * area + (500 + 6 * PI * 6.6) * t,
    features: {
      schemaVersion: 1, source: "step", aabb: { w: 150, h: 100, d: t }, obb: { w: 150, h: 100, d: t, axes: null }, volume: area * t, surfaceArea: 2 * area + (500 + 6 * PI * 6.6) * t,
      shape: { kind: "flat", primaryAxis: [0, 0, 1], is25D: true, stockThickness: t, profile: { area, perimeter: 500, innerPerimeter: 6 * PI * 6.6, bboxW: 150, bboxH: 100, minInternalRadius: null, minSlotWidth: null }, revolved: null },
      holes: HOLES.map(() => ({ diameter: 6.6, depth: t, through: true, axis: [0, 0, 1], center: [0, 0, 0], blind: false, kind: "round", depthToDiaRatio: t / 6.6 })),
      pockets: [], slots: [], bosses: [], walls: { minThickness: t }, access: { directions: [[0, 0, 1]], minSetups3Axis: 1, undercutAreaFraction: 0 },
      cornerRadii: { minInternalVertical: null, minInternalFloor: null }, overhang: { areaFraction45: 0, maxAngleFromVertical: 0, supportVolumeEstimate: 0 },
      confidence: { holes: 1, pockets: 1, walls: 1, shape: 1, overall: 1 }, notes: [],
    },
  };
  const engine = new PricingEngine(DEFAULT_PRICING_RULES);
  const g = parseDXF(FX.plateHoles());
  for (const quantity of [1, 10, 100]) {
    const a = engine.calculatePartPrice({ geometry: g, material: hdpe, thicknessMm: t, grade: hdpe.grades[0].name, quantity, process: "routing" });
    const b = calculate({ geometry: step, material: hdpe, thicknessMm: t, grade: hdpe.grades[0].name, quantity }, DEFAULT_PRICING_RULES);
    near(a.perUnit.final, b.perUnit.final, 0.001, `qty ${quantity}`);
    assert.strictEqual(a.meta.cutLengthMm, b.meta.cutLengthMm); assert.strictEqual(a.meta.cutter, b.meta.cutter);
    assert.strictEqual(a.meta.confidence.source, "features"); assert.deepStrictEqual(a.meta.confidence.legacyFields, []);
  }
});

test("pricing: thickness drives the price (more passes, more material); thicker is never cheaper", () => {
  const engine = new PricingEngine(DEFAULT_PRICING_RULES);
  const g = parseDXF(FX.plateHoles());
  const price = (t) => engine.calculatePartPrice({ geometry: g, material: hdpe, thicknessMm: t, grade: hdpe.grades[0].name, quantity: 10, process: "routing" });
  const p3 = price(3.2), p12 = price(12.7), p25 = price(25.4);
  assert.ok(p3.perUnit.final < p12.perUnit.final && p12.perUnit.final < p25.perUnit.final, `${p3.perUnit.final} < ${p12.perUnit.final} < ${p25.perUnit.final}`);
  assert.strictEqual(p12.meta.thicknessMm, 12.7); assert.ok(p12.perUnit.material > p3.perUnit.material * 3);
});

test("pricing refuses a DXF with no thickness or on another process (nothing is assumed)", () => {
  const engine = new PricingEngine(DEFAULT_PRICING_RULES);
  const g = parseDXF(FX.plateHoles());
  assert.throws(() => engine.calculatePartPrice({ geometry: g, material: hdpe, grade: "", quantity: 1, process: "routing" }), /stock thickness/);
  assert.throws(() => engine.calculatePartPrice({ geometry: g, material: CNC_MATERIALS[0], thicknessMm: 6.35, grade: "", quantity: 1, process: "cnc" }), /only be priced for CNC routing/);
});

test("3D geometry is untouched by the 2D path", () => {
  const solid = { boundingBox: { width: 10, height: 10, depth: 10 }, volume: 1000, surfaceArea: 600 };
  assert.strictEqual(is2D(solid), false); assert.strictEqual(materialize(solid, 6.35), solid);
});

console.log("DXF — upload path");

test("file validator: accepts ASCII DXF (with or without 999 comments), rejects a DWG renamed .dxf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxf-test-"));
  const mk = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return { path: p, originalname: name }; };
  const req = { files: [mk("ok.dxf", FX.plateHoles()), mk("comment.dxf", "999\nmade by a test\n" + FX.plateHoles()), mk("crlf.dxf", FX.plateHoles().replace(/\n/g, "\r\n")), mk("dwg.dxf", Buffer.from("AC1027\x00\x00\x00\x00\x00binarybinarybinary"))] };
  validateFileContent(req, {}, () => {});
  assert.deepStrictEqual(req.files.map((f) => f.originalname), ["ok.dxf", "comment.dxf", "crlf.dxf"]);
  assert.deepStrictEqual(req.rejectedFiles.map((f) => f.fileName), ["dwg.dxf"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

testAsync("parseFile: a .dxf gives geometry + routing DFM, other process tabs say 'routing only', units option is honoured", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxf-test-"));
  const file = path.join(dir, "unitless.dxf");
  fs.writeFileSync(file, FX.unitless());
  const parsed = await parseFile(file);
  assert.strictEqual(parsed.geometry.sourceFormat, "dxf"); assert.strictEqual(parsed.geometry.profile2d.units.needsConfirmation, true);
  assert.ok(parsed.dfm.checks.some((c) => c.id === "rt-dxf-units"), "default DFM is the routing one");
  assert.strictEqual(parsed.dfmAll.cnc.checks[0].id, "dxf-2d-file"); assert.ok(parsed.dfmAll.routing.checks.length > 5);
  assert.deepStrictEqual(parsed.geometry.meshData, { positions: [], triangleCount: 0 });
  const inch = await parseFile(file, { units: "in" });
  near(inch.geometry.boundingBox.width, 152.4, 1e-6);
  // bytes handed in directly (the upload is encrypted at rest and decrypted in memory)
  const fromBuffer = await parseFile(path.join(dir, "gone.dxf.enc"), { buffer: Buffer.from(FX.inchPlate()), ext: ".dxf" });
  near(fromBuffer.geometry.boundingBox.width, 152.4, 1e-6);
  fs.rmSync(dir, { recursive: true, force: true });
});

testAsync("vetting library: each DXF matches its analytic truth (±0.1 %) and prices within 2 % of its STEP twin", async () => {
  const dir = path.join(__dirname, "../../../tools/vet-quotes/parts");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "dxf_manifest.json"), "utf8"));
  assert.ok(manifest.parts.length >= 3);
  const engine = new PricingEngine(DEFAULT_PRICING_RULES);
  let compared = 0;
  for (const part of manifest.parts) {
    const d = await parseFile(path.join(dir, part.file));
    const p = d.geometry.profile2d;
    near(p.perimeter, part.truth.outer_perimeter_mm, TOL, `${part.id} outer`);
    near(p.innerPerimeter, part.truth.inner_perimeter_mm, TOL, `${part.id} inner`);
    near(p.area, part.truth.area_mm2, TOL, `${part.id} area`);
    assert.strictEqual(p.holes.length, part.truth.holes, `${part.id} holes`);
    assert.strictEqual(p.slots.length, part.truth.slots, `${part.id} slots`);
    assert.strictEqual(p.problems.length, 0, `${part.id} problems`);
    const s = await parseFile(path.join(dir, part.twin));
    assert.strictEqual(s.geometry.features.source, "step");
    for (const cfg of part.configs) {
      const material = ROUTING_MATERIALS.find((m) => m.slug === cfg.materialSlug);
      const opts = { process: "routing", thicknessMm: cfg.thicknessMm, materialSlug: material.slug, materialName: material.name };
      const flagged = (g) => runDFMAnalysis(g, opts).checks.filter((c) => !c.id.startsWith("rt-dxf-") && c.id !== "rt-thickness-match" && (c.severity === "warn" || c.severity === "fail")).map((c) => `${c.id}:${c.severity}`).join(",");
      assert.strictEqual(flagged(d.geometry), flagged(s.geometry), `${part.id} ${cfg.label}: the shared routing rules flag the same things`);
      for (const quantity of [1, 5, 10, 25]) {
        const base = { material, thicknessMm: cfg.thicknessMm, grade: material.grades[0].name, quantity, process: "routing" };
        const a = engine.calculatePartPrice({ ...base, geometry: d.geometry }), b = engine.calculatePartPrice({ ...base, geometry: s.geometry });
        near(a.perUnit.final, b.perUnit.final, 0.02, `${part.id} ${cfg.label} qty ${quantity}`);
        assert.strictEqual(a.meta.cutter, b.meta.cutter); assert.strictEqual(a.meta.passes, b.meta.passes);
        compared++;
      }
    }
  }
  assert.ok(compared >= 20, `${compared} comparisons`);
});

test("a 400-hole perforated panel analyses in well under a second", () => {
  const ents = [w.rect(0, 0, 420, 420)];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) ents.push(w.circle(20 + i * 20, 20 + j * 20, 4));
  const t0 = Date.now();
  const p = parseDXF(w.dxf({ insunits: 4, entities: ents })).profile2d;
  const ms = Date.now() - t0;
  assert.strictEqual(p.holes.length, 400); near(p.minWeb, 12, 1e-6, "circle-to-circle web is exact"); near(p.area, 420 * 420 - 400 * PI * 16, TOL);
  assert.ok(ms < 1500, `${ms} ms`);
});

test("more than 5,000 contours is refused for the instant quote (RFQ instead)", () => {
  const ents = [w.rect(0, 0, 1500, 1500)];
  for (let i = 0; i < 72; i++) for (let j = 0; j < 70; j++) ents.push(w.circle(20 + i * 20, 20 + j * 20, 4));
  assert.throws(() => parseDXF(w.dxf({ insunits: 4, entities: ents })), /5,041 contours.*RFQ/);
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
});
