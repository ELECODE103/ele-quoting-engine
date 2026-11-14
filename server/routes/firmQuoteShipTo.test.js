/**
 * A firm quote knows where it is going (review of 2026-11-13, N-05).
 * Run: node server/routes/firmQuoteShipTo.test.js
 *
 * Before: the firm-quote request carried no ship-to address, the owner priced blind, and the
 * buyer could accept to any address in the world at the quoted total ($480 accepted to Honolulu,
 * Hamburg and Anchorage, 3 of 3). Each case below fails on that code, except the ones that say
 * something still holds.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("A firm quote knows where it is going");
const COLUMBUS = { shippingName: "Pat Purchasing", shippingAddress: "1 Test St", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" };
const HONOLULU = { shippingName: "Pat Purchasing", shippingAddress: "1 Ala Moana Blvd", shippingCity: "Honolulu", shippingState: "HI", shippingZip: "96813" };
const linkIn = (m) => (m.text.match(/https:\/\/shop\.test\/firm-quote\/(\S+)/) || [])[1];

(async () => {
  const h = await start({ mailer: "configured" });
  const { rfqsDB, ordersDB } = h.models;
  const rfqToken = require("../services/rfqToken");
  let owner;
  let seq = 0;

  const request = (fields, token) => h.form("/api/rfq", { contactName: "Pat Purchasing", email: `pat${++seq}@oem.test`, company: "OEM Co", quantities: "250", notes: "guide rails", ...fields }, {}, token);
  /** The owner prices the request and sends it; returns the link the buyer is emailed. */
  async function send(rfqId, total = 480) {
    h.sent.length = 0;
    const r = await h.put(`/api/rfq/admin/${rfqId}`, { status: "quoted", quotedTotal: total, quotedLeadDays: 7 }, owner);
    assert.strictEqual(r.status, 200, r.text);
    const mail = h.sent.find((m) => /firm quote/i.test(m.subject));
    return { token: linkIn(mail), mail, res: r.body };
  }
  const accept = (token, body) => h.raw("POST", `/api/rfq/quote/${token}/accept`, { json: body });
  const orderOf = (rfqId) => { const id = rfqsDB.getById(rfqId).orderId; return id ? ordersDB.getById(id) : null; };
  const settings = async (over) => { const r = await h.put("/api/admin/pricing", { rules: over, note: "test" }, owner); assert.strictEqual(r.status, 200, r.text); };

  test("setup", async () => { owner = await h.admin("Owner"); });

  // ── The request ────────────────────────────────────────────────────────────────────────────────
  test("the request carries the ship-to address: stored with it, in the owner's email, and beside the price box in the admin queue", async () => {
    h.sent.length = 0;
    const r = await request(COLUMBUS);
    assert.strictEqual(r.status, 201, r.text);
    const row = rfqsDB.getById(r.body.rfqId);
    assert.deepStrictEqual([row.shipToKind, row.shippingName, row.shippingAddress, row.shippingCity, row.shippingState, row.shippingZip, row.shippingCountry], ["address", "Pat Purchasing", "1 Test St", "Columbus", "OH", "43215", "US"]);
    const shop = h.sent.find((m) => m.to === "owner@shop.test");
    assert.ok(shop.text.includes("Ship finished parts to: Pat Purchasing, 1 Test St, Columbus, OH 43215"), shop.text);
    const listed = (await h.get("/api/rfq/admin/list", owner)).body.find((x) => x.id === r.body.rfqId);
    assert.deepStrictEqual([listed.shipToKind, listed.shipToLine, listed.shipToZone], ["address", "Pat Purchasing, 1 Test St, Columbus, OH 43215", "contiguous"]);
  });

  test("the same validation as checkout: the state against the ZIP code, the ways a state is written, one line per field, a whole address", async () => {
    const mismatch = await request({ ...COLUMBUS, shippingState: "IN" });
    assert.deepStrictEqual([mismatch.status, mismatch.body.code, mismatch.body.field], [400, "address-mismatch", "shippingZip"]);
    assert.ok(/ZIP code 43215 is in Ohio/.test(mismatch.body.error) && /Check the address/.test(mismatch.body.error));
    assert.deepStrictEqual([(await request({ ...COLUMBUS, shippingZip: "4321" })).body.code, (await request({ ...COLUMBUS, shippingState: "Narnia" })).body.code, (await request({ ...COLUMBUS, shippingCountry: "Mars" })).body.code], ["ship-zip", "ship-state", "ship-country"]);
    const lines = await request({ ...COLUMBUS, shippingAddress: "1 Test St\nPAID IN FULL" });
    assert.deepStrictEqual([lines.status, lines.body.code, lines.body.field], [400, "field-single-line", "shippingAddress"]);
    const part = await request({ shippingAddress: "1 Test St", shippingState: "OH", shippingZip: "43215" }); // no city
    assert.deepStrictEqual([part.status, part.body.code], [400, "address-required"]);
    assert.strictEqual(rfqsDB.getAll().filter((r) => r.shippingAddress === "1 Test St\nPAID IN FULL").length, 0);
    // A refused request spends nothing: the same form, corrected, goes through. The state is stored as its code.
    const ok = await request({ ...COLUMBUS, shippingState: "Ohio", shippingZip: "43215-0001" });
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual(rfqsDB.getById(ok.body.rfqId).shippingState, "OH");
    // The name on the box defaults to the buyer's own.
    const noName = await request({ ...COLUMBUS, shippingName: "" });
    assert.strictEqual(rfqsDB.getById(noName.body.rfqId).shippingName, "Pat Purchasing");
  });

  test("an address outside the contiguous states is taken on a firm-quote request (a person prices that freight) and is marked for the owner", async () => {
    const hi = await request(HONOLULU);
    assert.strictEqual(hi.status, 201, hi.text);
    const de = await request({ shippingName: "Pat", shippingAddress: "Jungfernstieg 1", shippingCity: "Hamburg", shippingState: "HH", shippingZip: "20095", shippingCountry: "DE" });
    assert.strictEqual(de.status, 201, de.text);
    // A Hawaii ZIP code under a mainland state is recorded as Hawaii.
    const trick = await request({ ...HONOLULU, shippingState: "CA" });
    assert.strictEqual(rfqsDB.getById(trick.body.rfqId).shippingState, "HI");
    const list = (await h.get("/api/rfq/admin/list", owner)).body;
    assert.deepStrictEqual([hi, de, trick].map((r) => list.find((x) => x.id === r.body.rfqId).shipToZone), ["offshore", "foreign", "offshore"]);
  });

  test("pickup on the request only when the shop offers it; the public settings say whether it does", async () => {
    assert.strictEqual((await h.raw("GET", "/api/public/config")).body.pickupOffered, false);
    const off = await request({ shippingOption: "pickup" });
    assert.deepStrictEqual([off.status, off.body.code], [400, "shipping-option"]);
    await settings({ shippingLocalPickup: "on" });
    assert.strictEqual((await h.raw("GET", "/api/public/config")).body.pickupOffered, true);
    h.sent.length = 0;
    const on = await request({ shippingOption: "pickup" });
    assert.strictEqual(on.status, 201, on.text);
    const row = rfqsDB.getById(on.body.rfqId);
    assert.deepStrictEqual([row.shipToKind, row.shippingName, row.shippingAddress || ""], ["pickup", "Pat Purchasing", ""]);
    assert.ok(h.sent.find((m) => m.to === "owner@shop.test").text.includes("Delivery: Pickup at our shop"));
    await settings({ shippingLocalPickup: "off" });
  });

  test("a request sent with no address is still taken (no lead is lost), and the owner is told there is none", async () => {
    h.sent.length = 0;
    const r = await request({});
    assert.strictEqual(r.status, 201, r.text);
    assert.ok(!rfqsDB.getById(r.body.rfqId).shipToKind);
    assert.ok(h.sent.find((m) => m.to === "owner@shop.test").text.includes("Ship finished parts to: NOT GIVEN. Ask before pricing freight"));
    const listed = (await h.get("/api/rfq/admin/list", owner)).body.find((x) => x.id === r.body.rfqId);
    assert.deepStrictEqual([listed.shipToKind || null, listed.shipToLine, listed.shipToZone], [null, "", ""]);
  });

  // ── Acceptance ─────────────────────────────────────────────────────────────────────────────────
  test("the order ships to the address the quote was priced for: nothing has to be typed again, and the quote email and page say which address that is", async () => {
    const r = await request(COLUMBUS);
    const { token, mail } = await send(r.body.rfqId);
    assert.ok(mail.text.includes("Priced for delivery to: Pat Purchasing, 1 Test St, Columbus, OH 43215"), mail.text);
    const page = await h.raw("GET", `/api/rfq/quote/${token}`);
    assert.deepStrictEqual([page.body.shipTo.kind, page.body.shipTo.line], ["address", "Pat Purchasing, 1 Test St, Columbus, OH 43215"]);
    const a = await accept(token, { method: "po", poNumber: "PO-1", shippingName: "Attn: Receiving", seenTotal: 480 });
    assert.strictEqual(a.status, 201, a.text);
    const order = orderOf(r.body.rfqId);
    assert.deepStrictEqual([order.total, order.shippingName, order.shippingAddress, order.shippingCity, order.shippingState, order.shippingZip, order.shippingCost], [480, "Attn: Receiving", "1 Test St", "Columbus", "OH", "43215", 0]);
  });

  test("the same address typed again in other capitals, with ZIP+4 and the state by name, is the same address", async () => {
    const r = await request(COLUMBUS);
    const { token } = await send(r.body.rfqId);
    const a = await accept(token, { method: "po", poNumber: "PO-2", shippingName: "Pat", shippingAddress: "1 TEST ST.", shippingCity: "columbus", shippingState: "Ohio", shippingZip: "43215-0001", seenTotal: 480 });
    assert.strictEqual(a.status, 201, a.text);
  });

  test("another address at acceptance is NOT accepted at the quoted total: no order, the address is kept, the link closes, the owner is told (Honolulu, Hamburg, Anchorage: 3 of 3 were accepted)", async () => {
    const others = [HONOLULU, { shippingName: "Pat", shippingAddress: "Jungfernstieg 1", shippingCity: "Hamburg", shippingState: "HH", shippingZip: "20095", shippingCountry: "DE" }, { shippingName: "Pat", shippingAddress: "1 W 4th Ave", shippingCity: "Anchorage", shippingState: "AK", shippingZip: "99501" }, { shippingName: "Pat", shippingAddress: "9 Other Rd", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215" }];
    for (const [i, other] of others.entries()) {
      const r = await request(COLUMBUS);
      const { token } = await send(r.body.rfqId);
      h.sent.length = 0;
      const a = await accept(token, { method: i % 2 ? "po" : "card", ...(i % 2 ? { poNumber: "PO-3" } : {}), ...other, seenTotal: 480 });
      assert.deepStrictEqual([a.status, a.body.code, a.body.hadAddress], [409, "address-reconfirm", true], `${other.shippingCity}: ${a.text}`);
      assert.ok(/priced for delivery to a different address/.test(a.body.error) && /nothing was accepted and nothing was charged/.test(a.body.error) && /We will email you the quote again/.test(a.body.error), a.body.error);
      const row = rfqsDB.getById(r.body.rfqId);
      assert.deepStrictEqual([row.status, row.orderId || null, row.shippingCity, row.shipToPrevious, Boolean(row.shipToChangedAt)], ["quoted", null, other.shippingCity, "Pat Purchasing, 1 Test St, Columbus, OH 43215", true]);
      assert.strictEqual(ordersDB.query((o) => o.rfqId === r.body.rfqId).length, 0, "no order");
      const told = h.sent.filter((m) => m.to === "owner@shop.test");
      assert.strictEqual(told.length, 1);
      assert.ok(/ship-to address changed at acceptance, re-confirm the price$/.test(told[0].subject) && /NO ORDER WAS MADE/.test(told[0].text) && told[0].text.includes(`New ship-to: ${row.shippingName}, ${row.shippingAddress}`), told[0].text);
      assert.ok(!told[0].subject.includes(other.shippingCity), "nothing the buyer typed is in the subject");
      // The link the buyer holds is closed, for the new address and the old alike, and says why.
      const again = await accept(token, { method: "po", poNumber: "PO-3", shippingName: "Pat", seenTotal: 480 });
      const page = await h.raw("GET", `/api/rfq/quote/${token}`);
      assert.deepStrictEqual([again.status, again.body.code, page.status, page.body.code], [409, "address-reconfirm", 409, "address-reconfirm"]);
      const listed = (await h.get("/api/rfq/admin/list", owner)).body.find((x) => x.id === r.body.rfqId);
      assert.deepStrictEqual([listed.needsResend, listed.acceptUrl, listed.shipToPrevious, listed.shipToZone], [true, null, "Pat Purchasing, 1 Test St, Columbus, OH 43215", ["offshore", "foreign", "offshore", "contiguous"][i]]);
    }
  });

  test("the owner confirms the price for the new address and sends again: the new link is accepted to that address at that total", async () => {
    const r = await request(COLUMBUS);
    const first = await send(r.body.rfqId, 480);
    await accept(first.token, { method: "card", ...HONOLULU, seenTotal: 480 });
    const second = await send(r.body.rfqId, 780);
    assert.strictEqual(second.res.quoteSent, true);
    assert.ok(second.mail.text.includes("Priced for delivery to: Pat Purchasing, 1 Ala Moana Blvd, Honolulu, HI 96813"));
    const row = rfqsDB.getById(r.body.rfqId);
    assert.deepStrictEqual([row.shipToChangedAt || null, row.shipToPrevious || ""], [null, ""], "sending settles the change");
    assert.strictEqual((await accept(first.token, { method: "card", shippingName: "Pat", seenTotal: 480 })).status, 410, "the first link is dead");
    const a = await accept(second.token, { method: "card", shippingName: "Pat", seenTotal: 780 });
    assert.strictEqual(a.status, 201, a.text);
    const order = orderOf(r.body.rfqId);
    assert.deepStrictEqual([order.total, order.shippingCity, order.shippingState, order.shippingZip], [780, "Honolulu", "HI", "96813"]);
    const session = Object.values(h.stripe.sessions).find((s) => s.metadata && s.metadata.orderId === order.id);
    assert.strictEqual(session.amount_total, 78000, "and the card page is for the confirmed total");
  });

  test("a request that had no address: the address is asked for at acceptance and the quote goes back to the owner, once", async () => {
    const r = await request({});
    const first = await send(r.body.rfqId, 300);
    const page = await h.raw("GET", `/api/rfq/quote/${first.token}`);
    assert.deepStrictEqual([page.status, page.body.shipTo], [200, null], "it opens as before");
    assert.deepStrictEqual([(await accept(first.token, { method: "po", poNumber: "PO-4", seenTotal: 300 })).body.code], ["address-required"]);
    h.sent.length = 0;
    const a = await accept(first.token, { method: "po", poNumber: "PO-4", ...COLUMBUS, seenTotal: 300 });
    assert.deepStrictEqual([a.status, a.body.code, a.body.hadAddress], [409, "address-reconfirm", false], a.text);
    assert.ok(/priced before we had a ship-to address/.test(a.body.error));
    assert.ok(/ship-to address given at acceptance, re-confirm the price$/.test(h.sent.find((m) => m.to === "owner@shop.test").subject));
    assert.strictEqual(orderOf(r.body.rfqId), null);
    const second = await send(r.body.rfqId, 300);
    const ok = await accept(second.token, { method: "po", poNumber: "PO-4", ...COLUMBUS, seenTotal: 300 });
    assert.strictEqual(ok.status, 201, ok.text);
    assert.deepStrictEqual([orderOf(r.body.rfqId).status, orderOf(r.body.rfqId).shippingZip], ["pending_po", "43215"]);
  });

  test("a quote that was out before requests carried an address keeps its link: adding the address to the terms does not change the fingerprint of a request without one", async () => {
    const legacy = { quotedTotal: 300, quotedLeadDays: 7, validUntil: "2026-12-31T00:00:00.000Z", paperwork: false, returnPart: false, quoteNote: "", parts: [] };
    const before = rfqToken.termsFingerprint(legacy);
    assert.strictEqual(rfqToken.termsFingerprint({ ...legacy, shipToKind: null, shippingAddress: null }), before);
    assert.strictEqual(rfqToken.termsFingerprint({ ...legacy, shippingName: "x" }), before, "fields without a kind are not terms");
    assert.notStrictEqual(rfqToken.termsFingerprint({ ...legacy, shipToKind: "address", ...COLUMBUS }), before);
    assert.strictEqual(rfqToken.termsFingerprint({ ...legacy, shipToKind: "address", ...COLUMBUS }), rfqToken.termsFingerprint({ ...legacy, shipToKind: "address", ...COLUMBUS, shippingName: "Somebody Else", shippingZip: "43215-0001", shippingAddress: "1 test st." }), "the name on the box and the way the address is typed are not terms");
    assert.notStrictEqual(rfqToken.termsFingerprint({ ...legacy, shipToKind: "address", ...COLUMBUS }), rfqToken.termsFingerprint({ ...legacy, shipToKind: "address", ...HONOLULU }));
  });

  test("pickup at acceptance is accepted at the quoted total whatever the quote was priced for; a quote priced for pickup is not accepted for shipping", async () => {
    await settings({ shippingLocalPickup: "on" });
    const a = await request(COLUMBUS);
    const quoteA = await send(a.body.rfqId);
    const picked = await accept(quoteA.token, { method: "po", poNumber: "PO-5", shippingOption: "pickup", shippingName: "Pat", seenTotal: 480 });
    assert.strictEqual(picked.status, 201, picked.text);
    assert.strictEqual(orderOf(a.body.rfqId).shippingMethod, "pickup");
    const b = await request({ shippingOption: "pickup" });
    const quoteB = await send(b.body.rfqId);
    assert.strictEqual((await h.raw("GET", `/api/rfq/quote/${quoteB.token}`)).body.shipTo.kind, "pickup");
    const shipIt = await accept(quoteB.token, { method: "po", poNumber: "PO-6", ...COLUMBUS, seenTotal: 480 });
    assert.deepStrictEqual([shipIt.status, shipIt.body.code], [409, "address-reconfirm"]);
    assert.strictEqual(orderOf(b.body.rfqId), null);
    await settings({ shippingLocalPickup: "off" });
  });

  test("still held on this path: another total on the page is refused; a card and a purchase-order accept at the same instant make one order; a second acceptance is refused", async () => {
    const r = await request(COLUMBUS);
    const { token } = await send(r.body.rfqId);
    const lied = await accept(token, { method: "card", shippingName: "Pat", seenTotal: 1, total: 1, quotedTotal: 1 });
    assert.deepStrictEqual([lied.status, lied.body.code], [409, "quote-changed"]);
    // (The total is checked before the address: a wrong total with a new address changes nothing either.)
    const both = await accept(token, { method: "card", ...HONOLULU, seenTotal: 1 });
    assert.deepStrictEqual([both.status, both.body.code, rfqsDB.getById(r.body.rfqId).shippingCity], [409, "quote-changed", "Columbus"]);
    const [x, y] = await Promise.all([accept(token, { method: "card", shippingName: "Pat" }), accept(token, { method: "po", poNumber: "PO-7", shippingName: "Pat" })]);
    assert.deepStrictEqual([x.status, y.status].sort(), [201, 409]);
    assert.strictEqual(ordersDB.query((o) => o.rfqId === r.body.rfqId).length, 1);
    assert.strictEqual(orderOf(r.body.rfqId).total, 480);
    const again = await accept(token, { method: "po", poNumber: "PO-OTHER", ...HONOLULU });
    assert.deepStrictEqual([again.status, again.body.code, rfqsDB.getById(r.body.rfqId).shippingCity], [409, "already-accepted", "Columbus"], "an accepted quote's address is not changed by a later try");
  });

  await run(h.stop);
})().catch((err) => { console.error(err); process.exit(1); });
