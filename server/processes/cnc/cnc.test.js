/**
 * CNC pricing + feature-adapter tests. Run: `node server/processes/cnc/cnc.test.js`
 *
 * Covers: the adapter's legacy derivations, monotonicity in quantity, that
 * features move the price the right way (holes, corner radius, setups, walls,
 * pockets), turning sanity, floors, and the cost build-up / confidence meta.
 */
const assert = require("assert");
const { calculate } = require("./pricing");
const { resolveFeatures } = require("../featureAdapter");
const { DEFAULT_PRICING_RULES, CNC_MATERIALS } = require("../../config/defaults");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const R = DEFAULT_PRICING_RULES;
const delrin = CNC_MATERIALS.find((m) => m.slug === "cnc-delrin");
const alu = CNC_MATERIALS.find((m) => m.slug === "cnc-aluminum-6061");
const peek = CNC_MATERIALS.find((m) => m.slug === "cnc-peek");
const price = (geometry, over = {}) => calculate({ geometry, material: delrin, grade: delrin.grades[0].name, finish: null, quantity: 10, subProcess: "milling", ...over }, R);

// ─── Legacy fixtures (exact scalars, as the parser gives them) ───────────────
// 150 × 100 × 6.35 plate with six Ø6.6 through holes
const holeArea = 6 * Math.PI * 3.3 * 3.3;
const plate = {
  boundingBox: { width: 150, height: 100, depth: 6.35 },
  volume: (150 * 100 - holeArea) * 6.35,
  surfaceArea: 2 * (150 * 100 - holeArea) + (2 * (150 + 100) + 6 * Math.PI * 6.6) * 6.35,
};
// 100 × 60 × 25 solid block
const block = { boundingBox: { width: 100, height: 60, depth: 25 }, volume: 100 * 60 * 25, surfaceArea: 2 * (100 * 60 + 100 * 25 + 60 * 25) };
// 200 × 150 × 19.05 tray with a 170 × 120 × 12.7 pocket
const trayPocket = 170 * 120 * 12.7;
const tray = {
  boundingBox: { width: 200, height: 150, depth: 19.05 },
  volume: 200 * 150 * 19.05 - trayPocket,
  surfaceArea: 2 * 200 * 150 + 2 * (200 + 150) * 19.05 + 2 * (170 + 120) * 12.7,
};
// Ø40 × 30 bushing with Ø25 bore
const bushing = {
  boundingBox: { width: 40, height: 40, depth: 30 },
  volume: (Math.PI / 4) * (40 * 40 - 25 * 25) * 30,
  surfaceArea: 2 * (Math.PI / 4) * (40 * 40 - 25 * 25) + Math.PI * (40 + 25) * 30,
};

// A features object in the SCHEMA.md shape, built on the block
function featured(base, over = {}) {
  return {
    ...base,
    features: {
      schemaVersion: 1, source: "step",
      aabb: { w: base.boundingBox.width, h: base.boundingBox.height, d: base.boundingBox.depth },
      obb: { w: base.boundingBox.width, h: base.boundingBox.height, d: base.boundingBox.depth, axes: null },
      volume: base.volume, surfaceArea: base.surfaceArea,
      shape: { kind: "prismatic", primaryAxis: [0, 0, 1], is25D: true, stockThickness: null, profile: { area: null, perimeter: null, innerPerimeter: null, bboxW: null, bboxH: null, minInternalRadius: null, minSlotWidth: null }, revolved: null },
      holes: [], pockets: [], slots: [], bosses: [], fillets: null, chamfers: null, text: null,
      walls: { minThickness: 8, p05Thickness: 10, thinAreaFraction: 0, tallThinMaxAspect: 2 },
      access: { directions: [[0, 0, 1]], minSetups3Axis: 1, undercutAreaFraction: 0 },
      cornerRadii: { minInternalVertical: null, minInternalFloor: null },
      overhang: { areaFraction45: 0, maxAngleFromVertical: 0, supportVolumeEstimate: 0 },
      bridging: null, stock: null,
      confidence: { holes: 1, pockets: 1, walls: 0.9, shape: 1, overall: 0.95 },
      notes: [],
      ...over,
    },
  };
}
const hole = (d, depth, kind = "round") => ({ diameter: d, depth, through: true, axis: [0, 0, 1], center: [0, 0, 0], blind: false, kind, depthToDiaRatio: depth / d });

console.log("Feature adapter (legacy derivation)");

test("flat plate: top area, outer and inner edge length derive from SA/volume within 5%", () => {
  const { f, derived, source, confidence } = resolveFeatures(plate, {});
  assert.strictEqual(source, "legacy");
  assert.strictEqual(f.shape.kind, "flat");
  assert.ok(Math.abs(derived.edgeEquivalentMm - (500 + 6 * Math.PI * 6.6)) < 1, `edge ${derived.edgeEquivalentMm}`);
  assert.strictEqual(f.shape.profile.perimeter, 500);
  assert.ok(f.shape.profile.innerPerimeter > 40 && f.shape.profile.innerPerimeter <= 6 * Math.PI * 6.6 + 1, `inner ${f.shape.profile.innerPerimeter}`);
  assert.strictEqual(confidence.fields.holes, "legacy");
  assert.ok(f.holes.length === 0);
});

test("flat tray: blind pocket volume is recovered from the surface-area excess (within 10%)", () => {
  const { derived } = resolveFeatures(tray, {});
  assert.ok(Math.abs(derived.blindRemovalMm3 - trayPocket) / trayPocket < 0.1, `pocket ${derived.blindRemovalMm3} vs ${trayPocket}`);
  assert.ok(Math.abs(derived.topAreaEstimateMm2 - 30000) < 300, `top ${derived.topAreaEstimateMm2}`);
});

test("turning selected: diameter, length and bore derive from the box and volume within 2%", () => {
  const { f, confidence } = resolveFeatures(bushing, { subProcess: "turning" });
  assert.strictEqual(f.shape.kind, "revolved");
  const rv = f.shape.revolved;
  assert.ok(Math.abs(rv.maxDiameter - 40) < 0.8 && Math.abs(rv.length - 30) < 0.6 && Math.abs(rv.boreDiameter - 25) < 0.5, JSON.stringify(rv));
  assert.strictEqual(confidence.fields.revolved, "legacy");
  // a long shaft: Ø50 × 200 with Ø20 bore
  const roller = { boundingBox: { width: 50, height: 50, depth: 200 }, volume: (Math.PI / 4) * (2500 - 400) * 200, surfaceArea: 1 };
  const r2 = resolveFeatures(roller, { subProcess: "turning" }).f.shape.revolved;
  assert.ok(Math.abs(r2.maxDiameter - 50) < 0.1 && Math.abs(r2.length - 200) < 0.1 && Math.abs(r2.boreDiameter - 20) < 0.5, JSON.stringify(r2));
});

test("a block is prismatic; a 1-inch bracket is a block, a 1/2-inch rail is flat", () => {
  assert.strictEqual(resolveFeatures(block, {}).f.shape.kind, "prismatic");
  assert.strictEqual(resolveFeatures({ boundingBox: { width: 600, height: 25, depth: 12.7 }, volume: 190000, surfaceArea: 46000 }, {}).f.shape.kind, "flat");
  assert.strictEqual(resolveFeatures({ boundingBox: { width: 20, height: 20, depth: 20 }, volume: 8000, surfaceArea: 2400 }, {}).f.shape.kind, "prismatic");
});

test("features object is used as-is and confidence reports 'features'", () => {
  const g = featured(block, { holes: [hole(6, 25)] });
  const v = resolveFeatures(g, {});
  assert.strictEqual(v.source, "features");
  assert.strictEqual(v.f.holes.length, 1);
  assert.strictEqual(v.confidence.fields.holes, 1);
  assert.strictEqual(v.confidence.legacyFields.length, 0);
});

test("partial features (null fields) fall back per field and report 'mixed'", () => {
  const g = featured(block, { walls: null, holes: null });
  const v = resolveFeatures(g, {});
  assert.strictEqual(v.source, "mixed");
  assert.strictEqual(v.confidence.fields.walls, "legacy");
  assert.strictEqual(v.confidence.fields.holes, "legacy");
  assert.ok(v.confidence.legacyFields.includes("holes"));
});

test("garbage geometry still yields a usable view (no NaN)", () => {
  for (const g of [{}, { boundingBox: {}, volume: NaN }, { boundingBox: { width: 10, height: 10, depth: 10 }, volume: -5, surfaceArea: 0 }]) {
    const v = resolveFeatures(g, {});
    assert.ok(Number.isFinite(v.f.volume) && v.f.volume > 0 && Number.isFinite(v.f.surfaceArea) && v.f.surfaceArea > 0);
  }
});

console.log("CNC milling");

test("line item keeps the shared shape and carries costBuildup + confidence", () => {
  const p = price(plate);
  for (const k of ["material", "machining", "tooling", "setup", "finish", "subtotal", "discount", "margin", "final"]) assert.ok(Number.isFinite(p.perUnit[k]), k);
  assert.strictEqual(p.quantity, 10);
  assert.ok(Math.abs(p.lineTotal - p.perUnit.final * 10) < 1e-6);
  assert.strictEqual(p.weight.units, "kg");
  assert.strictEqual(p.meta.process, "cnc");
  assert.ok(Array.isArray(p.meta.costBuildup) && p.meta.costBuildup.length > 5);
  for (const s of p.meta.costBuildup) assert.ok(typeof s.step === "string" && Number.isFinite(s.minutes) && Number.isFinite(s.dollars) && typeof s.basis === "string");
  assert.strictEqual(p.meta.confidence.source, "legacy");
  assert.ok(Number.isFinite(p.meta.machineTimeHours) && p.meta.geometrySummary.volumeRatio > 0);
  // the build-up's dollars add up to the pre-discount subtotal
  const sum = p.meta.costBuildup.reduce((s, x) => s + x.dollars, 0);
  assert.ok(Math.abs(sum - p.perUnit.subtotal) < 0.05, `buildup ${sum} vs subtotal ${p.perUnit.subtotal}`);
});

test("unit price is non-increasing with quantity", () => {
  for (const g of [plate, block, tray, featured(block, { holes: [hole(5, 25, "tapped-candidate")] })]) {
    let prev = Infinity;
    for (const q of [1, 2, 5, 10, 25, 50, 100, 250]) {
      const u = price(g, { quantity: q }).perUnit.final;
      assert.ok(u <= prev + 1e-9, `rose at qty ${q}: ${prev} → ${u}`);
      prev = u;
    }
  }
});

test("more holes → more $; tapped holes cost more than plain; counterbores more again", () => {
  const none = price(featured(block)).perUnit.final;
  const four = price(featured(block, { holes: [hole(6, 25), hole(6, 25), hole(6, 25), hole(6, 25)] })).perUnit.final;
  const twenty = price(featured(block, { holes: Array.from({ length: 20 }, () => hole(6, 25)) })).perUnit.final;
  const tapped = price(featured(block, { holes: Array.from({ length: 4 }, () => hole(5, 25, "tapped-candidate")) })).perUnit.final;
  const cbore = price(featured(block, { holes: Array.from({ length: 4 }, () => hole(6, 25, "counterbored")) })).perUnit.final;
  assert.ok(none < four && four < twenty, `${none} < ${four} < ${twenty}`);
  assert.ok(tapped > four && cbore > four, `tapped ${tapped}, cbore ${cbore} > ${four}`);
});

test("deep holes peck (more $ than shallow of the same diameter); big holes are helically bored", () => {
  const shallow = price(featured(block, { holes: [hole(4, 8)] })).perUnit.final;
  const deep = price(featured(block, { holes: [hole(4, 24)] })).perUnit.final;
  assert.ok(deep > shallow);
  const bored = price(featured(block, { holes: [hole(30, 25)] }));
  assert.ok(bored.meta.costBuildup.find((s) => s.step === "holes").minutes > 0);
});

test("smaller pocket corner radius → more $; deeper pocket → more $", () => {
  const pk = (minCornerRadius, depthToWidthRatio = 0.5) => [{ area: 50 * 24, depth: 10, floorArea: 1200, openSides: 0, minCornerRadius, depthToWidthRatio, accessAxis: [0, 0, 1] }];
  const r6 = price(featured(block, { pockets: pk(6) })).perUnit.final;
  const r3 = price(featured(block, { pockets: pk(3) })).perUnit.final;
  const r1 = price(featured(block, { pockets: pk(1) })).perUnit.final;
  const deep = price(featured(block, { pockets: pk(6, 5) })).perUnit.final;
  assert.ok(r1 > r3 && r3 > r6, `${r1} > ${r3} > ${r6}`);
  assert.ok(deep > r6);
});

test("more setups → more $ (and a 4th-axis part uses 2 setups + the 4th-axis charge)", () => {
  const one = price(featured(block, { access: { directions: [[0, 0, 1]], minSetups3Axis: 1, undercutAreaFraction: 0 } }));
  const two = price(featured(block, { access: { directions: [], minSetups3Axis: 2, undercutAreaFraction: 0 } }));
  const four = price(featured(block, { access: { directions: [], minSetups3Axis: 4, undercutAreaFraction: 0 } }));
  assert.ok(two.perUnit.final > one.perUnit.final && four.perUnit.final > two.perUnit.final);
  assert.strictEqual(four.meta.fourthAxis, true);
  assert.strictEqual(four.meta.setups, 2);
  // a part too big for the 4th axis stays multi-setup
  const big = { boundingBox: { width: 400, height: 300, depth: 100 }, volume: 1.2e7, surfaceArea: 380000 };
  const bigFour = price(featured(big, { access: { directions: [], minSetups3Axis: 4, undercutAreaFraction: 0 } }));
  assert.strictEqual(bigFour.meta.fourthAxis, false);
  assert.strictEqual(bigFour.meta.setups, 4);
});

test("parts longer than the X travel get indexed setups", () => {
  const rail = { boundingBox: { width: 600, height: 25, depth: 12.7 }, volume: 600 * 25 * 12.7, surfaceArea: 2 * (600 * 25 + 600 * 12.7 + 25 * 12.7) };
  assert.ok(price(rail).meta.setups >= 2);
});

test("thinner walls → more $; tall thin walls → more again", () => {
  const thick = price(featured(block, { walls: { minThickness: 6, p05Thickness: 8, thinAreaFraction: 0, tallThinMaxAspect: 2 } })).perUnit.final;
  const thin = price(featured(block, { walls: { minThickness: 1.2, p05Thickness: 1.5, thinAreaFraction: 0.3, tallThinMaxAspect: 2 } })).perUnit.final;
  const tall = price(featured(block, { walls: { minThickness: 1.2, p05Thickness: 1.5, thinAreaFraction: 0.3, tallThinMaxAspect: 20 } })).perUnit.final;
  assert.ok(thin > thick && tall > thin, `${tall} > ${thin} > ${thick}`);
});

test("a pocketed tray costs more than the same plate without the pocket; more removal → more time", () => {
  const solid = { ...tray, volume: 200 * 150 * 19.05, surfaceArea: 2 * 200 * 150 + 2 * (200 + 150) * 19.05 };
  const a = price(solid), b = price(tray);
  assert.ok(b.perUnit.final > a.perUnit.final && b.meta.machineTimeHours > a.meta.machineTimeHours);
});

test("a feature-rich block prices above a plain block of the same stock, and a plate above a tiny clip", () => {
  const plain = price(featured(block)).perUnit.final;
  const rich = price(featured(block, { holes: Array.from({ length: 4 }, () => hole(5, 25, "tapped-candidate")), pockets: [{ area: 1200, depth: 10, floorArea: 1200, openSides: 0, minCornerRadius: 5, depthToWidthRatio: 0.4, accessAxis: [0, 0, 1] }] })).perUnit.final;
  assert.ok(rich > plain * 1.1, `${rich} vs ${plain}`);
  const clip = { boundingBox: { width: 20, height: 10, depth: 3 }, volume: 580, surfaceArea: 600 };
  assert.ok(price(plate).perUnit.final > price(clip).perUnit.final);
});

test("legacy block carries the unknown-feature allowance; a featured block does not", () => {
  const legacy = price(block);
  const feat = price(featured(block));
  assert.ok(legacy.meta.costBuildup.find((s) => s.step === "unknown-feature allowance"));
  assert.ok(!feat.meta.costBuildup.find((s) => s.step === "unknown-feature allowance"));
});

test("harder / dearer material costs more (6061 > Delrin on time, PEEK > Delrin on stock)", () => {
  const d = price(featured(block));
  const a = price(featured(block), { material: alu, grade: alu.grades[0].name });
  const p = price(featured(block), { material: peek, grade: peek.grades[0].name });
  assert.ok(a.meta.machineTimeHours > d.meta.machineTimeHours);
  assert.ok(p.perUnit.material > d.perUnit.material * 5 && p.perUnit.final > d.perUnit.final);
});

test("plate stock is bought at thickness (no Z padding); a block is padded all round", () => {
  const pl = price(plate).meta.geometrySummary;
  assert.strictEqual(pl.stockForm, "plate");
  assert.strictEqual(pl.stockMm.d, 6.35);
  const cube = price({ boundingBox: { width: 20, height: 20, depth: 20 }, volume: 8000, surfaceArea: 2400 }).meta.geometrySummary;
  assert.strictEqual(cube.stockForm, "block");
  assert.ok(cube.stockMm.d > 20);
});

test("floors: minimum part price holds; tiny parts never go below it; no NaN on degenerate input", () => {
  const tiny = price({ boundingBox: { width: 2, height: 2, depth: 1 }, volume: 4, surfaceArea: 16 }, { quantity: 1000 });
  assert.ok(tiny.perUnit.final >= R.minimumPartPrice - 1e-9);
  const weird = price({ boundingBox: { width: Infinity, height: 1, depth: 1 }, volume: Infinity, surfaceArea: NaN });
  assert.ok(Number.isFinite(weird.perUnit.final) && weird.perUnit.final >= R.minimumPartPrice);
});

test("tooling scales with machine time, not a flat per-piece floor", () => {
  const small = price({ boundingBox: { width: 12, height: 12, depth: 6 }, volume: 500, surfaceArea: 500 });
  const big = price(tray);
  assert.ok(big.perUnit.tooling > small.perUnit.tooling * 3);
});

console.log("CNC turning");

const turn = (geometry, over = {}) => calculate({ geometry, material: delrin, grade: delrin.grades[0].name, finish: null, quantity: 10, subProcess: "turning", ...over }, R);

test("turning a bushing is priced as turning (bar stock, lathe steps) and within 0.5–2× of milling it", () => {
  const t = turn(bushing), m = price(bushing);
  assert.strictEqual(t.meta.subProcess, "turning");
  assert.strictEqual(t.meta.geometrySummary.stockForm, "bar");
  assert.ok(t.meta.costBuildup.find((s) => s.step === "turn OD") && t.meta.costBuildup.find((s) => s.step === "drill bore"));
  const ratio = t.perUnit.final / m.perUnit.final;
  assert.ok(ratio > 0.5 && ratio < 2, `ratio ${ratio}`);
});

test("turning: longer part → more $; a bore costs more than solid; a Ø12 spacer is cheap in a batch", () => {
  const short = turn(bushing).perUnit.final;
  const long = turn({ ...bushing, boundingBox: { width: 40, height: 40, depth: 120 }, volume: bushing.volume * 4, surfaceArea: bushing.surfaceArea * 3 }).perUnit.final;
  const solid = turn({ ...bushing, volume: (Math.PI / 4) * 40 * 40 * 30 }).perUnit.final;
  assert.ok(long > short, `${long} > ${short}`);
  assert.ok(short > solid, `bored ${short} > solid ${solid}`);
  const spacer = turn({ boundingBox: { width: 12, height: 12, depth: 6 }, volume: (Math.PI / 4) * (144 - 42.25) * 6, surfaceArea: 500 }, { quantity: 25 });
  assert.ok(spacer.perUnit.final < 12 && spacer.perUnit.final >= R.minimumPartPrice, `spacer ${spacer.perUnit.final}`);
});

test("turning: per-piece time is well under the old 15-minute floor for a small bushing, and non-increasing with qty", () => {
  assert.ok(turn(bushing).meta.machineTimeHours * 60 < 12);
  let prev = Infinity;
  for (const q of [1, 5, 10, 25, 100]) { const u = turn(bushing, { quantity: q }).perUnit.final; assert.ok(u <= prev + 1e-9); prev = u; }
});

test("turning uses the next standard bar size and a bore-less part needs no drill", () => {
  const t = turn(bushing);
  assert.ok(t.meta.geometrySummary.stockMm.w >= 40 + 2 * R.latheBarPaddingMm);
  const solid = turn({ ...bushing, volume: (Math.PI / 4) * 40 * 40 * 30 });
  assert.ok(!solid.meta.costBuildup.find((s) => s.step === "drill bore"));
});

console.log(`\n${passed} checks passed`);
