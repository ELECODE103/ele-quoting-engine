/**
 * Shipping methods and sales tax at checkout, end to end against the real routes (Stripe
 * stubbed at the boundary, emails captured). Run: `node server/routes/taxShipping.test.js`
 *
 * What is proved here:
 *   - with every switch at its default, checkout is what it was before the switches existed:
 *     the same total, the same single Stripe line, no tax parameters, no new words;
 *   - each shipping setting (rate table, included, free over a threshold, the buyer's carrier
 *     account, pickup) charges what it says, shows it before the buyer commits and says it on
 *     the emails and documents; oversize, overweight and unknown-weight orders are never guessed;
 *   - Stripe Tax mode sends automatic_tax, stores the tax the payment reports and does not flag
 *     a taxed order as an amount mismatch; a purchase order's tax is "per invoice";
 *   - a declared exemption is charged without tax only when the owner trusts declarations;
 *   - nothing the browser sends can change an amount: method, weight, exemption flag, totals;
 *   - a carrier account number is sealed, masked everywhere but the admin's order view, and
 *     never reaches a log line or an email;
 *   - the pickup address is given only for a paid pickup order.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Shipping methods and sales tax");
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" };
const ACCOUNT = "A1B2C3D4";          // made up for the test: not a real carrier account
const TABLE = [{ maxLb: 1, price: 9 }, { maxLb: 5, price: 14.5 }, { maxLb: 20, price: 30 }, { maxLb: 50, price: 61 }];
const PDF = Buffer.from("%PDF-1.4\n%resale certificate (test)\n");
const cents = (n) => Math.round(n * 100) / 100;

(async () => {
  // This suite is about shipping and tax, on one buyer account: it makes more checkouts and more new
  // quotes in a few seconds than one account is allowed in an hour, and keeps more drafts than its
  // allowance. Those limits have their own suites (priceIntegrity, senderQuotas, pricingAvailability).
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  for (const k of ["QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY", "QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY"]) process.env[k] = "100000";
  for (const k of ["QUOTE_DRAFT_KB_PER_CLIENT", "QUOTE_DRAFT_KB_PER_ACCOUNT"]) process.env[k] = "100000";
  for (const k of ["QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR", "QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR"]) process.env[k] = "3600";
  const h = await start();
  const { quotesDB, ordersDB, orderItemsDB, rfqsDB, materialsDB } = h.models;
  const shipping = require("../services/shipping");
  const shipFrom = require("../config/shipFrom.json");
  const STREET = shipFrom.address; // the one string that must never reach a page, a log line or a pre-payment response
  let owner, buyer, partId;

  // Everything the server prints while a block runs, for the "never logged" checks.
  const printed = [];
  for (const level of ["log", "warn", "error", "info"]) {
    const real = console[level].bind(console);
    console[level] = (...args) => { printed.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); real(...args); };
  }

  const DEFAULTS = {
    shippingMethod: "formula", shippingRateTable: require("../config/ruleSchema").RULE_BY_KEY.shippingRateTable.default, shippingPackagingPercent: 0.10, shippingPackagingLb: 1,
    shippingOversizeLongestIn: 48, shippingMaxParcelLb: 50, shippingFreeOverSubtotal: 0, shippingCarrierAccount: "off", shippingLocalPickup: "off",
    taxMode: "off", taxProductCode: "", taxShipping: "goods", taxIdCollection: "off", taxExemptDeclare: "off", taxTrustDeclaredExemptions: "off", minimumOrderTotal: 25,
  };
  /** Set rules the way the owner does, in the pricing console. Everything not named goes back to its default. */
  async function settings(over = {}) {
    const r = await h.put("/api/admin/pricing", { rules: { ...DEFAULTS, ...over }, note: "test: shipping and tax settings" }, owner);
    assert.strictEqual(r.status, 200, r.text);
  }
  const price = (qty = 2, extra = {}, token = buyer) => h.post("/api/quote", { parts: [h.cncConfig(partId, qty)], leadTimeSlug: "standard", ...extra }, token);
  const checkout = (quoteId, body = {}, token = buyer) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...body }, token);
  const lastArgs = () => h.stripe.created[h.stripe.created.length - 1];
  const lastSession = () => h.stripe.sessions[`cs_test_${h.stripe.created.length}`];
  const sumLines = (args) => args.line_items.reduce((s, li) => s + li.price_data.unit_amount * (li.quantity || 1), 0);
  async function payByWebhook(session, over = {}) {
    h.pay(session.id, over);
    const res = await fetch(`${h.base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "checkout.session.completed", data: { object: session } }) });
    assert.strictEqual(res.status, 200);
  }
  const attach = (quoteId, file = { name: "resale-cert.pdf", data: PDF }, token = buyer) => h.form(`/api/quote/${quoteId}/tax-certificate`, {}, { certificate: file }, token);

  test("setup: the owner, a buyer and a part", async () => {
    owner = await h.admin("Owner");
    buyer = await h.register("dana@buyer.test", "Dana Buyer");
    partId = await h.uploadCube();
  });

  // ═══ 1. Defaults: nothing has changed ════════════════════════
  let baseline;
  test("defaults: the quote is priced by the weight formula and the pages are told nothing new", async () => {
    const q = await price(2);
    assert.strictEqual(q.status, 200, q.text);
    const d = require("../config/ruleSchema").defaultRules();
    assert.strictEqual(q.body.shippingEstimate, d.shippingBaseRate + q.body.totalWeight * d.shippingPerKg, "the old expression, to the last bit");
    assert.strictEqual(q.body.orderTotal, cents(Math.max(q.body.subtotal + cents(q.body.leadTimeSurcharge) + cents(q.body.shippingEstimate), d.minimumOrderTotal)));
    assert.strictEqual(q.body.shipping.mode, "formula");
    const c = q.body.checkout;
    assert.strictEqual(c.showOptions, false, "no delivery chooser");
    assert.deepStrictEqual(c.options.map((o) => o.method), ["ship"]);
    assert.strictEqual(c.options[0].total, q.body.orderTotal);
    assert.deepStrictEqual(c.tax, { mode: "off", note: "", poNote: "", exemption: { offered: false, trusted: false, reasons: [] } });
    assert.strictEqual(c.shipping.note, "");
    baseline = q.body;
  });

  test("defaults: Stripe is sent what any order without tax is sent: one line for the total, the buyer's email, no tax parameters", async () => {
    const before = h.stripe.customers.length;
    const c = await checkout(baseline.quoteId);
    assert.strictEqual(c.status, 200, c.text);
    const args = lastArgs();
    // The keys every session carries since the order-lifecycle work (expiry, the order id on the charge),
    // and nothing from this branch: no customer, no automatic_tax, no tax_id_collection.
    assert.deepStrictEqual(Object.keys(args).sort(), ["allow_promotion_codes", "cancel_url", "customer_email", "expires_at", "line_items", "metadata", "mode", "payment_intent_data", "payment_method_types", "success_url"]);
    assert.deepStrictEqual(args.line_items, [{ price_data: { currency: "usd", product_data: { name: "Straightedge Order — 1 part", description: "cube_20mm.stl" }, unit_amount: Math.round(baseline.orderTotal * 100) }, quantity: 1 }]);
    assert.strictEqual(args.customer_email, "dana@buyer.test");
    assert.strictEqual(h.stripe.customers.length, before, "no Stripe Customer is created");
    const order = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([order.shippingMethod, order.shippingMode, order.tax, order.taxMode, order.taxExempt, order.total], ["standard", "formula", 0, "off", false, baseline.orderTotal]);
    assert.strictEqual(order.shippingCost, cents(baseline.shippingEstimate));
    assert.ok(Math.abs(order.subtotal + order.leadTimeSurcharge + order.paperworkFee + order.shippingCost - order.total) < 0.01);
    assert.deepStrictEqual([order.shipCarrier, order.shipAccountEnc, order.taxCertPath], ["", "", ""]);
  });

  test("defaults: paid in full, the confirmation lists Shipping and says nothing about tax, pickup or carriers", async () => {
    const order = ordersDB.query((o) => o.quoteId === baseline.quoteId)[0];
    h.sent.length = 0;
    await payByWebhook(lastSession());
    const paid = ordersDB.getById(order.id);
    assert.deepStrictEqual([paid.status, paid.tax, paid.total], ["paid", 0, baseline.orderTotal]);
    const mail = h.sent.find((m) => m.to === "dana@buyer.test");
    assert.ok(/Shipping\s+\$/.test(mail.text));
    assert.ok(!/tax|pickup|pick up|carrier account|exempt/i.test(mail.text), "no new words in the default confirmation");
    assert.ok(/Ship to: Dana Buyer, 100 Main St, Columbus, OH 43215/.test(mail.text));
    const view = (await h.get(`/api/orders/${order.id}`, buyer)).body;
    assert.deepStrictEqual([view.taxLine, view.deliveryLine, view.pickupAddress, view.shipAccountMasked], [null, "", undefined, ""]);
    assert.ok(!("shipAccountEnc" in view) && !("taxCertPath" in view));
  });

  test("defaults: a delivery choice that is switched off is refused; amounts and flags in the request are ignored", async () => {
    const q = await price(3);
    for (const shippingOption of ["pickup", "carrier-account", "free", "", 7, null, ["ship"], { method: "pickup" }]) {
      const r = await checkout(q.body.quoteId, { shippingOption, carrier: "UPS", carrierAccount: ACCOUNT });
      if (shippingOption === null) { assert.strictEqual(r.status, 200, "no choice sent means we ship, as before"); ordersDB.delete(r.body.orderId); quotesDB.update(q.body.quoteId, { status: "draft" }); continue; }
      assert.strictEqual(r.status, 400, `${JSON.stringify(shippingOption)} → ${r.status}`);
      assert.strictEqual(r.body.code, "shipping-option");
    }
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 0, "a refused choice leaves no order");
    // Every number a browser could try to send, alongside a legitimate request.
    const c = await checkout(q.body.quoteId, { shippingCost: 0, shipping: 0, shippingEstimate: 0, total: 1, orderTotal: 1, subtotal: 1, tax: 0, packedWeightLb: 0.01, packedLb: 0.01, weight: 0, longestIn: 1, shippingMode: "included", shippingMethod: "pickup", taxMode: "off", taxExempt: true, taxExemptReason: "resale", taxExemptStatus: "untaxed", minimumOrderTotal: 0 });
    assert.strictEqual(c.status, 200, c.text);
    const order = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([order.total, order.shippingMethod, order.shippingMode, order.taxExempt, order.taxExemptStatus], [q.body.orderTotal, "standard", "formula", false, ""]);
    assert.strictEqual(sumLines(lastArgs()), Math.round(q.body.orderTotal * 100));
  });

  test("a quote saved before the shipping block existed checks out at its own total: shipping is worked out from its lines", async () => {
    const q = await price(4);
    require("../models/database").getDatabase().run("UPDATE quotes SET shipping_json = NULL WHERE id = ?", [q.body.quoteId]);
    assert.strictEqual(quotesDB.getById(q.body.quoteId).shipping, null);
    const view = (await h.get(`/api/quote/${q.body.quoteId}`, buyer)).body;
    assert.strictEqual(view.checkout.options[0].total, q.body.orderTotal);
    const c = await checkout(q.body.quoteId);
    assert.strictEqual(c.status, 200, c.text);
    const order = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([order.total, order.shippingCost, order.shippingMode], [q.body.orderTotal, cents(q.body.shippingEstimate), "formula"]);
    assert.strictEqual(lastArgs().line_items.length, 1, "and is sent to Stripe as the one line it always was");
  });

  test("the shipping amount stored on a quote is not the charge: it is worked out again at checkout from the lines", async () => {
    const q = await price(4);
    const real = cents(q.body.shippingEstimate);
    // Whatever the stored figure says (here: a cent, as if the row had been altered), the order is charged the computed one.
    quotesDB.update(q.body.quoteId, { shippingEstimate: 0.01, shipping: { mode: "formula", method: "ship", amount: 0.01, manual: false } });
    const view = (await h.get(`/api/quote/${q.body.quoteId}`, buyer)).body;
    assert.strictEqual(view.checkout.options[0].shippingCost, real);
    const c = await checkout(q.body.quoteId);
    assert.strictEqual(c.status, 200, c.text);
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.shippingCost, real);
    assert.strictEqual(order.total, q.body.orderTotal);
    assert.strictEqual(sumLines(lastArgs()), Math.round(q.body.orderTotal * 100));
  });

  test("a stored line with no weight is never shipped for the base rate alone: checkout works shipping out from the lines as it prices them again", async () => {
    // (Before the checkout re-pricing existed this order was refused as "shipping-manual": the stored
    // lines were all checkout had. Now every checkout prices the saved configuration again and shipping
    // is worked out from THOSE lines, so a weight missing from the stored row cannot lower the charge.
    // The rule itself, a line without a weight is never zero pounds, is in services/shipping.test.js.)
    const q = await price(2);
    const stored = quotesDB.getById(q.body.quoteId);
    quotesDB.update(q.body.quoteId, { lineItems: stored.lineItems.map((li) => ({ ...li, weight: undefined })) });
    const c = await checkout(q.body.quoteId);
    assert.strictEqual(c.status, 200, c.text);
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.total, q.body.orderTotal, "the full total, with the shipping the weight calls for");
    assert.strictEqual(order.shippingCost, cents(q.body.shippingEstimate));
    assert.strictEqual(sumLines(lastArgs()), Math.round(q.body.orderTotal * 100));
  });

  test("the owner changes how shipping is charged after a quote was priced: the checkout page and the charge follow the settings as they are now", async () => {
    const q = await price(2); // priced under the weight formula
    await settings({ shippingMethod: "table", shippingRateTable: [{ maxLb: 50, price: 99 }] });
    const view = (await h.get(`/api/quote/${q.body.quoteId}`, buyer)).body;
    const expected = cents(q.body.subtotal + cents(q.body.leadTimeSurcharge) + 99);
    assert.deepStrictEqual([view.checkout.shipping.mode, view.checkout.options[0].shippingCost, view.checkout.options[0].total], ["table", 99, expected]);
    const c = await checkout(q.body.quoteId);
    assert.strictEqual(c.status, 200, c.text);
    const order = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([order.shippingCost, order.shippingMode, order.total], [99, "table", expected]);
    const args = lastArgs();
    assert.strictEqual(sumLines(args), Math.round(expected * 100), "Stripe is asked for what the page showed");
    assert.strictEqual(args.line_items[args.line_items.length - 1].price_data.unit_amount, 9900, "with shipping as its own line");
    await settings();
  });

  // ═══ 2. Rate table ═══════════════════════════════════════════
  test("rate table: the quote carries the row for the packed weight, and the summary says how it was arrived at", async () => {
    await settings({ shippingMethod: "table", shippingRateTable: TABLE });
    const q = await price(2);
    const b = q.body;
    assert.deepStrictEqual([b.shipping.mode, b.shipping.manual], ["table", false]);
    // Two 20 mm cubes weigh ounces: with the 10% + 1 lb allowance they pack to just over a pound and bill as 2 lb.
    assert.ok(b.shipping.packedLb > 1 && b.shipping.packedLb < 1.2, `packed ${b.shipping.packedLb} lb`);
    assert.strictEqual(b.shippingEstimate, 14.5, "the 'up to 5 lb' row");
    assert.strictEqual(b.orderTotal, cents(Math.max(b.subtotal + cents(b.leadTimeSurcharge) + 14.5, 25)));
    assert.strictEqual(b.checkout.shipping.valueText, "$14.50");
    assert.ok(/packed weight \(about 2 lb\)/.test(b.checkout.shipping.note));
    assert.strictEqual(b.gate.requiresRfq, false);
  });

  test("rate table: shipping is computed on the server and is its own Stripe line; the lines add up to the total", async () => {
    const q = await price(2);
    const c = await checkout(q.body.quoteId, { packedWeightLb: 0.1, shippingCost: 1 });
    assert.strictEqual(c.status, 200, c.text);
    const args = lastArgs();
    assert.strictEqual(args.line_items.length, 2);
    assert.deepStrictEqual([args.line_items[1].price_data.product_data.name, args.line_items[1].price_data.unit_amount], ["Shipping", 1450]);
    assert.strictEqual(sumLines(args), Math.round(q.body.orderTotal * 100));
    const order = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([order.shippingCost, order.shippingMode, order.total], [14.5, "table", q.body.orderTotal]);
    assert.ok(order.packedWeightLb > 1);
    h.sent.length = 0;
    await payByWebhook(lastSession());
    assert.strictEqual(ordersDB.getById(order.id).status, "paid", "two lines paid in full is a clean paid order");
    const mail = h.sent.find((m) => m.to === "dana@buyer.test");
    assert.ok(/Shipping\s+\$14\.50/.test(mail.text));
  });

  test("rate table: when the owner changes the table, an open quote is charged the table as it is now", async () => {
    const q = await price(2);
    assert.strictEqual(q.body.shippingEstimate, 14.5);
    await settings({ shippingMethod: "table", shippingRateTable: [{ maxLb: 50, price: 99 }] });
    const c = await checkout(q.body.quoteId);
    assert.strictEqual(ordersDB.getById(c.body.orderId).shippingCost, 99);
    assert.strictEqual((await price(2)).body.shippingEstimate, 99, "and so is a new quote");
    await settings({ shippingMethod: "table", shippingRateTable: TABLE });
  });

  test("rate table: an address outside the contiguous United States is not given the parcel price", async () => {
    const q = await price(2);
    for (const where of [{ shippingState: "AK" }, { shippingState: "Hawaii" }, { shippingCountry: "CA", shippingState: "ON" }, { shippingCountry: "MX", shippingState: "NL" }]) {
      const r = await checkout(q.body.quoteId, where);
      assert.strictEqual(r.status, 409, JSON.stringify(where));
      assert.strictEqual(r.body.code, "shipping-manual");
      assert.ok(/contiguous United States/.test(r.body.error) && /firm quote/.test(r.body.error));
    }
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 0);
    assert.strictEqual(quotesDB.getById(q.body.quoteId).status, "draft", "the quote can still be bought for an address we do ship to");
    assert.strictEqual((await checkout(q.body.quoteId, { shippingState: "Illinois" })).status, 200);
  });

  test("rate table: an order over the parcel weight limit is not priced: it goes to a firm quote, with the reason", async () => {
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, shippingMaxParcelLb: 1 });
    const q = await price(2);
    assert.deepStrictEqual([q.body.shipping.manual, q.body.shipping.reasonCode, q.body.shippingEstimate], [true, "overweight", 0]);
    assert.strictEqual(q.body.gate.requiresRfq, true);
    assert.ok(q.body.gate.reasons.some((r) => r.code === "shipping-freight" && /confirm freight/.test(r.message)));
    assert.strictEqual(q.body.checkout.shipping.valueText, "To be confirmed");
    const c = await checkout(q.body.quoteId);
    assert.strictEqual(c.status, 409);
    assert.strictEqual(c.body.code, "rfq-required");
    await settings({ shippingMethod: "table", shippingRateTable: TABLE });
  });

  test("rate table: a material with no density is not priced at all: never zero pounds, never the cheapest row", async () => {
    // (The pricing whitelist refuses a material whose record has no density before anything is priced, so
    // the "unknown weight" shipping answer cannot be reached through a quote any more. That answer, for a
    // part whose weight cannot be worked out, is still covered in services/shipping.test.js.)
    const mat = materialsDB.getAll().find((m) => m.slug === h.cncConfig(partId).materialSlug);
    materialsDB.update(mat.id, { grades: (mat.grades || []).map((g) => ({ name: g.name })), density: null });
    let q;
    try { q = await price(2); } finally { materialsDB.update(mat.id, { grades: mat.grades, density: mat.density }); }
    assert.deepStrictEqual([q.status, q.body.code, q.body.offerRfq], [409, "material-unavailable", true]);
    assert.strictEqual(q.body.orderTotal, undefined, "no price, and so no shipping price");
    assert.strictEqual((await price(2)).body.shipping.manual, false);
  });

  test("free shipping over a threshold: zero at or over it, the table under it, and the summary says which", async () => {
    const small = await price(1);
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, shippingFreeOverSubtotal: cents(small.body.subtotal + 0.01) });
    const under = await price(1);
    assert.strictEqual(under.body.shippingEstimate, 14.5);
    const over = await price(3);
    assert.ok(over.body.subtotal > small.body.subtotal);
    assert.deepStrictEqual([over.body.shippingEstimate, over.body.shipping.freeApplied, over.body.checkout.shipping.valueText], [0, true, "Free"]);
    const c = await checkout(over.body.quoteId);
    const args = lastArgs();
    assert.strictEqual(args.line_items.length, 1, "nothing to charge, so no shipping line");
    assert.strictEqual(sumLines(args), Math.round(over.body.orderTotal * 100));
    h.sent.length = 0;
    await payByWebhook(lastSession());
    assert.ok(/Shipping \(free on this order\)/.test(h.sent.find((m) => m.to === "dana@buyer.test").text));
    assert.strictEqual(ordersDB.getById(c.body.orderId).shippingCost, 0);
  });

  // ═══ 3. Included ═════════════════════════════════════════════
  test("shipping included: no shipping line anywhere, and every page and document says included", async () => {
    await settings({ shippingMethod: "included" });
    const q = await price(2);
    assert.deepStrictEqual([q.body.shippingEstimate, q.body.shipping.mode, q.body.checkout.shipping.valueText], [0, "included", "Included"]);
    assert.strictEqual(q.body.orderTotal, cents(Math.max(q.body.subtotal + cents(q.body.leadTimeSurcharge), 25)));
    const c = await checkout(q.body.quoteId);
    assert.strictEqual(lastArgs().line_items.length, 1);
    h.sent.length = 0;
    await payByWebhook(lastSession());
    const order = ordersDB.getById(c.body.orderId);
    assert.ok(/Shipping \(included in the price\)/.test(h.sent.find((m) => m.to === "dana@buyer.test").text));
    const pdf = await require("../services/documents").buildOrderConfirmationPdf({ order, items: orderItemsDB.query((i) => i.orderId === order.id) });
    assert.ok((await require("../testSupport/pdfText").pdfText(pdf)).includes("Included"));
    assert.strictEqual((await checkout((await price(2)).body.quoteId, { shippingState: "HI" })).status, 409, "included covers the contiguous states only");
  });

  // ═══ 4. The buyer's own carrier account ══════════════════════
  let collectOrder;
  test("carrier account: offered only when switched on; no shipping charge; the total is the quote less its shipping line", async () => {
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, shippingCarrierAccount: "on" });
    const q = await price(2);
    const opts = q.body.checkout.options;
    assert.deepStrictEqual(opts.map((o) => o.method), ["ship", "carrier-account"]);
    assert.strictEqual(q.body.checkout.showOptions, true);
    assert.strictEqual(opts[1].total, cents(Math.max(q.body.subtotal + cents(q.body.leadTimeSurcharge), 25)));
    assert.ok(opts[1].total < opts[0].total);
    printed.length = 0;
    h.sent.length = 0;
    const c = await checkout(q.body.quoteId, { shippingOption: "carrier-account", carrier: "ups", carrierAccount: " a1b2-c3d4 ", carrierService: "Ground" });
    assert.strictEqual(c.status, 200, c.text);
    const order = ordersDB.getById(c.body.orderId);
    collectOrder = order.id;
    assert.deepStrictEqual([order.shippingMethod, order.shippingCost, order.total, order.shipCarrier, order.shipAccountLast4, order.shipService], ["carrier-account", 0, opts[1].total, "UPS", "C3D4", "Ground"]);
    assert.ok(order.shipAccountEnc && !order.shipAccountEnc.includes(ACCOUNT), "stored sealed, not readable");
    assert.strictEqual(shipping.openAccount(order), ACCOUNT);
    const args = lastArgs();
    assert.strictEqual(args.line_items.length, 1, "no shipping line");
    assert.strictEqual(sumLines(args), Math.round(order.total * 100));
    assert.ok(!JSON.stringify(args).includes(ACCOUNT), "the account number is not sent to Stripe");
    await payByWebhook(lastSession());
    assert.strictEqual(ordersDB.getById(order.id).status, "paid");
  });

  test("carrier account: masked for the buyer, in every email and document; in full only on the admin's view of that order; never in a log line", async () => {
    const order = ordersDB.getById(collectOrder);
    const mine = (await h.get(`/api/orders/${order.id}`, buyer));
    assert.ok(!mine.text.includes(ACCOUNT) && !mine.text.includes(order.shipAccountEnc));
    assert.deepStrictEqual([mine.body.shipAccountMasked, mine.body.deliveryLine], ["••••C3D4", "Ships on your UPS account ••••C3D4 (Ground)"]);
    assert.ok(!(await h.get("/api/orders", buyer)).text.includes(ACCOUNT));
    const adminOne = await h.get(`/api/orders/${order.id}`, owner);
    assert.strictEqual(adminOne.body.shipAccountNumber, ACCOUNT, "the admin's order view shows the full number");
    assert.ok(!adminOne.text.includes(order.shipAccountEnc));
    const adminList = await h.get("/api/orders", owner);
    assert.ok(!adminList.text.includes(ACCOUNT) && !adminList.text.includes(order.shipAccountEnc), "not in the order list");
    const queue = await h.get("/api/orders/admin/queue", owner);
    assert.ok(queue.text.includes(order.id) && !queue.text.includes(ACCOUNT) && !queue.text.includes(order.shipAccountEnc), "not in the production queue");
    const traveler = await h.get(`/api/orders/${order.id}/traveler`, owner);
    assert.ok(traveler.body.order.deliveryLine.includes("••••C3D4") && !traveler.text.includes(ACCOUNT));
    // Emails: the buyer's confirmation and the shop's notice.
    assert.ok(h.sent.length >= 2);
    for (const m of h.sent) assert.ok(!JSON.stringify(m).includes(ACCOUNT), `not in the ${m.template || m.subject} email`);
    const toBuyer = h.sent.find((m) => m.to === "dana@buyer.test");
    assert.ok(/Ships on your UPS account ••••C3D4 \(Ground\) \(no shipping charge from us\)/.test(toBuyer.text));
    assert.ok(/Carrier account: UPS ••••C3D4, Ground/.test(toBuyer.text));
    const toShop = h.sent.find((m) => m.to === "owner@shop.test");
    assert.ok(/SHIP COLLECT on the customer's UPS account \(ends C3D4\)/.test(toShop.text));
    // Documents.
    const items = orderItemsDB.query((i) => i.orderId === order.id);
    const { pdfText } = require("../testSupport/pdfText");
    const docs = require("../services/documents");
    for (const build of [docs.buildOrderConfirmationPdf, docs.buildPackingSlipPdf]) {
      const text = await pdfText(await build({ order, items }));
      assert.ok(!text.includes(ACCOUNT));
      assert.ok(/C3D4/.test(text), "the document names the account by its last four");
    }
    const travelerPdf = await require("../services/pdfGenerator").generateJobTraveler(order, items.map((i) => ({ ...i, geometry: null, dfm: null })));
    assert.ok(!(await pdfText(travelerPdf)).includes(ACCOUNT));
    // Logs: nothing the server printed since the buyer typed the number carries it.
    assert.ok(printed.length > 0);
    assert.ok(!printed.join("\n").includes(ACCOUNT), "the account number never reaches a log line");
  });

  test("carrier account: a missing or malformed account is refused; nothing can be skipped by naming the option", async () => {
    const q = await price(2);
    for (const bad of [{}, { carrier: "UPS" }, { carrier: "UPS", carrierAccount: "12" }, { carrier: "Pony Express", carrierAccount: ACCOUNT }, { carrier: "UPS", carrierAccount: { $ne: "" } }, { carrier: "UPS", carrierAccount: "A1B2C3D4'; --" }]) {
      const r = await checkout(q.body.quoteId, { shippingOption: "carrier-account", ...bad });
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
      assert.strictEqual(r.body.code, "carrier-account");
    }
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 0);
    await settings({ shippingMethod: "table", shippingRateTable: TABLE });
    const off = await checkout(q.body.quoteId, { shippingOption: "carrier-account", carrier: "UPS", carrierAccount: ACCOUNT });
    assert.deepStrictEqual([off.status, off.body.code], [400, "shipping-option"], "with the switch off, a carrier account does not dodge the shipping line");
  });

  test("carrier account: the order minimum still holds when the shipping line is gone", async () => {
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, shippingCarrierAccount: "on", minimumOrderTotal: 5000 });
    const q = await price(2);
    assert.strictEqual(q.body.orderTotal, 5000);
    assert.deepStrictEqual(q.body.checkout.options.map((o) => o.total), [5000, 5000]);
    const c = await checkout(q.body.quoteId, { shippingOption: "carrier-account", carrier: "FedEx", carrierAccount: "123456789" });
    const order = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([order.total, order.shippingCost, order.subtotal], [5000, 0, 5000]);
    assert.strictEqual(sumLines(lastArgs()), 500000);
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, shippingCarrierAccount: "on" });
  });

  test("an order too heavy for a parcel can still be bought on the buyer's own carrier account (no price is guessed)", async () => {
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, shippingCarrierAccount: "on", shippingMaxParcelLb: 1 });
    const q = await price(2);
    assert.strictEqual(q.body.shipping.manual, true);
    assert.strictEqual(q.body.gate.requiresRfq, false, "there is another way to take delivery, so the quote is not sent to a person");
    const [ship, collect] = q.body.checkout.options;
    assert.deepStrictEqual([ship.available, ship.total, ship.shippingText], [false, null, "To be confirmed"]);
    assert.ok(/confirm freight/.test(ship.unavailableReason));
    assert.strictEqual(collect.available, true);
    const refused = await checkout(q.body.quoteId);
    assert.deepStrictEqual([refused.status, refused.body.code], [409, "shipping-manual"]);
    const c = await checkout(q.body.quoteId, { shippingOption: "carrier-account", carrier: "UPS", carrierAccount: ACCOUNT });
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(ordersDB.getById(c.body.orderId).total, collect.total);
  });

  // ═══ 5. Pickup ═══════════════════════════════════════════════
  let pickupOrder;
  test("pickup: no shipping line, no address needed, and the street address is nowhere before payment", async () => {
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, shippingLocalPickup: "on" });
    const q = await price(2);
    assert.deepStrictEqual(q.body.checkout.options.map((o) => o.method), ["ship", "pickup"]);
    assert.ok(!q.text.includes(STREET));
    assert.ok(!(await h.get(`/api/quote/${q.body.quoteId}`, buyer)).text.includes(STREET));
    assert.strictEqual((await checkout(q.body.quoteId, { shippingOption: "pickup", shippingName: "" })).body.code, "pickup-name");
    printed.length = 0;
    h.sent.length = 0;
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, shippingOption: "pickup", shippingName: "Dana Buyer", shippingAddress: "ignored", shippingCity: "ignored" }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    assert.ok(!c.text.includes(STREET));
    const order = ordersDB.getById(c.body.orderId);
    pickupOrder = order.id;
    assert.deepStrictEqual([order.shippingMethod, order.shippingCost, order.shippingAddress, order.shippingCity, order.total], ["pickup", 0, "", "", q.body.checkout.options[1].total]);
    assert.strictEqual(lastArgs().line_items.length, 1);
    assert.ok(!JSON.stringify(lastArgs()).includes(STREET), "not sent to Stripe");
    const pending = await h.get(`/api/orders/${order.id}`, buyer);
    assert.ok(!pending.text.includes(STREET) && !("pickupAddress" in pending.body), "an unpaid pickup order does not show the address");
    assert.strictEqual(pending.body.deliveryLine, "Pickup at our shop");
    assert.strictEqual(h.sent.length, 0);
  });

  test("pickup: once paid, the order confirmation and the buyer's order page give the address; the shop is told not to ship", async () => {
    await payByWebhook(h.stripe.sessions[ordersDB.getById(pickupOrder).stripeSessionId]);
    const order = ordersDB.getById(pickupOrder);
    assert.strictEqual(order.status, "paid");
    const toBuyer = h.sent.find((m) => m.to === "dana@buyer.test");
    assert.ok(toBuyer.text.includes(`Pick up at: `) && toBuyer.text.includes(STREET), "the confirmation carries the address");
    assert.ok(/Pickup at our shop \(no shipping charge\)/.test(toBuyer.text) && /Pickup by: Dana Buyer/.test(toBuyer.text));
    assert.ok(!/Ship to:/.test(toBuyer.text));
    assert.ok(/PICKUP: the customer collects this order at the shop\. Do not ship it\./.test(h.sent.find((m) => m.to === "owner@shop.test").text));
    const view = await h.get(`/api/orders/${order.id}`, buyer);
    assert.deepStrictEqual(view.body.pickupAddress.lines, [STREET, `${shipFrom.city}, ${shipFrom.state} ${shipFrom.zip}`]);
    // Another customer still cannot see it; neither can a guest.
    const stranger = await h.register("stranger@else.test", "Someone Else");
    assert.strictEqual((await h.get(`/api/orders/${order.id}`, stranger)).status, 403);
    assert.strictEqual((await h.get(`/api/orders/${order.id}`)).status, 401);
    assert.ok(!printed.join("\n").includes(STREET), "the address is not logged");
  });

  test("pickup: 'shipped' in admin means ready to collect, and the email says that", async () => {
    h.sent.length = 0;
    const r = await h.put(`/api/orders/${pickupOrder}/status`, { status: "shipped" }, owner);
    assert.strictEqual(r.status, 200);
    const mail = h.sent[0];
    assert.ok(/ready for pickup/.test(mail.subject) && /ready to collect/.test(mail.text));
    assert.ok(!/on the way|tracking/i.test(mail.text));
    assert.ok(mail.text.includes(STREET));
  });

  test("the public catalog endpoints, the quote and the settings a guest can read never contain the street address", async () => {
    for (const url of ["/api/materials", "/api/processes", "/api/finishes", "/api/lead-times"]) assert.ok(!(await h.get(url)).text.includes(STREET), url);
    // (A visitor's own upload: the part the suite began with belongs to the buyer's account by now.)
    const guest = await h.post("/api/quote", { parts: [h.cncConfig(await h.uploadCube(), 1)], leadTimeSlug: "standard" });
    assert.ok(guest.body.checkout.options.some((o) => o.method === "pickup"));
    assert.ok(!guest.text.includes(STREET) && !guest.text.includes(shipFrom.zip), "the pickup option is offered without saying where");
  });

  // ═══ 6. Stripe Tax ═══════════════════════════════════════════
  let taxedOrder;
  test("Stripe Tax: the pages say tax is added at payment; the session carries automatic_tax and a Customer at the ship-to address", async () => {
    await settings({ taxMode: "stripe" });
    const q = await price(2);
    assert.strictEqual(q.body.checkout.tax.mode, "stripe");
    assert.ok(/added on the secure payment page/.test(q.body.checkout.tax.note));
    assert.strictEqual(q.body.orderTotal, baseline.orderTotal, "the quote's own price does not move");
    const before = h.stripe.customers.length;
    const c = await checkout(q.body.quoteId);
    assert.strictEqual(c.status, 200, c.text);
    const args = lastArgs();
    assert.deepStrictEqual(args.automatic_tax, { enabled: true });
    assert.ok(!("customer_email" in args) && !("tax_id_collection" in args));
    assert.strictEqual(h.stripe.customers.length, before + 1);
    const customer = h.stripe.customers[before];
    assert.strictEqual(args.customer, customer.id);
    assert.deepStrictEqual(customer.shipping.address, { line1: "100 Main St", city: "Columbus", state: "OH", postal_code: "43215", country: "US" });
    assert.deepStrictEqual([customer.email, customer.tax_exempt], ["dana@buyer.test", "none"]);
    // Shipping is its own line so it can be taxed its own way; every line is tax-exclusive.
    assert.deepStrictEqual(args.line_items.map((li) => li.price_data.product_data.name), ["Straightedge Order — 1 part", "Shipping"]);
    assert.ok(args.line_items.every((li) => li.price_data.tax_behavior === "exclusive"));
    assert.strictEqual(sumLines(args), Math.round(q.body.orderTotal * 100), "the lines are the pre-tax total");
    taxedOrder = c.body.orderId;
    const pending = (await h.get(`/api/orders/${taxedOrder}`, buyer)).body;
    assert.deepStrictEqual([pending.taxLine.valueText, pending.total], ["Added at payment", q.body.orderTotal]);
  });

  test("Stripe Tax: the tax the payment reports is stored, the total includes it, and a taxed order is NOT an amount mismatch", async () => {
    const session = lastSession();
    const before = ordersDB.getById(taxedOrder);
    const tax = session.total_details.amount_tax;
    assert.strictEqual(tax, Math.round(before.total * 100 * 0.07));
    assert.strictEqual(session.amount_total, session.amount_subtotal + tax, "the buyer was charged more than the order's pre-tax total");
    h.sent.length = 0;
    await payByWebhook(session);
    const order = ordersDB.getById(taxedOrder);
    assert.strictEqual(order.status, "paid", "not paid_amount_mismatch");
    assert.strictEqual(order.tax, tax / 100);
    assert.strictEqual(order.total, cents(before.total + tax / 100));
    assert.ok(Math.abs(order.subtotal + order.leadTimeSurcharge + order.paperworkFee + order.shippingCost + order.tax - order.total) < 0.01, "parts + fees + shipping + tax = total");
    const mail = h.sent.find((m) => m.to === "dana@buyer.test");
    assert.ok(new RegExp(`Sales tax\\s+\\$${order.tax.toFixed(2).replace(".", "\\.")}`).test(mail.text));
    const priced = mail.text.split("\n").filter((l) => /^\s+- /.test(l)).map((l) => Number((l.match(/\$([\d,]+\.\d{2})$/) || [])[1]?.replace(/,/g, ""))).filter(Number.isFinite);
    assert.ok(Math.abs(priced.reduce((a, b) => a + b, 0) - order.total) < 0.01, "the email's lines add up to the total paid, tax included");
    assert.strictEqual(h.sent.length, 2, "the customer hears from us (a mismatch would have gone to the shop only)");
    const view = (await h.get(`/api/orders/${taxedOrder}`, buyer)).body;
    assert.deepStrictEqual(view.taxLine, { label: "Sales tax", amount: order.tax, valueText: null });
    const text = await require("../testSupport/pdfText").pdfText(await require("../services/documents").buildOrderConfirmationPdf({ order, items: orderItemsDB.query((i) => i.orderId === order.id) }));
    assert.ok(text.includes("Sales tax") && text.includes(order.tax.toFixed(2)));
    // The same event again changes nothing (the tax is not added twice).
    await payByWebhook(session);
    assert.strictEqual(ordersDB.getById(taxedOrder).total, order.total);
  });

  test("Stripe Tax: settling on the return page (no webhook) stores the tax the same way", async () => {
    const q = await price(3);
    const c = await checkout(q.body.quoteId);
    h.pay(lastSession().id);
    const r = await h.post(`/api/orders/${c.body.orderId}/confirm-payment`, {}, buyer);
    assert.strictEqual(r.body.status, "paid");
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.tax, lastSession().total_details.amount_tax / 100);
    assert.strictEqual(order.total, cents(q.body.orderTotal + order.tax));
  });

  test("Stripe Tax: a promo code and tax together are still a clean paid order; a wrong pre-tax amount is still caught", async () => {
    // Promotion codes are off unless the owner switches them on (a discount on a session opened with
    // them off is itself a mismatch: orderLifecycle.test.js). On, for the first half of this test.
    process.env.STRIPE_PROMOTION_CODES = "on";
    let order;
    try {
      const q = await price(2);
      const c = await checkout(q.body.quoteId);
      const s = lastSession();
      const discount = Math.round(s.amount_subtotal * 0.1);
      const tax = Math.round((s.amount_subtotal - discount) * 0.07);
      await payByWebhook(s, { amount_total: s.amount_subtotal - discount + tax, total_details: { amount_tax: tax, amount_discount: discount, amount_shipping: 0 } });
      order = ordersDB.getById(c.body.orderId);
      assert.deepStrictEqual([order.status, order.tax, order.attention || null], ["paid", tax / 100, null]);
      assert.strictEqual(order.total, cents(q.body.orderTotal + tax / 100), "the order's total is its lines plus the tax");
      assert.strictEqual(order.amountPaid, (s.amount_subtotal - discount + tax) / 100, "and what was collected is that, less the discount");
    } finally { delete process.env.STRIPE_PROMOTION_CODES; }

    // What our lines came to is not what the order comes to: the order is NOT marked paid. It is
    // flagged, the shop is emailed, and the buyer is told nothing until a person has looked.
    const q2 = await price(4);
    const c2 = await checkout(q2.body.quoteId);
    const s2 = lastSession();
    h.sent.length = 0;
    await payByWebhook(s2, { amount_subtotal: 100, amount_total: 107, total_details: { amount_tax: 7, amount_discount: 0, amount_shipping: 0 } });
    const flagged = ordersDB.getById(c2.body.orderId);
    assert.deepStrictEqual([flagged.status, flagged.attention, flagged.tax || 0], ["pending_payment", "payment-mismatch", 0]);
    assert.deepStrictEqual(h.sent.map((m) => m.to), ["owner@shop.test"]);

    // Tax on a payment for an order that was checked out with tax OFF is a mismatch too, even when the
    // rest adds up: only a session opened with Stripe Tax on can carry tax.
    await settings();
    const q3 = await price(3);
    const c3 = await checkout(q3.body.quoteId);
    const s3 = lastSession();
    await payByWebhook(s3, { amount_total: s3.amount_subtotal + 50, total_details: { amount_tax: 50, amount_discount: 0, amount_shipping: 0 } });
    const untaxed = ordersDB.getById(c3.body.orderId);
    assert.deepStrictEqual([untaxed.status, untaxed.attention], ["pending_payment", "payment-mismatch"]);
    assert.ok(/sales tax of \$0\.50 was added although this order was checked out with sales tax off/.test(untaxed.attentionNote), untaxed.attentionNote);
    await settings({ taxMode: "stripe" });
  });

  test("Stripe Tax: no tax due (no registration there) is a paid order with $0.00 tax, said plainly", async () => {
    h.stripe.taxRate = 0;
    const q = await price(2);
    const c = await checkout(q.body.quoteId);
    await payByWebhook(lastSession());
    const order = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([order.status, order.tax, order.total], ["paid", 0, q.body.orderTotal]);
    assert.deepStrictEqual((await h.get(`/api/orders/${order.id}`, buyer)).body.taxLine, { label: "Sales tax", amount: 0, valueText: null });
    h.stripe.taxRate = 0.07;
  });

  test("Stripe Tax: an address Stripe cannot place is refused in words, and no order is left behind", async () => {
    const q = await price(2);
    h.stripe.failCustomer = true;
    const c = await checkout(q.body.quoteId, { shippingZip: "00000" });
    assert.deepStrictEqual([c.status, c.body.code], [400, "tax-address"]);
    assert.ok(/couldn't work out sales tax for that address/.test(c.body.error));
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 0);
    assert.strictEqual(quotesDB.getById(q.body.quoteId).status, "draft");
  });

  test("Stripe Tax: a pinned product code, nontaxable shipping and tax-ID collection are sent as set", async () => {
    await settings({ taxMode: "stripe", taxProductCode: "txcd_99999999", taxShipping: "nontaxable", taxIdCollection: "on" });
    const q = await price(2, { paperwork: true });
    const c = await checkout(q.body.quoteId);
    const args = lastArgs();
    const byName = Object.fromEntries(args.line_items.map((li) => [li.price_data.product_data.name, li.price_data.product_data.tax_code]));
    assert.deepStrictEqual(Object.values(byName), ["txcd_99999999", "txcd_99999999", "txcd_00000000"]);
    assert.deepStrictEqual(args.tax_id_collection, { enabled: true });
    assert.deepStrictEqual(args.customer_update, { name: "auto" });
    // The stub taxes everything but the nontaxable line.
    const s = lastSession();
    assert.strictEqual(s.total_details.amount_tax, Math.round((s.amount_subtotal - args.line_items[2].price_data.unit_amount) * 0.07));
    await payByWebhook(s, { customer_details: { tax_ids: [{ type: "ca_gst_hst", value: "123456789RT0002" }] } });
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.status, "paid");
    assert.strictEqual((await h.get(`/api/orders/${order.id}`, owner)).body.customerTaxIds, "ca_gst_hst 123456789RT0002");
    assert.ok(!("customerTaxIds" in (await h.get(`/api/orders/${order.id}`, buyer)).body));
    // A code that is not a Stripe code cannot be saved.
    const bad = await h.put("/api/admin/pricing", { rules: { taxProductCode: "general goods" }, note: "typo" }, owner);
    assert.strictEqual(bad.status, 400);
  });

  test("Stripe Tax: a pickup order is taxed at the shop's city, state and ZIP; the street address is still not sent", async () => {
    await settings({ taxMode: "stripe", shippingLocalPickup: "on" });
    const q = await price(2);
    const c = await checkout(q.body.quoteId, { shippingOption: "pickup" });
    assert.strictEqual(c.status, 200, c.text);
    const customer = h.stripe.customers[h.stripe.customers.length - 1];
    assert.deepStrictEqual(customer.shipping.address, { city: shipFrom.city, state: shipFrom.state, postal_code: shipFrom.zip, country: "US" });
    assert.ok(!JSON.stringify(customer).includes(STREET) && !JSON.stringify(lastArgs()).includes(STREET));
  });

  // ═══ 7. Declared exemptions ══════════════════════════════════
  test("exemption not offered: ticking a box that is not on the page does nothing; the order is taxed", async () => {
    await settings({ taxMode: "stripe" });
    const q = await price(2);
    assert.strictEqual(q.body.checkout.tax.exemption.offered, false);
    const c = await checkout(q.body.quoteId, { taxExempt: true, taxExemptReason: "resale", taxExemptStatus: "untaxed" });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(h.stripe.customers[h.stripe.customers.length - 1].tax_exempt, "none");
    assert.ok(lastSession().total_details.amount_tax > 0);
    assert.strictEqual(ordersDB.getById(c.body.orderId).taxExempt, false);
  });

  test("the certificate upload takes a real PDF or scan from the quote's owner and nothing else", async () => {
    await settings({ taxMode: "stripe", taxExemptDeclare: "on" });
    const q = await price(2);
    const id = q.body.quoteId;
    assert.strictEqual((await attach(id, { name: "cert.pdf", data: Buffer.from("<html>not a pdf</html>") })).status, 400, "content must match the name");
    assert.strictEqual((await attach(id, { name: "cert.exe", data: PDF })).status, 400);
    assert.strictEqual((await attach(id, { name: "cert.svg", data: Buffer.from("<svg onload=alert(1)>") })).status, 400);
    const stranger = await h.login("stranger@else.test");
    assert.strictEqual((await attach(id, undefined, stranger)).status, 404, "another customer cannot attach to this quote");
    assert.strictEqual((await h.form(`/api/quote/${id}/tax-certificate`, {}, { certificate: { name: "c.pdf", data: PDF } })).status, 404, "nor can a guest");
    const up = await attach(id, { name: "../../resale <cert>.pdf", data: PDF });
    assert.strictEqual(up.status, 200, up.text);
    assert.strictEqual(up.body.taxCertFileName, "resale _cert_.pdf", "the name is a label, cleaned");
    const row = quotesDB.getById(id);
    assert.ok(row.taxCertPath && path.dirname(row.taxCertPath).endsWith("quote-drawings") && /^[0-9a-f-]{36}\.pdf(\.enc)?$/.test(path.basename(row.taxCertPath)), "stored under a name of ours");
    const view = await h.get(`/api/quote/${id}`, buyer);
    assert.strictEqual(view.body.taxCertFileName, "resale _cert_.pdf");
    assert.ok(!("taxCertPath" in view.body) && !view.text.includes(row.taxCertPath), "the server path is not exposed");
    // Replacing it removes the old file; removing it removes the file.
    const again = await attach(id, { name: "scan.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) });
    assert.strictEqual(again.status, 200);
    assert.ok(!fs.existsSync(row.taxCertPath));
    const second = quotesDB.getById(id).taxCertPath;
    assert.strictEqual((await h.del(`/api/quote/${id}/tax-certificate`, buyer)).status, 200);
    assert.ok(!fs.existsSync(second));
    assert.strictEqual(quotesDB.getById(id).taxCertPath, "");
  });

  let reviewOrder;
  test("exemption declared, declarations NOT trusted: a certificate is required, the order is charged WITH tax, and the shop is told to review and refund", async () => {
    const q = await price(2);
    assert.deepStrictEqual([q.body.checkout.tax.exemption.offered, q.body.checkout.tax.exemption.trusted], [true, false]);
    const none = await checkout(q.body.quoteId, { taxExempt: true, taxExemptReason: "resale" });
    assert.deepStrictEqual([none.status, none.body.code], [400, "certificate-required"]);
    assert.strictEqual((await attach(q.body.quoteId)).status, 200);
    assert.strictEqual((await checkout(q.body.quoteId, { taxExempt: true, taxExemptReason: "because I say so" })).body.code, "exemption-reason");
    const c = await checkout(q.body.quoteId, { taxExempt: true, taxExemptReason: "resale", taxExemptStatus: "untaxed", taxTrustDeclaredExemptions: "on" });
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(h.stripe.customers[h.stripe.customers.length - 1].tax_exempt, "none", "the Customer is NOT marked exempt");
    const s = lastSession();
    assert.ok(s.total_details.amount_tax > 0, "tax is charged");
    h.sent.length = 0;
    await payByWebhook(s);
    const order = ordersDB.getById(c.body.orderId);
    reviewOrder = order.id;
    assert.deepStrictEqual([order.status, order.taxExempt, order.taxExemptReason, order.taxExemptStatus], ["paid", true, "resale", "taxed"]);
    assert.ok(order.tax > 0);
    assert.ok(/once we have read the certificate we refund the tax/.test(h.sent.find((m) => m.to === "dana@buyer.test").text));
    assert.ok(/TAX EXEMPTION DECLARED\. Resale: charged WITH tax\. Read the certificate, then refund the tax in Stripe/.test(h.sent.find((m) => m.to === "owner@shop.test").text));
  });

  test("the admin sees the exemption and can open the certificate; the buyer and other customers cannot download it", async () => {
    const order = ordersDB.getById(reviewOrder);
    const admin = (await h.get(`/api/orders/${order.id}`, owner)).body;
    assert.deepStrictEqual([admin.taxExempt, admin.taxExemptStatus, admin.hasTaxCertificate, admin.taxCertFileName], [true, "taxed", true, "resale-cert.pdf"]);
    assert.ok(/charged WITH tax/.test(admin.taxExemptionLine));
    assert.ok(!("taxCertPath" in admin));
    const list = (await h.get("/api/orders", owner)).body.find((o) => o.id === order.id);
    assert.ok(/charged WITH tax/.test(list.taxExemptionLine) && !("taxCertPath" in list));
    const dl = await fetch(`${h.base}/api/orders/${order.id}/tax-certificate`, { headers: { Authorization: `Bearer ${owner}` } });
    assert.strictEqual(dl.status, 200);
    assert.ok(/attachment/.test(dl.headers.get("content-disposition")));
    assert.ok((await dl.text()).startsWith("%PDF"));
    assert.strictEqual((await h.get(`/api/orders/${order.id}/tax-certificate`, buyer)).status, 403);
    assert.strictEqual((await h.get(`/api/orders/${order.id}/tax-certificate`)).status, 401);
    const mine = (await h.get(`/api/orders/${order.id}`, buyer)).body;
    assert.ok(!("taxCertPath" in mine) && !("taxExemptionLine" in mine));
    // The certificate is kept while the order points at it, like a drawing.
    const { referencedDrawings } = require("../services/fileRetention");
    assert.ok(referencedDrawings(h.models).has(path.basename(order.taxCertPath)));
  });

  test("exemption declared, declarations TRUSTED: with a certificate the order is charged with NO tax; without one it is refused", async () => {
    await settings({ taxMode: "stripe", taxExemptDeclare: "on", taxTrustDeclaredExemptions: "on" });
    const q = await price(2);
    assert.strictEqual(q.body.checkout.tax.exemption.trusted, true);
    const none = await checkout(q.body.quoteId, { taxExempt: true, taxExemptReason: "manufacturing" });
    assert.deepStrictEqual([none.status, none.body.code], [400, "certificate-required"], "the box alone removes nothing");
    await attach(q.body.quoteId);
    const c = await checkout(q.body.quoteId, { taxExempt: true, taxExemptReason: "manufacturing" });
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(h.stripe.customers[h.stripe.customers.length - 1].tax_exempt, "exempt");
    const s = lastSession();
    assert.strictEqual(s.total_details.amount_tax, 0);
    h.sent.length = 0;
    await payByWebhook(s);
    const order = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([order.status, order.tax, order.total, order.taxExemptStatus], ["paid", 0, q.body.orderTotal, "untaxed"]);
    assert.ok(/no sales tax was charged/.test(h.sent.find((m) => m.to === "dana@buyer.test").text));
    assert.ok(/charged with NO tax/.test(h.sent.find((m) => m.to === "owner@shop.test").text));
    assert.strictEqual((await h.get(`/api/orders/${order.id}`, buyer)).body.taxLine.valueText, "Exempt (certificate on file)");
    // A buyer who does not tick the box is taxed as usual, certificate on the quote or not.
    const q2 = await price(2);
    await attach(q2.body.quoteId);
    const c2 = await checkout(q2.body.quoteId, {});
    assert.strictEqual(h.stripe.customers[h.stripe.customers.length - 1].tax_exempt, "none");
    assert.deepStrictEqual([ordersDB.getById(c2.body.orderId).taxExempt, ordersDB.getById(c2.body.orderId).taxCertPath], [false, ""]);
  });

  // ═══ 8. Firm quotes and purchase orders ══════════════════════
  const tokenFrom = (m) => (m.text.match(/https:\/\/shop\.test\/firm-quote\/(\S+)/) || [])[1];
  async function firmQuote({ part = false, returnPart = false } = {}) {
    const fields = part ? { requestType: "part", contactName: "Pat Purchasing", email: "pat@oem.test", returnPart: String(returnPart), notes: "worn guide block" } : null;
    let rfqId;
    if (part) rfqId = (await h.form("/api/rfq", fields)).body.rfqId;
    else {
      // (A visitor's own upload: the part the suite began with belongs to the buyer's account by now.)
      const q = await h.post("/api/quote", { parts: [h.cncConfig(await h.uploadCube(), 500)], leadTimeSlug: "standard" });
      assert.strictEqual(q.status, 200, q.text);
      rfqId = (await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: "Pat Purchasing", email: "pat@oem.test" })).body.rfqId;
    }
    h.sent.length = 0;
    const r = await h.put(`/api/rfq/admin/${rfqId}`, { status: "quoted", quotedTotal: 4250, quotedLeadDays: 15 }, owner);
    assert.strictEqual(r.status, 200, r.text);
    return { rfqId, token: tokenFrom(h.sent[0]) };
  }

  test("firm quote, defaults: the page is offered nothing new and the order is what it always was", async () => {
    await settings();
    const { rfqId, token } = await firmQuote();
    const view = (await h.get(`/api/rfq/quote/${token}`)).body;
    assert.deepStrictEqual([view.checkout.showOptions, view.checkout.options.map((o) => o.method), view.checkout.tax.mode], [false, ["ship"], "off"]);
    const refused = await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", poNumber: "PO-1", ...SHIP, shippingOption: "pickup" });
    assert.deepStrictEqual([refused.status, refused.body.code], [400, "shipping-option"]);
    const before = h.stripe.customers.length;
    const r = await h.post(`/api/rfq/quote/${token}/accept`, { method: "card", ...SHIP });
    assert.strictEqual(r.status, 201, r.text);
    const order = ordersDB.getById(rfqsDB.getById(rfqId).orderId);
    assert.deepStrictEqual([order.total, order.shippingCost, order.shippingMethod, order.shippingMode, order.taxMode], [4250, 0, "standard", "firm", "off"]);
    const args = lastArgs();
    assert.deepStrictEqual([args.line_items.length, args.line_items[0].price_data.unit_amount, args.customer_email], [1, 425000, "pat@oem.test"]);
    assert.ok(!("automatic_tax" in args) && h.stripe.customers.length === before);
  });

  test("purchase order with Stripe Tax on: nothing is charged, tax is 'per invoice' on the order, the email and the PDF", async () => {
    await settings({ taxMode: "stripe", shippingCarrierAccount: "on", shippingLocalPickup: "on" });
    const { rfqId, token } = await firmQuote();
    const view = (await h.get(`/api/rfq/quote/${token}`)).body;
    assert.deepStrictEqual(view.checkout.options.map((o) => o.method), ["ship", "carrier-account", "pickup"]);
    assert.ok(/per invoice/.test(view.checkout.tax.poNote));
    const created = h.stripe.created.length;
    h.sent.length = 0;
    const r = await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", poNumber: "PO-88213", ...SHIP, shippingOption: "carrier-account", carrier: "FedEx", carrierAccount: "123456789" });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(h.stripe.created.length, created, "no Stripe session for a PO");
    const order = ordersDB.getById(rfqsDB.getById(rfqId).orderId);
    assert.deepStrictEqual([order.status, order.total, order.tax, order.taxMode, order.shippingMethod, order.shipAccountLast4], ["pending_po", 4250, 0, "stripe", "carrier-account", "6789"]);
    assert.strictEqual(shipping.openAccount(order), "123456789");
    const mail = h.sent.find((m) => m.to === "pat@oem.test");
    assert.ok(/Sales tax \(per invoice\)/.test(mail.text) && /Sales tax on a purchase order is per invoice/.test(mail.text));
    assert.ok(/Order total: \$4,250\.00/.test(mail.text));
    assert.ok(!JSON.stringify(h.sent).includes("123456789"), "the account number is in no email");
    const page = (await h.get(`/api/rfq/quote/${token}`)).body.order;
    assert.deepStrictEqual([page.taxLine.valueText, page.deliveryLine], ["Per invoice", "Ships on your FedEx account ••••6789"]);
    const text = await require("../testSupport/pdfText").pdfText(await require("../services/documents").buildOrderConfirmationPdf({ order, items: orderItemsDB.query((i) => i.orderId === order.id) }));
    assert.ok(/Per invoice/.test(text) && !text.includes("123456789"));
  });

  test("purchase order + pickup: accepted with no ship-to address; the street address is NOT given out (nothing has been paid)", async () => {
    const { rfqId, token } = await firmQuote();
    h.sent.length = 0;
    const r = await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", poNumber: "PO-88214", shippingName: "Pat Purchasing", shippingOption: "pickup" });
    assert.strictEqual(r.status, 201, r.text);
    const order = ordersDB.getById(rfqsDB.getById(rfqId).orderId);
    assert.deepStrictEqual([order.shippingMethod, order.shippingAddress], ["pickup", ""]);
    assert.ok(!JSON.stringify(h.sent).includes(STREET));
    assert.ok(/address and a time are confirmed with you before pickup/.test(h.sent.find((m) => m.to === "pat@oem.test").text));
    const page = await h.get(`/api/rfq/quote/${token}`);
    assert.ok(!page.text.includes(STREET) && page.body.order.pickupAddress === null);
    // Without pickup, the address is still required.
    const other = await firmQuote();
    assert.strictEqual((await h.post(`/api/rfq/quote/${other.token}/accept`, { method: "po", poNumber: "PO-1", shippingName: "Pat" })).status, 400);
  });

  test("firm quote by card with Stripe Tax: the quoted total is the pre-tax total, tax is added and stored; an exemption follows the same rule", async () => {
    await settings({ taxMode: "stripe", taxExemptDeclare: "on", taxTrustDeclaredExemptions: "on" });
    const { rfqId, token } = await firmQuote();
    // The certificate goes up through the signed link, before accepting.
    const fd = (file) => h.form(`/api/rfq/quote/${token}/tax-certificate`, {}, { certificate: file });
    assert.strictEqual((await fd({ name: "c.pdf", data: Buffer.from("nope") })).status, 400);
    assert.strictEqual((await h.post(`/api/rfq/quote/${token}/accept`, { method: "card", ...SHIP, taxExempt: true, taxExemptReason: "resale" })).body.code, "certificate-required");
    assert.strictEqual((await fd({ name: "resale.pdf", data: PDF })).status, 200);
    assert.strictEqual((await h.get(`/api/rfq/quote/${token}`)).body.taxCertFileName, "resale.pdf");
    assert.ok(!(await h.get(`/api/rfq/quote/${token}`)).text.includes("quote-drawings"));
    assert.ok(!(await h.get("/api/rfq/admin/list", owner)).text.includes(rfqsDB.getById(rfqId).taxCertPath), "nor does the admin queue carry the path");
    const r = await h.post(`/api/rfq/quote/${token}/accept`, { method: "card", ...SHIP, taxExempt: true, taxExemptReason: "resale" });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(h.stripe.customers[h.stripe.customers.length - 1].tax_exempt, "exempt");
    assert.strictEqual(sumLines(lastArgs()), 425000);
    await payByWebhook(lastSession());
    const order = ordersDB.getById(rfqsDB.getById(rfqId).orderId);
    assert.deepStrictEqual([order.status, order.tax, order.total, order.taxExemptStatus, Boolean(order.taxCertPath)], ["paid", 0, 4250, "untaxed", true]);
    assert.strictEqual((await fd({ name: "late.pdf", data: PDF })).status, 409, "an accepted quote can no longer be changed");

    // And taxed when nothing is declared.
    const plain = await firmQuote();
    await h.post(`/api/rfq/quote/${plain.token}/accept`, { method: "card", ...SHIP });
    await payByWebhook(lastSession());
    const taxed = ordersDB.getById(rfqsDB.getById(plain.rfqId).orderId);
    assert.deepStrictEqual([taxed.status, taxed.tax, taxed.total], ["paid", 297.5, 4547.5]);
    assert.strictEqual((await h.get(`/api/rfq/quote/${plain.token}`)).body.order.total, 4547.5);
  });

  test("replacement part with the original going back: every document says how it is returned, for each delivery choice", async () => {
    await settings({ shippingLocalPickup: "on", shippingCarrierAccount: "on" });
    const { pdfText } = require("../testSupport/pdfText");
    const docs = require("../services/documents");
    const cases = [
      [{ ...SHIP }, /return shipping included in the quoted price/, /Return shipping is included in the quoted price/],
      [{ shippingName: "Pat", shippingOption: "pickup" }, /handed back with your parts at pickup/, /Handed back to you with the finished parts at pickup/],
      [{ ...SHIP, shippingOption: "carrier-account", carrier: "UPS", carrierAccount: ACCOUNT }, /in the box with the finished parts, on your carrier account/, /on your carrier account/],
    ];
    for (const [body, inEmail, inPdf] of cases) {
      const { rfqId, token } = await firmQuote({ part: true, returnPart: true });
      const quotePage = (await h.get(`/api/rfq/quote/${token}`)).body;
      assert.ok(quotePage.covers.some((l) => /includes shipping your original part back/.test(l)), "the firm quote states the return is in the price");
      h.sent.length = 0;
      const r = await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", poNumber: "PO-7", ...body });
      assert.strictEqual(r.status, 201, r.text);
      const order = ordersDB.getById(rfqsDB.getById(rfqId).orderId);
      assert.strictEqual(order.returnPart, true);
      const mail = h.sent.find((m) => m.to === "pat@oem.test");
      assert.ok(/Your original part, returned with this order/.test(mail.text) && inEmail.test(mail.text), mail.text);
      const items = orderItemsDB.query((i) => i.orderId === order.id);
      assert.ok(inPdf.test(await pdfText(await docs.buildOrderConfirmationPdf({ order, items }))));
      assert.ok(/Customer's original part, returned/.test(await pdfText(await docs.buildPackingSlipPdf({ order, items }))));
      assert.strictEqual((await h.get(`/api/orders/${order.id}/traveler`, owner)).body.order.returnPart, true);
    }
  });

  // ═══ 9. Reorder, and orders from before ══════════════════════
  test("an order placed before these columns existed still displays, documents and reorders", async () => {
    await settings();
    const q = await price(2);
    const c = await checkout(q.body.quoteId);
    await payByWebhook(lastSession());
    // Put the row back to what the previous version wrote: every new column empty.
    const cols = require("../models/taxShippingMigration").ORDER_COLUMNS.map(([name]) => `${name} = NULL`).join(", ");
    require("../models/database").getDatabase().run(`UPDATE orders SET ${cols}, tax = 0 WHERE id = ?`, [c.body.orderId]);
    const old = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([old.shippingMode, old.taxMode, old.taxExempt, old.shipCarrier], [null, null, false, null]);
    const view = (await h.get(`/api/orders/${old.id}`, buyer)).body;
    assert.deepStrictEqual([view.status, view.total, view.shippingCost, view.taxLine, view.deliveryLine, view.shipAccountMasked, view.hasTaxCertificate], ["paid", q.body.orderTotal, cents(q.body.shippingEstimate), null, "", "", false]);
    const adminView = (await h.get(`/api/orders/${old.id}`, owner)).body;
    assert.deepStrictEqual([adminView.shipAccountNumber, adminView.taxExemptionLine], [null, ""]);
    const items = orderItemsDB.query((i) => i.orderId === old.id);
    const text = await require("../testSupport/pdfText").pdfText(await require("../services/documents").buildOrderConfirmationPdf({ order: old, items }));
    assert.ok(/Shipping/.test(text) && !/Sales tax|Pickup|Per invoice/.test(text));
    const mail = require("../emails/templates").orderConfirmation({ order: old, items, orderUrl: "https://shop.test/x" });
    assert.ok(/Shipping\s+\$/.test(mail.text) && !/tax|pickup/i.test(mail.text));
    assert.ok((await require("../services/pdfGenerator").generateJobTraveler(old, items.map((i) => ({ ...i, geometry: null, dfm: null })))).length > 1000);
    // Reorder: today's settings price the new quote; the old order is untouched.
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, taxMode: "stripe" });
    const r = await h.post(`/api/orders/${old.id}/reorder`, {}, buyer);
    assert.strictEqual(r.status, 201, r.text);
    const again = quotesDB.getById(r.body.quoteId);
    assert.deepStrictEqual([again.shipping.mode, again.shippingEstimate, again.status], ["table", 14.5, "draft"]);
    const c2 = await checkout(again.id);
    assert.strictEqual(c2.status, 200, c2.text);
    assert.deepStrictEqual(lastArgs().automatic_tax, { enabled: true });
    assert.strictEqual(ordersDB.getById(old.id).total, q.body.orderTotal);
  });

  test("reorder of a carrier-account order re-prices under today's settings and does not carry the account number along", async () => {
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, shippingCarrierAccount: "on" });
    const r = await h.post(`/api/orders/${collectOrder}/reorder`, {}, buyer);
    assert.strictEqual(r.status, 201, r.text);
    const again = await h.get(`/api/quote/${r.body.quoteId}`, buyer);
    assert.ok(!again.text.includes(ACCOUNT) && !again.text.includes("C3D4"));
    assert.strictEqual(again.body.checkout.options[0].total, again.body.orderTotal);
    const c = await checkout(r.body.quoteId);
    assert.deepStrictEqual([ordersDB.getById(c.body.orderId).shippingMethod, ordersDB.getById(c.body.orderId).shipAccountEnc], ["standard", ""], "the buyer chooses again at checkout");
  });

  test("changing the delivery choice on the way back from a cancelled payment updates the same order: amounts, method and account", async () => {
    await settings({ shippingMethod: "table", shippingRateTable: TABLE, shippingCarrierAccount: "on", shippingLocalPickup: "on" });
    const q = await price(2);
    const first = await checkout(q.body.quoteId);
    const second = await checkout(q.body.quoteId, { shippingOption: "carrier-account", carrier: "UPS", carrierAccount: ACCOUNT });
    const third = await checkout(q.body.quoteId, { shippingOption: "pickup" });
    const fourth = await checkout(q.body.quoteId);
    assert.deepStrictEqual([second.body.orderId, third.body.orderId, fourth.body.orderId], [first.body.orderId, first.body.orderId, first.body.orderId]);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 1);
    const order = ordersDB.getById(first.body.orderId);
    assert.deepStrictEqual([order.shippingMethod, order.shippingCost, order.total, order.shipCarrier, order.shipAccountEnc, order.shipAccountLast4, order.shippingAddress], ["standard", 14.5, q.body.orderTotal, "", "", "", "100 Main St"], "back to shipping: the account is gone and the shipping line is back");
    assert.strictEqual(sumLines(lastArgs()), Math.round(q.body.orderTotal * 100));
  });

  // ═══ 10. Admin ═══════════════════════════════════════════════
  test("the settings are in the pricing console's schema, in their own group, and save with a note like any other rule", async () => {
    const schema = (await h.get("/api/admin/pricing/schema", owner)).body;
    const group = schema.groups.find((g) => g.key === "checkout");
    assert.ok(group && /Shipping/.test(group.label));
    const rule = schema.rules.find((r) => r.key === "shippingMethod");
    assert.deepStrictEqual([rule.type, rule.simple, rule.default], ["choice", true, "formula"]);
    assert.strictEqual(schema.rules.find((r) => r.key === "shippingRateTable").placeholder, true);
    assert.strictEqual((await h.put("/api/admin/pricing", { rules: { shippingMethod: "carrier pigeon" }, note: "x" }, owner)).status, 400);
    assert.strictEqual((await h.put("/api/admin/pricing", { rules: { taxMode: "stripe" } }, owner)).status, 400, "a note is required, as for every rule");
    assert.strictEqual((await h.put("/api/admin/pricing", { rules: { taxMode: "stripe" }, note: "free tax for me" }, buyer)).status, 403);
    const history = (await h.get("/api/admin/pricing/history", owner)).body;
    assert.ok(history[0].changedKeys.length > 0 && history[0].note.includes("shipping and tax"));
  });

  test("the admin preview answers in a sentence under the rules on screen, saved or not; customers cannot call it", async () => {
    await settings();
    const now = await h.post("/api/admin/shipping/preview", { weightLb: 3, state: "OH" }, owner);
    assert.strictEqual(now.status, 200, now.text);
    assert.ok(/A 3 lb order .* shipped to OH would be charged \$15\.40 shipping/.test(now.body.sentence));
    const candidate = await h.post("/api/admin/shipping/preview", { rules: { shippingMethod: "table", shippingRateTable: TABLE, shippingLocalPickup: "on", taxMode: "stripe" }, weightLb: 3, state: "OH", subtotal: 150 }, owner);
    assert.ok(/would be charged \$14\.50 shipping/.test(candidate.body.sentence));
    assert.deepStrictEqual(candidate.body.extras, ["Picked up at the shop: no shipping charge."]);
    assert.strictEqual(candidate.body.tax.mode, "stripe");
    assert.strictEqual((await price(2)).body.shipping.mode, "formula", "previewing saves nothing");
    assert.strictEqual((await h.post("/api/admin/shipping/preview", { rules: { shippingMethod: "bogus" } }, owner)).status, 400);
    assert.strictEqual((await h.post("/api/admin/shipping/preview", {}, buyer)).status, 403);
    assert.strictEqual((await h.post("/api/admin/shipping/preview", {})).status, 401);
    assert.ok(!now.text.includes(STREET) && !candidate.text.includes(STREET));
  });

  test("back at the defaults, a fresh quote and checkout are once more exactly the baseline", async () => {
    await settings();
    const q = await price(2);
    assert.deepStrictEqual([q.body.orderTotal, q.body.shippingEstimate, q.body.subtotal], [baseline.orderTotal, baseline.shippingEstimate, baseline.subtotal]);
    const before = h.stripe.customers.length;
    await checkout(q.body.quoteId);
    const args = lastArgs();
    // The keys every session carries since the order-lifecycle work (expiry, the order id on the charge),
    // and nothing from this branch: no customer, no automatic_tax, no tax_id_collection.
    assert.deepStrictEqual(Object.keys(args).sort(), ["allow_promotion_codes", "cancel_url", "customer_email", "expires_at", "line_items", "metadata", "mode", "payment_intent_data", "payment_method_types", "success_url"]);
    assert.deepStrictEqual([args.line_items.length, args.line_items[0].price_data.unit_amount], [1, Math.round(baseline.orderTotal * 100)]);
    assert.ok(!("tax_behavior" in args.line_items[0].price_data));
    assert.strictEqual(h.stripe.customers.length, before);
  });

  await run(h.stop);
})();
