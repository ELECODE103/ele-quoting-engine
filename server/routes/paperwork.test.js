/**
 * Inspection paperwork as an option (owner, 2026-11-11): a first-article
 * inspection report per part number and a certificate of conformance per order,
 * asked for with a checkbox and charged at face value as its own line.
 * Run: `node server/routes/paperwork.test.js`
 *
 * The fee maths first (pure), then the real routes end to end: quote, stored
 * quote, session reload, checkout, Stripe lines, the paid-amount check, the
 * order, both emails, the three PDFs, reorder, and a quote from before the
 * columns existed.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const { pdfText } = require("../testSupport/pdfText");
const ruleSchema = require("../config/ruleSchema");
const { PricingEngine, paperworkCharge } = require("../services/pricingEngine");

const { test, run } = runner("Inspection paperwork option (FAI + CoC)");
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg || "amounts differ"}: ${a} vs ${b}`);
const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const LABEL = "First-article inspection report and certificate of conformance";

(async () => {
  const h = await start();
  const { quotesDB, ordersDB, orderItemsDB } = h.models;
  const documents = require("../services/documents");
  let owner, buyer, partA, partB, partC;

  // ─── The rules ─────────────────────────────────────────────
  test("two admin-editable rules, in the Shop group and the Simple view, defaulting to $45 per part number and $15 per order", () => {
    const perPart = ruleSchema.getDescriptor("paperworkFeePerPart");
    const perOrder = ruleSchema.getDescriptor("paperworkFeePerOrder");
    assert.ok(perPart && perOrder);
    assert.strictEqual(perPart.default, 45);
    assert.strictEqual(perOrder.default, 15);
    for (const d of [perPart, perOrder]) {
      assert.strictEqual(d.group, "shop");
      assert.strictEqual(d.simple, true, `${d.key} shows in the Simple view`);
      assert.strictEqual(d.type, "currency");
      assert.ok(/no margin/i.test(d.help) && /rush multiplier/i.test(d.help) && /quantity discount/i.test(d.help), `${d.key} help says how it is charged`);
      assert.ok(/Starting value/i.test(d.help), `${d.key} help says the default is a placeholder`);
    }
    assert.ok(/each line, not each piece/.test(perPart.help));
    assert.strictEqual(ruleSchema.defaultRules().paperworkFeePerPart, 45);
    assert.strictEqual(ruleSchema.validateRules({ paperworkFeePerPart: -1 }).ok, false, "a negative fee is refused");
  });

  // ─── The maths ─────────────────────────────────────────────
  test("fee = per part number × lines + per order: 0, 1 and 3 lines", () => {
    const r = ruleSchema.defaultRules();
    assert.strictEqual(paperworkCharge(0, r).fee, 0, "no lines, nothing to inspect, no fee");
    assert.strictEqual(paperworkCharge(1, r).fee, 60);
    assert.strictEqual(paperworkCharge(3, r).fee, 150);
    assert.deepStrictEqual(paperworkCharge(3, r), { perPart: 45, perOrder: 15, parts: 3, fee: 150 });
  });

  test("changed rules change the fee; a zero, missing or nonsense rule never makes it negative", () => {
    assert.strictEqual(paperworkCharge(2, { paperworkFeePerPart: 80, paperworkFeePerOrder: 25 }).fee, 185);
    assert.strictEqual(paperworkCharge(2, { paperworkFeePerPart: 0, paperworkFeePerOrder: 0 }).fee, 0);
    assert.strictEqual(paperworkCharge(2, {}).fee, 0);
    assert.strictEqual(paperworkCharge(2, { paperworkFeePerPart: -45, paperworkFeePerOrder: "abc" }).fee, 0);
    assert.strictEqual(paperworkCharge(1, { paperworkFeePerPart: 12.345, paperworkFeePerOrder: 0.005 }).fee, 12.36, "rounded to cents");
  });

  // ─── Through the routes ────────────────────────────────────
  test("option off (the default): no fee, no flag, and the offer says what ticking the box would cost", async () => {
    owner = await h.admin("Owner");
    buyer = await h.register("dana@buyer.test", "Dana Buyer");
    partA = await h.uploadCube();
    const r = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], leadTimeSlug: "standard" });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.paperwork, false);
    assert.strictEqual(r.body.paperworkFee, 0);
    assert.deepStrictEqual(r.body.paperworkOffer, { perPart: 45, perOrder: 15, parts: 1, fee: 60 });
    near(r.body.subtotal + r.body.leadTimeSurcharge + r.body.shippingEstimate, r.body.orderTotal, "off: parts + lead-time fee + shipping = total");
    const stored = quotesDB.getById(r.body.quoteId);
    assert.strictEqual(stored.paperwork, false);
    assert.strictEqual(stored.paperworkFee, 0);
  });

  test("one part number, 10 pieces, option on: +$60.00 exactly, as its own line, and nothing else moves", async () => {
    const off = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], leadTimeSlug: "standard" });
    const on = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], leadTimeSlug: "standard", paperwork: true });
    assert.strictEqual(on.body.paperwork, true);
    assert.strictEqual(on.body.paperworkFee, 60);
    near(on.body.orderTotal, off.body.orderTotal + 60, "the total rises by exactly the fee");
    near(on.body.subtotal, off.body.subtotal, "parts unchanged");
    near(on.body.shippingEstimate, off.body.shippingEstimate, "shipping unchanged");
    near(on.body.lineItems[0].perUnit.final, off.body.lineItems[0].perUnit.final, "unit price unchanged: no margin is taken on the fee through the part");
    near(on.body.subtotal + on.body.leadTimeSurcharge + on.body.paperworkFee + on.body.shippingEstimate, on.body.orderTotal, "subtotal + lead-time fee + paperwork + shipping = total");
    // As printed: every figure rounded to the cent, and they add up to the printed total exactly.
    const c = (n) => Math.round(n * 100);
    for (const k of ["subtotal", "paperworkFee", "orderTotal"]) assert.ok(Math.abs(on.body[k] * 100 - c(on.body[k])) < 1e-6, `${k} is whole cents`);
    assert.strictEqual(c(on.body.subtotal) + c(on.body.leadTimeSurcharge) + c(on.body.paperworkFee) + c(on.body.shippingEstimate), c(on.body.orderTotal), "the printed figures add up to the printed total");
    assert.strictEqual(on.body.lineItems.reduce((s, li) => s + c(li.lineTotal), 0), c(on.body.subtotal), "and the printed lines add up to the subtotal");
    const stored = quotesDB.getById(on.body.quoteId);
    assert.strictEqual(stored.paperwork, true);
    assert.strictEqual(stored.paperworkFee, 60);
    near(stored.orderTotal, on.body.orderTotal);
  });

  test("the fee is per part number, not per piece: 1 piece and 100 pieces pay the same; quantity breaks do not discount it", async () => {
    const one = await h.post("/api/quote", { parts: [h.cncConfig(partA, 1)], paperwork: true });
    const hundred = await h.post("/api/quote", { parts: [h.cncConfig(partA, 100)], paperwork: true });
    assert.strictEqual(one.body.paperworkFee, 60);
    assert.strictEqual(hundred.body.paperworkFee, 60);
    assert.ok(hundred.body.lineItems[0].perUnit.final < one.body.lineItems[0].perUnit.final, "the parts themselves do get the quantity break");
  });

  test("three part numbers: 3 × $45 + $15 = $150", async () => {
    partB = await h.uploadCube();
    partC = await h.uploadCube();
    const parts = [h.cncConfig(partA, 2), h.cncConfig(partB, 5), h.cncConfig(partC, 1)];
    const off = await h.post("/api/quote", { parts });
    const on = await h.post("/api/quote", { parts, paperwork: true });
    assert.strictEqual(off.body.paperworkOffer.fee, 150);
    assert.strictEqual(on.body.paperworkFee, 150);
    near(on.body.orderTotal, off.body.orderTotal + 150);
    near(on.body.subtotal + on.body.leadTimeSurcharge + on.body.paperworkFee + on.body.shippingEstimate, on.body.orderTotal);
  });

  test("an expedited lead time does not scale the fee: the surcharge is the same with and without the paperwork", async () => {
    const off = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], leadTimeSlug: "expedited" });
    const on = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], leadTimeSlug: "expedited", paperwork: true });
    assert.ok(off.body.leadTimeSurcharge > 0, "expedited carries a surcharge");
    assert.strictEqual(on.body.paperworkFee, 60, "still $60, not $60 × the rush multiplier");
    near(on.body.leadTimeSurcharge, off.body.leadTimeSurcharge, "the surcharge is on the parts only");
    near(on.body.leadTimeSurcharge, on.body.subtotal * (on.body.leadTimeMultiplier - 1), "the surcharge is the multiplier on the parts and nothing else");
    near(on.body.orderTotal, off.body.orderTotal + 60);
    for (const o of on.body.leadTimeOptions) {
      near(o.surcharge, off.body.leadTimeOptions.find((x) => x.slug === o.slug).surcharge, `${o.slug} option surcharge ignores the paperwork`);
    }
  });

  test("the engine adds the fee after margin and after the order minimum", () => {
    const rules = { ...ruleSchema.defaultRules(), minimumOrderTotal: 5000 };
    const engine = new PricingEngine(rules);
    const mat = h.models.materialsDB.getAll().find((m) => m.process === "cnc" && m.active);
    const part = h.models.partsDB.getById(partA);
    const input = { parts: [{ partId: partA, fileName: part.fileName, geometry: part.geometry, material: mat, grade: mat.grades?.[0]?.name || "", finish: null, quantity: 2, process: "cnc", subProcess: "milling" }] };
    const off = engine.calculateOrderQuote(input);
    const on = engine.calculateOrderQuote({ ...input, paperwork: true });
    assert.strictEqual(off.orderTotal, 5000, "the order minimum applies to the parts");
    assert.strictEqual(on.orderTotal, 5060, "and the paperwork is added on top of it, in full");
    // Margin: doubling the margin moves the parts and leaves the fee alone.
    const lean = new PricingEngine({ ...ruleSchema.defaultRules(), marginPercent: 0.1 }).calculateOrderQuote({ ...input, paperwork: true });
    const rich = new PricingEngine({ ...ruleSchema.defaultRules(), marginPercent: 0.8 }).calculateOrderQuote({ ...input, paperwork: true });
    assert.ok(rich.subtotal > lean.subtotal);
    assert.strictEqual(lean.paperworkFee, 60);
    assert.strictEqual(rich.paperworkFee, 60);
    // Only a real yes switches it on.
    for (const v of [undefined, null, 0, "", "yes", "true", 1, {}]) assert.strictEqual(engine.calculateOrderQuote({ ...input, paperwork: v }).paperworkFee, 0, `engine ignores paperwork=${JSON.stringify(v)}`);
  });

  test("the owner changes the fees in the pricing console: new quotes use them, a saved quote keeps its held price", async () => {
    // The buyer prices the part while signed in, so from here on it is the buyer's part (review 2026-11-11, F5):
    // the rest of this journey is made with the buyer's session, as it would be in a browser that stayed signed in.
    const held = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], paperwork: true }, buyer);
    assert.strictEqual(held.body.paperworkFee, 60);
    const put = await h.put("/api/admin/pricing", { rules: { paperworkFeePerPart: 80, paperworkFeePerOrder: 25 }, note: "FAI takes longer than I guessed" }, owner);
    assert.strictEqual(put.status, 200, put.text);
    assert.strictEqual(put.body.rules.paperworkFeePerPart, 80);
    const fresh = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], paperwork: true }, buyer);
    assert.strictEqual(fresh.body.paperworkFee, 105);
    assert.deepStrictEqual(fresh.body.paperworkOffer, { perPart: 80, perOrder: 25, parts: 1, fee: 105 });
    assert.strictEqual(quotesDB.getById(held.body.quoteId).paperworkFee, 60, "the earlier quote still holds $60 for its 30 days");
    const bad = await h.put("/api/admin/pricing", { rules: { paperworkFeePerOrder: 99999 }, note: "typo" }, owner);
    assert.strictEqual(bad.status, 400, "out of range is refused, not clamped silently");
    const customer = await h.put("/api/admin/pricing", { rules: { paperworkFeePerPart: 0 }, note: "free for me" }, buyer);
    assert.strictEqual(customer.status, 403, "only the owner sets the fee");
    const reset = await h.put("/api/admin/pricing", { rules: { paperworkFeePerPart: 45, paperworkFeePerOrder: 15 }, note: "back to the starting values" }, owner);
    assert.strictEqual(reset.status, 200);
  });

  // ─── A hand-built request cannot get the paperwork without paying for it ──
  test("a hand-built quote request cannot set, zero or shrink the fee", async () => {
    const free = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], paperwork: true, paperworkFee: 0, paperworkOffer: { fee: 0 }, orderTotal: 1 }, buyer);
    assert.strictEqual(free.body.paperworkFee, 60, "an amount sent by the client is ignored");
    const stored = quotesDB.getById(free.body.quoteId);
    assert.strictEqual(stored.paperworkFee, 60);
    assert.ok(stored.orderTotal > 60);
    const flagOnly = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], paperwork: false, paperworkFee: 60 }, buyer);
    assert.strictEqual(flagOnly.body.paperwork, false);
    assert.strictEqual(flagOnly.body.paperworkFee, 0, "no flag, no fee, whatever amount came with it");
    const perLine = await h.post("/api/quote", { parts: [{ ...h.cncConfig(partA, 10), paperwork: true }] }, buyer);
    assert.strictEqual(perLine.body.paperwork, false, "the option is on the order, not smuggled in on a line");
    assert.ok(!("paperwork" in quotesDB.getById(perLine.body.quoteId).config.parts[0]));
  });

  test("checkout takes the choice from the stored quote: a body that says paperwork=true on a quote without it gets no paperwork", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], leadTimeSlug: "standard" }, buyer);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP, paperwork: true, paperworkFee: 0 }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.paperwork, false, "the order is not flagged for paperwork nobody paid for");
    assert.strictEqual(order.paperworkFee, 0);
    near(order.total, q.body.orderTotal);
    const args = h.stripe.created[h.stripe.created.length - 1];
    assert.strictEqual(args.line_items.length, 1);
    const view = await h.get(`/api/orders/${order.id}`, owner);
    assert.strictEqual(view.body.paperwork, false, "so the admin drawer shows no FAI + CoC flag");
  });

  test("a stored quote whose paperwork fee is larger than its total is refused at checkout", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partA, 1)], paperwork: true }, buyer);
    quotesDB.update(q.body.quoteId, { paperworkFee: 1e6 });
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 409);
    assert.strictEqual(c.body.code, "quote-inconsistent");
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 0);
  });

  // ─── The funnel with the option on ─────────────────────────
  let orderId, quoteId, quoted;
  test("session reload brings the ticked box back", async () => {
    quoted = await h.post("/api/quote", { parts: [h.cncConfig(partA, 10)], leadTimeSlug: "expedited", paperwork: true, process: "cnc" }, buyer);
    quoteId = quoted.body.quoteId;
    const s = await h.get(`/api/quote/${quoteId}/session`, buyer);
    assert.strictEqual(s.body.paperwork, true);
    const view = await h.get(`/api/quote/${quoteId}`, buyer);
    assert.strictEqual(view.body.paperwork, true);
    assert.strictEqual(view.body.paperworkFee, 60);
    near(view.body.subtotal + view.body.leadTimeSurcharge + view.body.paperworkFee + view.body.shippingEstimate, view.body.orderTotal, "what the checkout page shows adds up");
    // Unticking re-prices the same quote back down.
    const off = await h.post("/api/quote", { quoteId, parts: [h.cncConfig(partA, 10)], leadTimeSlug: "expedited", paperwork: false, process: "cnc" }, buyer);
    assert.strictEqual(off.body.quoteId, quoteId);
    near(off.body.orderTotal, quoted.body.orderTotal - 60);
    assert.strictEqual((await h.get(`/api/quote/${quoteId}/session`, buyer)).body.paperwork, false);
    quoted = await h.post("/api/quote", { quoteId, parts: [h.cncConfig(partA, 10)], leadTimeSlug: "expedited", paperwork: true, process: "cnc" }, buyer);
  });

  test("checkout: the order carries the flag and the fee as its own line, and Stripe gets two lines that sum to the total", async () => {
    const c = await h.post("/api/orders/checkout-session", { quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    orderId = c.body.orderId;
    const order = ordersDB.getById(orderId);
    assert.strictEqual(order.paperwork, true);
    assert.strictEqual(order.paperworkFee, 60);
    near(order.total, quoted.body.orderTotal);
    near(order.subtotal, quoted.body.subtotal, "subtotal is the parts");
    assert.ok(order.leadTimeSurcharge > 0 && order.shippingCost > 0);
    near(order.subtotal + order.leadTimeSurcharge + order.paperworkFee + order.shippingCost, order.total, "subtotal + lead-time fee + paperwork + shipping = total");
    // Expedited, so all four lines are in play: as printed (each to the cent) they add up exactly.
    const ct = (n) => Math.round(n * 100);
    assert.strictEqual(ct(order.subtotal) + ct(order.leadTimeSurcharge) + ct(order.paperworkFee) + ct(order.shippingCost), ct(order.total), "the printed order lines add up to the printed total, to the cent");
    assert.strictEqual(ct(quoted.body.subtotal) + ct(quoted.body.leadTimeSurcharge) + ct(quoted.body.paperworkFee) + ct(quoted.body.shippingEstimate), ct(quoted.body.orderTotal), "and so do the quote's");
    const lines = orderItemsDB.query((i) => i.orderId === orderId).reduce((s, i) => s + i.lineTotal, 0);
    near(lines, order.subtotal, "line items add up to the subtotal");
    const args = h.stripe.created[h.stripe.created.length - 1];
    assert.strictEqual(args.line_items.length, 2);
    assert.strictEqual(args.line_items[1].price_data.product_data.name, LABEL);
    assert.strictEqual(args.line_items[1].price_data.unit_amount, 6000);
    assert.strictEqual(args.line_items[0].price_data.unit_amount + 6000, Math.round(order.total * 100), "the two Stripe lines sum to the order total in cents");
  });

  test("the paid-amount check counts the fee: a payment for the parts alone is a mismatch", async () => {
    // A second order, paid short by exactly the paperwork fee.
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partA, 3)], paperwork: true }, buyer);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    const session = h.stripe.sessions[`cs_test_${h.stripe.created.length}`];
    assert.strictEqual(session.amount_subtotal, Math.round(q.body.orderTotal * 100));
    h.pay(session.id, { amount_subtotal: session.amount_subtotal - 6000, amount_total: session.amount_subtotal - 6000 });
    h.sent.length = 0;
    await h.post(`/api/orders/${c.body.orderId}/confirm-payment`, {}, buyer);
    // Not marked paid at all: the order stays unpaid, is flagged, and the shop is told.
    const short = ordersDB.getById(c.body.orderId);
    assert.deepStrictEqual([short.status, short.attention], ["pending_payment", "payment-mismatch"]);
    assert.strictEqual(h.sent.length, 1, "the shop is told; the customer gets no confirmation");
    assert.strictEqual(h.sent[0].to, "owner@shop.test");
    assert.ok(/needs attention/i.test(h.sent[0].subject) && /has NOT been marked paid/.test(h.sent[0].text));
  });

  test("paid in full → order paid; both emails carry the paperwork line and a total that adds up", async () => {
    const session = Object.values(h.stripe.sessions).find((s) => s.metadata.orderId === orderId);
    h.pay(session.id);
    h.sent.length = 0;
    const r = await h.post(`/api/orders/${orderId}/confirm-payment`, {}, buyer);
    assert.strictEqual(r.body.status, "paid");
    const order = ordersDB.getById(orderId);
    const toCustomer = h.sent.find((m) => m.to === "dana@buyer.test");
    const toShop = h.sent.find((m) => m.to === "owner@shop.test");
    assert.ok(toCustomer && toShop);
    for (const m of [toCustomer, toShop]) {
      assert.ok(m.text.includes(`${LABEL}  $60.00`), "the fee is its own line with its amount");
      assert.ok(m.html.includes(LABEL) && m.html.includes("$60.00"));
      assert.ok(m.text.includes(money(order.total)), "and the total is the order total");
      assert.ok(/Expedited lead time/.test(m.text) && /Shipping/.test(m.text));
      // Every priced line in the email sums to the total it states.
      const amounts = m.text.split("\n").filter((l) => /^\s+- /.test(l)).map((l) => Number((l.match(/\$([\d,]+\.\d{2})$/) || [])[1]?.replace(/,/g, ""))).filter(Number.isFinite);
      assert.strictEqual(Math.round(amounts.reduce((a, b) => a + b, 0) * 100), Math.round(order.total * 100), "the email's printed lines add up to its printed total, to the cent");
    }
    assert.ok(/You ordered the inspection paperwork/.test(toCustomer.text));
    assert.ok(/FAI \+ CoC ORDERED/.test(toShop.text), "the shop is told to do it");
    assert.ok(toShop.text.includes("FAI + CoC: ORDERED ($60.00)"));
  });

  test("the order page data and the admin drawer data carry the flag and the fee", async () => {
    const mine = await h.get(`/api/orders/${orderId}`, buyer);
    assert.strictEqual(mine.body.paperwork, true);
    assert.strictEqual(mine.body.paperworkFee, 60);
    near(mine.body.subtotal + mine.body.leadTimeSurcharge + mine.body.paperworkFee + mine.body.shippingCost, mine.body.total);
    const admin = await h.get(`/api/orders/${orderId}`, owner);
    assert.strictEqual(admin.body.paperwork, true);
    const list = await h.get("/api/orders", owner);
    assert.strictEqual(list.body.find((o) => o.id === orderId).paperwork, true);
    const quotes = await h.get("/api/admin/quotes", owner);
    const q = quotes.body.find((x) => x.id === quoteId);
    assert.strictEqual(q.paperwork, true);
    assert.strictEqual(q.paperworkFee, 60);
  });

  test("quote, order confirmation and packing slip PDFs show the line; the order confirmation's figures add up", async () => {
    const order = ordersDB.getById(orderId);
    const items = orderItemsDB.query((i) => i.orderId === orderId);
    const quote = quotesDB.getById(quoteId);

    const q = pdfText(await documents.buildQuotePdf({ quote }));
    assert.ok(q.includes("Inspection paperwork") && q.includes("$60.00"), "quote PDF has the line");
    assert.ok(q.includes(money(quote.orderTotal)), "quote PDF total");
    assert.ok(/ordered\. The first piece of each part number/.test(q.replace(/\n/g, " ")));

    const oc = pdfText(await documents.buildOrderConfirmationPdf({ order, items }));
    const figures = {};
    const lines = oc.split("\n");
    for (const [key, labelText] of [["subtotal", "Subtotal"], ["rush", "Expedited lead time"], ["paperwork", "Inspection paperwork"], ["shipping", "Shipping"], ["total", "Order total"]]) {
      const at = lines.findIndex((l) => l === labelText);
      assert.ok(at >= 0, `order confirmation has a ${labelText} line`);
      figures[key] = Number(lines[at + 1].replace(/[$,]/g, ""));
    }
    assert.strictEqual(figures.paperwork, 60);
    near(figures.total, order.total, "PDF total is the order total");
    near(figures.subtotal + figures.rush + figures.paperwork + figures.shipping, figures.total, "PDF lines add up");

    const ps = pdfText(await documents.buildPackingSlipPdf({ order, items }));
    assert.ok(/First-article inspection report \(ordered\)/.test(ps) && /Certificate of conformance \(ordered\)/.test(ps), "the packing slip lists both for the packer");
    assert.ok(!ps.includes("$"), "still no prices on a packing slip");
  });

  test("without the option the documents say it was not ordered, and the packing slip does not mention it", async () => {
    const plain = ordersDB.getAll().find((o) => !o.paperwork && o.status === "pending_payment");
    const items = orderItemsDB.query((i) => i.orderId === plain.id);
    const oc = pdfText(await documents.buildOrderConfirmationPdf({ order: plain, items })).replace(/\n/g, " ");
    assert.ok(/certificate of conformance: not ordered/.test(oc));
    assert.ok(!/Inspection paperwork\s+\$/.test(oc), "no paperwork amount on the totals");
    const ps = pdfText(await documents.buildPackingSlipPdf({ order: plain, items }));
    assert.ok(!/First-article/.test(ps) && !/Certificate of conformance/.test(ps));
    const q = pdfText(await documents.buildQuotePdf({ quote: quotesDB.getById(plain.quoteId) })).replace(/\n/g, " ");
    assert.ok(/not ordered, so not in this price/.test(q));
  });

  test("reorder keeps the choice, at today's fee", async () => {
    await h.put("/api/admin/pricing", { rules: { paperworkFeePerPart: 50 }, note: "raise the FAI fee" }, owner);
    const r = await h.post(`/api/orders/${orderId}/reorder`, {}, buyer);
    assert.strictEqual(r.status, 201, r.text);
    const q = quotesDB.getById(r.body.quoteId);
    assert.strictEqual(q.paperwork, true);
    assert.strictEqual(q.paperworkFee, 65, "re-priced: $50 + $15");
    assert.strictEqual((await h.get(`/api/quote/${r.body.quoteId}/session`, buyer)).body.paperwork, true);
    const plain = ordersDB.getAll().find((o) => !o.paperwork && o.userId === ordersDB.getById(orderId).userId);
    // (relaunch merge, re-review RR-14) Reorder is refused for an order that was never paid for, and this one is
    // still awaiting payment: assert that, then pay it — the paperwork choice on a reorder is what this case holds.
    if (ordersDB.getById(plain.id).status === "pending_payment") {
      assert.deepStrictEqual([(await h.post(`/api/orders/${plain.id}/reorder`, {}, buyer)).body.code], ["reorder-not-available"]);
      assert.strictEqual((await h.completed(ordersDB.getById(plain.id).stripeSessionId)).status, 200);
    }
    const r2 = await h.post(`/api/orders/${plain.id}/reorder`, {}, buyer);
    assert.strictEqual(r2.status, 201, r2.text);
    assert.strictEqual(quotesDB.getById(r2.body.quoteId).paperwork, false, "an order without it reorders without it");
    await h.put("/api/admin/pricing", { rules: { paperworkFeePerPart: 45 }, note: "back to the starting value" }, owner);
  });

  test("with the order minimum in play the fee is still its own line and the order still adds up", async () => {
    await h.put("/api/admin/pricing", { rules: { minimumOrderTotal: 5000 }, note: "test: force the minimum" }, owner);
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partA, 1)], paperwork: true }, buyer);
    assert.strictEqual(q.body.orderTotal, 5060);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.paperworkFee, 60);
    assert.strictEqual(order.subtotal, 5000, "the minimum is the parts line");
    near(order.subtotal + order.leadTimeSurcharge + order.paperworkFee + order.shippingCost, order.total);
    await h.put("/api/admin/pricing", { rules: { minimumOrderTotal: 25 }, note: "test: restore" }, owner);
  });

  // ─── A quote from before the columns existed ───────────────
  test("an old quote without the paperwork columns still loads, reopens and checks out, with no paperwork", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partA, 4)], leadTimeSlug: "standard", process: "cnc" }, buyer);
    const { getDatabase } = require("../models/database");
    // As a row written by the previous version reads after the ALTER TABLE: no value in either column.
    getDatabase().run("UPDATE quotes SET paperwork = NULL, paperwork_fee = NULL WHERE id = ?", [q.body.quoteId]);
    const view = await h.get(`/api/quote/${q.body.quoteId}`, buyer);
    assert.strictEqual(view.status, 200);
    assert.strictEqual(view.body.paperwork, false);
    assert.strictEqual(view.body.paperworkFee, 0);
    near(view.body.orderTotal, q.body.orderTotal);
    const s = await h.get(`/api/quote/${q.body.quoteId}/session`, buyer);
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.body.paperwork, false);
    assert.strictEqual(s.body.parts.length, 1);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.paperwork, false);
    assert.strictEqual(order.paperworkFee, 0);
    near(order.subtotal + order.leadTimeSurcharge + order.shippingCost, order.total);
    // And an old order row reads the same way.
    getDatabase().run("UPDATE orders SET paperwork = NULL, paperwork_fee = NULL WHERE id = ?", [order.id]);
    const old = await h.get(`/api/orders/${order.id}`, buyer);
    assert.strictEqual(old.body.paperwork, false);
    const pdf = pdfText(await documents.buildOrderConfirmationPdf({ order: ordersDB.getById(order.id), items: orderItemsDB.query((i) => i.orderId === order.id) }));
    assert.ok(pdf.includes(money(order.total)));
    // (relaunch merge, re-review RR-14) an order has to have been paid for before it can be reordered: pay this one.
    assert.strictEqual((await h.completed(ordersDB.getById(order.id).stripeSessionId)).status, 200);
    const reorder = await h.post(`/api/orders/${order.id}/reorder`, {}, buyer);
    assert.strictEqual(reorder.status, 201, reorder.text);
    assert.strictEqual(quotesDB.getById(reorder.body.quoteId).paperwork, false);
  });

  await run(h.stop);
})();
