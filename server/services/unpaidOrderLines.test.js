/**
 * Checkouts that were never paid for are not a way to fill the database (re-review 2026-11-12, F-12,
 * the database side).
 * Run: node server/services/unpaidOrderLines.test.js
 *
 * An order line is about 3 kB (its configuration, its cost build-up, the snapshot of what was priced).
 * Before: an order that closed unpaid kept its lines for good, so accounts that pressed "pay" day
 * after day and never paid walked the database to its ceiling, where new quotes are refused for
 * everybody, and nothing the clean-up was allowed to remove would bring it back. Each case below
 * fails on that code.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Unpaid orders under database pressure");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

let h, models, pressure, lifecycle, database, limits, admin;
const sql = (q, p = []) => database.getDatabase().run(q, p);
const order = (id) => models.ordersDB.getById(id);
const linesOf = (id) => models.orderItemsDB._query("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?", [id])[0].n;
const lineBytes = (ids) => pressure.lapsedOrderLines(models).filter((o) => ids.includes(o.id)).reduce((n, o) => n + o.bytes, 0);

/** An unpaid order of `lines` printed lines for `token`. */
async function unpaidOrder(token, lines) {
  const data = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl"));
  const up = await h.form("/api/upload", {}, { files: { name: "cube_20mm.stl", data } }, token);
  assert.strictEqual(up.status, 200, up.text.slice(0, 200));
  const printed = models.materialsDB.getAll().find((m) => m.process === "3d-printing" && m.active);
  const line = { partId: up.body.parts[0].partId, materialSlug: printed.slug, grade: "", finishSlug: "", process: "3d-printing", subProcess: printed.subProcess || "" };
  const q = await h.post("/api/quote", { parts: Array.from({ length: lines }, (_, i) => ({ ...line, quantity: 1 + i })), leadTimeSlug: "standard" }, token);
  assert.strictEqual(q.status, 200, q.text.slice(0, 200));
  const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, token);
  assert.strictEqual(c.status, 200, c.text.slice(0, 200));
  return { orderId: c.body.orderId, sessionId: String(c.body.sessionUrl).split("/").pop(), quoteId: q.body.quoteId };
}
/** Make an order one that closed unpaid `agoMs` ago. */
async function lapse(o, agoMs) {
  const r = await lifecycle.closeUnderPressure(o.orderId);
  assert.strictEqual(r.outcome, "closed", JSON.stringify(r));
  sql("UPDATE orders SET expired_at = ?, updated_at = ? WHERE id = ?", [new Date(Date.now() - agoMs).toISOString(), new Date(Date.now() - agoMs).toISOString(), o.orderId]);
}
/** The database module, reporting `bytes` in use: the pass works to a number of bytes to free. */
const allLineBytes = () => models.orderItemsDB._query("SELECT COALESCE(SUM(200 + COALESCE(OCTET_LENGTH(config_json), 0) + COALESCE(OCTET_LENGTH(geometry_json), 0) + COALESCE(OCTET_LENGTH(dfm_json), 0)), 0) AS n FROM order_items")[0].n;
const sized = (bytes) => { const at = allLineBytes(); const now = () => bytes - (at - allLineBytes()); return { ...database, liveSize: now, usedSize: now, fileSize: now }; };
const empty = () => { database.batch(() => { models.orderItemsDB.clear(); models.ordersDB.clear(); models.quotesDB.clear(); models.partsDB.clear(); }); pressure.state.databaseQuietUntil = 0; };

test("setup", async () => {
  h = await start({ mailer: "configured" });
  models = h.models;
  pressure = require("./storagePressure");
  lifecycle = require("./orderLifecycle");
  database = require("../models/database");
  limits = require("../security/limits").limits;
  admin = await h.admin();
});

test("the lines of orders that closed unpaid over an hour ago go first, from whoever holds the most; the order itself stays, and a paid, flagged or just-closed order is not touched", async () => {
  const heavy = await h.register("heavy@buyer.test");
  const light = await h.register("light@buyer.test");
  const other = await h.register("other@buyer.test");
  const heavyOrders = [await unpaidOrder(heavy, 8), await unpaidOrder(heavy, 8)];
  const lightOrder = await unpaidOrder(light, 1);
  const justClosed = await unpaidOrder(other, 6);
  const flagged = await unpaidOrder(other, 6);
  const paid = await unpaidOrder(other, 6);
  await h.completed(paid.sessionId);
  for (const o of heavyOrders) await lapse(o, 2 * HOUR);
  await lapse(lightOrder, 2 * HOUR);
  await lapse(justClosed, 10 * MIN);
  await lapse(flagged, 2 * HOUR);
  models.ordersDB.update(flagged.orderId, { attention: "late-payment", attentionNote: "paid after it closed", attentionAt: new Date().toISOString() });

  const candidates = pressure.lapsedOrderLines(models);
  assert.deepStrictEqual(candidates.map((c) => c.id).sort(), [...heavyOrders.map((o) => o.orderId), lightOrder.orderId, justClosed.orderId].sort(), "only never-paid, unflagged, closed orders are candidates");
  const heavyBytes = lineBytes(heavyOrders.map((o) => o.orderId));
  const lightBytes = lineBytes([lightOrder.orderId]);
  assert.ok(heavyBytes > 30000 && lightBytes > 1500, `16 lines are ${heavyBytes} bytes, one is ${lightBytes}`);

  // The database is over its clean-up line by a little less than the heavy holder's lines.
  const max = limits.databaseMaxBytes;
  const target = max * Math.max(0.1, limits.dbSweepFraction - 0.2);
  const r = await pressure.relieveDatabase(models, { force: true, sync: true, database: sized(target + heavyBytes - lightBytes - 500) });
  assert.strictEqual(r.clearedOrders, 2, JSON.stringify(r));
  for (const o of heavyOrders) {
    const row = order(o.orderId);
    assert.strictEqual(linesOf(o.orderId), 0, "its lines are gone");
    assert.strictEqual(row.status, "expired", "the order itself is still on record as not paid, closed");
    assert.ok(row.linesClearedAt && row.lineCount === 0 && Number(row.total) > 0, "marked, with its total kept");
  }
  assert.strictEqual(linesOf(lightOrder.orderId), 1, "the light holder was not reached");
  assert.strictEqual(linesOf(justClosed.orderId), 6, "closed ten minutes ago: kept for now");
  assert.strictEqual(linesOf(flagged.orderId), 6, "flagged for the owner: never touched");
  assert.strictEqual(linesOf(paid.orderId), 6, "paid for: never touched");
  assert.strictEqual(order(paid.orderId).status, "paid");

  // The start-up check that every order has the lines it was written with is not tripped by it.
  const check = require("./orderRepair").checkOrders({ log: { warn() {}, error() {} } });
  assert.deepStrictEqual([check.closed.length, check.flagged.length], [0, 0], JSON.stringify(check));
  // The owner's list and the single order still answer.
  const list = await h.get("/api/orders?pageSize=100", admin);
  assert.strictEqual(list.status, 200);
  const one = await h.get(`/api/orders/${heavyOrders[0].orderId}`, admin);
  assert.strictEqual(one.status, 200);
  assert.ok(one.body.linesClearedAt && Array.isArray(one.body.items) && one.body.items.length === 0);
});

test("a payment that still arrives for an order whose lines were cleared is flagged for the owner exactly as before, and the owner cannot mark such an order paid by hand", async () => {
  empty();
  const who = await h.register("late@buyer.test");
  const o = await unpaidOrder(who, 4);
  // The buyer's payment page is still open in a tab when the order is closed here (Stripe could not be reached to close it).
  const session = h.stripe.sessions[o.sessionId];
  await lapse(o, 3 * HOUR);
  const r = await pressure.relieveDatabase(models, { force: true, sync: true, database: sized(limits.databaseMaxBytes * 0.9) });
  assert.strictEqual(r.clearedOrders, 1, JSON.stringify(r));
  assert.strictEqual(linesOf(o.orderId), 0);

  // By hand: refused, with words that say what to do instead.
  const move = await h.put(`/api/orders/${o.orderId}/status`, { status: "paid", reason: "paid by check" }, admin);
  assert.strictEqual(move.status, 409, move.text.slice(0, 200));
  assert.strictEqual(move.body.code, "order-lines-cleared");
  assert.ok(/Take the order again/.test(move.body.error), move.body.error);
  assert.strictEqual(order(o.orderId).status, "expired");

  // The money arrives after all.
  Object.assign(session, { status: "complete", payment_status: "paid", payment_intent: "pi_late_cleared" });
  await h.webhook("checkout.session.completed", session);
  const after = order(o.orderId);
  assert.strictEqual(after.attention, "late-payment", `flagged for the owner: ${after.status} / ${after.attention}`);
  assert.notStrictEqual(after.status, "paid", "never quietly a live order");
});

test("still at the line where visitors are turned away: unpaid orders are closed from the heaviest holder first, each buyer is told, and their lines go; firm-quote, phone and flagged orders are never closed", async () => {
  empty();
  const heavy = await h.register("heavy2@buyer.test");
  const light = await h.register("light2@buyer.test");
  const heavyOrders = [await unpaidOrder(heavy, 8), await unpaidOrder(heavy, 8)];
  const lightOrder = await unpaidOrder(light, 2);
  const userId = models.usersDB.getAll().find((u) => u.email === "light2@buyer.test").id;
  const mk = (over) => {
    const row = models.ordersDB.insert({ userId, status: "pending_payment", total: 100, subtotal: 100, customerEmail: "light2@buyer.test", lineCount: 1, ...over });
    models.orderItemsDB.insert({ orderId: row.id, fileName: "cube.stl", quantity: 1, config: { note: "x".repeat(60000) } });
    return row;
  };
  // Each of these holds far more than the heavy account does, and none of them may be closed.
  const firm = mk({ rfqId: "rfq-1", paymentMethod: "card" });
  const phone = mk({ paymentMethod: "" });
  const flagged = mk({ paymentMethod: "card", attention: "payment-mismatch" });

  const bytesOf = (ids) => models.orderItemsDB._query(`SELECT COALESCE(SUM(200 + COALESCE(OCTET_LENGTH(config_json), 0) + COALESCE(OCTET_LENGTH(geometry_json), 0) + COALESCE(OCTET_LENGTH(dfm_json), 0)), 0) AS n FROM order_items WHERE order_id IN (${ids.map(() => "?").join(", ")})`, ids)[0].n;
  const heavyBytes = bytesOf(heavyOrders.map((o) => o.orderId));
  // Nothing else can be removed. Unpaid orders are closed down to 5 points under the clean-up line; the
  // database stands over that by a little less than the heavy account's lines. (The line where visitors
  // are turned away is put at the same place for this case, so "a little over" is over both.)
  const max = limits.databaseMaxBytes;
  const downTo = limits.dbSweepFraction - 0.05;
  const prev = process.env.DB_RESERVED_PERCENT;
  process.env.DB_RESERVED_PERCENT = String(100 - Math.round(downTo * 100));
  h.sent.length = 0;
  let r;
  try { r = await pressure.relieveDatabase(models, { force: true, sync: true, database: sized(max * downTo + heavyBytes - 400) }); }
  finally { if (prev === undefined) delete process.env.DB_RESERVED_PERCENT; else process.env.DB_RESERVED_PERCENT = prev; }
  assert.strictEqual(r.closedUnpaidOrders, 2, JSON.stringify(r));
  for (const o of heavyOrders) {
    assert.strictEqual(order(o.orderId).status, "expired");
    assert.ok(h.stripe.expired.includes(o.sessionId), "its payment page was closed at Stripe first");
    assert.strictEqual(linesOf(o.orderId), 0, "and its lines went");
  }
  const told = h.sent.filter((m) => m.to === "heavy2@buyer.test" && /was closed/i.test(m.subject));
  assert.strictEqual(told.length, 2, h.sent.map((m) => `${m.to}: ${m.subject}`).join(" | "));
  assert.ok(/Nothing was charged/.test(told[0].text));
  assert.strictEqual(order(lightOrder.orderId).status, "pending_payment", "the light holder was not reached");
  assert.strictEqual(linesOf(lightOrder.orderId), 2);
  for (const o of [firm, phone, flagged]) {
    assert.strictEqual(order(o.id).status, "pending_payment", `${o.rfqId ? "firm quote" : o.attention ? "flagged" : "phone"} order left alone`);
    assert.strictEqual(linesOf(o.id), 1);
  }
});

test("an unpaid order that turns out to be paid when its page is closed is settled, with every line", async () => {
  empty();
  const who = await h.register("paid-now@buyer.test");
  const o = await unpaidOrder(who, 5);
  h.pay(o.sessionId); // Stripe has the money; no webhook has arrived
  const prev = process.env.DB_RESERVED_PERCENT;
  process.env.DB_RESERVED_PERCENT = "20";
  let r;
  try { r = await pressure.relieveDatabase(models, { force: true, sync: true, database: sized(limits.databaseMaxBytes * 0.95) }); }
  finally { if (prev === undefined) delete process.env.DB_RESERVED_PERCENT; else process.env.DB_RESERVED_PERCENT = prev; }
  assert.strictEqual(r.closedUnpaidOrders, 0, JSON.stringify(r));
  assert.strictEqual(order(o.orderId).status, "paid");
  assert.strictEqual(linesOf(o.orderId), 5);
});

run(() => h.stop());
