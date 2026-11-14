#!/usr/bin/env node
/**
 * Review conditions (2026-11-13): N-03 (the destination is decided by ZIP code as well as state) and
 * N-05 (a firm quote knows where it is going).
 *
 *   node tools/security/rereview-fixes/r4-shipping-firm.js
 *
 * This stands beside the reviewer's r3-shipping-firm-f06.js, which can no longer express two of its
 * cases as written:
 *   - section A sends, as an "ordinary mainland address", the state " il " with the ZIP code of
 *     Columbus, Ohio. A state that is not the ZIP code's state is now refused, so that case reports
 *     a finding that is the test address itself. Here every "ordinary" address is a real pairing.
 *   - section D asks for a firm quote WITHOUT a ship-to address and then accepts it. Such a request
 *     is now sent back to the owner at acceptance, so the script's later steps find no order.
 *     Here the request carries the address, as the form now requires, and each thing that section
 *     showed to hold is shown again on that path.
 *
 * In-process harness, Stripe stand-in, mail captured; nothing leaves the machine.
 *
 *   A  destination: the six addresses the review bought at the mainland price; the spellings of a
 *      state it found refused; a state that does not agree with the ZIP code
 *   D  the firm quote: the request carries the address; the owner sees it; another address at
 *      acceptance goes back to the owner; a request with no address goes back once; and everything
 *      the review listed as holding on this path
 */
const assert = require("assert");
const { liftPacing, report, SHIP } = require("../rereview-relaunch/lib");
const { start } = require("../../../server/testSupport/harness");

(async () => {
  liftPacing();
  process.env.UPLOAD_MAX_PARTS_PER_15MIN = "100000";
  const h = await start({ mailer: "configured" });
  const R = report();
  const { ordersDB, rfqsDB } = h.models;
  const owner = await h.admin("Owner");
  const buyer = await h.register("dana@buyer.test", "Dana Buyer");
  const cube = await h.uploadCube();
  const cubeQuote = async (qty = 2, token = buyer) => { const q = await h.post("/api/quote", { parts: [h.cncConfig(cube, qty)], leadTimeSlug: "standard" }, token); assert.strictEqual(q.status, 200, q.text); return q.body; };
  const checkout = (quoteId, body = {}, token = buyer) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...body }, token);
  const settings = async (over) => { const r = await h.put("/api/admin/pricing", { rules: over, note: "review conditions" }, owner); assert.strictEqual(r.status, 200, r.text); };

  // ── A. Destination ────────────────────────────────────────────────────────────────────────────
  console.log("\nA. destination by ZIP code as well as state (default shipping rule: $12.00 + $2.50 a kg)");
  const zipTricks = [
    ["Honolulu ZIP 96813 under state CA", { shippingState: "CA", shippingCity: "Honolulu", shippingZip: "96813" }],
    ["Anchorage ZIP 99501 under state WA", { shippingState: "WA", shippingCity: "Anchorage", shippingZip: "99501" }],
    ["San Juan ZIP 00901 under state FL", { shippingState: "FL", shippingCity: "San Juan", shippingZip: "00901" }],
    ["military ZIP 09012 (APO AE) under state NY", { shippingState: "NY", shippingCity: "APO", shippingZip: "09012" }],
    ["Guam ZIP 96910 under state CA", { shippingState: "CA", shippingCity: "Hagatna", shippingZip: "96910" }],
    ["Hamburg, Germany typed in the city and the street, country left out, state DE (Delaware)", { shippingState: "DE", shippingCity: "Hamburg, Germany", shippingAddress: "Jungfernstieg 1, 20095 Hamburg, GERMANY", shippingZip: "20095" }],
  ];
  const sold = [];
  const refusedHow = [];
  for (const [label, body] of zipTricks) {
    const q = await cubeQuote();
    const c = await checkout(q.quoteId, body);
    if (c.status === 200) sold.push(label); else refusedHow.push(`${label}: ${c.status} ${c.body.code}`);
  }
  R.check(sold.length === 0, `the six addresses the review bought at the mainland price are refused (${zipTricks.length - sold.length} of ${zipTricks.length})`, sold.length ? `SOLD: ${sold.join(" | ")}` : refusedHow.join(" | "));
  const mustAccept = [
    ["Ohio, as the page sends it", {}],
    ["state by name", { shippingState: "New York", shippingCity: "Albany", shippingZip: "12207" }],
    ["state lower case and padded, with its own ZIP code", { shippingState: " il ", shippingCity: "Chicago", shippingZip: "60601", shippingCountry: " us " }],
    ["country 'USA'", { shippingCountry: "USA" }],
    ["Washington DC as 'DC'", { shippingState: "DC", shippingCity: "Washington", shippingZip: "20001" }],
    ["Washington DC as 'D.C.'", { shippingState: "D.C.", shippingCity: "Washington", shippingZip: "20001" }],
    ["Washington DC as 'Washington DC'", { shippingState: "Washington DC", shippingCity: "Washington", shippingZip: "20001" }],
    ["state with a full stop: 'Ill.'", { shippingState: "Ill.", shippingCity: "Chicago", shippingZip: "60601" }],
    ["state 'N.Y.'", { shippingState: "N.Y.", shippingCity: "Albany", shippingZip: "12207" }],
    ["ZIP+4", { shippingZip: "43215-1234" }],
  ];
  const refusedHonest = [];
  let sameShipping = true;
  for (const [label, body] of mustAccept) {
    const q = await cubeQuote();
    const c = await checkout(q.quoteId, body);
    if (c.status !== 200) refusedHonest.push(`${label}: ${c.status} ${c.body.code || ""}`);
    else if (Math.abs(ordersDB.getById(c.body.orderId).total - q.orderTotal) > 0.001) sameShipping = false;
  }
  R.check(refusedHonest.length === 0, `mainland addresses are accepted however the state is written (${mustAccept.length - refusedHonest.length} of ${mustAccept.length}), including the four spellings the review found refused`, refusedHonest.join(" | "));
  R.check(sameShipping, "each of them at the total the quote showed: the shipping price is the formula's, unchanged");
  {
    const q = await cubeQuote();
    const c = await checkout(q.quoteId, { shippingState: "IL" }); // Illinois with the ZIP code of Columbus, Ohio
    R.check(c.status === 400 && c.body.code === "address-mismatch", "a state that is not the ZIP code's state is refused, in words that ask the buyer to check the address", `${c.status} ${c.body.code}: "${c.body.error}"`);
    const ok = await checkout(q.quoteId, {});
    R.check(ok.status === 200, "…and the same quote is bought once the address is right", `${ok.status}`);
  }
  {
    const q = await cubeQuote();
    const first = await checkout(q.quoteId, {});
    const hi = await checkout(q.quoteId, { shippingState: "CA", shippingCity: "Honolulu", shippingZip: "96813" });
    const after = ordersDB.getById(first.body.orderId);
    R.check(hi.status >= 400 && after.shippingState === "OH" && after.shippingZip === "43215", "an unpaid order to Ohio cannot be re-addressed to a Hawaii ZIP code under 'CA'", `${hi.status} ${hi.body.code || ""}; order still ${after.shippingCity} ${after.shippingState} ${after.shippingZip}`);
  }

  // ── D. The firm quote ─────────────────────────────────────────────────────────────────────────
  console.log("\nD. the firm quote knows where it is going");
  const COLUMBUS = { shippingName: "Firm Buyer", shippingAddress: "1 Test St", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" };
  const linkFor = (email) => { const mail = [...h.sent].reverse().find((m) => m.to === email && /firm-quote\//.test(m.text || "")); return (mail.text.match(/firm-quote\/([A-Za-z0-9._~-]+)/) || [])[1]; };
  let seq = 0;
  /** A request (with `shipTo`, or with none when null), priced by the owner at `total`. */
  const firmQuote = async (total, shipTo = COLUMBUS) => {
    const email = `firm-${++seq}@buyer.test`;
    const who = await h.register(email, "Firm Buyer");
    const part = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [h.cncConfig(part, 2)], leadTimeSlug: "standard" }, who);
    const r = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: "Firm Buyer", email, notes: "please quote", ...(shipTo || {}) }, {}, who);
    assert.strictEqual(r.status, 201, r.text);
    h.sent.length = 0;
    const sent = await h.put(`/api/rfq/admin/${r.body.rfqId}`, { quotedTotal: total, quotedLeadDays: 7, status: "quoted" }, owner);
    assert.strictEqual(sent.status, 200, sent.text);
    return { rfqId: r.body.rfqId, token: linkFor(email), who, part, email, quoteId: q.body.quoteId };
  };
  const accept = (token, json) => h.raw("POST", `/api/rfq/quote/${token}/accept`, { json });
  const orderOf = (rfqId) => { const id = rfqsDB.getById(rfqId).orderId; return id ? ordersDB.getById(id) : null; };

  {
    // The request carries the address, the owner sees it beside the price, and the emails say it.
    h.sent.length = 0;
    const email = "seen@buyer.test";
    const who = await h.register(email, "Firm Buyer");
    const part = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [h.cncConfig(part, 2)], leadTimeSlug: "standard" }, who);
    const bad = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: "Firm Buyer", email, ...COLUMBUS, shippingState: "IN" }, {}, who);
    R.check(bad.status === 400 && bad.body.code === "address-mismatch", "the request form's address is checked the way checkout's is (a state that is not the ZIP code's is refused)", `${bad.status} ${bad.body.code}`);
    const hon = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: "Firm Buyer", email, shippingName: "Firm Buyer", shippingAddress: "1 Ala Moana Blvd", shippingCity: "Honolulu", shippingState: "HI", shippingZip: "96813" }, {}, who);
    R.check(hon.status === 201, "a request for an address in Hawaii is taken: a person prices that freight", `${hon.status}`);
    const row = rfqsDB.getById(hon.body.rfqId);
    R.check(row.shipToKind === "address" && row.shippingCity === "Honolulu" && row.shippingState === "HI" && row.shippingZip === "96813", "the address is stored with the request", `${row.shipToKind}: ${row.shippingAddress}, ${row.shippingCity} ${row.shippingState} ${row.shippingZip}`);
    const shopMail = h.sent.find((m) => m.to === "owner@shop.test" && /^RFQ:/.test(m.subject));
    R.check(Boolean(shopMail) && /Ship finished parts to: Firm Buyer, 1 Ala Moana Blvd, Honolulu, HI 96813/.test(shopMail.text), "the owner's notification email says where it ships", (shopMail ? (shopMail.text.match(/Ship finished parts to:[^\n]*/) || [""])[0] : "no email"));
    const listed = (await h.get("/api/rfq/admin/list", owner)).body.find((x) => x.id === hon.body.rfqId);
    R.check(listed.shipToLine === "Firm Buyer, 1 Ala Moana Blvd, Honolulu, HI 96813" && listed.shipToZone === "offshore", "the admin queue shows it beside the price box, marked as outside the contiguous states", `${listed.shipToLine} [${listed.shipToZone}]`);
  }
  {
    // Another address at acceptance: not completed at the quoted total.
    const out = [];
    for (const [label, addr] of [["Honolulu, HI", { shippingAddress: "1 Ala Moana Blvd", shippingState: "HI", shippingCity: "Honolulu", shippingZip: "96813" }], ["Hamburg, Germany", { shippingAddress: "Jungfernstieg 1", shippingCountry: "DE", shippingState: "HH", shippingCity: "Hamburg", shippingZip: "20095" }], ["Anchorage, AK", { shippingAddress: "1 W 4th Ave", shippingState: "AK", shippingCity: "Anchorage", shippingZip: "99501" }]]) {
      const f = await firmQuote(480);
      const a = await accept(f.token, { method: "card", shippingName: "Firm Buyer", ...addr, seenTotal: 480 });
      out.push(`${label}: ${a.status} ${a.body.code || ""}, order ${orderOf(f.rfqId) ? "MADE" : "none"}`);
    }
    R.check(out.every((x) => /: 409 address-reconfirm, order none$/.test(x)), "a $480 firm quote priced for Columbus, Ohio is NOT accepted to Honolulu, Hamburg or Anchorage at $480 (the review: 3 of 3 accepted)", out.join(" | "));
  }
  {
    // The whole round trip for one of them.
    const f = await firmQuote(480);
    h.sent.length = 0;
    const a = await accept(f.token, { method: "card", shippingName: "Firm Buyer", shippingAddress: "1 Ala Moana Blvd", shippingCity: "Honolulu", shippingState: "HI", shippingZip: "96813", seenTotal: 480 });
    console.log(`  the buyer reads: "${a.body.error}"`);
    const row = rfqsDB.getById(f.rfqId);
    R.check(row.status === "quoted" && row.shippingCity === "Honolulu" && /Columbus, OH 43215/.test(row.shipToPrevious) && Boolean(row.shipToChangedAt), "the new address is stored with the request, with the one the price was for", `now ${row.shippingCity} ${row.shippingState}; was "${row.shipToPrevious}"`);
    const told = h.sent.find((m) => m.to === "owner@shop.test" && /ship-to address changed at acceptance, re-confirm the price/.test(m.subject));
    R.check(Boolean(told) && /NO ORDER WAS MADE/.test(told.text), "the owner is emailed: address changed, re-confirm the price", told ? told.subject : "no email");
    const listed = (await h.get("/api/rfq/admin/list", owner)).body.find((x) => x.id === f.rfqId);
    R.check(listed.needsResend === true && listed.acceptUrl === null && Boolean(listed.shipToChangedAt), "the admin queue shows it waiting for the owner, with no live link");
    const again = await accept(f.token, { method: "card", shippingName: "Firm Buyer", seenTotal: 480 });
    const page = await h.raw("GET", `/api/rfq/quote/${f.token}`);
    R.check(again.status === 409 && page.status === 409 && page.body.code === "address-reconfirm" && ordersDB.query((o) => o.rfqId === f.rfqId).length === 0, "the link the buyer holds is closed until the owner confirms: it cannot be accepted, to the new address or the old", `accept ${again.status} ${again.body.code}; page ${page.status} ${page.body.code}`);
    // The owner confirms a price for Honolulu and sends again.
    const resent = await h.put(`/api/rfq/admin/${f.rfqId}`, { quotedTotal: 780, quotedLeadDays: 7, status: "quoted" }, owner);
    assert.strictEqual(resent.status, 200, resent.text);
    const mail = [...h.sent].reverse().find((m) => m.to === f.email && /firm-quote\//.test(m.text || ""));
    R.check(/Priced for delivery to: Firm Buyer, 1 Ala Moana Blvd, Honolulu, HI 96813/.test(mail.text), "the new quote email says which address the price is for", (mail.text.match(/Priced for delivery to:[^\n]*/) || [""])[0]);
    const ok = await accept(linkFor(f.email), { method: "card", shippingName: "Firm Buyer", seenTotal: 780 });
    const order = orderOf(f.rfqId);
    R.check(ok.status === 201 && order && Math.round(order.total * 100) === 78000 && order.shippingCity === "Honolulu" && order.shippingState === "HI", "accepted from the new link, the order is at the confirmed total and ships to the address it was priced for", `${ok.status}; order $${order && order.total} to ${order && order.shippingCity} ${order && order.shippingState} ${order && order.shippingZip}`);
  }
  {
    // A request that was made with no address (an open request from before this change).
    const f = await firmQuote(300, null);
    const row = rfqsDB.getById(f.rfqId);
    const page = await h.raw("GET", `/api/rfq/quote/${f.token}`);
    R.check(!row.shipToKind && page.status === 200 && page.body.shipTo === null, "a request with no address still opens (nothing crashes on one)", `page ${page.status}`);
    const first = await accept(f.token, { method: "po", poNumber: "PO-100", ...COLUMBUS, seenTotal: 300 });
    R.check(first.status === 409 && first.body.code === "address-reconfirm" && first.body.hadAddress === false && !orderOf(f.rfqId), "accepted with an address for the first time: no order, it goes back to the owner", `${first.status} ${first.body.code}: "${String(first.body.error).slice(0, 90)}…"`);
    await h.put(`/api/rfq/admin/${f.rfqId}`, { quotedTotal: 300, quotedLeadDays: 7, status: "quoted" }, owner);
    const second = await accept(linkFor(f.email), { method: "po", poNumber: "PO-100", ...COLUMBUS, seenTotal: 300 });
    R.check(second.status === 201 && orderOf(f.rfqId).shippingZip === "43215", "…once: after the owner has confirmed, the same address is accepted", `${second.status}; order ${orderOf(f.rfqId).status}`);
  }
  {
    // Same address, written a little differently, and a different name on the box: not "another address".
    const f = await firmQuote(480);
    const a = await accept(f.token, { method: "po", poNumber: "PO-7", shippingName: "Attn: Receiving", shippingAddress: "1 TEST ST.", shippingCity: "columbus", shippingState: "Ohio", shippingZip: "43215-0001", seenTotal: 480 });
    R.check(a.status === 201 && orderOf(f.rfqId).shippingName === "Attn: Receiving", "the same address in other capitals, with ZIP+4 and another name on the box, is accepted", `${a.status} ${a.body.code || ""}`);
  }
  {
    // Pickup at acceptance: no freight, accepted whatever the quote was priced for.
    await settings({ shippingLocalPickup: "on" });
    const f = await firmQuote(480);
    const a = await accept(f.token, { method: "po", poNumber: "PO-8", shippingOption: "pickup", shippingName: "Firm Buyer", seenTotal: 480 });
    R.check(a.status === 201 && orderOf(f.rfqId).shippingMethod === "pickup", "collecting at the shop is accepted at the quoted total (no freight to a new place)", `${a.status}`);
    // …and a request priced FOR pickup that the buyer then wants shipped goes back to the owner.
    const p = await firmQuote(480, { shippingOption: "pickup", shippingName: "Firm Buyer" });
    const ship = await accept(p.token, { method: "po", poNumber: "PO-9", ...COLUMBUS, seenTotal: 480 });
    R.check(rfqsDB.getById(p.rfqId).shipToKind === "address" && ship.status === 409 && ship.body.code === "address-reconfirm" && !orderOf(p.rfqId), "a quote priced for pickup cannot be accepted for shipping at that price", `${ship.status} ${ship.body.code}`);
    await settings({ shippingLocalPickup: "off" });
  }

  console.log("\n   what the review listed as holding on this path, on a request that carries its address");
  {
    const f = await firmQuote(480);
    const lied = await accept(f.token, { method: "card", shippingName: "Firm Buyer", seenTotal: 1, total: 1, quotedTotal: 1, amount: 1 });
    R.check(lied.status === 409 && lied.body.code === "quote-changed", "accepting with another total on the page is refused", `${lied.status} ${lied.body.code || ""}`);
    const [a, b] = await Promise.all([
      accept(f.token, { method: "card", shippingName: "Firm Buyer", total: 1, quotedTotal: 1 }),
      accept(f.token, { method: "po", poNumber: "PO-7781", shippingName: "Firm Buyer" }),
    ]);
    const orders = ordersDB.query((o) => o.rfqId === f.rfqId);
    R.check(orders.length === 1 && [a.status, b.status].filter((s) => s === 201).length === 1, "a card accept and a purchase-order accept at the same moment make one order", `card ${a.status}, PO ${b.status}, orders ${orders.length}`);
    const order = orders[0];
    R.check(Math.round(order.total * 100) === 48000 && order.shippingCity === "Columbus" && order.shippingCost === 0, "the order is at the owner's total whatever the request said, and ships to the address it was priced for", `$${order.total} to ${order.shippingCity} ${order.shippingState}`);
    const edit = await h.put(`/api/rfq/admin/${f.rfqId}`, { quotedTotal: 10 }, owner);
    R.check(edit.status === 409, "the price cannot be edited under an accepted quote", `${edit.status}`);
    if (order.status === "pending_payment") {
      const s = Object.values(h.stripe.sessions).find((x) => x.metadata && x.metadata.orderId === order.id);
      R.check(s && s.amount_total === 48000, "the card page is for the quoted total", `${s && s.amount_total}`);
      await h.webhook("checkout.session.completed", { ...s, payment_status: "paid", status: "complete", payment_intent: "pi_firm_short", amount_total: 100, amount_subtotal: 100 });
      const o = ordersDB.getById(order.id);
      R.check(o.status === "pending_payment" && Boolean(o.attention), "a report of $1.00 paid on a $480 firm quote does not release the order", `${o.status} / ${o.attention}`);
    } else R.info("the purchase order won the race in this run, so the two card-page checks were not made", order.status);
  }
  {
    const f = await firmQuote(300);
    const revise = await h.put(`/api/rfq/admin/${f.rfqId}`, { quotedTotal: 900, quotedLeadDays: 7, status: "quoted" }, owner);
    const oldLink = await accept(f.token, { method: "po", poNumber: "PO-1", shippingName: "Firm Buyer" });
    R.check(revise.status === 200 && oldLink.status === 410 && ordersDB.query((o) => o.rfqId === f.rfqId).length === 0, "after the owner revises the price ($300 → $900) the first link cannot be accepted at any price", `old link → ${oldLink.status} ${oldLink.body.code || ""}`);
    const token2 = linkFor(f.email);
    const po = await accept(token2, { method: "po", poNumber: "PO-STRANGER-1", shippingName: "Firm Buyer" });
    const o = orderOf(f.rfqId);
    const again = await accept(token2, { method: "po", poNumber: "PO-OTHER", shippingName: "Firm Buyer" });
    const card = await accept(token2, { method: "card", shippingName: "Firm Buyer" });
    R.check(po.status === 201 && again.status === 409 && card.status === 409 && ordersDB.query((x) => x.rfqId === f.rfqId).length === 1, "a second acceptance (another PO number, or a card) is refused: one quote, one order", `first ${po.status}; PO again ${again.status}; card ${card.status}`);
    const units = await h.raw("POST", `/api/parts/${f.part}/units`, { json: { units: "in" }, token: f.who, headers: { "X-Part-Key": h.editKeys[f.part] || "" } });
    R.check(units.status >= 400, "a part on a firm-quote request cannot have its units changed", `${units.status} ${units.body && (units.body.code || units.body.error)}`);
    const ro = await h.post(`/api/orders/${o.id}/reorder`, {}, f.who);
    R.check(ro.status === 409, "an unconfirmed purchase-order order cannot be reordered", `${ro.status} ${ro.body.code || ""}`);
  }

  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
