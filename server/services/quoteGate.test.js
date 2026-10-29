/**
 * Quote gate tests. Run: `node server/services/quoteGate.test.js`
 */
const assert = require("assert");
const gate = require("./quoteGate");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}
const line = (over = {}) => ({ partId: "p1", quantity: 10, lineTotal: 500, meta: { process: "cnc" }, ...over });
const okDfm = { summary: { manufacturable: true }, checks: [] };

console.log("Quote gate");

test("ordinary quote goes straight to checkout", () => {
  const r = gate.evaluate([line()], { p1: okDfm });
  assert.strictEqual(r.requiresRfq, false);
  assert.strictEqual(r.reasons.length, 0);
});

test(`over ${gate.RFQ_QTY_THRESHOLD} pieces requires an RFQ`, () => {
  const r = gate.evaluate([line({ quantity: gate.RFQ_QTY_THRESHOLD + 1 })], { p1: okDfm });
  assert.strictEqual(r.requiresRfq, true);
  assert.strictEqual(r.reasons[0].code, "quantity");
});

test(`exactly ${gate.RFQ_QTY_THRESHOLD} pieces is still instant`, () => {
  const r = gate.evaluate([line({ quantity: gate.RFQ_QTY_THRESHOLD })], { p1: okDfm });
  assert.strictEqual(r.requiresRfq, false);
});

test("a hard DFM failure requires an RFQ", () => {
  const bad = { summary: { manufacturable: false }, checks: [{ id: "rt-bed-size", label: "Router Bed Size", severity: "fail" }] };
  const r = gate.evaluate([line({ meta: { process: "routing" } })], { p1: bad });
  assert.strictEqual(r.requiresRfq, true);
  assert.ok(r.reasons.some((x) => x.code === "dfm-fail"));
});

test("envelope warning (part bigger than the mill) requires an RFQ", () => {
  const d = { summary: { manufacturable: true }, checks: [{ id: "cnc-max-size", severity: "warn", detail: "too big" }] };
  const r = gate.evaluate([line()], { p1: d });
  assert.ok(r.reasons.some((x) => x.code === "envelope"));
});

test("low stock-to-part ratio on CNC flags for review", () => {
  const r = gate.evaluate([line({ meta: { process: "cnc", geometrySummary: { volumeRatio: 0.05 } } })], { p1: okDfm });
  assert.ok(r.reasons.some((x) => x.code === "complex-geometry"));
});

test("big-ticket line total flags for review", () => {
  const r = gate.evaluate([line({ lineTotal: gate.BIG_TICKET_LINE_TOTAL + 1 })], { p1: okDfm });
  assert.ok(r.reasons.some((x) => x.code === "big-ticket"));
});

test("missing DFM is tolerated (no throw)", () => {
  const r = gate.evaluate([line()], {});
  assert.strictEqual(r.requiresRfq, false);
});

test("Gate rules override the constants: quantity threshold, big ticket, hollow ratio", () => {
  const rules = { rfqQuantityThreshold: 20, bigTicketLineTotal: 300, lowVolumeRatio: 0.5 };
  const r = gate.evaluate([line({ quantity: 25, lineTotal: 400, meta: { process: "cnc", geometrySummary: { volumeRatio: 0.4 } } })], { p1: okDfm }, rules);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("quantity") && codes.includes("big-ticket") && codes.includes("complex-geometry"), codes.join(","));
  assert.strictEqual(r.threshold, 20);
  const ok = gate.evaluate([line({ quantity: 25, lineTotal: 400 })], { p1: okDfm }, {});
  assert.strictEqual(ok.requiresRfq, false, "defaults still apply when rules are empty");
});

test("a machined block priced from legacy geometry goes to review; a flat part does not; the rule can turn it off", () => {
  const block = (shape, source, volumeRatio = 0.9) => line({ meta: { process: "cnc", confidence: { source }, geometrySummary: { volumeRatio, shape } } });
  assert.ok(!gate.evaluate([block("prismatic", "legacy", 1.0)], { p1: okDfm }).reasons.some((x) => x.code === "legacy-features"), "a plain block has nothing hidden");
  assert.ok(gate.evaluate([block("prismatic", "legacy")], { p1: okDfm }).reasons.some((x) => x.code === "legacy-features"));
  assert.ok(!gate.evaluate([block("flat", "legacy")], { p1: okDfm }).reasons.some((x) => x.code === "legacy-features"));
  assert.ok(!gate.evaluate([block("prismatic", "features")], { p1: okDfm }).reasons.some((x) => x.code === "legacy-features"));
  assert.ok(!gate.evaluate([block("prismatic", "legacy")], { p1: okDfm }, { gateReviewOnLegacyFeatures: 0 }).reasons.some((x) => x.code === "legacy-features"));
});

test("walls under the review threshold flag thin-wall", () => {
  const thin = line({ meta: { process: "cnc", geometrySummary: { volumeRatio: 0.3, shape: "prismatic", minWallMm: 0.8 }, confidence: { source: "features" } } });
  assert.ok(gate.evaluate([thin], { p1: okDfm }).reasons.some((x) => x.code === "thin-wall"));
  assert.ok(!gate.evaluate([thin], { p1: okDfm }, { gateReviewThinWallMm: 0.5 }).reasons.some((x) => x.code === "thin-wall"));
});

console.log(`\n${passed} checks passed`);
