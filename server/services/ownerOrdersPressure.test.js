/**
 * The clean-up never closes an order that is the owner's to settle (review of the re-review fixes,
 * 2026-11-13, section F-12). Run: node server/services/ownerOrdersPressure.test.js
 *
 * Three kinds of order wait without a card payment being the buyer's next move:
 *   - an order the owner took by phone        (POST /api/orders as the owner: NO payment method is stored)
 *   - an order accepted on a purchase order   (firm quote, "po": waits for the owner to confirm the PO)
 *   - a firm-quote order paying by card       (the owner priced it and sent the link)
 *
 * Before: the clean-up's list took every unpaid order whose payment method was "card" OR NOT SET,
 * and "not set" is exactly how a phone order is stored, so a phone order was on the list and would
 * have been closed like an abandoned checkout. (The two older suites built their phone order with
 * an empty string for the method, which the list did not match, so they did not see it.)
 *
 * Here each kind is made the way the site makes it, through its real route, is given the heaviest
 * files and the fattest lines of anybody, and the clean-up is run under pressure on both sides: the
 * file store and the database. An ordinary abandoned card checkout beside them IS closed, which
 * shows the pass reached the closing step.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.UPLOAD_DIR_MAX_MB = "10";
process.env.UPLOAD_STORED_MB_PER_IP = "6";
process.env.UPLOAD_STORED_MB_PER_ACCOUNT = "6";
process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("The clean-up and the owner's orders: phone, purchase order, firm quote");
const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

let h, models, pressure, guards, lifecycle, database, limits, owner, dataDir;
const uploadsDir = () => path.join(dataDir, "uploads");
const onDisk = (p) => fs.existsSync(path.join(uploadsDir(), p.name));
const storedMb = () => { guards.storage.invalidate(); return guards.storage.scan() / MB; };
const order = (id) => models.ordersDB.getById(id);
const linesOf = (id) => models.orderItemsDB._query("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?", [id])[0].n;

/** A real uploaded cube made to look like a `bytes`-sized upload by `token` from `ageMs` ago. */
async function storedPart(token, bytes, ageMs) {
  const data = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl"));
  const up = await h.form("/api/upload", {}, { files: { name: "cube_20mm.stl", data } }, token);
  assert.strictEqual(up.status, 200, up.text.slice(0, 200));
  const id = up.body.parts[0].partId;
  const name = models.partsDB.getRow(id).storedName;
  fs.writeFileSync(path.join(uploadsDir(), name), Buffer.alloc(bytes, 1));
  database.getDatabase().run("UPDATE parts SET file_size = ?, created_at = ? WHERE id = ?", [bytes, new Date(Date.now() - ageMs).toISOString(), id]);
  return { id, name };
}
const quoteOf = async (token, part) => { const q = await h.post("/api/quote", { parts: [h.cncConfig(part.id, 1)], leadTimeSlug: "standard" }, token); assert.strictEqual(q.status, 200, q.text.slice(0, 200)); return q.body.quoteId; };

/** An abandoned card checkout: the kind the clean-up may close. */
async function cardCheckout(token, part) {
  const c = await h.post("/api/orders/checkout-session", { quoteId: await quoteOf(token, part), ...SHIP }, token);
  assert.strictEqual(c.status, 200, c.text.slice(0, 200));
  return { orderId: c.body.orderId, sessionId: String(c.body.sessionUrl).split("/").pop() };
}
/** An order the owner takes by phone, through the owner's own route. */
async function phoneOrder(token, part) {
  const r = await h.post("/api/orders", { quoteId: await quoteOf(token, part), ...SHIP }, owner);
  assert.strictEqual(r.status, 201, r.text.slice(0, 200));
  return { orderId: r.body.orderId };
}
/** A firm quote requested, priced by the owner and accepted by card or on a purchase order. */
async function firmOrder(token, email, part, method) {
  const quoteId = await quoteOf(token, part);
  const r = await h.form("/api/rfq", { quoteId, contactName: "Pat Buyer", email, notes: "please quote", ...SHIP }, {}, token);
  assert.strictEqual(r.status, 201, r.text.slice(0, 200));
  const sent = await h.put(`/api/rfq/admin/${r.body.rfqId}`, { quotedTotal: 480, quotedLeadDays: 7, status: "quoted" }, owner);
  assert.strictEqual(sent.status, 200, sent.text.slice(0, 200));
  const mail = [...h.sent].reverse().find((m) => m.to === email && /firm-quote\//.test(m.text || ""));
  const link = (mail.text.match(/firm-quote\/([A-Za-z0-9._~-]+)/) || [])[1];
  const a = await h.raw("POST", `/api/rfq/quote/${link}/accept`, { json: { method, ...(method === "po" ? { poNumber: "PO-4471" } : {}), ...SHIP, seenTotal: 480 } });
  assert.strictEqual(a.status, 201, a.text.slice(0, 200));
  return { orderId: models.rfqsDB.getById(r.body.rfqId).orderId, rfqId: r.body.rfqId };
}
function emptyStore() {
  database.batch(() => { models.orderItemsDB.clear(); models.ordersDB.clear(); models.quotesDB.clear(); models.rfqsDB.clear(); models.partsDB.clear(); });
  for (const f of fs.readdirSync(uploadsDir())) fs.unlinkSync(path.join(uploadsDir(), f));
  guards.storage.invalidate();
  pressure.state.storageQuietUntil = 0;
  pressure.state.databaseQuietUntil = 0;
}

test("setup", async () => {
  h = await start({ mailer: "configured" });
  models = h.models;
  pressure = require("./storagePressure");
  guards = require("../security/uploadGuards");
  lifecycle = require("./orderLifecycle");
  database = require("../models/database");
  limits = require("../security/limits").limits;
  dataDir = process.env.QUOTING_DATA_DIR;
  owner = await h.admin();
});

let kinds;
test("the three kinds as the site stores them: a phone order has NO payment method on record; the others carry theirs and their request", async () => {
  emptyStore();
  const who = await h.register("kinds@buyer.test");
  const p = [await storedPart(who, 2.9 * MB, 3 * HOUR), await storedPart(who, 2.9 * MB, 3 * HOUR), await storedPart(who, 2.9 * MB, 3 * HOUR)];
  kinds = {
    who, parts: p,
    phone: await phoneOrder(who, p[0]),
    po: await firmOrder(who, "kinds@buyer.test", p[1], "po"),
    firmCard: await firmOrder(who, "kinds@buyer.test", p[2], "card"),
  };
  const rows = Object.fromEntries(["phone", "po", "firmCard"].map((k) => [k, database.getDatabase().exec("SELECT status, payment_method, rfq_id FROM orders WHERE id = ?", [kinds[k].orderId])[0].values[0]]));
  assert.deepStrictEqual(rows.phone, ["pending_payment", null, null], "a phone order: waiting, payment method NULL");
  assert.deepStrictEqual(rows.po.slice(0, 2), ["pending_po", "po"]);
  assert.deepStrictEqual(rows.firmCard.slice(0, 2), ["pending_payment", "card"]);
  assert.ok(rows.po[2] && rows.firmCard[2], "both firm-quote orders name their request");
  for (const k of ["phone", "po", "firmCard"]) assert.strictEqual(lifecycle.isWaitingCardOrder(order(kinds[k].orderId)), false, `${k}: not an order the site may close`);
});

test("the file store is full and these three hold the most: the clean-up closes the abandoned card checkout beside them and none of the three, however often it runs", async () => {
  const plain = await h.register("plain@buyer.test");
  const plainPart = await storedPart(plain, 1.0 * MB, 3 * HOUR);
  const abandoned = await cardCheckout(plain, plainPart);
  assert.ok(storedMb() > 9.4, `the store is full: ${storedMb().toFixed(1)} MB of 10`);
  assert.strictEqual(guards.storage.hasRoom(1 * MB), false);
  h.sent.length = 0;
  const sessionsExpiredBefore = h.stripe.expired.length;

  const first = await pressure.relieveStorage(models, { force: true });
  assert.strictEqual(first.closedUnpaidOrders, 1, JSON.stringify(first));
  assert.strictEqual(order(abandoned.orderId).status, "expired", "the abandoned card checkout was closed: the pass did reach the closing step");
  assert.ok(h.stripe.expired.includes(abandoned.sessionId));
  // Still over the line (the three hold 8.7 MB of 10): two more passes have only the owner's orders to look at.
  for (let i = 0; i < 2; i++) {
    pressure.state.storageQuietUntil = 0;
    const again = await pressure.relieveStorage(models, { force: true });
    assert.strictEqual(again ? again.closedUnpaidOrders : 0, 0, JSON.stringify(again));
  }
  assert.ok(storedMb() > 8.5, `still full: ${storedMb().toFixed(1)} MB`);
  const expectStatus = { phone: "pending_payment", po: "pending_po", firmCard: "pending_payment" };
  for (const k of ["phone", "po", "firmCard"]) {
    const o = order(kinds[k].orderId);
    assert.deepStrictEqual([o.status, o.expiredAt || null, o.attention || ""], [expectStatus[k], null, ""], `${k}: left exactly as it was`);
    assert.ok(linesOf(o.id) >= 1, `${k}: its lines are there`);
    assert.deepStrictEqual(await lifecycle.closeUnderPressure(o.id), { outcome: "kept" }, `${k}: asked directly, the closing step refuses it`);
    assert.deepStrictEqual(await lifecycle.closeUnderPressure(o.id, { reason: "database" }), { outcome: "kept" });
    assert.deepStrictEqual((await lifecycle.cancelByBuyer(o.id)).outcome, "kept", `${k}: nor can it be cancelled from the buyer's side`);
  }
  for (const part of kinds.parts) assert.ok(onDisk(part), "their files are still on the disk");
  assert.strictEqual(h.stripe.expired.length, sessionsExpiredBefore + 1, "one payment page was expired at Stripe: the abandoned checkout's, and not the firm quote's");
  assert.strictEqual(h.sent.filter((m) => m.to === "kinds@buyer.test").length, 0, "their buyer was told nothing");
  assert.strictEqual(models.rfqsDB.getById(kinds.po.rfqId).status, "accepted");
  assert.strictEqual(models.rfqsDB.getById(kinds.firmCard.rfqId).status, "accepted");
});

test("the database is at its ceiling: the same on that side. Abandoned card checkouts are closed and their lines cleared; the three are not, and their lines stay", async () => {
  // A second abandoned checkout, so the database pass has something it may close.
  const plain = await h.register("plain2@buyer.test");
  const abandoned = await cardCheckout(plain, await storedPart(plain, 0.2 * MB, 3 * HOUR));
  const before = Object.fromEntries(["phone", "po", "firmCard"].map((k) => [k, linesOf(kinds[k].orderId)]));
  // The database "is" far over its ceiling: the pass wants more bytes back than every order line holds.
  const huge = limits.databaseMaxBytes * 3;
  const fake = { ...database, liveSize: () => huge, usedSize: () => huge, fileSize: () => huge };
  h.sent.length = 0;
  for (let i = 0; i < 2; i++) {
    pressure.state.databaseQuietUntil = 0;
    await pressure.relieveDatabase(models, { force: true, sync: true, database: fake });
  }
  const direct = await pressure.relieveUnpaidOrderLines(models, { need: huge, sync: true });
  assert.strictEqual(order(abandoned.orderId).status, "expired", "the abandoned card checkout was closed by the database pass");
  assert.strictEqual(linesOf(abandoned.orderId), 0, "and its lines were cleared");
  assert.strictEqual(direct.closed, 0, `nothing was left that the pass may close: ${JSON.stringify(direct)}`);
  const expectStatus = { phone: "pending_payment", po: "pending_po", firmCard: "pending_payment" };
  for (const k of ["phone", "po", "firmCard"]) {
    const o = order(kinds[k].orderId);
    assert.deepStrictEqual([o.status, o.linesClearedAt || null], [expectStatus[k], null], `${k}: left exactly as it was`);
    assert.strictEqual(linesOf(o.id), before[k], `${k}: every line is still there`);
  }
  assert.strictEqual(h.sent.filter((m) => m.to === "kinds@buyer.test").length, 0);
});

test("a phone order the owner cancelled keeps its lines under database pressure, so the owner can still mark it paid by hand", async () => {
  const id = kinds.phone.orderId;
  const moved = await h.put(`/api/orders/${id}/status`, { status: "cancelled" }, owner);
  assert.strictEqual(moved.status, 200, moved.text.slice(0, 200));
  database.getDatabase().run("UPDATE orders SET updated_at = ?, cancelled_at = ? WHERE id = ?", [new Date(Date.now() - 3 * HOUR).toISOString(), new Date(Date.now() - 3 * HOUR).toISOString(), id]);
  const lines = linesOf(id);
  assert.ok(!pressure.lapsedOrderLines(models).some((o) => o.id === id), "it is not on the list of orders whose lines may be cleared");
  assert.strictEqual(pressure.clearOrderLines(models, id), 0, "and asked directly, its lines are not cleared");
  const huge = limits.databaseMaxBytes * 3;
  pressure.state.databaseQuietUntil = 0;
  await pressure.relieveDatabase(models, { force: true, sync: true, database: { ...database, liveSize: () => huge, usedSize: () => huge, fileSize: () => huge } });
  assert.strictEqual(linesOf(id), lines);
  const paid = await h.put(`/api/orders/${id}/status`, { status: "paid", reason: "cheque 1042 received", paidVia: "cheque" }, owner);
  assert.strictEqual(paid.status, 200, paid.text.slice(0, 200));
  assert.strictEqual(order(id).status, "paid");
});

run(() => h.stop());
