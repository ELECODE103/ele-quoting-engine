/**
 * Process-registry tests. Run: `node server/processes/registry.test.js`
 * Proves: adding a process is a registry entry — pricing + DFM dispatch pick it
 * up with NO edits to the engine, parser, or routes.
 */
const assert = require("assert");
const registry = require("./registry");
const { PricingEngine } = require("../services/pricingEngine");
const { runDFMAnalysis } = require("../parsers/fileParser");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

const engine = new PricingEngine();
const geometry = {
  boundingBox: { width: 100, height: 60, depth: 2 },
  volume: 12000, surfaceArea: 13000, overhangFraction: 0.1,
  estimatedThickness: 2, flatWidth: 100, flatHeight: 60, flatArea: 6000,
  estimatedPerimeter: 320, estimatedBends: 1, estimatedHoles: 2, estimatedSlots: 0,
};
const material = {
  slug: "mild-steel", pricePerKg: 1.2,
  grades: [{ name: "A36", density: 0.284 }],
};

console.log("Process registry");

test("built-in processes are registered with behavior wiring", () => {
  assert.strictEqual(registry.activeProcesses().length >= 3, true);
  assert.strictEqual(registry.getProcess("3d-printing").priceMethod, "calculatePrintPrice");
  assert.strictEqual(registry.getProcess("cnc").dfmFn, "runCNCDFM");
});

test("unknown process resolves to a safe sheet-metal fallback (no throw)", () => {
  const def = registry.resolveProcess("does-not-exist");
  assert.strictEqual(def.priceMethod, "calculateSheetMetalPrice");
});

test("a NEW process registered at runtime flows through pricing dispatch", () => {
  // Add 'laser-cutting' reusing the sheet-metal pricing math — no engine edits.
  registry.defineProcess({
    slug: "laser-cutting", name: "Laser Cutting", active: true,
    priceMethod: "calculateSheetMetalPrice", dfmFn: "runSheetMetalDFM",
    defaultFinishSlug: "raw", previewSubProcess: undefined,
  });
  const price = engine.calculatePartPrice({
    process: "laser-cutting", geometry, material, grade: "A36", finish: null, quantity: 1,
    thicknessMm: 2,
  });
  assert.ok(Number.isFinite(price.perUnit.final) && price.perUnit.final > 0, `final=${price.perUnit.final}`);
});

test("the same NEW process flows through DFM dispatch", () => {
  const r = runDFMAnalysis(geometry, { process: "laser-cutting", thicknessMm: 2 });
  assert.ok(r.summary && typeof r.summary.score === "number");
  assert.ok(Array.isArray(r.checks) && r.checks.length > 0);
});

test("registry default-finish lookup matches the definition", () => {
  assert.strictEqual(registry.resolveProcess("3d-printing").defaultFinishSlug, "3dp-as-printed");
  assert.strictEqual(registry.resolveProcess("laser-cutting").defaultFinishSlug, "raw");
});

console.log(`\n${passed} checks passed` + (process.exitCode ? " (with failures above)" : ""));
