/**
 * Standalone pricing-engine tests (no test framework required).
 * Run: `node server/services/pricingEngine.test.js`
 *
 * Focus: the PricingEngine public API (calculatePartPrice, calculateOrderQuote,
 * quantityPriceBreaks), 3D-printing robustness & correctness, and the
 * cross-process guarantees. Per-process detail lives in
 * processes/cnc/cnc.test.js and processes/routing/routing.test.js.
 */
const assert = require("assert");
const { PricingEngine } = require("./pricingEngine");
const { DEFAULT_PRICING_RULES } = require("../config/defaults");
const { mergeRules } = require("../config/ruleSchema");

const engine = new PricingEngine();
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

// ─── Fixtures ────────────────────────────────────────────────
const cube = { volume: 8000, boundingBox: { width: 20, height: 20, depth: 20 }, surfaceArea: 2400 }; // 20mm cube, 8 cm³
// open-top box 120 × 80 × 40, 2.5 mm walls, 3 mm floor
const housing = {
  volume: 120 * 80 * 40 - 115 * 75 * 37,
  boundingBox: { width: 120, height: 80, depth: 40 },
  surfaceArea: 2 * 120 * 80 + 2 * (120 + 80) * 40 + 2 * (115 + 75) * 37 + 115 * 75 - 115 * 75 + 2 * 115 * 75,
  overhangFraction: 0.05,
};
const fdmMat = { slug: "pla", subProcess: "fdm", density: 1.24, pricePerCm3: 0.05, defaultLayerHeight: 0.2 };
const slaMat = { slug: "resin", subProcess: "sla", density: 1.1, pricePerCm3: 0.15, defaultLayerHeight: 0.05 };
const slsMat = { slug: "pa12", subProcess: "sls", density: 1.01, pricePerCm3: 0.25, defaultLayerHeight: 0.1 };
const cncMat = { slug: "cnc-delrin", category: "Plastic", machinability: 1.3, pricePerKg: 11, grades: [{ name: "natural", density: 0.051 }], materialClass: "plastic", stockForms: ["plate", "rod"] };
const rtMat = { slug: "rt-hdpe", category: "Plastic", feedClass: "soft", pricePerKg: 5.5, grades: [{ name: "natural", density: 0.035 }], thicknesses: [{ mm: 6.35 }] };

const base = (material, extra = {}) => ({
  geometry: cube, material, finish: null, quantity: 1, process: "3d-printing", ...extra,
});
const isMoney = (n) => Number.isFinite(n) && n >= 0;

console.log("Pricing engine — 3D printing");

test("FDM quote is finite and >= per-process minimum ($8)", () => {
  const p = engine.calculatePartPrice(base(fdmMat));
  assert.ok(isMoney(p.perUnit.final), `final not money: ${p.perUnit.final}`);
  assert.ok(p.perUnit.final >= 8.0, `expected >= 8, got ${p.perUnit.final}`);
});

test("SLA & SLS quotes are finite and carry higher floors", () => {
  const sla = engine.calculatePartPrice(base(slaMat));
  const sls = engine.calculatePartPrice(base(slsMat));
  assert.ok(isMoney(sla.perUnit.final) && sla.perUnit.final >= 12.0, `sla=${sla.perUnit.final}`);
  assert.ok(isMoney(sls.perUnit.final) && sls.perUnit.final >= 15.0, `sls=${sls.perUnit.final}`);
});

test("unknown sub-process does NOT produce NaN (falls back to fdm model)", () => {
  const weird = engine.calculatePartPrice(base({ ...fdmMat, subProcess: "mjf-experimental" }));
  assert.ok(isMoney(weird.perUnit.final), `final=${weird.perUnit.final}`);
  assert.strictEqual(weird.meta.subProcess, "fdm");
});

test("negative signed volume is guarded (not used as a negative cost)", () => {
  const p = engine.calculatePartPrice(base(fdmMat, { geometry: { ...cube, volume: -8000 } }));
  assert.ok(isMoney(p.perUnit.material) && p.perUnit.material >= 0, `material=${p.perUnit.material}`);
  assert.ok(isMoney(p.perUnit.final));
});

test("zero / missing volume falls back to a bbox estimate (no NaN)", () => {
  for (const v of [0, undefined, null, NaN]) {
    const p = engine.calculatePartPrice(base(fdmMat, { geometry: { boundingBox: cube.boundingBox, volume: v } }));
    assert.ok(isMoney(p.perUnit.final), `volume=${v} → final=${p.perUnit.final}`);
  }
});

test("missing infill defaults to 20% (NOT 0%) — material cost reflects shells+infill", () => {
  const withDefault = engine.calculatePartPrice(base(fdmMat)); // infill undefined
  const explicit20 = engine.calculatePartPrice(base(fdmMat, { infill: 0.2 }));
  assert.ok(Math.abs(withDefault.perUnit.material - explicit20.perUnit.material) < 1e-9,
    `default ${withDefault.perUnit.material} != 20% ${explicit20.perUnit.material}`);
});

test("FDM: more infill → more material and time; shell term tracks surface area (thin-wall box ≈ all shell)", () => {
  const big = { volume: 125000, boundingBox: { width: 50, height: 50, depth: 50 }, surfaceArea: 15000 };
  const lo = engine.calculatePartPrice(base(fdmMat, { geometry: big, infill: 0.1 }));
  const hi = engine.calculatePartPrice(base(fdmMat, { geometry: big, infill: 0.6 }));
  assert.ok(hi.perUnit.material > lo.perUnit.material && hi.meta.printTimeHours > lo.meta.printTimeHours);
  const h = engine.calculatePartPrice(base(fdmMat, { geometry: housing }));
  const shell = h.meta.costBuildup.find((s) => s.step === "print shell");
  assert.ok(shell && h.meta.geometrySummary.materialCm3 > 0.85 * housing.volume / 1000, "thin-wall box should print almost entirely as shell");
  assert.ok(h.meta.printTimeHours > 3 && h.meta.printTimeHours < 8, `housing ${h.meta.printTimeHours} h`);
});

test("FDM: overhang needs supports (more $ than the same part with none)", () => {
  const flat = engine.calculatePartPrice(base(fdmMat, { geometry: { ...housing, overhangFraction: 0 } }));
  const over = engine.calculatePartPrice(base(fdmMat, { geometry: { ...housing, overhangFraction: 0.4 } }));
  assert.ok(over.perUnit.final > flat.perUnit.final && over.perUnit.support > 0);
});

test("zero layer height cannot divide-by-zero (clamped)", () => {
  const p = engine.calculatePartPrice(base(slaMat, { layerHeight: 0 }));
  assert.ok(isMoney(p.perUnit.final) && isMoney(p.perUnit.machineTime), `mt=${p.perUnit.machineTime}`);
});

test("SLA time uses the MEAN cross-section: a thin-wall box is not charged for its footprint", () => {
  const solidBox = { volume: 120 * 80 * 40, boundingBox: housing.boundingBox, surfaceArea: 2 * (120 * 80 + 120 * 40 + 80 * 40) };
  const solid = engine.calculatePartPrice(base(slaMat, { geometry: solidBox }));
  const hollow = engine.calculatePartPrice(base(slaMat, { geometry: housing }));
  assert.ok(hollow.meta.printTimeHours < solid.meta.printTimeHours, `hollow ${hollow.meta.printTimeHours} h should be < solid ${solid.meta.printTimeHours} h`);
  assert.ok(hollow.meta.printTimeHours < 6, `thin-wall housing on SLA ${hollow.meta.printTimeHours} h (was 34 h with the footprint proxy)`);
  // taller part of the same volume → more layers → more time
  const tall = engine.calculatePartPrice(base(slaMat, { geometry: { volume: 4000, boundingBox: { width: 50, height: 50, depth: 50 }, surfaceArea: 2000 } }));
  const short = engine.calculatePartPrice(base(slaMat, { geometry: { volume: 4000, boundingBox: { width: 50, height: 50, depth: 10 }, surfaceArea: 2000 } }));
  assert.ok(tall.meta.printTimeHours > short.meta.printTimeHours);
});

test("quantity breaks: per-unit price is non-increasing with quantity (every process)", () => {
  const parts = [
    base(fdmMat), base(slaMat), base(slsMat),
    { geometry: housing, material: cncMat, grade: "natural", finish: null, quantity: 1, process: "cnc", subProcess: "milling" },
    { geometry: { volume: 22800, boundingBox: { width: 40, height: 40, depth: 30 }, surfaceArea: 7700 }, material: cncMat, grade: "natural", finish: null, quantity: 1, process: "cnc", subProcess: "turning" },
    { geometry: { volume: 150 * 100 * 6.35, boundingBox: { width: 150, height: 100, depth: 6.35 }, surfaceArea: 33175 }, material: rtMat, grade: "natural", thicknessMm: 6.35, finish: null, quantity: 1, process: "routing" },
  ];
  for (const part of parts) {
    const breaks = engine.quantityPriceBreaks(part);
    assert.strictEqual(breaks.length, 6);
    for (let i = 1; i < breaks.length; i++) {
      assert.ok(breaks[i].perUnit <= breaks[i - 1].perUnit + 1e-9,
        `${part.process}: perUnit rose at qty ${breaks[i].qty}: ${breaks[i].perUnit} > ${breaks[i - 1].perUnit}`);
    }
  }
});

test("calculateOrderQuote throws on invalid pricing instead of persisting NaN", () => {
  const poisoned = base(fdmMat, { geometry: { boundingBox: { width: Infinity, height: 1, depth: 1 }, volume: Infinity } });
  let threwOrFinite = false;
  try {
    const q = engine.calculateOrderQuote({ parts: [{ ...poisoned, partId: "x", fileName: "x.stl" }] });
    threwOrFinite = Number.isFinite(q.orderTotal) && q.orderTotal >= 0; // guard clamps bbox → finite is also acceptable
  } catch (e) {
    threwOrFinite = true;
  }
  assert.ok(threwOrFinite, "order quote neither threw nor produced a finite total");
});

test("order quote for a mixed multi-process order is finite, includes breaks, shipping and lead-time surcharge", () => {
  const q = engine.calculateOrderQuote({
    parts: [
      { ...base(fdmMat), partId: "a", fileName: "a.stl", quantity: 3 },
      { ...base(slsMat), partId: "b", fileName: "b.stl", quantity: 10 },
      { geometry: housing, material: cncMat, grade: "natural", finish: null, quantity: 2, process: "cnc", subProcess: "milling", partId: "c", fileName: "c.step" },
    ],
    leadTimeMultiplier: 1.5,
  });
  assert.ok(isMoney(q.orderTotal), `orderTotal=${q.orderTotal}`);
  assert.ok(Array.isArray(q.lineItems[0].quantityBreaks) && q.lineItems[0].quantityBreaks.length === 6);
  assert.ok(Math.abs(q.leadTimeSurcharge - q.subtotal * 0.5) < 1e-6);
  assert.ok(Math.abs(q.shippingEstimate - (DEFAULT_PRICING_RULES.shippingBaseRate + q.totalWeight * DEFAULT_PRICING_RULES.shippingPerKg)) < 1e-6);
  assert.strictEqual(q.nestingApplied, true);
  for (const li of q.lineItems) {
    assert.ok(Array.isArray(li.meta.costBuildup) && li.meta.costBuildup.length > 0, `${li.partId} costBuildup`);
    assert.ok(li.meta.confidence && ["legacy", "mixed", "features"].includes(li.meta.confidence.source), `${li.partId} confidence`);
  }
});

test("SLS powder reuse lowers material cost vs. no-reuse, and reuse=0 ~ old 1/packing model", () => {
  const noReuse = new PricingEngine({ ...DEFAULT_PRICING_RULES, slsPowderReuseRatio: 0 });
  const halfReuse = new PricingEngine({ ...DEFAULT_PRICING_RULES, slsPowderReuseRatio: 0.5 });
  const m0 = noReuse.calculatePartPrice(base(slsMat)).perUnit.material;
  const m50 = halfReuse.calculatePartPrice(base(slsMat)).perUnit.material;
  assert.ok(m50 < m0, `reuse should reduce material cost (${m50} !< ${m0})`);
  const packing = DEFAULT_PRICING_RULES.slsPackingEfficiency;
  const partCm3 = 8000 / 1000;
  const expectedNoReuse = (partCm3 / packing) * slsMat.pricePerCm3;
  assert.ok(Math.abs(m0 - expectedNoReuse) < 1e-6, `reuse=0 material ${m0} != 1/packing ${expectedNoReuse}`);
});

console.log("Pricing engine — rules and cross-process guarantees");

test("engine runs on schema-merged rules from a stale stored blob (old keys ignored, new keys defaulted)", () => {
  const stale = { cncSetupCost: 45, cncMinimumMachineTime: 0.25, marginPercent: 0.35, seedVersion: 2 };
  const e = new PricingEngine(mergeRules(stale));
  const p = e.calculatePartPrice({ geometry: housing, material: cncMat, grade: "natural", finish: null, quantity: 5, process: "cnc" });
  assert.ok(isMoney(p.perUnit.final));
  const ref = new PricingEngine(mergeRules({ marginPercent: 0.30 })).calculatePartPrice({ geometry: housing, material: cncMat, grade: "natural", finish: null, quantity: 5, process: "cnc" });
  assert.ok(p.perUnit.final > ref.perUnit.final, "higher margin should raise the price");
});

test("the 15-minute floor is gone: a 20 mm cube and a 100 × 60 × 25 bracket no longer price the same", () => {
  const part = (geometry) => engine.calculatePartPrice({ geometry, material: cncMat, grade: "natural", finish: null, quantity: 10, process: "cnc" });
  const c = part(cube);
  const bracket = part({ volume: 100 * 60 * 25 - 50 * 24 * 10, boundingBox: { width: 100, height: 60, depth: 25 }, surfaceArea: 22800 });
  assert.ok(bracket.perUnit.final > c.perUnit.final * 1.3, `bracket ${bracket.perUnit.final} vs cube ${c.perUnit.final}`);
  assert.ok(c.meta.machineTimeHours * 60 < 10, `cube ${c.meta.machineTimeHours * 60} min`);
});

test("routing a flat plate is cheaper than milling it; SLA on the housing is cheaper than milling it", () => {
  const plate = { volume: 150 * 100 * 6.35, boundingBox: { width: 150, height: 100, depth: 6.35 }, surfaceArea: 2 * 150 * 100 + 2 * (150 + 100) * 6.35 };
  const rt = engine.calculatePartPrice({ geometry: plate, material: rtMat, grade: "natural", thicknessMm: 6.35, finish: null, quantity: 10, process: "routing" }).perUnit.final;
  const cnc = engine.calculatePartPrice({ geometry: plate, material: cncMat, grade: "natural", finish: null, quantity: 10, process: "cnc" }).perUnit.final;
  assert.ok(rt < cnc, `routing ${rt} < cnc ${cnc}`);
  const sla = engine.calculatePartPrice({ geometry: housing, material: slaMat, finish: null, quantity: 10, process: "3d-printing" }).perUnit.final;
  const mill = engine.calculatePartPrice({ geometry: housing, material: cncMat, grade: "natural", finish: null, quantity: 10, process: "cnc" }).perUnit.final;
  assert.ok(sla < mill, `sla ${sla} < cnc ${mill}`);
});

test("dearer material is dearer: PEEK ring > Delrin ring on the lathe", () => {
  const ring = { volume: (Math.PI / 4) * (3600 - 2025) * 8, boundingBox: { width: 60, height: 60, depth: 8 }, surfaceArea: 5000 };
  const peek = { ...cncMat, slug: "cnc-peek", machinability: 0.9, pricePerKg: 130, grades: [{ name: "natural", density: 0.047 }] };
  const d = engine.calculatePartPrice({ geometry: ring, material: cncMat, grade: "natural", finish: null, quantity: 10, process: "cnc", subProcess: "turning" }).perUnit.final;
  const p = engine.calculatePartPrice({ geometry: ring, material: peek, grade: "natural", finish: null, quantity: 10, process: "cnc", subProcess: "turning" }).perUnit.final;
  assert.ok(p > d);
});

test("a finish record adds its per-part + per-area cost on every process", () => {
  const finish = { slug: "deburr", name: "Deburr", pricePerPart: 2.5, pricePerSqIn: 0.004 };
  for (const part of [
    { geometry: housing, material: cncMat, grade: "natural", quantity: 10, process: "cnc" },
    { geometry: housing, material: fdmMat, quantity: 10, process: "3d-printing" },
    { geometry: { volume: 150 * 100 * 6.35, boundingBox: { width: 150, height: 100, depth: 6.35 }, surfaceArea: 33175 }, material: rtMat, grade: "natural", thicknessMm: 6.35, quantity: 10, process: "routing" },
  ]) {
    const raw = engine.calculatePartPrice({ ...part, finish: null });
    const fin = engine.calculatePartPrice({ ...part, finish });
    assert.ok(fin.perUnit.finish > 2.5 && fin.perUnit.final > raw.perUnit.final, `${part.process}`);
  }
});

console.log(`\n${passed} checks passed` + (process.exitCode ? " (with failures above)" : ""));
