/**
 * A drawing's units cannot change under an order or a request (independent re-review 2026-11-12, F-01).
 * Run: node server/routes/unitsLock.test.js
 *
 * The units route asked "is this part on an order?", waited for the file to be read again in a worker,
 * then replaced the stored measurements. A checkout sent a few milliseconds behind the units request
 * made its order from the small (millimetre) part and the route swapped in the large (inch) one under
 * it: paid $140.94 for a part that prices at $519.08. Each case below fails on the code before the fix.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const { rectDxf } = require("../testSupport/shapes");

const { test, run } = runner("Units lock");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

(async () => {
  for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  const h = await start({ mailer: "configured" });
  const { ordersDB, orderItemsDB, partsDB, quotesDB, rfqsDB, materialsDB } = h.models;
  const quoteIntegrity = require("../services/quoteIntegrity");
  const partLock = require("../services/partLock");
  const material = materialsDB.getAll().find((m) => m.slug === "rt-acrylic");
  let buyer;

  /** A 20 x 20 plate drawn in inches, uploaded by the buyer, on a draft quote read as millimetres. */
  async function draftInMm(name) {
    const up = await h.form("/api/upload", {}, { files: { name, data: rectDxf(20, 20, 1) } }, buyer);
    assert.strictEqual(up.status, 200, up.text);
    const partId = up.body.parts[0].partId;
    const cfg = { partId, materialSlug: "rt-acrylic", grade: material.grades[0].name, finishSlug: "", quantity: 2, process: "routing", thicknessMm: 25.4 };
    const setUnits = (units) => h.post(`/api/parts/${partId}/units`, { units, editKey: h.editKeys[partId] }, buyer);
    const price = (extra = {}) => h.post("/api/quote", { parts: [cfg], leadTimeSlug: "standard", ...extra }, buyer);
    const inch = await price();
    assert.strictEqual(inch.status, 200, inch.text);
    const toMm = await setUnits("mm");
    assert.strictEqual(toMm.status, 200, toMm.text);
    const mm = await price({ quoteId: inch.body.quoteId });
    assert.strictEqual(mm.status, 200, mm.text);
    return { partId, cfg, setUnits, price, quoteId: mm.body.quoteId, inchTotal: inch.body.orderTotal, mmTotal: mm.body.orderTotal };
  }
  /** Make every DXF read take `ms` in the worker, so "during the read" is a window a test can aim at. */
  const slowReads = (ms) => { if (ms) { process.env.PARSE_TEST_DELAY_MS = String(ms); process.env.PARSE_TEST_DELAY_EXT = ".dxf"; } else { delete process.env.PARSE_TEST_DELAY_MS; delete process.env.PARSE_TEST_DELAY_EXT; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const width = (partId) => Math.round(partsDB.getById(partId).geometry.boundingBox.width);

  test("setup", async () => {
    await h.admin("Owner");
    buyer = await h.register("units@buyer.test");
  });

  test("a units change on a draft works, counts a new revision, and the draft is priced again", async () => {
    const d = await draftInMm("draft.dxf");
    assert.ok(d.mmTotal < d.inchTotal, `${d.mmTotal} < ${d.inchTotal}`);
    assert.strictEqual(width(d.partId), 20);
    assert.strictEqual(partsDB.getRow(d.partId).geometryRev, 1, "one replacement so far");
    const back = await d.setUnits("in");
    assert.strictEqual(back.status, 200, back.text);
    assert.strictEqual(width(d.partId), 508);
    assert.strictEqual(partsDB.getRow(d.partId).geometryRev, 2);
    assert.strictEqual(partLock.lockedBy(d.partId), null);
    // The draft that holds it is at the inch price again (the server priced it, or marked it to be priced).
    const row = quotesDB.getById(d.quoteId);
    const stale = Boolean(row.config.integrity && row.config.integrity.stale);
    assert.ok(stale || Math.abs(row.orderTotal - d.inchTotal) < 0.011, `draft total ${row.orderTotal}, stale ${stale}`);
  });

  test("units → inches sent, checkout for the millimetre price right behind it: the order is for the part as stored", async () => {
    const d = await draftInMm("race.dxf");
    slowReads(250);
    try {
      const units = d.setUnits("in");
      await sleep(40); // the units request is past its gate and waiting for the worker
      const c = await h.post("/api/orders/checkout-session", { quoteId: d.quoteId, ...SHIP }, buyer);
      const u = await units;
      assert.strictEqual(c.status, 200, c.text);
      assert.strictEqual(u.status, 409, `the units change must be refused once the order exists: ${u.status} ${u.text.slice(0, 120)}`);
      assert.strictEqual(u.body.code, "part-locked");
      assert.ok(/units can no longer be changed/.test(u.body.error), u.body.error);
      const item = orderItemsDB.query((i) => i.orderId === c.body.orderId)[0];
      const part = partsDB.getById(d.partId);
      assert.strictEqual(width(d.partId), 20, "the stored part is still the millimetre part");
      assert.strictEqual(item.config.priced.geometryHash, quoteIntegrity.geometryHash(part.geometry));
      assert.strictEqual(item.config.priced.partRev, part.geometryRev);
      assert.deepStrictEqual(partLock.changedSincePriced(c.body.orderId), []);
      await h.completed(String(c.body.sessionUrl).split("/").pop());
      const paid = ordersDB.getById(c.body.orderId);
      assert.strictEqual(paid.status, "paid");
      assert.ok(!paid.attention, "nothing to flag");
    } finally { slowReads(0); }
  });

  test("the same race the other way round (checkout first): one of the two is refused, never both applied", async () => {
    const d = await draftInMm("race2.dxf");
    slowReads(150);
    try {
      const [c, u] = await Promise.all([h.post("/api/orders/checkout-session", { quoteId: d.quoteId, ...SHIP }, buyer), d.setUnits("in")]);
      assert.ok(c.status === 200 || c.status === 409, c.text);
      if (c.status === 200) {
        assert.strictEqual(u.status, 409, u.text.slice(0, 120));
        assert.strictEqual(width(d.partId), 20);
      } else {
        assert.strictEqual(orderItemsDB.query((i) => i.partId === d.partId).length, 0, "a refused checkout made no order");
      }
    } finally { slowReads(0); }
  });

  test("a firm-quote request sent during the read locks the part the same way", async () => {
    const d = await draftInMm("request.dxf");
    slowReads(250);
    try {
      const units = d.setUnits("in");
      await sleep(40);
      const rq = await h.form("/api/rfq", { contactName: "Pat Buyer", email: "units@buyer.test", quoteId: d.quoteId, notes: "please quote" }, {}, buyer);
      const u = await units;
      assert.strictEqual(rq.status, 201, rq.text);
      assert.strictEqual(u.status, 409, u.text.slice(0, 120));
      assert.strictEqual(u.body.code, "part-locked");
      assert.strictEqual(width(d.partId), 20);
      assert.strictEqual(partLock.lockedBy(d.partId), "request");
      assert.ok(rfqsDB.getById(rq.body.rfqId));
    } finally { slowReads(0); }
  });

  test("locked: on an order (paid, unpaid or lapsed), on a request, on a quote that is no longer a draft", async () => {
    const d = await draftInMm("locked.dxf");
    const c = await h.post("/api/orders/checkout-session", { quoteId: d.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(partLock.lockedBy(d.partId), "order");
    assert.strictEqual((await d.setUnits("in")).status, 409);
    // The order lapses unpaid: the quote is a draft again, the part stays as it was priced.
    await h.sweep();
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "expired");
    assert.strictEqual(quotesDB.getById(d.quoteId).status, "draft");
    assert.strictEqual((await d.setUnits("in")).status, 409, "an expired order still names the part");
    // A quote that has moved on locks its parts even with no order line and no request row to show for it.
    const e = await draftInMm("moved.dxf");
    quotesDB.update(e.quoteId, { status: "ordered" });
    assert.strictEqual(partLock.lockedBy(e.partId), "quote");
    const r = await e.setUnits("in");
    assert.strictEqual(r.status, 409, r.text);
    quotesDB.update(e.quoteId, { status: "draft" });
    assert.strictEqual(partLock.lockedBy(e.partId), null);
    // A file NAMED like a part id on somebody's request locks nothing.
    rfqsDB.insert({ status: "new", contactName: "x", email: "x@x.test", parts: [{ partId: "00000000-0000-4000-8000-000000000000", fileName: `${e.partId}.dxf` }] });
    assert.strictEqual(partLock.lockedBy(e.partId), null);
  });

  test("if a part ever differs from what was priced, the paid order is flagged and the shop is emailed", async () => {
    const d = await draftInMm("flag.dxf");
    const c = await h.post("/api/orders/checkout-session", { quoteId: d.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    // Not reachable through the site any more; done to the stored part directly, as a fault or a hand edit would.
    const part = partsDB.getById(d.partId);
    partsDB.update(d.partId, { geometry: { ...part.geometry, boundingBox: { ...part.geometry.boundingBox, width: 508, height: 508 } } });
    assert.strictEqual(partLock.changedSincePriced(c.body.orderId).length, 1);
    h.sent.length = 0;
    await h.completed(String(c.body.sessionUrl).split("/").pop());
    const paid = ordersDB.getById(c.body.orderId);
    assert.strictEqual(paid.status, "paid", "the payment was right, so the order is paid");
    assert.strictEqual(paid.attention, "part-changed");
    assert.ok(/not the file that was priced/.test(paid.attentionNote), paid.attentionNote);
    const notice = h.sent.filter((m) => m.to === "owner@shop.test" && /part file changed/i.test(m.subject));
    assert.strictEqual(notice.length, 1, h.sent.map((m) => m.subject).join(" | "));
    assert.ok(/Do not cut from it/.test(notice[0].text));
    // The owner's order view carries the flag; the customer's does not say why.
    const owner = await h.adminLogin();
    const seen = (await h.get(`/api/orders/${paid.id}`, owner)).body;
    assert.strictEqual(seen.payment.attentionLabel, "Part file changed after it was priced");
    const mine = (await h.get(`/api/orders/${paid.id}`, buyer)).body;
    assert.strictEqual(mine.attention, undefined);
  });

  await run(() => h.stop());
})();
