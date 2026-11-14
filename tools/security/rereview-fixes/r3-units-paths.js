#!/usr/bin/env node
/**
 * Second re-review (2026-11-13), F-01 and F-13 on the paths the author's units-race-stress.js does not take.
 *
 *   node tools/security/rereview-fixes/r3-units-paths.js [rounds=20]
 *
 * In-process harness, Stripe stand-in. A 20 x 20 plate drawn in inches is priced as MILLIMETRES (the small
 * price), then its units are set to inches (25.4 times larger). The author says that for a second or
 * two (up to about 25 s under load) the saved quote still shows the small price but "cannot be ordered
 * or sent as a request at that price".
 *
 *   1. The stale window, every door. Straight after the units answer, without waiting for the saved
 *      quote to be priced again: pay with the old total confirmed; pay with no total; send it as a
 *      firm-quote request; the owner takes it as a phone order; the owner takes it with the old total.
 *      `rounds` times each. Nothing may be made at the small price.
 *   2. A visitor's part ordered by an account. The visitor (who holds the part's edit key) changes the
 *      units while the account presses pay, `rounds` x 2 times with a sweeping gap. Every order made
 *      must be for the part as it is stored.
 *   3. After the order: the visitor's key, the buyer and a second account all try to change the units.
 *   4. A paid order reordered: the new quote prices the stored part, and the part is still locked.
 */
const assert = require("assert");
const { liftPacing, report, SHIP } = require("../rereview-relaunch/lib");
const { start } = require("../../../server/testSupport/harness");
const quoteIntegrity = require("../../../server/services/quoteIntegrity");

const ROUNDS = Number(process.argv[2]) || 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function plate(w, h, holes) {
  const out = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1015", "9", "$INSUNITS", "70", "1", "9", "$MEASUREMENT", "70", "0", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
    "0", "LWPOLYLINE", "8", "0", "90", "4", "70", "1", "10", "0", "20", "0", "10", String(w), "20", "0", "10", String(w), "20", String(h), "10", "0", "20", String(h)];
  const cols = Math.ceil(Math.sqrt(holes));
  for (let i = 0; i < holes; i++) out.push("0", "CIRCLE", "8", "0", "10", (0.5 + (i % cols) * ((w - 1) / cols)).toFixed(4), "20", (0.5 + Math.floor(i / cols) * ((h - 1) / cols)).toFixed(4), "40", "0.05");
  out.push("0", "ENDSEC", "0", "EOF");
  return Buffer.from(out.join("\n") + "\n");
}

(async () => {
  liftPacing();
  for (const k of ["UPLOAD_MAX_PARTS_PER_15MIN", "ORDERS_UNPAID_PER_ACCOUNT", "ORDERS_UNPAID_PER_CLIENT", "ORDERS_UNPAID_NEW_PER_ACCOUNT_DAY", "ORDERS_UNPAID_NEW_PER_CLIENT_DAY", "UNITS_CHANGES_PER_CLIENT_10MIN"]) process.env[k] = "100000";
  const h = await start();
  const R = report();
  const { ordersDB, orderItemsDB, partsDB, rfqsDB, materialsDB, quotesDB } = h.models;
  const owner = await h.admin("Owner");
  const buyer = await h.register("units@buyer.test", "Units Buyer");
  const other = await h.register("other@buyer.test", "Other Buyer");
  const m = materialsDB.getAll().find((x) => x.slug === "rt-acrylic");
  let seq = 0;
  /** A plate priced as millimetres on a draft of `token` (or of nobody). */
  async function smallQuote(token, holes = 60) {
    const up = await h.form("/api/upload", {}, { files: { name: `plate-${seq++}.dxf`, data: plate(20, 20, holes) } }, token);
    assert.ok(up.status === 200 && up.body.parts.length, up.text);
    const partId = up.body.parts[0].partId;
    const key = h.editKeys[partId];
    const cfg = { partId, materialSlug: "rt-acrylic", grade: m.grades[0].name, finishSlug: "", quantity: 2, process: "routing", thicknessMm: 25.4 };
    const setUnits = (units, as = token, withKey = true) => h.raw("POST", `/api/parts/${partId}/units`, { json: { units, ...(withKey ? { editKey: key } : {}) }, token: as, headers: { ...(withKey ? { "X-Part-Key": key } : {}), "X-Human-Token": h.humanToken } });
    const mm = await setUnits("mm");
    assert.strictEqual(mm.status, 200, mm.text);
    const q = await h.post("/api/quote", { parts: [cfg], leadTimeSlug: "standard" }, token);
    assert.strictEqual(q.status, 200, q.text);
    const shown = (await h.get(`/api/quote/${q.body.quoteId}`, token)).body.checkout.options[0].total;
    return { partId, key, cfg, setUnits, quoteId: q.body.quoteId, small: q.body.orderTotal, shown };
  }
  const storedMatches = (orderId, partId) => {
    const part = partsDB.getById(partId);
    const item = orderItemsDB.query((i) => i.orderId === orderId)[0];
    const priced = (item.config && item.config.priced) || {};
    return { ok: priced.geometryHash === quoteIntegrity.geometryHash(part.geometry) && priced.partRev === (Number(part.geometryRev) || 0), pricedMm: priced.dimsMm && Math.round(priced.dimsMm.x), storedMm: Math.round((part.geometry.boundingBox || {}).width) };
  };

  // ── 1. The stale window ──
  console.log(`\n1. the saved quote still shows the small price: can anything be made at it? (${ROUNDS} rounds a door)`);
  const doors = {
    "pay, old total confirmed": (x) => h.post("/api/orders/checkout-session", { quoteId: x.quoteId, ...SHIP, confirmedTotal: x.shown }, buyer),
    "pay, no total sent": (x) => h.post("/api/orders/checkout-session", { quoteId: x.quoteId, ...SHIP }, buyer),
    "send as a firm-quote request": (x) => h.form("/api/rfq", { contactName: "Units Buyer", email: "units@buyer.test", quoteId: x.quoteId, notes: "stale" }, {}, buyer),
    "owner's phone order": (x) => h.post("/api/orders", { quoteId: x.quoteId, ...SHIP }, owner),
    "owner's phone order, old total confirmed": (x) => h.post("/api/orders", { quoteId: x.quoteId, ...SHIP, confirmedTotal: x.small }, owner),
  };
  for (const [door, go] of Object.entries(doors)) {
    let madeAtSmall = 0, made = 0, refused = 0, staleSeen = 0; const codes = {}; const bad = [];
    for (let i = 0; i < ROUNDS; i++) {
      const x = await smallQuote(buyer, [40, 120, 300][i % 3]);
      const u = await x.setUnits("in");
      assert.strictEqual(u.status, 200, u.text);
      // The quote as stored at this instant: is it still the small price?
      const stored = quotesDB.getById(x.quoteId);
      if (Math.abs(stored.orderTotal - x.small) < 0.011) staleSeen++;
      const r = await go(x);
      codes[`${r.status}${r.body && r.body.code ? " " + r.body.code : ""}`] = (codes[`${r.status}${r.body && r.body.code ? " " + r.body.code : ""}`] || 0) + 1;
      if (r.status >= 400) { refused++; continue; }
      made++;
      const order = r.body.orderId ? ordersDB.getById(r.body.orderId) : null;
      const rfq = r.body.rfqId ? rfqsDB.getById(r.body.rfqId) : null;
      const amount = order ? order.subtotal : rfq ? rfq.budgetTotal : null;
      // "At the small price": within 20 % of the millimetre total (the inch price is several times it).
      if (amount !== null && amount < x.small * 1.2) { madeAtSmall++; bad.push(`${order ? "order" : "request"} at $${amount}; millimetre price was $${x.small}`); }
      else if (order) { const s = storedMatches(order.id, x.partId); if (!s.ok) { madeAtSmall++; bad.push(`order made from ${s.pricedMm} mm, the part is ${s.storedMm} mm`); } }
    }
    R.check(madeAtSmall === 0, `${door}: nothing made at the small price`, `${ROUNDS} rounds; the stored quote still showed the small price at that instant in ${staleSeen}; refused ${refused}, made ${made} (at today's price); answers ${JSON.stringify(codes)}${bad.length ? " :: " + bad.slice(0, 3).join(" | ") : ""}`);
  }

  // ── 2. A visitor's part, ordered by an account, units flipped by the visitor's key in the gap ──
  console.log(`\n2. a visitor's part: the visitor's key changes the units while an account presses pay (${ROUNDS * 2} rounds)`);
  {
    const tally = { orders: 0, refused: 0, unitsApplied: 0, unitsRefused: 0, mismatched: 0 }; const bad = [];
    for (let i = 0; i < ROUNDS * 2; i++) {
      const x = await smallQuote(undefined, [50, 200, 600][i % 3]); // uploaded and quoted with no account
      const t0 = Date.now(); const probe = await x.setUnits("mm", undefined); const readMs = Date.now() - t0; assert.ok(probe.status === 200, probe.text);
      const gap = Math.round(((i * 7) % 11) / 10 * (readMs * 1.6 + 6));
      const pay = () => h.post("/api/orders/checkout-session", { quoteId: x.quoteId, ...SHIP, confirmedTotal: x.shown }, buyer);
      let u, c;
      if (i % 2 === 0) { const p = x.setUnits("in", undefined); await sleep(gap); c = await pay(); u = await p; }
      else { const p = pay(); await sleep(Math.min(gap, 6)); u = await x.setUnits("in", undefined); c = await p; }
      if (u.status === 200) tally.unitsApplied++; else tally.unitsRefused++;
      if (c.status !== 200) { tally.refused++; if (orderItemsDB.query((it) => it.partId === x.partId).length) { tally.mismatched++; bad.push(`#${i}: refused ${c.status} and a line exists`); } continue; }
      tally.orders++;
      const s = storedMatches(c.body.orderId, x.partId);
      if (!s.ok) { tally.mismatched++; bad.push(`#${i} gap ${gap} of ${readMs} ms: order priced from ${s.pricedMm} mm, the stored part is ${s.storedMm} mm; units answer ${u.status}`); }
    }
    R.check(tally.mismatched === 0, "every order made is for the part as it is stored", `${JSON.stringify(tally)}${bad.length ? " :: " + bad.slice(0, 4).join(" | ") : ""}`);
  }

  // ── 3. After the order ──
  console.log("\n3. after the order exists: who can still change the units?");
  {
    const x = await smallQuote(undefined);
    const c = await h.post("/api/orders/checkout-session", { quoteId: x.quoteId, ...SHIP, confirmedTotal: x.shown }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    const tries = [["the visitor, with the part's key", undefined, true], ["the buyer, with the key", buyer, true], ["the buyer, without the key", buyer, false], ["another account, with the key", other, true], ["the owner", owner, true]];
    const out = [];
    for (const [who, token, withKey] of tries) { const r = await x.setUnits("in", token, withKey); out.push(`${who}: ${r.status}${r.body && r.body.code ? " " + r.body.code : ""}`); }
    R.check(out.every((o) => !/: 200/.test(o)) && storedMatches(c.body.orderId, x.partId).ok, "nobody can change the units of a part that is on an order (unpaid)", out.join(" | "));
    await h.completed(String(c.body.sessionUrl).split("/").pop());
    const paid = ordersDB.getById(c.body.orderId);
    const again = await x.setUnits("in", buyer, true);
    R.check(paid.status === "paid" && !paid.attention && again.status >= 400, "…nor once it is paid; the paid order carries no 'part changed' flag", `order ${paid.status}, flag ${paid.attention || "none"}; units → ${again.status}`);
    // ── 4. Reorder ──
    const ro = await h.post(`/api/orders/${paid.id}/reorder`, {}, buyer);
    const nq = ro.status === 201 ? quotesDB.getById(ro.body.quoteId) : null;
    const after = await x.setUnits("in", buyer, true);
    R.check(ro.status === 201 && nq && Math.abs(nq.subtotal - paid.subtotal) < 0.011 && after.status >= 400, "a reorder prices the stored part at the same figure, and the part stays locked", `reorder ${ro.status}; new quote parts $${nq && nq.subtotal}, paid $${paid.subtotal}; units → ${after.status}`);
  }

  const f = R.done();
  await h.stop();
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
