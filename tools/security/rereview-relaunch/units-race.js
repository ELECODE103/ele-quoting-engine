/**
 * DXF units changed WHILE the order is being made (re-review 2026-11-12).
 *
 *   node tools/security/rereview-relaunch/units-race.js
 *
 * The units route checks "is this part on an order?" and then waits for the file to be read again in
 * a worker before it replaces the stored geometry. A checkout that lands in that wait makes the order
 * from the old (small) geometry; the route then swaps in the new (25.4x larger) geometry under it.
 * Prints the price paid, the price of what the shop is now holding, and what the traveler says.
 * Exit code 1 when the stored part of a paid order is not the part that was priced.
 */
const { liftPacing, report, SHIP } = require("./lib");
const { start } = require("../../../server/testSupport/harness");

/** A plate with a grid of holes, drawn in inches. More holes = a longer read = a wider window. */
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

(async () => {
  liftPacing();
  const h = await start();
  const R = report();
  const { ordersDB, orderItemsDB, partsDB, materialsDB } = h.models;
  const owner = await h.admin("Owner");
  const buyer = await h.register("racer@buyer.test");
  const holes = Number(process.argv[2]) || 600;
  const up = await h.form("/api/upload", {}, { files: { name: "plate.dxf", data: plate(20, 20, holes) } }, buyer);
  if (up.status !== 200 || !up.body.parts.length) throw new Error(`upload: ${up.status} ${up.text.slice(0, 200)}`);
  const partId = up.body.parts[0].partId;
  const key = h.editKeys[partId];
  const slug = process.argv[4] || "rt-acrylic";
  const thicknessMm = Number(process.argv[5]) || 25.4;
  const m = materialsDB.getAll().find((x) => x.slug === slug);
  const cfg = { partId, materialSlug: slug, grade: m.grades[0].name, finishSlug: "", quantity: 2, process: "routing", thicknessMm };
  const quote = (extra = {}) => h.post("/api/quote", { parts: [cfg], leadTimeSlug: "standard", ...extra }, buyer);
  const setUnits = (units) => h.post(`/api/parts/${partId}/units`, { units, editKey: key }, buyer);

  // What the plate costs at each size.
  const asInch = await quote();
  if (asInch.status !== 200) throw new Error(`quote (in): ${asInch.status} ${asInch.text.slice(0, 200)}`);
  let t0 = Date.now();
  const toMm = await setUnits("mm");
  const readMs = Date.now() - t0;
  const asMm = await quote({ quoteId: asInch.body.quoteId });
  console.log(`a 20 x 20 plate with ${holes} holes: $${asInch.body.orderTotal} drawn in inches, $${asMm.body.orderTotal} read as millimetres (rfq: ${asInch.body.gate.requiresRfq}/${asMm.body.gate.requiresRfq}); a units change takes ${readMs} ms (${toMm.status})`);
  const shown = (await h.get(`/api/quote/${asMm.body.quoteId}`, buyer)).body.checkout.options[0].total;

  // The race: units → inches is sent, and the checkout for the millimetre price right behind it.
  const unitsReq = setUnits("in");
  await new Promise((r) => setTimeout(r, Number(process.argv[3]) || 15));
  const c = await h.post("/api/orders/checkout-session", { quoteId: asMm.body.quoteId, ...SHIP, confirmedTotal: shown }, buyer);
  const u = await unitsReq;
  console.log(`checkout answered ${c.status} ${c.body.code || ""}; units → in answered ${u.status} ${u.body.code || ""}`);
  if (c.status !== 200) { R.holds("the checkout was refused while the units change was in flight", `${c.status} ${c.body.code}`); R.done(); await h.stop(); return; }
  const order = ordersDB.getById(c.body.orderId);
  const session = h.stripe.sessions[String(c.body.sessionUrl).split("/").pop()];
  await h.completed(session.id);
  const paid = ordersDB.getById(order.id);
  const part = partsDB.getById(partId);
  const item = orderItemsDB.query((i) => i.orderId === order.id)[0];
  const bb = part.geometry.boundingBox || {};
  const traveler = (await h.get(`/api/orders/${order.id}/traveler`, owner)).body;
  const tItem = traveler.items && traveler.items[0];
  const pricedDims = (item.config.priced && item.config.priced.dimsMm) || {};
  console.log(`order ${paid.status}, paid ${paid.amountPaid}; priced as ${Math.round(pricedDims.x)} x ${Math.round(pricedDims.y)} mm; the stored part is now ${Math.round(bb.width)} x ${Math.round(bb.height)} mm`);
  console.log(`traveler: matchesPriced=${tItem && tItem.matchesPriced}; attention flag on the order: ${paid.attention || "none"}; shop emails mentioning a mismatch: ${h.sent.filter((x) => /owner@shop.test/.test(String(x.to)) && /match|units|changed/i.test(x.subject + x.text)).length}`);
  const swapped = u.status === 200 && Math.abs((Number(bb.width) || 0) - (Number(pricedDims.x) || 0)) > 1;
  if (swapped && paid.status === "paid") {
    R.finding("a PAID order's part was replaced after it was priced", `paid $${paid.amountPaid} (millimetre price); the same drawing in inches prices at $${asInch.body.orderTotal}; the order is '${paid.status}' with no flag; only the traveler's matchesPriced=${tItem && tItem.matchesPriced} says so`);
  } else R.holds("the units change did not replace the geometry under the order", `units answer ${u.status}, order ${paid.status}`);
  // And afterwards the lock holds (it is only the window that is open).
  const later = await setUnits("mm");
  R.check(later.status === 409, "once the order exists a NEW units request is refused", `${later.status} ${later.body.code || ""}`);
  const f = R.done();
  await h.stop();
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
