/**
 * F-01  A DXF's units can be changed after its price is saved and before checkout.
 *
 * 1. upload a 40 x 30 plate drawn in inches (1016 x 762 mm)
 * 2. tell the server the drawing is in millimetres  -> the part becomes 40 x 30 mm
 * 3. price 20 pieces                                 -> a small-part price is saved on the quote
 * 4. tell the server the drawing is in inches again  -> the stored part is 1016 x 762 mm again
 * 5. check out the saved quote                       -> charged the small-part price
 * 6. pay; read the order as the shop sees it         -> the part on the paid order is the big one
 *
 * Run: node tools/security/review-payments/poc-01-dxf-units-swap.js
 */
const { start, report, money, SHIP } = require("./lib");
const { dxfPlate } = require("./fixtures");

(async () => {
  const h = await start();
  const r = report("F-01 DXF units changed between pricing and checkout");
  try {
    const config = (partId) => ({ partId, process: "routing", materialSlug: "rt-hdpe", thicknessMm: 19.1, quantity: 1 }); // (2026-11-13: one piece, was 20. Twenty of these pack to far over 50 lb, which now goes to a firm quote for its freight under every shipping rule, so the order this script needs could not be placed at all.)
    const size = (p) => `${Math.round(p.geometry.flatWidth)} x ${Math.round(p.geometry.flatHeight)} mm`;
    const setUnits = (p, units) => h.post(`/api/parts/${p.partId}/units`, { units }, undefined, { "X-Part-Key": p.editKey });

    // What the job honestly costs.
    const honest = await h.uploadData("panel-40x30in.dxf", dxfPlate(40, 30));
    const honestQuote = await h.post("/api/quote", { parts: [config(honest.partId)], leadTimeSlug: "standard" });
    r.note(`honest: part ${size(honest)}, 1 pc in 3/4" HDPE -> ${money(honestQuote.body.orderTotal)} (gate: ${honestQuote.body.gate.reasons.map((x) => x.code).join(",") || "none"})`);

    // The swap.
    const part = await h.uploadData("panel-40x30in.dxf", dxfPlate(40, 30));
    const asMm = await setUnits(part, "mm");
    r.note(`units -> mm: ${asMm.status}, part is now ${size(asMm.body)}`);
    const cheap = await h.post("/api/quote", { parts: [config(part.partId)], leadTimeSlug: "standard" });
    r.note(`priced as millimetres: ${money(cheap.body.orderTotal)} (gate: ${cheap.body.gate.reasons.map((x) => x.code).join(",") || "none"})`);
    const asIn = await setUnits(part, "in");
    r.note(`units -> in after pricing: ${asIn.status}, part is now ${asIn.body.geometry ? size(asIn.body) : JSON.stringify(asIn.body)}`);

    const buyer = await h.register("units-swap@example.test");
    const co = await h.post("/api/orders/checkout-session", { quoteId: cheap.body.quoteId, ...SHIP }, buyer);
    const session = h.lastSession();
    r.note(`checkout: ${co.status}; amount sent to Stripe ${money(session.amount_total / 100)}`);
    const hook = await h.webhook(h.completed(session));
    const admin = await h.admin();
    // (2026-11-13: the order list is a page of summaries now; an order's lines come from the single-order route.)
    const order = (await h.get(`/api/orders/${co.body.orderId}`, admin)).body;
    // (2026-11-13: an order's lines no longer carry the part's measurements (re-review F-09); the shop
    // sees them on the traveler, so that is where "the part as the shop sees it" is read from.)
    const g = (await h.get(`/api/orders/${co.body.orderId}/traveler`, admin)).body.items[0].geometry;
    r.note(`webhook ${hook.status}; order status "${order.status}", total ${money(order.total)}; part on the order as the shop sees it: ${Math.round(g.flatWidth)} x ${Math.round(g.flatHeight)} mm`);
    const lockedNow = await setUnits(part, "mm");
    r.note(`units change after the order exists: ${lockedNow.status} (${lockedNow.body.code || ""})`);

    const paidForBigAtSmallPrice = co.status === 200 && order.status === "paid" && g.flatWidth > 1000 && session.amount_total / 100 < honestQuote.body.orderTotal / 2;
    r.finding(paidForBigAtSmallPrice, `paid ${money(session.amount_total / 100)} for a job the engine prices at ${money(honestQuote.body.orderTotal)}; the paid order carries the full-size part`);
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
