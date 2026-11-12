/**
 * Reorder (POST /api/orders/:id/reorder) on the merged tree — re-review 2026-11-12, RR-14 and RR-05.
 *
 *   RR-14a  Reorder was accepted for an order that was never paid for: an abandoned checkout was a
 *           ticket to the re-pricing route. Now it is for an order that was really placed — paid at
 *           some point, or accepted on a PO and taken into work (services/orderState.js wasPlaced) —
 *           and the order page only offers the button then (`canReorder`).
 *   RR-14b  Two lines of the same part in different stock (two thicknesses) must come back as two
 *           lines, each with its own thickness and quantity. That holds on this tree; this keeps it.
 *   RR-05   The main-thread stall of a reorder on a dense part is NOT fixed here: it needs modules
 *           from availability-fixes. The call site in routes/orders.js carries the note; the last
 *           case holds the note in place so the next merge cannot miss it.
 * Run: node server/routes/reorder.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { start, runner } = require("../testSupport/harness");
const gen = require("../../tools/security/review-uploads/gen");

const { test, run } = runner("Reorder: only an order that was placed; every line comes back");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Test St", shippingCity: "Testville", shippingState: "IL", shippingZip: "60000", shippingCountry: "US" };

(async () => {
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000"; // this suite makes more than 12 checkouts on one account
  const h = await start();
  const { ordersDB, orderItemsDB, quotesDB, materialsDB } = h.models;
  const orderState = require("../services/orderState");
  const lifecycle = require("../services/orderLifecycle");
  let owner, buyer, cube, panel;

  const order = (id) => ordersDB.getById(id);
  /** An order awaiting payment, from the given lines. */
  async function pending(parts) {
    const q = await h.post("/api/quote", { parts, leadTimeSlug: "standard" }, buyer);
    assert.strictEqual(q.status, 200, q.text);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    return c.body.orderId;
  }
  const pay = async (id) => { assert.strictEqual((await h.completed(order(id).stripeSessionId)).status, 200); assert.strictEqual(order(id).status, "paid"); return id; };
  const reorder = (id, token = buyer) => h.post(`/api/orders/${id}/reorder`, {}, token);
  const quotes = () => quotesDB.getAll().length;
  async function refused(id, what) {
    const before = quotes();
    const r = await reorder(id);
    assert.deepStrictEqual([r.status, r.body.code], [409, "reorder-not-available"], `${what}: ${r.text}`);
    assert.strictEqual(quotes(), before, `${what}: no quote was made`);
    assert.strictEqual((await h.get(`/api/orders/${id}`, buyer)).body.canReorder, false, `${what}: the order page is told not to offer it`);
    return r;
  }
  async function allowed(id, what) {
    assert.strictEqual((await h.get(`/api/orders/${id}`, buyer)).body.canReorder, true, `${what}: the order page offers it`);
    const r = await reorder(id);
    assert.strictEqual(r.status, 201, `${what}: ${r.text}`);
    assert.strictEqual(quotesDB.getById(r.body.quoteId).status, "draft", what);
    return r;
  }

  test("setup: the owner, a buyer, a cube and a DXF panel", async () => {
    owner = await h.admin();
    buyer = await h.register("pat@buyer.test", "Pat Buyer");
    const up = async (name, data, fields = {}) => { const r = await h.form("/api/upload", fields, { files: { name, data } }, buyer); assert.strictEqual(r.status, 200, r.text); return r.body.parts[0].partId; };
    cube = await up("cube_20mm.stl", fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl")));
    panel = await up("panel.dxf", Buffer.from(gen.dxfDoc({ entities: gen.dxfRect(0, 0, 200, 150) })), { process: "routing" });
  });

  test("RR-14a: an order still awaiting payment cannot be reordered, and the answer says to go back to checkout", async () => {
    const id = await pending([h.cncConfig(cube, 2)]);
    const r = await refused(id, "awaiting payment");
    assert.strictEqual(r.body.status, "pending_payment");
    assert.ok(/Go back to checkout/.test(r.body.error), r.body.error);
  });

  test("RR-14a: an order that lapsed unpaid, and one the shop cancelled before any payment, cannot be reordered", async () => {
    const lapsed = await pending([h.cncConfig(cube, 3)]);
    lifecycle.expireOrder(lapsed, "test: the payment page ran out");
    assert.strictEqual(order(lapsed).status, "expired");
    await refused(lapsed, "expired");
    const cancelled = await pending([h.cncConfig(cube, 4)]);
    assert.strictEqual((await h.put(`/api/orders/${cancelled}/status`, { status: "cancelled", reason: "customer asked" }, owner)).status, 200);
    assert.strictEqual(order(cancelled).status, "cancelled");
    await refused(cancelled, "cancelled before payment");
  });

  test("RR-14a: a paid order can be reordered — and still can after it is in work, shipped, refunded, or cancelled after payment", async () => {
    const paid = await pay(await pending([h.cncConfig(cube, 5)]));
    await allowed(paid, "paid");
    for (const status of ["in_production", "shipped"]) {
      assert.strictEqual((await h.put(`/api/orders/${paid}/status`, { status }, owner)).status, 200, status);
      await allowed(paid, status);
    }
    assert.strictEqual((await h.put(`/api/orders/${paid}/status`, { status: "refunded", reason: "returned" }, owner)).status, 200);
    await allowed(paid, "refunded");
    const called = await pay(await pending([h.cncConfig(cube, 6)]));
    assert.strictEqual((await h.put(`/api/orders/${called}/status`, { status: "cancelled", reason: "customer asked" }, owner)).status, 200);
    assert.ok(order(called).paidAt, "it was paid before it was called off");
    await allowed(called, "cancelled after payment");
  });

  test("RR-14a: the rule is the state machine's — every state is decided, and a PO order counts once the shop has taken it into work", () => {
    const placed = (o) => orderState.wasPlaced(o);
    assert.deepStrictEqual(orderState.STATES.filter((s) => placed({ status: s })), [...orderState.FULFILMENT, "refunded"]);
    assert.deepStrictEqual(orderState.STATES.filter((s) => !placed({ status: s })), ["pending_payment", "pending_po", "expired", "cancelled", "paid_amount_mismatch"]);
    for (const s of ["cancelled", "paid_amount_mismatch", "expired"]) assert.strictEqual(placed({ status: s, paidAt: "2026-11-01T00:00:00.000Z" }), true, `${s} with a payment on record`);
    assert.strictEqual(placed({ status: "pending_po" }), false, "a PO the shop has not confirmed");
    assert.strictEqual(placed({ status: "in_production" }), true, "a PO order in work has no payment on record and is still a real order");
    assert.strictEqual(placed(null), false);
  });

  test("RR-14a: the owner can still rebuild a quote from any order; a stranger still cannot touch it", async () => {
    const id = await pending([h.cncConfig(cube, 7)]);
    assert.strictEqual((await reorder(id, owner)).status, 201);
    const stranger = await h.register("sam@other.test", "Sam Other");
    assert.strictEqual((await reorder(id, stranger)).status, 403);
  });

  test("RR-14b: two lines of one part in two thicknesses come back as two lines, each with its own thickness and quantity", async () => {
    const hdpe = materialsDB.getAll().find((m) => m.slug === "rt-hdpe");
    const mm = (hdpe.thicknesses || []).map((t) => t.mm).sort((a, b) => a - b);
    assert.ok(mm.length >= 2, "the sheet material stocks more than one thickness");
    const [thin, thick] = [mm[0], mm[mm.length - 1]];
    const line = (thicknessMm, quantity) => ({ partId: panel, materialSlug: "rt-hdpe", process: "routing", thicknessMm, quantity });
    const id = await pay(await pending([line(thin, 2), line(thick, 3)]));
    assert.deepStrictEqual(orderItemsDB.query((i) => i.orderId === id).map((i) => [Number(i.config.thicknessMm), i.quantity]).sort((a, b) => a[0] - b[0]), [[thin, 2], [thick, 3]]);
    const r = await reorder(id);
    assert.deepStrictEqual([r.status, r.body.parts, r.body.skipped], [201, 2, 0], r.text);
    const q = quotesDB.getById(r.body.quoteId);
    const got = (rows, pick) => rows.map(pick).sort((a, b) => a[0] - b[0]);
    assert.deepStrictEqual(got(q.config.parts, (p) => [p.thicknessMm, p.quantity, p.partId]), [[thin, 2, panel], [thick, 3, panel]], "the saved configuration");
    assert.deepStrictEqual(got(q.lineItems, (l) => [l.meta.thicknessMm, l.quantity]), [[thin, 2], [thick, 3]], "the priced lines");
    assert.notStrictEqual(q.lineItems[0].lineTotal, q.lineItems[1].lineTotal, "priced separately");
    // And what the builder is given when it opens the new quote.
    const s = await h.get(`/api/quote/${r.body.quoteId}/session`, buyer);
    assert.deepStrictEqual(got(s.body.parts, (p) => [p.config ? p.config.thicknessMm : p.thicknessMm, p.config ? p.config.quantity : p.quantity]), [[thin, 2], [thick, 3]], JSON.stringify(s.body.parts).slice(0, 300));
  });

  test("RR-05 (open, for the availability-fixes merge): the reorder route still prices on the main thread, and says so at the call site", () => {
    const src = fs.readFileSync(path.join(__dirname, "orders.js"), "utf8");
    const route = src.slice(src.indexOf('router.post("/:id/reorder"'), src.indexOf("GET /api/orders/:id/drawing"));
    assert.ok(/NOTE FOR THE availability-fixes MERGE \(re-review RR-05\)/.test(route), "the note is at the call site");
    assert.ok(route.indexOf("NOTE FOR THE availability-fixes MERGE") < route.indexOf("saveQuote("), "ahead of the call it is about");
    assert.ok(route.indexOf("orderState.wasPlaced(order)") < route.indexOf("saveQuote("), "and the order is checked before anything is priced");
  });

  await run(h.stop);
})().catch((err) => { console.error(err); process.exit(1); });
