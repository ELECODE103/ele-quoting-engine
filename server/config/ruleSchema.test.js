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
    assert.ok(["number", "percent", "currency", "table", "choice", "text"].includes(r.type), `${r.key} type ${r.type}`);
    assert.ok(r.help.length > 10 && /[.]$/.test(r.help), `${r.key} help should be a sentence`);
    if (r.type === "choice") assert.ok(r.options.length >= 2 && r.options.some((o) => o.value === r.default) && r.options.every((o) => o.value && o.label), `${r.key} needs options and a default among them`);
    else if (r.type === "text") assert.ok(typeof r.default === "string" && new RegExp(r.pattern).test(r.default), `${r.key} default must match its pattern`);
    else if (r.type !== "table") assert.ok(r.default >= r.min && r.default <= r.max, `${r.key} default outside range`);
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

// ─── Shipping & tax settings (2026-11-11) ──────────────────────────────────
test("shipping and tax switches default to what the site did before they existed", () => {
  const d = schema.defaultRules();
  assert.strictEqual(d.shippingMethod, "formula", "shipping stays the weight formula");
  assert.strictEqual(d.shippingBaseRate, 12);
  assert.strictEqual(d.shippingPerKg, 2.5);
  assert.strictEqual(d.shippingFreeOverSubtotal, 0, "no free-shipping threshold");
  assert.strictEqual(d.shippingCarrierAccount, "off");
  assert.strictEqual(d.shippingLocalPickup, "off");
  assert.strictEqual(d.taxMode, "off", "no tax is collected");
  assert.strictEqual(d.taxExemptDeclare, "off");
  assert.strictEqual(d.taxTrustDeclaredExemptions, "off");
  assert.strictEqual(d.taxProductCode, "", "no tax code is pinned: Stripe's own preset applies");
});

test("the shipping and tax switches are in the Simple view, in their own group, in plain words", () => {
  const group = schema.RULE_GROUPS.find((g) => g.key === "checkout");
  assert.ok(group && /shipping/i.test(group.label) && /tax/i.test(group.label));
  for (const key of ["shippingMethod", "shippingCarrierAccount", "shippingLocalPickup", "taxMode", "taxExemptDeclare", "taxTrustDeclaredExemptions"]) {
    const d = schema.getDescriptor(key);
    assert.strictEqual(d.group, "checkout");
    assert.strictEqual(d.simple, true, `${key} is in the Simple view`);
    assert.ok(d.options.every((o) => !/[_{}]/.test(o.label)), `${key} options read as words`);
  }
  assert.ok(schema.getDescriptor("shippingMethod").options.find((o) => o.value === "formula").label.includes("as today"));
});

test("the rate table's seed numbers are marked as placeholders", () => {
  const d = schema.getDescriptor("shippingRateTable");
  assert.strictEqual(d.placeholder, true);
  assert.ok(/PLACEHOLDER/.test(d.help) && /your own/.test(d.help));
  assert.strictEqual(d.sortBy, "maxLb");
});

test("a choice takes one of its options and nothing else; a stored bad value falls back to the default", () => {
  assert.deepStrictEqual(schema.validateRules({ shippingMethod: "table" }).values, { shippingMethod: "table" });
  for (const bad of ["free", "", 1, true, null, ["table"], { value: "table" }, "TABLE", "table "]) {
    const r = schema.validateRules({ shippingMethod: bad });
    assert.strictEqual(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.strictEqual(schema.mergeRules({ shippingMethod: bad }).shippingMethod, "formula");
  }
  assert.strictEqual(schema.validateRules({ taxMode: "on" }).ok, false, "taxMode is off or stripe, not on");
  assert.strictEqual(schema.mergeRules({ taxMode: "stripe" }).taxMode, "stripe");
  assert.strictEqual(schema.mergeRules({ taxTrustDeclaredExemptions: "yes" }).taxTrustDeclaredExemptions, "off");
});

test("the tax code is empty or exactly a Stripe code; anything else is refused", () => {
  assert.strictEqual(schema.validateRules({ taxProductCode: "txcd_99999999" }).ok, true);
  assert.strictEqual(schema.validateRules({ taxProductCode: "" }).ok, true);
  assert.strictEqual(schema.validateRules({ taxProductCode: " txcd_99999999 " }).values.taxProductCode, "txcd_99999999");
  for (const bad of ["txcd_1", "general goods", "txcd_99999999; drop", 99999999, null, "TXCD_99999999"]) {
    assert.strictEqual(schema.validateRules({ taxProductCode: bad }).ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.strictEqual(schema.mergeRules({ taxProductCode: bad }).taxProductCode, "");
  }
});

test("the rate table: rows in rising weight, numbers in range, at least one row", () => {
  assert.strictEqual(schema.validateRules({ shippingRateTable: [{ maxLb: 2, price: 9 }, { maxLb: 10, price: 15 }] }).ok, true);
  assert.strictEqual(schema.validateRules({ shippingRateTable: [{ maxLb: 10, price: 15 }, { maxLb: 2, price: 9 }] }).ok, false, "out of order");
  assert.strictEqual(schema.validateRules({ shippingRateTable: [{ maxLb: 2, price: 9 }, { maxLb: 2, price: 12 }] }).ok, false, "duplicate band");
  assert.strictEqual(schema.validateRules({ shippingRateTable: [] }).ok, false, "empty");
  assert.strictEqual(schema.validateRules({ shippingRateTable: [{ maxLb: 2, price: -1 }] }).ok, false, "negative price");
  assert.strictEqual(schema.validateRules({ shippingRateTable: [{ maxLb: 2 }] }).ok, false, "missing price");
  // A stored table out of order is put in order, not thrown away.
  assert.deepStrictEqual(schema.mergeRules({ shippingRateTable: [{ maxLb: 10, price: 15 }, { maxLb: 2, price: 9 }] }).shippingRateTable.map((r) => r.maxLb), [2, 10]);
});

test("the new settings do not touch any existing rule's default", () => {
  // The values the engine priced with before 2026-11-11, spot-checked across groups.
  const d = schema.defaultRules();
  const before = { cncMachineRatePerHour: 110, marginPercent: 0.5, minimumOrderTotal: 25, shippingBaseRate: 12, shippingPerKg: 2.5, paperworkFeePerPart: 45, paperworkFeePerOrder: 15, routerSetupMinutes: 20, rfqQuantityThreshold: 100, bigTicketLineTotal: 5000, nestingEfficiencyBonus: 0.12 };
  for (const [k, v] of Object.entries(before)) assert.strictEqual(d[k], v, k);
  assert.deepStrictEqual(d.rushMultipliers, { standard: 1.0, expedited: 1.35, rush: 1.85, "same-day": 2.5 });
});

console.log(`\n${passed} checks passed`);
