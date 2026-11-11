/**
 * CNC routing process tests. Run: `node server/processes/routing/routing.test.js`
 */
const assert = require("assert");
const { calculate } = require("./pricing");
const { run } = require("./dfm");
const { DEFAULT_PRICING_RULES, ROUTING_MATERIALS } = require("../../config/defaults");
const registry = require("../registry");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

const { calculate: calculateCnc } = require("../cnc/pricing");
const { CNC_MATERIALS } = require("../../config/defaults");

// 300 × 200 × 12.7 plate with six Ø10 through holes — legacy scalars only
const holeArea = 6 * Math.PI * 25;
const plate = {
  boundingBox: { width: 300, height: 200, depth: 12.7 },
  volume: (300 * 200 - holeArea) * 12.7,
  surfaceArea: 2 * (300 * 200 - holeArea) + (2 * (300 + 200) + 6 * Math.PI * 10) * 12.7,
  estimatedThickness: 12.7, flatWidth: 300, flatHeight: 200, flatArea: 300 * 200,
  estimatedPerimeter: 1000, estimatedHoles: 6, estimatedSlots: 1,
};
// The same plate described by a features object (SCHEMA.md shape)
function withFeatures(g, over = {}) {
  return { ...g, features: {
    schemaVersion: 1, source: "step",
    aabb: { w: g.boundingBox.width, h: g.boundingBox.height, d: g.boundingBox.depth },
    obb: { w: g.boundingBox.width, h: g.boundingBox.height, d: g.boundingBox.depth, axes: null },
    volume: g.volume, surfaceArea: g.surfaceArea,
    shape: { kind: "flat", primaryAxis: [0, 0, 1], is25D: true, stockThickness: g.boundingBox.depth,
      profile: { area: 300 * 200 - holeArea, perimeter: 1000, innerPerimeter: 6 * Math.PI * 10, bboxW: 300, bboxH: 200, minInternalRadius: null, minSlotWidth: null }, revolved: null },
    holes: Array.from({ length: 6 }, () => ({ diameter: 10, depth: 12.7, through: true, axis: [0, 0, 1], center: [0, 0, 0], blind: false, kind: "round", depthToDiaRatio: 1.27 })),
    pockets: [], slots: [], bosses: [], fillets: null, chamfers: null, text: null,
    walls: { minThickness: 12.7, p05Thickness: 12.7, thinAreaFraction: 0, tallThinMaxAspect: 1 },
    access: { directions: [[0, 0, 1]], minSetups3Axis: 1, undercutAreaFraction: 0 },
    cornerRadii: { minInternalVertical: null, minInternalFloor: null },
    overhang: { areaFraction45: 0, maxAngleFromVertical: 0, supportVolumeEstimate: 0 },
    bridging: null, stock: null, confidence: { holes: 1, pockets: 1, walls: 1, shape: 1, overall: 1 }, notes: [],
    ...over,
  } };
}
const hdpe = ROUTING_MATERIALS.find((m) => m.slug === "rt-hdpe");
const g10 = ROUTING_MATERIALS.find((m) => m.slug === "rt-g10");
const alu = ROUTING_MATERIALS.find((m) => m.slug === "rt-aluminum-6061");
const cncHdpe = CNC_MATERIALS.find((m) => m.slug === "cnc-hdpe");
const base = { geometry: plate, material: hdpe, thicknessMm: 12.7, grade: hdpe.grades[0].name, finish: null };

console.log("CNC routing");

test("routing is registered and active with its own pricing + DFM", () => {
  const def = registry.getProcess("routing");
  assert.ok(def && def.active !== false);
  assert.strictEqual(typeof def.pricing.calculate, "function");
  assert.strictEqual(typeof def.dfm.run, "function");
  assert.ok(registry.activeProcesses().map((p) => p.slug).includes("routing"));
});

test("sheet metal is registered but inactive (hidden from the quote flow)", () => {
  assert.strictEqual(registry.getProcess("sheetmetal").active, false);
  assert.ok(!registry.activeProcesses().map((p) => p.slug).includes("sheetmetal"));
});

test("unit price falls with quantity (setup amortizes, discounts apply)", () => {
  const p1 = calculate({ ...base, quantity: 1 }, DEFAULT_PRICING_RULES).perUnit.final;
  const p10 = calculate({ ...base, quantity: 10 }, DEFAULT_PRICING_RULES).perUnit.final;
  const p100 = calculate({ ...base, quantity: 100 }, DEFAULT_PRICING_RULES).perUnit.final;
  assert.ok(p1 > p10 && p10 > p100, `${p1} > ${p10} > ${p100}`);
});

test("longer cut path costs more (features: profile perimeter; legacy: more edge surface)", () => {
  const short = calculate({ ...base, geometry: withFeatures(plate), quantity: 10 }, DEFAULT_PRICING_RULES);
  const longF = withFeatures(plate); longF.features.shape.profile.perimeter = 4000;
  const long = calculate({ ...base, geometry: longF, quantity: 10 }, DEFAULT_PRICING_RULES);
  assert.ok(long.perUnit.final > short.perUnit.final && long.meta.cutLengthMm > short.meta.cutLengthMm);
  // legacy: the parser's noisy estimatedPerimeter is ignored; real edge surface is not
  const noisy = calculate({ ...base, geometry: { ...plate, estimatedPerimeter: 4000 }, quantity: 10 }, DEFAULT_PRICING_RULES);
  const legacyShort = calculate({ ...base, quantity: 10 }, DEFAULT_PRICING_RULES);
  assert.ok(Math.abs(noisy.perUnit.final - legacyShort.perUnit.final) < 1e-9, "estimatedPerimeter must not move the price");
  const moreEdge = calculate({ ...base, geometry: { ...plate, surfaceArea: plate.surfaceArea + 2000 * 12.7 }, quantity: 10 }, DEFAULT_PRICING_RULES);
  assert.ok(moreEdge.perUnit.final > legacyShort.perUnit.final);
});

test("legacy and featured views of the same plate price within 15% of each other", () => {
  const a = calculate({ ...base, quantity: 10 }, DEFAULT_PRICING_RULES);
  const b = calculate({ ...base, geometry: withFeatures(plate), quantity: 10 }, DEFAULT_PRICING_RULES);
  assert.ok(Math.abs(a.perUnit.final / b.perUnit.final - 1) < 0.15, `${a.perUnit.final} vs ${b.perUnit.final}`);
  assert.strictEqual(a.meta.confidence.source, "legacy");
  assert.strictEqual(b.meta.confidence.source, "features");
});

test("more holes → more $ (plunges) on the router", () => {
  const six = calculate({ ...base, geometry: withFeatures(plate), quantity: 10 }, DEFAULT_PRICING_RULES).perUnit.final;
  const holes = Array.from({ length: 30 }, () => ({ diameter: 10, depth: 12.7, through: true, kind: "round" }));
  const thirty = calculate({ ...base, geometry: withFeatures(plate, { holes }), quantity: 10 }, DEFAULT_PRICING_RULES).perUnit.final;
  assert.ok(thirty > six);
});

test("a pocket adds removal time (the tray case) — featured and legacy", () => {
  const trayPocket = 170 * 120 * 12.7;
  const tray = { boundingBox: { width: 200, height: 150, depth: 19.05 }, volume: 200 * 150 * 19.05 - trayPocket,
    surfaceArea: 2 * 200 * 150 + 2 * (200 + 150) * 19.05 + 2 * (170 + 120) * 12.7 };
  const solid = { ...tray, volume: 200 * 150 * 19.05, surfaceArea: 2 * 200 * 150 + 2 * (200 + 150) * 19.05 };
  const a = calculate({ ...base, geometry: solid, thicknessMm: 19.05, quantity: 10 }, DEFAULT_PRICING_RULES);
  const b = calculate({ ...base, geometry: tray, thicknessMm: 19.05, quantity: 10 }, DEFAULT_PRICING_RULES);
  assert.ok(b.meta.pocketCm3 > 200 && b.meta.cycleMinutes > a.meta.cycleMinutes + 5, `pocket ${b.meta.pocketCm3} cm³, ${b.meta.cycleMinutes} vs ${a.meta.cycleMinutes} min`);
  const feat = withFeatures(tray, { shape: { kind: "flat", stockThickness: 19.05, profile: { area: 30000, perimeter: 700, innerPerimeter: 0, bboxW: 200, bboxH: 150, minInternalRadius: 6, minSlotWidth: null }, revolved: null },
    holes: [], pockets: [{ area: 170 * 120, depth: 12.7, floorArea: 170 * 120, openSides: 0, minCornerRadius: 6, depthToWidthRatio: 0.1, accessAxis: [0, 0, 1] }] });
  const c = calculate({ ...base, geometry: feat, thicknessMm: 19.05, quantity: 10 }, DEFAULT_PRICING_RULES);
  assert.ok(Math.abs(c.meta.pocketCm3 - trayPocket / 1000) < 1);
});

test("small internal corners force the 1/8\" cutter (slower, dearer)", () => {
  const normal = calculate({ ...base, geometry: withFeatures(plate), quantity: 10 }, DEFAULT_PRICING_RULES);
  const f = withFeatures(plate); f.features.shape.profile.minInternalRadius = 1.5;
  const tight = calculate({ ...base, geometry: f, quantity: 10 }, DEFAULT_PRICING_RULES);
  assert.ok(tight.meta.cutter.startsWith("1/8") && tight.perUnit.final > normal.perUnit.final);
});

test("aluminum plate runs shallow passes and prices well above HDPE", () => {
  const a = calculate({ ...base, quantity: 10 }, DEFAULT_PRICING_RULES);
  const b = calculate({ ...base, material: alu, grade: alu.grades[0].name, quantity: 10 }, DEFAULT_PRICING_RULES);
  assert.ok(b.meta.passes > a.meta.passes * 2 && b.perUnit.final > a.perUnit.final * 1.5);
});

test("routing is cheaper than milling the same flat HDPE plate at every quantity", () => {
  for (const q of [1, 10, 25, 100]) {
    const rt = calculate({ ...base, quantity: q }, DEFAULT_PRICING_RULES).perUnit.final;
    const cnc = calculateCnc({ geometry: plate, material: cncHdpe, grade: cncHdpe.grades[0].name, finish: null, quantity: q, subProcess: "milling" }, DEFAULT_PRICING_RULES).perUnit.final;
    assert.ok(rt < cnc, `qty ${q}: routing ${rt} should be < cnc ${cnc}`);
  }
});

test("router floor holds; tool changes and sheet handling are shared per sheet; costBuildup present", () => {
  const tiny = calculate({ ...base, geometry: { boundingBox: { width: 20, height: 10, depth: 3 }, volume: 580, surfaceArea: 600 }, thicknessMm: 3.2, quantity: 250 }, DEFAULT_PRICING_RULES);
  assert.ok(tiny.perUnit.final >= DEFAULT_PRICING_RULES.routerMinimumPartPrice - 1e-9);
  const one = calculate({ ...base, quantity: 1 }, DEFAULT_PRICING_RULES);
  const many = calculate({ ...base, quantity: 50 }, DEFAULT_PRICING_RULES);
  const share = (p) => p.meta.costBuildup.find((s) => s.step === "sheet share").minutes;
  assert.ok(share(one) > share(many));
  assert.ok(Array.isArray(one.meta.costBuildup) && one.meta.costBuildup.every((s) => Number.isFinite(s.dollars)));
  const sum = one.meta.costBuildup.reduce((s, x) => s + x.dollars, 0);
  assert.ok(Math.abs(sum - one.perUnit.subtotal) < 0.05);
});

test("abrasive stock (G-10) prices above HDPE for the same part", () => {
  const a = calculate({ ...base, quantity: 10 }, DEFAULT_PRICING_RULES).perUnit.final;
  const b = calculate({ ...base, material: g10, grade: g10.grades[0].name, quantity: 10 }, DEFAULT_PRICING_RULES).perUnit.final;
  assert.ok(b > a);
});

test("thicker stock needs more passes and costs more", () => {
  const thin = calculate({ ...base, thicknessMm: 6.35, quantity: 10 }, DEFAULT_PRICING_RULES);
  const thick = calculate({ ...base, thicknessMm: 25.4, quantity: 10 }, DEFAULT_PRICING_RULES);
  assert.ok(thick.meta.passes > thin.meta.passes);
  assert.ok(thick.perUnit.final > thin.perUnit.final);
});

test("line item has the shared shape (perUnit.final, lineTotal, weight, meta.process)", () => {
  const r = calculate({ ...base, quantity: 3 }, DEFAULT_PRICING_RULES);
  assert.ok(Number.isFinite(r.perUnit.final) && r.perUnit.final > 0);
  assert.strictEqual(r.lineTotal, r.perUnit.final * 3);
  assert.strictEqual(r.weight.units, "kg");
  assert.strictEqual(r.meta.process, "routing");
  assert.ok(r.meta.partsPerSheet > 0);
});

test("DFM: a plate that fits the bed passes with no fails", () => {
  const d = run(plate, { thicknessMm: 12.7 });
  assert.strictEqual(d.summary.failCount, 0);
  assert.strictEqual(d.summary.manufacturable, true);
});

test("DFM: wider than the 59\" × 96\" bed FAILS (the only hard gate)", () => {
  const huge = { ...plate, boundingBox: { width: 2600, height: 300, depth: 12.7 }, flatWidth: 2600, flatHeight: 300 };
  const d = run(huge, {});
  assert.strictEqual(d.summary.manufacturable, false);
  assert.ok(d.checks.find((c) => c.id === "rt-bed-size").severity === "fail");
});

test("DFM: a 3D block (not sheet) WARNS toward CNC machining, never blocks", () => {
  const block = { ...plate, boundingBox: { width: 50, height: 30, depth: 40 }, flatWidth: 50, flatHeight: 30 };
  const d = run(block, {});
  assert.strictEqual(d.checks.find((c) => c.id === "rt-sheet-geometry").severity, "warn");
  assert.strictEqual(d.summary.manufacturable, true);
});

test("DFM: selected stock thickness far from the model WARNS", () => {
  const d = run(plate, { thicknessMm: 25.4 });
  assert.strictEqual(d.checks.find((c) => c.id === "rt-thickness-match").severity, "warn");
});

console.log(`\n${passed} checks passed`);
