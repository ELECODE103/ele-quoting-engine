/**
 * Quantity, rounding, lead time, finish and paperwork inputs (mostly controls: what held),
 * plus F-05: a sent-out finish on Expedited by using another process's finish slug.
 *
 * Run: node tools/security/review-payments/poc-05-quantity-rounding-leadtime.js
 */
const { start, report, money, SHIP } = require("./lib");

(async () => {
  const h = await start();
  const r = report("Quantity / rounding / lead time / finish / paperwork");
  try {
    const buyer = await h.register("qty@example.test");
    const cube = await h.upload("cube_20mm.stl");
    const clip = await h.upload("small_clip.stl");
    const base = { partId: cube.partId, process: "cnc", materialSlug: "cnc-aluminum-6061" };
    const quote = (parts, extra = {}) => h.post("/api/quote", { parts, leadTimeSlug: "standard", ...extra });

    // ── quantities ──
    const seen = [];
    let badQty = false;
    for (const q of [-5, 0, 0.5, 1.9, 99.9, "3", "1e3", "0x10", 1e21, 1000001, "abc", null, true, [5], { n: 5 }, "", " 7 ", 1e-7, Number.MAX_SAFE_INTEGER]) {
      const res = await quote([{ ...base, quantity: q }]);
      if (res.status !== 200) { seen.push(`${JSON.stringify(q)}→${res.status}`); continue; }
      const li = res.body.lineItems[0];
      const ok = Number.isInteger(li.quantity) && li.quantity >= 1 && li.lineTotal > 0 && Number.isFinite(res.body.orderTotal) && Math.abs(li.lineTotal - Math.round(li.perUnit.final * li.quantity * 100) / 100) < 0.006;
      if (!ok) badQty = true;
      seen.push(`${JSON.stringify(q)}→qty ${li.quantity}, ${money(res.body.orderTotal)}${res.body.gate.requiresRfq ? " (to RFQ)" : ""}`);
    }
    r.note(seen.join("; "));
    r.finding(badQty, "a quantity value produces a zero, negative, fractional or non-finite line");

    // ── cents: what is saved, what the order stores and what Stripe is asked for ──
    let drift = 0, checked = 0;
    for (const n of [1, 3, 7, 33, 100]) {
      for (const lead of ["standard", "expedited"]) {
        for (const paperwork of [false, true]) {
          const parts = Array.from({ length: n }, (_, i) => ({ partId: i % 2 ? clip.partId : cube.partId, process: "3d-printing", materialSlug: i % 3 ? "fdm-pla" : "fdm-petg", quantity: 1 + (i % 7) }));
          const q = await quote(parts, { leadTimeSlug: lead, paperwork });
          if (q.status !== 200) { r.note(`n=${n} ${lead} paperwork=${paperwork}: ${q.status} ${q.body.error}`); continue; }
          const sumLines = Math.round(q.body.lineItems.reduce((s, li) => s + li.lineTotal, 0) * 100) / 100;
          const co = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
          if (co.status !== 200) { r.note(`n=${n} ${lead}: checkout ${co.status} ${JSON.stringify(co.body)}`); continue; }
          const s = h.lastSession();
          const order = (await h.get(`/api/orders/${co.body.orderId}`, buyer)).body;
          const parts4 = Math.round((order.subtotal + order.leadTimeSurcharge + order.shippingCost + order.paperworkFee) * 100);
          const stripeLines = s._args.line_items.reduce((a, li) => a + li.price_data.unit_amount * li.quantity, 0);
          const bad = Math.abs(sumLines - q.body.subtotal) > 0.001 || s.amount_total !== Math.round(q.body.orderTotal * 100) || parts4 !== s.amount_total || stripeLines !== s.amount_total || Boolean(order.paperwork) !== paperwork || (paperwork && order.paperworkFee !== q.body.paperworkFee) || !Number.isInteger(Math.round(q.body.orderTotal * 100));
          if (bad) { drift++; r.note(`  mismatch n=${n} ${lead} pw=${paperwork}: quote ${q.body.orderTotal}, stripe ${s.amount_total}, order parts ${parts4}`); }
          checked++;
        }
      }
    }
    r.note(`${checked} quotes of 1–100 lines, both lead times, with and without paperwork: quote total = order subtotal + lead fee + shipping + paperwork = Stripe amount in ${checked - drift} of ${checked}`);
    r.finding(drift > 0, "a quote, its order and its Stripe amount disagree by a cent or more");
    const tooMany = await quote(Array.from({ length: 101 }, () => ({ ...base, quantity: 1 })));
    r.finding(tooMany.status === 200, `101 lines accepted (got ${tooMany.status}: ${tooMany.body.code || ""})`);

    // ── minimum order and paperwork fee ──
    const tiny = await quote([{ partId: clip.partId, process: "3d-printing", materialSlug: "fdm-pla", quantity: 1 }]);
    const tinyPw = await quote([{ partId: clip.partId, process: "3d-printing", materialSlug: "fdm-pla", quantity: 1 }], { paperwork: true, paperworkFee: 0.01, paperworkOffer: { fee: 0 } });
    r.note(`one small print: ${money(tiny.body.orderTotal)} (parts ${money(tiny.body.subtotal)}); with paperwork and a client-sent fee of $0.01: ${money(tinyPw.body.orderTotal)} (fee ${money(tinyPw.body.paperworkFee)})`);
    r.finding(!(tinyPw.body.paperworkFee > 1 && Math.abs(tinyPw.body.orderTotal - tiny.body.orderTotal - tinyPw.body.paperworkFee) < 0.005), "the paperwork fee can be lowered or absorbed by the order minimum");
    const unticked = await quote([{ partId: clip.partId, process: "3d-printing", materialSlug: "fdm-pla", quantity: 1 }], { paperwork: false, quoteId: tinyPw.body.quoteId });
    const co = await h.post("/api/orders/checkout-session", { quoteId: unticked.body.quoteId, ...SHIP, paperwork: true }, buyer);
    const o = (await h.get(`/api/orders/${co.body.orderId}`, buyer)).body;
    r.finding(o.paperwork === true || unticked.body.quoteId !== tinyPw.body.quoteId && false, `paperwork un-ticked before checkout but the order still records it (order.paperwork=${o.paperwork}, fee ${o.paperworkFee})`);

    // ── lead times ──
    const lt = {};
    for (const slug of ["rush", "same-day", "free", "", 5, null]) lt[JSON.stringify(slug)] = (await quote([{ ...base, quantity: 2 }], { leadTimeSlug: slug })).status;
    r.note(`lead times not offered: ${JSON.stringify(lt)}`);
    r.finding(lt['"rush"'] === 200 || lt['"same-day"'] === 200, "an unlisted lead time can be bought by slug");
    const std = await quote([{ ...base, quantity: 2 }]);
    const exp = await quote([{ ...base, quantity: 2 }], { leadTimeSlug: "expedited", leadTimeMultiplier: 1, leadTimeSurcharge: 0 });
    r.finding(!(exp.body.orderTotal > std.body.orderTotal), `Expedited costs no more than Standard (${money(exp.body.orderTotal)} vs ${money(std.body.orderTotal)})`);

    // ── sent-out finish on Expedited ──
    const ano = await quote([{ ...base, quantity: 2, finishSlug: "cnc-anodize-clear" }], { leadTimeSlug: "expedited" });
    r.note(`cnc-anodize-clear + Expedited: ${ano.status} (${ano.body.code || ""})`);
    const cross = await quote([{ ...base, quantity: 2, finishSlug: "anodize-clear" }], { leadTimeSlug: "expedited" });
    const crossPc = await quote([{ ...base, quantity: 2, finishSlug: "powder-black" }], { leadTimeSlug: "expedited" });
    r.note(`"anodize-clear" (the sheet-metal finish) + Expedited on a CNC part: ${cross.status}${cross.status === 200 ? `, ${money(cross.body.orderTotal)}, finish on the line "${cross.body.lineItems[0].meta.finishSlug}"` : ` ${cross.body.error}`}; "powder-black": ${crossPc.status}`);
    if (cross.status === 200) {
      const c2 = await h.post("/api/orders/checkout-session", { quoteId: cross.body.quoteId, ...SHIP }, buyer);
      const o2 = (await h.get(`/api/orders/${c2.body.orderId}`, buyer)).body;
      r.note(`  checkout ${c2.status}; order: lead time "${o2.leadTimeName}", ship by ${o2.shipBy}, finish "${o2.items[0].finishName}"`);
      r.finding(ano.status === 400 && c2.status === 200, `F-05: an anodized part is ordered on Expedited by sending another process's finish slug (the Standard-only rule lists four cnc- slugs)`);
    } else r.finding(false, "F-05: cross-process sent-out finish on Expedited");
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
