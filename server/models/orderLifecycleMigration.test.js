/**
 * The order-lifecycle migration, proven on a database made by the code of origin/master.
 * Run: `node server/models/orderLifecycleMigration.test.js`
 *
 * server/models/fixtures/origin-master-orders.db was written by origin/master's own code
 * (scripts/dev/make-origin-master-fixture.js says how) and holds a paid order, an order awaiting
 * payment, a quoted firm quote, a firm quote accepted on a PO and one accepted by card and not
 * paid. This suite opens a copy of it with today's code and checks that the migration only
 * adds, that it is a no-op the second time, and that each of those rows still displays and
 * still behaves: the paid order can be refunded, the unpaid ones can be paid or lapse, the
 * quoted firm quote can still be accepted from a link in the old format.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { start, runner } = require("../testSupport/harness");
const migration = require("./orderLifecycleMigration");

const { test, run } = runner("Order-lifecycle migration on a database made by origin/master");
const FIXTURE = path.join(__dirname, "fixtures", "origin-master-orders.db");
const made = JSON.parse(fs.readFileSync(FIXTURE.replace(/\.db$/, ".json"), "utf8"));
const SHIP = { shippingName: "Legacy Buyer", shippingAddress: "1 Fixture St", shippingCity: "Testville", shippingState: "IL", shippingZip: "60000", shippingCountry: "US" };

test("the lists agree: every new column has a field name, and every statement only adds", () => {
  const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const mapped = new Set(Object.values(migration.FIELD_MAP));
  for (const [name] of [...migration.ORDER_COLUMNS, ...migration.RFQ_COLUMNS]) {
    assert.ok(mapped.has(name) || snake(name) === name && !name.includes("_"), `column ${name} has no camelCase name in FIELD_MAP`);
  }
  for (const [field, column] of Object.entries(migration.FIELD_MAP)) assert.strictEqual(snake(field), column, `${field} ↔ ${column}`);
  for (const sql of Object.values(migration.TABLES)) assert.ok(/^CREATE TABLE IF NOT EXISTS [a-z_]+ \(/.test(sql));
  const src = fs.readFileSync(path.join(__dirname, "orderLifecycleMigration.js"), "utf8");
  assert.ok(!/DROP |DELETE |UPDATE |RENAME /i.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "additive only");
});

(async () => {
  // What the old database looked like before today's code touched it.
  const SQL = await require("sql.js")();
  const before = new SQL.Database(fs.readFileSync(FIXTURE));
  const columnsOf = (db, table) => { const out = []; const st = db.prepare(`PRAGMA table_info(${table})`); while (st.step()) out.push(st.getAsObject().name); st.free(); return out; };
  const rowsOf = (db, table) => { const out = []; const st = db.prepare(`SELECT * FROM ${table} ORDER BY id`); while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
  const old = { orders: rowsOf(before, "orders"), rfqs: rowsOf(before, "rfqs"), orderColumns: columnsOf(before, "orders"), items: rowsOf(before, "order_items") };
  assert.ok(!old.orderColumns.includes("attention"), "the fixture really is from before the migration");

  const h = await start({ seedDb: FIXTURE });
  const { ordersDB, rfqsDB, quotesDB } = h.models;
  const { paymentSessionsDB } = h.lifecycle;
  const { getDatabase } = require("./database");
  const lifecycle = require("../services/orderLifecycle");
  const totp = require("../security/totp");
  h.stripe.seq = 100; // the old database already holds sessions cs_test_1 … cs_test_3
  for (const [id, s] of Object.entries(made.sessions)) {
    h.stripe.sessions[id] = { id, object: "checkout.session", url: `https://checkout.stripe.test/${id}`, status: s.payment_status === "paid" ? "complete" : "open", payment_status: s.payment_status, currency: "usd", amount_total: s.amount_total, amount_subtotal: s.amount_total, total_details: { amount_discount: 0 }, metadata: { orderId: s.orderId }, payment_intent: s.payment_status === "paid" ? "pi_legacy_paid" : null };
  }
  let buyer, owner;
  const key = (label) => crypto.createHmac("sha256", "test-secret").update(label).digest();
  /** A firm-quote link exactly as origin/master issued it: no amount inside. */
  const oldLink = (rfq) => jwt.sign({ rfqId: rfq.id, v: rfq.quoteSentAt, exp: Math.floor(Date.parse(rfq.validUntil) / 1000) }, key("rfq-quote-link-v1"), { audience: "rfq-quote", algorithm: "HS256" });
  // The fixture's quotes were sent on the day it was made; keep them inside their validity whenever this runs.
  const stillValid = (id) => rfqsDB.update(id, { validUntil: new Date(Date.now() + 20 * 864e5).toISOString() });

  test("the migration only added: every old row and column is as it was, and applying it again changes nothing", async () => {
    const db = getDatabase();
    const now = columnsOf(db, "orders");
    for (const c of old.orderColumns) assert.ok(now.includes(c), `orders.${c} is still there`);
    for (const [c] of migration.ORDER_COLUMNS) assert.ok(now.includes(c), `orders.${c} was added`);
    assert.ok(columnsOf(db, "rfqs").includes("sent_terms"));
    for (const t of Object.keys(migration.TABLES)) assert.ok(columnsOf(db, t).length > 0, `${t} exists`);
    const after = { orders: rowsOf(db, "orders"), rfqs: rowsOf(db, "rfqs"), items: rowsOf(db, "order_items") };
    for (const table of ["orders", "rfqs", "items"]) {
      assert.strictEqual(after[table].length, old[table].length, `${table}: same number of rows`);
      old[table].forEach((row, i) => { for (const [k, v] of Object.entries(row)) assert.deepStrictEqual(after[table][i][k], v, `${table}[${i}].${k}`); });
    }
    assert.deepStrictEqual(migration.apply(db), [], "a second run adds nothing");
    // New columns read as "nothing recorded".
    const paid = ordersDB.getById(made.paidOrder);
    assert.deepStrictEqual([paid.attention, paid.refundedAmount, paid.discountAmount, paid.amountPaid, paid.currency, paid.sessionExpiresAt], [null, null, null, null, null, null]);
  });

  test("the accounts still sign in; the owner turns on two-step sign-in as today's code requires", async () => {
    buyer = await h.login(made.buyer.email, made.buyer.password);
    const first = await h.login("owner@shop.test", made.buyer.password);
    const setup = await h.raw("POST", "/api/auth/2fa/setup", { json: { password: made.buyer.password }, token: first });
    assert.strictEqual(setup.status, 200, setup.text);
    const secret = setup.body.setupKey.replace(/\s/g, "");
    const enabled = await h.raw("POST", "/api/auth/2fa/enable", { json: { code: totp.codeAt(secret) }, token: first });
    assert.strictEqual(enabled.status, 200, enabled.text);
    owner = enabled.body.token;
  });

  test("the paid order displays as paid, for its customer and for the owner, and is in the production queue", async () => {
    const mine = await h.get(`/api/orders/${made.paidOrder}`, buyer);
    // (origin/master stored totals unrounded: 259.2436…; the charge was the total rounded to the cent.)
    assert.deepStrictEqual([mine.status, mine.body.status, Math.round(mine.body.total * 100), mine.body.paymentUnderReview, mine.body.items.length], [200, "paid", made.sessions.cs_test_1.amount_total, false, 1]);
    const list = await h.get("/api/orders", buyer);
    assert.deepStrictEqual(list.body.map((o) => o.status).sort(), ["paid", "pending_payment"]);
    const admin = await h.get(`/api/orders/${made.paidOrder}`, owner);
    assert.deepStrictEqual([admin.body.payment.needsAttention, admin.body.payment.refundedAmount, admin.body.payment.discountAmount, admin.body.payment.paidByHand, admin.body.paymentEvents], [false, 0, 0, false, []]);
    assert.ok((await h.get("/api/orders/admin/queue", owner)).body.some((o) => o.id === made.paidOrder));
    for (const doc of ["order-confirmation", "traveler", "packing-slip"]) {
      const pdf = await fetch(`${h.base}/api/pdf/${doc}/${made.paidOrder}`, { headers: { Authorization: `Bearer ${owner}`, "X-Forwarded-For": "198.51.100.60" } });
      assert.strictEqual(pdf.status, 200, doc);
    }
  });

  test("the paid order behaves: its own payment seen again is not a duplicate; it moves through the shop's steps; a refund finds it", async () => {
    h.sent.length = 0;
    const replay = await h.webhook("checkout.session.completed", h.stripe.sessions.cs_test_1);
    assert.deepStrictEqual([replay.status, replay.body.outcome], [200, "replay"]);
    assert.deepStrictEqual([ordersDB.getById(made.paidOrder).status, ordersDB.getById(made.paidOrder).attention, h.sent.length], ["paid", null, 0]);
    assert.strictEqual((await h.put(`/api/orders/${made.paidOrder}/status`, { status: "in_production" }, owner)).status, 200);
    // No payment intent was stored by the old code: the refund is matched through Stripe's own record of the session.
    const cents = made.sessions.cs_test_1.amount_total;
    const refund = await h.webhook("charge.refunded", { id: "ch_legacy", payment_intent: "pi_legacy_paid", amount: cents, amount_captured: cents, amount_refunded: cents, refunded: true });
    assert.deepStrictEqual([refund.status, refund.body.outcome], [200, "refunded"]);
    const o = ordersDB.getById(made.paidOrder);
    assert.deepStrictEqual([o.status, o.refundedAmount, o.stripePaymentId], ["refunded", cents / 100, "pi_legacy_paid"]);
    assert.strictEqual(h.sent.filter((m) => /refunded in full/.test(m.subject)).length, 1);
    assert.ok(!(await h.get("/api/orders/admin/queue", owner)).body.some((x) => x.id === made.paidOrder));
  });

  test("the order awaiting payment displays as such and can still be paid on the session it already has", async () => {
    const mine = await h.get(`/api/orders/${made.pendingOrder}`, buyer);
    assert.deepStrictEqual([mine.body.status, mine.body.paymentUnderReview], ["pending_payment", false]);
    assert.strictEqual(quotesDB.getById(made.pendingQuote).status, "ordered");
    h.sent.length = 0;
    const paid = await h.completed("cs_test_2");
    assert.deepStrictEqual([paid.status, paid.body.outcome], [200, "paid"]);
    const o = ordersDB.getById(made.pendingOrder);
    assert.deepStrictEqual([o.status, o.paidVia, o.amountPaid], ["paid", "card", made.sessions.cs_test_2.amount_total / 100]);
    assert.strictEqual(h.sent.length, 2);
    assert.strictEqual(paymentSessionsDB.getById("cs_test_2").outcome, "settled", "its session is on record now");
  });

  test("the firm quote accepted by card and never paid: pay-again closes the old session at Stripe; left alone, the sweep expires it and reopens the quote", async () => {
    stillValid(made.cardRfq);
    const rfq = rfqsDB.getById(made.cardRfq);
    const view = await h.get(`/api/rfq/quote/${oldLink(rfq)}`);
    assert.deepStrictEqual([view.status, view.body.status, view.body.order.status], [200, "accepted", "pending_payment"]);
    const again = await h.post(`/api/rfq/quote/${oldLink(rfq)}/accept`, { method: "card", ...SHIP });
    assert.strictEqual(again.status, 200, again.text);
    assert.ok(h.stripe.expired.includes("cs_test_3"), "the session the old code made is closed before a new one is opened");
    const args = h.stripe.created[h.stripe.created.length - 1];
    assert.ok(args.success_url.includes("/firm-quote/return?o=") && args.expires_at > 0 && args.allow_promotion_codes === false);
    // Nobody pays: a day later the sweep closes the order out and the quote is open again.
    const swept = await lifecycle.sweepExpired({ now: Date.now() + 26 * 3600e3 });
    assert.ok(swept.expired >= 1, JSON.stringify(swept));
    assert.strictEqual(ordersDB.getById(rfq.orderId).status, "expired");
    assert.deepStrictEqual([rfqsDB.getById(made.cardRfq).status, rfqsDB.getById(made.cardRfq).orderId], ["quoted", null]);
  });

  test("the quoted firm quote opens from a link in the old format and can be accepted; once opened it is protected against unsent changes", async () => {
    stillValid(made.quotedRfq);
    let rfq = rfqsDB.getById(made.quotedRfq);
    assert.strictEqual(rfq.sentTerms, null);
    const link = oldLink(rfq);
    const view = await h.get(`/api/rfq/quote/${link}`);
    assert.deepStrictEqual([view.status, view.body.status, view.body.quotedTotal, view.body.linkAmount, view.body.quotedLeadDays], [200, "quoted", 1850, 1850, 12]);
    assert.ok(rfqsDB.getById(made.quotedRfq).sentTerms, "its terms are on record from the first look");
    const list = await h.get("/api/rfq/admin/list", owner);
    assert.deepStrictEqual([list.body.find((r) => r.id === made.quotedRfq).needsResend, Boolean(list.body.find((r) => r.id === made.quotedRfq).acceptUrl)], [false, true]);
    await h.put(`/api/rfq/admin/${made.quotedRfq}`, { quotedTotal: 18500 }, owner);
    assert.strictEqual((await h.get(`/api/rfq/quote/${link}`)).body.code, "quote-changed");
    await h.put(`/api/rfq/admin/${made.quotedRfq}`, { quotedTotal: 1850 }, owner);
    // (review of 2026-11-13, N-05) This request was made before requests carried a ship-to address, so the
    // owner priced it without one. Accepting it gives the address for the first time: no order is made at the
    // quoted total; the address is stored and the quote goes back to the owner, once. After the owner has
    // sent it again, the same address is accepted from the new link.
    const first = await h.post(`/api/rfq/quote/${link}/accept`, { method: "po", poNumber: "PO-OLD-LINK", ...SHIP });
    assert.deepStrictEqual([first.status, first.body.code, first.body.hadAddress], [409, "address-reconfirm", false], first.text);
    assert.deepStrictEqual([rfqsDB.getById(made.quotedRfq).status, rfqsDB.getById(made.quotedRfq).orderId || null, rfqsDB.getById(made.quotedRfq).shippingCity], ["quoted", null, SHIP.shippingCity]);
    assert.strictEqual((await h.get(`/api/rfq/quote/${link}`)).body.code, "address-reconfirm", "the old link is closed while the owner confirms the price");
    h.sent.length = 0;
    const resent = await h.put(`/api/rfq/admin/${made.quotedRfq}`, { status: "quoted", quotedTotal: 1850, quotedLeadDays: 12 }, owner);
    assert.deepStrictEqual([resent.status, resent.body.quoteSent], [200, true], resent.text);
    const newLink = (h.sent[0].text.match(/\/firm-quote\/(\S+)/) || [])[1];
    const ok = await h.post(`/api/rfq/quote/${newLink}/accept`, { method: "po", poNumber: "PO-OLD-LINK", ...SHIP });
    assert.strictEqual(ok.status, 201, ok.text);
    rfq = rfqsDB.getById(made.quotedRfq);
    assert.deepStrictEqual([rfq.status, ordersDB.getById(rfq.orderId).status, ordersDB.getById(rfq.orderId).total], ["accepted", "pending_po", 1850]);
  });

  test("the PO order displays as PO to confirm, is in the queue, and the owner can start it", async () => {
    stillValid(made.poRfq);
    const rfq = rfqsDB.getById(made.poRfq);
    const view = await h.get(`/api/rfq/quote/${oldLink(rfq)}`);
    assert.deepStrictEqual([view.status, view.body.order.status, view.body.poNumber], [200, "pending_po", "PO-LEGACY-7"]);
    assert.ok((await h.get("/api/orders/admin/queue", owner)).body.some((o) => o.id === rfq.orderId));
    assert.strictEqual((await h.put(`/api/orders/${rfq.orderId}/status`, { status: "in_production" }, owner)).status, 200);
    assert.strictEqual(ordersDB.getById(rfq.orderId).paidAt || null, null);
  });

  await run(() => h.stop());
})().catch((err) => { console.error(err); process.exit(1); });
