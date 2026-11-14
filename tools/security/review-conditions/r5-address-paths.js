#!/usr/bin/env node
/**
 * Review of the review-conditions fixes (2026-11-13): N-03 (ZIP code as well as state) and N-05 (a
 * firm quote knows where it is going), attacked on every path that takes an address.
 *
 *   node tools/security/review-conditions/r5-address-paths.js
 *
 * In-process harness (real routes, throwaway database, Stripe stand-in, mail captured).
 *
 *   A  instant checkout: can an address whose ZIP code is off the mainland be SOLD at the parcel
 *      price by any spelling of ZIP code, state or country? Which honest spellings are turned away?
 *   B  the other ways an address reaches an order: the same quote checked out again with another
 *      address, a reorder, the owner's phone order
 *   D  the firm quote: which changes of address count as "changed"; two acceptances at once with
 *      different addresses; can a buyer keep the owner re-confirming; pickup both ways; a request
 *      with no address; what the owner is shown (HTML and header characters in every field)
 */
const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const { liftPacing, report, SHIP } = require(path.join(ROOT, "tools/security/rereview-relaunch/lib"));
const { start } = require(path.join(ROOT, "server/testSupport/harness"));
const us = require(path.join(ROOT, "server/services/usAddress"));

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
  const settings = async (over) => { const r = await h.put("/api/admin/pricing", { rules: over, note: "r5" }, owner); assert.strictEqual(r.status, 200, r.text); };
  const offshoreZip = (zip) => { const st = us.statesOfZip(String(zip).replace(/[^\x20-\x7e]/g, "").trim()); return Boolean(st && st.some((x) => !us.isContiguous(x))); };

  // ── A ──
  console.log("\nA. instant checkout: an off-mainland ZIP code, written every way I could think of");
  const ZIPS = ["96813", "99501", "00901", "09012", "09901", "96910", "96799", "96950", "34002", "96201", "00802", "99950"];
  const DECOR = [(z) => z, (z) => `${z}-1234`, (z) => `${z} 1234`, (z) => `${z}1234`, (z) => ` ${z}`, (z) => `${z} `, (z) => `\t${z}`, (z) => `${z}-`, (z) => `${z}x`, (z) => `${z.slice(0, 1)} ${z.slice(1)}`, (z) => `+${z}`, (z) => `${z}.0`,
    (z) => z.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))), (z) => Number(z), (z) => [z], (z) => ({ zip: z }), (z) => `${z}​`, (z) => `${z},`, (z) => `US ${z}`, (z) => `${z}-0000`, (z) => `0${z}`, (z) => `${z}0`];
  const STATES = ["CA", "WA", "FL", "NY", "TX", "DE", "ca", "California", "Calif.", ["CA"], { code: "CA" }, "", "HI", "AK", "PR", "XX", "C A"];
  const COUNTRIES = ["US", "USA", "U.S.", "us", "United States of America", "United States", "", undefined, null, "U.S.A.", " US ", ["US"], "America", "PR", "GU", "VI", "UM", "CA", "MX", "DE"];
  let q = await cubeQuote();
  let tried = 0; const sold = []; const answers = {};
  const attempt = async (label, body) => {
    tried++;
    const c = await checkout(q.quoteId, body);
    const key = c.status === 200 ? "200 SOLD" : `${c.status} ${c.body && c.body.code}`;
    answers[key] = (answers[key] || 0) + 1;
    if (c.status === 200) {
      const o = ordersDB.getById(c.body.orderId);
      if (o.shippingMethod !== "pickup" && (offshoreZip(o.shippingZip) || !us.isContiguous(us.stateCode(o.shippingState) || "") || (o.shippingCountry || "US") !== "US")) sold.push(`${label} → order to "${o.shippingCity}, ${o.shippingState} ${o.shippingZip} ${o.shippingCountry}" shipping $${o.shippingCost}`);
      q = await cubeQuote(); // that quote is ordered now
    }
  };
  for (const z of ZIPS) for (const [i, d] of DECOR.entries()) await attempt(`ZIP ${z} written as form ${i} ${JSON.stringify(d(z))}, state CA`, { shippingState: "CA", shippingCity: "Somewhere", shippingZip: d(z) });
  for (const z of ZIPS) for (const st of STATES) await attempt(`ZIP ${z}, state ${JSON.stringify(st)}`, { shippingState: st, shippingCity: "Somewhere", shippingZip: z });
  for (const z of ZIPS.slice(0, 6)) for (const co of COUNTRIES) await attempt(`ZIP ${z}, state CA, country ${JSON.stringify(co)}`, { shippingState: "CA", shippingCity: "Somewhere", shippingZip: z, shippingCountry: co });
  // a mainland ZIP code with a country or state that is not the mainland
  for (const co of ["PR", "GU", "VI", "CA", "MX", "DE", "GB"]) await attempt(`mainland ZIP 43215, state OH, country ${co}`, { shippingCountry: co });
  for (const st of ["HI", "AK", "PR", "GU", "AE", "AP", "AA", "VI", "AS", "MP", "Hawaii", "alaska"]) await attempt(`mainland ZIP 43215, state ${st}`, { shippingState: st });
  // a foreign postcode with country US
  for (const zip of ["M5V 2T6", "SW1A 1AA", "20095 Hamburg", "D-20095", "75008"]) await attempt(`postcode "${zip}", state NY, country US`, { shippingState: "NY", shippingZip: zip });
  R.check(sold.length === 0, `none of ${tried} checkouts to an address off the mainland (by ZIP code, state or country) was sold at a parcel price`, sold.length ? sold.slice(0, 6).join(" || ") : Object.entries(answers).map(([k, n]) => `${k}: ${n}`).join(", "));

  console.log("\n   honest mainland addresses, written the ways people write them");
  const HONEST = [
    ["OH / 43215 as the page sends it", {}], ["'D.C.' 20001", { shippingState: "D.C.", shippingCity: "Washington", shippingZip: "20001" }], ["'Washington DC' 20001", { shippingState: "Washington DC", shippingCity: "Washington", shippingZip: "20001" }],
    ["'Ill.' 60601", { shippingState: "Ill.", shippingCity: "Chicago", shippingZip: "60601" }], ["'N.Y.' 12207", { shippingState: "N.Y.", shippingCity: "Albany", shippingZip: "12207" }],
    ["'ohio' lower case", { shippingState: "ohio" }], ["' OH ' padded", { shippingState: " OH " }], ["ZIP+4", { shippingZip: "43215-1234" }], ["ZIP with a space after", { shippingZip: "43215 " }], ["nine digits, no hyphen", { shippingZip: "432151234" }],
    ["country 'USA'", { shippingCountry: "USA" }], ["country 'United States'", { shippingCountry: "United States" }], ["country left out", { shippingCountry: undefined }],
    ["owner's own town: Wauconda IL 60084", { shippingState: "IL", shippingCity: "Wauconda", shippingZip: "60084" }], ["'Illinois' 60084", { shippingState: "Illinois", shippingCity: "Wauconda", shippingZip: "60084" }],
    ["'N. Carolina' 27601", { shippingState: "N. Carolina", shippingCity: "Raleigh", shippingZip: "27601" }], ["'West Va.' 25301", { shippingState: "West Va.", shippingCity: "Charleston", shippingZip: "25301" }],
    ["'Mass' 02108", { shippingState: "Mass", shippingCity: "Boston", shippingZip: "02108" }], ["'Pa.' 19104", { shippingState: "Pa.", shippingCity: "Philadelphia", shippingZip: "19104" }], ["'New-York' 10001", { shippingState: "New-York", shippingCity: "New York", shippingZip: "10001" }],
    ["'NYC' 10001", { shippingState: "NYC", shippingCity: "New York", shippingZip: "10001" }], ["'Washington, D.C.' 20001", { shippingState: "Washington, D.C.", shippingCity: "Washington", shippingZip: "20001" }], ["'District of Columbia' 20001", { shippingState: "District of Columbia", shippingCity: "Washington", shippingZip: "20001" }],
    ["Texarkana TX 75501", { shippingState: "TX", shippingCity: "Texarkana", shippingZip: "75501" }], ["Texarkana AR 71854", { shippingState: "AR", shippingCity: "Texarkana", shippingZip: "71854" }],
  ];
  const turnedAway = []; let accepted = 0; let shipWrong = 0;
  for (const [label, body] of HONEST) {
    const c = await checkout(q.quoteId, body);
    if (c.status === 200) { accepted++; const o = ordersDB.getById(c.body.orderId); if (Math.abs(o.total - q.orderTotal) > 0.001) shipWrong++; q = await cubeQuote(); } else turnedAway.push(`${label}: ${c.status} ${c.body.code}`);
  }
  R.info(`honest mainland addresses accepted at the quoted total: ${accepted} of ${HONEST.length}`, turnedAway.length ? `turned away: ${turnedAway.join(" | ")}` : "none turned away");
  R.check(shipWrong === 0, "every accepted honest address was charged exactly the quoted total (no shipping price moved)", `${shipWrong} differ`);
  const four = HONEST.slice(1, 5).map(([l]) => l).filter((l) => !turnedAway.some((t) => t.startsWith(l)));
  R.check(four.length === 4, "the four spellings the earlier review found refused are accepted (4 of 4)", `${four.length} of 4`);

  // ── B ──
  console.log("\nB. the other ways an address reaches an order");
  {
    const c1 = await checkout(q.quoteId, {});
    const before = ordersDB.getById(c1.body.orderId);
    const c2 = await checkout(q.quoteId, { shippingState: "CA", shippingCity: "Honolulu", shippingZip: "96813" });
    const after = ordersDB.getById(c1.body.orderId);
    R.check(c1.status === 200 && c2.status !== 200 && after.shippingZip === before.shippingZip && after.shippingCity === before.shippingCity, "an order made for Columbus cannot have its address changed to Honolulu-under-CA by checking the same quote out again", `second checkout ${c2.status} ${c2.body.code}; order still ${after.shippingCity} ${after.shippingState} ${after.shippingZip}`);
    const c3 = await checkout(q.quoteId, { shippingState: "IN", shippingCity: "Columbus" });
    R.check(c3.status === 400 && c3.body.code === "address-mismatch", "…nor to a state that is not the ZIP code's", `${c3.status} ${c3.body.code}`);
    // pay it, then reorder and try the reordered quote to Hawaii
    await h.completed(String(c1.body.sessionUrl).split("/").pop());
    const ro = await h.post(`/api/orders/${c1.body.orderId}/reorder`, {}, buyer);
    const rq = ro.body && (ro.body.quoteId || (ro.body.quote && ro.body.quote.id));
    if (ro.status === 200 && rq) {
      const c4 = await checkout(rq, { shippingState: "CA", shippingCity: "Honolulu", shippingZip: "96813" });
      R.check(c4.status !== 200, "a reorder checked out to Honolulu-under-CA is refused the same way", `${c4.status} ${c4.body.code}`);
    } else R.info("reorder did not hand back a quote id in this run", `${ro.status} ${String(ro.text).slice(0, 120)}`);
    q = await cubeQuote();
  }
  {
    // The owner's phone order.
    const phone = async (body) => { const pq = await cubeQuote(2, owner); return h.post("/api/orders", { quoteId: pq.quoteId, customerEmail: "phone@buyer.test", customerName: "Phone Buyer", shippingName: "Phone Buyer", shippingAddress: "1 Main St", shippingCity: "Chicago", shippingCost: 12, ...body }, owner); };
    const rows = [];
    for (const [label, body] of [["IL + 60601", { shippingState: "IL", shippingZip: "60601" }], ["IL + 43215 (a slip)", { shippingState: "IL", shippingZip: "43215" }], ["state only, no ZIP code yet", { shippingState: "IL" }], ["ZIP code only", { shippingZip: "60601" }], ["nothing (address to follow)", {}], ["Honolulu HI 96813", { shippingState: "HI", shippingZip: "96813", shippingCity: "Honolulu" }], ["Toronto ON M5V 2T6, country CA", { shippingState: "ON", shippingZip: "M5V 2T6", shippingCountry: "CA" }]]) {
      const r = await phone(body);
      rows.push(`${label}: ${r.status}${r.body && r.body.code ? ` ${r.body.code}` : ""}`);
    }
    R.info("the owner's phone-order route (new: state held against ZIP code)", rows.join(" | "));
  }

  // ── D ──
  console.log("\nD. the firm quote");
  const COLUMBUS = { shippingName: "Firm Buyer", shippingAddress: "1 Test St", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" };
  const linkFor = (email) => { const mail = [...h.sent].reverse().find((m) => m.to === email && /firm-quote\//.test(m.text || "")); return (mail.text.match(/firm-quote\/([A-Za-z0-9._~-]+)/) || [])[1]; };
  let seq = 0;
  const firmQuote = async (total, shipTo = COLUMBUS) => {
    const email = `firm-${++seq}@buyer.test`;
    const who = await h.register(email, "Firm Buyer");
    const part = await h.uploadCube();
    const fq = await h.post("/api/quote", { parts: [h.cncConfig(part, 2)], leadTimeSlug: "standard" }, who);
    const r = await h.form("/api/rfq", { quoteId: fq.body.quoteId, contactName: "Firm Buyer", email, notes: "please quote", ...(shipTo || {}) }, {}, who);
    assert.strictEqual(r.status, 201, r.text);
    const sent = await h.put(`/api/rfq/admin/${r.body.rfqId}`, { quotedTotal: total, quotedLeadDays: 7, status: "quoted" }, owner);
    assert.strictEqual(sent.status, 200, sent.text);
    return { rfqId: r.body.rfqId, token: linkFor(email), who, part, email };
  };
  const accept = (token, json) => h.raw("POST", `/api/rfq/quote/${token}/accept`, { json });
  const ordersOf = (rfqId) => ordersDB.query((o) => o.rfqId === rfqId);

  {
    // Which re-typings of the SAME address are taken, and which changes are caught.
    const SAME = [["exactly as priced", {}], ["capitals", { shippingAddress: "1 TEST ST", shippingCity: "COLUMBUS" }], ["a full stop: '1 Test St.'", { shippingAddress: "1 Test St." }], ["extra spaces", { shippingAddress: " 1  Test   St ", shippingCity: " Columbus " }],
      ["ZIP+4", { shippingZip: "43215-1234" }], ["nine digits, no hyphen", { shippingZip: "432151234" }], ["state by name", { shippingState: "Ohio" }], ["'Street' for 'St'", { shippingAddress: "1 Test Street" }], ["a comma: '1 Test St,'", { shippingAddress: "1 Test St," }],
      ["country 'USA'", { shippingCountry: "USA" }], ["another name on the box only", { shippingName: "Receiving Dock" }]];
    const CHANGED = [["the street number", { shippingAddress: "2 Test St" }], ["a suite added", { shippingAddress: "1 Test St Ste 400" }], ["the city only", { shippingCity: "Grandview Heights" }], ["another ZIP code in the same state", { shippingZip: "45202", shippingCity: "Cincinnati" }],
      ["another state and ZIP code", { shippingState: "CA", shippingZip: "94105", shippingCity: "San Francisco" }], ["Hawaii", { shippingState: "HI", shippingZip: "96813", shippingCity: "Honolulu" }], ["Hawaii under OH", { shippingState: "OH", shippingZip: "96813", shippingCity: "Honolulu" }],
      ["Germany", { shippingCountry: "DE", shippingState: "HH", shippingZip: "20095", shippingCity: "Hamburg" }], ["Canada", { shippingCountry: "CA", shippingState: "ON", shippingZip: "M5V 2T6", shippingCity: "Toronto" }],
      ["Hamburg in the street line, the rest as priced", { shippingAddress: "1 Test St, c/o Spedition, Jungfernstieg 1, 20095 Hamburg GERMANY" }]];
    const same = []; const sameBounced = [];
    for (const [label, over] of SAME) { const f = await firmQuote(480); const a = await accept(f.token, { method: "po", poNumber: "PO-1", ...COLUMBUS, ...over, seenTotal: 480 }); (a.status === 201 ? same : sameBounced).push(`${label}${a.status === 201 ? "" : `: ${a.status} ${a.body.code}`}`); }
    R.info(`the same address typed again at acceptance: accepted ${same.length} of ${SAME.length}`, sameBounced.length ? `sent back to the owner (too strict, costs a round trip, no money): ${sameBounced.join(" | ")}` : "all accepted");
    const caught = []; const through = [];
    for (const [label, over] of CHANGED) { const f = await firmQuote(480); const a = await accept(f.token, { method: "po", poNumber: "PO-1", ...COLUMBUS, ...over, seenTotal: 480 }); const made = ordersOf(f.rfqId).length; (made === 0 && a.status !== 201 ? caught : through).push(`${label}: ${a.status} ${a.body.code || ""}`); }
    R.check(through.length === 0, `a different address at acceptance makes no order at the quoted total (${caught.length} of ${CHANGED.length} caught)`, through.length ? `ACCEPTED: ${through.join(" | ")}` : caught.join(" | "));
  }
  {
    // Card and purchase order at the same moment, with different addresses.
    const f = await firmQuote(480);
    const [a, b] = await Promise.all([accept(f.token, { method: "card", ...COLUMBUS, shippingState: "HI", shippingZip: "96813", shippingCity: "Honolulu", seenTotal: 480 }), accept(f.token, { method: "po", poNumber: "PO-2", shippingName: "Firm Buyer", seenTotal: 480 })]);
    const made = ordersOf(f.rfqId);
    const okOne = made.length <= 1 && made.every((o) => o.shippingCity === "Columbus" && Math.round(o.total * 100) === 48000);
    R.check(okOne, "card-to-Honolulu and PO-to-the-priced-address at the same moment: at most one order, and only to the priced address at $480", `card ${a.status} ${a.body.code || ""}, PO ${b.status} ${b.body.code || ""}; orders ${made.length}${made[0] ? ` → ${made[0].shippingCity} $${made[0].total}` : ""}`);
    const [c, d] = await Promise.all([accept(f.token, { method: "card", ...COLUMBUS, shippingAddress: "9 Other Rd", seenTotal: 480 }), accept(f.token, { method: "po", poNumber: "PO-3", ...COLUMBUS, shippingAddress: "7 Third Ave", seenTotal: 480 })]);
    R.info("two different NEW addresses at the same moment on the same link", `card ${c.status} ${c.body.code || ""}, PO ${d.status} ${d.body.code || ""}; orders ${ordersOf(f.rfqId).length}; the request now reads "${rfqsDB.getById(f.rfqId).shippingAddress}"`);
  }
  {
    // Can a buyer keep the owner re-confirming? Each round needs the owner to press Send.
    const f = await firmQuote(480);
    h.sent.length = 0;
    let token = f.token; let rounds = 0; let ownerMails = 0; const closed = [];
    for (let i = 0; i < 5; i++) {
      const a = await accept(token, { method: "po", poNumber: "PO-L", ...COLUMBUS, shippingAddress: `${10 + i} Loop Rd`, seenTotal: 480 });
      if (a.status !== 409 || a.body.code !== "address-reconfirm") break;
      rounds++;
      // with the link he holds, before the owner acts: five more tries with five more addresses
      let extra = 0;
      for (let k = 0; k < 5; k++) { const again = await accept(token, { method: "po", poNumber: "PO-L", ...COLUMBUS, shippingAddress: `${100 + i * 10 + k} Loop Rd`, seenTotal: 480 }); if (again.status === 409 && again.body.code === "address-reconfirm") extra++; }
      closed.push(extra);
      await h.put(`/api/rfq/admin/${f.rfqId}`, { quotedTotal: 480, quotedLeadDays: 7, status: "quoted" }, owner);
      token = linkFor(f.email);
    }
    ownerMails = h.sent.filter((m) => m.to === "owner@shop.test" && /re-confirm the price/.test(m.subject)).length;
    const row = rfqsDB.getById(f.rfqId);
    R.check(ownerMails === rounds, "the owner is emailed once per round, not once per try: the link the buyer holds is closed until the owner sends again", `${rounds} rounds, ${ownerMails} emails to the owner, ${rounds * 5} further tries on closed links; the request ended at "${row.shippingAddress}"`);
    R.info("nothing stops round after round, but each needs the owner to press Send, and no order is made", `${rounds} of 5 rounds went back to the owner`);
  }
  {
    // A request with no address: back to the owner once, then?
    const f = await firmQuote(300, null);
    const first = await accept(f.token, { method: "po", poNumber: "PO-N", ...COLUMBUS, seenTotal: 300 });
    const stale = await accept(f.token, { method: "po", poNumber: "PO-N", ...COLUMBUS, seenTotal: 300 });
    await h.put(`/api/rfq/admin/${f.rfqId}`, { quotedTotal: 300, quotedLeadDays: 7, status: "quoted" }, owner);
    const other = await accept(linkFor(f.email), { method: "po", poNumber: "PO-N", ...COLUMBUS, shippingAddress: "5 Elsewhere", seenTotal: 300 });
    await h.put(`/api/rfq/admin/${f.rfqId}`, { quotedTotal: 300, quotedLeadDays: 7, status: "quoted" }, owner);
    const done = await accept(linkFor(f.email), { method: "po", poNumber: "PO-N", shippingName: "Firm Buyer", seenTotal: 300 });
    R.check(first.status === 409 && stale.status === 409 && other.status === 409 && done.status === 201 && ordersOf(f.rfqId).length === 1 && ordersOf(f.rfqId)[0].shippingAddress === "5 Elsewhere", "a request with no address: goes back once; the same link is then closed; after the owner sends, another address goes back again; the address the owner last confirmed is the one accepted", `${first.status} ${first.body.code}; ${stale.status} ${stale.body.code}; ${other.status} ${other.body.code}; ${done.status}`);
    const none = await firmQuote(300, null);
    const empty = await accept(none.token, { method: "po", poNumber: "PO-E", shippingName: "Firm Buyer", seenTotal: 300 });
    R.check(empty.status === 400 && ordersOf(none.rfqId).length === 0, "a request with no address accepted with no address: refused, no order", `${empty.status} ${empty.body.code}`);
  }
  {
    // Pickup both ways.
    await settings({ shippingLocalPickup: "on" });
    const a = await firmQuote(480);
    const ra = await accept(a.token, { method: "po", poNumber: "PO-P1", shippingOption: "pickup", shippingName: "Firm Buyer", seenTotal: 480 });
    const b = await firmQuote(480, { shippingOption: "pickup", shippingName: "Firm Buyer" });
    const rb = await accept(b.token, { method: "po", poNumber: "PO-P2", ...COLUMBUS, seenTotal: 480 });
    const c = await firmQuote(480, { shippingOption: "pickup", shippingName: "Firm Buyer" });
    const rc = await accept(c.token, { method: "po", poNumber: "PO-P3", shippingName: "Firm Buyer", seenTotal: 480 });
    R.check(ra.status === 201 && rb.status === 409 && ordersOf(b.rfqId).length === 0 && rc.status === 201, "priced for delivery, collected: accepted. Priced for pickup, then shipped: back to the owner. Priced for pickup, accepted with only a name: accepted", `${ra.status}; ${rb.status} ${rb.body.code}; ${rc.status} ${rc.body.code || ""} (method ${ordersOf(c.rfqId)[0] && ordersOf(c.rfqId)[0].shippingMethod})`);
    await settings({ shippingLocalPickup: "off" });
    const d = await firmQuote(480, { shippingOption: "pickup", shippingName: "Firm Buyer" }).catch((e) => e);
    R.info("a request that asks for pickup while pickup is switched off", d instanceof Error ? String(d.message).slice(0, 160) : "taken");
    const e = await accept(c.token, { method: "po", poNumber: "PO-P3", shippingName: "Firm Buyer", seenTotal: 480 });
    R.info("(repeat of an accepted pickup quote after pickup is switched off)", `${e.status} ${e.body.code || e.body.status || ""}`);
  }
  {
    // What the owner is shown when the address fields carry HTML, header and control characters.
    const email = "inject@buyer.test";
    const who = await h.register(email, "Inject Buyer");
    const part = await h.uploadCube();
    const fq = await h.post("/api/quote", { parts: [h.cncConfig(part, 2)], leadTimeSlug: "standard" }, who);
    const HOSTILE = { shippingName: "<img src=x onerror=alert(1)>", shippingAddress: "1 <script>alert(2)</script> St \"><b>bold", shippingCity: "Columbus</td><td>x", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" };
    h.sent.length = 0;
    const r = await h.form("/api/rfq", { quoteId: fq.body.quoteId, contactName: "Inject Buyer", email, ...HOSTILE }, {}, who);
    const shop = h.sent.find((m) => m.to === "owner@shop.test");
    const raw = shop ? String(shop.html || "") : "";
    R.check(r.status === 201 ? Boolean(shop) && !/<img src=x|<script>alert|<b>bold|<\/td><td>x/.test(raw) : true, "HTML typed into the address fields is not live markup in the owner's email", r.status === 201 ? `request ${r.status}; in the email as: ${(raw.match(/Ship finished parts to[\s\S]{0,260}/) || [""])[0].replace(/\s+/g, " ").slice(0, 230)}` : `the request was refused: ${r.status} ${r.body.code}`);
    R.check(!shop || !/[<>\r\n]/.test(shop.subject), "nothing the buyer typed is in the subject line", shop ? shop.subject : "");
    const ctl = [];
    for (const [label, field, value] of [["a line break in the street", "shippingAddress", "1 Test St\r\nBcc: evil@example.com"], ["a line break in the name", "shippingName", "Firm\nBuyer"], ["a NUL in the city", "shippingCity", "Colum\u0000bus"], ["a tab in the ZIP code", "shippingZip", "43215\t"], ["a right-to-left override in the street", "shippingAddress", "1 Test ‮St"], ["2,000 characters of street", "shippingAddress", "9".repeat(2000)]]) {
      const x = await h.form("/api/rfq", { quoteId: fq.body.quoteId, contactName: "Inject Buyer", email, ...COLUMBUS, [field]: value }, {}, who);
      ctl.push(`${label}: ${x.status}${x.body && x.body.code ? ` ${x.body.code}` : ""}`);
    }
    R.info("control characters and over-long fields on the request form", ctl.join(" | "));
    if (r.status === 201) {
      await h.put(`/api/rfq/admin/${r.body.rfqId}`, { quotedTotal: 200, quotedLeadDays: 7, status: "quoted" }, owner);
      const buyerMail = [...h.sent].reverse().find((m) => m.to === email && /firm-quote\//.test(m.text || ""));
      R.check(!/<img src=x|<script>alert/.test(String(buyerMail.html || "")), "…nor in the quote email to the buyer");
      h.sent.length = 0;
      const a = await accept(linkFor(email), { method: "po", poNumber: "PO-X", shippingName: "x", shippingAddress: "2 <svg onload=alert(3)> Rd", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", seenTotal: 200 });
      const changed = h.sent.find((m) => m.to === "owner@shop.test" && /re-confirm/.test(m.subject));
      R.check(a.status === 409 && Boolean(changed) && !/<svg onload|<img src=x|<script>alert/.test(String(changed.html || "")), "…nor in the 'address changed' email (both the new and the old address are in it)", `${a.status} ${a.body.code}`);
      const listed = (await h.get("/api/rfq/admin/list", owner)).body.find((x) => x.id === r.body.rfqId);
      R.info("the admin queue gets the address as JSON text (the page prints it as text)", `shipToLine: ${String(listed.shipToLine).slice(0, 90)}… | shipToPrevious: ${String(listed.shipToPrevious || "").slice(0, 60)}…`);
    }
  }

  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
