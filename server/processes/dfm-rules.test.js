/**
 * DFM rule tests — synthetic `features` objects (server/geometry/SCHEMA.md) that trip each
 * rule, proving severity tier, threshold and the confidence policy. Also runs the legacy
 * adapter path. Run: `node server/processes/dfm-rules.test.js`
 */
const assert = require("assert");
const cnc = require("./cnc/dfm");
const routing = require("./routing/dfm");
const printing = require("./3d-printing/dfm");
const { getFeatures } = require("./featureAdapter");
const { gate, materialProfile } = require("./dfmKit");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const find = (r, id) => r.checks.find((c) => c.id === id);
const sev = (r, id) => (find(r, id) || {}).severity;
const cost = (r, id) => (find(r, id) || {}).cost;

/** Measured-features builder: a 100 × 60 × 25 block with high-confidence fields. */
function block(overrides = {}) {
  const base = {
    schemaVersion: 1, source: "step",
    mesh: { triangles: 1200, watertight: true, manifold: true, selfIntersections: false },
    aabb: { w: 100, h: 60, d: 25 }, obb: { w: 100, h: 60, d: 25, axes: null },
    volume: 100 * 60 * 25 * 0.9, surfaceArea: 2 * (100 * 60 + 100 * 25 + 60 * 25),
    shape: { kind: "prismatic", primaryAxis: [0, 0, 1], is25D: true, stockThickness: null,
      profile: { area: 6000, perimeter: 320, innerPerimeter: 0, bboxW: 100, bboxH: 60, minInternalRadius: null, minSlotWidth: null }, revolved: null },
    holes: [], pockets: [], slots: [], bosses: [], fillets: null, chamfers: null, text: null,
    walls: { minThickness: 6, p05Thickness: 8, thinAreaFraction: 0, tallThinMaxAspect: 2 },
    access: { directions: [[0, 0, 1], [0, 0, -1]], minSetups3Axis: 2, undercutAreaFraction: 0 },
    cornerRadii: { minInternalVertical: 5, minInternalFloor: 0 },
    overhang: { areaFraction45: 0.05, maxAngleFromVertical: 90, supportVolumeEstimate: 0 },
    bridging: null,
    stock: { block: { w: 106, h: 66, d: 31, volume: 106 * 66 * 31 }, bar: null, sheet: null, removalVolumeBlock: 0, removalRatioBlock: 0.38 },
    confidence: { holes: 1, pockets: 1, walls: 1, shape: 1, overall: 1 },
    notes: [],
  };
  return { features: deepMerge(base, overrides) };
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}
const plastic = { materialType: "plastic", materialSlug: "cnc-delrin", materialName: "Delrin (Acetal)" };
const metal = { materialType: "metal", materialSlug: "cnc-aluminum-6061", materialName: "Aluminum 6061" };

console.log("DFM rules — kit");

test("gate: fail needs ≥0.9 confidence; degrades to warn (≥0.6) or info (<0.6), never blocks on legacy", () => {
  assert.strictEqual(gate("fail", 1.0).severity, "fail");
  assert.strictEqual(gate("fail", 0.95).severity, "fail");
  assert.deepStrictEqual(gate("fail", 0.7), { severity: "warn", verify: true });
  assert.deepStrictEqual(gate("fail", 0.3), { severity: "info", verify: true });
  assert.deepStrictEqual(gate("fail", "legacy"), { severity: "info", verify: true });
  assert.strictEqual(gate("warn", "legacy").severity, "warn");
  assert.strictEqual(gate("pass", 0.1).severity, "pass");
});

test("materialProfile resolves families and flags from slugs", () => {
  assert.strictEqual(materialProfile({ materialSlug: "cnc-acrylic" }).brittle, true);
  assert.strictEqual(materialProfile({ materialSlug: "rt-nylon" }).hygroscopic, true);
  assert.strictEqual(materialProfile({ materialSlug: "cnc-peek" }).highCost, true);
  assert.strictEqual(materialProfile({ materialSlug: "cnc-uhmw" }).soft, true);
  assert.strictEqual(materialProfile({ materialSlug: "cnc-aluminum-6061" }).isMetal, true);
  assert.strictEqual(materialProfile({ materialSlug: "fdm-abs" }).warpProne, true);
  assert.strictEqual(materialProfile({ materialType: "metal" }).isMetal, true);
  assert.strictEqual(materialProfile({}).isPlastic, true, "plastics shop default");
});

test("every check carries id, label, severity, detail, cost and confidence", () => {
  const runs = [cnc.run(block(), plastic), cnc.run(block(), { ...plastic, subProcess: "turning" }), routing.run(block(), {}), printing.run(block(), { subProcess: "fdm" })];
  for (const r of runs) for (const c of r.checks) {
    assert.ok(c.id && c.label && c.detail, `missing fields on ${JSON.stringify(c).slice(0, 80)}`);
    assert.ok(["pass", "info", "warn", "fail"].includes(c.severity), c.id);
    assert.ok(["none", "minor", "major"].includes(c.cost), `${c.id} cost=${c.cost}`);
    assert.ok(c.confidence === "legacy" || c.confidence === "n/a" || Number.isFinite(c.confidence), `${c.id} conf=${c.confidence}`);
    assert.strictEqual(c.pass, c.severity === "pass");
  }
});

console.log("DFM rules — CNC milling (measured features)");

test("clean block passes with no warns/fails and a 100 score", () => {
  const r = cnc.run(block(), plastic);
  assert.strictEqual(r.summary.failCount, 0);
  assert.strictEqual(r.summary.warnCount, 0, JSON.stringify(r.checks.filter((c) => c.severity === "warn").map((c) => c.id)));
  assert.strictEqual(r.summary.score, 100);
});

test("min wall: plastic 1.2 mm WARNS minor (<1.5 rec), 0.8 mm WARNS major (<1.0 feasible); metal 0.8 mm passes", () => {
  assert.strictEqual(sev(cnc.run(block({ walls: { minThickness: 1.2 } }), plastic), "cnc-min-wall-thickness"), "warn");
  assert.strictEqual(cost(cnc.run(block({ walls: { minThickness: 1.2 } }), plastic), "cnc-min-wall-thickness"), "minor");
  assert.strictEqual(cost(cnc.run(block({ walls: { minThickness: 0.8 } }), plastic), "cnc-min-wall-thickness"), "major");
  assert.strictEqual(sev(cnc.run(block({ walls: { minThickness: 0.8 } }), metal), "cnc-min-wall-thickness"), "pass");
  // brittle plastics get a 2.0 mm guideline
  assert.strictEqual(sev(cnc.run(block({ walls: { minThickness: 1.8 } }), { materialType: "plastic", materialSlug: "cnc-acrylic" }), "cnc-min-wall-thickness"), "warn");
});

test("zero-thickness wall FAILS at high confidence, degrades to info on legacy", () => {
  const r = cnc.run(block({ walls: { minThickness: 0.0 } }), plastic);
  assert.strictEqual(sev(r, "cnc-min-wall-thickness"), "fail");
  assert.strictEqual(r.summary.manufacturable, false);
  const low = cnc.run(block({ walls: { minThickness: 0.0 }, confidence: { walls: 0.3 } }), plastic);
  assert.strictEqual(sev(low, "cnc-min-wall-thickness"), "info");
  assert.ok(find(low, "cnc-min-wall-thickness").verify);
  assert.ok(/verify/i.test(find(low, "cnc-min-wall-thickness").detail));
  assert.strictEqual(low.summary.manufacturable, true);
});

test("envelope: fits → pass; long flat plate → warn (router); 600 mm block → warn (indexed); 1200 mm block → FAIL", () => {
  assert.strictEqual(sev(cnc.run(block(), plastic), "cnc-max-size"), "pass");
  const rail = cnc.run(block({ aabb: { w: 600, h: 25, d: 12.7 }, obb: { w: 600, h: 25, d: 12.7 } }), plastic);
  assert.strictEqual(sev(rail, "cnc-max-size"), "warn");
  assert.ok(/router/i.test(find(rail, "cnc-max-size").detail));
  const longBlock = cnc.run(block({ aabb: { w: 600, h: 100, d: 100 }, obb: { w: 600, h: 100, d: 100 } }), plastic);
  assert.strictEqual(sev(longBlock, "cnc-max-size"), "warn");
  assert.ok(/two setups/i.test(find(longBlock, "cnc-max-size").detail));
  const huge = cnc.run(block({ aabb: { w: 1200, h: 300, d: 300 }, obb: { w: 1200, h: 300, d: 300 } }), plastic);
  assert.strictEqual(sev(huge, "cnc-max-size"), "fail");
  assert.strictEqual(huge.summary.manufacturable, false);
});

test("sharp internal corner in a deep pocket FAILS (B-rep confidence); same corner at 0.7 confidence WARNS with verify", () => {
  const pocket = { pockets: [{ area: 2000, depth: 10, floorArea: 2000, openSides: 0, minCornerRadius: 0, depthToWidthRatio: 10 / Math.sqrt(2000), accessAxis: [0, 0, 1] }], cornerRadii: { minInternalVertical: 0 } };
  const r = cnc.run(block(pocket), plastic);
  assert.strictEqual(sev(r, "cnc-corner-radius"), "fail");
  assert.ok(/dog-bone/i.test(find(r, "cnc-corner-radius").detail));
  const low = cnc.run(block({ ...pocket, confidence: { pockets: 0.7 } }), plastic);
  assert.strictEqual(sev(low, "cnc-corner-radius"), "warn");
  assert.ok(find(low, "cnc-corner-radius").verify);
});

test("corner radius tiers: 0.5 mm → warn major (micro tool); R < depth/3 → warn minor; R ≥ depth/3 → pass", () => {
  const mk = (r, depth) => cnc.run(block({ pockets: [{ area: 2500, depth, floorArea: 2500, openSides: 0, minCornerRadius: r, depthToWidthRatio: depth / 50, accessAxis: [0, 0, 1] }], cornerRadii: { minInternalVertical: r } }), plastic);
  assert.strictEqual(cost(mk(0.5, 10), "cnc-corner-radius"), "major");
  assert.strictEqual(sev(mk(0.5, 10), "cnc-corner-radius"), "warn");
  assert.strictEqual(sev(mk(2, 12), "cnc-corner-radius"), "warn");
  assert.strictEqual(cost(mk(2, 12), "cnc-corner-radius"), "minor");
  assert.strictEqual(sev(mk(5, 12), "cnc-corner-radius"), "pass");
  // acrylic: R 2 mm in a shallow pocket still warns (notch sensitivity)
  assert.strictEqual(sev(cnc.run(block({ pockets: [{ area: 2500, depth: 3, minCornerRadius: 2, depthToWidthRatio: 0.06 }], cornerRadii: { minInternalVertical: 2 } }), { materialType: "plastic", materialSlug: "cnc-acrylic" }), "cnc-corner-radius"), "warn");
});

test("pocket depth-to-width: 5× warn minor, 7× warn major, 3× pass", () => {
  const mk = (ratio) => cnc.run(block({ pockets: [{ area: 400, depth: 20 * ratio, minCornerRadius: 5, depthToWidthRatio: ratio }] }), plastic);
  assert.strictEqual(sev(mk(3), "cnc-pocket-ratio"), "pass");
  assert.strictEqual(sev(mk(5), "cnc-pocket-ratio"), "warn");
  assert.strictEqual(cost(mk(5), "cnc-pocket-ratio"), "minor");
  assert.strictEqual(cost(mk(7), "cnc-pocket-ratio"), "major");
});

test("hole depth: 7.6× (Ø4.2 × 32) warns minor with the open-to-Ø option; 13× warns major; 3× passes", () => {
  const mk = (d, depth) => cnc.run(block({ holes: [{ diameter: d, depth, through: false, blind: true, kind: "round", axis: [0, 0, 1], center: [0, 0, 0] }] }), plastic);
  const r = mk(4.2, 32);
  assert.strictEqual(sev(r, "cnc-hole-depth"), "warn");
  assert.strictEqual(cost(r, "cnc-hole-depth"), "minor");
  assert.ok(/7\.6×/.test(find(r, "cnc-hole-depth").detail) && /Ø5\.3/.test(find(r, "cnc-hole-depth").detail), find(r, "cnc-hole-depth").detail);
  assert.strictEqual(cost(mk(3, 40), "cnc-hole-depth"), "major");
  assert.strictEqual(sev(mk(8, 24), "cnc-hole-depth"), "pass");
});

test("hole diameter: Ø0.8 warns major; Ø2 passes with a minor cost note", () => {
  const mk = (d) => cnc.run(block({ holes: [{ diameter: d, depth: 5, through: true, kind: "round" }] }), plastic);
  assert.strictEqual(sev(mk(0.8), "cnc-hole-diameter"), "warn");
  assert.strictEqual(cost(mk(0.8), "cnc-hole-diameter"), "major");
  assert.strictEqual(sev(mk(2), "cnc-hole-diameter"), "pass");
  assert.strictEqual(cost(mk(2), "cnc-hole-diameter"), "minor");
});

test("thread depth: tapped candidate 5 mm × 20 deep (4×) warns; 12 deep (2.4×) passes", () => {
  const mk = (depth) => cnc.run(block({ holes: [{ diameter: 5, depth, through: false, blind: true, kind: "tapped-candidate" }] }), plastic);
  assert.strictEqual(sev(mk(20), "cnc-thread-depth"), "warn");
  assert.strictEqual(sev(mk(12), "cnc-thread-depth"), "pass");
  // acrylic gets an insert recommendation
  assert.ok(/insert/i.test(find(cnc.run(block({ holes: [{ diameter: 5, depth: 12, kind: "tapped-candidate" }] }), { materialType: "plastic", materialSlug: "cnc-acrylic" }), "cnc-thread-depth").detail));
});

test("min feature: 0.8 mm slot warns major, 2 mm warns minor, 3 mm passes", () => {
  const mk = (w) => cnc.run(block({ slots: [{ width: w, length: 20, depth: 5, through: false }] }), plastic);
  assert.strictEqual(cost(mk(0.8), "cnc-min-feature"), "major");
  assert.strictEqual(cost(mk(2), "cnc-min-feature"), "minor");
  assert.strictEqual(sev(mk(3), "cnc-min-feature"), "pass");
});

test("setups and undercuts: 4 setups warn minor, 6 warn major; 8% undercut warns major", () => {
  assert.strictEqual(cost(cnc.run(block({ access: { minSetups3Axis: 4 } }), plastic), "cnc-tool-access"), "minor");
  assert.strictEqual(cost(cnc.run(block({ access: { minSetups3Axis: 6 } }), plastic), "cnc-tool-access"), "major");
  assert.strictEqual(sev(cnc.run(block({ access: { undercutAreaFraction: 0.08 } }), plastic), "cnc-undercut"), "warn");
  assert.strictEqual(cost(cnc.run(block({ access: { undercutAreaFraction: 0.08 } }), plastic), "cnc-undercut"), "major");
  assert.strictEqual(sev(cnc.run(block(), plastic), "cnc-undercut"), "pass");
});

test("tall thin wall: plastic 5:1 warns minor, 9:1 major; metal 5:1 passes (≤4:1 plastic / ≤4:1 metal… metal threshold 4)", () => {
  assert.strictEqual(cost(cnc.run(block({ walls: { tallThinMaxAspect: 5 } }), plastic), "cnc-thin-tall-features"), "minor");
  assert.strictEqual(cost(cnc.run(block({ walls: { tallThinMaxAspect: 9 } }), plastic), "cnc-thin-tall-features"), "major");
  assert.strictEqual(sev(cnc.run(block({ walls: { tallThinMaxAspect: 3.5 } }), metal), "cnc-thin-tall-features"), "pass");
  assert.strictEqual(sev(cnc.run(block({ walls: { tallThinMaxAspect: 2.9 } }), plastic), "cnc-thin-tall-features"), "pass");
});

test("non-manifold mesh FAILS; open (non-watertight) mesh warns major", () => {
  assert.strictEqual(sev(cnc.run(block({ mesh: { manifold: false } }), plastic), "cnc-mesh-integrity"), "fail");
  const open = cnc.run(block({ mesh: { watertight: false } }), plastic);
  assert.strictEqual(sev(open, "cnc-mesh-integrity"), "warn");
  assert.strictEqual(cost(open, "cnc-mesh-integrity"), "major");
});

test("material notes: nylon moisture info, acrylic brittle, PEEK cost, UHMW soft, stress relief on heavy removal", () => {
  assert.strictEqual(sev(cnc.run(block(), { materialType: "plastic", materialSlug: "cnc-nylon" }), "cnc-moisture"), "info");
  assert.ok(find(cnc.run(block(), { materialType: "plastic", materialSlug: "cnc-acrylic" }), "cnc-brittle-material"));
  assert.ok(find(cnc.run(block(), { materialType: "plastic", materialSlug: "cnc-peek" }), "cnc-material-cost"));
  assert.ok(find(cnc.run(block(), { materialType: "plastic", materialSlug: "cnc-uhmw" }), "cnc-soft-material"));
  assert.ok(!find(cnc.run(block(), metal), "cnc-soft-material"));
  const heavy = cnc.run(block({ volume: 100 * 60 * 25 * 0.15 }), plastic);
  assert.strictEqual(sev(heavy, "cnc-stress-relief"), "warn");
  assert.strictEqual(cost(heavy, "cnc-stress-relief"), "minor");
});

test("removal efficiency: 10% of bbox warns major; 20% warns minor", () => {
  assert.strictEqual(cost(cnc.run(block({ volume: 100 * 60 * 25 * 0.1 }), plastic), "cnc-removal-efficiency"), "major");
  assert.strictEqual(cost(cnc.run(block({ volume: 100 * 60 * 25 * 0.2 }), plastic), "cnc-removal-efficiency"), "minor");
});

test("text stroke 0.3 mm warns; small part 8 × 6 mm warns minor", () => {
  assert.strictEqual(sev(cnc.run(block({ text: { present: true, minStroke: 0.3 } }), plastic), "cnc-text"), "warn");
  assert.strictEqual(sev(cnc.run(block({ aabb: { w: 30, h: 8, d: 6 }, obb: { w: 30, h: 8, d: 6 } }), plastic), "cnc-small-part"), "warn");
});

console.log("DFM rules — CNC turning");

function revolved(overrides = {}) {
  return block(deepMerge({
    aabb: { w: 50, h: 50, d: 200 }, obb: { w: 200, h: 50, d: 50 },
    volume: Math.PI / 4 * (50 * 50 - 20 * 20) * 200,
    shape: { kind: "revolved", primaryAxis: [0, 0, 1], revolved: { axis: [0, 0, 1], maxDiameter: 50, length: 200, minDiameter: 50, boreDiameter: 20, segments: 1 } },
    holes: [{ diameter: 20, depth: 200, through: true, axis: [0, 0, 1], kind: "round" }],
    walls: { minThickness: 15, tallThinMaxAspect: 1 },
  }, overrides));
}
const turn = (g, extra = {}) => cnc.run(g, { ...plastic, subProcess: "turning", ...extra });

test("roller Ø50 × 200 with Ø20 through bore: L/D 4 warns minor, bore 10× warns major, wall passes", () => {
  const r = turn(revolved());
  assert.strictEqual(sev(r, "cnc-turning-geometry"), "pass");
  assert.strictEqual(sev(r, "cnc-turn-ld-ratio"), "warn");
  assert.strictEqual(cost(r, "cnc-turn-ld-ratio"), "minor");
  assert.strictEqual(sev(r, "cnc-turn-bore-depth"), "warn");
  assert.strictEqual(cost(r, "cnc-turn-bore-depth"), "major");
  assert.strictEqual(sev(r, "cnc-turn-min-wall"), "pass");
  assert.strictEqual(r.summary.manufacturable, true);
});

test("L/D 10 warns major (steady rest); L/D 2 passes", () => {
  assert.strictEqual(cost(turn(revolved({ shape: { revolved: { length: 500, maxDiameter: 50 } }, aabb: { w: 50, h: 50, d: 500 }, obb: { w: 500, h: 50, d: 50 } })), "cnc-turn-ld-ratio"), "major");
  assert.strictEqual(sev(turn(revolved({ shape: { revolved: { length: 100, maxDiameter: 50 } }, aabb: { w: 50, h: 50, d: 100 }, obb: { w: 100, h: 50, d: 50 } })), "cnc-turn-ld-ratio"), "pass");
});

test("tube wall: Ø50 with Ø48 bore (1 mm wall) warns major in plastic, passes in metal; zero wall FAILS", () => {
  assert.strictEqual(cost(turn(revolved({ shape: { revolved: { boreDiameter: 48 } } })), "cnc-turn-min-wall"), "major");
  assert.strictEqual(sev(turn(revolved({ shape: { revolved: { boreDiameter: 48 } } }), metal), "cnc-turn-min-wall"), "pass");
  // UHMW needs 2.5 mm
  assert.strictEqual(sev(turn(revolved({ shape: { revolved: { boreDiameter: 46 } } }), { materialSlug: "cnc-uhmw", materialName: "UHMW" }), "cnc-turn-min-wall"), "warn");
  const zero = turn(revolved({ shape: { revolved: { boreDiameter: 50 } } }));
  assert.strictEqual(sev(zero, "cnc-turn-min-wall"), "fail");
  assert.strictEqual(zero.summary.manufacturable, false);
});

test("lathe envelope: Ø300 × 200 FAILS (swing), Ø50 × 700 FAILS (length), Ø240 × 590 passes", () => {
  assert.strictEqual(sev(turn(revolved({ shape: { revolved: { maxDiameter: 300, length: 200 } }, aabb: { w: 300, h: 300, d: 200 }, obb: { w: 300, h: 300, d: 200 } })), "cnc-max-size"), "fail");
  assert.strictEqual(sev(turn(revolved({ shape: { revolved: { maxDiameter: 50, length: 700 } }, aabb: { w: 50, h: 50, d: 700 }, obb: { w: 700, h: 50, d: 50 } })), "cnc-max-size"), "fail");
  assert.strictEqual(sev(turn(revolved({ shape: { revolved: { maxDiameter: 240, length: 590 } }, aabb: { w: 240, h: 240, d: 590 }, obb: { w: 590, h: 240, d: 240 } })), "cnc-max-size"), "pass");
});

test("thin neck, tiny part, small cross hole and non-revolved shape all warn (never fail)", () => {
  assert.strictEqual(sev(turn(revolved({ shape: { revolved: { minDiameter: 4, segments: 3 } } })), "cnc-turn-min-diameter"), "warn");
  assert.strictEqual(sev(turn(revolved({ shape: { revolved: { minDiameter: 0.5 } } })), "cnc-turn-min-diameter"), "warn");
  const tiny = turn(revolved({ shape: { revolved: { maxDiameter: 3, length: 6, boreDiameter: 1 } }, aabb: { w: 3, h: 3, d: 6 }, obb: { w: 6, h: 3, d: 3 } }));
  assert.strictEqual(sev(tiny, "cnc-turn-small-part"), "warn");
  const cross = turn(revolved({ holes: [{ diameter: 1.5, depth: 10, axis: [1, 0, 0], kind: "round" }] }));
  assert.strictEqual(sev(cross, "cnc-turn-radial-holes"), "warn");
  const notRound = turn(block());
  assert.strictEqual(sev(notRound, "cnc-turning-geometry"), "warn");
  assert.strictEqual(notRound.summary.manufacturable, true);
});

console.log("DFM rules — routing (measured features)");

function plate(overrides = {}) {
  return block(deepMerge({
    aabb: { w: 150, h: 100, d: 6.35 }, obb: { w: 150, h: 100, d: 6.35 },
    volume: 150 * 100 * 6.35 * 0.98,
    shape: { kind: "flat", is25D: true, stockThickness: 6.35, profile: { area: 150 * 100 * 0.98, perimeter: 500, bboxW: 150, bboxH: 100, minInternalRadius: 5, minSlotWidth: null } },
    walls: { minThickness: 20, tallThinMaxAspect: 1 },
    stock: { sheet: { thickness: 6.35, blankW: 156, blankH: 106, area: 156 * 106 } },
  }, overrides));
}
const rt = (g, extra = {}) => routing.run(g, { thicknessMm: 6.35, materialSlug: "rt-hdpe", materialType: "plastic", ...extra });

test("clean plate passes with no warns", () => {
  const r = rt(plate());
  assert.strictEqual(r.summary.failCount, 0);
  assert.strictEqual(r.summary.warnCount, 0, JSON.stringify(r.checks.filter((c) => c.severity === "warn").map((c) => c.id)));
});

test("inside corner: sharp → warn major (dog-bone); R 2 mm in 6.35 mm stock → pass with minor cost (1/8\" tool); R 1 mm in 12.7 mm stock → warn major", () => {
  const sharp = rt(plate({ shape: { profile: { minInternalRadius: 0 } } }));
  assert.strictEqual(sev(sharp, "rt-corner-radius"), "warn");
  assert.strictEqual(cost(sharp, "rt-corner-radius"), "major");
  assert.ok(/dog-bone/.test(find(sharp, "rt-corner-radius").detail));
  assert.strictEqual(sharp.summary.manufacturable, true);
  const r2 = rt(plate({ shape: { profile: { minInternalRadius: 2 } } }));
  assert.strictEqual(sev(r2, "rt-corner-radius"), "pass");
  assert.strictEqual(cost(r2, "rt-corner-radius"), "minor");
  const thick = rt(plate({ aabb: { d: 12.7 }, obb: { d: 12.7 }, shape: { stockThickness: 12.7, profile: { minInternalRadius: 1 } } }), { thicknessMm: 12.7 });
  assert.strictEqual(cost(thick, "rt-corner-radius"), "major");
});

test("acrylic: R 2 mm inside corner warns (crack starter) even though a tool reaches it", () => {
  const r = rt(plate({ shape: { profile: { minInternalRadius: 2 } } }), { materialSlug: "rt-acrylic" });
  assert.strictEqual(sev(r, "rt-corner-radius"), "warn");
  assert.ok(find(r, "rt-material-note"));
});

test("slot width: 1.2 mm slot in 6.35 stock warns major (no tool reaches); 4 mm passes with minor cost; 7 mm passes", () => {
  assert.strictEqual(cost(rt(plate({ slots: [{ width: 1.2, length: 20, depth: 6.35, through: true }] })), "rt-slot-width"), "major");
  const s4 = rt(plate({ slots: [{ width: 4, length: 20, depth: 6.35, through: true }] }));
  assert.strictEqual(sev(s4, "rt-slot-width"), "pass");
  assert.strictEqual(cost(s4, "rt-slot-width"), "minor");
  assert.strictEqual(cost(rt(plate({ slots: [{ width: 7, length: 20, depth: 6.35, through: true }] })), "rt-slot-width"), "none");
});

test("thin web: 1 mm warns major, 4 mm warns minor (< 1× t), 7 mm passes; zero web FAILS", () => {
  assert.strictEqual(cost(rt(plate({ walls: { minThickness: 1 } })), "rt-thin-web"), "major");
  assert.strictEqual(cost(rt(plate({ walls: { minThickness: 4 } })), "rt-thin-web"), "minor");
  assert.strictEqual(sev(rt(plate({ walls: { minThickness: 7 } })), "rt-thin-web"), "pass");
  const z = rt(plate({ walls: { minThickness: 0 } }));
  assert.strictEqual(sev(z, "rt-thin-web"), "fail");
  assert.strictEqual(z.summary.manufacturable, false);
});

test("small parts: 20 × 10 clip warns (tabs, min charge); 8 × 30 warns major (not holdable); 60 × 60 has no small-part note", () => {
  const clip = rt(plate({ aabb: { w: 20, h: 10, d: 3 }, obb: { w: 20, h: 10, d: 3 }, shape: { stockThickness: 3, profile: { bboxW: 20, bboxH: 10 } } }), { thicknessMm: 3.2 });
  assert.strictEqual(sev(clip, "rt-small-part"), "warn");
  const sliver = rt(plate({ aabb: { w: 30, h: 8, d: 3 }, obb: { w: 30, h: 8, d: 3 }, shape: { stockThickness: 3, profile: { bboxW: 30, bboxH: 8 } } }), { thicknessMm: 3.2 });
  assert.strictEqual(cost(sliver, "rt-small-part"), "major");
  assert.ok(!find(rt(plate({ aabb: { w: 60, h: 60 }, obb: { w: 60, h: 60 }, shape: { profile: { bboxW: 60, bboxH: 60 } } })), "rt-small-part"));
});

test("holes: Ø1 warns major; Ø2.5 in 12.7 stock warns minor (drilled, deep); Ø6.6 passes", () => {
  assert.strictEqual(cost(rt(plate({ holes: [{ diameter: 1, depth: 6.35, through: true, kind: "round" }] })), "rt-holes"), "major");
  const deep = rt(plate({ aabb: { d: 12.7 }, obb: { d: 12.7 }, shape: { stockThickness: 12.7 }, holes: [{ diameter: 2.5, depth: 12.7, through: true, kind: "round" }] }), { thicknessMm: 12.7 });
  assert.strictEqual(sev(deep, "rt-holes"), "warn");
  assert.strictEqual(sev(rt(plate({ holes: [{ diameter: 6.6, depth: 6.35, through: true, kind: "round" }] })), "rt-holes"), "pass");
});

test("pockets: 5:1 deep pocket warns major; thin 0.8 mm floor warns; normal pocket passes with minor cost", () => {
  assert.strictEqual(cost(rt(plate({ pockets: [{ area: 16, depth: 20, depthToWidthRatio: 5, minCornerRadius: 3 }] }), { thicknessMm: 25.4 }), "rt-pockets"), "major");
  assert.strictEqual(sev(rt(plate({ pockets: [{ area: 2000, depth: 5.55, depthToWidthRatio: 0.12, minCornerRadius: 6 }] })), "rt-pockets"), "warn");
  const ok = rt(plate({ pockets: [{ area: 2000, depth: 3, depthToWidthRatio: 0.07, minCornerRadius: 6 }] }));
  assert.strictEqual(sev(ok, "rt-pockets"), "pass");
  assert.strictEqual(cost(ok, "rt-pockets"), "minor");
});

test("lacy part (80% removed) warns major; 3D (not 2.5D) part warns toward milling; bed overflow FAILS", () => {
  assert.strictEqual(cost(rt(plate({ shape: { profile: { area: 150 * 100 * 0.2 } } })), "rt-material-removal"), "major");
  assert.strictEqual(sev(rt(plate({ shape: { is25D: false } })), "rt-sheet-geometry"), "warn");
  const big = rt(plate({ aabb: { w: 2600, h: 300 }, obb: { w: 2600, h: 300 }, shape: { profile: { bboxW: 2600, bboxH: 300 } } }));
  assert.strictEqual(sev(big, "rt-bed-size"), "fail");
  assert.strictEqual(big.summary.manufacturable, false);
});

console.log("DFM rules — 3D printing (measured features)");

const fdm = (g, extra = {}) => printing.run(g, { subProcess: "fdm", materialSlug: "fdm-pla", ...extra });
const sla = (g, extra = {}) => printing.run(g, { subProcess: "sla", materialSlug: "sla-standard", ...extra });

test("clean block passes FDM and SLA with no warns", () => {
  for (const r of [fdm(block()), sla(block())]) {
    assert.strictEqual(r.summary.failCount, 0);
    assert.strictEqual(r.summary.warnCount, 0, JSON.stringify(r.checks.filter((c) => c.severity === "warn").map((c) => c.id)));
  }
});

test("min wall: 0.6 mm warns on FDM (0.8), passes on SLA (0.5); 0 mm FAILS; 0.9 mm passes FDM with a free-standing note", () => {
  assert.strictEqual(sev(fdm(block({ walls: { minThickness: 0.6 } })), "print-min-wall"), "warn");
  assert.strictEqual(sev(sla(block({ walls: { minThickness: 0.6 } })), "print-min-wall"), "pass");
  const z = fdm(block({ walls: { minThickness: 0 } }));
  assert.strictEqual(sev(z, "print-min-wall"), "fail");
  assert.strictEqual(z.summary.manufacturable, false);
  assert.strictEqual(cost(fdm(block({ walls: { minThickness: 0.9 } })), "print-min-wall"), "minor");
});

test("build volume: 400 × 100 × 100 fits FDM (any orientation) but FAILS SLA with a switch-process hint", () => {
  const g = block({ aabb: { w: 100, h: 100, d: 400 }, obb: { w: 400, h: 100, d: 100 } });
  assert.strictEqual(sev(fdm(g), "print-build-volume"), "pass");
  const s = sla(g);
  assert.strictEqual(sev(s, "print-build-volume"), "fail");
  assert.ok(/FDM/.test(find(s, "print-build-volume").detail));
});

test("overhang: 60% warns major on FDM/SLA, info on SLS; support volume 50% of part → major cost", () => {
  assert.strictEqual(cost(fdm(block({ overhang: { areaFraction45: 0.6 } })), "print-overhang"), "major");
  assert.strictEqual(sev(sla(block({ overhang: { areaFraction45: 0.6 } })), "print-overhang"), "warn");
  assert.strictEqual(sev(printing.run(block({ overhang: { areaFraction45: 0.6 } }), { subProcess: "sls" }), "print-overhang"), "info");
  const sup = fdm(block({ overhang: { areaFraction45: 0.2, supportVolumeEstimate: 100 * 60 * 25 * 0.45 } }));
  assert.strictEqual(sev(sup, "print-overhang"), "pass");
  assert.strictEqual(cost(sup, "print-overhang"), "major");
});

test("bridging: 15 mm span warns on FDM (10), passes on SLA (21); 30 mm warns on SLA", () => {
  assert.strictEqual(sev(fdm(block({ bridging: { maxSpan: 15 } })), "print-bridge-length"), "warn");
  assert.strictEqual(sev(sla(block({ bridging: { maxSpan: 15 } })), "print-bridge-length"), "pass");
  assert.strictEqual(sev(sla(block({ bridging: { maxSpan: 30 } })), "print-bridge-length"), "warn");
});

test("holes: Ø1.5 warns on FDM (2 mm), passes on SLA (0.5); pins Ø2 warn on FDM (3 mm), lanky 12:1 pin warns", () => {
  assert.strictEqual(sev(fdm(block({ holes: [{ diameter: 1.5, depth: 5 }] })), "print-min-hole"), "warn");
  assert.strictEqual(sev(sla(block({ holes: [{ diameter: 1.5, depth: 5 }] })), "print-min-hole"), "pass");
  assert.strictEqual(sev(fdm(block({ bosses: [{ diameter: 2, height: 5 }] })), "print-pins"), "warn");
  assert.strictEqual(sev(fdm(block({ bosses: [{ diameter: 4, height: 50 }] })), "print-pins"), "warn");
  assert.strictEqual(sev(fdm(block({ bosses: [{ diameter: 4, height: 10 }] })), "print-pins"), "pass");
});

test("small features and text: 1.5 mm slot warns on FDM, passes on SLA; 0.4 mm text stroke warns on FDM", () => {
  assert.strictEqual(sev(fdm(block({ slots: [{ width: 1.5, length: 10, depth: 2 }] })), "print-small-features"), "warn");
  assert.strictEqual(sev(sla(block({ slots: [{ width: 1.5, length: 10, depth: 2 }] })), "print-small-features"), "pass");
  assert.strictEqual(sev(fdm(block({ text: { present: true, minStroke: 0.4 } })), "print-text"), "warn");
  assert.strictEqual(sev(sla(block({ text: { present: true, minStroke: 0.4 } })), "print-text"), "pass");
});

test("warping: 120 × 80 base warns in ABS (5000 mm²) but not PLA (15000 mm²); 25:1 wall warns only when under 1.5 mm", () => {
  const g = block({ aabb: { w: 120, h: 80, d: 40 }, obb: { w: 120, h: 80, d: 40 } });
  assert.strictEqual(sev(fdm(g, { materialSlug: "fdm-abs" }), "print-fdm-warping"), "warn");
  assert.strictEqual(sev(fdm(g, { materialSlug: "fdm-pla" }), "print-fdm-warping"), "pass");
  assert.strictEqual(sev(fdm(block({ walls: { tallThinMaxAspect: 25, minThickness: 1.0 } })), "print-tall-thin"), "warn");
  assert.ok(!find(fdm(block({ walls: { tallThinMaxAspect: 25, minThickness: 2.5 } })), "print-tall-thin"), "2.5 mm walls are fine at any height");
});

test("non-manifold mesh FAILS printing; multi-body file warns about clearance", () => {
  assert.strictEqual(sev(fdm(block({ mesh: { manifold: false } })), "print-mesh-integrity"), "fail");
  const asm = fdm({ ...block(), bodyCount: 2, isAssembly: true, boundingBox: { width: 100, height: 60, depth: 25 }, volume: 1000 });
  assert.strictEqual(sev(asm, "print-clearance"), "warn");
});

console.log("DFM rules — legacy adapter path");

const legacyPlate = { boundingBox: { width: 150, height: 100, depth: 6.35 }, volume: 93952, surfaceArea: 2 * 150 * 100 + 2 * 250 * 6.35, estimatedThickness: 6.35, flatWidth: 150, flatHeight: 100, estimatedPerimeter: 624, estimatedHoles: 6, estimatedSlots: 0, estimatedBends: 0, overhangFraction: 0.5 };

test("adapter marks legacy confidence and derives extents, shape and stock", () => {
  const { features, conf } = getFeatures(legacyPlate, {});
  assert.strictEqual(conf.source, "legacy");
  assert.strictEqual(conf.walls, "legacy");
  assert.strictEqual(conf.extents, 1.0);
  assert.strictEqual(features.shape.kind, "flat");
  assert.strictEqual(features.shape.stockThickness, 6.35);
  assert.ok(features.stock.sheet && features.stock.block);
  assert.strictEqual(features.holes.length, 0);
  assert.strictEqual(features.legacy.estimatedHoles, 6);
});

test("adapter passes a measured features object through and keeps its confidence", () => {
  const { features, conf } = getFeatures(block({ confidence: { holes: 0.8 } }), {});
  assert.strictEqual(conf.source, "measured");
  assert.strictEqual(conf.holes, 0.8);
  assert.strictEqual(features.aabb.w, 100);
});

test("legacy geometry never FAILS on feature-level rules: only exact extents can fail", () => {
  const r = cnc.run(legacyPlate, plastic);
  assert.strictEqual(r.summary.failCount, 0);
  for (const c of r.checks) if (c.confidence === "legacy") assert.notStrictEqual(c.severity, "fail", c.id);
  const t = cnc.run({ boundingBox: { width: 50, height: 50, depth: 200 }, volume: 329261, estimatedThickness: 50, estimatedHoles: 1 }, { ...plastic, subProcess: "turning" });
  assert.strictEqual(t.summary.failCount, 0);
  assert.strictEqual(sev(t, "cnc-turning-geometry"), "pass");
  assert.strictEqual(sev(t, "cnc-turn-ld-ratio"), "warn");
});

test("legacy routing plate keeps the historical ids (bed, sheet, corner info, holes info, nesting)", () => {
  const r = routing.run(legacyPlate, { thicknessMm: 6.35 });
  for (const id of ["rt-bed-size", "rt-sheet-geometry", "rt-thickness-match", "rt-corner-radius", "rt-holes", "rt-tolerance", "rt-nesting"]) assert.ok(find(r, id), id);
  assert.strictEqual(sev(r, "rt-corner-radius"), "info");
  assert.strictEqual(r.summary.failCount, 0);
});

console.log(`\n${passed} checks passed` + (process.exitCode ? " (with failures above)" : ""));
