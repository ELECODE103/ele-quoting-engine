/**
 * Reorder (POST /api/orders/:id/reorder) on the merged tree — re-review 2026-11-12, RR-14 and RR-05.
 *
 *   RR-14a  Reorder was accepted for an order that was never paid for: an abandoned checkout was a
 *           ticket to the re-pricing route. Now it is for an order that was really placed — paid at
 *           some point, or accepted on a PO and taken into work (services/orderState.js wasPlaced) —
 *           and the order page only offers the button then (`canReorder`).
 *   RR-14b  Two lines of the same part in different stock (two thicknesses) must come back as two
 *           lines, each with its own thickness and quantity. That holds on this tree; this keeps it.
 *   RR-05   A reorder priced every line on the main thread, with no memo, no budget and no wait per
 *           client: one reorder of a dense part held the site for seconds. Since the second
 *           integration pass (availability-fixes merged) the route is behind the same door as
 *           POST /api/quote (security/pricingGate.js) and prices through the site's one runner
 *           (services/pricingMemo.js). The last cases hold that: the work is done in pieces and
 *           charged to the sender; a refusal about load or allowances is passed on as it is and is
 *           neither retried nor turned into "this order can't be re-quoted".
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
  // …and more new quotes in an hour than one account or one address is allowed (60 and 30: security/quoteGuards.js).
  // Those limits have their own suites; one case below sets the account's to 1 to see a reorder meet it.
  process.env.QUOTE_NEW_PER_ACCOUNT_HOUR = "100000";
  process.env.QUOTE_NEW_PER_ACCOUNT_DAY = "100000";
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

  // ─── RR-05: the reorder route behind the pricing gate and the runner ───
  const { monitorEventLoopDelay } = require("perf_hooks");
  const memo = require("../services/pricingMemo");
  const gate = require("../security/pricingGate");
  const buyerId = () => h.models.usersDB.getAll().find((u) => u.email === "pat@buyer.test").id;
  /** A plate with n holes: a real routed part whose measured detail is large (the re-review's dense drawing). */
  function perforatedDxf(n, pitch = 6) {
    const side = Math.ceil(Math.sqrt(n));
    const w = side * pitch + 10;
    let e = `0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n-5\n20\n-5\n10\n${w - 5}\n20\n-5\n10\n${w - 5}\n20\n${w - 5}\n10\n-5\n20\n${w - 5}\n`;
    for (let i = 0; i < n; i++) e += `0\nCIRCLE\n8\n0\n10\n${(i % side) * pitch}\n20\n${Math.floor(i / side) * pitch}\n40\n1.6\n`;
    return Buffer.from(`0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${e}0\nENDSEC\n0\nEOF\n`);
  }
  /**
   * A paid order of `lines` lines of one dense drawing, every line a different thing to price. Written straight
   * into the tables: an order like this is what a customer builds up over several orders or a phone order, and
   * the quote gate would send a new quote of this size to a person before it could be paid for online.
   */
  let dense;
  async function denseOrder(lines, over = {}) {
    if (!dense) {
      const r = await h.form("/api/upload", { process: "routing" }, { files: { name: "perforated.dxf", data: perforatedDxf(1600) } }, buyer);
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      dense = r.body.parts[0].partId;
      assert.ok(Number(h.models.partsDB.getRow(dense).detailBytes) > 256 * 1024, "the drawing's measured detail is in a file: a heavy quote");
    }
    const hdpe = materialsDB.getAll().find((m) => m.slug === "rt-hdpe");
    const mm = hdpe.thicknesses.map((t) => t.mm);
    const o = ordersDB.insert({ userId: buyerId(), status: "paid", paidAt: new Date().toISOString(), total: 100, subtotal: 100, leadTimeSlug: "standard", paymentMethod: "card", customerEmail: "pat@buyer.test", ...SHIP, ...over });
    for (let i = 0; i < lines; i++) {
      const input = { partId: dense, materialSlug: "rt-hdpe", process: "routing", thicknessMm: mm[i % mm.length], quantity: i + 1 };
      orderItemsDB.insert({ orderId: o.id, partId: dense, fileName: "perforated.dxf", process: "routing", materialSlug: "rt-hdpe", finishSlug: "", quantity: i + 1, unitPrice: 1, lineTotal: 1, config: { thicknessMm: input.thicknessMm, input } });
    }
    return o.id;
  }
  async function counting(obj, method, fn) {
    const real = obj[method];
    let n = 0;
    obj[method] = function counted(...args) { n++; return real.apply(this, args); };
    try { await fn(); } finally { obj[method] = real; }
    return n;
  }

  test("RR-05: a reorder is priced by the site's one runner: in pieces, each part loaded once, the time charged to the account and the address", async () => {
    const id = await denseOrder(60);
    memo.resetForTests();
    const ip = "203.0.113.180";
    const loop = monitorEventLoopDelay({ resolution: 5 });
    let others = 0;
    let going = true;
    const poke = (async () => { while (going) { const r = await h.raw("GET", "/api/public/config"); if (r.status === 200) others++; } })();
    let r;
    let took = 0;
    const loads = await counting(h.models.partsDB, "getById", async () => {
      loop.enable();
      const t0 = Date.now();
      r = await h.raw("POST", `/api/orders/${id}/reorder`, { json: {}, token: buyer, ip });
      took = Date.now() - t0;
      loop.disable();
    });
    going = false;
    await poke;
    assert.strictEqual(r.status, 201, r.text.slice(0, 300));
    assert.deepStrictEqual([r.body.parts, r.body.skipped], [60, 0]);
    assert.strictEqual(quotesDB.getById(r.body.quoteId).lineItems.length, 60, "every line was priced and saved");
    const stats = memo.stats();
    assert.deepStrictEqual([stats.started, stats.finished], [1, 1], "one pricing job, through the runner");
    assert.ok(stats.pieces >= 2, `the work was done in pieces (${stats.pieces})`);
    assert.strictEqual(loads, 1, "the part's measurement file was read once for the whole reorder (it was once per line, twice over)");
    const worst = loop.max / 1e6;
    assert.ok(worst < Math.max(250, took / 3), `the event loop was held ${worst.toFixed(0)} ms at most during a ${took} ms reorder`);
    assert.ok(others >= 1, `${others} other requests were answered meanwhile`);
    assert.ok(memo.usedMs(`user:${buyerId()}`) > 0 && memo.usedMs(ip) > 0, "the pricing time is charged to the account and to the address");
    assert.strictEqual(gate.stats().inFlight, 0, "and the client's place at the door was given back");
    console.log(`       (60 lines of a 1,600-hole drawing: ${took} ms, ${stats.pieces} pieces, longest ${stats.longestPieceMs} ms, event loop held ${worst.toFixed(0)} ms at most, ${others} other requests answered)`);
  });

  test("RR-05: a sender who has used the hour's pricing time is told when to come back: 429 pricing-budget, not reorder-failed, and nothing is priced", async () => {
    const id = await denseOrder(3);
    memo.resetForTests();
    memo.usage.add(`user:${buyerId()}`, 121 * 1000); // past the default 120 s
    const before = quotes();
    const r = await reorder(id);
    assert.deepStrictEqual([r.status, r.body.code, r.body.offerRfq], [429, "pricing-budget", true], r.text.slice(0, 200));
    assert.ok(Number(r.headers.get("retry-after")) >= 1, "Retry-After says when");
    assert.strictEqual(memo.stats().started, 0, "no pricing was started");
    assert.strictEqual(quotes(), before, "no quote was made");
    memo.resetForTests();
    assert.strictEqual((await reorder(id)).status, 201, "the same reorder goes through once the allowance is there again");
  });

  test("RR-05: a reorder that takes longer to price than the instant quote allows is answered quote-too-slow, once: it is not tried again with another lead time", async () => {
    const id = await denseOrder(40);
    memo.resetForTests();
    const before = quotes();
    process.env.QUOTE_PRICE_BUDGET_MS = "3";
    process.env.QUOTE_PRICE_SLICE_MS = "1";
    let r;
    try { r = await reorder(id); } finally { delete process.env.QUOTE_PRICE_BUDGET_MS; delete process.env.QUOTE_PRICE_SLICE_MS; }
    assert.deepStrictEqual([r.status, r.body.code, r.body.offerRfq], [422, "quote-too-slow", true], r.text.slice(0, 200));
    assert.ok(/firm quote/i.test(r.body.error), r.body.error);
    assert.deepStrictEqual([memo.stats().started, memo.stats().refusedSlow], [1, 1], "priced once, refused once: no second try");
    assert.strictEqual(quotes(), before, "no quote was made");
  });

  test("RR-05: the limits on new quotes apply to a reorder and are passed on as they are (429 quote-limit), not as 'this order can't be re-quoted'", async () => {
    const id = await denseOrder(2);
    memo.resetForTests();
    const before = quotes();
    process.env.QUOTE_NEW_PER_ACCOUNT_HOUR = "1"; // this account has made more than one new quote in the last hour
    let r;
    try { r = await reorder(id); } finally { process.env.QUOTE_NEW_PER_ACCOUNT_HOUR = "100000"; }
    assert.deepStrictEqual([r.status, r.body.code], [429, "quote-limit"], r.text.slice(0, 200));
    assert.strictEqual(quotes(), before, "no quote was made");
  });

  test("RR-05: one reorder at a time per client: four at once from one address are served in turn or told to wait, never priced side by side", async () => {
    const id = await denseOrder(30);
    memo.resetForTests();
    const ip = "203.0.113.181";
    const from = () => h.raw("POST", `/api/orders/${id}/reorder`, { json: {}, token: buyer, ip });
    process.env.QUOTE_PRICE_WAIT_MS = "0";
    let four;
    try { four = await Promise.all([from(), from(), from(), from()]); } finally { delete process.env.QUOTE_PRICE_WAIT_MS; }
    const statuses = four.map((r) => r.status).sort();
    assert.ok(statuses.includes(201) && statuses.includes(429), `four at once: ${statuses.join(" ")}`);
    const waiting = four.find((r) => r.status === 429);
    assert.strictEqual(waiting.body.code, "pricing-in-progress");
    assert.ok(waiting.headers.get("retry-after"));
    assert.strictEqual(gate.stats().inFlight, 0, "every place was given back");
  });

  test("a retired lead time still does not block a reorder (it is priced on Standard); the order is checked before anything is priced", async () => {
    memo.resetForTests();
    const retired = await denseOrder(2, { leadTimeSlug: "no-longer-offered" });
    const r = await reorder(retired);
    assert.strictEqual(r.status, 201, r.text.slice(0, 200));
    assert.strictEqual(quotesDB.getById(r.body.quoteId).leadTimeSlug, "standard");
    // An order that was never placed is refused before the runner sees it.
    const unpaid = await pending([h.cncConfig(cube, 9)]);
    memo.resetForTests(); // (making that order priced a quote; the count starts here)
    assert.strictEqual((await reorder(unpaid)).body.code, "reorder-not-available");
    assert.strictEqual(memo.stats().started, 0, "nothing was priced for it");
    const src = fs.readFileSync(path.join(__dirname, "orders.js"), "utf8");
    const route = src.slice(src.indexOf('router.post("/:id/reorder"'), src.indexOf("GET /api/orders/:id/drawing"));
    assert.ok(/router\.post\("\/:id\/reorder", authenticate, pricingGate\.admit\(\), async/.test(route), "the route is behind the pricing gate");
    assert.ok(route.indexOf("orderState.wasPlaced(order)") < route.indexOf("pricingMemo.run("), "and the order is checked before the runner is asked");
    assert.ok(!/NOTE FOR THE availability-fixes MERGE/.test(src), "the note for the merge is gone: the merge is done");
    assert.strictEqual((route.match(/[^.\w]saveQuote\(/g) || []).length, 1, "saveQuote is called in one place, inside the runner");
  });

  await run(h.stop);
})().catch((err) => { console.error(err); process.exit(1); });
