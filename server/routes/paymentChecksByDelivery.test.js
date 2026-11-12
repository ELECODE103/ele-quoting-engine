/**
 * The payment checks, run once with shipping and tax as they are out of the box and again with each
 * of them switched on. Run: `node server/routes/paymentChecksByDelivery.test.js`
 *
 * The checks themselves have their own suites (priceIntegrity.test.js, orderLifecycle.test.js); what
 * is proved here is that none of them depends on how an order is delivered or whether Stripe adds tax:
 *
 *   1. the amount Stripe is asked for is the order's expected charge (services/expectedCharge.js),
 *      line by line, and never includes tax
 *   2. checkout prices the saved quote again: a stored total that was lowered is not charged, and a
 *      total the page was not showing is not charged without asking
 *   3. the fingerprint: a held price is honoured only for exactly what was priced
 *   4. one quote, one order: a second press, a double click and a paid quote
 *   5. a payment settles the order only at the expected charge (plus the tax Stripe reports, on an
 *      order checked out with tax on); a replayed event changes nothing; a wrong amount is flagged
 *   6. refunds and disputes are read against what was actually collected
 *
 * Stripe is stubbed at the boundary (testSupport/harness.js); its stand-in for Stripe Tax adds 7 % to
 * every taxable line of a session opened with automatic_tax.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Payment checks with shipping and tax off and on");
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" };
const TABLE = [{ maxLb: 1, price: 9 }, { maxLb: 5, price: 14.5 }, { maxLb: 20, price: 30 }, { maxLb: 50, price: 61 }];
const OWNER = "owner@shop.test";
const cents = (n) => Math.round(Number(n) * 100);

const MODES = [
  { name: "defaults (weight formula, we ship, tax off)", rules: {}, body: {}, taxed: false },
  { name: "rate table, Stripe Tax on", rules: { shippingMethod: "table", shippingRateTable: TABLE, taxMode: "stripe" }, body: {}, taxed: true },
  { name: "pickup, Stripe Tax on", rules: { shippingLocalPickup: "on", taxMode: "stripe" }, body: { shippingOption: "pickup" }, taxed: true },
  { name: "buyer's carrier account, rate table, tax off", rules: { shippingMethod: "table", shippingRateTable: TABLE, shippingCarrierAccount: "on" }, body: { shippingOption: "carrier-account", carrier: "UPS", carrierAccount: "A1B2C3D4" }, taxed: false },
];

(async () => {
  // One buyer makes dozens of quotes and checkouts in a few seconds. The per-account limits have their
  // own suites (priceIntegrity, senderQuotas, pricingAvailability).
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  for (const k of ["QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY", "QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY"]) process.env[k] = "100000";
  for (const k of ["QUOTE_DRAFT_KB_PER_CLIENT", "QUOTE_DRAFT_KB_PER_ACCOUNT"]) process.env[k] = "100000";
  for (const k of ["QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR", "QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR"]) process.env[k] = "3600";
  const h = await start();
  const { quotesDB, ordersDB, materialsDB } = h.models;
  const { paymentSessionsDB, paymentEventsDB } = h.lifecycle;
  const { expectedCharge } = require("../services/expectedCharge");
  const ruleSchema = require("../config/ruleSchema");
  let owner, buyer, partId;

  const DEFAULTS = {
    shippingMethod: "formula", shippingRateTable: ruleSchema.RULE_BY_KEY.shippingRateTable.default, shippingPackagingPercent: 0.10, shippingPackagingLb: 1,
    shippingOversizeLongestIn: 48, shippingMaxParcelLb: 50, shippingFreeOverSubtotal: 0, shippingCarrierAccount: "off", shippingLocalPickup: "off",
    taxMode: "off", taxProductCode: "", taxShipping: "goods", taxIdCollection: "off", taxExemptDeclare: "off", taxTrustDeclaredExemptions: "off",
  };
  async function settings(over = {}) {
    const r = await h.put("/api/admin/pricing", { rules: { ...DEFAULTS, ...over }, note: "test: shipping and tax settings" }, owner);
    assert.strictEqual(r.status, 200, r.text);
  }
  const order = (id) => ordersDB.getById(id);
  const price = (qty = 2) => h.post("/api/quote", { parts: [h.cncConfig(partId, qty)], leadTimeSlug: "standard" }, buyer);
  const sumLines = (args) => args.line_items.reduce((s, li) => s + li.price_data.unit_amount * (li.quantity || 1), 0);
  const toShop = () => h.sent.filter((m) => (Array.isArray(m.to) ? m.to.includes(OWNER) : m.to === OWNER));
  const sessionOf = (orderId) => h.stripe.sessions[order(orderId).stripeSessionId];
  const openSessions = (orderId) => paymentSessionsDB.query((s) => s.orderId === orderId && s.status === "open");

  test("setup: the owner, a buyer and a part", async () => {
    owner = await h.admin("Owner");
    buyer = await h.register("dana@buyer.test", "Dana Buyer");
    partId = await h.uploadCube();
  });

  for (const mode of MODES) {
    const tag = `[${mode.name}]`;
    const checkout = (quoteId, extra = {}) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...mode.body, ...extra }, buyer);
    /** A quote and the total this delivery choice comes to, as the checkout page is told it. */
    async function quoted(qty = 2) {
      const q = await price(qty);
      assert.strictEqual(q.status, 200, q.text);
      const view = (await h.get(`/api/quote/${q.body.quoteId}`, buyer)).body;
      const method = mode.body.shippingOption || "ship";
      const option = view.checkout.options.find((o) => o.method === method);
      assert.ok(option && option.available !== false && option.total > 0, `${tag} the page offers ${method} with a total`);
      return { quoteId: q.body.quoteId, quote: q.body, total: option.total };
    }
    /** An unpaid order made through the real checkout route. */
    async function pending(qty = 2) {
      const q = await quoted(qty);
      const c = await checkout(q.quoteId, { confirmedTotal: q.total });
      assert.strictEqual(c.status, 200, c.text);
      return { ...q, orderId: c.body.orderId, session: sessionOf(c.body.orderId) };
    }
    async function paid(qty = 2) {
      const p = await pending(qty);
      const r = await h.completed(p.session.id);
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(order(p.orderId).status, "paid", `${tag} ${order(p.orderId).attentionNote || ""}`);
      return p;
    }

    test(`${tag} settings`, async () => { await settings(mode.rules); });

    test(`${tag} 1. Stripe is asked for the order's expected charge, line by line, and never for tax`, async () => {
      const before = h.stripe.created.length;
      const p = await pending(2);
      const o = order(p.orderId);
      const args = h.stripe.created[h.stripe.created.length - 1];
      assert.strictEqual(h.stripe.created.length, before + 1, "one session");
      assert.strictEqual(cents(o.total), cents(p.total), "the order is made at the total the page showed for this delivery choice");
      assert.strictEqual(o.tax || 0, 0, "an unpaid order carries no tax");
      assert.strictEqual(expectedCharge(o).cents, cents(o.total));
      assert.strictEqual(sumLines(args), expectedCharge(o).cents, "the lines add up to the expected charge");
      assert.strictEqual(paymentSessionsDB.getById(p.session.id).amountCents, expectedCharge(o).cents, "and the session is recorded at it");
      assert.ok(Math.abs((o.subtotal || 0) + (o.leadTimeSurcharge || 0) + (o.paperworkFee || 0) + (o.shippingCost || 0) - o.total) < 0.011, "the order's own parts add up to its total");
      assert.strictEqual(Boolean(args.automatic_tax && args.automatic_tax.enabled), mode.taxed, "automatic tax exactly when the order was checked out with tax on");
      assert.strictEqual(o.taxMode, mode.taxed ? "stripe" : "off");
      assert.strictEqual("customer_email" in args, !mode.taxed, "a taxed session is tied to a Stripe Customer at the tax address, any other to the buyer's email");
    });

    test(`${tag} 2. checkout prices the quote again: a lowered stored total is not charged; a total the page was not showing is not charged without asking`, async () => {
      const q = await quoted(3);
      const orders = () => ordersDB.query((o) => o.quoteId === q.quoteId).length;
      // The stored row is lowered (as a tampered or corrupted database would have it).
      const real = quotesDB.getById(q.quoteId);
      quotesDB.update(q.quoteId, { orderTotal: 1, subtotal: 0.5 });
      const low = await checkout(q.quoteId);
      assert.deepStrictEqual([low.status, low.body.code], [409, "quote-changed"], low.text);
      assert.strictEqual(orders(), 0, "no order at the lowered figure");
      assert.ok(low.body.newTotal > 1, "the answer carries today's price");
      // Back as it was priced. The page says it was showing another total: nothing is charged until the buyer has seen the real one.
      quotesDB.update(q.quoteId, { orderTotal: real.orderTotal, subtotal: real.subtotal, lineItems: real.lineItems, shippingEstimate: real.shippingEstimate, gate: real.gate, config: real.config });
      const stale = await checkout(q.quoteId, { confirmedTotal: cents(q.total - 5) / 100 });
      assert.deepStrictEqual([stale.status, stale.body.code], [409, "quote-changed"], stale.text);
      assert.strictEqual(cents(stale.body.newTotal), cents(q.total), "it is told the total for THIS delivery choice");
      assert.strictEqual(orders(), 0);
      const ok = await checkout(q.quoteId, { confirmedTotal: q.total });
      assert.strictEqual(ok.status, 200, ok.text);
      assert.strictEqual(cents(order(ok.body.orderId).total), cents(q.total));
    });

    test(`${tag} 3. the fingerprint: a held price is honoured for exactly what was priced, and for nothing else`, async () => {
      const held = await quoted(2);
      const altered = await quoted(2);
      // The owner raises the material's price by a fifth: both quotes are inside their 30-day hold.
      const mat = materialsDB.getAll().find((m) => m.slug === h.cncConfig(partId).materialSlug);
      materialsDB.update(mat.id, { pricePerKg: mat.pricePerKg * 1.2 });
      require("../routes/api").loadPricingRules();
      try {
        const today = await quoted(2);
        assert.ok(today.quote.subtotal > held.quote.subtotal, "today's price is higher");
        // Exactly what was priced: charged at the held parts price.
        const a = await checkout(held.quoteId, { confirmedTotal: held.total });
        assert.strictEqual(a.status, 200, a.text);
        assert.strictEqual(cents(order(a.body.orderId).total), cents(held.total));
        assert.strictEqual(h.stripe.created.length > 0 && sumLines(h.stripe.created[h.stripe.created.length - 1]), cents(held.total));
        // The same quote with a different fingerprint on record (its parts or setup are not what was priced): today's price, after asking.
        const row = quotesDB.getById(altered.quoteId);
        quotesDB.update(altered.quoteId, { config: { ...row.config, integrity: { ...row.config.integrity, fingerprint: "0".repeat(64) } } });
        const b = await checkout(altered.quoteId, { confirmedTotal: altered.total });
        assert.deepStrictEqual([b.status, b.body.code], [409, "quote-changed"], b.text);
        assert.strictEqual(ordersDB.query((o) => o.quoteId === altered.quoteId).length, 0);
        assert.ok(b.body.newTotal > altered.quote.orderTotal - 0.005, "and it is told a price that is not the old one's");
      } finally {
        materialsDB.update(mat.id, { pricePerKg: mat.pricePerKg });
        require("../routes/api").loadPricingRules();
      }
    });

    test(`${tag} 4. one quote, one order: a second press and a double click get the same order and the same card page; a paid quote is used up`, async () => {
      const q = await quoted(4);
      const sessionsBefore = h.stripe.created.length;
      const customersBefore = h.stripe.customers.length;
      const [a, b] = await Promise.all([checkout(q.quoteId, { confirmedTotal: q.total }), checkout(q.quoteId, { confirmedTotal: q.total })]);
      assert.deepStrictEqual([a.status, b.status], [200, 200], `${a.text} ${b.text}`);
      assert.strictEqual(a.body.orderId, b.body.orderId, "a double click makes one order");
      assert.strictEqual(a.body.sessionUrl, b.body.sessionUrl, "and one card page");
      const again = await checkout(q.quoteId, { confirmedTotal: q.total });
      assert.deepStrictEqual([again.status, again.body.orderId, again.body.sessionUrl], [200, a.body.orderId, a.body.sessionUrl], "pressing pay again resumes it");
      assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 1);
      assert.strictEqual(h.stripe.created.length, sessionsBefore + 1, "one session was made for all three");
      assert.strictEqual(h.stripe.customers.length, customersBefore + (mode.taxed ? 1 : 0), "and at most one Stripe Customer");
      assert.strictEqual(openSessions(a.body.orderId).length, 1);
      await h.completed(sessionOf(a.body.orderId).id);
      assert.strictEqual(order(a.body.orderId).status, "paid");
      const used = await checkout(q.quoteId, { confirmedTotal: q.total });
      assert.deepStrictEqual([used.status, used.body.code, used.body.orderId], [409, "quote-already-ordered", a.body.orderId]);
      assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 1);
    });

    test(`${tag} 5. a payment settles the order only at its expected charge${mode.taxed ? " plus the tax Stripe reports" : ""}; a replay changes nothing; a wrong amount is flagged, not paid`, async () => {
      const p = await pending(2);
      const preTax = expectedCharge(order(p.orderId)).cents;
      const taxCents = mode.taxed ? Math.round(sumLines(h.stripe.created[h.stripe.created.length - 1]) * h.stripe.taxRate) : 0;
      assert.strictEqual(p.session.amount_total, preTax + taxCents, "what Stripe will collect");
      h.sent.length = 0;
      const first = await h.completed(p.session.id);
      assert.strictEqual(first.status, 200, first.text);
      let o = order(p.orderId);
      assert.deepStrictEqual([o.status, o.attention || null], ["paid", null], o.attentionNote || "");
      assert.strictEqual(cents(o.amountPaid), preTax + taxCents, "what was collected");
      assert.strictEqual(cents(o.tax || 0), taxCents, "the tax Stripe reported is on the order");
      assert.strictEqual(cents(o.total), preTax + taxCents, "and in its total");
      assert.strictEqual(expectedCharge(o).cents, preTax, "the expected charge is still what our lines came to");
      const mails = h.sent.length;
      assert.ok(mails >= 2, "the buyer's confirmation and the shop's notice");
      // The same event again, and the return page after it: nothing moves, nothing is sent twice.
      await h.webhook("checkout.session.completed", p.session);
      const back = await h.post(`/api/orders/${p.orderId}/confirm-payment`, {}, buyer);
      assert.strictEqual(back.status, 200, back.text);
      o = order(p.orderId);
      assert.deepStrictEqual([o.status, cents(o.total), cents(o.tax || 0), h.sent.length], ["paid", preTax + taxCents, taxCents, mails]);
      assert.strictEqual(paymentEventsDB.query((e) => e.orderId === p.orderId && e.kind === "order-paid").length, 1);

      // An amount that is not this order's: flagged for the owner, never marked paid.
      const w = await pending(3);
      const wrong = expectedCharge(order(w.orderId)).cents - 500;
      h.sent.length = 0;
      await h.completed(w.session.id, { amount_subtotal: wrong, amount_total: wrong + (mode.taxed ? 35 : 0), total_details: { amount_tax: mode.taxed ? 35 : 0, amount_discount: 0, amount_shipping: 0 } });
      const flagged = order(w.orderId);
      assert.deepStrictEqual([flagged.status, flagged.attention, cents(flagged.tax || 0)], ["pending_payment", "payment-mismatch", 0]);
      assert.strictEqual(toShop().length, 1, "the shop is told once");
      assert.strictEqual(h.sent.length, 1, "and the buyer is told nothing");
    });

    test(`${tag} 6. refunds and disputes are read against what was collected`, async () => {
      const p = await paid(2);
      const o = order(p.orderId);
      const collected = cents(o.amountPaid);
      const part = mode.taxed ? cents(o.tax) : 500; // with tax on: the owner refunds the tax after reading a certificate
      assert.ok(part > 0 && part < collected);
      const charge = (refunded) => ({ id: `ch_${p.orderId.slice(0, 8)}`, object: "charge", payment_intent: o.stripePaymentId, amount: collected, amount_captured: collected, amount_refunded: refunded, refunded: refunded >= collected, currency: "usd", metadata: {} });
      const partial = await h.webhook("charge.refunded", charge(part));
      assert.deepStrictEqual([partial.status, partial.body.outcome], [200, "partially-refunded"], partial.text);
      assert.deepStrictEqual([order(p.orderId).status, cents(order(p.orderId).refundedAmount)], ["paid", part], "a part refund leaves the order where it is");
      const full = await h.webhook("charge.refunded", charge(collected));
      assert.strictEqual(full.status, 200, full.text);
      assert.deepStrictEqual([order(p.orderId).status, cents(order(p.orderId).refundedAmount)], ["refunded", collected], "refunding everything that was collected (tax included) closes it as refunded");

      const d = await paid(3);
      const od = order(d.orderId);
      h.sent.length = 0;
      const opened = await h.webhook("charge.dispute.created", { id: `dp_${d.orderId.slice(0, 8)}`, object: "dispute", charge: "ch_d", payment_intent: od.stripePaymentId, amount: cents(od.amountPaid), currency: "usd", reason: "product_not_received", status: "needs_response" });
      assert.deepStrictEqual([opened.status, opened.body.outcome], [200, "dispute-opened"], opened.text);
      assert.deepStrictEqual([order(d.orderId).status, order(d.orderId).attention, order(d.orderId).disputeStatus], ["paid", "dispute", "open"]);
      assert.strictEqual(toShop().length, 1);
    });

    if (!mode.body.shippingOption) {
      test(`${tag} 7. back from the card page with another address: the same order; ${mode.taxed ? "a new card page taxed at the new address, and the old one closed" : "the same card page"}`, async () => {
        const q = await quoted(5);
        const a = await checkout(q.quoteId, { confirmedTotal: q.total });
        assert.strictEqual(a.status, 200, a.text);
        const first = sessionOf(a.body.orderId);
        const sessionsBefore = h.stripe.created.length;
        const customersBefore = h.stripe.customers.length;
        const b = await checkout(q.quoteId, { confirmedTotal: q.total, shippingAddress: "9 Other Rd", shippingCity: "Chicago", shippingState: "IL", shippingZip: "60601" });
        assert.deepStrictEqual([b.status, b.body.orderId], [200, a.body.orderId], b.text);
        const o = order(a.body.orderId);
        assert.deepStrictEqual([o.shippingAddress, o.shippingState, o.shippingZip], ["9 Other Rd", "IL", "60601"], "the order ships to the address as now entered");
        if (mode.taxed) {
          assert.strictEqual(h.stripe.created.length, sessionsBefore + 1, "a new session");
          assert.strictEqual(h.stripe.customers.length, customersBefore + 1, "tied to a new Stripe Customer");
          const customer = h.stripe.customers[h.stripe.customers.length - 1];
          assert.deepStrictEqual([customer.shipping.address.state, customer.shipping.address.postal_code], ["IL", "60601"], "at the new address");
          assert.notStrictEqual(b.body.sessionUrl, a.body.sessionUrl);
          assert.ok(h.stripe.expired.includes(first.id), "the page taxed at the old address can no longer be paid");
          assert.deepStrictEqual(openSessions(a.body.orderId).map((x) => x.id), [o.stripeSessionId], "one open session: the new one");
        } else {
          assert.strictEqual(h.stripe.created.length, sessionsBefore, "no new session: nothing on Stripe's page depends on the address");
          assert.strictEqual(b.body.sessionUrl, a.body.sessionUrl);
        }
        // Either way it is one order, and paying it settles it.
        await h.completed(o.stripeSessionId);
        assert.strictEqual(order(a.body.orderId).status, "paid", order(a.body.orderId).attentionNote || "");
        assert.strictEqual(ordersDB.query((x) => x.quoteId === q.quoteId).length, 1);
      });
    }
  }

  test("back at the defaults", async () => { await settings(); });

  await run(h.stop);
})().catch((err) => { console.error(err); process.exit(1); });
