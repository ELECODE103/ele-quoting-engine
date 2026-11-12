const c = require("./lib/common");
(async () => {
  const s = await c.start();
  try {
    const ip = "203.0.113.5";
    const admin = await s.admin({ ip: "203.0.113.1" });
    const buyer = await s.register("buyer@example.test", { ip });
    // --- A: process mismatch
    const up = await s.upload([{ name: "block.stl", data: c.boxStl([100, 80, 40]) }], { ip });
    const partId = up.body.parts[0].partId;
    const honest = await s.post("/api/quote", { parts: [{ partId, materialSlug: "cnc-peek", process: "cnc", quantity: 10 }] }, { ip, token: buyer });
    const cheat = await s.post("/api/quote", { parts: [{ partId, materialSlug: "cnc-peek", process: "sheetmetal", quantity: 10 }] }, { ip, token: buyer });
    // (review-fixes: the script used to assume the exploit works; it now prints what the server answers when it does not.)
    if (cheat.status !== 200) {
      console.log("honest", honest.body.orderTotal, "| cheat REFUSED:", cheat.status, JSON.stringify(cheat.body));
    } else {
      console.log("honest", honest.body.orderTotal, "cheat", cheat.body.orderTotal, cheat.body.gate, JSON.stringify(cheat.body.lineItems[0].meta).slice(0, 500));
      const co = await s.post("/api/orders/checkout-session", { quoteId: cheat.body.quoteId, shippingName: "B", shippingAddress: "1 St", shippingCity: "C", shippingState: "IL", shippingZip: "60000" }, { ip, token: buyer });
      console.log("checkout", co.status, co.body);
      const sess = Object.values(s.state().sessions)[0];
      console.log("stripe amount cents", sess.amount_total);
      s.payAll();
      const cp = await s.post(`/api/orders/${co.body.orderId}/confirm-payment`, {}, { ip, token: buyer });
      console.log("confirm", cp.status, cp.body);
      const ao = await s.get(`/api/orders/${co.body.orderId}`, { token: admin, ip: "203.0.113.1" });
      console.log("order", ao.body.status, ao.body.total, ao.body.items.map((i) => ({ process: i.process, materialName: i.materialName, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal })));
    }

    // --- B: DXF units swap after pricing
    const dx = await s.upload([{ name: "panel.dxf", data: c.rectDxf(40, 30, 4) }], { ip, fields: { process: "routing" } });
    console.log("dxf upload", dx.status, JSON.stringify(dx.body).slice(0, 300));
    const dpart = dx.body.parts[0];
    console.log("editKey", dpart.editKey, "bbox", JSON.stringify(dpart.geometry.boundingBox), dpart.geometry.profile2d && dpart.geometry.profile2d.units);
    const mats = (await s.get("/api/materials?process=routing")).body;
    const m = mats.find((x) => x.slug === "rt-polycarbonate") || mats[0];
    const t = m.thicknesses[m.thicknesses.length - 1].mm;
    const cfg = { partId: dpart.partId, materialSlug: m.slug, process: "routing", thicknessMm: t, quantity: 20 };
    const small = await s.post("/api/quote", { parts: [cfg] }, { ip, token: buyer });
    console.log("priced at mm:", small.status, small.body.orderTotal, small.body.gate && small.body.gate.requiresRfq, small.body.error);
    // (review-fixes: the part now belongs to the buyer who priced it, so the buyer — the attacker here — sends
    // the change with their own session; without it the answer is 404 and the attack never starts.)
    const sw = await s.post(`/api/parts/${dpart.partId}/units`, { units: "in" }, { ip, token: buyer, headers: { "X-Part-Key": dpart.editKey } });
    console.log("units->in", sw.status, JSON.stringify(sw.body.geometry && sw.body.geometry.boundingBox), sw.body.error);
    const fair = await s.post("/api/quote", { parts: [cfg] }, { ip: c.randomIp(), token: buyer });
    console.log("what the inch-size part costs:", fair.status, fair.body.orderTotal, fair.body.gate && fair.body.gate.reasons.map((r) => r.code), fair.body.error);
    const co2 = await s.post("/api/orders/checkout-session", { quoteId: small.body.quoteId, shippingName: "B", shippingAddress: "1 St", shippingCity: "C", shippingState: "IL", shippingZip: "60000" }, { ip, token: buyer });
    if (co2.status !== 200) {
      const { quote, ...rest } = co2.body || {};
      console.log("checkout stale quote REFUSED:", co2.status, JSON.stringify(rest), quote ? `(quote now shows total ${quote.orderTotal}, gate.requiresRfq ${quote.gate && quote.gate.requiresRfq})` : "");
      console.log("stripe sessions created for it:", Object.values(s.state().sessions).filter((x) => x.metadata && x.metadata.quoteId === small.body.quoteId).length);
      const stored = await s.get(`/api/quote/${small.body.quoteId}`, { ip, token: buyer });
      console.log("the stored quote after the units change:", stored.status, "total", stored.body.orderTotal, "requiresRfq", stored.body.gate && stored.body.gate.requiresRfq);
    } else {
      console.log("checkout stale quote", co2.status, co2.body);
      const sess2 = Object.values(s.state().sessions).pop();
      console.log("stripe amount cents", sess2.amount_total);
      s.payAll();
      await s.post(`/api/orders/${co2.body.orderId}/confirm-payment`, {}, { ip, token: buyer });
      const tr = await s.get(`/api/orders/${co2.body.orderId}/traveler`, { token: admin, ip: "203.0.113.1" });
      console.log("traveler", tr.status, tr.body.order, tr.body.items.map((i) => ({ qty: i.quantity, lineTotal: i.lineTotal, bbox: i.geometry && i.geometry.boundingBox && [i.geometry.boundingBox.width, i.geometry.boundingBox.height, i.geometry.boundingBox.depth], cfg: i.config && { thicknessMm: i.config.thicknessMm, geometrySummary: i.config.geometrySummary } })));
    }
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
