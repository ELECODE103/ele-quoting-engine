/**
 * An order and its lines are one write (independent re-review 2026-11-12, F-02 and F-08), and an
 * open payment page is settled or closed before its order is changed (F-06).
 * Run: node server/routes/orderAtomic.test.js
 *
 * Before: an order row, each line, each part claim and the quote's new status were separate saves of
 * the whole database file. A process killed between two of them left an order with some of its lines
 * on the disk; the buyer came back, pressed pay and was charged in full for it. Each case below fails
 * on that code.
 */
const assert = require("assert");
const fs = require("fs");
const { start, runner } = require("../testSupport/harness");
const { boxStl } = require("../testSupport/shapes");

const { test, run } = runner("Orders are written whole");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

(async () => {
  for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
  process.env.QUOTE_DRAFT_KB_PER_ACCOUNT = "1048576";
  process.env.QUOTE_DRAFT_KB_PER_CLIENT = "1048576";
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  const h = await start({ mailer: "configured" });
  const { ordersDB, orderItemsDB, quotesDB, rfqsDB, usersDB } = h.models;
  const database = require("../models/database");
  const lifecycle = require("../services/orderLifecycle");
  const orderRepair = require("../services/orderRepair");
  const initSqlJs = require("sql.js");
  let buyer, owner, partId, SQL;

  /** The database as it is in the FILE right now (what a restart would find). */
  const onDisk = (sql, params = []) => {
    const db = new SQL.Database(fs.readFileSync(database.DB_PATH));
    try { const st = db.prepare(sql); st.bind(params); const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows; } finally { db.close(); }
  };
  // (One piece a line: the gate sends more than 100 pieces of one part, or over $5,000, to a firm quote.)
  const quoteOf = async (lines) => {
    const printed = h.models.materialsDB.getAll().find((m) => m.process === "3d-printing" && m.active);
    const line = { partId, materialSlug: printed.slug, grade: "", finishSlug: "", quantity: 1, process: "3d-printing", subProcess: printed.subProcess || "" };
    const q = await h.post("/api/quote", { parts: Array.from({ length: lines }, () => line), leadTimeSlug: "standard" }, buyer);
    assert.strictEqual(q.status, 200, q.text.slice(0, 200));
    assert.ok(!q.body.gate.requiresRfq, JSON.stringify(q.body.gate.reasons).slice(0, 200));
    return q.body;
  };
  const pay = (quoteId, extra = {}) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...extra }, buyer);
  /** Count whole-file writes of the database while `fn` runs (a save renames quoting.db.tmp over quoting.db). */
  const savesDuring = async (fn) => {
    const real = fs.renameSync;
    let n = 0;
    fs.renameSync = (from, to) => { if (to === database.DB_PATH) n++; return real(from, to); };
    try { await fn(); } finally { fs.renameSync = real; }
    return n;
  };
  /** An order as the old code could leave it after a kill: the row, the first `kept` lines, the quote untouched. */
  const makePartial = (quote, kept, status = "pending_payment") => {
    const order = ordersDB.insert({ userId: usersDB.getAll().find((u) => u.email === "whole@buyer.test").id, quoteId: quote.quoteId, status, paymentMethod: "card", subtotal: quote.subtotal, total: quote.orderTotal, shippingCost: 0, tax: 0, customerEmail: "whole@buyer.test", ...SHIP, ...(status === "paid" ? { paidAt: new Date().toISOString(), amountPaid: quote.orderTotal } : {}) });
    for (const li of quote.lineItems.slice(0, kept)) orderItemsDB.insert({ orderId: order.id, partId: li.partId, fileName: li.fileName, quantity: li.quantity, unitPrice: li.perUnit.final, lineTotal: li.lineTotal, process: "3d-printing" });
    return order;
  };

  test("setup", async () => {
    SQL = await initSqlJs();
    owner = await h.admin("Owner");
    buyer = await h.register("whole@buyer.test");
    const up = await h.form("/api/upload", {}, { files: { name: "block.stl", data: boxStl(20) } }, buyer);
    partId = up.body.parts[0].partId;
  });

  test("database.transaction: everything or nothing, in memory and in the file; a failed write inside it throws", async () => {
    const before = ordersDB.getAll().length;
    assert.throws(() => database.transaction(() => {
      ordersDB.insert({ status: "pending_payment", total: 1 });
      ordersDB.insert({ status: "pending_payment", total: 2 });
      throw new Error("stop half way");
    }), /stop half way/);
    assert.strictEqual(ordersDB.getAll().length, before, "rolled back in memory");
    assert.strictEqual(onDisk("SELECT COUNT(*) AS n FROM orders")[0].n, before, "and nothing of it in the file");
    // A statement that fails inside a transaction stops the whole change (outside one it is logged and stepped over).
    assert.throws(() => database.transaction(() => {
      ordersDB.insert({ id: "fixed-id-1", status: "pending_payment" });
      ordersDB.insert({ id: "fixed-id-1", status: "pending_payment" }); // the same primary key again
    }));
    assert.strictEqual(ordersDB.getById("fixed-id-1"), null, "the first insert went with the second");
    assert.throws(() => database.transaction(async () => {}), /synchronous/);
    // And the plain case: both rows, one write of the file.
    let made;
    const saves = await savesDuring(async () => { made = database.transaction(() => [ordersDB.insert({ status: "cancelled", total: 1 }), ordersDB.insert({ status: "cancelled", total: 2 })]); });
    assert.strictEqual(saves, 1);
    assert.strictEqual(onDisk("SELECT COUNT(*) AS n FROM orders WHERE id IN (?, ?)", made.map((o) => o.id))[0].n, 2);
    for (const o of made) ordersDB.delete(o.id);
  });

  test("a 40-line checkout writes the database file twice (the order with its lines; the payment page), not once per line", async () => {
    const q = await quoteOf(40);
    database.flush();
    let c;
    const saves = await savesDuring(async () => { c = await pay(q.quoteId); });
    assert.strictEqual(c.status, 200, c.text.slice(0, 200));
    assert.ok(saves <= 2, `${saves} whole-file saves for one checkout (it was more than 40)`);
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.lineCount, 40);
    assert.strictEqual(onDisk("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?", [order.id])[0].n, 40);
    assert.strictEqual(onDisk("SELECT status FROM quotes WHERE id = ?", [q.quoteId])[0].status, "ordered");
    await h.completed(String(c.body.sessionUrl).split("/").pop());
  });

  test("a write that fails part way through the lines leaves no order, no lines and the quote a draft: in memory and in the file", async () => {
    const q = await quoteOf(20);
    database.flush();
    const real = orderItemsDB.insert.bind(orderItemsDB);
    let n = 0;
    orderItemsDB.insert = (row) => { if (++n === 8) throw new Error("the process fell over on line 8"); return real(row); };
    const errors = [];
    const realError = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    let c;
    try { c = await pay(q.quoteId); } finally { orderItemsDB.insert = real; console.error = realError; }
    assert.strictEqual(c.status, 500, c.text.slice(0, 200));
    assert.ok(!/line 8|fell over/.test(c.text), "the buyer is not shown the fault");
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 0);
    assert.strictEqual(orderItemsDB.getAll().filter((i) => !ordersDB.getById(i.orderId)).length, 0, "no line without its order");
    assert.strictEqual(quotesDB.getById(q.quoteId).status, "draft");
    assert.deepStrictEqual(onDisk("SELECT COUNT(*) AS n FROM orders WHERE quote_id = ?", [q.quoteId])[0].n, 0);
    assert.strictEqual(onDisk("SELECT status FROM quotes WHERE id = ?", [q.quoteId])[0].status, "draft");
    // The buyer presses pay again and gets a whole order.
    const again = await pay(q.quoteId);
    assert.strictEqual(again.status, 200, again.text.slice(0, 200));
    assert.strictEqual(orderItemsDB.query((i) => i.orderId === again.body.orderId).length, 20);
    await h.completed(String(again.body.sessionUrl).split("/").pop());
  });

  test("start-up: an unpaid order an earlier version left with 7 of its 20 lines is closed and can never be paid; the buyer checks out again and gets all 20", async () => {
    const q = await quoteOf(20);
    const partial = makePartial(q, 7);
    const lines = [];
    const result = orderRepair.checkOrders({ log: { warn: (l) => lines.push(l), error: (l) => lines.push(l) } });
    assert.deepStrictEqual(result.closed.map((c) => [c.id, c.lines, c.expected]), [[partial.id, 7, 20]]);
    assert.ok(lines.some((l) => /only partly written \(7 of 20 lines\)/.test(l)), lines.join(" | "));
    const closed = ordersDB.getById(partial.id);
    assert.strictEqual(closed.status, "expired");
    assert.strictEqual(closed.lineCount, 7);
    assert.strictEqual(quotesDB.getById(q.quoteId).status, "draft");
    assert.strictEqual(onDisk("SELECT status FROM orders WHERE id = ?", [partial.id])[0].status, "expired", "on the disk too");
    // Looked at once.
    assert.strictEqual(orderRepair.checkOrders({ log: { warn() {}, error() {} } }).checked, 0);
    const sessions = h.stripe.created.length;
    const c = await pay(q.quoteId);
    assert.strictEqual(c.status, 200, c.text.slice(0, 200));
    assert.notStrictEqual(c.body.orderId, partial.id, "a new order, not the partial one");
    assert.strictEqual(orderItemsDB.query((i) => i.orderId === c.body.orderId).length, 20);
    assert.strictEqual(h.stripe.created.length, sessions + 1);
    assert.ok(/20 parts/.test(h.stripe.created[sessions].line_items[0].price_data.product_data.name));
    await h.completed(String(c.body.sessionUrl).split("/").pop());
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "paid");
    assert.strictEqual(ordersDB.getById(partial.id).status, "expired");
  });

  test("checkout itself never hands a payment page to an order whose lines are not its quote's (the start-up check not yet run)", async () => {
    const q = await quoteOf(12);
    const partial = makePartial(q, 5);
    const sessions = h.stripe.created.length;
    const c = await pay(q.quoteId);
    assert.strictEqual(c.status, 200, c.text.slice(0, 200));
    assert.notStrictEqual(c.body.orderId, partial.id);
    assert.strictEqual(ordersDB.getById(partial.id).status, "expired");
    assert.strictEqual(lifecycle.sessionsFor(partial.id).length, 0, "no payment page was ever made for the partial order");
    assert.strictEqual(orderItemsDB.query((i) => i.orderId === c.body.orderId).length, 12);
    assert.strictEqual(h.stripe.created.length, sessions + 1);
    await h.completed(String(c.body.sessionUrl).split("/").pop());
  });

  test("start-up: an order that was PAID with lines missing is flagged for the owner and the shop is emailed; nothing is cancelled", async () => {
    const q = await quoteOf(10);
    const partial = makePartial(q, 4, "paid");
    h.sent.length = 0;
    const result = orderRepair.checkOrders({ log: { warn() {}, error() {} } });
    assert.deepStrictEqual(result.flagged.map((f) => [f.id, f.lines, f.expected]), [[partial.id, 4, 10]]);
    await orderRepair.closeLeftovers(result);
    const flagged = ordersDB.getById(partial.id);
    assert.strictEqual(flagged.status, "paid");
    assert.strictEqual(flagged.attention, "order-incomplete");
    assert.ok(/lists 4 of the 10 lines/.test(flagged.attentionNote), flagged.attentionNote);
    const mail = h.sent.filter((m) => m.to === "owner@shop.test" && /missing lines/i.test(m.subject));
    assert.strictEqual(mail.length, 1, h.sent.map((m) => m.subject).join(" | "));
    assert.strictEqual((await h.get(`/api/orders/${partial.id}`, owner)).body.payment.attentionLabel, "Order is missing lines");
    assert.strictEqual(orderRepair.checkOrders({ log: { warn() {}, error() {} } }).checked, 0, "flagged once");
  });

  test("an order made by this code carries its line count; if a line is ever lost the next start-up says so", async () => {
    const q = await quoteOf(6);
    const c = await pay(q.quoteId);
    assert.strictEqual(ordersDB.getById(c.body.orderId).lineCount, 6);
    assert.strictEqual(orderRepair.checkOrders({ log: { warn() {}, error() {} } }).checked, 0);
    orderItemsDB.delete(orderItemsDB.query((i) => i.orderId === c.body.orderId)[0].id);
    const result = orderRepair.checkOrders({ log: { warn() {}, error() {} } });
    assert.deepStrictEqual(result.closed.map((x) => [x.id, x.lines, x.expected]), [[c.body.orderId, 5, 6]]);
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "expired");
  });

  test("a firm-quote acceptance is one write too, and an order its request never came to point at is closed at start-up", async () => {
    const rfq = rfqsDB.insert({ status: "quoted", contactName: "Pat", email: "pat@oem.test", quotedTotal: 900, quotedLeadDays: 5, parts: [{ partId, fileName: "block.stl", quantity: 3 }, { partId, fileName: "block.stl", quantity: 9 }] });
    const orphan = ordersDB.insert({ rfqId: rfq.id, status: "pending_po", paymentMethod: "po", total: 900, subtotal: 900, customerEmail: "pat@oem.test" });
    orderItemsDB.insert({ orderId: orphan.id, partId, fileName: "block.stl", quantity: 3 });
    const result = orderRepair.checkOrders({ log: { warn() {}, error() {} } });
    assert.deepStrictEqual(result.closed.map((x) => x.id), [orphan.id]);
    assert.strictEqual(ordersDB.getById(orphan.id).status, "cancelled");
    assert.strictEqual(rfqsDB.getById(rfq.id).status, "quoted", "the quote is still open for the buyer to accept");
  });

  test("F-06: a payment page that was PAID is settled before the order is changed; the correct payment is not flagged", async () => {
    // Pickup has to be on offer for there to be two delivery choices.
    const rules = await h.put("/api/admin/pricing", { rules: { shippingLocalPickup: "on" }, note: "test: pickup on" }, owner);
    assert.strictEqual(rules.status, 200, rules.text.slice(0, 200));
    const q = await quoteOf(2);
    const tab1 = await pay(q.quoteId, { shippingOption: "pickup" });
    assert.strictEqual(tab1.status, 200, tab1.text.slice(0, 200));
    const sid = String(tab1.body.sessionUrl).split("/").pop();
    const pickupTotal = ordersDB.getById(tab1.body.orderId).total;
    h.pay(sid); // Stripe has the money; the webhook has not arrived yet
    h.sent.length = 0;
    const tab2 = await pay(q.quoteId, { shippingOption: "ship" });
    assert.strictEqual(tab2.status, 200, tab2.text.slice(0, 200));
    assert.strictEqual(tab2.body.orderId, tab1.body.orderId);
    assert.ok(/\?paid=true$/.test(tab2.body.sessionUrl), `the second tab is sent to the paid order, not to a payment page: ${tab2.body.sessionUrl}`);
    const order = ordersDB.getById(tab1.body.orderId);
    assert.strictEqual(order.status, "paid");
    assert.ok(!order.attention, `not flagged: ${order.attention}`);
    assert.strictEqual(order.shippingMethod, "pickup", "it is the order the buyer paid for");
    assert.strictEqual(order.total, pickupTotal);
    assert.strictEqual(h.sent.filter((m) => /needs attention/i.test(m.subject)).length, 0);
    // The webhook, when it lands, changes nothing.
    await h.completed(sid);
    assert.strictEqual(ordersDB.getById(order.id).status, "paid");
    assert.ok(!ordersDB.getById(order.id).attention);
  });

  test("F-06: a payment page that was NOT paid is closed at Stripe before the order is changed, then a new page is made", async () => {
    const q = await quoteOf(3);
    const tab1 = await pay(q.quoteId, { shippingOption: "pickup" });
    const sid1 = String(tab1.body.sessionUrl).split("/").pop();
    const before = ordersDB.getById(tab1.body.orderId);
    const tab2 = await pay(q.quoteId, { shippingOption: "ship" });
    assert.strictEqual(tab2.status, 200, tab2.text.slice(0, 200));
    assert.strictEqual(tab2.body.orderId, tab1.body.orderId, "still one order");
    const sid2 = String(tab2.body.sessionUrl).split("/").pop();
    assert.notStrictEqual(sid2, sid1);
    assert.ok(h.stripe.expired.includes(sid1), "the first page was closed at Stripe");
    assert.strictEqual(h.stripe.sessions[sid1].status, "expired");
    const after = ordersDB.getById(tab1.body.orderId);
    assert.strictEqual(after.shippingMethod, "standard");
    assert.ok(after.total > before.total, `ship ${after.total} > pickup ${before.total}`);
    // Same choice again, nothing changed: the same page is handed back and nothing is closed.
    const closedBefore = h.stripe.expired.length;
    const tab3 = await pay(q.quoteId, { shippingOption: "ship" });
    assert.strictEqual(String(tab3.body.sessionUrl).split("/").pop(), sid2);
    assert.strictEqual(h.stripe.expired.length, closedBefore);
    // Stripe cannot say whether the page is closed: the order is NOT changed, and the buyer is told to try again.
    h.stripe.failExpire = true;
    const realRetrieve = h.stripe.sessions[sid2];
    delete h.stripe.sessions[sid2]; // retrieve answers nothing useful either
    const tab4 = await pay(q.quoteId, { shippingOption: "pickup" });
    h.stripe.sessions[sid2] = realRetrieve;
    h.stripe.failExpire = false;
    assert.ok([200, 502].includes(tab4.status), tab4.text.slice(0, 200));
    if (tab4.status === 502) {
      assert.strictEqual(tab4.body.code, "payment-session-busy");
      assert.strictEqual(ordersDB.getById(after.id).shippingMethod, "standard", "unchanged");
    }
  });

  await run(() => h.stop());
})();
