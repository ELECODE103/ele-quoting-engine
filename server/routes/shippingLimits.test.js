/**
 * The default shipping rule does not sell freight at a parcel price (re-review 2026-11-12, F-03).
 * Run: node server/routes/shippingLimits.test.js
 *
 * Everything here is at the DEFAULT settings (shipping by the weight formula, $12.00 + $2.50 a kg,
 * no pickup, no carrier account). Before: a 58 x 94 in sheet was priced online with $25 to $32 of
 * shipping and checked out to Honolulu and to Hamburg at that figure; the country was free text.
 * Each case below fails on that code, except the ones that say a price did NOT change.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const { rectDxf } = require("../testSupport/shapes");

const { test, run } = runner("Shipping limits under the default (weight formula) rule");
const IN = 25.4;
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

(async () => {
  for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  const h = await start({ mailer: "configured" });
  const { materialsDB, ordersDB, pricingDB } = h.models;
  const acrylic = materialsDB.getAll().find((m) => m.slug === "rt-acrylic");
  const thin = acrylic.thicknesses.map((t) => t.mm).sort((a, b) => a - b)[0];
  const thick = acrylic.thicknesses.map((t) => t.mm).sort((a, b) => b - a)[0];
  let buyer;

  /** A sheet w x h inches, routed in acrylic at `mm`, priced as a new quote. */
  async function sheet(wIn, hIn, mm, quantity = 1) {
    const up = await h.form("/api/upload", { process: "routing" }, { files: { name: `sheet-${wIn}x${hIn}.dxf`, data: rectDxf(wIn * IN, hIn * IN) } }, buyer);
    assert.strictEqual(up.status, 200, up.text.slice(0, 200));
    const q = await h.post("/api/quote", { parts: [{ partId: up.body.parts[0].partId, materialSlug: "rt-acrylic", grade: acrylic.grades[0].name, finishSlug: "", quantity, process: "routing", thicknessMm: mm }], leadTimeSlug: "standard" }, buyer);
    assert.strictEqual(q.status, 200, q.text.slice(0, 300));
    return q.body;
  }
  const checkout = (quoteId, over = {}, total) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...over, ...(total === undefined ? {} : { confirmedTotal: total }) }, buyer);

  test("setup: the settings are the defaults", async () => {
    await h.admin("Owner");
    buyer = await h.register("ship@buyer.test");
    const rules = pricingDB.getAll()[0].rules;
    assert.deepStrictEqual([rules.shippingMethod, rules.shippingBaseRate, rules.shippingPerKg, rules.shippingOversizeLongestIn, rules.shippingMaxParcelLb], ["formula", 12, 2.5, 48, 50]);
  });

  let small;
  test("an order inside the limits is priced and charged exactly as before: $12.00 plus $2.50 a kg, to the cent", async () => {
    small = await sheet(24, 36, thin, 2);
    assert.strictEqual(small.gate.requiresRfq, false, JSON.stringify(small.gate.reasons));
    const kg = small.lineItems.reduce((n, li) => n + li.weight.total, 0);
    assert.strictEqual(small.shippingEstimate, 12 + kg * 2.5, `${kg} kg: the expression the formula has always used, unrounded`);
    assert.strictEqual(small.checkout.shipping.manual, false);
    const c = await checkout(small.quoteId, {}, small.orderTotal);
    assert.strictEqual(c.status, 200, c.text.slice(0, 200));
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.shippingCost, Math.round(small.shippingEstimate * 100) / 100, "charged in whole cents");
    assert.strictEqual(order.shippingCountry, "US");
  });

  test("a sheet 58 x 94 in is not given a shipping price: the quote goes to a firm quote, with the reason in words, and it cannot be checked out", async () => {
    const big = await sheet(58, 94, thin);
    assert.strictEqual(big.gate.requiresRfq, true);
    const reason = big.gate.reasons.find((r) => r.code === "shipping-freight");
    assert.ok(reason && /94 in on its longest side, over the 48 in we ship by parcel, so we confirm freight before you order/.test(reason.message), JSON.stringify(big.gate.reasons));
    assert.deepStrictEqual([big.checkout.shipping.manual, big.checkout.shipping.valueText], [true, "To be confirmed"]);
    assert.strictEqual(big.shippingEstimate, 0, "no shipping amount is in the total");
    assert.ok(big.lineItems[0].lineTotal > 100, "the part itself is priced as it was");
    const c = await checkout(big.quoteId);
    assert.ok([403, 409].includes(c.status) && ["rfq-required", "shipping-manual"].includes(c.body.code), c.text.slice(0, 200));
    assert.strictEqual(ordersDB.query((o) => o.quoteId === big.quoteId).length, 0);
    // Looked at again later (nothing is priced, no part is read): the same answer.
    const seen = await h.get(`/api/quote/${big.quoteId}`, buyer);
    assert.strictEqual(seen.body.checkout.shipping.manual, true);
  });

  test("a long, light strip (6 x 94 in) and a heavy plate (48 x 48 in at the thickest stock) go the same way", async () => {
    const strip = await sheet(6, 94, thin);
    assert.ok(strip.gate.requiresRfq && strip.gate.reasons.some((r) => r.code === "shipping-freight" && /longest side/.test(r.message)), JSON.stringify(strip.gate.reasons));
    const plate = await sheet(48, 48, thick);
    assert.ok(plate.gate.requiresRfq && plate.gate.reasons.some((r) => r.code === "shipping-freight" && /lb, over the 50 lb we ship by parcel/.test(r.message)), JSON.stringify(plate.gate.reasons));
  });

  test("exactly 48 in on the longest side and under 50 lb packed is still an instant order", async () => {
    const edge = await sheet(48, 48, thin);
    assert.strictEqual(edge.gate.requiresRfq, false, JSON.stringify(edge.gate.reasons));
    assert.ok(edge.shippingEstimate > 12);
  });

  test("Alaska, Hawaii, a territory, Canada, Mexico, Germany: no shipping price online, in words, and nothing is ordered; Illinois goes through at the same figure", async () => {
    for (const dest of [{ shippingState: "HI" }, { shippingState: "AK" }, { shippingState: "PR" }, { shippingState: "ON", shippingCountry: "CA" }, { shippingState: "", shippingCountry: "MX" }, { shippingState: "HH", shippingCountry: "DE" }]) {
      const q = await sheet(10, 12, thin);
      const c = await checkout(q.quoteId, dest, q.orderTotal);
      assert.deepStrictEqual([c.status, c.body.code], [409, "shipping-manual"], `${JSON.stringify(dest)}: ${c.text.slice(0, 200)}`);
      assert.ok(/contiguous United States/.test(c.body.error) && /firm quote/i.test(c.body.error), c.body.error);
      assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 0);
      // The same quote to an address in the contiguous states: accepted, at the total the quote showed.
      const ok = await checkout(q.quoteId, {}, q.orderTotal);
      assert.strictEqual(ok.status, 200, ok.text.slice(0, 200));
      assert.strictEqual(ordersDB.getById(ok.body.orderId).total, q.orderTotal);
    }
  });

  test("the country is one of a list: free text is refused in words and never stored", async () => {
    const q = await sheet(10, 12, thin);
    for (const typed of ["Germany", "U", "<b>x", "US;--"]) {
      const c = await checkout(q.quoteId, { shippingCountry: typed }, q.orderTotal);
      assert.deepStrictEqual([c.status, c.body.code], [400, "ship-country"], `${typed}: ${c.text.slice(0, 200)}`);
      assert.ok(/Choose the country from the list/.test(c.body.error));
    }
    const usa = await checkout(q.quoteId, { shippingCountry: " usa " }, q.orderTotal);
    assert.strictEqual(usa.status, 200, usa.text.slice(0, 200));
    assert.strictEqual(ordersDB.getById(usa.body.orderId).shippingCountry, "US");
  });

  // ── Review of 2026-11-13, N-03: the ZIP code decides as well as the state ──────────────────────
  test("a ZIP code outside the contiguous states under a mainland state is not sold at the parcel price (the review sold 6 of 6)", async () => {
    const tricks = [
      ["Honolulu 96813 under CA", { shippingState: "CA", shippingCity: "Honolulu", shippingZip: "96813" }, 409, "shipping-manual"],
      ["Anchorage 99501 under WA", { shippingState: "WA", shippingCity: "Anchorage", shippingZip: "99501" }, 409, "shipping-manual"],
      ["San Juan 00901 under FL", { shippingState: "FL", shippingCity: "San Juan", shippingZip: "00901" }, 409, "shipping-manual"],
      ["military 09012 under NY", { shippingState: "NY", shippingCity: "APO", shippingZip: "09012" }, 409, "shipping-manual"],
      ["Guam 96910 under CA", { shippingState: "CA", shippingCity: "Hagatna", shippingZip: "96910" }, 409, "shipping-manual"],
      ["Hamburg typed into the city, state DE, postcode 20095", { shippingState: "DE", shippingCity: "Hamburg, Germany", shippingAddress: "Jungfernstieg 1, 20095 Hamburg, GERMANY", shippingZip: "20095" }, 400, "address-mismatch"],
    ];
    for (const [label, where, status, code] of tricks) {
      const q = await sheet(10, 12, thin);
      const c = await checkout(q.quoteId, where, q.orderTotal);
      assert.deepStrictEqual([c.status, c.body.code], [status, code], `${label}: ${c.text.slice(0, 200)}`);
      if (code === "shipping-manual") assert.ok(/contiguous United States/.test(c.body.error) && /firm quote/.test(c.body.error), c.body.error);
      else assert.ok(/don't match/.test(c.body.error) && /Check the address/.test(c.body.error), c.body.error);
      assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 0, `${label}: no order`);
    }
  });

  test("a state that is not the ZIP code's state is refused in words, and the same quote is then bought with the address put right", async () => {
    const q = await sheet(10, 12, thin);
    const wrong = await checkout(q.quoteId, { shippingState: "IL", shippingCity: "Columbus", shippingZip: "43215" }, q.orderTotal);
    assert.deepStrictEqual([wrong.status, wrong.body.code], [400, "address-mismatch"]);
    assert.strictEqual(wrong.body.error, "The state and the ZIP code don't match: ZIP code 43215 is in Ohio, and the state chosen is Illinois. Check the address and try again.");
    for (const [over, code] of [[{ shippingZip: "" }, "ship-zip"], [{ shippingZip: "6270" }, "ship-zip"], [{ shippingZip: "00000" }, "ship-zip"], [{ shippingState: "" }, "ship-state"], [{ shippingState: "Narnia" }, "ship-state"]]) {
      const c = await checkout(q.quoteId, over, q.orderTotal);
      assert.deepStrictEqual([c.status, c.body.code], [400, code], JSON.stringify(over));
    }
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 0);
    const right = await checkout(q.quoteId, { shippingState: "OH", shippingCity: "Columbus", shippingZip: "43215" }, q.orderTotal);
    assert.strictEqual(right.status, 200, right.text.slice(0, 200));
    assert.strictEqual(ordersDB.getById(right.body.orderId).total, q.orderTotal, "at the quoted total: nothing about the price changed");
  });

  test("a mainland buyer who writes the state another way is not sent to a firm quote: D.C., Washington DC, Ill., N.Y. (the review: 4 of 4 refused)", async () => {
    const ways = [["D.C.", "Washington", "20001", "DC"], ["Washington DC", "Washington", "20001", "DC"], ["Ill.", "Chicago", "60601", "IL"], ["N.Y.", "Albany", "12207", "NY"], [" new york ", "Albany", "12207-0001", "NY"], ["illinois", "Springfield", "62701", "IL"]];
    for (const [state, city, zip, code] of ways) {
      const q = await sheet(10, 12, thin);
      const c = await checkout(q.quoteId, { shippingState: state, shippingCity: city, shippingZip: zip }, q.orderTotal);
      assert.strictEqual(c.status, 200, `${state}: ${c.text.slice(0, 200)}`);
      const order = ordersDB.getById(c.body.orderId);
      assert.deepStrictEqual([order.shippingState, order.total, order.shippingCost > 12], [code, q.orderTotal, true], "stored as the two-letter code, at the quoted total, with the formula's shipping");
    }
  });

  test("an unpaid order to Ohio cannot be re-addressed to a Hawaii ZIP code under a mainland state", async () => {
    const q = await sheet(10, 12, thin);
    const first = await checkout(q.quoteId, { shippingState: "OH", shippingCity: "Columbus", shippingZip: "43215" }, q.orderTotal);
    assert.strictEqual(first.status, 200, first.text.slice(0, 200));
    const again = await checkout(q.quoteId, { shippingState: "CA", shippingCity: "Honolulu", shippingZip: "96813" }, q.orderTotal);
    assert.deepStrictEqual([again.status, again.body.code], [409, "shipping-manual"]);
    const order = ordersDB.getById(first.body.orderId);
    assert.deepStrictEqual([order.shippingState, order.shippingZip, order.status], ["OH", "43215", "pending_payment"]);
  });

  test("the owner's phone order: a state and ZIP code that disagree are caught when the order is entered", async () => {
    const owner = await h.adminLogin();
    const q = await sheet(10, 12, thin);
    const slip = await h.post("/api/orders", { quoteId: q.quoteId, ...SHIP, shippingState: "IN" }, owner);
    assert.deepStrictEqual([slip.status, slip.body.code], [400, "address-mismatch"], slip.text.slice(0, 200));
    const ok = await h.post("/api/orders", { quoteId: q.quoteId, ...SHIP, shippingState: "Ill." }, owner);
    assert.strictEqual(ok.status, 201, ok.text.slice(0, 200));
    assert.strictEqual(ordersDB.getById(ok.body.orderId).shippingState, "IL");
  });

  await run(h.stop);
})().catch((err) => { console.error(err); process.exit(1); });
