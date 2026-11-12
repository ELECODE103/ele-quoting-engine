/**
 * F-04  Checkout charges the total saved on the quote; nothing is re-priced or re-checked
 *       when the buyer pays. The saved price is good for 30 days and for any number of orders.
 *
 *  a. owner raises prices (or fixes a rate that was too low): earlier quotes still check out at the old total
 *  b. owner switches a material off: earlier quotes in it still check out
 *  c. one saved quote can be turned into several paid orders at the old price
 *  d. (control) re-pricing the quote does pick up the new rules, and a buyer cannot send a total of their own
 *
 * Run: node tools/security/review-payments/poc-04-stale-quote.js
 */
const { start, report, money, SHIP } = require("./lib");

(async () => {
  const h = await start();
  const r = report("F-04 saved quote is charged as saved");
  try {
    const buyer = await h.register("stale@example.test");
    const admin = await h.admin();
    const cube = await h.upload("cube_20mm.stl");
    const body = { parts: [{ partId: cube.partId, process: "cnc", materialSlug: "cnc-brass-360", quantity: 20 }], leadTimeSlug: "standard" };
    const old = await h.post("/api/quote", body, buyer); // review-fixes: the buyer is signed in throughout (once they check out, the part is their account's)
    r.note(`quote saved at today's rules: ${money(old.body.orderTotal)} (valid until ${old.body.expiresAt.slice(0, 10)})`);

    // a. prices go up
    const up = await h.put("/api/admin/pricing", { rules: { cncMachineRatePerHour: 220, marginPercent: 0.7 }, note: "review PoC: raise prices" }, admin);
    const now = await h.post("/api/quote", body, buyer);
    r.note(`owner raises the mill rate and margin (${up.status}); the same job now prices at ${money(now.body.orderTotal)}`);
    const co1 = await h.post("/api/orders/checkout-session", { quoteId: old.body.quoteId, ...SHIP }, buyer);
    // review-fixes: the script no longer assumes a Stripe session exists after each checkout call.
    let s1 = co1.status === 200 ? h.lastSession() : null;
    r.note(`checkout of the earlier quote: ${co1.status}${s1 ? `, Stripe amount ${money(s1.amount_total / 100)}` : ` ${co1.body.code} (was ${money(co1.body.previousTotal)}, now ${money(co1.body.newTotal)}); Stripe sessions made: ${h.sessions().length}`}`);
    r.finding(co1.status === 200 && s1.amount_total / 100 < now.body.orderTotal - 1, `after a price rise the earlier quote is still charged at ${s1 ? money(s1.amount_total / 100) : "-"} (today ${money(now.body.orderTotal)})`);
    if (!s1) {
      // The buyer accepts the new price, as the checkout page asks them to.
      const again = await h.post("/api/orders/checkout-session", { quoteId: old.body.quoteId, ...SHIP, confirmedTotal: co1.body.newTotal }, buyer);
      s1 = again.status === 200 ? h.lastSession() : null;
      r.note(`  the buyer confirms the new total: checkout ${again.status}, Stripe amount ${s1 ? money(s1.amount_total / 100) : "-"}`);
    }

    // c. the same saved quote, bought again after the first order is paid
    if (s1) await h.webhook(h.completed(s1));
    const before2 = h.sessions().length;
    const co2 = await h.post("/api/orders/checkout-session", { quoteId: old.body.quoteId, ...SHIP }, buyer);
    const s2 = h.sessions().length > before2 ? h.lastSession() : null;
    if (s2) await h.webhook(h.completed(s2));
    const orders = (await h.get("/api/orders", buyer)).body.filter((o) => o.quoteId === old.body.quoteId);
    r.note(`second checkout of the same quote: ${co2.status} ${co2.body.code || ""}; paid orders from it: ${orders.filter((o) => o.status === "paid").length}; new Stripe session: ${s2 ? "yes" : "no"}`);
    r.finding(orders.filter((o) => o.status === "paid").length === 2, "one saved quote produced two paid orders at the old price (no limit until it expires)");

    // b. material switched off
    const mat = (await h.get("/api/admin/materials", admin)).body.find((m) => m.slug === "cnc-brass-360");
    const off = await h.put(`/api/admin/materials/${mat.id}`, { active: false }, admin);
    const fresh = await h.post("/api/quote", body, buyer);
    const co3 = await h.post("/api/orders/checkout-session", { quoteId: old.body.quoteId, ...SHIP }, buyer);
    r.note(`brass switched off (${off.status}); new quote in brass: ${fresh.status} (${fresh.body.error || ""}); checkout of the earlier brass quote: ${co3.status}`);
    r.finding(fresh.status === 400 && co3.status === 200, "a material the owner switched off can still be bought from an earlier quote");

    // d. controls
    const sent = await h.post("/api/quote", { ...body, parts: [{ ...body.parts[0], materialSlug: "cnc-aluminum-6061", unitPrice: 0.01, lineTotal: 0.01 }], orderTotal: 1, subtotal: 1, paperworkFee: 0, leadTimeMultiplier: 0.1, shippingEstimate: 0, quoteId: now.body.quoteId }, buyer);
    r.note(`re-price with client-sent totals (orderTotal 1, unitPrice 0.01, leadTimeMultiplier 0.1): ${sent.status === 200 ? `server total ${money(sent.body.orderTotal)}` : `${sent.status} ${sent.body.code} — ${sent.body.error}`}`);
    r.finding(!(sent.body.orderTotal > 50), "client-sent amounts change the saved total");
    const co4 = await h.post("/api/orders/checkout-session", { quoteId: sent.body.quoteId, ...SHIP, total: 1, orderTotal: 1, amount: 100, paperwork: false, leadTimeSlug: "standard" }, buyer);
    const s4 = h.lastSession();
    r.note(`checkout with client-sent amounts: ${co4.status} ${co4.body.code || ""}; Stripe asked for ${co4.status === 200 ? money(s4.amount_total / 100) : "-"}`);
    r.finding(!(co4.status === 200 && Math.abs(s4.amount_total / 100 - sent.body.orderTotal) < 0.005), "an amount sent with the checkout request changes what Stripe is asked to charge");

    // review-fixes: e. the price hold itself, kept by design for 30 days — a small price rise does not change a quote
    // already given, but the owner can end every hold at once.
    const lathe = await h.upload("small_clip.stl");
    const heldBody = { parts: [{ partId: lathe.partId, process: "3d-printing", materialSlug: "fdm-pla", quantity: 40 }], leadTimeSlug: "standard" };
    const held = await h.post("/api/quote", heldBody, buyer);
    const rules = (await h.get("/api/admin/pricing", admin)).body.rules || {};
    const up2 = await h.put("/api/admin/pricing", { rules: { marginPercent: Math.min(0.9, (Number(rules.marginPercent) || 0.7) + 0.05) }, note: "review PoC: a small rise" }, admin);
    const heldNow = await h.post("/api/quote", heldBody, buyer);
    const voided = await h.post("/api/admin/quotes/void-open", {}, admin);
    const coHeld = await h.post("/api/orders/checkout-session", { quoteId: held.body.quoteId, ...SHIP }, buyer);
    r.note(`price hold: quote ${money(held.body.orderTotal)}; small rise (${up2.status}) makes it ${money(heldNow.body.orderTotal)}; owner ends open price holds (${voided.status}); checkout of the earlier quote: ${coHeld.status} ${coHeld.body.code || ""}`);
    r.finding(coHeld.status === 200, "after the owner ends open price holds, an earlier quote still checks out at its old price");
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
