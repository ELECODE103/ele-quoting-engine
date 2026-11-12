/**
 * F-02  The process, the material/process pairing, the stock thickness and the grade
 *       sent with a quote are not checked against what the shop offers.
 *
 *  a. a process the site does not sell ("sheetmetal", or any unknown word, which falls
 *     back to it) prices a part with the old laser-cutting model, skips the quote gate
 *     for a part that fails review on every real process, and checks out
 *  b. a material from another process (aluminum under "3d-printing") is priced with
 *     that process's fallback rates
 *  c. a stock thickness the material is not sold in is accepted
 *  d. free text sent as the grade is stored on the order and printed on its documents
 *
 * Run: node tools/security/review-payments/poc-02-process-material-not-validated.js
 */
const path = require("path");
const { start, report, money, SHIP, ROOT } = require("./lib");
const { dxfPlate } = require("./fixtures");

(async () => {
  const h = await start();
  const r = report("F-02 process / material / thickness / grade not validated");
  try {
    const quote = (parts, extra = {}) => h.post("/api/quote", { parts, leadTimeSlug: "standard", ...extra });
    const gateOf = (q) => q.body.gate ? (q.body.gate.reasons.map((x) => x.code).join(",") || "none") : `refused: ${q.body.error}`;
    const buyer = await h.register("process-swap@example.test");
    const admin = await h.admin();

    // a. hidden / unknown process
    const offered = (await h.get("/api/processes")).body.map((p) => p.slug);
    r.note(`processes the site offers: ${offered.join(", ")}`);
    const panel = await h.upload("oversize_panel.stl");
    const real = {};
    for (const [proc, mat] of [["cnc", "cnc-aluminum-6061"], ["routing", "rt-aluminum-6061"]]) {
      real[proc] = await quote([{ partId: panel.partId, process: proc, materialSlug: mat, quantity: 10 }]);
      r.note(`oversize panel x10, ${proc}/${mat}: ${money(real[proc].body.orderTotal)}, gate: ${gateOf(real[proc])}`);
    }
    for (const proc of ["sheetmetal", "anything-at-all"]) {
      const q = await quote([{ partId: panel.partId, process: proc, materialSlug: "cnc-aluminum-6061", quantity: 10 }]);
      const li = q.body.lineItems[0];
      r.note(`oversize panel x10, process "${proc}": ${money(q.body.orderTotal)} (${money(li.perUnit.final)} each), priced as "${li.meta.process}", thickness ${li.meta.thicknessMm} mm, gate: ${gateOf(q)}`);
      if (proc === "anything-at-all") {
        const co = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
        const s = h.lastSession();
        await h.webhook(h.completed(s));
        const order = (await h.get(`/api/orders/${co.body.orderId}`, admin)).body;
        r.note(`  checkout ${co.status}; Stripe amount ${money(s.amount_total / 100)}; order "${order.status}"; line: ${order.items[0].quantity} x ${order.items[0].fileName}, process "${order.items[0].process}", material "${order.items[0].materialName}"`);
        r.finding(co.status === 200 && order.status === "paid" && real.cnc.body.gate.requiresRfq && s.amount_total / 100 < real.routing.body.orderTotal / 2,
          `a part that needs a person's review on cnc and routing was bought unreviewed for ${money(s.amount_total / 100)} (routing estimate ${money(real.routing.body.orderTotal)}, cnc ${money(real.cnc.body.orderTotal)}) by naming a process the site does not offer`);
        // What the shop's documents say about that line.
        const { pdfText } = require(path.join(ROOT, "server", "testSupport", "pdfText.js"));
        const trav = await h.s.req({ url: `/api/pdf/traveler/${co.body.orderId}`, token: admin });
        const text = trav.status === 200 ? await Promise.resolve(pdfText(trav.buffer)) : "";
        r.note(`  traveler PDF ${trav.status}: process column reads "${(String(text).match(/Sheet ?metal|Sheetmetal|sheetmetal/i) || ["(not found)"])[0]}"`);
      }
    }

    // b. a material from another process
    const housing = await h.upload("thin_wall_housing.stl");
    const cnc = await quote([{ partId: housing.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity: 10 }]);
    const cross = await quote([{ partId: housing.partId, process: "3d-printing", materialSlug: "cnc-aluminum-6061", quantity: 10 }]);
    r.note(`housing x10 aluminum: cnc ${money(cnc.body.orderTotal)}; same material under 3d-printing ${money(cross.body.orderTotal)} (priced as ${cross.body.lineItems[0].meta.subProcess}, material ${cross.body.lineItems[0].meta.materialSlug})`);
    const co2 = await h.post("/api/orders/checkout-session", { quoteId: cross.body.quoteId, ...SHIP }, buyer);
    r.finding(cross.status === 200 && co2.status === 200 && cross.body.orderTotal < cnc.body.orderTotal / 2, `an aluminum part ordered as a "3D print" in a CNC material checks out at ${money(cross.body.orderTotal)} against ${money(cnc.body.orderTotal)} machined`);

    // c. thickness not in the material's list; d. free-text grade
    const mats = (await h.get("/api/materials")).body;
    const hdpe = mats.find((m) => m.slug === "rt-hdpe");
    const plate = await h.uploadData("plate-12x8in.dxf", dxfPlate(12, 8));
    const thick = await quote([{ partId: plate.partId, process: "routing", materialSlug: "rt-hdpe", thicknessMm: 25.4, quantity: 10 }]);
    const thin = await quote([{ partId: plate.partId, process: "routing", materialSlug: "rt-hdpe", thicknessMm: 0.01, quantity: 10, grade: "PEEK natural - upgrade approved by phone" }]);
    r.note(`HDPE is sold in ${hdpe.thicknesses.map((t) => t.mm).join(", ")} mm`);
    r.note(`12 x 8 in plate x10: 25.4 mm ${money(thick.body.orderTotal)}; 0.01 mm ${thin.status === 200 ? money(thin.body.orderTotal) : thin.body.error}`);
    if (thin.status === 200) {
      const co3 = await h.post("/api/orders/checkout-session", { quoteId: thin.body.quoteId, ...SHIP }, buyer);
      const order = (await h.get(`/api/orders/${co3.body.orderId}`, admin)).body;
      const cfg = order.items[0].config || {};
      r.note(`  checkout ${co3.status}; order line stores thickness ${cfg.thicknessMm} mm and grade "${cfg.grade}"`);
      r.finding(co3.status === 200 && cfg.thicknessMm === 0.01, "a stock thickness the material is not sold in is priced and ordered");
      r.finding(co3.status === 200 && /PEEK/.test(cfg.grade || ""), "free text sent as the grade is stored on the order line (priced as the first listed grade)");
    } else {
      r.finding(false, "thickness outside the material's list is refused");
    }
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
