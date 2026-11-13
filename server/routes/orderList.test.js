/**
 * The order list is a page of summaries, whatever the orders hold (independent re-review 2026-11-12, F-09),
 * and one sender may hold only so many unpaid orders (F-09, F-12: security/orderCaps.js).
 * Run: node server/routes/orderList.test.js
 *
 * Before: GET /api/orders loaded the part of every line of every order and put its measurements in the
 * answer. One account with a detailed drawing on four unpaid orders made the answer larger than the
 * site sends: 500 `answer-too-large` for that customer and for the owner, whose admin panel loads the
 * same route. Each case below fails on that code.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const { boxStl } = require("../testSupport/shapes");

const { test, run } = runner("Order list and unpaid-order ceilings");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

/** A 100 mm disc drawn as n short segments: cheap to cut, and its measurements are tens of kB. */
function fineDisc(n) {
  const out = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", "0", "LWPOLYLINE", "8", "0", "90", String(n), "70", "1"];
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; out.push("10", (50 + 50 * Math.cos(a)).toFixed(5), "20", (50 + 50 * Math.sin(a)).toFixed(5)); }
  out.push("0", "ENDSEC", "0", "EOF");
  return Buffer.from(out.join("\n") + "\n");
}

(async () => {
  for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
  process.env.QUOTE_DRAFT_KB_PER_ACCOUNT = "1048576";
  process.env.QUOTE_DRAFT_KB_PER_CLIENT = "1048576";
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  // The real ceilings on unpaid orders: this suite is where they are tested.
  const h = await start({ mailer: "configured", orderCaps: true });
  const { ordersDB, orderItemsDB, materialsDB } = h.models;
  const database = require("../models/database");
  const { limits } = require("../security/limits");
  let owner, buyer, other, discLine, cubeLine;
  const quote = (parts, token) => h.post("/api/quote", { parts, leadTimeSlug: "standard" }, token);
  const pay = (quoteId, token) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP }, token);
  const header = (r, name) => Number(r.headers.get(name));

  test("setup: two customers, a detailed drawing and a cube", async () => {
    owner = await h.admin("Owner");
    buyer = await h.register("list@buyer.test");
    other = await h.register("other@buyer.test");
    const up = await h.form("/api/upload", { process: "routing" }, { files: { name: "disc.dxf", data: fineDisc(6000) } }, buyer);
    assert.strictEqual(up.status, 200, up.text.slice(0, 200));
    const m = materialsDB.getAll().find((x) => x.slug === "rt-hdpe") || materialsDB.getAll().find((x) => x.process === "routing" && x.active);
    discLine = { partId: up.body.parts[0].partId, materialSlug: m.slug, grade: (m.grades && m.grades[0] && m.grades[0].name) || "", finishSlug: "", quantity: 1, process: "routing", thicknessMm: m.thicknesses[3].mm };
    const cube = await h.form("/api/upload", {}, { files: { name: "cube.stl", data: boxStl(20) } }, other);
    cubeLine = h.cncConfig(cube.body.parts[0].partId, 1);
  });

  test("the list is summaries: a line count, no lines, no measurements; the lines are on the order's own page", async () => {
    const q = await quote(Array.from({ length: 40 }, () => ({ ...discLine })), buyer);
    assert.strictEqual(q.status, 200, q.text.slice(0, 200));
    assert.ok(!q.body.gate.requiresRfq, JSON.stringify(q.body.gate).slice(0, 200));
    const c = await pay(q.body.quoteId, buyer);
    assert.strictEqual(c.status, 200, c.text.slice(0, 200));
    const list = await h.get("/api/orders", buyer);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.length, 1);
    assert.strictEqual(list.body[0].itemCount, 40);
    assert.strictEqual(list.body[0].items, undefined);
    assert.ok(list.text.length < 3000, `the list is ${list.text.length} bytes for a 40-line order of a detailed drawing`);
    assert.ok(!/geometry|"dfm"|profile2d|clientTag/.test(list.text), "no measurements, no DFM result, no address tag");
    assert.deepStrictEqual([header(list, "x-total-count"), header(list, "x-page"), header(list, "x-page-count"), header(list, "x-page-size")], [1, 1, 1, 50]);
    const one = await h.get(`/api/orders/${c.body.orderId}`, buyer);
    assert.strictEqual(one.body.items.length, 40);
    assert.ok(one.body.items.every((it) => it.storedName && !it.geometry && !it.dfm));
    assert.ok(one.text.length < 400000, `one order's page is ${one.text.length} bytes`);
    assert.ok(!/clientTag/.test(one.text));
  });

  test("one account may hold three unpaid orders at once; the fourth press of pay is refused in words, and nothing is made", async () => {
    const made = [];
    for (let i = 0; i < 2; i++) {
      const q = await quote([{ ...discLine, quantity: 2 + i }], buyer);
      const c = await pay(q.body.quoteId, buyer);
      assert.strictEqual(c.status, 200, c.text.slice(0, 200));
      made.push({ quoteId: q.body.quoteId, orderId: c.body.orderId });
    }
    assert.strictEqual(limits.ordersUnpaidPerAccount, 3);
    const q4 = await quote([{ ...discLine, quantity: 9 }], buyer);
    const before = ordersDB.getAll().length;
    const sessions = h.stripe.created.length;
    const c4 = await pay(q4.body.quoteId, buyer);
    assert.strictEqual(c4.status, 429, c4.text.slice(0, 200));
    assert.strictEqual(c4.body.code, "unpaid-orders-limit");
    assert.ok(/You have 3 orders waiting for payment/.test(c4.body.error) && /Your orders/.test(c4.body.error) && /2 hours/.test(c4.body.error), c4.body.error);
    assert.ok(Number(c4.headers.get("retry-after")) > 0);
    assert.strictEqual(ordersDB.getAll().length, before, "no order was made");
    assert.strictEqual(h.stripe.created.length, sessions, "and no payment page");
    // Going back to pay for an order that already exists is not a new order.
    const again = await pay(made[0].quoteId, buyer);
    assert.strictEqual(again.status, 200, again.text.slice(0, 200));
    assert.strictEqual(again.body.orderId, made[0].orderId);
    // Paying for one frees a place.
    await h.completed(String(again.body.sessionUrl).split("/").pop());
    const c5 = await pay(q4.body.quoteId, buyer);
    assert.strictEqual(c5.status, 200, c5.text.slice(0, 200));
    // Another account is not affected by this one's orders (it comes from another address).
    const qo = await quote([cubeLine], other);
    assert.strictEqual((await pay(qo.body.quoteId, other)).status, 200);
  });

  test("an order that lapses frees its place, but only so many may be started and left unpaid in a day", async () => {
    await h.sweep(); // every unpaid order lapses
    assert.strictEqual(ordersDB.query((o) => o.status === "pending_payment").length, 0);
    const unpaidToday = () => ordersDB.query((o) => !o.paidAt && o.customerEmail === "list@buyer.test").length;
    let refused = null;
    for (let i = 0; i < 12 && !refused; i++) {
      const q = await quote([{ ...discLine, quantity: 20 + i }], buyer);
      const c = await pay(q.body.quoteId, buyer);
      if (c.status !== 200) refused = c; else await h.sweep();
    }
    assert.ok(refused, "the day's ceiling was reached");
    assert.strictEqual(refused.status, 429);
    assert.strictEqual(refused.body.code, "unpaid-orders-daily-limit");
    assert.ok(/Nothing was charged/.test(refused.body.error) && /try again tomorrow/.test(refused.body.error), refused.body.error);
    assert.strictEqual(unpaidToday(), limits.ordersUnpaidNewPerAccountDay, "exactly the day's allowance of unpaid orders exists");
    // Yesterday's are not counted.
    database.batch(() => { for (const o of ordersDB.query((x) => !x.paidAt)) ordersDB.update(o.id, { createdAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }); });
    const q = await quote([{ ...discLine, quantity: 77 }], buyer);
    assert.strictEqual((await pay(q.body.quoteId, buyer)).status, 200);
  });

  test("a list of thousands of orders is one page at a time: 50 by default, 100 at most, newest first, the count in the headers", async () => {
    const mine = h.models.usersDB.getAll().find((u) => u.email === "list@buyer.test").id;
    const sample = ordersDB.query((o) => o.userId === mine)[0];
    const lines = orderItemsDB.query((i) => i.orderId === sample.id);
    database.batch(() => {
      for (let n = 0; n < 2400; n++) {
        const { id: _id, ...row } = sample;
        const o = ordersDB.insert({ ...row, status: "expired", attention: n % 800 === 0 ? "late-payment" : null, createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60000).toISOString() });
        if (n % 40 === 0) for (const li of lines) { const { id: _li, ...item } = li; orderItemsDB.insert({ ...item, orderId: o.id }); }
      }
    });
    const first = await h.get("/api/orders", buyer);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.length, 50);
    assert.ok(header(first, "x-total-count") > 2400);
    assert.ok(first.text.length < 150000, `a page is ${first.text.length} bytes`);
    const dates = first.body.map((o) => o.createdAt);
    assert.deepStrictEqual(dates, [...dates].sort().reverse(), "newest first");
    const big = await h.get("/api/orders?pageSize=5000&page=2", buyer);
    assert.deepStrictEqual([big.body.length, header(big, "x-page-size"), header(big, "x-page")], [100, 100, 2]);
    assert.ok(!big.body.some((o) => first.body.some((f) => f.id === o.id)), "page 2 holds other orders than page 1");
    const last = await h.get(`/api/orders?page=${header(first, "x-page-count")}`, buyer);
    assert.ok(last.body.length >= 1 && last.body.length <= 50);
    const past = await h.get("/api/orders?page=999999", buyer);
    assert.strictEqual(header(past, "x-page"), header(first, "x-page-count"), "a page past the end is the last page");
    for (const bad of ["page=-3", "page=abc", "pageSize=0", "pageSize=1e9", "page[]=2"]) assert.strictEqual((await h.get(`/api/orders?${bad}`, buyer)).status, 200, bad);
    // The owner's list is everyone's, by the same route, and can be narrowed to what needs him.
    const all = await h.get("/api/orders", owner);
    assert.strictEqual(all.status, 200);
    assert.ok(header(all, "x-total-count") > header(first, "x-total-count"));
    const flagged = await h.get("/api/orders?attention=1", owner);
    assert.strictEqual(header(flagged, "x-total-count"), 3);
    assert.ok(flagged.body.every((o) => o.attention === "late-payment"));
    // A customer cannot use the filter to see anything, and never sees why an order is flagged.
    const notMine = await h.get("/api/orders?attention=1", other);
    assert.ok(notMine.body.every((o) => o.attention === undefined) && header(notMine, "x-total-count") <= 2);
    // The count the admin panel shows is of all orders, not of the page.
    assert.strictEqual((await h.get("/api/orders/admin/payment-settings", owner)).body.needsAttention, 3);
  });

  test("the admin's other lists answer at that volume too, each bounded", async () => {
    for (const url of ["/api/orders/admin/queue", "/api/admin/stats", "/api/admin/parts", "/api/admin/quotes", "/api/rfq/admin/list", "/api/admin/calibration", "/api/orders/admin/payment-settings"]) {
      const t0 = Date.now();
      const r = await h.get(url, owner);
      assert.strictEqual(r.status, 200, `${url}: ${r.status} ${r.text.slice(0, 120)}`);
      assert.ok(r.text.length < 2 * 1024 * 1024, `${url}: ${r.text.length} bytes`);
      assert.ok(Date.now() - t0 < 1500, `${url}: ${Date.now() - t0} ms`);
    }
    const stats = (await h.get("/api/admin/stats", owner)).body;
    assert.strictEqual(stats.totalOrders, 1, "one order was paid for");
    assert.ok(stats.paidRevenue > 0 && stats.totalParts === 2 && stats.openQuotes >= 1);
  });

  await run(() => h.stop());
})();
