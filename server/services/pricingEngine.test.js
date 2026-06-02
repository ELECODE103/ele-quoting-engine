/**
 * Standalone pricing-engine tests (no test framework required).
 * Run: `node server/services/pricingEngine.test.js`
 *
 * Focus: 3D-printing robustness & correctness guarantees.
 */
const assert = require("assert");
const { PricingEngine } = require("./pricingEngine");

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
const fdmMat = { slug: "pla", subProcess: "fdm", density: 1.24, pricePerCm3: 0.05, defaultLayerHeight: 0.2 };
const slaMat = { slug: "resin", subProcess: "sla", density: 1.1, pricePerCm3: 0.15, defaultLayerHeight: 0.05 };
const slsMat = { slug: "pa12", subProcess: "sls", density: 1.01, pricePerCm3: 0.25, defaultLayerHeight: 0.1 };

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

test("zero layer height cannot divide-by-zero (clamped)", () => {
  const p = engine.calculatePartPrice(base(slaMat, { layerHeight: 0 }));
  assert.ok(isMoney(p.perUnit.final) && isMoney(p.perUnit.machineTime), `mt=${p.perUnit.machineTime}`);
});

test("SLA cost rises with cross-sectional area (wide plate > thin pin of equal height)", () => {
  const pin = { volume: 800, boundingBox: { width: 4, height: 4, depth: 50 } };   // tall thin
  const plate = { volume: 800, boundingBox: { width: 80, height: 80, depth: 1.25 } }; // wide flat
  // Make heights comparable by using same depth so the area term dominates:
  const tall = { volume: 4000, boundingBox: { width: 4, height: 4, depth: 50 } };
  const wide = { volume: 4000, boundingBox: { width: 50, height: 50, depth: 50 } };
  const tallP = engine.calculatePartPrice(base(slaMat, { geometry: tall }));
  const wideP = engine.calculatePartPrice(base(slaMat, { geometry: wide }));
  assert.ok(wideP.perUnit.machineTime > tallP.perUnit.machineTime,
    `wide ${wideP.perUnit.machineTime} should exceed tall ${tallP.perUnit.machineTime}`);
});

test("quantity breaks: per-unit price is non-increasing with quantity", () => {
  const breaks = engine.quantityPriceBreaks(base(fdmMat));
  for (let i = 1; i < breaks.length; i++) {
    assert.ok(breaks[i].perUnit <= breaks[i - 1].perUnit + 1e-9,
      `perUnit rose at qty ${breaks[i].qty}: ${breaks[i].perUnit} > ${breaks[i - 1].perUnit}`);
  }
});

test("calculateOrderQuote throws on invalid pricing instead of persisting NaN", () => {
  // Force NaN by handing the engine a margin of 1.0 (divide-by-zero) via a custom rule set,
  // bypassing the per-call clamp by poisoning the volume with Infinity geometry.
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

test("order quote for normal multi-part FDM order is finite, includes breaks", () => {
  const q = engine.calculateOrderQuote({
    parts: [
      { ...base(fdmMat), partId: "a", fileName: "a.stl", quantity: 3 },
      { ...base(slsMat), partId: "b", fileName: "b.stl", quantity: 10 },
    ],
    leadTimeMultiplier: 1.5,
  });
  assert.ok(isMoney(q.orderTotal), `orderTotal=${q.orderTotal}`);
  assert.ok(Array.isArray(q.lineItems[0].quantityBreaks) && q.lineItems[0].quantityBreaks.length === 6);
});

test("SLS powder reuse lowers material cost vs. no-reuse, and reuse=0 ~ old 1/packing model", () => {
  const { DEFAULT_PRICING_RULES } = require("../config/defaults");
  const noReuse = new PricingEngine({ ...DEFAULT_PRICING_RULES, slsPowderReuseRatio: 0 });
  const halfReuse = new PricingEngine({ ...DEFAULT_PRICING_RULES, slsPowderReuseRatio: 0.5 });
  const m0 = noReuse.calculatePartPrice(base(slsMat)).perUnit.material;
  const m50 = halfReuse.calculatePartPrice(base(slsMat)).perUnit.material;
  assert.ok(m50 < m0, `reuse should reduce material cost (${m50} !< ${m0})`);
  // reuse=0 reproduces the old full 1/packing powder charge:
  const packing = DEFAULT_PRICING_RULES.slsPackingEfficiency;
  const partCm3 = 8000 / 1000;
  const expectedNoReuse = (partCm3 / packing) * slsMat.pricePerCm3;
  assert.ok(Math.abs(m0 - expectedNoReuse) < 1e-6, `reuse=0 material ${m0} != 1/packing ${expectedNoReuse}`);
});

console.log(`\n${passed} checks passed` + (process.exitCode ? " (with failures above)" : ""));
