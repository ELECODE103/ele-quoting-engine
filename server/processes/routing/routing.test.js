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

const plate = {
  boundingBox: { width: 300, height: 200, depth: 12.7 },
  volume: 300 * 200 * 12.7 * 0.8, surfaceArea: 2 * 300 * 200 + 2 * (300 + 200) * 12.7,
  estimatedThickness: 12.7, flatWidth: 300, flatHeight: 200, flatArea: 300 * 200 * 0.8,
  estimatedPerimeter: 1000, estimatedHoles: 6, estimatedSlots: 1,
};
const hdpe = ROUTING_MATERIALS.find((m) => m.slug === "rt-hdpe");
const g10 = ROUTING_MATERIALS.find((m) => m.slug === "rt-g10");
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

test("longer cut path costs more", () => {
  const short = calculate({ ...base, quantity: 10 }, DEFAULT_PRICING_RULES).perUnit.final;
  const long = calculate({ ...base, geometry: { ...plate, estimatedPerimeter: 4000 }, quantity: 10 }, DEFAULT_PRICING_RULES).perUnit.final;
  assert.ok(long > short);
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
