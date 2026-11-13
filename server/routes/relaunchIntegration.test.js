/**
 * Relaunch integration (2026-11-12): what has to hold once the price-integrity work
 * (review-fixes) and the order-lifecycle work (order-lifecycle-fixes) are in one tree.
 * Run: `node server/routes/relaunchIntegration.test.js`
 *
 *   1. Every route that makes an order or a Stripe session goes through BOTH choke points:
 *      the pricing check (routes/api.js verifyQuoteForOrder → priceQuote) and the one place a
 *      session is made (services/orderLifecycle.js openSession), at expectedCharge(order).
 *   2. One quote, one order on the instant path, across the whole lifecycle: while the order is
 *      unpaid, once it is paid, after it is cancelled, after it is refunded — and the quote is
 *      usable again only when the state machine says so (the order lapsed unpaid).
 *   3. One admin change log: one table, one module, and both branches' events in it.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Relaunch integration: price integrity and order lifecycle in one tree");
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "1 Test St", shippingCity: "Testville", shippingState: "IL", shippingZip: "60000", shippingCountry: "US" };
const root = path.join(__dirname, "..", "..");

/** Every non-test source file under server/. */
function sources(dir = path.join(root, "server"), out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", "fixtures", "testSupport"].includes(e.name)) sources(p, out); continue; }
    if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const code = (p) => fs.readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("in the source: a Stripe session is created in one function, and an order row in three routes — each behind its check", () => {
  const files = sources();
  // 1. Stripe Checkout sessions: one call site in the whole server, inside orderLifecycle.openSession.
  const creators = files.filter((f) => /checkout\s*\.\s*sessions\s*\.\s*create\s*\(/.test(code(f))).map(rel);
  assert.deepStrictEqual(creators, ["server/services/orderLifecycle.js"], "sessions.create is called from one file");
  const lifecycle = code(path.join(root, "server", "services", "orderLifecycle.js"));
  assert.strictEqual((lifecycle.match(/sessions\s*\.\s*create\s*\(/g) || []).length, 1, "and from one place in it");
  const open = lifecycle.slice(lifecycle.indexOf("async function openSession("), lifecycle.indexOf("async function closeOpenSessions("));
  assert.ok(/sessions\.create\(/.test(open), "that place is openSession");
  assert.ok(/expectedCents\(order\)/.test(open) && /expectedChargeModule\.expectedCharge\(order\)/.test(lifecycle), "which works from expectedCharge(order)");
  // The lines Stripe is given are built from the same number.
  assert.ok(/const charge = expectedCharge\(order\)/.test(code(path.join(root, "server", "services", "orderEvents.js"))));
  // Nothing else reaches openSession except through checkoutSession (the per-order in-flight share).
  for (const f of files) {
    if (rel(f) === "server/services/orderLifecycle.js") continue;
    assert.ok(!/\bopenSession\s*\(/.test(code(f)), `${rel(f)} calls openSession directly`);
  }
  const callers = files.filter((f) => /createCheckoutSession\s*\(|lifecycle\(\)\.checkoutSession\s*\(/.test(code(f))).map(rel).sort();
  assert.deepStrictEqual(callers, ["server/routes/orders.js", "server/routes/rfq.js", "server/services/checkoutGuard.js", "server/services/orderEvents.js"]);

  // 2. Order rows: inserted by the two instant routes and the firm-quote accept, nowhere else.
  const inserters = Object.fromEntries(files.map((f) => [rel(f), (code(f).match(/ordersDB\.insert\s*\(/g) || []).length]).filter(([, n]) => n > 0));
  assert.deepStrictEqual(inserters, { "server/routes/orders.js": 2, "server/routes/rfq.js": 1 });
  // In orders.js every insert sits after the pricing check of its own step.
  // (2026-11-13) The checkout's read-price-compare-write is now one named function, orderStep(), which the
  // pricing runner runs (re-review F-08); the admin phone order is still inside its route handler. So the
  // pieces looked at are "each top-level function or route handler", and the refusal reads `return refuse(`
  // in the step where it read `return res.status(` in the handler. What is held is unchanged.
  const orders = code(path.join(root, "server", "routes", "orders.js"));
  const pieces = orders.split(/\n(?=router\.(?:get|post|put|delete)\(|function \w+\()/);
  let checked = 0;
  for (const body of pieces) {
    const insertAt = body.indexOf("ordersDB.insert(");
    if (insertAt < 0) continue;
    const checkAt = body.indexOf("verifyQuoteForOrder(");
    assert.ok(checkAt >= 0 && checkAt < insertAt, "an order is inserted only after verifyQuoteForOrder in the same step");
    assert.ok(/if \(!checked\.ok\) return (?:res\.status|refuse)\(/.test(body.slice(checkAt, insertAt)), "and only when it passed");
    checked++;
  }
  assert.strictEqual(checked, 2);
  // The resume of an unpaid order (no insert) is in the same step, after the same check, and the checkout
  // handler opens a payment page only for what that step returned.
  const step = pieces.find((b) => b.startsWith("function orderStep("));
  assert.ok(step.indexOf("verifyQuoteForOrder(") >= 0 && step.indexOf("verifyQuoteForOrder(") < step.indexOf("resumed: true"), "a resumed order is re-checked before it is handed on");
  const checkout = pieces.find((b) => b.startsWith('router.post("/checkout-session"'));
  assert.ok(checkout.indexOf("orderStep(req, quoteId)") >= 0 && checkout.indexOf("orderStep(req, quoteId)") < checkout.indexOf("checkoutGuard.sessionFor("), "a payment page is opened only after the step");
  assert.ok(!/verifyQuoteForOrder\(|ordersDB\.insert\(/.test(checkout), "and the handler itself neither prices nor inserts");
  // The firm-quote accept charges the owner's amount: it must be a positive amount of money and the terms that were sent.
  const rfq = code(path.join(root, "server", "routes", "rfq.js"));
  const accept = rfq.slice(rfq.indexOf('router.post("/quote/:token/accept"'));
  for (const guard of ["rfqFromToken(req, res)", "quote-not-payable", "quote-changed"]) assert.ok(accept.indexOf(guard) >= 0 && accept.indexOf(guard) < accept.indexOf("ordersDB.insert("), `accept checks ${guard} before it makes an order`);
  const fromToken = rfq.slice(rfq.indexOf("function rfqFromToken("), rfq.indexOf("function customerView("));
  assert.ok(/termsChanged\(rfq\)/.test(fromToken) && /claim\.amt !== rfqToken\.amountCents\(rfq\)/.test(fromToken), "the link opens only the terms and the amount it was sent for");
  // …and the owner's amount was held to "an amount of money" when it was saved and when it was sent.
  assert.strictEqual((rfq.match(/quoteIntegrity\.firmQuoteAmount\(/g) || []).length, 2);
});

(async () => {
  const h = await start();
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000"; // this suite is not about the per-account limiter (priceIntegrity.test.js is)
  const { ordersDB, quotesDB, adminAuditDB } = h.models;
  const { paymentSessionsDB } = h.lifecycle;
  const api = require("./api");
  const { expectedCharge } = require("../services/expectedCharge");
  const orderState = require("../services/orderState");
  let owner, buyer, partId;

  // Count every pass through the pricing check (the routes look the function up on the module each time).
  let verified = 0;
  const realVerify = api.verifyQuoteForOrder;
  // (2026-11-13) Checkout prices in pieces now (re-review F-08): the runner calls the check once per warm-up
  // pass, which stops before anything is judged, and once more for the pass that judges and writes. That
  // last one is what "passed the pricing check" means, so that is what is counted.
  api.verifyQuoteForOrder = (...args) => { const r = realVerify(...args); if (!(r && r.warming)) verified++; return r; };

  const quote = async (quantity = 2) => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, quantity)], leadTimeSlug: "standard" }, buyer);
    assert.strictEqual(q.status, 200, q.text);
    return q.body;
  };
  const checkout = (quoteId, token = buyer, extra = {}) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...extra }, token);
  const stripeAmount = (args) => args.line_items.reduce((sum, li) => sum + li.price_data.unit_amount * (li.quantity || 1), 0);

  test("setup: the owner, a buyer, a part", async () => {
    owner = await h.admin("Owner");
    buyer = await h.register("dana@buyer.test", "Dana Buyer");
    partId = await h.uploadCube();
  });

  test("a first checkout, the resume of an unpaid order and an admin phone order each pass the pricing check; every session is opened by openSession at expectedCharge(order)", async () => {
    const q = await quote(3);
    let before = verified;
    const sessionsBefore = h.stripe.created.length;
    const first = await checkout(q.quoteId);
    assert.strictEqual(first.status, 200, first.text);
    assert.strictEqual(verified, before + 1, "first checkout: priced again");
    const order = ordersDB.getById(first.body.orderId);
    const expected = expectedCharge(order).cents;
    assert.strictEqual(expected, Math.round(q.orderTotal * 100));
    assert.strictEqual(h.stripe.created.length, sessionsBefore + 1);
    assert.strictEqual(stripeAmount(h.stripe.created[h.stripe.created.length - 1]), expected, "Stripe is asked for expectedCharge(order), to the cent");
    const rec = paymentSessionsDB.getById(order.stripeSessionId);
    assert.deepStrictEqual([rec.orderId, rec.status, rec.amountCents], [order.id, "open", expected], "the session is recorded by openSession with the amount it was made for");
    assert.strictEqual(h.stripe.created[h.stripe.created.length - 1].allow_promotion_codes, false);
    assert.ok(h.stripe.created[h.stripe.created.length - 1].expires_at > Date.now() / 1000, "and it has an expiry");
    assert.strictEqual(quotesDB.getById(q.quoteId).status, "ordered", "the quote is claimed in the same step as the order");

    // Resume: same order, same session, and priced again before the page is handed out.
    before = verified;
    const again = await checkout(q.quoteId);
    assert.deepStrictEqual([again.status, again.body.orderId, again.body.sessionUrl], [200, first.body.orderId, first.body.sessionUrl]);
    assert.strictEqual(verified, before + 1, "resume: priced again");
    assert.strictEqual(h.stripe.created.length, sessionsBefore + 1, "no second session");
    assert.strictEqual(paymentSessionsDB.query((s) => s.orderId === order.id && s.status === "open").length, 1);

    // A resumed order whose price no longer holds is refused before any page is handed out.
    const pricing = require("../models").pricingDB;
    const row = pricing.getAll()[0];
    const rules = JSON.parse(JSON.stringify(row.rules));
    try {
      pricing.update(row.id, { rules: { ...rules, marginPercent: Math.min(0.9, (rules.marginPercent || 0.5) + 0.35) } });
      api.loadPricingRules();
      quotesDB.update(q.quoteId, { expiresAt: new Date(Date.now() - 1000).toISOString() }); // and its price hold has run out
      const stale = await checkout(q.quoteId);
      assert.ok([409, 410].includes(stale.status), stale.text);
      assert.ok(["quote-changed", "quote-expired"].includes(stale.body.code), stale.text);
      assert.strictEqual(h.stripe.created.length, sessionsBefore + 1, "and no new session was made for it");
    } finally {
      pricing.update(row.id, { rules });
      api.loadPricingRules();
    }

    // The admin phone order: same check, no session.
    const q2 = await quote(4);
    before = verified;
    const created = h.stripe.created.length;
    const phone = await h.post("/api/orders", { quoteId: q2.quoteId, ...SHIP }, owner);
    assert.strictEqual(phone.status, 201, phone.text);
    assert.strictEqual(verified, before + 1, "phone order: priced again");
    assert.strictEqual(h.stripe.created.length, created, "a phone order has no Stripe session");
    // …and from then on the quote is used up for the buyer as well.
    const taken = await checkout(q2.quoteId);
    assert.deepStrictEqual([taken.status, taken.body.code], [409, "quote-already-ordered"], taken.text);
  });

  test("a cheat row written straight into the database is stopped at the check, and Stripe is never asked", async () => {
    const q = await quote(5);
    const honest = q.orderTotal;
    quotesDB.update(q.quoteId, { orderTotal: 1, subtotal: 1, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const created = h.stripe.created.length;
    const r = await checkout(q.quoteId);
    assert.ok(r.status === 409 || r.status === 410, r.text);
    assert.strictEqual(h.stripe.created.length, created);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 0);
    assert.ok(honest > 1);
  });

  test("one quote, one order, across the lifecycle: unpaid, paid, cancelled and refunded orders keep their quote; only a lapsed one gives it back", async () => {
    // Paid.
    const a = await quote(2);
    const a1 = await checkout(a.quoteId);
    await h.completed(ordersDB.getById(a1.body.orderId).stripeSessionId);
    assert.strictEqual(ordersDB.getById(a1.body.orderId).status, "paid");
    const a2 = await checkout(a.quoteId);
    assert.deepStrictEqual([a2.status, a2.body.code, a2.body.orderId], [409, "quote-already-ordered", a1.body.orderId]);
    // …moved through the shop, and refunded in full: still one order for that quote.
    assert.strictEqual((await h.put(`/api/orders/${a1.body.orderId}/status`, { status: "in_production" }, owner)).status, 200);
    assert.strictEqual((await h.put(`/api/orders/${a1.body.orderId}/status`, { status: "refunded", reason: "customer cancelled, refunded in Stripe" }, owner)).status, 200);
    assert.strictEqual(orderState.holdsQuote(ordersDB.getById(a1.body.orderId)), true);
    assert.deepStrictEqual([(await checkout(a.quoteId)).body.code], ["quote-already-ordered"]);

    // Cancelled by the shop while unpaid: the card page is closed, and the quote stays used
    // (the owner can still mark a cancelled order paid; buying again is a new quote or Reorder).
    const b = await quote(2);
    const b1 = await checkout(b.quoteId);
    const bSession = ordersDB.getById(b1.body.orderId).stripeSessionId;
    assert.strictEqual((await h.put(`/api/orders/${b1.body.orderId}/status`, { status: "cancelled" }, owner)).status, 200);
    assert.ok(h.stripe.expired.includes(bSession), "its payment page was closed at Stripe");
    const b2 = await checkout(b.quoteId);
    assert.deepStrictEqual([b2.status, b2.body.code], [409, "quote-already-ordered"], b2.text);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === b.quoteId).length, 1);
    // An unpaid order cannot be jumped into production by hand.
    const c0 = await quote(2);
    const c01 = await checkout(c0.quoteId);
    const jump = await h.put(`/api/orders/${c01.body.orderId}/status`, { status: "in_production" }, owner);
    assert.deepStrictEqual([jump.status, jump.body.code], [409, "transition-not-allowed"]);

    // Lapsed unpaid (the session expired): the state machine gives the quote back, and it can be ordered again —
    // through the pricing check, as a new order with its own session.
    const c = await quote(2);
    const c1 = await checkout(c.quoteId);
    const cSession = h.stripe.sessions[ordersDB.getById(c1.body.orderId).stripeSessionId];
    cSession.status = "expired";
    const lapsed = await h.webhook("checkout.session.expired", cSession);
    assert.strictEqual(lapsed.status, 200, lapsed.text);
    assert.strictEqual(ordersDB.getById(c1.body.orderId).status, "expired");
    assert.strictEqual(quotesDB.getById(c.quoteId).status, "draft", "the quote was given back");
    const before = verified;
    const c2 = await checkout(c.quoteId);
    assert.strictEqual(c2.status, 200, c2.text);
    assert.notStrictEqual(c2.body.orderId, c1.body.orderId);
    assert.strictEqual(verified, before + 1);
    // Tidying the lapsed order away as "cancelled" changes nothing for the quote or for the live order.
    assert.strictEqual((await h.put(`/api/orders/${c1.body.orderId}/status`, { status: "cancelled" }, owner)).status, 200);
    assert.strictEqual(orderState.holdsQuote(ordersDB.getById(c1.body.orderId)), false);
    const c3 = await checkout(c.quoteId);
    assert.deepStrictEqual([c3.status, c3.body.orderId], [200, c2.body.orderId], "still the one live order");
    assert.deepStrictEqual(ordersDB.query((o) => o.quoteId === c.quoteId && orderState.holdsQuote(o)).map((o) => o.id), [c2.body.orderId]);
    // And once that one is paid, the quote is used up.
    await h.completed(ordersDB.getById(c2.body.orderId).stripeSessionId);
    assert.deepStrictEqual([(await checkout(c.quoteId)).body.code], ["quote-already-ordered"]);
  });

  test("two checkouts of one quote at the same moment: one order, one session, both priced", async () => {
    const q = await quote(6);
    const created = h.stripe.created.length;
    h.stripe.delayMs = 40;
    try {
      const [x, y] = await Promise.all([checkout(q.quoteId), checkout(q.quoteId)]);
      assert.deepStrictEqual([x.status, y.status], [200, 200], x.text + y.text);
      assert.strictEqual(x.body.orderId, y.body.orderId);
      assert.strictEqual(x.body.sessionUrl, y.body.sessionUrl);
    } finally { h.stripe.delayMs = 0; }
    assert.strictEqual(h.stripe.created.length, created + 1);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 1);
  });

  test("one change log: both branches' events are rows of the same table, in one shape, written by one module", async () => {
    const rows = adminAuditDB.getAll();
    const actions = new Set(rows.map((r) => `${r.area}/${r.action}`));
    for (const wanted of ["admin-account/create", "order/order.status", "order/order.cancel"]) assert.ok(actions.has(wanted), `${wanted} is in the log (have: ${[...actions].join(", ")})`);
    for (const r of rows) {
      assert.ok(r.area && r.action && r.createdAt, "every row says what and when");
      assert.ok(r.changes && typeof r.changes === "object" && !Array.isArray(r.changes));
      for (const pair of Object.values(r.changes)) assert.ok(Array.isArray(pair) && pair.length === 2, "changes are [before, after] pairs");
    }
    // The table has the one definition, whichever migration ran first.
    const db = require("../models/database").getDatabase();
    const cols = []; const st = db.prepare("PRAGMA table_info(admin_audit)"); while (st.step()) cols.push(st.getAsObject().name); st.free();
    assert.deepStrictEqual(cols.sort(), ["action", "area", "changes_json", "created_at", "entity_id", "id", "note", "target", "updated_at", "user_email", "user_id"]);
    assert.deepStrictEqual(require("../models/auditMigration").apply(db), [], "applying it again adds nothing");
    // One module writes it.
    const writers = sources().filter((f) => /adminAuditDB\s*\.\s*(insert|update|delete)\s*\(|store\(\)\s*\.\s*(insert|update|delete)\s*\(/.test(code(f))).map(rel);
    assert.deepStrictEqual(writers, ["server/services/audit.js"]);
    assert.ok(!/\.(update|delete)\s*\(/.test(code(path.join(root, "server", "services", "audit.js"))), "and it only ever inserts");
    // The Change log screen gets every row, newest first, with the reason.
    const shown = await h.get("/api/admin/audit", owner);
    assert.strictEqual(shown.status, 200);
    assert.strictEqual(shown.body.length, Math.min(200, rows.length));
    assert.ok(shown.body.some((r) => r.action === "order.status" && r.note && /refunded in Stripe/.test(r.note)));
  });

  test("a table made by either branch on its own gains the missing columns and loses nothing", async () => {
    const SQL = await require("sql.js")();
    const migration = require("../models/auditMigration");
    const cols = (db) => { const out = []; const st = db.prepare("PRAGMA table_info(admin_audit)"); while (st.step()) out.push(st.getAsObject().name); st.free(); return out; };
    // As review-fixes alone created it.
    const a = new SQL.Database();
    a.run("CREATE TABLE admin_audit (id TEXT PRIMARY KEY, user_id TEXT, user_email TEXT, area TEXT, action TEXT, target TEXT, changes_json TEXT, created_at TEXT, updated_at TEXT)");
    a.run("INSERT INTO admin_audit (id, area, action, target, changes_json) VALUES ('r1', 'material', 'update', 'cnc-delrin', '{\"pricePerKg\":[11,12.5]}')");
    assert.deepStrictEqual(migration.apply(a).sort(), ["admin_audit.entity_id", "admin_audit.note"]);
    // As order-lifecycle-fixes alone created it.
    const b = new SQL.Database();
    b.run("CREATE TABLE admin_audit (id TEXT PRIMARY KEY, user_id TEXT, user_email TEXT, action TEXT, entity TEXT, entity_id TEXT, note TEXT, before_json TEXT, after_json TEXT, created_at TEXT)");
    b.run("INSERT INTO admin_audit (id, action, entity, entity_id, note) VALUES ('l1', 'order.cancel', 'order', 'o-1', 'called off')");
    assert.deepStrictEqual(migration.apply(b).sort(), ["admin_audit.area", "admin_audit.changes_json", "admin_audit.target", "admin_audit.updated_at"]);
    for (const db of [a, b]) {
      assert.deepStrictEqual(migration.apply(db), [], "a second run adds nothing");
      for (const [name] of migration.COLUMNS) assert.ok(cols(db).includes(name), name);
      const st = db.prepare("SELECT COUNT(*) AS n FROM admin_audit"); st.step(); assert.strictEqual(st.getAsObject().n, 1, "the row is still there"); st.free();
    }
  });

  await run();
  api.verifyQuoteForOrder = realVerify;
  await h.stop();
})().catch((err) => { console.error(err); process.exit(1); });
