#!/usr/bin/env node
/**
 * Second re-review (2026-11-13): the shipping limits (F-03) on every route that makes an order total,
 * the firm-quote and purchase-order money path, and the two-tab delivery change (F-06) under a race.
 *
 *   node tools/security/rereview-fixes/r3-shipping-firm-f06.js [f06Rounds=200]
 *
 * In-process harness, Stripe stand-in, mail captured; nothing leaves the machine.
 *
 *   A  destination: Hawaii, Alaska, territories, military mail and other countries, written the ways a
 *      person (or a script) can write them: by state code, by state name, by ZIP code under a mainland
 *      state code, mixed case, padded, as a list
 *   B  an address or a delivery choice changed AFTER the order exists
 *   C  size and weight: many lines each inside the limits; a long part drawn on the diagonal
 *   D  the firm quote: who can accept, at what total, to what address, on card and on a purchase order
 *   E  F-06: tab 1 pays for pickup while tab 2 switches the same order to shipping, `rounds` times with
 *      random timing. A correct payment must never be flagged.
 */
const assert = require("assert");
const { liftPacing, rectDxf, report, SHIP } = require("../rereview-relaunch/lib");
const { start } = require("../../../server/testSupport/harness");

const ROUNDS = Number(process.argv[2]) || 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A w x l inch strip turned by `deg` degrees, as a closed polyline DXF in inches. */
function rotatedRectDxf(wIn, lIn, deg) {
  const a = (deg * Math.PI) / 180;
  const pts = [[0, 0], [lIn, 0], [lIn, wIn], [0, wIn]].map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
  const minX = Math.min(...pts.map((p) => p[0])), minY = Math.min(...pts.map((p) => p[1]));
  const out = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1015", "9", "$INSUNITS", "70", "1", "9", "$MEASUREMENT", "70", "0", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", "0", "LWPOLYLINE", "8", "0", "90", "4", "70", "1"];
  for (const [x, y] of pts) out.push("10", (x - minX).toFixed(4), "20", (y - minY).toFixed(4));
  out.push("0", "ENDSEC", "0", "EOF");
  return Buffer.from(out.join("\n") + "\n");
}

(async () => {
  liftPacing();
  process.env.UPLOAD_MAX_PARTS_PER_15MIN = "100000";
  const h = await start({ mailer: "configured" });
  const R = report();
  const { ordersDB, quotesDB, rfqsDB } = h.models;
  const owner = await h.admin("Owner");
  const buyer = await h.register("dana@buyer.test", "Dana Buyer");
  const cube = await h.uploadCube();
  const cubeQuote = async (qty = 2, token = buyer) => { const q = await h.post("/api/quote", { parts: [h.cncConfig(cube, qty)], leadTimeSlug: "standard" }, token); assert.strictEqual(q.status, 200, q.text); return q.body; };
  const checkout = (quoteId, body = {}, token = buyer) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...body }, token);
  const settings = async (over) => { const r = await h.put("/api/admin/pricing", { rules: over, note: "second re-review" }, owner); assert.strictEqual(r.status, 200, r.text); };

  // ── A. Destination ────────────────────────────────────────────────────────────────────────────
  console.log("\nA. destination, every way of writing it (default shipping rule: $12.00 + $2.50 a kg)");
  const mustRefuse = [
    ["Hawaii by code", { shippingState: "HI", shippingCity: "Honolulu", shippingZip: "96813" }],
    ["Hawaii by name, mixed case", { shippingState: " hawaii ", shippingCity: "Honolulu", shippingZip: "96813" }],
    ["Alaska by code", { shippingState: "AK", shippingCity: "Anchorage", shippingZip: "99501" }],
    ["Puerto Rico", { shippingState: "PR", shippingCity: "San Juan", shippingZip: "00901" }],
    ["Guam", { shippingState: "GU", shippingCity: "Hagatna", shippingZip: "96910" }],
    ["military mail (AE)", { shippingState: "AE", shippingCity: "APO", shippingZip: "09012" }],
    ["Germany", { shippingState: "HH", shippingCity: "Hamburg", shippingZip: "20095", shippingCountry: "DE" }],
    ["Germany, lower case and padded", { shippingState: "HH", shippingCity: "Hamburg", shippingZip: "20095", shippingCountry: " de " }],
    ["Canada, with a state code that is also a US state", { shippingState: "CA", shippingCity: "Toronto", shippingZip: "M5V 2T6", shippingCountry: "CA" }],
    ["Mexico", { shippingState: "CO", shippingCity: "Colima", shippingZip: "28000", shippingCountry: "MX" }],
    ["country sent as a number", { shippingCountry: 0 }],
    ["country sent as free text", { shippingCountry: "Mars" }],
  ];
  // Written so the STATE says mainland and everything else says otherwise: a carrier goes by the ZIP code.
  const zipTricks = [
    ["Honolulu ZIP 96813 under state CA", { shippingState: "CA", shippingCity: "Honolulu", shippingZip: "96813" }],
    ["Anchorage ZIP 99501 under state WA", { shippingState: "WA", shippingCity: "Anchorage", shippingZip: "99501" }],
    ["San Juan ZIP 00901 under state FL", { shippingState: "FL", shippingCity: "San Juan", shippingZip: "00901" }],
    ["military ZIP 09012 (APO AE) under state NY", { shippingState: "NY", shippingCity: "APO", shippingZip: "09012" }],
    ["Guam ZIP 96910 under state CA", { shippingState: "CA", shippingCity: "Hagatna", shippingZip: "96910" }],
    ["Hamburg, Germany typed in the city and the street, country left out, state DE (Delaware)", { shippingState: "DE", shippingCity: "Hamburg, Germany", shippingAddress: "Jungfernstieg 1, 20095 Hamburg, GERMANY", shippingZip: "20095" }],
  ];
  const mustAccept = [
    ["Ohio, as the page sends it", {}],
    ["state by name", { shippingState: "New York", shippingCity: "Albany", shippingZip: "12207" }],
    ["state lower case and padded, country ' us '", { shippingState: " il ", shippingCountry: " us " }],
    ["country 'USA'", { shippingCountry: "USA" }],
    ["country 'United States'", { shippingCountry: "United States" }],
    ["Washington DC as 'DC'", { shippingState: "DC", shippingCity: "Washington", shippingZip: "20001" }],
    ["Washington DC as 'D.C.'", { shippingState: "D.C.", shippingCity: "Washington", shippingZip: "20001" }],
    ["Washington DC as 'Washington DC'", { shippingState: "Washington DC", shippingCity: "Washington", shippingZip: "20001" }],
    ["state with a full stop: 'Ill.'", { shippingState: "Ill.", shippingCity: "Chicago", shippingZip: "60601" }],
    ["state 'N.Y.'", { shippingState: "N.Y.", shippingCity: "Albany", shippingZip: "12207" }],
  ];
  for (const [label, body] of mustRefuse) {
    const q = await cubeQuote();
    const c = await checkout(q.quoteId, body);
    R.check(c.status >= 400, `refused: ${label}`, `${c.status} ${c.body.code || ""}`);
  }
  const sold = [];
  for (const [label, body] of zipTricks) {
    const q = await cubeQuote();
    const c = await checkout(q.quoteId, body);
    if (c.status === 200) { const o = ordersDB.getById(c.body.orderId); sold.push(`${label}: sold, shipping $${o.shippingCost} on a $${o.total} order`); }
  }
  if (sold.length) R.finding(`${sold.length} of ${zipTricks.length} addresses outside the contiguous states are given a parcel price when the STATE field says a mainland state (the ZIP code is not looked at)`, sold.join(" | "));
  else R.holds("an off-mainland ZIP code under a mainland state code is refused");
  const refusedHonest = [];
  for (const [label, body] of mustAccept) {
    const q = await cubeQuote();
    const c = await checkout(q.quoteId, body);
    if (c.status !== 200) refusedHonest.push(`${label}: ${c.status} ${c.body.code || ""} "${String(c.body.error || "").slice(0, 90)}"`);
  }
  R.check(refusedHonest.filter((x) => !/D\.C\.|Washington DC|Ill\.|N\.Y\./.test(x)).length === 0, "ordinary mainland addresses are accepted", refusedHonest.join(" | "));
  const fussy = refusedHonest.filter((x) => /D\.C\.|Washington DC|Ill\.|N\.Y\./.test(x));
  if (fussy.length) R.info(`a mainland customer who types the state another way is sent to a firm quote (${fussy.length} of 4 spellings tried)`, fussy.join(" | "));

  // ── B. Changed after the order exists ─────────────────────────────────────────────────────────
  console.log("\nB. address or delivery choice changed after the order exists");
  {
    const q = await cubeQuote();
    const first = await checkout(q.quoteId, {});
    const before = ordersDB.getById(first.body.orderId);
    const hi = await checkout(q.quoteId, { shippingState: "HI", shippingCity: "Honolulu", shippingZip: "96813" });
    const after = ordersDB.getById(first.body.orderId);
    R.check(hi.status >= 400 && after.shippingState === before.shippingState && after.total === before.total, "an unpaid order to Ohio cannot be re-addressed to Hawaii", `${hi.status} ${hi.body.code || ""}; order still ${after.shippingState} $${after.total}`);
    const de = await checkout(q.quoteId, { shippingCountry: "DE", shippingState: "HH", shippingCity: "Hamburg" });
    R.check(de.status >= 400 && ordersDB.getById(first.body.orderId).shippingCountry === "US", "…nor to Germany", `${de.status} ${de.body.code || ""}`);
  }
  {
    await settings({ shippingLocalPickup: "on" });
    const q = await cubeQuote();
    const pickup = await checkout(q.quoteId, { shippingOption: "pickup", shippingState: "HI", shippingCity: "Honolulu", shippingZip: "96813" });
    const toShip = await checkout(q.quoteId, { shippingState: "HI", shippingCity: "Honolulu", shippingZip: "96813" });
    const o = pickup.status === 200 ? ordersDB.getById(pickup.body.orderId) : null;
    R.check(toShip.status >= 400 && (!o || ordersDB.getById(o.id).shippingMethod === "pickup"), "a pickup order cannot be switched to 'ship it' for a Hawaii address", `pickup ${pickup.status}; switch → ${toShip.status} ${toShip.body.code || ""}`);
    await settings({ shippingLocalPickup: "off" });
  }

  // ── C. Size and weight ────────────────────────────────────────────────────────────────────────
  console.log("\nC. size and weight");
  {
    const mat = h.models.materialsDB.getAll().find((m) => m.active && m.process === "routing" && m.slug === "rt-hdpe") || h.models.materialsDB.getAll().find((m) => m.active && m.process === "routing");
    const grade = (mat.grades && mat.grades[0] && mat.grades[0].name) || "";
    const ts = (mat.thicknesses || []).map((t) => (t && typeof t === "object" ? t.mm || t.thicknessMm : t)).filter(Boolean);
    const thick = ts[ts.length - 1];
    const up = async (name, data) => { const r = await h.form("/api/upload", {}, { files: { name, data } }); assert.ok(r.status === 200 && r.body.parts.length, r.text); return r.body.parts[0].partId; };
    const line = (partId, quantity, t = thick) => ({ partId, materialSlug: mat.slug, grade, finishSlug: "", quantity, process: "routing", thicknessMm: t });
    // Several different sheets, each a line inside the limits by itself.
    const sheets = [];
    for (let i = 0; i < 6; i++) sheets.push(await up(`sheet-${i}.dxf`, rectDxf(24, 40 + i)));
    const one = await h.post("/api/quote", { parts: [line(sheets[0], 1)], leadTimeSlug: "standard" }, buyer);
    const many = await h.post("/api/quote", { parts: sheets.map((id) => line(id, 1)), leadTimeSlug: "standard" }, buyer);
    const lbOne = one.body.shipping && one.body.shipping.packedLb;
    const lbMany = many.body.shipping && many.body.shipping.packedLb;
    R.info("one 24 x 40 in sheet of the thickest HDPE, and six such sheets as six lines", `one: ${lbOne} lb, firm quote ${Boolean(one.body.gate && one.body.gate.requiresRfq)}; six lines: ${lbMany} lb, firm quote ${Boolean(many.body.gate && many.body.gate.requiresRfq)}, reasons ${((many.body.gate || {}).reasons || []).map((r) => r.code).join(",")}`);
    if (lbMany > 50) {
      R.check(Boolean(many.body.gate && many.body.gate.requiresRfq), "six lines that are each inside the limits and together over 50 lb go to a firm quote");
      const c = await checkout(many.body.quoteId, {});
      R.check(c.status >= 400, "…and cannot be checked out", `${c.status} ${c.body.code || ""}`);
    }
    // The stored quote says 1 piece; the stored configuration is pushed to many pieces behind the page's back.
    if (one.status === 200 && !(one.body.gate && one.body.gate.requiresRfq)) {
      const stored = quotesDB.getById(one.body.quoteId);
      quotesDB.update(stored.id, { config: { ...stored.config, parts: stored.config.parts.map((p) => ({ ...p, quantity: 40 })) } });
      const c = await checkout(stored.id, {});
      R.check(c.status >= 400, "a stored quote whose quantity no longer matches what was priced is not charged at the old shipping", `${c.status} ${c.body.code || ""}`);
    }
    // A long strip drawn on the diagonal: its true length is over 48 in, its upright box is under.
    const TRUE_LEN = 62;
    const strip = await up("strip-diagonal.dxf", rotatedRectDxf(3, TRUE_LEN, 45));
    const straight = await up("strip-straight.dxf", rectDxf(3, TRUE_LEN));
    const qd = await h.post("/api/quote", { parts: [line(strip, 1, ts[0])], leadTimeSlug: "standard" }, buyer);
    const qs = await h.post("/api/quote", { parts: [line(straight, 1, ts[0])], leadTimeSlug: "standard" }, buyer);
    const gated = (q) => Boolean(q.body.gate && q.body.gate.requiresRfq);
    R.info(`a 3 x ${TRUE_LEN} in strip, drawn straight and drawn at 45 degrees`, `straight: longest ${qs.body.shipping && qs.body.shipping.longestIn} in, firm quote ${gated(qs)}; diagonal: longest ${qd.body.shipping && qd.body.shipping.longestIn} in, firm quote ${gated(qd)}, shipping $${qd.body.shippingEstimate}, total $${qd.body.orderTotal}`);
    if (qd.status === 200 && !gated(qd)) R.finding(`a ${TRUE_LEN} in long part drawn on the diagonal is given a parcel price (the 48 in limit reads the upright box: ${qd.body.shipping && qd.body.shipping.longestIn} in)`, `shipping $${qd.body.shippingEstimate} on $${qd.body.orderTotal}; the same strip drawn straight goes to a firm quote: ${gated(qs)}`);
    else R.holds("a long part drawn on the diagonal is still measured at its true length");
  }

  // ── D. The firm quote ─────────────────────────────────────────────────────────────────────────
  console.log("\nD. the firm quote and the purchase order");
  const firmQuote = async (email, total) => {
    const who = await h.register(email, "Firm Buyer");
    const part = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [h.cncConfig(part, 2)], leadTimeSlug: "standard" }, who);
    const r = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: "Firm Buyer", email, notes: "please quote" }, {}, who);
    assert.strictEqual(r.status, 201, r.text);
    const sent = await h.put(`/api/rfq/admin/${r.body.rfqId}`, { quotedTotal: total, quotedLeadDays: 7, status: "quoted" }, owner);
    assert.strictEqual(sent.status, 200, sent.text);
    const mail = [...h.sent].reverse().find((m) => m.to === email && /firm-quote\//.test(m.text || ""));
    const token = (mail.text.match(/firm-quote\/([A-Za-z0-9._~-]+)/) || [])[1];
    return { rfqId: r.body.rfqId, token, who, part, quoteId: q.body.quoteId };
  };
  const ADDRESS = { shippingName: "Firm Buyer", shippingAddress: "1 Test St", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" };
  {
    // Where can a firm quote be accepted TO? The owner priced it without being asked for an address.
    const out = [];
    for (const [label, addr] of [["Honolulu, HI", { shippingState: "HI", shippingCity: "Honolulu", shippingZip: "96813" }], ["Hamburg, Germany", { shippingCountry: "DE", shippingState: "HH", shippingCity: "Hamburg", shippingZip: "20095" }], ["Anchorage, AK", { shippingState: "AK", shippingCity: "Anchorage", shippingZip: "99501" }]]) {
      const f = await firmQuote(`firm-${out.length}@buyer.test`, 480);
      const a = await h.raw("POST", `/api/rfq/quote/${f.token}/accept`, { json: { method: "card", ...ADDRESS, ...addr, seenTotal: 480 } });
      const order = a.status === 201 ? ordersDB.getById(rfqsDB.getById(f.rfqId).orderId) : null;
      out.push(`${label}: ${a.status}${order ? ` (order $${order.total}, shipping line $${order.shippingCost}, ship to ${order.shippingCity} ${order.shippingState} ${order.shippingCountry})` : ` ${a.body.code || ""}`}`);
    }
    const accepted = out.filter((x) => x.includes(": 201")).length;
    const rfqHasAddress = Object.keys(rfqsDB.getAll()[0] || {}).some((k) => /^shipping(State|Zip|Country|City)$/.test(k));
    if (accepted) R.finding(`a firm quote is accepted, at the quoted total, to an address outside the contiguous states (${accepted} of 3), and the request the owner priced carries no ship-to address`, `${out.join(" | ")}; request row has ship-to fields: ${rfqHasAddress}`);
    else R.holds("a firm quote cannot be accepted to an address outside the contiguous states", out.join(" | "));
  }
  {
    const f = await firmQuote("firm-money@buyer.test", 480);
    // Total: nothing the page sends is an amount.
    const lied = await h.raw("POST", `/api/rfq/quote/${f.token}/accept`, { json: { method: "card", ...ADDRESS, seenTotal: 1, total: 1, quotedTotal: 1, amount: 1 } });
    R.check(lied.status === 409, "accepting with another total on the page is refused", `${lied.status} ${lied.body.code || ""}`);
    // Two accepts at once, card and PO.
    const [a, b] = await Promise.all([
      h.raw("POST", `/api/rfq/quote/${f.token}/accept`, { json: { method: "card", ...ADDRESS, total: 1, quotedTotal: 1 } }),
      h.raw("POST", `/api/rfq/quote/${f.token}/accept`, { json: { method: "po", poNumber: "PO-7781", ...ADDRESS } }),
    ]);
    const orders = ordersDB.query((o) => o.rfqId === f.rfqId);
    R.check(orders.length === 1 && [a.status, b.status].filter((s) => s === 201).length === 1, "a card accept and a purchase-order accept at the same moment make one order", `card ${a.status}, PO ${b.status}, orders ${orders.length} (${orders.map((o) => o.status).join(",")})`);
    const order = orders[0];
    R.check(Math.round(order.total * 100) === 48000, "the order is at the owner's total whatever the request said", `$${order.total}`);
    // The owner cannot be made to change the price under the order; a change before acceptance kills the old link.
    const edit = await h.put(`/api/rfq/admin/${f.rfqId}`, { quotedTotal: 10 }, owner);
    R.check(edit.status === 409, "the price cannot be edited under an accepted quote", `${edit.status}`);
    if (order.status === "pending_payment") {
      const s = Object.values(h.stripe.sessions).find((x) => x.metadata && x.metadata.orderId === order.id);
      R.check(s && s.amount_total === 48000, "the card page is for the quoted total", `${s && s.amount_total}`);
      // Paid short by a doctored report: not released.
      await h.webhook("checkout.session.completed", { ...s, payment_status: "paid", status: "complete", payment_intent: "pi_firm_short", amount_total: 100, amount_subtotal: 100 });
      const o = ordersDB.getById(order.id);
      R.check(o.status === "pending_payment" && Boolean(o.attention), "a report of $1.00 paid on a $480 firm quote does not release the order", `${o.status} / ${o.attention}`);
    }
  }
  {
    const f = await firmQuote("firm-link@buyer.test", 300);
    // The owner revises the price: the first link must stop working.
    const revise = await h.put(`/api/rfq/admin/${f.rfqId}`, { quotedTotal: 900, quotedLeadDays: 7, status: "quoted" }, owner);
    const oldLink = await h.raw("POST", `/api/rfq/quote/${f.token}/accept`, { json: { method: "po", poNumber: "PO-1", ...ADDRESS } });
    const orders = ordersDB.query((o) => o.rfqId === f.rfqId);
    R.check(revise.status === 200 && oldLink.status >= 400 && orders.length === 0, "after the owner revises the price ($300 → $900) the first link cannot be accepted at any price", `revise ${revise.status}; old link → ${oldLink.status} ${oldLink.body.code || ""}; orders ${orders.length}`);
    const mail = [...h.sent].reverse().find((m) => m.to === "firm-link@buyer.test" && /firm-quote\//.test(m.text || ""));
    const token2 = (mail.text.match(/firm-quote\/([A-Za-z0-9._~-]+)/) || [])[1];
    // A purchase order: who can place one, and what does the shop get?
    const po = await h.raw("POST", `/api/rfq/quote/${token2}/accept`, { json: { method: "po", poNumber: "PO-STRANGER-1", ...ADDRESS } });
    const o = ordersDB.query((x) => x.rfqId === f.rfqId)[0];
    const queue = (await h.get("/api/orders/admin/queue", owner)).body;
    R.info("a purchase-order acceptance: no login, no card, the link in the email is the only credential", `accept ${po.status}; order ${o && o.status}, $${o && o.total}, in the production queue: ${Boolean(o && queue.some((x) => x.id === o.id))}; nothing charged: the owner confirms the PO by hand`);
    const again = await h.raw("POST", `/api/rfq/quote/${token2}/accept`, { json: { method: "po", poNumber: "PO-OTHER", ...ADDRESS } });
    const card = await h.raw("POST", `/api/rfq/quote/${token2}/accept`, { json: { method: "card", ...ADDRESS } });
    R.check(again.status === 409 && card.status === 409 && ordersDB.query((x) => x.rfqId === f.rfqId).length === 1, "a second acceptance (another PO number, or a card) is refused: one quote, one order", `PO again ${again.status}, card ${card.status}`);
    // The drawing under a firm quote: can its units still be changed? (F-01 for requests)
    const units = await h.raw("POST", `/api/parts/${f.part}/units`, { json: { units: "in" }, token: f.who, headers: { "X-Part-Key": h.editKeys[f.part] || "" } });
    R.check(units.status >= 400, "a part on a firm-quote request cannot have its units changed", `${units.status} ${units.body && (units.body.code || units.body.error)}`);
    // Reorder of a PO order that was never paid and never taken into work.
    const ro = await h.post(`/api/orders/${o.id}/reorder`, {}, f.who);
    R.info("reorder of a purchase-order order the shop has not yet confirmed", `${ro.status} ${ro.body.code || ""}`);
  }

  // ── E. F-06 under a race ──────────────────────────────────────────────────────────────────────
  console.log(`\nE. F-06: tab 1 pays for pickup while tab 2 switches to shipping, ${ROUNDS} rounds`);
  {
    await settings({ shippingLocalPickup: "on" });
    process.env.ORDERS_UNPAID_PER_ACCOUNT = "100000"; process.env.ORDERS_UNPAID_PER_CLIENT = "100000"; process.env.ORDERS_UNPAID_NEW_PER_ACCOUNT_DAY = "100000"; process.env.ORDERS_UNPAID_NEW_PER_CLIENT_DAY = "100000";
    const tally = { rounds: 0, paid: 0, paidPickup: 0, paidShip: 0, unpaid: 0, flagged: 0, wrongAmount: 0, tab2: {}, payerSkipped: 0, doubleCharged: 0 };
    const flaggedExamples = [];
    const sessionsOf = (orderId) => Object.values(h.stripe.sessions).filter((s) => s.metadata && s.metadata.orderId === orderId);
    for (let i = 0; i < ROUNDS; i++) {
      h.stripe.delayMs = [0, 1, 3, 8][i % 4];
      const q = await cubeQuote(2 + (i % 7));
      const a = await checkout(q.quoteId, { shippingOption: "pickup" });
      assert.strictEqual(a.status, 200, a.text);
      const orderId = a.body.orderId;
      const pickupTotal = ordersDB.getById(orderId).total;
      const jitter = () => Math.floor(Math.random() * 14);
      let charged = 0;
      // The buyer in tab 1: pays whatever page of this order is open at Stripe at that instant
      // (Stripe takes money only on an open page), and Stripe then tells the site by webhook.
      const payer = (async () => {
        await sleep(jitter());
        const open = sessionsOf(orderId).find((s) => s.status === "open");
        if (!open) { tally.payerSkipped++; return; }
        Object.assign(open, { payment_status: "paid", status: "complete", payment_intent: `pi_f06_${i}` });
        charged += open.amount_total;
        await sleep(jitter());
        await h.webhook("checkout.session.completed", open);
      })();
      const tab2 = (async () => { await sleep(jitter()); return checkout(q.quoteId, {}); })();
      const back = (async () => { await sleep(jitter() + 5); return h.post(`/api/orders/${orderId}/confirm-payment`, {}, buyer); })();
      const [, t2] = await Promise.all([payer, tab2, back]);
      await sleep(15);
      // A buyer handed a second page by tab 2 may pay that one too if the first payment had not shown yet.
      const o = ordersDB.getById(orderId);
      tally.rounds++;
      tally.tab2[`${t2.status}${t2.body.code ? " " + t2.body.code : ""}`] = (tally.tab2[`${t2.status}${t2.body.code ? " " + t2.body.code : ""}`] || 0) + 1;
      if (o.attention) { tally.flagged++; if (flaggedExamples.length < 4) flaggedExamples.push(`round ${i}: ${o.status}, flag ${o.attention}, method ${o.shippingMethod}, order $${o.total}, pickup was $${pickupTotal}, charged $${charged / 100}, stripe delay ${h.stripe.delayMs} ms, tab 2 → ${t2.status}; "${String(o.attentionNote || "").slice(0, 150)}"`); }
      if (o.status === "paid") {
        tally.paid++;
        if (o.shippingMethod === "pickup") tally.paidPickup++; else tally.paidShip++;
        if (Math.round(o.amountPaid * 100) !== charged || Math.round(o.total * 100) !== charged) { tally.wrongAmount++; if (flaggedExamples.length < 6) flaggedExamples.push(`round ${i}: PAID with amounts that differ: order $${o.total}, amountPaid $${o.amountPaid}, charged $${charged / 100}, method ${o.shippingMethod}`); }
      } else tally.unpaid++;
      if (charged > 0 && o.status !== "paid" && !o.attention) { tally.wrongAmount++; flaggedExamples.push(`round ${i}: charged $${charged / 100} and the order is ${o.status} with no flag`); }
    }
    h.stripe.delayMs = 0;
    R.info("what happened", JSON.stringify(tally));
    R.check(tally.flagged === 0, `a correct payment is never flagged (${tally.flagged} of ${tally.rounds} rounds flagged)`, flaggedExamples.join(" || "));
    R.check(tally.wrongAmount === 0, "every paid order is at the amount that was charged, and no charge is left without a paid or flagged order", `${tally.wrongAmount} of ${tally.rounds}`);
  }

  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
