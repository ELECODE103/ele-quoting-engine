/**
 * What happens to an order after a Stripe session exists, end to end against the real routes
 * (Stripe stubbed at the boundary, emails captured). Run: `node server/routes/orderLifecycle.test.js`
 *
 * Each block is one finding of the independent payment-path review (2026-11-11), turned from
 * the reviewer's proof of concept (tools/security/review-payments/poc-06, 07, 09, 10) into a
 * permanent case: F-06 payment checks, F-07 refunds and disputes, F-08 sessions, duplicate and
 * late payments, expiry; F-09 firm-quote link bound to its terms; F-10 single-line fields;
 * F-11 one quote, one order; F-17 promotion codes; the manual moves and their audit trail;
 * the return URLs; the shop notices. F-18 (startup) is server/security/stripeStartup.test.js.
 */
const assert = require("assert");
const jwt = require("jsonwebtoken");
const { start, runner } = require("../testSupport/harness");
const { pdfText } = require("../testSupport/pdfText");

const { test, run } = runner("Order lifecycle after the Stripe session");
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "1 Test St", shippingCity: "Testville", shippingState: "IL", shippingZip: "60000", shippingCountry: "US" };
const OWNER = "owner@shop.test";
const tokenFrom = (m) => (m.text.match(/https:\/\/shop\.test\/firm-quote\/(\S+)/) || [])[1];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const h = await start();
  // (merge 2026-11-12) This suite checks out dozens of times as one buyer. The per-account checkout limiter
  // from the price-integrity work (12 per 15 minutes, read per request; its own test is in priceIntegrity.test.js)
  // is raised to its ceiling here so that what is under test is the lifecycle, not the limiter.
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  const { ordersDB, orderItemsDB, quotesDB, rfqsDB } = h.models;
  const { paymentSessionsDB, paymentEventsDB, adminAuditDB } = h.lifecycle;
  // Loaded where used, so that on a tree without them each case fails on its own account.
  const lifecycle = { sweepExpired: (...a) => require("../services/orderLifecycle").sweepExpired(...a), promotionCodesAllowed: () => require("../services/orderLifecycle").promotionCodesAllowed() };
  const manualMoves = () => require("../services/orderState").MANUAL;
  let owner, buyer, other, partId, n = 0;

  const order = (id) => ordersDB.getById(id);
  const toShop = (re) => h.sent.filter((m) => (Array.isArray(m.to) ? m.to.includes(OWNER) : m.to === OWNER) && (!re || re.test(m.subject)));
  const events = (orderId, kind) => paymentEventsDB.query((e) => e.orderId === orderId && (!kind || e.kind === kind));
  const openSessions = (orderId) => paymentSessionsDB.query((s) => s.orderId === orderId && s.status === "open");

  /** An unpaid instant order: { orderId, quoteId, session } */
  async function pending(quantity = 2, token = buyer, part = partId) {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(part, quantity)], leadTimeSlug: "standard" }, token);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, token);
    assert.strictEqual(c.status, 200, c.text);
    return { orderId: c.body.orderId, quoteId: q.body.quoteId, session: h.stripe.sessions[order(c.body.orderId).stripeSessionId], url: c.body.sessionUrl };
  }
  /** A paid instant order. */
  async function paid(quantity = 2) {
    const p = await pending(quantity);
    const r = await h.completed(p.session.id);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(order(p.orderId).status, "paid");
    return p;
  }
  /** A firm quote that has been sent: { id, token, email } */
  async function quoted(total = 1500, days = 10, extra = {}) {
    const email = `fq${++n}@oem.test`;
    const c = await h.form("/api/rfq", { contactName: `Pat Buyer`, email, company: "OEM Co", notes: `job ${n}`, quantities: "250", process: "cnc" });
    assert.strictEqual(c.status, 201, c.text);
    h.sent.length = 0;
    const q = await h.put(`/api/rfq/admin/${c.body.rfqId}`, { status: "quoted", quotedTotal: total, quotedLeadDays: days, ...extra }, owner);
    assert.strictEqual(q.status, 200, q.text);
    return { id: c.body.rfqId, email, token: tokenFrom(h.sent.find((m) => m.to === email)) };
  }
  const accept = (token, body) => h.post(`/api/rfq/quote/${token}/accept`, { ...SHIP, ...body });

  test("setup: the owner, two buyers, a part", async () => {
    owner = await h.admin("Owner");
    buyer = await h.register("dana@buyer.test", "Dana Buyer");
    other = await h.register("olive@other.test", "Olive Other");
    partId = await h.uploadCube();
  });

  // ═══ F-08 · sessions ═════════════════════════════════════════
  test("F-08: a session is made with an expiry, promotion codes off, and is recorded with its order", async () => {
    const before = Date.now();
    const p = await pending();
    const args = h.stripe.created[h.stripe.created.length - 1];
    const minutes = (args.expires_at * 1000 - before) / 60000;
    assert.ok(minutes > 119 && minutes < 121, `expires_at is two hours out (got ${minutes.toFixed(1)} min)`);
    assert.strictEqual(args.allow_promotion_codes, false);
    assert.strictEqual(args.payment_intent_data.metadata.orderId, p.orderId, "the charge will name its order");
    const rec = paymentSessionsDB.getById(p.session.id);
    assert.deepStrictEqual([rec.orderId, rec.status, rec.amountCents, rec.currency], [p.orderId, "open", Math.round(order(p.orderId).total * 100), "usd"]);
    assert.ok(order(p.orderId).sessionExpiresAt, "the order knows when its session lapses");
  });

  test("F-08: pressing pay again hands out the same session; a stale one is expired at Stripe before a new one is made", async () => {
    const p = await pending(3);
    const again = await h.post("/api/orders/checkout-session", { quoteId: p.quoteId, ...SHIP }, buyer);
    assert.deepStrictEqual([again.body.orderId, again.body.sessionUrl], [p.orderId, p.url], "same order, same payment page");
    assert.strictEqual(openSessions(p.orderId).length, 1);
    // The stored session is about to lapse: it is not handed out again.
    paymentSessionsDB.update(p.session.id, { expiresAt: new Date(Date.now() + 60000).toISOString() });
    const third = await h.post("/api/orders/checkout-session", { quoteId: p.quoteId, ...SHIP }, buyer);
    assert.strictEqual(third.status, 200, third.text);
    assert.notStrictEqual(third.body.sessionUrl, p.url);
    assert.ok(h.stripe.expired.includes(p.session.id), "the old session was expired through the Stripe API");
    assert.strictEqual(h.stripe.sessions[p.session.id].status, "expired");
    assert.deepStrictEqual(openSessions(p.orderId).map((s) => s.id), [order(p.orderId).stripeSessionId], "one open session, the new one");
    // Stripe then reports the old session expired: that says nothing about the order.
    const ev = await h.webhook("checkout.session.expired", h.stripe.sessions[p.session.id]);
    assert.strictEqual(ev.status, 200);
    assert.strictEqual(order(p.orderId).status, "pending_payment");
  });

  test("F-08: if the old session cannot be confirmed closed, no second one is opened", async () => {
    const p = await pending(4);
    paymentSessionsDB.update(p.session.id, { expiresAt: new Date(Date.now() + 60000).toISOString() });
    const made = h.stripe.created.length;
    h.stripe.failExpire = true; // the call to Stripe fails; the session is still open there
    const r = await h.post("/api/orders/checkout-session", { quoteId: p.quoteId, ...SHIP }, buyer);
    assert.deepStrictEqual([r.status, r.body.code], [502, "payment-session-busy"]);
    assert.strictEqual(h.stripe.created.length, made, "no new session");
    assert.deepStrictEqual(openSessions(p.orderId).map((s) => s.id), [p.session.id]);
  });

  test("F-08: if the old session turns out to be paid, the order is settled and nobody is sent to pay again", async () => {
    const p = await pending(5);
    paymentSessionsDB.update(p.session.id, { expiresAt: new Date(Date.now() + 60000).toISOString() });
    h.pay(p.session.id); // paid at Stripe; no webhook has arrived yet
    const made = h.stripe.created.length;
    const r = await h.post("/api/orders/checkout-session", { quoteId: p.quoteId, ...SHIP }, buyer);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.sessionUrl, `https://shop.test/orders/${p.orderId}?paid=true`, "sent to the order page, not to a payment page");
    assert.strictEqual(h.stripe.created.length, made);
    assert.strictEqual(order(p.orderId).status, "paid");
  });

  // ═══ F-06 · the payment checks ═══════════════════════════════
  test("F-06: a payment report with no amount, with amount 0, in another currency, or for a session we did not make is not marked paid: flagged, shop told once", async () => {
    const cases = [
      ["no amount", (s) => ({ ...s, amount_total: undefined, amount_subtotal: undefined }), /carries no amount/],
      ["amount 0", (s) => ({ ...s, amount_total: 0, amount_subtotal: 0 }), /Stripe reports \$0\.00/],
      ["another currency", (s) => ({ ...s, currency: "jpy" }), /payment is in JPY/],
      ["no currency", (s) => ({ ...s, currency: undefined }), /unnamed currency/],
      ["a fractional amount", (s) => ({ ...s, amount_total: s.amount_total + 0.5 }), /carries no amount/],
      ["a session made elsewhere", (s) => ({ ...s, id: "cs_live_made_elsewhere" }), /not one we opened for this order/],
      ["a lower amount", (s) => ({ ...s, amount_total: 100, amount_subtotal: 100 }), /Stripe reports \$1\.00/],
    ];
    for (const [name, change, why] of cases) {
      const p = await pending();
      h.sent.length = 0;
      const object = change({ ...p.session, payment_status: "paid", status: "complete", payment_intent: "pi_x" });
      const r = await h.webhook("checkout.session.completed", object);
      assert.strictEqual(r.status, 200, `${name}: ${r.text}`);
      const o = order(p.orderId);
      assert.deepStrictEqual([o.status, o.attention], ["pending_payment", "payment-mismatch"], name);
      assert.ok(why.test(o.attentionNote), `${name}: ${o.attentionNote}`);
      assert.strictEqual(o.paidAt || null, null, name);
      assert.strictEqual(h.sent.length, 1, `${name}: one email`);
      assert.strictEqual(toShop(/needs attention: payment does not match the order/).length, 1, `${name}: ${h.sent[0].subject}`);
      // Delivered again (Stripe retries): nothing more happens.
      await h.webhook("checkout.session.completed", object);
      assert.strictEqual(h.sent.length, 1, `${name}: no second email`);
      assert.strictEqual(events(p.orderId, "payment-mismatch").length, 1, name);
    }
  });

  test("F-06: an unpaid session changes nothing and flags nothing; the right payment then settles the order", async () => {
    const p = await pending();
    h.sent.length = 0;
    await h.webhook("checkout.session.completed", { ...p.session, payment_status: "unpaid" });
    assert.deepStrictEqual([order(p.orderId).status, order(p.orderId).attention || null, h.sent.length], ["pending_payment", null, 0]);
    const r = await h.completed(p.session.id);
    assert.strictEqual(r.body.outcome, "paid");
    const o = order(p.orderId);
    assert.deepStrictEqual([o.status, o.paidVia, o.stripePaymentId, o.amountPaid, o.discountAmount, o.currency], ["paid", "card", p.session.payment_intent, o.total, 0, "usd"]);
    assert.strictEqual(paymentSessionsDB.getById(p.session.id).outcome, "settled");
    assert.strictEqual(h.sent.length, 2, "confirmation to the buyer, new-order notice to the shop");
    assert.strictEqual(events(p.orderId, "order-paid").length, 1);
  });

  test("F-06: both confirm-payment routes make the same checks", async () => {
    const p = await pending();
    h.pay(p.session.id, { amount_total: 100, amount_subtotal: 100 });
    h.sent.length = 0;
    const r = await h.post(`/api/orders/${p.orderId}/confirm-payment`, {}, buyer);
    assert.deepStrictEqual([r.status, r.body.status, r.body.paymentUnderReview], [200, "pending_payment", true]);
    assert.strictEqual(order(p.orderId).attention, "payment-mismatch");
    assert.strictEqual(toShop(/needs attention/).length, 1);

    const f = await quoted(900, 5);
    await accept(f.token, { method: "card" });
    const fo = ordersDB.query((o) => o.rfqId === f.id)[0];
    h.pay(fo.stripeSessionId, { currency: "eur" });
    h.sent.length = 0;
    const view = await h.post(`/api/rfq/quote/${f.token}/confirm-payment`, {});
    assert.strictEqual(view.status, 200);
    assert.deepStrictEqual([view.body.order.status, view.body.order.paymentUnderReview], ["pending_payment", true]);
    assert.strictEqual(order(fo.id).attention, "payment-mismatch");
    assert.strictEqual(toShop(/needs attention/).length, 1);
    assert.ok(!("attentionNote" in view.body.order), "the reason stays with the shop");
  });

  // ═══ F-08 · payments that arrive for an order that is not waiting ═══
  test("F-08: a second payment for a paid order is recorded, the order flagged, the shop emailed once; the order stays paid", async () => {
    const p = await pending(6);
    const first = p.session.id;
    paymentSessionsDB.update(first, { expiresAt: new Date(Date.now() + 60000).toISOString() });
    await h.post("/api/orders/checkout-session", { quoteId: p.quoteId, ...SHIP }, buyer); // a second session; the first is expired at Stripe
    const second = order(p.orderId).stripeSessionId;
    await h.completed(second);
    assert.strictEqual(order(p.orderId).status, "paid");
    // The first session was paid all the same (the buyer's other tab got there a moment before it was closed).
    h.sent.length = 0;
    const late = { ...h.stripe.sessions[first], payment_status: "paid", status: "complete", payment_intent: "pi_second_payment" };
    const r = await h.webhook("checkout.session.completed", late, { id: "evt_duplicate_1" });
    assert.deepStrictEqual([r.status, r.body.outcome], [200, "duplicate-payment"]);
    const o = order(p.orderId);
    assert.deepStrictEqual([o.status, o.attention], ["paid", "duplicate-payment"]);
    assert.ok(/second card payment/.test(o.attentionNote));
    assert.strictEqual(h.sent.length, 1);
    const mail = toShop()[0];
    assert.ok(/^Order [0-9A-F]{8} needs attention: duplicate payment — \$[\d,.]+$/.test(mail.subject), mail.subject);
    assert.ok(mail.text.includes("pi_second_payment") && /refund it/i.test(mail.text));
    assert.deepStrictEqual(events(p.orderId, "duplicate-payment").map((e) => [e.notified, e.paymentIntent]), [[true, "pi_second_payment"]]);
    // The same event again, and the same session under a new event id: no second email.
    assert.strictEqual((await h.webhook("checkout.session.completed", late, { id: "evt_duplicate_1" })).body.duplicate, true);
    await h.webhook("checkout.session.completed", late);
    assert.strictEqual(h.sent.length, 1);
    // The customer's view does not carry the flag; the owner's does, with the money history.
    const mine = await h.get(`/api/orders/${p.orderId}`, buyer);
    assert.ok(!("attention" in mine.body) && !("attentionNote" in mine.body) && !("paymentEvents" in mine.body));
    const admin = await h.get(`/api/orders/${p.orderId}`, owner);
    assert.strictEqual(admin.body.attention, "duplicate-payment");
    assert.deepStrictEqual(admin.body.paymentEvents.map((e) => e.kind), ["order-paid", "duplicate-payment"]);
  });

  test("F-08: cancelling an unpaid order expires its session at Stripe; a payment that arrives anyway is flagged and reported", async () => {
    const p = await pending(7);
    const cancel = await h.put(`/api/orders/${p.orderId}/status`, { status: "cancelled", reason: "customer called it off" }, owner);
    assert.strictEqual(cancel.status, 200, cancel.text);
    assert.ok(h.stripe.expired.includes(p.session.id));
    assert.strictEqual(paymentSessionsDB.getById(p.session.id).status, "replaced");
    h.sent.length = 0;
    const r = await h.webhook("checkout.session.completed", { ...p.session, payment_status: "paid", status: "complete", payment_intent: "pi_late" });
    assert.deepStrictEqual([r.status, r.body.outcome], [200, "late-payment"]);
    const o = order(p.orderId);
    assert.deepStrictEqual([o.status, o.attention, o.paidAt || null], ["cancelled", "late-payment", null]);
    assert.strictEqual(toShop(/needs attention: late payment/).length, 1);
    assert.strictEqual(h.sent.length, 1, "nothing goes to the customer");
  });

  test("F-08: cancelling an order whose session was paid a moment ago does not lose the payment", async () => {
    const p = await pending(8);
    h.pay(p.session.id); // paid at Stripe; the webhook has not arrived
    h.sent.length = 0;
    const cancel = await h.put(`/api/orders/${p.orderId}/status`, { status: "cancelled" }, owner);
    assert.strictEqual(cancel.status, 200);
    assert.deepStrictEqual([cancel.body.status, cancel.body.attention], ["cancelled", "late-payment"]);
    assert.strictEqual(toShop(/late payment/).length, 1);
  });

  // ═══ I-2 · expiry ════════════════════════════════════════════
  test("an expired session closes the unpaid order out as expired and gives the quote back", async () => {
    const p = await pending(9);
    assert.strictEqual(quotesDB.getById(p.quoteId).status, "ordered");
    h.stripe.sessions[p.session.id].status = "expired";
    const r = await h.webhook("checkout.session.expired", h.stripe.sessions[p.session.id]);
    assert.deepStrictEqual([r.status, r.body.outcome], [200, "order-expired"]);
    const o = order(p.orderId);
    assert.deepStrictEqual([o.status, Boolean(o.expiredAt)], ["expired", true]);
    assert.strictEqual(quotesDB.getById(p.quoteId).status, "draft", "the quote can be used again");
    assert.strictEqual(events(p.orderId, "order-expired").length, 1);
    // The buyer comes back and checks out the same quote: a new order.
    const again = await h.post("/api/orders/checkout-session", { quoteId: p.quoteId, ...SHIP }, buyer);
    assert.strictEqual(again.status, 200, again.text);
    assert.notStrictEqual(again.body.orderId, p.orderId);
    // A payment that still turns up for the expired order is not dropped.
    h.sent.length = 0;
    await h.webhook("checkout.session.completed", { ...p.session, payment_status: "paid", status: "complete", payment_intent: "pi_after_expiry" });
    assert.deepStrictEqual([order(p.orderId).status, order(p.orderId).attention], ["expired", "late-payment"]);
    assert.strictEqual(toShop(/late payment/).length, 1);
  });

  test("the sweep closes unpaid orders past their session's expiry, settles one that was paid unheard, and leaves alone what it should", async () => {
    const stale = await pending(10);
    const paidUnheard = await pending(11);
    const flagged = await pending(12);
    const unreachable = await pending(13);
    const fresh = await pending(14);
    // A phone order: made by the owner, no card session at all.
    const pq = await h.post("/api/quote", { parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard" }, owner);
    const phone = await h.post("/api/orders", { quoteId: pq.body.quoteId, ...SHIP }, owner);
    assert.strictEqual(phone.status, 201, phone.text);

    h.pay(paidUnheard.session.id);
    ordersDB.update(flagged.orderId, { attention: "payment-mismatch", attentionNote: "x" });
    const past = new Date(Date.now() - 3600e3).toISOString();
    for (const p of [stale, paidUnheard, flagged, unreachable]) ordersDB.update(p.orderId, { sessionExpiresAt: past });
    const realRetrieve = require("../services/stripeClient").get().checkout.sessions.retrieve;
    require("../services/stripeClient").get().checkout.sessions.retrieve = async (id) => { if (id === unreachable.session.id) throw new Error("network"); return realRetrieve(id); };
    h.sent.length = 0;
    let result;
    try { result = await lifecycle.sweepExpired(); } finally { require("../services/stripeClient").get().checkout.sessions.retrieve = realRetrieve; }
    assert.deepStrictEqual([order(stale.orderId).status, order(paidUnheard.orderId).status, order(flagged.orderId).status, order(unreachable.orderId).status, order(fresh.orderId).status, order(phone.body.orderId).status],
      ["expired", "paid", "pending_payment", "pending_payment", "pending_payment", "pending_payment"]);
    assert.ok(result.expired >= 1 && result.settled >= 1 && result.skipped >= 1, JSON.stringify(result));
    assert.ok(h.stripe.expired.includes(stale.session.id), "the lapsed session is closed at Stripe too");
    assert.strictEqual(quotesDB.getById(stale.quoteId).status, "draft");
    assert.ok(h.sent.some((m) => m.to === "dana@buyer.test" && /confirmed/.test(m.subject)), "the order that was paid gets its confirmation");
    // Within the grace period nothing is closed.
    const justNow = await pending(15);
    ordersDB.update(justNow.orderId, { sessionExpiresAt: new Date(Date.now() - 60e3).toISOString() });
    await lifecycle.sweepExpired();
    assert.strictEqual(order(justNow.orderId).status, "pending_payment");
  });

  test("an expired firm-quote order gives the quote back: it can be accepted again, on a PO this time", async () => {
    const f = await quoted(2200, 9);
    assert.strictEqual((await accept(f.token, { method: "card" })).status, 201);
    const first = ordersDB.query((o) => o.rfqId === f.id)[0];
    ordersDB.update(first.id, { sessionExpiresAt: new Date(Date.now() - 3600e3).toISOString() });
    await lifecycle.sweepExpired();
    assert.strictEqual(order(first.id).status, "expired");
    const rfq = rfqsDB.getById(f.id);
    assert.deepStrictEqual([rfq.status, rfq.orderId || null, rfq.acceptedVia || null], ["quoted", null, null]);
    const view = await h.get(`/api/rfq/quote/${f.token}`);
    assert.deepStrictEqual([view.status, view.body.status, view.body.order], [200, "quoted", null]);
    const po = await accept(f.token, { method: "po", poNumber: "PO-4410" });
    assert.strictEqual(po.status, 201, po.text);
    assert.deepStrictEqual(ordersDB.query((o) => o.rfqId === f.id).map((o) => o.status).sort(), ["expired", "pending_po"]);
  });

  // ═══ F-11 · one quote, one order ═════════════════════════════
  test("F-11: two card accepts at the same moment make one order and get the same payment page", async () => {
    const f = await quoted(3000, 10);
    h.stripe.delayMs = 120; // Stripe's network call takes a while: this is the window the race needs
    const made = h.stripe.created.length;
    let a, b;
    try { [a, b] = await Promise.all([accept(f.token, { method: "card" }), accept(f.token, { method: "card" })]); } finally { h.stripe.delayMs = 0; }
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 201]);
    assert.strictEqual(a.body.sessionUrl, b.body.sessionUrl, "the same Stripe session");
    assert.strictEqual(a.body.order, b.body.order, "the same order");
    assert.strictEqual(ordersDB.query((o) => o.rfqId === f.id).length, 1);
    assert.strictEqual(h.stripe.created.length, made + 1, "one session was made");
    // A third, later accept (back from the Stripe page): still the same order and the same page.
    const c = await accept(f.token, { method: "card" });
    assert.deepStrictEqual([c.status, c.body.repeat, c.body.sessionUrl], [200, true, a.body.sessionUrl]);
  });

  test("F-11: a card accept and a PO accept at the same moment make one order; two PO accepts make one order", async () => {
    const f = await quoted(3000, 10);
    h.stripe.delayMs = 120;
    let card, po;
    try { [card, po] = await Promise.all([accept(f.token, { method: "card" }), accept(f.token, { method: "po", poNumber: "PO-RACE" })]); } finally { h.stripe.delayMs = 0; }
    assert.deepStrictEqual([card.status, po.status, po.body.code], [201, 409, "already-accepted"]);
    assert.deepStrictEqual(ordersDB.query((o) => o.rfqId === f.id).map((o) => o.paymentMethod), ["card"]);

    const g = await quoted(800, 4);
    h.sent.length = 0;
    const [p1, p2] = await Promise.all([accept(g.token, { method: "po", poNumber: "PO-7781" }), accept(g.token, { method: "po", poNumber: "PO-7781" })]);
    assert.deepStrictEqual([p1.status, p2.status].sort(), [200, 201]);
    assert.strictEqual(ordersDB.query((o) => o.rfqId === g.id).length, 1);
    assert.strictEqual(toShop(/accepted on a purchase order/).length, 1, "the shop is told once");
    // A different PO number afterwards is a second acceptance, and is refused.
    assert.strictEqual((await accept(g.token, { method: "po", poNumber: "PO-9999" })).body.code, "already-accepted");
    assert.strictEqual(events(ordersDB.query((o) => o.rfqId === g.id)[0].id, "po-order").length, 1);
  });

  test("F-11: when the session cannot be made, both of two simultaneous accepts fail, the claim is released and the quote is open", async () => {
    const f = await quoted(1200, 5);
    const orders = ordersDB.getAll().length, lines = orderItemsDB.getAll().length;
    h.stripe.delayMs = 80; h.stripe.failNext = true;
    let a, b;
    try { [a, b] = await Promise.all([accept(f.token, { method: "card" }), accept(f.token, { method: "card" })]); } finally { h.stripe.delayMs = 0; }
    assert.deepStrictEqual([a.status, b.status], [502, 502]);
    assert.deepStrictEqual([rfqsDB.getById(f.id).status, rfqsDB.getById(f.id).orderId || null], ["quoted", null]);
    assert.deepStrictEqual([ordersDB.getAll().length, orderItemsDB.getAll().length], [orders, lines]);
    assert.strictEqual((await accept(f.token, { method: "card" })).status, 201, "and it can be accepted afterwards");
  });

  test("instant checkout: two requests at the same moment make one order and one session (the order is written before anything waits on Stripe)", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 16)], leadTimeSlug: "standard" }, buyer);
    const made = h.stripe.created.length;
    h.stripe.delayMs = 120;
    let a, b;
    try { [a, b] = await Promise.all([1, 2].map(() => h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer))); } finally { h.stripe.delayMs = 0; }
    assert.deepStrictEqual([a.status, b.status], [200, 200]);
    assert.strictEqual(a.body.orderId, b.body.orderId);
    assert.strictEqual(a.body.sessionUrl, b.body.sessionUrl);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 1);
    assert.strictEqual(h.stripe.created.length, made + 1);
    assert.strictEqual(openSessions(a.body.orderId).length, 1);
  });

  test("instant checkout: a re-price that arrives while the checkout is waiting on Stripe makes a new quote; the ordered one is untouched", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 1)], leadTimeSlug: "standard" }, buyer);
    h.stripe.delayMs = 150;
    let landed, reprice;
    try {
      const flying = h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
      await sleep(40);
      reprice = await h.post("/api/quote", { quoteId: q.body.quoteId, parts: [h.cncConfig(partId, 90)], leadTimeSlug: "standard" }, buyer);
      landed = await flying;
    } finally { h.stripe.delayMs = 0; }
    assert.notStrictEqual(reprice.body.quoteId, q.body.quoteId, "the re-price forked");
    const stored = quotesDB.getById(q.body.quoteId);
    assert.deepStrictEqual([stored.status, stored.lineItems[0].quantity, stored.orderTotal], ["ordered", 1, order(landed.body.orderId).total]);
  });

  test("confirm-payment twice and the webhook, all at once: one move to paid, one pair of emails", async () => {
    const p = await pending(17);
    h.pay(p.session.id);
    h.sent.length = 0;
    const rs = await Promise.all([
      h.post(`/api/orders/${p.orderId}/confirm-payment`, {}, buyer),
      h.post(`/api/orders/${p.orderId}/confirm-payment`, {}, buyer),
      h.webhook("checkout.session.completed", h.stripe.sessions[p.session.id]),
    ]);
    assert.deepStrictEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.strictEqual(order(p.orderId).status, "paid");
    assert.strictEqual(h.sent.length, 2, `one confirmation and one shop notice, got ${h.sent.map((m) => m.subject).join(" | ")}`);
    assert.strictEqual(events(p.orderId, "order-paid").length, 1);
    assert.ok(!order(p.orderId).attention, "the same payment seen three times is not a duplicate payment");
  });

  test("reorder twice at once: two draft quotes, nothing ordered, nothing charged", async () => {
    const p = await paid(2);
    const [orders, sessions] = [ordersDB.getAll().length, h.stripe.created.length];
    const [a, b] = await Promise.all([h.post(`/api/orders/${p.orderId}/reorder`, {}, buyer), h.post(`/api/orders/${p.orderId}/reorder`, {}, buyer)]);
    assert.deepStrictEqual([a.status, b.status], [201, 201]);
    assert.deepStrictEqual([quotesDB.getById(a.body.quoteId).status, quotesDB.getById(b.body.quoteId).status], ["draft", "draft"]);
    assert.deepStrictEqual([ordersDB.getAll().length, h.stripe.created.length], [orders, sessions]);
  });

  // ═══ F-07 · refunds and disputes ═════════════════════════════
  test("F-07: a full refund moves the order to refunded and out of the production queue; the shop is told once", async () => {
    const p = await paid(3);
    const o = order(p.orderId);
    const cents = Math.round(o.total * 100);
    const inQueue = async () => (await h.get("/api/orders/admin/queue", owner)).body.some((x) => x.id === p.orderId);
    assert.strictEqual(await inQueue(), true);
    h.sent.length = 0;
    const charge = { id: "ch_full", object: "charge", payment_intent: o.stripePaymentId, amount: cents, amount_captured: cents, amount_refunded: cents, refunded: true, currency: "usd", metadata: {} };
    const r = await h.webhook("charge.refunded", charge, { id: "evt_refund_full" });
    assert.deepStrictEqual([r.status, r.body.outcome], [200, "refunded"]);
    const after = order(p.orderId);
    assert.deepStrictEqual([after.status, after.refundedAmount, Boolean(after.refundedAt)], ["refunded", o.total, true]);
    assert.strictEqual(await inQueue(), false);
    assert.strictEqual(toShop(/refunded in full/).length, 1);
    assert.strictEqual(h.sent.length, 1);
    await h.webhook("charge.refunded", charge, { id: "evt_refund_full" });
    await h.webhook("charge.refunded", charge);
    assert.strictEqual(h.sent.length, 1, "a replay does nothing");
    // Refunded is the end: the owner cannot move it on.
    const move = await h.put(`/api/orders/${p.orderId}/status`, { status: "in_production" }, owner);
    assert.deepStrictEqual([move.status, move.body.code], [409, "transition-not-allowed"]);
  });

  test("F-07: a partial refund keeps the order active and shows the amount; a second one adds up; the last one refunds it", async () => {
    const p = await paid(4);
    await h.put(`/api/orders/${p.orderId}/status`, { status: "in_production" }, owner);
    const o = order(p.orderId);
    const cents = Math.round(o.total * 100);
    const charge = (refunded) => ({ id: "ch_part", payment_intent: o.stripePaymentId, amount: cents, amount_captured: cents, amount_refunded: refunded, refunded: refunded >= cents, currency: "usd" });
    h.sent.length = 0;
    assert.strictEqual((await h.webhook("charge.refunded", charge(2500))).body.outcome, "partially-refunded");
    assert.deepStrictEqual([order(p.orderId).status, order(p.orderId).refundedAmount], ["in_production", 25]);
    assert.strictEqual(toShop(/partly refunded — \$25\.00/).length, 1);
    await h.webhook("charge.refunded", charge(4000));
    assert.deepStrictEqual([order(p.orderId).status, order(p.orderId).refundedAmount], ["in_production", 40]);
    const view = await h.get(`/api/orders/${p.orderId}`, buyer);
    assert.deepStrictEqual([view.body.status, view.body.refundedAmount], ["in_production", 40], "the customer sees the amount");
    assert.strictEqual((await h.get(`/api/orders/${p.orderId}`, owner)).body.payment.partiallyRefunded, true);
    await h.webhook("charge.refunded", charge(cents));
    assert.strictEqual(order(p.orderId).status, "refunded");
  });

  test("F-07: refund.updated reads the charge from Stripe; a refund that fails afterwards is flagged", async () => {
    const p = await paid(5);
    const o = order(p.orderId);
    const cents = Math.round(o.total * 100);
    h.stripe.charges.ch_upd = { id: "ch_upd", payment_intent: o.stripePaymentId, amount: cents, amount_captured: cents, amount_refunded: 1000, refunded: false, currency: "usd" };
    assert.strictEqual((await h.webhook("refund.updated", { id: "re_1", object: "refund", charge: "ch_upd", payment_intent: o.stripePaymentId, amount: 1000, status: "succeeded" })).body.outcome, "partially-refunded");
    assert.strictEqual(order(p.orderId).refundedAmount, 10);
    // Days later the refund fails: Stripe's running total goes back to zero.
    h.stripe.charges.ch_upd.amount_refunded = 0;
    h.sent.length = 0;
    await h.webhook("refund.updated", { id: "re_1", object: "refund", charge: "ch_upd", payment_intent: o.stripePaymentId, amount: 1000, status: "failed" });
    assert.deepStrictEqual([order(p.orderId).refundedAmount, order(p.orderId).attention, order(p.orderId).status], [0, "refund-problem", "paid"]);
    assert.strictEqual(toShop(/needs attention: refund problem/).length, 1);
  });

  test("F-07: a dispute flags the order and tells the shop at once; nothing is cancelled; won clears it, lost keeps it flagged", async () => {
    const p = await paid(6);
    const o = order(p.orderId);
    const cents = Math.round(o.total * 100);
    h.sent.length = 0;
    const opened = await h.webhook("charge.dispute.created", { id: "dp_1", object: "dispute", charge: "ch_d", payment_intent: o.stripePaymentId, amount: cents, currency: "usd", reason: "product_not_received", status: "needs_response" });
    assert.deepStrictEqual([opened.status, opened.body.outcome], [200, "dispute-opened"]);
    let now = order(p.orderId);
    assert.deepStrictEqual([now.status, now.attention, now.disputeStatus], ["paid", "dispute", "open"]);
    assert.strictEqual(toShop(/payment disputed/).length, 1);
    assert.ok(/has NOT been cancelled/.test(toShop()[0].text) && toShop()[0].text.includes("product not received"));
    assert.ok((await h.get("/api/orders/admin/queue", owner)).body.some((x) => x.id === p.orderId && x.attention === "dispute"), "still in the queue, flagged");
    const mine = await h.get(`/api/orders/${p.orderId}`, buyer);
    assert.ok(!("disputeStatus" in mine.body), "the dispute state is the shop's");
    await h.webhook("charge.dispute.closed", { id: "dp_1", payment_intent: o.stripePaymentId, amount: cents, status: "won" });
    now = order(p.orderId);
    assert.deepStrictEqual([now.status, now.attention || null, now.disputeStatus], ["paid", null, "won"]);

    const q = await paid(7);
    const qo = order(q.orderId);
    await h.webhook("charge.dispute.created", { id: "dp_2", payment_intent: qo.stripePaymentId, amount: 5000, status: "needs_response" });
    h.sent.length = 0;
    await h.webhook("charge.dispute.closed", { id: "dp_2", payment_intent: qo.stripePaymentId, amount: 5000, status: "lost" });
    now = order(q.orderId);
    assert.deepStrictEqual([now.status, now.attention, now.disputeStatus], ["paid", "dispute", "lost"]);
    assert.strictEqual(toShop(/dispute lost/).length, 1);
  });

  test("F-07: refunding the extra payment of a double-paid order does not refund the order; it clears the flag", async () => {
    const p = await paid(8);
    const extra = { ...p.session, id: "cs_extra_for_refund", payment_status: "paid", payment_intent: "pi_extra_refund" };
    paymentSessionsDB.insert({ id: "cs_extra_for_refund", orderId: p.orderId, status: "open", amountCents: p.session.amount_total, currency: "usd", promoAllowed: false });
    await h.webhook("checkout.session.completed", extra);
    assert.strictEqual(order(p.orderId).attention, "duplicate-payment");
    h.sent.length = 0;
    const r = await h.webhook("charge.refunded", { id: "ch_extra", payment_intent: "pi_extra_refund", amount: p.session.amount_total, amount_captured: p.session.amount_total, amount_refunded: p.session.amount_total, refunded: true });
    assert.strictEqual(r.body.outcome, "extra-refund");
    const o = order(p.orderId);
    assert.deepStrictEqual([o.status, o.attention || null, o.refundedAmount || 0], ["paid", null, 0]);
    assert.strictEqual(toShop(/extra payment refunded/).length, 1);
  });

  test("events that are not ours are acknowledged and ignored (a retry storm would get the endpoint disabled)", async () => {
    const none = await h.webhook("checkout.session.completed", { id: "cs_other_product", amount_total: 500, currency: "usd", payment_status: "paid", metadata: {} });
    assert.deepStrictEqual([none.status, none.body.ignored], [200, "no-order-id"]);
    const unknown = await h.webhook("checkout.session.completed", { id: "cs_x", amount_total: 500, currency: "usd", payment_status: "paid", metadata: { orderId: "00000000-0000-4000-8000-000000000000" } });
    assert.deepStrictEqual([unknown.status, unknown.body.ignored], [200, "order-not-found"]);
    const refund = await h.webhook("charge.refunded", { id: "ch_none", payment_intent: "pi_not_ours", amount_refunded: 100 });
    assert.deepStrictEqual([refund.status, refund.body.outcome], [200, "unmatched"]);
    assert.deepStrictEqual([(await h.webhook("invoice.paid", { id: "in_1" })).body.ignored], ["event-type"]);
    assert.strictEqual((await h.raw("POST", "/api/stripe/webhook", { body: "{not json", headers: { "Content-Type": "application/json" } })).status, 400);
  });

  // ═══ F-17 · promotion codes ══════════════════════════════════
  test("F-17: promotion codes are off; a discount reported anyway is a mismatch", async () => {
    assert.strictEqual(lifecycle.promotionCodesAllowed(), false);
    const settings = await h.get("/api/orders/admin/payment-settings", owner);
    assert.deepStrictEqual([settings.status, settings.body.promotionCodes, settings.body.sessionMinutes], [200, false, 120]);
    assert.strictEqual((await h.get("/api/orders/admin/payment-settings", buyer)).status, 403);
    const p = await pending();
    const half = Math.round(p.session.amount_total / 2);
    await h.completed(p.session.id, { amount_total: p.session.amount_total - half, total_details: { amount_discount: half } });
    const o = order(p.orderId);
    assert.deepStrictEqual([o.status, o.attention], ["pending_payment", "payment-mismatch"]);
    assert.ok(/promotion codes are switched off/.test(o.attentionNote));
  });

  test("F-17: with promotion codes switched on, a discounted payment is paid, and the order, the email and the PDF state the discount and the amount paid", async () => {
    process.env.STRIPE_PROMOTION_CODES = "on";
    try {
      const p = await pending(3);
      assert.strictEqual(h.stripe.created[h.stripe.created.length - 1].allow_promotion_codes, true);
      const total = p.session.amount_total;
      const discount = Math.round(total * 0.2);
      h.sent.length = 0;
      const r = await h.completed(p.session.id, { amount_total: total - discount, total_details: { amount_discount: discount } });
      assert.strictEqual(r.body.outcome, "paid");
      const o = order(p.orderId);
      assert.deepStrictEqual([o.status, o.total, o.discountAmount, o.amountPaid], ["paid", total / 100, discount / 100, (total - discount) / 100]);
      const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const mail = h.sent.find((m) => m.to === "dana@buyer.test");
      assert.ok(mail.text.includes(`Total paid: ${money(total - discount)}`), mail.text);
      assert.ok(mail.text.includes(`Promotion code (${money(discount)} off)`) && mail.text.includes(money(total)));
      const shop = toShop(/New order/)[0];
      assert.ok(shop.text.includes(`Card, ${money(total - discount)} collected`) && /Promotion code: /.test(shop.text));
      const pdf = await h.raw("GET", `/api/pdf/order-confirmation/${p.orderId}`, { token: owner });
      const text = pdfText(Buffer.from(await (await fetch(`${h.base}/api/pdf/order-confirmation/${p.orderId}`, { headers: { Authorization: `Bearer ${owner}`, "X-Forwarded-For": "198.51.100.77" } })).arrayBuffer())).replace(/\n/g, " ");
      assert.strictEqual(pdf.status, 200);
      assert.ok(text.includes("Promotion code") && text.includes(`-${money(discount)}`) && text.includes("Amount paid") && text.includes(money(total - discount)) && text.includes(money(total)), text.slice(-600));
      // A discount that does not add up is still a mismatch.
      const q = await pending(4);
      await h.completed(q.session.id, { amount_total: 100, total_details: { amount_discount: 100 } });
      assert.strictEqual(order(q.orderId).attention, "payment-mismatch");
      // A session made while codes were off does not honour a discount because the switch is on now.
    } finally { delete process.env.STRIPE_PROMOTION_CODES; }
  });

  test("F-17: a 100% promotion code collects nothing: the order is not released, and the owner is told", async () => {
    process.env.STRIPE_PROMOTION_CODES = "on";
    try {
      for (const status of ["no_payment_required", "paid"]) {
        const p = await pending();
        h.sent.length = 0;
        const r = await h.completed(p.session.id, { payment_status: status, amount_total: 0, total_details: { amount_discount: p.session.amount_total }, payment_intent: null });
        assert.deepStrictEqual([r.status, r.body.outcome], [200, "zero-payment"], status);
        const o = order(p.orderId);
        assert.deepStrictEqual([o.status, o.attention, o.paidAt || null], ["pending_payment", "zero-payment", null], status);
        assert.strictEqual(toShop(/needs attention: nothing was collected/).length, 1, status);
        assert.strictEqual(h.sent.length, 1, "no confirmation goes to the customer");
        // The owner decides: mark it paid by hand, with a reason.
        const ok = await h.put(`/api/orders/${p.orderId}/status`, { status: "paid", reason: "launch promotion, approved", paidVia: "other" }, owner);
        assert.deepStrictEqual([ok.status, ok.body.status, ok.body.payment.paidByHand], [200, "paid", true]);
      }
    } finally { delete process.env.STRIPE_PROMOTION_CODES; }
  });

  // ═══ F-09 · the link is for the terms that were sent ═════════
  test("F-09: a total changed without re-sending kills the emailed link until the quote is sent again", async () => {
    const f = await quoted(1500, 10);
    const seen = await h.get(`/api/rfq/quote/${f.token}`);
    assert.deepStrictEqual([seen.status, seen.body.quotedTotal, seen.body.linkAmount], [200, 1500, 1500]);
    h.sent.length = 0;
    const edit = await h.put(`/api/rfq/admin/${f.id}`, { quotedTotal: 2500 }, owner);
    assert.deepStrictEqual([edit.status, edit.body.quoteSent, edit.body.linkInvalidated, edit.body.acceptUrl, edit.body.needsResend], [200, false, true, null, true]);
    assert.strictEqual(h.sent.length, 0);
    for (const r of [await h.get(`/api/rfq/quote/${f.token}`), await accept(f.token, { method: "card" }), await accept(f.token, { method: "po", poNumber: "PO-1" }), await h.post(`/api/rfq/quote/${f.token}/confirm-payment`, {})]) {
      assert.deepStrictEqual([r.status, r.body.code], [409, "quote-changed"]);
    }
    assert.strictEqual(ordersDB.query((o) => o.rfqId === f.id).length, 0);
    assert.strictEqual((await h.get("/api/rfq/admin/list", owner)).body.find((x) => x.id === f.id).needsResend, true);
    // Sending it again issues a link for the new amount; the old link is superseded.
    const resent = await h.put(`/api/rfq/admin/${f.id}`, { status: "quoted" }, owner);
    assert.deepStrictEqual([resent.body.quoteSent, resent.body.needsResend], [true, false]);
    const fresh = tokenFrom(h.sent.find((m) => m.to === f.email));
    assert.strictEqual((await h.get(`/api/rfq/quote/${f.token}`)).body.code, "link-superseded");
    assert.deepStrictEqual([(await h.get(`/api/rfq/quote/${fresh}`)).body.linkAmount, jwt.decode(fresh).amt], [2500, 250000]);
    // The page says which total the buyer was looking at; a different one is refused.
    { const stale = await accept(fresh, { method: "card", seenTotal: 1500 }); assert.deepStrictEqual([stale.body.code, stale.body.linkReplaced], ["quote-changed", undefined]); } // a stale page: reload shows the quote
    const ok = await accept(fresh, { method: "card", seenTotal: 2500 });
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual(h.stripe.created[h.stripe.created.length - 1].line_items[0].price_data.unit_amount, 250000);
  });

  test("F-09: a change to the lines, the lead time or what the price covers kills the link too; a saved total of 0 cannot be accepted", async () => {
    for (const change of [{ quotedLeadDays: 30 }, { paperwork: true }, { quoteNote: "now covers 100 pcs, not 250" }]) {
      const f = await quoted(1500, 10);
      await h.put(`/api/rfq/admin/${f.id}`, change, owner);
      assert.strictEqual((await accept(f.token, { method: "po", poNumber: "PO-1" })).body.code, "quote-changed", JSON.stringify(change));
    }
    // Lines: the quantity the firm price covers.
    // (merge 2026-11-12) A part belongs to whoever uploaded it (part ownership, review F5): the suite's shared part
    // is the buyer's by now, so this visitor without an account uploads their own and prices it with its edit key.
    const linesPart = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [h.cncConfig(linesPart, 500)], leadTimeSlug: "standard" });
    assert.strictEqual(q.status, 200, q.text);
    const c = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: "Lee Lines", email: "lines@oem.test" });
    h.sent.length = 0;
    await h.put(`/api/rfq/admin/${c.body.rfqId}`, { status: "quoted", quotedTotal: 4000, quotedLeadDays: 12, partQuantities: { [linesPart]: 500 } }, owner);
    const token = tokenFrom(h.sent.find((m) => m.to === "lines@oem.test"));
    await h.put(`/api/rfq/admin/${c.body.rfqId}`, { partQuantities: { [linesPart]: 250 } }, owner);
    assert.strictEqual((await h.get(`/api/rfq/quote/${token}`)).body.code, "quote-changed");
    // (relaunch merge) …and says which kind of "changed" it is, so the page can tell the buyer the link is dead rather than "reload".
    assert.strictEqual((await h.get(`/api/rfq/quote/${token}`)).body.linkReplaced, true);
    // Total saved as 0 on a quote that is out.
    const z = await quoted(1500, 10);
    // (merge 2026-11-12) Two defences meet here. The admin save now refuses a total of 0 on a quote that is out
    // (price-integrity work, F-09b), so that state can no longer be made through the route; the quote stays at what
    // was sent. The accept path's own refusal (this branch) is still proven below, on a row written the way the
    // earlier code would have saved it.
    const zeroSave = await h.put(`/api/rfq/admin/${z.id}`, { quotedTotal: 0 }, owner);
    assert.deepStrictEqual([zeroSave.status, zeroSave.body.code, rfqsDB.getById(z.id).quotedTotal], [400, "quoted-total-invalid", 1500]);
    rfqsDB.update(z.id, { quotedTotal: 0 });
    assert.strictEqual((await accept(z.token, { method: "po", poNumber: "PO-ZERO" })).status, 409);
    rfqsDB.update(z.id, { sentTerms: null }); // even with nothing to compare against, a quote with no price is not an order
    const zero = await accept(z.token, { method: "po", poNumber: "PO-ZERO" });
    assert.strictEqual(zero.status, 409);
    assert.strictEqual(ordersDB.query((o) => o.rfqId === z.id).length, 0);
  });

  test("F-09: a quote sent before terms were recorded is stamped the first time it is opened, and protected from then on; an accepted quote's terms cannot be edited", async () => {
    const f = await quoted(700, 6);
    const rfq = rfqsDB.getById(f.id);
    rfqsDB.update(f.id, { sentTerms: null });
    // A link as the earlier version issued it: no amount inside.
    const legacy = jwt.sign({ rfqId: rfq.id, v: rfq.quoteSentAt, exp: Math.floor(Date.parse(rfq.validUntil) / 1000) },
      require("crypto").createHmac("sha256", "test-secret").update("rfq-quote-link-v1").digest(), { audience: "rfq-quote", algorithm: "HS256" });
    const view = await h.get(`/api/rfq/quote/${legacy}`);
    assert.deepStrictEqual([view.status, view.body.quotedTotal, view.body.linkAmount], [200, 700, 700]);
    assert.ok(rfqsDB.getById(f.id).sentTerms, "stamped");
    await h.put(`/api/rfq/admin/${f.id}`, { quotedTotal: 7000 }, owner);
    assert.strictEqual((await accept(legacy, { method: "po", poNumber: "PO-1" })).body.code, "quote-changed");
    await h.put(`/api/rfq/admin/${f.id}`, { quotedTotal: 700 }, owner); // put back exactly as sent: the link works again
    assert.strictEqual((await accept(legacy, { method: "po", poNumber: "PO-1" })).status, 201);
    const after = await h.put(`/api/rfq/admin/${f.id}`, { quotedTotal: 9 }, owner);
    assert.deepStrictEqual([after.status, after.body.code], [409, "quote-accepted"]);
    assert.strictEqual((await h.put(`/api/rfq/admin/${f.id}`, { notes: "called to confirm", quotedTotal: 700 }, owner)).status, 200, "a note, with the same terms, is fine");
  });

  // ═══ F-10 · single-line fields ═══════════════════════════════
  test("F-10: a PO number that is not one printable line is refused, not rewritten", async () => {
    const f = await quoted(4200, 10);
    const bad = ["PO-778\nPAID IN FULL - SHIP TODAY", "PO-9\r\nBcc: someone@evil.example", "PO\t7", "PO-" + String.fromCharCode(0x2028) + "x", "PO-" + String.fromCharCode(0x202e) + "x", "x".repeat(61), "PO <b>1</b>", "   ", 12345];
    for (const poNumber of bad) {
      const r = await accept(f.token, { method: "po", poNumber });
      assert.strictEqual(r.status, 400, JSON.stringify(poNumber));
      assert.ok(["po-number-invalid", "po-number-required"].includes(r.body.code), `${JSON.stringify(poNumber)} → ${r.body.code}`);
    }
    assert.deepStrictEqual([rfqsDB.getById(f.id).status, ordersDB.query((o) => o.rfqId === f.id).length], ["quoted", 0]);
    const ok = await accept(f.token, { method: "po", poNumber: "  PO-778 / Rev.B #12  " });
    assert.strictEqual(ok.status, 201, ok.text);
    const o = ordersDB.query((x) => x.rfqId === f.id)[0];
    assert.strictEqual(o.poNumber, "PO-778 / Rev.B #12");
    const pdf = await fetch(`${h.base}/api/pdf/traveler/${o.id}`, { headers: { Authorization: `Bearer ${owner}`, "X-Forwarded-For": "198.51.100.78" } });
    const lines = pdfText(Buffer.from(await pdf.arrayBuffer())).split("\n");
    // (merge 2026-11-12) The traveler's layout is the journey pass's: a typed value prints inside a labelled field,
    // "Customer PO (as typed): …". Same assertion, that label.
    assert.ok(lines.map((l) => l.trim()).includes("Customer PO (as typed): PO-778 / Rev.B #12"), lines.filter((l) => /PO/.test(l)).join(" | "));
    // A row written before the check existed: the traveler still prints it on one line.
    ordersDB.update(o.id, { poNumber: "PO-778\nPAID IN FULL - SHIP TODAY" });
    const old = pdfText(Buffer.from(await (await fetch(`${h.base}/api/pdf/traveler/${o.id}`, { headers: { Authorization: `Bearer ${owner}`, "X-Forwarded-For": "198.51.100.79" } })).arrayBuffer())).split("\n");
    const oldLines = old.map((l) => l.trim());
    assert.ok(oldLines.includes("Customer PO (as typed): PO-778 PAID IN FULL - SHIP TODAY") && !oldLines.includes("PAID IN FULL - SHIP TODAY") && !oldLines.some((l) => /^PAID IN FULL/.test(l)), "no line of the buyer's own on the traveler");
  });

  test("F-10: the other single-line fields are held to the same rule on every route that takes them", async () => {
    const f = await quoted(500, 5);
    for (const field of ["shippingName", "shippingAddress", "shippingCity", "shippingState", "shippingZip"]) {
      const r = await accept(f.token, { method: "po", poNumber: "PO-1", [field]: "Line one\nPAID" });
      assert.deepStrictEqual([r.status, r.body.code, r.body.field], [400, "field-single-line", field]);
    }
    assert.strictEqual(rfqsDB.getById(f.id).status, "quoted");
    // Instant checkout.
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard" }, buyer);
    const co = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP, shippingName: "Dana\r\nURGENT: SHIP FIRST" }, buyer);
    assert.deepStrictEqual([co.status, co.body.code, co.body.field], [400, "field-single-line", "shippingName"]);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 0);
    // The request form: name, company, phone.
    for (const [field, value] of [["contactName", "Pat\nBuyer"], ["company", "OEM Co\nPRIORITY"], ["phone", "815-555-0100\n(owner approved)"]]) {
      const r = await h.form("/api/rfq", { contactName: "Pat Buyer", email: "single@oem.test", notes: `single ${field}`, [field]: value });
      assert.deepStrictEqual([r.status, r.body.code, r.body.field], [400, "field-single-line", field]);
    }
    assert.strictEqual(rfqsDB.query((r) => r.email === "single@oem.test").length, 0);
    // The account's own name, company and phone (they become "Ordered by" on documents).
    const reg = await h.raw("POST", "/api/auth/register", { json: { email: "lines@buyer.test", password: h.password, name: "Lee\nPAID IN FULL" }, headers: { "X-Form-Token": h.formToken("register"), "X-Turnstile-Token": "pass-register" } });
    assert.deepStrictEqual([reg.status, reg.body.code, reg.body.field], [400, "field-single-line", "name"]);
    const prof = await h.put("/api/auth/profile", { company: "Acme\r\nNET 90 APPROVED" }, buyer);
    assert.deepStrictEqual([prof.status, prof.body.code, prof.body.field], [400, "field-single-line", "company"]);
    // The owner's own fields on an order: carrier and tracking number.
    const p = await paid(2);
    const t = await h.put(`/api/orders/${p.orderId}/status`, { status: "shipped", carrier: "UPS", trackingNumber: "1Z999\nfake line" }, owner);
    assert.deepStrictEqual([t.status, t.body.code, t.body.field], [400, "field-single-line", "trackingNumber"]);
    assert.strictEqual(order(p.orderId).status, "paid");
    // Ordinary punctuation and accents are text, not an attack.
    const fine = await accept(f.token, { method: "po", poNumber: "PO-1", shippingName: "Zoë O'Brien & Sons <Receiving>", shippingAddress: "500 Plant Rd, Dock #4" });
    assert.strictEqual(fine.status, 201, fine.text);
  });

  // ═══ Return URLs ═════════════════════════════════════════════
  test("Stripe is never given the quote link: the return URL carries the order id and a return token good for one question", async () => {
    const f = await quoted(1800, 7);
    await accept(f.token, { method: "card" });
    const o = ordersDB.query((x) => x.rfqId === f.id)[0];
    const args = h.stripe.created[h.stripe.created.length - 1];
    assert.ok(!JSON.stringify(args).includes(f.token), "the accept link is not in anything sent to Stripe");
    const url = new URL(args.success_url);
    assert.deepStrictEqual([url.pathname, url.searchParams.get("o"), url.searchParams.get("paid")], ["/firm-quote/return", o.id, "true"]);
    const rt = url.searchParams.get("r");
    const confirm = (order, token) => h.raw("POST", "/api/rfq/return/confirm", { json: { order, token } });
    // Not a quote link, not a login, not good for another order, not forgeable.
    assert.strictEqual((await h.get(`/api/rfq/quote/${rt}`)).status, 404);
    assert.strictEqual((await h.get("/api/orders", rt)).status, 401);
    const otherOrder = (await pending()).orderId;
    for (const [order, token] of [[otherOrder, rt], [o.id, rt.slice(0, -3) + "abc"], [o.id, f.token], [o.id, ""], ["", rt]]) {
      const r = await confirm(order, token);
      assert.deepStrictEqual([r.status, r.body.code], [404, "return-link-invalid"]);
    }
    const before = await confirm(o.id, rt);
    assert.deepStrictEqual([before.status, before.body.status], [200, "pending_payment"]);
    h.pay(o.stripeSessionId);
    const after = await confirm(o.id, rt);
    assert.deepStrictEqual(Object.keys(after.body).sort(), ["paymentUnderReview", "reference", "shipBy", "status", "total"], "where the order stands, and nothing about who it is for");
    assert.deepStrictEqual([after.body.status, after.body.total], ["paid", 1800]);
    assert.strictEqual(order(o.id).status, "paid");
    // An expired return token is refused.
    const expired = jwt.sign({ o: o.id }, require("crypto").createHmac("sha256", "test-secret").update("checkout-return-v1").digest(), { audience: "checkout-return", algorithm: "HS256", expiresIn: -10 });
    assert.strictEqual((await confirm(o.id, expired)).status, 404);
  });

  // ═══ The owner's manual moves ════════════════════════════════
  test("the status route allows only the moves in the state machine, needs a reason to mark paid, and writes an audit event", async () => {
    const p = await pending();
    const put = (id, body) => h.put(`/api/orders/${id}/status`, body, owner);
    for (const status of ["in_production", "received", "shipped", "delivered", "expired", "refunded", "pending_po", "paid_amount_mismatch"]) {
      const r = await put(p.orderId, { status, reason: "because" });
      assert.deepStrictEqual([r.status, r.body.code], [409, "transition-not-allowed"], status);
    }
    assert.deepStrictEqual([(await put(p.orderId, { status: "free" })).body.code], ["status-unknown"]);
    for (const reason of [undefined, "", "  ", "ok"]) assert.deepStrictEqual([(await put(p.orderId, { status: "paid", reason })).body.code], ["reason-required"]);
    assert.strictEqual((await put(p.orderId, { status: "paid", reason: "line one\nline two" })).body.code, "field-single-line");
    assert.strictEqual(order(p.orderId).status, "pending_payment");
    const audits = adminAuditDB.getAll().length;
    h.sent.length = 0;
    const ok = await put(p.orderId, { status: "paid", reason: "wire received 11 Nov, ref 88213", paidVia: "wire" });
    assert.strictEqual(ok.status, 200, ok.text);
    const o = order(p.orderId);
    assert.deepStrictEqual([o.status, o.paidVia, o.manualPaidReason, o.manualPaidBy, Boolean(o.paidAt)], ["paid", "manual", "wire: wire received 11 Nov, ref 88213", OWNER, true]);
    assert.ok(h.stripe.expired.includes(p.session.id), "the card page for it is closed");
    const row = adminAuditDB.getAll().slice(audits)[0];
    // (merge 2026-11-12) One change log for both fix branches (services/audit.js): the kind of thing is `area`
    // (was `entity`) and before/after are stored as { field: [before, after] } pairs. Same facts, one shape.
    assert.deepStrictEqual([row.action, row.area, row.entityId, row.userEmail, row.note, row.changes], ["order.mark-paid", "order", p.orderId, OWNER, "wire received 11 Nov, ref 88213", { status: ["pending_payment", "paid"], paidVia: [null, "wire"] }]);
    assert.strictEqual(row.target, p.orderId.slice(0, 8).toUpperCase(), "the order's reference, as the Change log screen shows it");
    assert.strictEqual(events(p.orderId, "manual-paid").length, 1);
    // Paid cannot be undone to "awaiting payment"; the shop's own steps move freely; saving the same status changes nothing but the fields sent.
    assert.strictEqual((await put(p.orderId, { status: "pending_payment" })).body.code, "transition-not-allowed");
    assert.strictEqual((await put(p.orderId, { status: "in_production" })).status, 200);
    assert.strictEqual((await put(p.orderId, { status: "received" })).status, 200);
    const same = await put(p.orderId, { status: "received", notes: "bar stock on the rack" });
    assert.deepStrictEqual([same.status, same.body.notes, same.body.status], [200, "bar stock on the rack", "received"]);
    assert.deepStrictEqual(adminAuditDB.getAll().slice(audits).map((r) => r.action), ["order.mark-paid", "order.status", "order.status"]);
    // A buyer cannot do any of it.
    assert.strictEqual((await h.put(`/api/orders/${p.orderId}/status`, { status: "cancelled" }, buyer)).status, 403);
    // The table in orderState.js is the whole truth: nothing by hand leads to awaiting payment, PO to confirm or expired.
    for (const to of Object.values(manualMoves()).flat()) assert.ok(!["pending_payment", "pending_po", "expired", "paid_amount_mismatch"].includes(to), to);
  });

  test("a PO order: confirming the PO moves it into work without a payment; marking it paid later needs a reason", async () => {
    const f = await quoted(640, 8);
    await accept(f.token, { method: "po", poNumber: "PO-3310" });
    const o = ordersDB.query((x) => x.rfqId === f.id)[0];
    assert.strictEqual((await h.put(`/api/orders/${o.id}/status`, { status: "in_production" }, owner)).status, 200);
    assert.strictEqual(order(o.id).paidAt || null, null, "nothing is recorded as paid");
    assert.strictEqual((await h.put(`/api/orders/${o.id}/status`, { status: "paid" }, owner)).body.code, "reason-required");
    assert.strictEqual((await h.put(`/api/orders/${o.id}/status`, { status: "paid", reason: "cheque 5521 deposited", paidVia: "cheque" }, owner)).status, 200);
  });

  test("a flagged order is cleared by the owner with a note, which is audited", async () => {
    const p = await pending();
    await h.completed(p.session.id, { amount_total: 100 });
    assert.strictEqual(order(p.orderId).attention, "payment-mismatch");
    assert.strictEqual((await h.get("/api/orders/admin/payment-settings", owner)).body.needsAttention > 0, true);
    assert.strictEqual((await h.post(`/api/orders/${p.orderId}/resolve-attention`, { note: "" }, owner)).body.code, "reason-required");
    assert.strictEqual((await h.post(`/api/orders/${p.orderId}/resolve-attention`, { note: "refunded in Stripe" }, buyer)).status, 403);
    const r = await h.post(`/api/orders/${p.orderId}/resolve-attention`, { note: "refunded in Stripe, customer told" }, owner);
    assert.deepStrictEqual([r.status, r.body.attention || null], [200, null]);
    assert.ok(/Resolved: refunded in Stripe, customer told/.test(order(p.orderId).attentionNote));
    assert.ok(adminAuditDB.getAll().some((a) => a.action === "order.attention-resolved" && a.entityId === p.orderId));
  });

  test("the audit service never breaks the action it records", async () => {
    const audit = require("../services/audit");
    const quiet = console.error; console.error = () => {};
    try {
      assert.strictEqual(audit.record(null) !== undefined, true);
      const circular = {}; circular.self = circular;
      audit.record({ actor: { userId: "u", email: "a@b.test" }, action: "test.circular", entity: "order", entityId: "x", after: circular });
      audit.record({ actor: { userId: "u", email: "a@b.test" }, action: "test.circular", area: "order", entityId: "x", changes: circular });
    } finally { console.error = quiet; }
    assert.ok(audit.list({ entity: "order" }).length > 0);
    assert.deepStrictEqual(audit.list({ entity: "order" }).map((r) => r.id), audit.list({ area: "order" }).map((r) => r.id), "`entity` and `area` name the same thing");
  });

  // ═══ Notifications ═══════════════════════════════════════════
  test("the shop gets one email for each money event, none of them with customer text in the subject, and each leaves a row that can be counted", async () => {
    const hostile = await h.register("hostile@buyer.test", "Mallory <script> RE: URGENT WIRE");
    const mine = (o) => (m) => m.text.includes(String(o).slice(0, 8).toUpperCase());
    // 1. a new paid order
    const p = await pending(2, hostile, await h.uploadCube()); // their own upload (part ownership, review F5)
    h.sent.length = 0;
    await h.completed(p.session.id);
    // 2. a payment needing attention (the same order, paid twice)
    await h.webhook("checkout.session.completed", { ...p.session, id: "cs_twice", payment_status: "paid", payment_intent: "pi_twice" });
    // 3. a refund   4. a dispute
    const o = order(p.orderId);
    await h.webhook("charge.refunded", { id: "ch_n", payment_intent: o.stripePaymentId, amount_refunded: 500, amount_captured: Math.round(o.total * 100) });
    await h.webhook("charge.dispute.created", { id: "dp_n", payment_intent: o.stripePaymentId, amount: 500, status: "needs_response", reason: "fraudulent" });
    const mails = toShop().filter(mine(p.orderId));
    assert.deepStrictEqual(mails.map((m) => m.subject.replace(/[0-9A-F]{8}/, "ID").replace(/\$[\d,.]+/, "$N")), [
      "New order ID — $N",
      "Order ID needs attention: duplicate payment — $N",
      "Order ID: partly refunded — $N",
      "Order ID: payment disputed — $N",
    ]);
    for (const m of mails) assert.ok(!/Mallory|script|URGENT|hostile/i.test(m.subject), m.subject);
    assert.deepStrictEqual(events(p.orderId).filter((e) => e.notified).map((e) => e.kind), ["order-paid", "duplicate-payment", "refund", "dispute-opened"]);
    // 5. a new PO order
    const f = await quoted(990, 6);
    h.sent.length = 0;
    await accept(f.token, { method: "po", poNumber: "PO-5521" });
    assert.strictEqual(toShop(/^Quote [0-9A-F]{8} accepted on a purchase order — \$990\.00$/).length, 1);
    assert.strictEqual(events(ordersDB.query((x) => x.rfqId === f.id)[0].id, "po-order").filter((e) => e.notified).length, 1);
  });

  await run(() => h.stop());
})().catch((err) => { console.error(err); process.exit(1); });
