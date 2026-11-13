/**
 * The pricing runner never judges or writes from figures the database no longer holds
 * (independent re-review 2026-11-12, F-01 and F-08).
 * Run: node server/services/pricingMemoStale.test.js
 *
 * The runner prices in pieces and serves other requests between them. Checkout now runs through it,
 * so between the pricing and the pass that judges and writes, a part's measurements can be replaced
 * or a catalog row saved. The final pass must then price again, not charge what it worked out
 * before. Here the slice is made tiny so every quote takes several passes, and a part is changed
 * between two of them.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const { rectDxf } = require("../testSupport/shapes");

const { test, run } = runner("Pricing runner: stale figures are priced again");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

(async () => {
  for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  const h = await start({ mailer: "configured" });
  const { ordersDB, partsDB, quotesDB, materialsDB } = h.models;
  const pricingMemo = require("./pricingMemo");
  const material = materialsDB.getAll().find((m) => m.slug === "rt-acrylic");
  let buyer;
  let parts = [];
  const line = (partId) => ({ partId, materialSlug: "rt-acrylic", grade: material.grades[0].name, finishSlug: "", quantity: 2, process: "routing", thicknessMm: 25.4 });

  /** Run `change` once, between two pieces of the runner's work on the request that `send` starts. */
  async function between(send, change) {
    const before = pricingMemo.stats().pieces;
    const request = send();
    let done = false;
    await new Promise((resolve) => {
      const watch = () => {
        const s = pricingMemo.stats();
        if (!done && s.pieces > before && (s.lightActive || s.heavyActive)) { done = true; change(); return resolve(); }
        if (s.finished > 0 && !s.lightActive && !s.heavyActive && s.pieces > before && s.lightWaiting + s.heavyWaiting === 0 && done === false && Date.now() - t0 > 3000) return resolve();
        setImmediate(watch);
      };
      const t0 = Date.now();
      setImmediate(watch);
    });
    return { answer: await request, changed: done };
  }
  const grow = (partId) => { const p = partsDB.getById(partId); partsDB.update(partId, { geometry: { ...p.geometry, boundingBox: { ...p.geometry.boundingBox, width: p.geometry.boundingBox.width * 3, height: p.geometry.boundingBox.height * 3 }, flatWidth: p.geometry.flatWidth * 3, flatHeight: p.geometry.flatHeight * 3, flatArea: p.geometry.flatArea * 9, profile2d: { ...p.geometry.profile2d, area: p.geometry.profile2d.area * 9, bbox: { ...p.geometry.profile2d.bbox, w: p.geometry.profile2d.bbox.w * 3, h: p.geometry.profile2d.bbox.h * 3 } } } }); };

  test("setup: six different plates on one quote, and a slice so small that pricing takes several passes", async () => {
    await h.admin("Owner");
    buyer = await h.register("stale@buyer.test");
    for (let i = 0; i < 6; i++) {
      const up = await h.form("/api/upload", {}, { files: { name: `plate-${i}.dxf`, data: rectDxf(100 + i * 7, 80 + i * 5, 4) } }, buyer);
      assert.strictEqual(up.status, 200, up.text.slice(0, 200));
      parts.push(up.body.parts[0].partId);
    }
    process.env.QUOTE_PRICE_SLICE_MS = "1";
  });

  // ── The runner itself, with a pricing function that changes the database at a chosen moment ──
  const wrapped = pricingMemo.wrapModels(h.models);

  test("runner: a part replaced after the memo loaded it is loaded again before the final pass (which sees the part as stored)", async () => {
    const restarted = pricingMemo.stats().restarted;
    const before = partsDB.getRow(parts[0]).geometryRev || 0;
    let passes = 0;
    const out = await pricingMemo.run(() => {
      passes++;
      const part = wrapped.partsDB.getById(parts[0]);
      if (pricingMemo.warming()) { if (passes === 1) grow(parts[0]); return null; } // replaced while the quote is "being priced"
      return { rev: part.geometryRev, width: part.geometry.boundingBox.width };
    }, {});
    const now = partsDB.getById(parts[0]);
    assert.strictEqual(pricingMemo.stats().restarted, restarted + 1, "priced again from the start, once");
    assert.strictEqual(now.geometryRev, before + 1);
    assert.deepStrictEqual(out, { rev: now.geometryRev, width: now.geometry.boundingBox.width }, "the final pass worked from the part as it is stored");
  });

  test("runner: a catalog row saved, a part deleted: each is seen before the final pass; an unrelated write restarts nothing", async () => {
    const m = materialsDB.getAll().find((x) => x.slug === "rt-acrylic");
    // A catalog table written after it was read.
    let restarted = pricingMemo.stats().restarted;
    let passes = 0;
    const price = await pricingMemo.run(() => {
      passes++;
      const row = wrapped.materialsDB.getAll().find((x) => x.slug === "rt-acrylic");
      if (pricingMemo.warming()) { if (passes === 1) materialsDB.update(m.id, { pricePerKg: 77.5 }); return null; }
      return row.pricePerKg;
    }, {});
    assert.strictEqual(price, 77.5, "the final pass read the price as saved");
    assert.strictEqual(pricingMemo.stats().restarted, restarted + 1);
    materialsDB.update(m.id, { pricePerKg: m.pricePerKg });
    // A part that is deleted after it was loaded.
    const up = await h.form("/api/upload", {}, { files: { name: "gone.dxf", data: rectDxf(50, 50, 4) } }, buyer);
    const goneId = up.body.parts[0].partId;
    restarted = pricingMemo.stats().restarted;
    passes = 0;
    const found = await pricingMemo.run(() => {
      passes++;
      const part = wrapped.partsDB.getById(goneId);
      if (pricingMemo.warming()) { if (passes === 1) partsDB.delete(goneId); return null; }
      return part;
    }, {});
    assert.strictEqual(found, null, "the final pass found no such part");
    assert.strictEqual(pricingMemo.stats().restarted, restarted + 1);
    // Nothing changed: no restart.
    restarted = pricingMemo.stats().restarted;
    passes = 0;
    await pricingMemo.run(() => { passes++; wrapped.partsDB.getById(parts[1]); wrapped.materialsDB.getAll(); return pricingMemo.warming() ? null : true; }, {});
    assert.strictEqual(pricingMemo.stats().restarted, restarted);
    assert.ok(passes >= 2, "at least one warm-up pass and the final one");
    // An unrelated upload (the parts table is written, this quote's parts are not) does not restart anything.
    passes = 0;
    await pricingMemo.run(() => { passes++; wrapped.partsDB.getById(parts[1]); if (pricingMemo.warming()) { if (passes === 1) partsDB.setOwner(parts[2], partsDB.getRow(parts[2]).userId); return null; } return true; }, {});
    assert.strictEqual(pricingMemo.stats().restarted, restarted);
  });

  test("runner: a quote that keeps being overtaken is told to try again, never judged on stale figures", async () => {
    const m = materialsDB.getAll().find((x) => x.slug === "rt-acrylic");
    let n = 0;
    let finalRan = false;
    const outcome = await pricingMemo.run(() => {
      wrapped.materialsDB.getAll();
      if (pricingMemo.warming()) { materialsDB.update(m.id, { color: `c${n++}` }); return null; } // overtaken on every pass
      finalRan = true;
      return "judged";
    }, {}).then((v) => ({ value: v }), (err) => ({ err }));
    assert.strictEqual(finalRan, false, "the final pass never ran");
    assert.ok(outcome.err && outcome.err.expose === true, String(outcome.value));
    assert.deepStrictEqual([outcome.err.status, outcome.err.extra.code], [503, "pricing-busy"]);
    assert.ok(outcome.err.retryAfterSeconds > 0);
    assert.strictEqual(n, 4, "priced from the start four times, then stopped");
  });

  // ── Through the site: a part changed while a request is in the runner ──

  test("a part replaced while its quote is being priced: the quote that is saved is for the part as stored", async () => {
    const r = await between(() => h.post("/api/quote", { parts: parts.map(line), leadTimeSlug: "standard" }, buyer), () => grow(parts[2]));
    assert.ok(r.changed, "the part was changed between two pieces of the pricing");
    assert.strictEqual(r.answer.status, 200, r.answer.text.slice(0, 200));
    const row = quotesDB.getById(r.answer.body.quoteId);
    const snap = row.config.integrity.lines[2].snapshot;
    const now = partsDB.getById(parts[2]);
    assert.strictEqual(snap.partRev, now.geometryRev, "priced at the revision the part is at now");
    assert.strictEqual(Math.round(snap.dimsMm.x), Math.round(now.geometry.boundingBox.width), "and at its size now");
  });

  test("a part replaced while CHECKOUT is pricing: the buyer is not charged the old price; they are shown the new one", async () => {
    const q = await h.post("/api/quote", { parts: parts.map(line), leadTimeSlug: "standard" }, buyer);
    assert.strictEqual(q.status, 200, q.text.slice(0, 200));
    const orders = ordersDB.getAll().length;
    const r = await between(() => h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP, confirmedTotal: q.body.orderTotal }, buyer), () => grow(parts[3]));
    assert.ok(r.changed);
    assert.strictEqual(r.answer.status, 409, r.answer.text.slice(0, 200));
    assert.strictEqual(r.answer.body.code, "quote-changed");
    assert.ok(r.answer.body.newTotal > q.body.orderTotal, `${r.answer.body.newTotal} > ${q.body.orderTotal}`);
    assert.strictEqual(ordersDB.getAll().length, orders, "no order was made at the old price");
    // Confirming the new total makes the order, at the new price, for the part as stored.
    const again = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP, confirmedTotal: r.answer.body.quote.checkout.options[0].total }, buyer);
    assert.strictEqual(again.status, 200, again.text.slice(0, 200));
    const order = ordersDB.getById(again.body.orderId);
    assert.ok(order.subtotal > q.body.subtotal);
    assert.deepStrictEqual(require("./partLock").changedSincePriced(order.id), []);
    delete process.env.QUOTE_PRICE_SLICE_MS;
  });

  await run(() => h.stop());
})();
