/**
 * Standalone DFM tests (no framework). Run: `node server/parsers/dfm.test.js`
 * Focus: two-tier severity (info/warn/fail), real overhang metric, no over-blocking.
 */
const assert = require("assert");
const { runPrintingDFM, runCNCDFM, runSheetMetalDFM } = require("./fileParser");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const sev = (r, id) => r.checks.find((c) => c.id === id)?.severity;

// A clean, healthy FDM part: 40mm cube, solid, minimal overhang, fits build volume.
const cleanCube = {
  boundingBox: { width: 40, height: 40, depth: 40 },
  volume: 64000, overhangFraction: 0.05, estimatedThickness: 40,
  estimatedBends: 0, estimatedHoles: 0, estimatedSlots: 0,
  flatWidth: 40, flatHeight: 40, flatArea: 1600,
};

console.log("DFM — two-tier severity");

test("clean FDM part is manufacturable, scores ~100, has zero blocking fails", () => {
  const r = runPrintingDFM(cleanCube, { subProcess: "fdm" });
  assert.strictEqual(r.summary.manufacturable, true);
  assert.strictEqual(r.summary.failCount, 0);
  assert.ok(r.summary.score >= 95, `score=${r.summary.score}`);
});

test("info checks are excluded from score (advisories don't lower a clean part)", () => {
  const r = runPrintingDFM(cleanCube, { subProcess: "fdm" });
  assert.ok(r.summary.infoCount > 0, "expected some advisory notes");
  assert.strictEqual(r.summary.score, 100, `score=${r.summary.score} should be 100 with only pass+info`);
});

test("exceeding build volume BLOCKS (fail) — the one legitimate gate", () => {
  const huge = { ...cleanCube, boundingBox: { width: 900, height: 40, depth: 40 } };
  const r = runPrintingDFM(huge, { subProcess: "fdm" });
  assert.strictEqual(sev(r, "print-build-volume"), "fail");
  assert.strictEqual(r.summary.manufacturable, false);
});

test("heavy overhang on FDM WARNS (not blocks) using the real overhang fraction", () => {
  const overhung = { ...cleanCube, overhangFraction: 0.6 };
  const r = runPrintingDFM(overhung, { subProcess: "fdm" });
  assert.strictEqual(sev(r, "print-overhang"), "warn");
  assert.strictEqual(r.summary.manufacturable, true);
});

test("same overhang on SLS is INFO (self-supporting), never warns", () => {
  const overhung = { ...cleanCube, overhangFraction: 0.6 };
  const r = runPrintingDFM(overhung, { subProcess: "sls" });
  assert.strictEqual(sev(r, "print-overhang"), "info");
});

test("thin wall WARNS, does not FAIL/block (proxy is unreliable)", () => {
  const thin = { ...cleanCube, estimatedThickness: 0.3 };
  const r = runPrintingDFM(thin, { subProcess: "fdm" });
  assert.strictEqual(sev(r, "print-min-wall"), "warn");
  assert.strictEqual(r.summary.manufacturable, true);
});

test("missing overhang metric degrades to INFO, not a crash", () => {
  const noMetric = { ...cleanCube, overhangFraction: undefined };
  const r = runPrintingDFM(noMetric, { subProcess: "fdm" });
  assert.strictEqual(sev(r, "print-overhang"), "info");
});

test("CNC always-on filler is INFO, not WARN", () => {
  const r = runCNCDFM(cleanCube, {});
  assert.strictEqual(sev(r, "cnc-corner-radius"), "info");
  assert.strictEqual(sev(r, "cnc-tool-access"), "info");
  assert.strictEqual(sev(r, "cnc-tolerance"), "info");
});

test("CNC low volume-ratio WARNS, never blocks", () => {
  const sparse = { ...cleanCube, volume: 6400 }; // 10% of bbox
  const r = runCNCDFM(sparse, {});
  assert.strictEqual(sev(r, "cnc-removal-efficiency"), "warn");
  assert.strictEqual(r.summary.manufacturable, true);
});

test("sheet-metal small part WARNS instead of blocking", () => {
  const small = { ...cleanCube, flatWidth: 2, flatHeight: 2, estimatedThickness: 1 };
  const r = runSheetMetalDFM(small, 1);
  assert.strictEqual(sev(r, "min-feature-size"), "warn");
  assert.strictEqual(r.summary.manufacturable, true);
});

console.log(`\n${passed} checks passed` + (process.exitCode ? " (with failures above)" : ""));
