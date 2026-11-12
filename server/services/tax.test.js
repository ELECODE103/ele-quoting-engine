/**
 * Tax: the settings, what a declared exemption does, the Stripe parameters for a taxed order,
 * and reading the tax back from a paid session. Stripe is a stub: nothing leaves the machine.
 * Run: `node server/services/tax.test.js`
 */
const assert = require("assert");
const tax = require("./tax");
const schema = require("../config/ruleSchema");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const rules = (over = {}) => ({ ...schema.defaultRules(), ...over });
const ON = { taxMode: "stripe" };
const DECLARE = { ...ON, taxExemptDeclare: "on" };
const TRUST = { ...DECLARE, taxTrustDeclaredExemptions: "on" };

function stripeStub() {
  const customers = [];
  return { customers, stripe: { customers: { create: async (args) => { customers.push(args); return { id: `cus_test_${customers.length}` }; } } } };
}
const ORDER = { id: "o-1", taxMode: "stripe", shippingMethod: "standard", shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Columbus", shippingState: "Ohio", shippingZip: "43215", shippingCountry: "US", customerName: "Dana Buyer" };
const line = (name, cents) => ({ price_data: { currency: "usd", product_data: { name, description: "x" }, unit_amount: cents }, quantity: 1 });

test("default settings: tax is off and the pages say nothing about it", () => {
  const s = tax.settings(rules());
  assert.deepStrictEqual([s.mode, s.declare, s.trust, s.taxIds, s.productCode], ["off", false, false, false, ""]);
  const info = tax.publicInfo(rules());
  assert.deepStrictEqual(info, { mode: "off", note: "", poNote: "", exemption: { offered: false, trusted: false, reasons: [] } });
});

test("the exemption switches mean nothing while tax is off", () => {
  const s = tax.settings(rules({ taxExemptDeclare: "on", taxTrustDeclaredExemptions: "on", taxIdCollection: "on" }));
  assert.deepStrictEqual([s.mode, s.declare, s.trust, s.taxIds], ["off", false, false, false]);
  // "Trust" without "let buyers declare" is nothing either.
  assert.strictEqual(tax.settings(rules({ ...ON, taxTrustDeclaredExemptions: "on" })).trust, false);
});

test("with Stripe Tax on, the pages say tax is added at payment, and a PO is per invoice", () => {
  const info = tax.publicInfo(rules(ON));
  assert.strictEqual(info.mode, "stripe");
  assert.ok(/added on the secure payment page/.test(info.note));
  assert.ok(/per invoice/.test(info.poNote));
  assert.strictEqual(info.exemption.offered, false);
  const review = tax.publicInfo(rules(DECLARE)).exemption;
  assert.deepStrictEqual([review.offered, review.trusted, review.reasons.length], [true, false, 4]);
  assert.ok(/charged with tax today/.test(review.note) && /refund/.test(review.note));
  assert.ok(/no sales tax/.test(tax.publicInfo(rules(TRUST)).exemption.note));
  for (const text of [info.note, info.poNote, review.note]) assert.ok(!/\bI\b/.test(text) && /\bwe\b|your/i.test(text), "plain we voice");
});

test("a declared exemption: ignored unless the owner offers it; needs a reason and a certificate; untaxed only when trusted", () => {
  const declared = { declared: true, reason: "resale", hasCertificate: true };
  assert.deepStrictEqual(tax.exemptionFor(declared, rules()), { ok: true, declared: false, reason: "", status: "" }, "tax off: the flag does nothing");
  assert.deepStrictEqual(tax.exemptionFor(declared, rules(ON)), { ok: true, declared: false, reason: "", status: "" }, "not offered: the flag does nothing");
  assert.deepStrictEqual(tax.exemptionFor(declared, rules(DECLARE)), { ok: true, declared: true, reason: "resale", status: "taxed" });
  assert.deepStrictEqual(tax.exemptionFor(declared, rules(TRUST)), { ok: true, declared: true, reason: "resale", status: "untaxed" });
  // No certificate: refused in both modes (the box cannot be ticked on its word alone).
  for (const r of [DECLARE, TRUST]) {
    const none = tax.exemptionFor({ declared: true, reason: "resale", hasCertificate: false }, rules(r));
    assert.deepStrictEqual([none.ok, none.code], [false, "certificate-required"]);
  }
  assert.strictEqual(tax.exemptionFor({ declared: true, reason: "because", hasCertificate: true }, rules(TRUST)).code, "exemption-reason");
  assert.strictEqual(tax.exemptionFor({ declared: true, hasCertificate: true }, rules(TRUST)).code, "exemption-reason");
  // Not declared is not declared, whatever else is sent.
  for (const flag of [false, undefined, null, 0, "", "false", "no", [], {}]) {
    assert.strictEqual(tax.exemptionFor({ declared: flag, reason: "resale", hasCertificate: true }, rules(TRUST)).declared, false, JSON.stringify(flag));
  }
});

test("an order with tax off gets no Stripe parameters and no Stripe Customer", async () => {
  const { stripe, customers } = stripeStub();
  assert.strictEqual(await tax.stripeParams(stripe, { ...ORDER, taxMode: "off" }, "dana@buyer.test", rules(ON)), null);
  assert.strictEqual(await tax.stripeParams(stripe, { ...ORDER, taxMode: undefined }, "dana@buyer.test", rules(ON)), null, "an order from before the column existed");
  assert.strictEqual(customers.length, 0);
});

test("a taxed order: automatic_tax on, a Customer at the ship-to address, tax-exclusive lines", async () => {
  const { stripe, customers } = stripeStub();
  const p = await tax.stripeParams(stripe, ORDER, "dana@buyer.test", rules(ON));
  assert.deepStrictEqual(p.session, { customer: "cus_test_1", automatic_tax: { enabled: true } });
  assert.ok(!("customer_email" in p.session), "the Customer carries the email");
  const c = customers[0];
  assert.strictEqual(c.email, "dana@buyer.test");
  assert.deepStrictEqual(c.shipping.address, { line1: "100 Main St", city: "Columbus", state: "OH", postal_code: "43215", country: "US" });
  assert.strictEqual(c.tax_exempt, "none");
  assert.deepStrictEqual(c.tax, { validate_location: "immediately" });
  assert.strictEqual(c.metadata.orderId, "o-1");
  const goods = p.decorate(line("Order", 10000), "goods");
  assert.strictEqual(goods.price_data.tax_behavior, "exclusive");
  assert.strictEqual(goods.price_data.unit_amount, 10000, "amounts are not touched");
  assert.ok(!("tax_code" in goods.price_data.product_data), "no code pinned: Stripe's preset applies");
});

test("a pinned product code goes on every line; shipping can be sent as nontaxable; tax IDs only when asked for", async () => {
  const { stripe } = stripeStub();
  const p = await tax.stripeParams(stripe, ORDER, "d@b.test", rules({ ...ON, taxProductCode: "txcd_99999999", taxShipping: "nontaxable", taxIdCollection: "on" }));
  assert.strictEqual(p.decorate(line("Order", 1), "goods").price_data.product_data.tax_code, "txcd_99999999");
  assert.strictEqual(p.decorate(line("Paperwork", 1), "paperwork").price_data.product_data.tax_code, "txcd_99999999");
  assert.strictEqual(p.decorate(line("Shipping", 1), "shipping").price_data.product_data.tax_code, "txcd_00000000");
  assert.deepStrictEqual(p.session.tax_id_collection, { enabled: true });
  assert.deepStrictEqual(p.session.customer_update, { name: "auto" });
  const like = await tax.stripeParams(stripe, ORDER, "d@b.test", rules({ ...ON, taxProductCode: "txcd_99999999" }));
  assert.strictEqual(like.decorate(line("Shipping", 1), "shipping").price_data.product_data.tax_code, "txcd_99999999", "shipping taxed like the parts by default");
  // A code that is not a Stripe code (hand-edited database) is not sent.
  const junk = await tax.stripeParams(stripe, ORDER, "d@b.test", rules({ ...ON, taxProductCode: "anything" }));
  assert.ok(!("tax_code" in junk.decorate(line("Order", 1), "goods").price_data.product_data));
});

test("the Customer is marked exempt only for an order whose declaration was trusted", async () => {
  const { stripe, customers } = stripeStub();
  await tax.stripeParams(stripe, { ...ORDER, taxExempt: true, taxExemptStatus: "untaxed" }, "d@b.test", rules(TRUST));
  await tax.stripeParams(stripe, { ...ORDER, taxExempt: true, taxExemptStatus: "taxed" }, "d@b.test", rules(DECLARE));
  await tax.stripeParams(stripe, { ...ORDER, taxExempt: false, taxExemptStatus: "untaxed" }, "d@b.test", rules(TRUST));
  await tax.stripeParams(stripe, { ...ORDER, taxExempt: true, taxExemptStatus: "" }, "d@b.test", rules(TRUST));
  assert.deepStrictEqual(customers.map((c) => c.tax_exempt), ["exempt", "none", "none", "none"]);
});

test("a pickup order is taxed at the shop's city, state and ZIP, with no street line", async () => {
  const { stripe, customers } = stripeStub();
  await tax.stripeParams(stripe, { ...ORDER, shippingMethod: "pickup", shippingAddress: "", shippingCity: "", shippingState: "", shippingZip: "" }, "d@b.test", rules(ON));
  const a = customers[0].shipping.address;
  assert.deepStrictEqual(Object.keys(a).sort(), ["city", "country", "postal_code", "state"]);
  assert.strictEqual(a.state, "IL");
  assert.ok(!("line1" in a), "the street address is not sent anywhere before payment");
});

test("reading a paid session: the tax Stripe added, and the pre-tax, pre-discount amount", () => {
  const plain = tax.readSession({ amount_subtotal: 25924, amount_total: 25924 });
  assert.deepStrictEqual([plain.taxCents, plain.preTaxCents], [0, 25924], "a session from before tax existed reads as before");
  const taxed = tax.readSession({ amount_subtotal: 25924, amount_total: 27739, total_details: { amount_tax: 1815, amount_discount: 0, amount_shipping: 0 } });
  assert.deepStrictEqual([taxed.taxCents, taxed.preTaxCents], [1815, 25924]);
  const promo = tax.readSession({ amount_subtotal: 25924, amount_total: 24965, total_details: { amount_tax: 1633, amount_discount: 2592 } });
  assert.deepStrictEqual([promo.taxCents, promo.preTaxCents, promo.discountCents], [1633, 25924, 2592]);
  // No subtotal on the object: the tax and the discount are taken back out of the total.
  assert.strictEqual(tax.readSession({ amount_total: 24965, total_details: { amount_tax: 1633, amount_discount: 2592 } }).preTaxCents, 25924);
  assert.strictEqual(tax.readSession({}).preTaxCents, null);
  // Garbage tax figures do not become a negative or fractional tax.
  assert.strictEqual(tax.readSession({ amount_subtotal: 100, total_details: { amount_tax: -50 } }).taxCents, 0);
  assert.strictEqual(tax.readSession({ amount_subtotal: 100, total_details: { amount_tax: "abc" } }).taxCents, 0);
  assert.strictEqual(tax.readSession({ amount_subtotal: 100, customer_details: { tax_ids: [{ type: "ca_gst_hst", value: "123456789RT0002" }] } }).taxIds, "ca_gst_hst 123456789RT0002");
});

test("how an order's tax reads: nothing when off, the amount when charged, per invoice on a PO, exempt when trusted", () => {
  assert.strictEqual(tax.orderLine({ tax: 0 }), null, "an order from before: no tax line at all");
  assert.strictEqual(tax.orderLine({ tax: 0, taxMode: "off", status: "paid" }), null);
  assert.deepStrictEqual(tax.orderLine({ tax: 18.15, taxMode: "stripe", status: "paid" }), { label: "Sales tax", amount: 18.15, valueText: null });
  assert.strictEqual(tax.orderLine({ tax: 0, taxMode: "stripe", paymentMethod: "po", status: "pending_po" }).valueText, "Per invoice");
  assert.strictEqual(tax.orderLine({ tax: 0, taxMode: "stripe", taxExempt: true, taxExemptStatus: "untaxed", status: "paid" }).valueText, "Exempt (certificate on file)");
  assert.strictEqual(tax.orderLine({ tax: 0, taxMode: "stripe", status: "pending_payment" }).valueText, "Added at payment");
  assert.deepStrictEqual(tax.orderLine({ tax: 0, taxMode: "stripe", status: "paid" }), { label: "Sales tax", amount: 0, valueText: null }, "Stripe found no tax due: $0.00, said plainly");
  // Tax Stripe charged is shown even if our switch says off (Stripe's own default-on setting).
  assert.strictEqual(tax.orderLine({ tax: 3.2, taxMode: "off", status: "paid" }).amount, 3.2);
});

test("the shop is told what a declared exemption did", () => {
  assert.strictEqual(tax.exemptionLine({}), "");
  assert.ok(/NO tax/.test(tax.exemptionLine({ taxExempt: true, taxExemptReason: "resale", taxExemptStatus: "untaxed" })));
  const taxed = tax.exemptionLine({ taxExempt: true, taxExemptReason: "manufacturing", taxExemptStatus: "taxed" });
  assert.ok(/WITH tax/.test(taxed) && /refund/.test(taxed) && /^Manufacturing machinery/.test(taxed));
});

(async () => {
  console.log("Tax");
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`  ok   ${t.name}`); }
    catch (err) { console.error(`  FAIL ${t.name}\n       ${err.stack || err.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} checks passed`);
})();
