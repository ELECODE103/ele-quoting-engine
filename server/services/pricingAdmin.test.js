/**
 * Admin pricing console tests. Run: `node server/services/pricingAdmin.test.js`
 *
 *   1. schema validation — out-of-range, unknown keys, tables
 *   2. preview endpoint shape — 6 reference parts × lines × qty 1/10/100
 *   3. audit log round trip — save with note → history → restore → reset
 *   4. calibration — ratio summary and a conservative suggestion
 */
const assert = require("assert");
const schema = require("../config/ruleSchema");
const { createPricingAdmin } = require("./pricingAdmin");
const preview = require("./pricingPreview");
const calibration = require("./calibration");
const { DEFAULT_PRICING_RULES } = require("../config/defaults");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

/** Minimal in-memory stand-in for SqliteDB/JsonDB (same interface). */
function memDB() {
  const rows = [];
  let n = 0;
  return {
    getAll: () => rows.map((r) => JSON.parse(JSON.stringify(r))),
    getById: (id) => { const r = rows.find((x) => x.id === id); return r ? JSON.parse(JSON.stringify(r)) : null; },
    insert: (rec) => { const full = { id: `id-${++n}`, createdAt: new Date(Date.now() + n).toISOString(), ...rec }; rows.push(JSON.parse(JSON.stringify(full))); return JSON.parse(JSON.stringify(full)); },
    update: (id, up) => { const i = rows.findIndex((x) => x.id === id); if (i < 0) return null; rows[i] = { ...rows[i], ...JSON.parse(JSON.stringify(up)), updatedAt: new Date().toISOString() }; return JSON.parse(JSON.stringify(rows[i])); },
  };
}

console.log("Rule schema");

test("every DEFAULT_PRICING_RULES key is described and whitelisted", () => {
  const keys = new Set(schema.schemaKeys());
  for (const k of Object.keys(DEFAULT_PRICING_RULES)) assert.ok(keys.has(k), `missing ${k}`);
  for (const r of schema.RULE_SCHEMA) {
    assert.ok(r.label && r.help && r.group, `${r.key} needs label/help/group`);
    assert.ok(schema.RULE_GROUPS.some((g) => g.key === r.group), `${r.key} has unknown group ${r.group}`);
    assert.ok(/[.!]$/.test(r.help.trim()), `${r.key} help should be a sentence`);
  }
});

test("schema defaults equal the shipped defaults for every legacy key", () => {
  const d = schema.schemaDefaults();
  for (const [k, v] of Object.entries(DEFAULT_PRICING_RULES)) assert.deepStrictEqual(d[k], v, k);
});

test("accepts an in-range value and coerces strings to numbers", () => {
  const r = schema.validateRules({ cncMachineRatePerHour: "110" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.values.cncMachineRatePerHour, 110);
});

test("rejects an out-of-range value with the rule's label", () => {
  const r = schema.validateRules({ marginPercent: 1.5 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].key, "marginPercent");
  assert.ok(/Margin/.test(r.errors[0].message));
  assert.strictEqual(schema.validateRules({ cncSetupMinutesFirst: -1 }).ok, false);
});

test("rejects unknown keys (mass-assignment guard)", () => {
  const r = schema.validateRules({ __proto__x: 1, seedVersion: 9, marginPercent: 0.25 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.key === "seedVersion"));
  assert.strictEqual(r.values.marginPercent, 0.25, "valid keys are still returned");
});

test("rejects non-numeric and integer-typed rules", () => {
  assert.strictEqual(schema.validateRules({ cncFacingMrrCm3PerMin: "fast" }).ok, false);
  assert.strictEqual(schema.validateRules({ rfqQuantityThreshold: 10.5 }).ok, false);
  assert.strictEqual(schema.validateRules({ rfqQuantityThreshold: 50 }).ok, true);
});

test("map table: fills missing rows from defaults, rejects unknown rows and bad values", () => {
  const ok = schema.validateRules({ routerFeedMmPerMin: { soft: 3000 } });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.values.routerFeedMmPerMin.soft, 3000);
  assert.strictEqual(ok.values.routerFeedMmPerMin.medium, DEFAULT_PRICING_RULES.routerFeedMmPerMin.medium);
  assert.strictEqual(schema.validateRules({ routerFeedMmPerMin: { titanium: 100 } }).ok, false);
  assert.strictEqual(schema.validateRules({ routerFeedMmPerMin: { soft: 99999 } }).ok, false);
});

test("rows table: validates columns and ascending order", () => {
  const good = schema.validateRules({ volumeDiscounts: [{ minQty: 1, discount: 0 }, { minQty: 10, discount: 0.1 }] });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(schema.validateRules({ volumeDiscounts: [{ minQty: 10, discount: 0 }, { minQty: 5, discount: 0.1 }] }).ok, false);
  assert.strictEqual(schema.validateRules({ volumeDiscounts: [{ minQty: 1, discount: 0.95 }] }).ok, false);
  assert.strictEqual(schema.validateRules({ volumeDiscounts: "lots" }).ok, false);
});

test("partial=false reports missing keys", () => {
  const r = schema.validateRules({ marginPercent: 0.3 }, { partial: false });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length > 10);
});

console.log("Preview");

test("prices the 6 reference parts at qty 1/10/100 for every line, with baselines", () => {
  const saved = schema.schemaDefaults();
  const out = preview.run({ ...saved, cncMachineRatePerHour: 120 }, saved);
  assert.deepStrictEqual(out.quantities, [1, 10, 100]);
  assert.strictEqual(out.parts.length, 6);
  const processes = new Set();
  for (const part of out.parts) {
    assert.ok(part.name && part.bbox && part.volumeCm3 > 0, `${part.id} geometry parsed`);
    assert.ok(part.lines.length >= 2, `${part.id} has lines`);
    for (const line of part.lines) {
      processes.add(line.process);
      assert.ok(!line.error, `${part.id}/${line.materialSlug}: ${line.error}`);
      for (const q of [1, 10, 100]) {
        const at = line.at[q];
        assert.ok(at && Number.isFinite(at.unit) && at.unit > 0, `${part.id} ${line.process} q${q} unit`);
        assert.ok(Number.isFinite(at.baseUnit), "baseline unit present");
        assert.ok(Number.isFinite(at.minutes), "engine minutes present");
        if (line.process === "cnc" && line.subProcess === "milling") assert.ok(at.unit > at.baseUnit, "dearer mill rate → higher price");
        else if (line.process === "cnc") assert.strictEqual(at.unit, at.baseUnit, "turned parts run on the lathe rate, untouched");
        else assert.strictEqual(at.unit, at.baseUnit, "other processes untouched");
      }
      assert.ok(line.at[10].unit <= line.at[1].unit && line.at[100].unit <= line.at[10].unit, "price falls with qty");
    }
  }
  assert.deepStrictEqual([...processes].sort(), ["3d-printing", "cnc", "routing"]);
});

test("reference geometry is parsed once and cached", () => {
  const a = preview.loadReferenceGeometry();
  const b = preview.loadReferenceGeometry();
  assert.strictEqual(a, b);
  assert.ok(!a.bracket_block.meshData, "mesh preview data stripped");
});

console.log("Audit log");

test("save requires a note, validates, writes a diff and a snapshot", () => {
  const admin = createPricingAdmin({ pricingDB: memDB(), auditDB: memDB() });
  const noNote = admin.save({ marginPercent: 0.35 }, { user: { userId: "u1", email: "erik@example.com" } });
  assert.strictEqual(noNote.ok, false);
  assert.strictEqual(noNote.status, 400);

  const bad = admin.save({ marginPercent: 5 }, { note: "oops", user: { userId: "u1" } });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.errors[0].key, "marginPercent");

  const r = admin.save({ marginPercent: 0.35, routerFeedMmPerMin: { soft: 3000 } }, { note: "  Spring price bump  ", user: { userId: "u1", email: "erik@example.com" } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rules.marginPercent, 0.35);
  assert.strictEqual(r.rules.routerFeedMmPerMin.soft, 3000);
  assert.strictEqual(r.rules.routerFeedMmPerMin.medium, DEFAULT_PRICING_RULES.routerFeedMmPerMin.medium);
  assert.strictEqual(r.rules.cncSetupCost, DEFAULT_PRICING_RULES.cncSetupCost, "untouched rules keep their value");

  const h = admin.history();
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].note, "Spring price bump");
  assert.strictEqual(h[0].userEmail, "erik@example.com");
  assert.strictEqual(h[0].action, "save");
  assert.deepStrictEqual(h[0].changedKeys.sort(), ["marginPercent", "routerFeedMmPerMin"]);
  assert.deepStrictEqual(h[0].diff.marginPercent, { from: 0.3, to: 0.35 });
});

test("an unchanged save writes nothing to the log", () => {
  const admin = createPricingAdmin({ pricingDB: memDB(), auditDB: memDB() });
  const r = admin.save({ marginPercent: DEFAULT_PRICING_RULES.marginPercent }, { note: "no-op" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unchanged, true);
  assert.strictEqual(admin.history().length, 0);
});

test("stored blob keeps non-rule keys (seedVersion) across saves", () => {
  const pricingDB = memDB();
  pricingDB.insert({ rules: { ...DEFAULT_PRICING_RULES, seedVersion: 2 } });
  const admin = createPricingAdmin({ pricingDB, auditDB: memDB() });
  admin.save({ cncSetupMinutesFirst: 50 }, { note: "setup" });
  assert.strictEqual(pricingDB.getAll()[0].rules.seedVersion, 2);
  assert.strictEqual(pricingDB.getAll()[0].rules.cncSetupMinutesFirst, 50);
});

test("restore puts a previous snapshot back and logs it; reset returns to defaults", () => {
  const admin = createPricingAdmin({ pricingDB: memDB(), auditDB: memDB() });
  const first = admin.save({ cncMachineRatePerHour: 100 }, { note: "first" });
  admin.save({ cncMachineRatePerHour: 130, marginPercent: 0.4 }, { note: "second" });
  assert.strictEqual(admin.currentRules().cncMachineRatePerHour, 130);

  const restored = admin.restore(first.audit.id, { user: { userId: "u1" } });
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(admin.currentRules().cncMachineRatePerHour, 100);
  assert.strictEqual(admin.currentRules().marginPercent, 0.3, "restore brings back the whole snapshot");
  const h = admin.history();
  assert.strictEqual(h[0].action, "restore");
  assert.ok(/first/.test(h[0].note));
  assert.strictEqual(h.length, 3);

  assert.strictEqual(admin.restore("nope").status, 404);

  const reset = admin.reset({ user: { userId: "u1" } });
  assert.strictEqual(reset.ok, true);
  assert.deepStrictEqual(admin.currentRules().cncMachineRatePerHour, DEFAULT_PRICING_RULES.cncMachineRatePerHour);
  assert.strictEqual(admin.history()[0].action, "reset");
});

console.log("Calibration");

test("builds rows for completed orders only and computes ratios", () => {
  const orders = [
    { id: "o1", status: "shipped", createdAt: "2026-10-01T00:00:00Z", shippingName: "Acme" },
    { id: "o2", status: "pending_payment", createdAt: "2026-10-02T00:00:00Z" },
  ];
  const items = [
    { id: "i1", orderId: "o1", fileName: "a.stl", process: "cnc", quantity: 5, config: { process: "cnc", machineTimeHours: 0.5 }, actualMinutes: 45 },
    { id: "i2", orderId: "o1", fileName: "b.stl", process: "routing", quantity: 5, config: { process: "routing", cycleMinutes: 2 } },
    { id: "i3", orderId: "o2", fileName: "c.stl", process: "cnc", quantity: 1, config: { process: "cnc", machineTimeHours: 1 }, actualMinutes: 60 },
  ];
  const rows = calibration.buildRows(orders, items);
  assert.strictEqual(rows.length, 2);
  const cnc = rows.find((r) => r.itemId === "i1");
  assert.strictEqual(cnc.engineMinutes, 30);
  assert.strictEqual(cnc.ratio, 1.5);
  assert.strictEqual(rows.find((r) => r.itemId === "i2").ratio, null);
});

test("suggests a conservative, explained rate change once enough jobs are measured", () => {
  const rules = schema.schemaDefaults();
  const rows = [
    { process: "cnc", subProcess: "milling", engineMinutes: 30, actualMinutes: 42, ratio: 1.4 },
    { process: "cnc", subProcess: "milling", engineMinutes: 40, actualMinutes: 60, ratio: 1.5 },
    { process: "cnc", subProcess: "milling", engineMinutes: 20, actualMinutes: 26, ratio: 1.3 },
    { process: "routing", subProcess: "sheet", engineMinutes: 2, actualMinutes: 2, ratio: 1.0 },
  ];
  const s = calibration.summarize(rows, rules);
  const cnc = s.find((x) => x.process === "cnc");
  assert.strictEqual(cnc.measured, 3);
  assert.strictEqual(cnc.medianRatio, 1.4);
  assert.strictEqual(cnc.suggestion.kind, "adjust");
  assert.strictEqual(cnc.suggestion.key, "cncRoughingMrrCm3PerMin");
  // halfway toward 1.4 → every material class's removal rate ÷ 1.2 (plastic 13 → 11)
  const defaults = rules.cncRoughingMrrCm3PerMin;
  for (const [cls, v] of Object.entries(cnc.suggestion.suggested)) assert.strictEqual(v, Math.round(defaults[cls] / 1.2), `${cls} rate`);
  assert.ok(/1\.40×/.test(cnc.suggestion.text) && /halfway/.test(cnc.suggestion.text));
  const routing = s.find((x) => x.process === "routing");
  assert.strictEqual(routing.suggestion.kind, "wait");
});

test("floor-dominated CNC jobs point at the minimum machine time instead of the removal rate", () => {
  const rules = schema.schemaDefaults(); // cncMinMinutesPerCm2 0.01 min/cm²
  const rows = [1.6, 1.5, 1.7].map((ratio) => ({ process: "cnc", subProcess: "milling", engineMinutes: 15, actualMinutes: 15 * ratio, ratio, timeFloorApplied: true }));
  const s = calibration.summarize(rows, rules);
  assert.strictEqual(s[0].suggestion.key, "cncMinMinutesPerCm2");
  const floor = rules.cncMinMinutesPerCm2;
  assert.ok(s[0].suggestion.suggested > floor && s[0].suggestion.suggested < floor * 1.6);
});

console.log(`\n${passed} checks passed`);
