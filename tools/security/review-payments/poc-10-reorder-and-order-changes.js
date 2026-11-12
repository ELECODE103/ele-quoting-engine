/**
 * Reorder, order changes after payment, cancelled and abandoned orders.
 *
 * Run: node tools/security/review-payments/poc-10-reorder-and-order-changes.js
 */
const { start, report, money, SHIP } = require("./lib");

(async () => {
  const h = await start();
  const r = report("Reorder and order changes");
  try {
    const admin = await h.admin();
    const buyer = await h.register("reorder@example.test");
    const other = await h.register("reorder-other@example.test");
    const cube = await h.upload("cube_20mm.stl");
    const q = await h.post("/api/quote", { parts: [{ partId: cube.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity: 40 }], leadTimeSlug: "expedited", paperwork: true });
    const co = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    const s = h.lastSession();
    await h.webhook(h.completed(s));
    const orderId = co.body.orderId;

    // ── reorder ──
    const stranger = await h.post(`/api/orders/${orderId}/reorder`, {}, other);
    const anon = await h.post(`/api/orders/${orderId}/reorder`, {});
    r.finding(stranger.status === 201 || anon.status === 201, `another account (${stranger.status}) or no account (${anon.status}) can reorder this order`);
    await h.put("/api/admin/pricing", { rules: { cncMachineRatePerHour: 200, rfqQuantityThreshold: 25, paperworkFeePerPart: 90 }, note: "review PoC: prices up, gate tighter" }, admin);
    const re = await h.post(`/api/orders/${orderId}/reorder`, { total: 1, orderTotal: 1 }, buyer);
    const rq = (await h.get(`/api/quote/${re.body.quoteId}`, buyer)).body;
    r.note(`original order ${money(s.amount_total / 100)} (paperwork ${money(q.body.paperworkFee)}); reorder after a price rise and a tighter gate: ${re.status}, new quote ${money(rq.orderTotal)}, paperwork ${rq.paperwork} at ${money(rq.paperworkFee)}, lead time ${rq.leadTimeSlug}, gate: ${rq.gate.reasons.map((x) => x.code).join(",") || "none"}`);
    const reCo = await h.post("/api/orders/checkout-session", { quoteId: re.body.quoteId, ...SHIP }, buyer);
    r.finding(!(rq.orderTotal > s.amount_total / 100 && rq.gate.requiresRfq && reCo.status === 409), `a reorder keeps the old price or skips the gate (checkout of the reorder: ${reCo.status})`);

    // ── changing a paid order ──
    const tries = {
      "checkout again with a new address (same quote)": await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP, shippingAddress: "666 Elsewhere Ave" }, buyer),
      "PUT /orders/:id": await h.put(`/api/orders/${orderId}`, { shippingAddress: "666 Elsewhere Ave", paperwork: false, total: 1 }, buyer),
      "PUT /orders/:id/status": await h.put(`/api/orders/${orderId}/status`, { status: "cancelled" }, buyer),
      "POST /orders (admin phone-order route)": await h.post("/api/orders", { quoteId: q.body.quoteId, shippingCost: 0 }, buyer),
      "units on the ordered part": await h.post(`/api/parts/${cube.partId}/units`, { units: "in" }, buyer, { "X-Part-Key": cube.editKey }),
      "re-price the ordered quote in place": await h.post("/api/quote", { quoteId: q.body.quoteId, parts: [{ partId: cube.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity: 1 }], leadTimeSlug: "standard" }, buyer),
    };
    const paid = (await h.get(`/api/orders/${orderId}`, admin)).body;
    const forked = tries["re-price the ordered quote in place"].body.quoteId !== q.body.quoteId;
    r.note(Object.entries(tries).map(([k, v]) => `${k}: ${v.status}`).join("; "));
    r.note(`paid order afterwards: "${paid.status}", ${money(paid.total)}, ship to "${paid.shippingAddress}", paperwork ${paid.paperwork}, ${paid.items[0].quantity} pcs; the re-price made a new quote (${forked}); the second checkout of the paid quote answered ${tries["checkout again with a new address (same quote)"].status} ${tries["checkout again with a new address (same quote)"].body.code || ""} (merge 2026-11-12: with both fix branches in, it no longer makes a second order)`);
    r.finding(paid.total !== s.amount_total / 100 || paid.shippingAddress !== SHIP.shippingAddress || !paid.paperwork || paid.items[0].quantity !== 40 || !forked, "a buyer can change a paid order's lines, address, paperwork flag or total");

    // ── F-08 (second part): an order cancelled by the shop can still be paid ──
    // (merge 2026-11-12, script fault, not the server's: this quote was asked for without a session after the part had been
    //  claimed by the signed-in buyer at checkout, so with part ownership (review F5) it was refused and nothing below ran
    //  against a real order. It is now priced by the buyer who owns the part. No attack request was changed.)
    const q2 = await h.post("/api/quote", { parts: [{ partId: cube.partId, process: "cnc", materialSlug: "cnc-brass-360", quantity: 2 }], leadTimeSlug: "standard" }, buyer);
    const co2 = await h.post("/api/orders/checkout-session", { quoteId: q2.body.quoteId, ...SHIP }, buyer);
    const s2 = h.lastSession();
    await h.put(`/api/orders/${co2.body.orderId}/status`, { status: "cancelled" }, admin);
    const mailsBefore = h.s.mail(null, /./).length;
    const late = await h.webhook(h.completed(s2));
    const o2 = (await h.get(`/api/orders/${co2.body.orderId}`, admin)).body;
    // (Checks updated with the order-lifecycle fixes, 2026-11-11: the script now looks at whether the session was closed
    //  at Stripe when the order was cancelled, and whether a payment that arrives anyway is recorded and reported.)
    const told = h.s.mail(null, /./).length - mailsBefore;
    const sessionAtStripe = h.session(s2.id).status;
    r.note(`shop cancels an unpaid order: its Stripe session is now "${sessionAtStripe}". A payment for it arrives anyway: webhook ${late.status} ${late.text}; order "${o2.status}", flagged "${o2.attention}"; emails sent about it: ${told}`);
    r.finding(sessionAtStripe !== "expired", "F-08: the checkout session is not expired when an order is cancelled, so the cancelled order can still be paid");
    r.finding(!(late.status === 200 && o2.attention === "late-payment" && told === 1), "F-08: money collected for a cancelled order is acknowledged to Stripe and dropped: the order stays cancelled and nobody is told");

    // ── orders that never get paid ──
    const pending = (await h.get("/api/orders", admin)).body.filter((o) => o.status === "pending_payment");
    r.note(`unpaid orders left behind by this script: ${pending.length}; each has a Stripe session that expires (${pending.map((o) => String(o.sessionExpiresAt).slice(11, 16)).join(", ")} UTC), after which the sweep closes the order as "expired" and its quote can be used again (server/routes/orderLifecycle.test.js)`);
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
