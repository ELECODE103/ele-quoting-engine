#!/usr/bin/env node
/**
 * F-01, worst case: the units of a drawing changed while its order (or its firm-quote request) is being
 * made, tried many times with the gap between the two requests swept across the whole window.
 *
 *   node tools/security/rereview-fixes/units-race-stress.js [attempts=200]
 *
 * The reviewer's units-race.js tries one gap per run. This one makes a new drawing per attempt (30 to
 * 600 holes, so the file read takes anything from a few ms to 150 ms), and for each sends
 *   A  units → inches, then the checkout for the millimetre price `gap` ms later   (gap 0 … the whole read)
 *   B  the checkout first, then units → inches `gap` ms later
 *   C  units → inches, then a firm-quote request for the millimetre quote `gap` ms later
 *   D  units → inches and units → millimetres together, then the checkout
 * and then checks, for every order and request that was made, the one thing that must hold:
 *
 *   the part as stored afterwards is the part that was priced
 *   (same revision, same measurement hash, same size; and for an order, the amount charged is what that part costs).
 *
 * Also checked in every attempt: a units change on a part that is only on a DRAFT still works and the
 * draft is priced again at the new size. Exit code 1 if any attempt breaks the rule.
 */
const { liftPacing, report, SHIP } = require("../rereview-relaunch/lib");
const { start } = require("../../../server/testSupport/harness");
const quoteIntegrity = require("../../../server/services/quoteIntegrity");

function plate(w, h, n) {
  const out = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "1", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
    "0", "LWPOLYLINE", "8", "0", "90", "4", "70", "1", "10", "0", "20", "0", "10", String(w), "20", "0", "10", String(w), "20", String(h), "10", "0", "20", String(h)];
  const cols = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const x = 0.5 + (i % cols) * ((w - 1) / cols), y = 0.5 + Math.floor(i / cols) * ((h - 1) / cols);
    out.push("0", "CIRCLE", "8", "0", "10", x.toFixed(4), "20", y.toFixed(4), "40", "0.05");
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return Buffer.from(out.join("\n") + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  liftPacing();
  process.env.UPLOAD_MAX_PARTS_PER_15MIN = "100000";
  process.env.ORDERS_UNPAID_PER_ACCOUNT = "100000"; // this script makes hundreds of unpaid orders on one account on purpose
  process.env.ORDERS_UNPAID_PER_CLIENT = "100000";
  process.env.UNITS_CHANGES_PER_CLIENT_10MIN = "100000";
  const ATTEMPTS = Number(process.argv[2]) || 200;
  const h = await start();
  const R = report();
  const { ordersDB, orderItemsDB, partsDB, rfqsDB, materialsDB, quotesDB } = h.models;
  await h.admin("Owner");
  const buyer = await h.register("stress@buyer.test");
  const m = materialsDB.getAll().find((x) => x.slug === "rt-acrylic");
  const tally = { A: 0, B: 0, C: 0, D: 0, orders: 0, requests: 0, unitsRefused: 0, unitsApplied: 0, checkoutRefused: 0, broken: 0, draftRepriced: 0 };
  const broken = [];
  const HOLES = [30, 50, 80, 120, 200, 300, 450, 600];

  for (let n = 0; n < ATTEMPTS; n++) {
    const variant = "ABCD"[n % 4];
    tally[variant]++;
    const holes = HOLES[Math.floor(n / 4) % HOLES.length];
    const up = await h.form("/api/upload", {}, { files: { name: `plate-${n}.dxf`, data: plate(20, 20, holes) } }, buyer);
    if (up.status !== 200 || !up.body.parts.length) throw new Error(`upload ${n}: ${up.status} ${up.text.slice(0, 200)}`);
    const partId = up.body.parts[0].partId;
    const key = h.editKeys[partId];
    const cfg = { partId, materialSlug: "rt-acrylic", grade: m.grades[0].name, finishSlug: "", quantity: 2, process: "routing", thicknessMm: 25.4 };
    const quote = (extra = {}) => h.post("/api/quote", { parts: [cfg], leadTimeSlug: "standard", ...extra }, buyer);
    const setUnits = (units) => h.post(`/api/parts/${partId}/units`, { units, editKey: key }, buyer);

    // A draft in inches, then the legitimate change to millimetres: it must work, and the draft must follow.
    const asInch = await quote();
    if (asInch.status !== 200) throw new Error(`quote ${n}: ${asInch.status} ${asInch.text.slice(0, 200)}`);
    const t0 = Date.now();
    const toMm = await setUnits("mm");
    const readMs = Date.now() - t0;
    if (toMm.status !== 200) { broken.push(`#${n}: a units change on a draft was refused (${toMm.status} ${toMm.body && toMm.body.code})`); tally.broken++; continue; }
    const asMm = await quote({ quoteId: asInch.body.quoteId });
    if (asMm.status !== 200 || !(asMm.body.orderTotal < asInch.body.orderTotal)) { broken.push(`#${n}: the draft was not priced again at the new size (${asMm.status}, $${asMm.body && asMm.body.orderTotal} against $${asInch.body.orderTotal})`); tally.broken++; continue; }
    tally.draftRepriced++;
    const shown = (await h.get(`/api/quote/${asMm.body.quoteId}`, buyer)).body.checkout.options[0].total;
    // The gap sweeps the whole window: 0 … a little past the time a units change takes.
    const gap = Math.round((((n >> 2) * 7 + n) % 11) / 10 * (readMs * 1.6 + 6));
    const checkout = () => h.post("/api/orders/checkout-session", { quoteId: asMm.body.quoteId, ...SHIP, confirmedTotal: shown }, buyer);
    const request = () => h.form("/api/rfq", { contactName: "Stress Buyer", email: "stress@buyer.test", quoteId: asMm.body.quoteId, notes: `attempt ${n}` }, {}, buyer);

    let c = null, rq = null, u = [];
    if (variant === "A") { const p = setUnits("in"); await sleep(gap); c = await checkout(); u = [await p]; }
    if (variant === "B") { const p = checkout(); await sleep(Math.min(gap, 8)); u = [await setUnits("in")]; c = await p; }
    if (variant === "C") { const p = setUnits("in"); await sleep(gap); rq = await request(); u = [await p]; }
    if (variant === "D") { const p1 = setUnits("in"); const p2 = setUnits("mm"); await sleep(gap); c = await checkout(); u = [await p1, await p2]; }
    for (const x of u) { if (x.status === 200) tally.unitsApplied++; else if (x.status === 409) tally.unitsRefused++; else if (x.status !== 429 && x.status !== 503) { broken.push(`#${n}${variant}: units answered ${x.status} ${x.text.slice(0, 120)}`); tally.broken++; } }

    const part = partsDB.getById(partId);
    const storedHash = quoteIntegrity.geometryHash(part.geometry);
    const bb = part.geometry.boundingBox || {};
    if (c) {
      if (c.status !== 200) {
        tally.checkoutRefused++;
        // A refused checkout made no order; that is a correct outcome (the buyer is shown the new price).
        if (orderItemsDB.query((i) => i.partId === partId).length) { broken.push(`#${n}${variant}: checkout answered ${c.status} and an order line exists`); tally.broken++; }
        continue;
      }
      tally.orders++;
      const order = ordersDB.getById(c.body.orderId);
      const items = orderItemsDB.query((i) => i.orderId === order.id);
      const priced = items[0].config.priced || {};
      const same = priced.geometryHash === storedHash && priced.partRev === (Number(part.geometryRev) || 0) && Math.abs((Number(bb.width) || 0) - priced.dimsMm.x) < 0.01;
      // What the stored part costs now, priced by the site itself for the same setup.
      const sid = String(c.body.sessionUrl).split("/").pop();
      await h.completed(sid);
      const paid = ordersDB.getById(order.id);
      const again = await h.post(`/api/orders/${order.id}/reorder`, {}, buyer);
      const today = again.status === 201 ? quotesDB.getById(again.body.quoteId) : null;
      const priceOk = today && Math.abs(Number(today.subtotal) - Number(paid.subtotal)) < 0.011;
      if (!same || paid.status !== "paid" || !priceOk || paid.attention) {
        tally.broken++;
        broken.push(`#${n}${variant} gap ${gap} ms of ${readMs}: order ${paid.status}, attention ${paid.attention || "none"}; priced ${Math.round(priced.dimsMm.x)} mm rev ${priced.partRev}, stored ${Math.round(bb.width)} mm rev ${part.geometryRev}; parts paid $${paid.subtotal}, the stored part prices at $${today ? today.subtotal : `? (${again.status})`}`);
      }
    }
    if (rq) {
      if (rq.status !== 201) { if (rfqsDB.query((r) => (r.parts || []).some((p) => p.partId === partId)).length) { broken.push(`#${n}C: the request answered ${rq.status} and a request exists`); tally.broken++; } continue; }
      tally.requests++;
      const rfq = rfqsDB.getById(rq.body.rfqId);
      const snap = (rfq.parts || []).find((p) => p.partId === partId) || {};
      const after = await setUnits("mm");
      // The request shows the size the part has now, and the part can no longer be changed.
      const dims = snap.dimsMm || snap.dimensions || null;
      const quoteRow = quotesDB.getById(asMm.body.quoteId);
      const pricedRev = quoteRow.config && quoteRow.config.integrity && quoteRow.config.integrity.lines[0].snapshot.partRev;
      if (after.status !== 409 || (pricedRev !== (Number(part.geometryRev) || 0) && !(quoteRow.config.integrity || {}).stale && u[0].status === 200)) {
        tally.broken++;
        broken.push(`#${n}C gap ${gap} ms of ${readMs}: units after the request ${after.status}; request made from revision ${pricedRev}, the part is at ${part.geometryRev}; units answer ${u[0].status}${dims ? `; ${JSON.stringify(dims)}` : ""}`);
      }
    }
    if ((n + 1) % 40 === 0) console.log(`  … ${n + 1} attempts: ${JSON.stringify(tally)}`);
  }
  console.log(JSON.stringify(tally));
  for (const b of broken.slice(0, 20)) console.log(`  BROKEN ${b}`);
  R.check(tally.broken === 0, `${ATTEMPTS} attempts: every order and request is for the part as it is stored`, `${tally.orders} orders paid and compared, ${tally.requests} requests, ${tally.checkoutRefused} checkouts refused with the new price, ${tally.unitsRefused} units changes refused (part-locked), ${tally.unitsApplied} applied`);
  R.check(tally.draftRepriced === ATTEMPTS, "a units change on a draft worked and the draft was priced again, every time", `${tally.draftRepriced} of ${ATTEMPTS}`);
  const f = R.done();
  await h.stop();
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
