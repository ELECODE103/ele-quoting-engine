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

// (2026-11-13, re-review F-03.) This case used to assert "the formula never goes manual: an oversize
// sheet is priced as it always was, and has no destination rule". That was the finding: a 58 x 94 in
// sheet was sold with $25.63 of shipping to any address on earth. The formula now has the rate
// table's limits; inside them it charges what it always did.
test("the formula has the parcel limits too: over the longest side, over the parcel weight, not measurable, or outside the contiguous states is 'freight to be confirmed'; inside them the charge is the old expression", () => {
  const engine = new PricingEngine(rules());
  const d = schema.defaultRules();
  const quote = (geometry, qty, extra) => engine.calculateOrderQuote({ parts: [part(geometry, hdpeSheet, qty, extra)], leadTimeMultiplier: 1 });
  // 94 in long, 12 lb: over the longest side.
  const long = quote(block(2387.6, 1473.2, 1.6), 1, { thicknessMm: 1.6 });
  assert.deepStrictEqual([long.shipping.mode, long.shipping.manual, long.shipping.reasonCode, long.shippingEstimate], ["formula", true, "oversize", 0]);
  assert.ok(/94 in on its longest side, over the 48 in we ship by parcel/.test(long.shipping.reason), long.shipping.reason);
  // 48 x 48 x 1 in of HDPE: 80 lb, over the parcel weight.
  const heavy = quote(block(1219.2, 1219.2, 25.4), 1, { thicknessMm: 25.4 });
  assert.deepStrictEqual([heavy.shipping.manual, heavy.shipping.reasonCode], [true, "overweight"]);
  // Exactly at the longest side, and light: priced, by the expression the formula has always used.
  const ok = quote(block(1219.2, 1219.2, 1.6), 1, { thicknessMm: 1.6 });
  assert.strictEqual(ok.shipping.manual, false);
  assert.strictEqual(ok.shippingEstimate, d.shippingBaseRate + ok.totalWeight * d.shippingPerKg, "bit-for-bit the old expression");
  // The part prices are not touched by any of this.
  const withoutLimits = new PricingEngine(rules({ shippingOversizeLongestIn: 240, shippingMaxParcelLb: 2000 }));
  for (const [g, t] of [[block(2387.6, 1473.2, 1.6), 1.6], [block(1219.2, 1219.2, 25.4), 25.4], [block(1219.2, 1219.2, 1.6), 1.6]]) {
    const a = engine.calculateOrderQuote({ parts: [part(g, hdpeSheet, 1, { thicknessMm: t })], leadTimeMultiplier: 1 });
    const b = withoutLimits.calculateOrderQuote({ parts: [part(g, hdpeSheet, 1, { thicknessMm: t })], leadTimeMultiplier: 1 });
    assert.deepStrictEqual(a.lineItems.map((li) => [li.perUnit.final, li.lineTotal]), b.lineItems.map((li) => [li.perUnit.final, li.lineTotal]), "line prices are the same with and without the limits");
    assert.strictEqual(a.subtotal, b.subtotal);
  }
  // The limits are the admin's settings, the same two the rate table reads.
  const wide = new PricingEngine(rules({ shippingOversizeLongestIn: 100 })).calculateOrderQuote({ parts: [part(block(2387.6, 1473.2, 1.6), hdpeSheet, 1, { thicknessMm: 1.6 })], leadTimeMultiplier: 1 });
  assert.strictEqual(wide.shipping.manual, false);
  // Destination: the contiguous United States only, in the formula as in the table.
  const stored = shipping.storedFor({ shipping: ok.shipping, shippingEstimate: ok.shippingEstimate });
  assert.strictEqual(shipping.atDestination(stored, { country: "US", state: "IL" }, rules()).manual, false);
  for (const dest of [{ country: "CA", state: "ON" }, { country: "US", state: "HI" }, { country: "US", state: "AK" }, { country: "DE", state: "" }, { country: "US", state: "PR" }, { country: "zz!", state: "IL" }]) {
    const at = shipping.atDestination(stored, dest, rules());
    assert.deepStrictEqual([at.manual, at.reasonCode, at.amount], [true, "destination", 0], JSON.stringify(dest));
    assert.ok(/contiguous United States/.test(at.reason));
  }
  // A part that cannot be measured is not guessed at.
  const unknown = shipping.priceShipment({ v: null, subtotal: 100, formulaKg: 2 }, rules());
  assert.deepStrictEqual([unknown.manual, unknown.reasonCode], [true, "unknown-size"]);
});

test("the country is a two-letter code or nothing: what is stored on an order is never free text", () => {
  for (const [typed, code] of [[undefined, "US"], ["", "US"], ["us", "US"], [" USA ", "US"], ["United States", "US"], ["ca", "CA"], ["MX", "MX"], ["DE", "DE"]]) assert.strictEqual(shipping.countryCode(typed), code, String(typed));
  for (const typed of ["Germany", "U", "USAA", "C4", "<b>", "US;DROP", "🇺🇸", 12, {}]) assert.strictEqual(shipping.countryCode(typed), null, String(typed));
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
  // (2026-11-13: the formula is given a size and a packed weight like the other modes; with none it is "to be confirmed".)
  const small = { packedLb: 3, longestIn: 10, unknown: [] };
  const f = shipping.priceShipment({ v: small, subtotal: 300, formulaKg: 2 }, rules(free));
  assert.deepStrictEqual([f.amount, f.freeApplied], [0, true]);
  assert.strictEqual(shipping.priceShipment({ v: small, subtotal: 100, formulaKg: 2 }, rules(free)).amount, 12 + 2 * 2.5);
  assert.strictEqual(shipping.priceShipment({ v: { packedLb: 3, longestIn: 60, unknown: [] }, subtotal: 5000, formulaKg: 2 }, rules(free)).manual, true, "an oversize order is not free freight under the formula either");
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

// ─── From priced lines (what checkout calls) ─────────────────────
// shippingFor is a pure function of the priced lines, the settings and a lookup: no stored
// shipping amount goes in, so none can come out.
const pricedWith = (parts, r = rules()) => new PricingEngine(r).calculateOrderQuote({ parts, leadTimeMultiplier: 1 });
const lookupFor = (parts, materials = [delrin, pla, hdpeSheet]) => ({
  part: (id) => { const p = parts.find((x) => x.partId === id); return p ? { id, fileName: p.fileName, geometry: p.geometry } : null; },
  material: (slug) => materials.find((m) => m.slug === slug) || null,
});

test("shippingFor: from a priced quote's lines it gives exactly what the pricing engine gave, under the formula and under the table", () => {
  const parts = [part(block(100, 100, 50), delrin, 4, { partId: "a" }), part(block(60, 40, 20), delrin, 2, { partId: "b", fileName: "small.step" })];
  for (const r of [rules(), rules({ shippingMethod: "table" }), rules({ shippingMethod: "included" }), rules({ shippingMethod: "table", shippingFreeOverSubtotal: 1 })]) {
    const q = pricedWith(parts, r);
    const again = shipping.shippingFor(JSON.parse(JSON.stringify({ lineItems: q.lineItems, subtotal: q.subtotal })), r, lookupFor(parts));
    assert.deepStrictEqual(again, q.shipping, r.shippingMethod);
    assert.strictEqual(again.amount, q.shippingEstimate, "to the last bit, after a trip through JSON as a stored quote makes");
  }
});

test("shippingFor: the settings in force now decide, not the ones the quote was priced under", () => {
  const parts = [part(block(100, 100, 50), delrin, 4, { partId: "a" })];
  const q = pricedWith(parts, rules());
  const now = shipping.shippingFor(q, rules({ shippingMethod: "table", shippingRateTable: [{ maxLb: 50, price: 99 }] }), lookupFor(parts));
  assert.deepStrictEqual([now.mode, now.amount, now.manual], ["table", 99, false]);
  const dearer = shipping.shippingFor(q, rules({ shippingBaseRate: 20 }), lookupFor(parts));
  assert.strictEqual(dearer.amount, 20 + q.totalWeight * rules().shippingPerKg);
});

test("shippingFor: a line with no weight, a part that is gone or a material that is gone is never priced as weightless", () => {
  const parts = [part(block(100, 100, 50), delrin, 4, { partId: "a" })];
  const q = pricedWith(parts, rules());
  const noWeight = { lineItems: q.lineItems.map((li) => ({ ...li, weight: undefined })), subtotal: q.subtotal };
  for (const r of [rules(), rules({ shippingMethod: "table" }), rules({ shippingMethod: "included" })]) {
    const s = shipping.shippingFor(noWeight, r, lookupFor(parts));
    assert.deepStrictEqual([s.manual, s.reasonCode, s.amount], [true, "unknown-weight", 0], r.shippingMethod);
  }
  assert.strictEqual(shipping.shippingFor({ lineItems: [], subtotal: 0 }, rules(), lookupFor(parts)).manual, true, "no lines");
  const table = rules({ shippingMethod: "table" });
  assert.strictEqual(shipping.shippingFor(q, table, lookupFor([])).manual, true, "the part record is gone");
  assert.strictEqual(shipping.shippingFor(q, table, lookupFor(parts, [])).manual, true, "the material is gone");
  assert.strictEqual(shipping.shippingFor(q, table, {}).manual, true, "no lookup at all");
  // (2026-11-13, F-03.) Under the formula the charge is still worked out from the lines' own weights, and
  // it is the quote's own figure; but the size and the packed weight now decide whether there IS a charge,
  // so a part that is gone is "to be confirmed" here too.
  assert.strictEqual(shipping.shippingFor(q, rules(), lookupFor(parts)).amount, q.shippingEstimate);
  assert.deepStrictEqual([shipping.shippingFor(q, rules(), {}).manual, shipping.shippingFor(q, rules(), {}).reasonCode], [true, "unknown-size"]);
  // A page that only shows the line hands in what the quote was priced with, and no part is read.
  let read = 0;
  const counting = { part: (id) => { read++; return lookupFor(parts).part(id); }, material: (slug) => lookupFor(parts).material(slug) };
  const shown = shipping.shippingFor(q, rules(), counting, { measure: false, known: { packedLb: q.shipping.packedLb, longestIn: q.shipping.longestIn } });
  assert.deepStrictEqual([shown.amount, shown.manual, read], [q.shippingEstimate, false, 0]);
  const shownBig = shipping.shippingFor(q, rules(), counting, { measure: false, known: { packedLb: 12, longestIn: 94 } });
  assert.deepStrictEqual([shownBig.manual, shownBig.reasonCode, read], [true, "oversize", 0]);
  // A quote stored without them (older) is measured after all.
  const older = shipping.shippingFor(q, rules(), counting, { measure: false, known: { packedLb: null, longestIn: null } });
  assert.ok(older.amount === q.shippingEstimate && read > 0);
});

test("shippingFor: a DXF line is measured at the stock thickness the line was priced at", () => {
  const lines = [{ partId: "d", fileName: "plate.dxf", quantity: 3, weight: { total: 1.2 }, meta: { materialSlug: "rt-hdpe", grade: "", thicknessMm: 12.7 } }];
  const built = shipping.partsFromLines(lines, { part: () => ({ fileName: "plate.dxf", geometry: { any: 1 } }), material: () => hdpeSheet });
  assert.deepStrictEqual([built[0].thicknessMm, built[0].quantity, built[0].material.slug], [12.7, 3, "rt-hdpe"]);
  assert.strictEqual(shipping.partsFromLines(lines, { part: () => ({ payloadError: true, geometry: { volume: 1 } }), material: () => hdpeSheet })[0].geometry, null, "measurements that could not be read are unknown");
});

test("Stripe: shipping is its own line for the table, included and whenever tax is on; never more than the order has room for", () => {
  assert.strictEqual(shipping.stripeShippingCents({ shippingMode: "formula", shippingCost: 14.35 }, 20000), 0, "the formula with tax off stays inside the one line, as before");
  assert.strictEqual(shipping.stripeShippingCents({ shippingCost: 14.35 }, 20000), 0, "an order from before the setting existed");
  assert.strictEqual(shipping.stripeShippingCents({ shippingMode: "table", shippingCost: 16 }, 20000), 1600);
  assert.strictEqual(shipping.stripeShippingCents({ shippingMode: "formula", taxMode: "stripe", shippingCost: 14.35 }, 20000), 1435);
  assert.strictEqual(shipping.stripeShippingCents({ shippingMode: "table", shippingCost: 16 }, 900), 900);
  assert.strictEqual(shipping.stripeShippingCents({ shippingMode: "table", shippingCost: -5 }, 900), 0);
  assert.deepStrictEqual(shipping.stripeShippingLine({ packedWeightLb: 2.2 }), { name: "Shipping", description: "Ground, about 3 lb packed" });
});

console.log(`\n${passed} checks passed`);
