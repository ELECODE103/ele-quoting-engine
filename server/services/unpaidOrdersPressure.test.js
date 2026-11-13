/**
 * Unpaid orders are not a way to hold the file store (independent re-review 2026-11-12, F-12).
 * Run: node server/services/unpaidOrdersPressure.test.js
 *
 * Before: a file on an unpaid order was held outright for at least 48 hours, and for good when the
 * order had no payment page; the pressure pass never touched it. Thirteen accounts that pressed
 * "pay" and never paid held the store at 100 %: no visitor and no customer could upload. Each case
 * below fails on that code.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// A test-sized store: 10 MB, 6 MB per sender, so a sender's protected share is 2 MB.
process.env.UPLOAD_DIR_MAX_MB = "10";
process.env.UPLOAD_STORED_MB_PER_IP = "6";
process.env.UPLOAD_STORED_MB_PER_ACCOUNT = "6";
process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Unpaid orders under storage pressure");
const MB = 1024 * 1024;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

let h, models, pressure, guards, lifecycle, dataDir;
const uploadsDir = () => path.join(dataDir, "uploads");
const onDisk = (p) => fs.existsSync(path.join(uploadsDir(), p.name));
const storedMb = () => { guards.storage.invalidate(); return guards.storage.scan() / MB; };

/** A real uploaded cube made to look like a `bytes`-sized upload by `token` from `ageMs` ago. */
async function storedPart(token, bytes, ageMs) {
  const data = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl"));
  const up = await h.form("/api/upload", {}, { files: { name: "cube_20mm.stl", data } }, token);
  assert.strictEqual(up.status, 200, up.text.slice(0, 200));
  const id = up.body.parts[0].partId;
  const name = models.partsDB.getRow(id).storedName;
  fs.writeFileSync(path.join(uploadsDir(), name), Buffer.alloc(bytes, 1));
  require("../models/database").getDatabase().run("UPDATE parts SET file_size = ?, created_at = ? WHERE id = ?", [bytes, new Date(Date.now() - ageMs).toISOString(), id]);
  return { id, name };
}
/** Price `parts` for `token` and press pay. Returns the order id and its Stripe session id. */
async function unpaidOrder(token, parts) {
  const q = await h.post("/api/quote", { parts: parts.map((p) => h.cncConfig(p.id, 1)), leadTimeSlug: "standard" }, token);
  assert.strictEqual(q.status, 200, q.text.slice(0, 200));
  const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, token);
  assert.strictEqual(c.status, 200, c.text.slice(0, 200));
  return { orderId: c.body.orderId, sessionId: String(c.body.sessionUrl).split("/").pop(), quoteId: q.body.quoteId };
}

/** Start a case with an empty store: no parts, quotes or orders, no files. */
function emptyStore() {
  require("../models/database").batch(() => { models.orderItemsDB.clear(); models.ordersDB.clear(); models.quotesDB.clear(); models.partsDB.clear(); });
  for (const f of fs.readdirSync(uploadsDir())) fs.unlinkSync(path.join(uploadsDir(), f));
  guards.storage.invalidate();
  pressure.state.storageQuietUntil = 0;
}

test("setup", async () => {
  h = await start({ mailer: "configured" });
  models = h.models;
  pressure = require("./storagePressure");
  guards = require("../security/uploadGuards");
  lifecycle = require("./orderLifecycle");
  dataDir = process.env.QUOTING_DATA_DIR;
  await h.admin();
});

test("three accounts press pay and never pay, and the store is full: the pass closes unpaid orders from the heaviest holder first, tells each buyer, and room is made; a paid order and a light holder are not touched", async () => {
  const heavyA = await h.register("heavy-a@buyer.test");
  const heavyB = await h.register("heavy-b@buyer.test");
  const light = await h.register("light@buyer.test");
  const payer = await h.register("payer@buyer.test");
  // 3.2 + 3.0 + 0.4 + 1.4 + the paid 1.6 = 9.6 MB of a 10 MB store, everything uploaded three hours ago.
  const a = [await storedPart(heavyA, 1.6 * MB, 3 * HOUR), await storedPart(heavyA, 1.6 * MB, 3 * HOUR)];
  const b = [await storedPart(heavyB, 1.5 * MB, 3 * HOUR), await storedPart(heavyB, 1.5 * MB, 3 * HOUR)];
  const l = [await storedPart(light, 0.4 * MB, 3 * HOUR)];
  const p = [await storedPart(payer, 1.6 * MB, 3 * HOUR)];
  const loose = [await storedPart(payer, 1.4 * MB, 3 * HOUR)]; // a saved quote, not ordered
  const orderA = await unpaidOrder(heavyA, a);
  const orderB = await unpaidOrder(heavyB, b);
  const orderL = await unpaidOrder(light, l);
  const paid = await unpaidOrder(payer, p);
  await h.completed(paid.sessionId);
  await h.post("/api/quote", { parts: loose.map((x) => h.cncConfig(x.id, 1)), leadTimeSlug: "standard" }, payer);
  assert.ok(storedMb() > 9.4, `the store is full: ${storedMb().toFixed(1)} MB of 10`);
  assert.strictEqual(guards.storage.hasRoom(1 * MB), false, "a 1 MB upload has no room");
  // Every unpaid order's payment page is open: all of it is held outright, as before.
  const refs = require("./rowRetention").references(models);
  for (const part of [...a, ...b, ...l, ...p]) assert.ok(refs.partsHard.has(part.id));

  h.sent.length = 0;
  const r = await pressure.relieveStorage(models, { force: true });
  assert.ok(r.closedUnpaidOrders >= 1, JSON.stringify(r));
  // The heaviest holder went first, and its payment page was closed at Stripe before anything was touched.
  assert.strictEqual(models.ordersDB.getById(orderA.orderId).status, "expired");
  assert.ok(h.stripe.expired.includes(orderA.sessionId), "closed at Stripe");
  assert.strictEqual(h.stripe.sessions[orderA.sessionId].status, "expired");
  assert.strictEqual(models.quotesDB.getById(orderA.quoteId) ? models.quotesDB.getById(orderA.quoteId).status : "draft", "draft", "its quote was given back (or went with its file)");
  // The buyer was told, once, in words: nothing was charged, and what to do.
  const told = h.sent.filter((m) => m.to === "heavy-a@buyer.test" && /unpaid order .* was closed/i.test(m.subject));
  assert.strictEqual(told.length, 1, h.sent.map((m) => `${m.to}: ${m.subject}`).join(" | "));
  assert.ok(/Nothing was charged/.test(told[0].text) && /upload the files again/i.test(told[0].text), told[0].text);
  // Room was made: under the line unpaid orders are closed down to (5 points under the line the clean-up starts at), and an upload has room again.
  assert.ok(r.bytesAfter < r.bytesBefore && r.bytesAfter <= 0.76 * 10 * MB, `${(r.bytesBefore / MB).toFixed(1)} MB → ${(r.bytesAfter / MB).toFixed(1)} MB`);
  assert.strictEqual(guards.storage.hasRoom(1 * MB), true);
  // Never: the file of the order that was paid for.
  assert.ok(onDisk(p[0]), "the paid order's file is still here");
  assert.strictEqual(models.ordersDB.getById(paid.orderId).status, "paid");
  // The lightest holder of unpaid orders was not reached: its order is open and its file is here.
  assert.strictEqual(models.ordersDB.getById(orderL.orderId).status, "pending_payment");
  assert.ok(onDisk(l[0]));
  assert.strictEqual(h.sent.filter((m) => m.to === "light@buyer.test").length, 0);
  // Each holder whose order was closed keeps its protected share (2 MB here): at least one of its files.
  assert.ok(a.some(onDisk), "the heaviest holder keeps its share");
  // Whoever of the two heavy holders was not needed is left alone entirely.
  const bClosed = models.ordersDB.getById(orderB.orderId).status === "expired";
  if (!bClosed) assert.ok(b.every(onDisk));
});

test("an unpaid order that turns out to be PAID when its page is closed is settled and keeps its files; one whose page cannot be confirmed closed is left alone", async () => {
  emptyStore();
  const one = await h.register("paid-late@buyer.test");
  const two = await h.register("unknown@buyer.test");
  const filler = await h.register("filler@buyer.test");
  // Heaviest first: the one that was paid, then the one Stripe cannot answer for, then the one that can be closed.
  const x = [await storedPart(one, 3.2 * MB, 3 * HOUR)];
  const y = [await storedPart(two, 3.0 * MB, 3 * HOUR)];
  const orderX = await unpaidOrder(one, x);
  const orderY = await unpaidOrder(two, y);
  // Fill the rest of the store with files on an unpaid order that CAN be closed.
  const z = [];
  for (let i = 0; i < 5; i++) z.push(await storedPart(filler, 0.56 * MB, 3 * HOUR));
  const orderZ = await unpaidOrder(filler, z);
  assert.ok(storedMb() > 8.8, `the store is past the line where visitors are turned away: ${storedMb().toFixed(1)} MB of 10`);
  h.pay(orderX.sessionId); // Stripe has the money; no webhook has arrived
  // For order Y Stripe answers neither "closed" nor anything else.
  const realExpire = h.stripe.sessions[orderY.sessionId];
  const stripe = require("./stripeClient").get();
  const expire = stripe.checkout.sessions.expire;
  const retrieve = stripe.checkout.sessions.retrieve;
  stripe.checkout.sessions.expire = async (id) => { if (id === orderY.sessionId) throw new Error("stripe unavailable"); return expire(id); };
  stripe.checkout.sessions.retrieve = async (id) => { if (id === orderY.sessionId) throw new Error("stripe unavailable"); return retrieve(id); };
  h.sent.length = 0;
  let r;
  try { r = await pressure.relieveStorage(models, { force: true }); }
  finally { stripe.checkout.sessions.expire = expire; stripe.checkout.sessions.retrieve = retrieve; }
  assert.ok(realExpire);
  assert.strictEqual(models.ordersDB.getById(orderX.orderId).status, "paid", "paid in the meantime: settled, not closed");
  assert.ok(onDisk(x[0]), "and its file is kept for good");
  assert.strictEqual(h.sent.filter((m) => m.to === "paid-late@buyer.test" && /was closed/i.test(m.subject)).length, 0);
  assert.strictEqual(models.ordersDB.getById(orderY.orderId).status, "pending_payment", "Stripe could not say: the order is left as it is");
  assert.ok(onDisk(y[0]), "and so is its file: an order is never paid for after its file has gone");
  assert.strictEqual(lifecycle.sessionsFor(orderY.orderId).filter((s) => s.status === "open").length, 1, "its payment page is still on record as open");
  assert.strictEqual(models.ordersDB.getById(orderZ.orderId).status, "expired", "the one that could be closed was");
  assert.ok(r.closedUnpaidOrders >= 1);
});

test("never closed: a firm-quote order, an order the owner took by phone, an order flagged for the owner; never removed: a customer's upload in its first minutes", async () => {
  emptyStore();
  const who = await h.register("kept@buyer.test");
  const userId = models.usersDB.getAll().find((u) => u.email === "kept@buyer.test").id;
  const parts = [await storedPart(who, 1.2 * MB, 3 * HOUR), await storedPart(who, 1.2 * MB, 3 * HOUR), await storedPart(who, 1.2 * MB, 3 * HOUR)];
  const fresh = await storedPart(who, 1.2 * MB, 2 * MIN); // uploaded two minutes ago
  const mk = (over, part) => {
    const o = models.ordersDB.insert({ userId, status: "pending_payment", total: 100, subtotal: 100, customerEmail: "kept@buyer.test", ...over });
    models.orderItemsDB.insert({ orderId: o.id, partId: part.id, fileName: "cube.stl", quantity: 1 });
    return o;
  };
  const firm = mk({ rfqId: "rfq-1", paymentMethod: "card", stripeSessionId: "cs_firm", sessionExpiresAt: new Date(Date.now() + HOUR).toISOString() }, parts[0]);
  const phone = mk({ paymentMethod: "" }, parts[1]);
  const flagged = mk({ paymentMethod: "card", attention: "payment-mismatch", stripeSessionId: "cs_flag", sessionExpiresAt: new Date(Date.now() - 3 * HOUR).toISOString() }, parts[2]);
  const recent = await unpaidOrder(who, [fresh]);
  const filler = await h.register("filler2@buyer.test");
  for (let i = 0; i < 6; i++) await storedPart(filler, 0.8 * MB, 3 * HOUR);
  assert.ok(storedMb() > 9.4, `the store is full: ${storedMb().toFixed(1)} MB of 10`);
  const r = await pressure.relieveStorage(models, { force: true });
  assert.ok(r.removedUploads >= 3 && r.closedUnpaidOrders === 0, JSON.stringify(r));
  for (const o of [firm, phone, flagged]) assert.strictEqual(models.ordersDB.getById(o.id).status, "pending_payment", `${o.rfqId ? "firm quote" : o.attention ? "flagged" : "phone"} order left alone`);
  for (const part of parts) assert.ok(onDisk(part));
  assert.ok(onDisk(fresh), "a signed-in customer's upload of two minutes ago is never removed");
  assert.strictEqual(models.ordersDB.getById(recent.orderId).status, "pending_payment", "and an order is not closed for a file that could not be removed anyway");
});

run(() => h.stop());
