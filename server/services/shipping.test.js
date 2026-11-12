/**
 * Shipping: weights, the "we ship it" line under each setting, the oversize and unknown-weight
 * rules, the destination rule, carrier accounts and the admin preview.
 * Run: `node server/services/shipping.test.js`
 */
const assert = require("assert");
process.env.JWT_SECRET = process.env.JWT_SECRET || require("crypto").randomBytes(24).toString("hex");
const shipping = require("./shipping");
const schema = require("../config/ruleSchema");
const { PricingEngine } = require("./pricingEngine");
const { CNC_MATERIALS, PRINTING_MATERIALS, ROUTING_MATERIALS } = require("../config/defaults");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); process.exitCode = 1; }
}

const rules = (over = {}) => ({ ...schema.defaultRules(), ...over });
const delrin = CNC_MATERIALS.find((m) => m.slug === "cnc-delrin");
const pla = PRINTING_MATERIALS.find((m) => m.slug === "fdm-pla");
const hdpeSheet = ROUTING_MATERIALS.find((m) => m.slug === "rt-hdpe");
/** A solid block w × h × d mm. */
const block = (w, h, d) => ({ volume: w * h * d, surfaceArea: 2 * (w * h + w * d + h * d), boundingBox: { width: w, height: h, depth: d } });
const part = (geometry, material, quantity = 1, extra = {}) => ({ partId: "p", fileName: "block.step", geometry, material, grade: material.grades?.[0]?.name || "", quantity, process: material.process, ...extra });

console.log("Shipping");

// ─── Weight and size ────────────────────────────────────────────
test("packed weight = volume × the material's density × quantity, plus the packaging allowance", () => {
  // 100 × 100 × 50 mm of acetal at 0.051 lb/in³: 500 cm³ = 30.51 in³ → 1.556 lb each.
  const each = (500000 / 16387.064) * 0.051;
  const v = shipping.measure([part(block(100, 100, 50), delrin, 4)], rules());
  assert.ok(Math.abs(v.partsLb - each * 4) < 0.01, `parts ${v.partsLb} lb`);
  assert.ok(Math.abs(v.packedLb - (each * 4 * 1.10 + 1)) < 0.01, `packed ${v.packedLb} lb (10% + 1 lb)`);
  assert.strictEqual(v.pieces, 4);
  assert.deepStrictEqual(v.unknown, []);
  const heavier = shipping.measure([part(block(100, 100, 50), delrin, 4)], rules({ shippingPackagingPercent: 0.25, shippingPackagingLb: 3 }));
  assert.ok(Math.abs(heavier.packedLb - (each * 4 * 1.25 + 3)) < 0.01, "the allowance is the admin's");
});

test("printing materials weigh by their own g/cm³; two lines add up", () => {
  const v = shipping.measure([part(block(50, 50, 20), pla, 10), part(block(100, 100, 50), delrin, 1)], rules({ shippingPackagingPercent: 0, shippingPackagingLb: 0 }));
  const plaLb = (50 * 1.24 * 10) / 453.59237;
  const delrinLb = (500000 / 16387.064) * 0.051;
  assert.ok(Math.abs(v.partsLb - (plaLb + delrinLb)) < 0.01);
  assert.strictEqual(v.packedLb, v.partsLb);
});

test("longest side is the largest extent of any part, in inches", () => {
  const v = shipping.measure([part(block(100, 50, 10), delrin), part(block(1219.2, 300, 6.35), hdpeSheet)], rules());
  assert.strictEqual(v.longestIn, 48);
  const withObb = shipping.measure([part({ ...block(100, 100, 10), features: { obb: { w: 141.4, h: 20, d: 10 } } }, delrin)], rules());
  assert.ok(Math.abs(withObb.longestIn - 141.4 / 25.4) < 0.01, "a part lying diagonally in its box is as long as it really is");
});

test("a DXF weighs what its profile weighs at the thickness the buyer picked, and nothing without one", () => {
  const dxfGeometry = { is2D: true, sourceFormat: "dxf", boundingBox: { width: 200, height: 100, depth: 0 }, profile2d: { outer: [[0, 0], [200, 0], [200, 100], [0, 100]] } };
  const none = shipping.measure([part(dxfGeometry, hdpeSheet, 1)], rules());
  assert.strictEqual(none.packedLb, null, "no thickness, no weight");
  assert.ok(none.unknown.length > 0);
});

test("no density on the material, or no volume, is UNKNOWN: never zero, never a typical value", () => {
  const noDensity = { slug: "mystery", name: "Mystery", process: "cnc", grades: [{ name: "x" }] };
  const a = shipping.measure([part(block(100, 100, 50), noDensity)], rules());
  assert.strictEqual(a.partsLb, null);
  assert.strictEqual(a.packedLb, null);
  assert.ok(/density/.test(a.unknown.join(" ")));
  assert.strictEqual(shipping.densityGcm3(noDensity, "x"), null);
  assert.strictEqual(shipping.densityGcm3({ grades: [{ name: "x", density: 0 }], density: 0 }, "x"), null);
  assert.strictEqual(shipping.densityGcm3({ density: -3 }), null);
  assert.strictEqual(shipping.densityGcm3(null), null);
  for (const volume of [0, -5, NaN, undefined, null, "big"]) {
    const v = shipping.measure([part({ ...block(10, 10, 10), volume }, delrin)], rules());
    assert.strictEqual(v.packedLb, null, `volume ${volume}`);
  }
  // One unknown part makes the whole order unknown, however light the rest is.
  const mixed = shipping.measure([part(block(10, 10, 10), delrin), part(block(100, 100, 50), noDensity)], rules());
  assert.strictEqual(mixed.packedLb, null);
  const noSize = shipping.measure([part({ volume: 1000 }, delrin)], rules());
  assert.strictEqual(noSize.longestIn, null);
  assert.strictEqual(shipping.measure([], rules()).packedLb, null, "no parts is not a zero-pound order");
});

// ─── The default is the formula, to the last bit ────────────────
test("default settings: the shipping line is base + kg × rate, the same number the engine always produced", () => {
  const engine = new PricingEngine(rules());
  const q = engine.calculateOrderQuote({ parts: [part(block(100, 100, 50), delrin, 3)], leadTimeMultiplier: 1 });
  const d = schema.defaultRules();
  assert.strictEqual(q.shippingEstimate, d.shippingBaseRate + q.totalWeight * d.shippingPerKg, "bit-for-bit the old expression");
  assert.strictEqual(q.shipping.mode, "formula");
  assert.strictEqual(q.shipping.manual, false);
  assert.strictEqual(q.shipping.freeApplied, false);
  const cents = (n) => Math.round(n * 100) / 100;
  assert.strictEqual(q.orderTotal, cents(Math.max(q.subtotal + cents(q.leadTimeSurcharge) + cents(q.shippingEstimate), d.minimumOrderTotal)));
});

test("the formula never goes manual: an oversize sheet or a material with no density is priced as it always was", () => {
  const engine = new PricingEngine(rules());
  const big = engine.calculateOrderQuote({ parts: [part(block(2400, 1200, 12.7), hdpeSheet, 1, { thicknessMm: 12.7 })], leadTimeMultiplier: 1 });
  assert.strictEqual(big.shipping.manual, false);
  assert.ok(big.shippingEstimate > 12);
  assert.strictEqual(shipping.atDestination(shipping.storedFor({ shipping: big.shipping, shippingEstimate: big.shippingEstimate }), { country: "CA", state: "ON" }, rules()).manual, false, "and has no destination rule");
});

// ─── Rate table ─────────────────────────────────────────────────
const TABLE = { shippingMethod: "table", shippingRateTable: [{ maxLb: 1, price: 9 }, { maxLb: 5, price: 14.5 }, { maxLb: 20, price: 30 }, { maxLb: 50, price: 61 }] };
const priced = (packedLb, longestIn = 10, over = {}, subtotal = 100) => shipping.priceShipment({ v: { packedLb, longestIn, unknown: [] }, subtotal }, rules({ ...TABLE, ...over }));

test("rate table: the row the packed weight falls in, billed up to the next whole pound", () => {
  assert.strictEqual(priced(0.4).amount, 9);
  assert.strictEqual(priced(1).amount, 9, "exactly 1 lb is still the 1 lb row");
  assert.strictEqual(priced(1.01).amount, 14.5, "1.01 lb bills as 2 lb");
  assert.strictEqual(priced(5).amount, 14.5);
  assert.strictEqual(priced(5.2).amount, 30);
  assert.strictEqual(priced(49.6).amount, 61);
  assert.strictEqual(priced(3).mode, "table");
  assert.strictEqual(priced(3).manual, false);
});

test("rate table: past the heaviest row, past the parcel weight limit, or past the longest side → manual, with the reason in words", () => {
  const heavy = priced(50.5);
  assert.strictEqual(heavy.manual, true);
  assert.strictEqual(heavy.reasonCode, "overweight");
  assert.strictEqual(heavy.amount, 0);
  assert.ok(/51 lb/.test(heavy.reason) && /confirm freight/.test(heavy.reason));
  const overTable = priced(30, 10, { shippingRateTable: [{ maxLb: 20, price: 30 }] });
  assert.strictEqual(overTable.reasonCode, "over-table", "inside the parcel limit but past the last row");
  const long = priced(3, 48.5);
  assert.strictEqual(long.reasonCode, "oversize");
  assert.ok(/48\.5 in/.test(long.reason) && /48 in/.test(long.reason));
  assert.strictEqual(priced(3, 48).manual, false, "exactly at the limit ships");
  assert.strictEqual(priced(3, 60, { shippingOversizeLongestIn: 96 }).manual, false, "the limit is the admin's");
});

test("rate table: unknown weight or size → manual. An unknown weight is never the cheapest row", () => {
  for (const v of [{ packedLb: null, longestIn: 10 }, { packedLb: 0, longestIn: 10 }, { packedLb: NaN, longestIn: 10 }]) {
    const r = shipping.priceShipment({ v: { ...v, unknown: ["x"] }, subtotal: 100 }, rules(TABLE));
    assert.strictEqual(r.manual, true, JSON.stringify(v));
    assert.strictEqual(r.reasonCode, "unknown-weight");
  }
  assert.strictEqual(shipping.priceShipment({ v: { packedLb: 3, longestIn: null, unknown: ["x"] }, subtotal: 100 }, rules(TABLE)).reasonCode, "unknown-size");
  assert.strictEqual(shipping.priceShipment({ v: null, subtotal: 100 }, rules(TABLE)).manual, true);
  // Through the engine: a material with no density on a real quote.
  const engine = new PricingEngine(rules(TABLE));
  const q = engine.calculateOrderQuote({ parts: [part(block(100, 100, 50), { ...delrin, grades: [{ name: "Natural" }], density: undefined }, 1, { grade: "Natural" })], leadTimeMultiplier: 1 });
  assert.strictEqual(q.shipping.manual, true);
  assert.strictEqual(q.shippingEstimate, 0, "no amount is charged for a shipment nobody priced");
});

test("rate table: only the contiguous United States gets the price", () => {
  const stored = priced(3);
  const at = (country, state) => shipping.atDestination(stored, { country, state }, rules(TABLE));
  assert.strictEqual(at("US", "OH").manual, false);
  assert.strictEqual(at("US", "Ohio").manual, false, "a state typed in full");
  assert.strictEqual(at("US", " il ").manual, false);
  assert.strictEqual(at("", "IL").manual, false, "no country given reads as US, as the checkout form defaults");
  for (const [c, st] of [["US", "AK"], ["US", "HI"], ["US", "Hawaii"], ["US", "PR"], ["CA", "ON"], ["MX", "NL"], ["US", ""], ["US", "Narnia"], ["GB", "IL"]]) {
    const r = at(c, st);
    assert.strictEqual(r.manual, true, `${c}/${st}`);
    assert.strictEqual(r.reasonCode, "destination");
  }
});

// ─── Included, free over ────────────────────────────────────────
test("included: no shipping amount, but oversize and overweight still go to a person", () => {
  const inc = (packedLb, longestIn) => shipping.priceShipment({ v: { packedLb, longestIn, unknown: [] }, subtotal: 100 }, rules({ shippingMethod: "included" }));
  assert.deepStrictEqual([inc(3, 10).amount, inc(3, 10).manual, inc(3, 10).mode], [0, false, "included"]);
  assert.strictEqual(inc(3, 96).reasonCode, "oversize", "a 4 × 8 sheet is not shipped free by guesswork");
  assert.strictEqual(inc(80, 10).reasonCode, "overweight");
  assert.strictEqual(inc(null, 10).reasonCode, "unknown-weight");
});

test("free over a threshold: zero at or above it, charged below it, never for a manual order, off at 0", () => {
  const free = { shippingFreeOverSubtotal: 250 };
  assert.strictEqual(priced(3, 10, free, 249.99).amount, 14.5);
  assert.deepStrictEqual([priced(3, 10, free, 250).amount, priced(3, 10, free, 250).freeApplied], [0, true]);
  assert.strictEqual(priced(3, 60, free, 5000).manual, true, "an oversize order is not free freight");
  assert.strictEqual(priced(3, 10, { shippingFreeOverSubtotal: 0 }, 1e6).amount, 14.5, "0 is off");
  // The formula honours it too, once the owner sets it.
  const f = shipping.priceShipment({ v: null, subtotal: 300, formulaKg: 2 }, rules(free));
  assert.deepStrictEqual([f.amount, f.freeApplied], [0, true]);
  assert.strictEqual(shipping.priceShipment({ v: null, subtotal: 100, formulaKg: 2 }, rules(free)).amount, 12 + 2 * 2.5);
});

// ─── Stored quotes ──────────────────────────────────────────────
test("a quote saved before the shipping block existed reads as the formula with the amount it holds", () => {
  const old = shipping.storedFor({ shippingEstimate: 14.3478, subtotal: 100 });
  assert.deepStrictEqual([old.mode, old.amount, old.manual], ["formula", 14.35, false]);
  assert.strictEqual(shipping.storedFor({}).amount, 0);
  assert.strictEqual(shipping.storedFor({ shipping: "garbage", shippingEstimate: 5 }).mode, "formula");
  const manual = shipping.storedFor({ shipping: { mode: "table", manual: true, reasonCode: "oversize", reason: "too long", packedLb: null, longestIn: 60 }, shippingEstimate: 0 });
  assert.deepStrictEqual([manual.manual, manual.packedLb, manual.longestIn], [true, null, 60]);
});

// ─── Words ──────────────────────────────────────────────────────
test("what the buyer reads is true for the setting: an amount, included, free, or to be confirmed", () => {
  const say = (block, over = {}) => shipping.describe(block, rules({ ...TABLE, ...over }));
  assert.strictEqual(say(priced(3)).valueText, "$14.50");
  assert.ok(/about 3 lb/.test(say(priced(3)).note));
  assert.strictEqual(say(priced(3, 10, { shippingFreeOverSubtotal: 50 }), { shippingFreeOverSubtotal: 50 }).valueText, "Free");
  assert.strictEqual(say(priced(3, 60)).valueText, "To be confirmed");
  assert.strictEqual(shipping.describe({ mode: "included", manual: false, amount: 0 }, rules({ shippingMethod: "included" })).valueText, "Included");
  const formula = shipping.describe({ mode: "formula", manual: false, amount: 14.35 }, rules());
  assert.deepStrictEqual([formula.valueText, formula.note], ["$14.35", ""], "the default says nothing new");
  for (const b of [priced(3), priced(3, 60), priced(60)]) for (const text of Object.values(say(b))) assert.ok(!/\bI\b|\bmy shop\b/i.test(text), "we voice");
});

// ─── Carrier accounts ───────────────────────────────────────────
test("carrier account: carrier from a short list, 5 to 20 letters and digits, spaces and dashes dropped", () => {
  const ok = shipping.cleanCarrierAccount({ carrier: "ups", account: " a1b 2c3 ", service: "Ground" });
  assert.deepStrictEqual(ok, { ok: true, carrier: "UPS", account: "A1B2C3", last4: "B2C3", service: "Ground" });
  assert.strictEqual(shipping.cleanCarrierAccount({ carrier: "FedEx", account: "123-456-789" }).account, "123456789");
  for (const bad of [{ carrier: "DHL-ish", account: "123456" }, { carrier: "UPS", account: "12" }, { carrier: "UPS", account: "" }, { carrier: "UPS" }, { carrier: "UPS", account: 123456 }, { carrier: "UPS", account: "123456; DROP" }, { carrier: "UPS", account: "x".repeat(21) }, { carrier: "", account: "123456" }, { carrier: "UPS", account: ["123456"] }, {}]) {
    assert.strictEqual(shipping.cleanCarrierAccount(bad).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(shipping.cleanCarrierAccount({ carrier: "UPS", account: "123456", service: "<b>Next\nDay</b>" + "x".repeat(100) }).service.length, 60);
  assert.ok(!/[<>\n]/.test(shipping.cleanCarrierAccount({ carrier: "UPS", account: "123456", service: "<b>Next\nDay</b>" }).service));
});

test("the account number is sealed to its order: unreadable as stored, readable only with that order's id", () => {
  const sealed = shipping.sealAccount("A1B2C3", "order-1");
  assert.ok(!sealed.includes("A1B2C3"));
  assert.strictEqual(shipping.openAccount({ id: "order-1", shipAccountEnc: sealed }), "A1B2C3");
  assert.strictEqual(shipping.openAccount({ id: "order-2", shipAccountEnc: sealed }), null, "copied onto another order it does not open");
  assert.strictEqual(shipping.openAccount({ id: "order-1", shipAccountEnc: sealed.slice(0, -2) + "xx" }), null, "tampered");
  assert.strictEqual(shipping.openAccount({ id: "order-1" }), null);
  assert.notStrictEqual(shipping.sealAccount("A1B2C3", "order-1"), sealed, "a fresh seal each time");
  assert.strictEqual(shipping.maskAccount("B2C3"), "••••B2C3");
  assert.strictEqual(shipping.maskAccount(""), "");
  assert.strictEqual(shipping.methodLine({ shippingMethod: "carrier-account", shipCarrier: "UPS", shipAccountLast4: "B2C3", shipService: "Ground" }), "Ships on your UPS account ••••B2C3 (Ground)");
  assert.strictEqual(shipping.methodLine({ shippingMethod: "pickup" }), "Pickup at our shop");
  assert.strictEqual(shipping.methodLine({ shippingMethod: "standard" }), "");
});

// ─── Pickup address ─────────────────────────────────────────────
test("the pickup address comes from the server-side file; the tax locality carries no street line", () => {
  const where = shipping.pickupAddress();
  assert.ok(where.name && where.lines.length === 2 && /\d/.test(where.lines[0]));
  const loc = shipping.pickupLocality();
  assert.deepStrictEqual(Object.keys(loc).sort(), ["city", "country", "postal_code", "state"]);
  assert.ok(!JSON.stringify(loc).includes(where.lines[0]));
});

// ─── Admin preview ──────────────────────────────────────────────
test("the admin preview says what an example order would be charged, in a sentence, for each setting", () => {
  const p = (over, args) => shipping.preview(rules(over), args);
  const formula = p({}, { weightLb: 3, state: "OH" });
  assert.ok(/A 3 lb order .* shipped to OH would be charged \$15\.40 shipping/.test(formula.sentence), formula.sentence);
  const table = p(TABLE, { weightLb: 3, state: "Ohio", subtotal: 150 });
  assert.ok(/would be charged \$14\.50 shipping/.test(table.sentence) && /billed as 5 lb/.test(table.sentence), table.sentence);
  assert.strictEqual(table.amount, 14.5);
  assert.strictEqual(table.placeholderTable, false);
  assert.strictEqual(p({ shippingMethod: "table" }).placeholderTable, true, "the seed table is flagged until the owner changes it");
  assert.ok(/shipping is included/.test(p({ shippingMethod: "included" }).sentence));
  assert.ok(/would ship free/.test(p({ ...TABLE, shippingFreeOverSubtotal: 100 }, { subtotal: 150 }).sentence));
  const oversize = p(TABLE, { weightLb: 3, longestIn: 96 });
  assert.ok(oversize.manual && /firm quote/.test(oversize.sentence) && /confirm freight/.test(oversize.sentence));
  assert.ok(p(TABLE, { state: "HI" }).manual, "Hawaii is not on the parcel table");
  const extras = p({ ...TABLE, shippingCarrierAccount: "on", shippingLocalPickup: "on" }).extras;
  assert.strictEqual(extras.length, 2);
  assert.deepStrictEqual(p(TABLE).extras, []);
});

test("settings read defensively: junk in the stored rules is the default, not a crash", () => {
  const s = shipping.settings({ shippingMethod: "teleport", shippingRateTable: "no", shippingOversizeLongestIn: "x", shippingCarrierAccount: true, shippingLocalPickup: "yes" });
  assert.deepStrictEqual([s.mode, s.table, s.oversizeIn, s.carrierAccount, s.pickup], ["formula", [], 48, false, false]);
  assert.strictEqual(shipping.settings().mode, "formula");
});

console.log(`\n${passed} checks passed`);
