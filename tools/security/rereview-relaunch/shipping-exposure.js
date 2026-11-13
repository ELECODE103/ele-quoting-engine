/**
 * Business exposure of the DEFAULT shipping rule ($12 + $2.50/kg, no size, weight or destination limit).
 * Prices the largest routed sheets the instant quote will sell (not sent to a firm quote by the gate) and
 * prints what the site charges for shipping against the part's size and weight.
 *
 *   node tools/security/rereview-relaunch/shipping-exposure.js
 *
 * No carrier is called. The carrier column in the report is the reviewer's stated assumption.
 */
const { liftPacing, rectDxf, SHIP } = require("./lib");
const { start } = require("../../../server/testSupport/harness");

(async () => {
  liftPacing();
  process.env.UPLOAD_MAX_PARTS_PER_15MIN = "100000";
  const h = await start();
  const buyer = await h.register("ship@buyer.test");
  const mats = h.models.materialsDB.getAll().filter((m) => m.active && m.process === "routing");
  console.log(`routing materials on the default catalogue: ${mats.length}`);
  const sizes = [[48, 96], [59, 96], [24, 48], [48, 48], [60, 120]];
  const rows = [];
  for (const [w, l] of sizes) {
    const up = await h.form("/api/upload", {}, { files: { name: `sheet_${w}x${l}.dxf`, data: rectDxf(w, l) } });
    if (up.status !== 200 || !up.body.parts || !up.body.parts.length) { console.log(`upload ${w}x${l}: ${up.status} ${up.text.slice(0, 200)}`); continue; }
    const partId = up.body.parts[0].partId;
    for (const m of mats) {
      const grade = (m.grades && m.grades[0] && m.grades[0].name) || "";
      const thicknesses = (m.thicknesses || m.thicknessesMm || (m.grades && m.grades[0] && m.grades[0].thicknesses) || []);
      const list = Array.isArray(thicknesses) && thicknesses.length ? [thicknesses[0], thicknesses[thicknesses.length - 1]] : [null];
      for (const t of [...new Set(list)]) {
        const tMm = t && typeof t === "object" ? (t.mm || t.thicknessMm) : t;
        let best = null;
        for (const qty of [1, 2, 5, 10, 25, 50, 100]) {
          const q = await h.post("/api/quote", { parts: [{ partId, materialSlug: m.slug, grade, finishSlug: "", quantity: qty, process: "routing", ...(tMm ? { thicknessMm: tMm } : {}) }], leadTimeSlug: "standard" }, buyer);
          if (q.status !== 200) { if (qty === 1) rows.push({ size: `${w}x${l}`, material: m.slug, t: tMm, note: `${q.status} ${q.body && (q.body.code || q.body.error)}` }); break; }
          if (q.body.gate && q.body.gate.requiresRfq) { if (qty === 1) rows.push({ size: `${w}x${l}`, material: m.slug, t: tMm, note: `firm quote: ${(q.body.gate.reasons || []).map((r) => r.code).join(",")}` }); break; }
          best = { qty, subtotal: q.body.subtotal, shipping: q.body.shippingEstimate, kg: q.body.totalWeight, total: q.body.orderTotal, quoteId: q.body.quoteId };
        }
        if (best) {
          // Does checkout really take it at that shipping figure, to Hawaii as well?
          const c = await h.post("/api/orders/checkout-session", { quoteId: best.quoteId, ...SHIP, shippingState: "HI", shippingCity: "Honolulu", shippingZip: "96813" }, buyer);
          const order = c.status === 200 ? h.models.ordersDB.getById(c.body.orderId) : null;
          rows.push({ size: `${w}x${l}`, material: m.slug, t: tMm, qty: best.qty, parts$: best.subtotal, shipCharged$: Math.round(best.shipping * 100) / 100, kg: Math.round(best.kg * 10) / 10, lb: Math.round(best.kg * 22.046) / 10, checkoutToHawaii: c.status, orderShipping: order ? order.shippingCost : null });
        }
      }
    }
  }
  console.table(rows);
  await h.stop();
})().catch((e) => { console.error(e); process.exit(1); });
