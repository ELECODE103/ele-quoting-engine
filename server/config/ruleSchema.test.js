/**
 * Rule schema tests. Run: `node server/config/ruleSchema.test.js`
 */
const assert = require("assert");
const schema = require("./ruleSchema");
const { DEFAULT_PRICING_RULES } = require("./defaults");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

console.log("Pricing rule schema");

test("every rule has key, group, label, help, unit, type, min, max, default", () => {
  const groups = new Set(schema.GROUPS.map((g) => g.id));
  for (const r of schema.RULES) {
    for (const k of ["key", "group", "label", "help", "unit", "type", "min", "max", "default"]) assert.ok(k in r, `${r.key} missing ${k}`);
    assert.ok(groups.has(r.group), `${r.key} has unknown group ${r.group}`);
    assert.ok(["number", "percent", "currency", "table"].includes(r.type), `${r.key} type ${r.type}`);
    assert.ok(r.help.length > 10 && /[.]$/.test(r.help), `${r.key} help should be a sentence`);
    if (r.type !== "table") assert.ok(r.default >= r.min && r.default <= r.max, `${r.key} default outside range`);
    else assert.ok(r.tableSpec && ["map", "rows"].includes(r.tableSpec.kind), `${r.key} table needs a tableSpec`);
  }
});

test("rule keys are unique and the schema is JSON-serializable", () => {
  const keys = schema.RULES.map((r) => r.key);
  assert.strictEqual(new Set(keys).size, keys.length);
  const json = JSON.parse(JSON.stringify(schema.describeSchema()));
  assert.ok(json.groups.length === schema.GROUPS.length && json.materialFields.length > 0);
  assert.strictEqual(json.groups.reduce((n, g) => n + g.rules.length, 0), schema.RULES.length);
});

test("all nine required groups exist", () => {
  for (const g of ["shop", "materials", "cnc", "turning", "routing", "printing", "discounts", "gate"]) {
    assert.ok(schema.GROUPS.find((x) => x.id === g), `missing group ${g}`);
    assert.ok(schema.RULES.some((r) => r.group === g), `group ${g} has no rules`);
  }
});

test("DEFAULT_PRICING_RULES is the schema defaults (and a fresh copy)", () => {
  const d = schema.defaultRules();
  assert.deepStrictEqual(DEFAULT_PRICING_RULES, d);
  d.routerFeedMmPerMin.soft = 1;
  assert.notStrictEqual(DEFAULT_PRICING_RULES.routerFeedMmPerMin.soft, 1);
});

test("mergeRules lays stored values over defaults, clamps, ignores unknown keys, keeps seedVersion", () => {
  const m = schema.mergeRules({ marginPercent: 0.4, cncMachineRatePerHour: 99999, bogusKey: 7, seedVersion: 3, routerFeedMmPerMin: { soft: 3000 } });
  assert.strictEqual(m.marginPercent, 0.4);
  assert.strictEqual(m.cncMachineRatePerHour, 500);               // clamped to max
  assert.strictEqual(m.bogusKey, undefined);
  assert.strictEqual(m.seedVersion, 3);
  assert.strictEqual(m.routerFeedMmPerMin.soft, 3000);
  assert.strictEqual(m.routerFeedMmPerMin.medium, DEFAULT_PRICING_RULES.routerFeedMmPerMin.medium); // filled from default
  assert.strictEqual(Object.keys(m).filter((k) => k !== "seedVersion").length, schema.RULES.length);
});

test("mergeRules tolerates garbage input", () => {
  for (const bad of [null, undefined, 5, "x", { marginPercent: "abc", volumeDiscounts: "nope" }]) {
    const m = schema.mergeRules(bad);
    assert.strictEqual(m.marginPercent, DEFAULT_PRICING_RULES.marginPercent);
    assert.deepStrictEqual(m.volumeDiscounts, DEFAULT_PRICING_RULES.volumeDiscounts);
  }
});

test("sanitizeRules reports errors for bad values and sorts discount tiers", () => {
  const { rules, errors } = schema.sanitizeRules({ marginPercent: "0.25", latheRatePerHour: "lots", volumeDiscounts: [{ minQty: 10, discount: 0.1 }, { minQty: 1, discount: 0 }] });
  assert.strictEqual(rules.marginPercent, 0.25);
  assert.ok(errors.length === 1 && /latheRatePerHour/.test(errors[0]));
  assert.deepStrictEqual(rules.volumeDiscounts.map((t) => t.minQty), [1, 10]);
});

test("legacy keys that kept their meaning still exist (admin-tuned values carry over)", () => {
  for (const k of ["marginPercent", "minimumPartPrice", "routerMinimumPartPrice", "fdmMinimumPartPrice", "slaMinimumPartPrice", "slsMinimumPartPrice",
    "minimumOrderTotal", "volumeDiscounts", "nestingEfficiencyBonus", "shippingBaseRate", "shippingPerKg", "cncMachineRatePerHour", "routerMachineRatePerHour",
    "routerFeedMmPerMin", "routerKerfMarginMm", "routerNestYield", "routerToolWearPerMeter", "routerHoleSeconds", "routerToolChangeSeconds",
    "fdmInfillPercent", "slaLayerTimeSec", "slaScanTimeSecPerCm2", "slsLayerTimeSec", "slsScanTimeSecPerCm2", "slsPackingEfficiency", "slsPowderReuseRatio"]) {
    assert.ok(schema.RULE_BY_KEY[k], `missing ${k}`);
  }
});

console.log(`\n${passed} checks passed`);
