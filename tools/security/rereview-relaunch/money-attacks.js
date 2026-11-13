/**
 * Money attacks on the merged checkout (re-review 2026-11-12). In-process harness, Stripe stand-in.
 *
 *   node tools/security/rereview-relaunch/money-attacks.js
 *
 * For every shipping mode x tax x delivery choice: the total the page is told, the order total, the
 * amount Stripe is asked for and the amount that settles the order must be one number. Then the
 * attacks: delivery switched between two tabs, an old session paid after the switch, a payment that
 * lands before the switch, replayed and out-of-order events, a late payment on a lapsed order,
 * amounts sent by the browser, a zero/absurd weight, units changed on a DXF during checkout.
 * Exit code 1 when any FINDING is printed.
 */
const assert = require("assert");
const { liftPacing, rectDxf, report, sumLines, SHIP } = require("./lib");
const { start } = require("../../../server/testSupport/harness");

const TABLE = [{ maxLb: 1, price: 9 }, { maxLb: 5, price: 14.5 }, { maxLb: 20, price: 30 }, { maxLb: 50, price: 61 }];

(async () => {
  liftPacing();
  const h = await start();
  const R = report();
  const { quotesDB, ordersDB, partsDB } = h.models;
  const ruleSchema = require("../../../server/config/ruleSchema");
  const { expectedCharge } = require("../../../server/services/expectedCharge");
  const owner = await h.admin("Owner");
  const buyer = await h.register("dana@buyer.test", "Dana Buyer");
  const partId = await h.uploadCube();
  const DEFAULTS = {
    shippingMethod: "formula", shippingRateTable: ruleSchema.RULE_BY_KEY.shippingRateTable.default, shippingPackagingPercent: 0.10, shippingPackagingLb: 1,
    shippingOversizeLongestIn: 48, shippingMaxParcelLb: 50, shippingFreeOverSubtotal: 0, shippingCarrierAccount: "off", shippingLocalPickup: "off",
    taxMode: "off", taxProductCode: "", taxShipping: "goods", taxIdCollection: "off", taxExemptDeclare: "off", taxTrustDeclaredExemptions: "off", minimumOrderTotal: 25,
  };
  const settings = async (over = {}) => { const r = await h.put("/api/admin/pricing", { rules: { ...DEFAULTS, ...over }, note: "re-review" }, owner); assert.strictEqual(r.status, 200, r.text); };
  const price = (qty = 2, extra = {}, token = buyer) => h.post("/api/quote", { parts: [h.cncConfig(partId, qty)], leadTimeSlug: "standard", ...extra }, token);
  const checkout = (quoteId, body = {}, token = buyer) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...body }, token);
  const lastArgs = () => h.stripe.created[h.stripe.created.length - 1];
  const sessionOfUrl = (url) => h.stripe.sessions[String(url).split("/").pop()];
  const c100 = (n) => Math.round(Number(n) * 100);

  // ── 1. The matrix: page total == order total == Stripe lines == settles paid ──────────────────
  console.log("\n1. shipping mode x tax x delivery choice: one number from page to payment");
  const shipModes = [
    { name: "formula", rules: {} },
    { name: "table", rules: { shippingMethod: "table", shippingRateTable: TABLE } },
    { name: "included", rules: { shippingMethod: "included" } },
    { name: "formula+free-over-50", rules: { shippingFreeOverSubtotal: 50 } },
  ];
  const deliveries = [
    { name: "ship", body: {} },
    { name: "pickup", body: { shippingOption: "pickup" } },
    { name: "carrier-account", body: { shippingOption: "carrier-account", carrier: "UPS", carrierAccount: "A1B2C3D4" } },
  ];
  for (const sm of shipModes) for (const taxOn of [false, true]) for (const d of deliveries) for (const paperwork of [false, true]) {
    await settings({ ...sm.rules, shippingCarrierAccount: "on", shippingLocalPickup: "on", ...(taxOn ? { taxMode: "stripe" } : {}) });
    const tag = `${sm.name} / tax ${taxOn ? "on" : "off"} / ${d.name}${paperwork ? " / paperwork" : ""}`;
    const q = await price(3, { paperwork });
    if (q.status !== 200) { R.finding(`${tag}: quote refused`, `${q.status} ${q.text.slice(0, 120)}`); continue; }
    const view = (await h.get(`/api/quote/${q.body.quoteId}`, buyer)).body;
    const method = d.name;
    const opt = view.checkout.options.find((o) => o.method === method);
    if (!opt) { R.finding(`${tag}: the page was not offered this choice`); continue; }
    const shown = opt.total;
    // A page that confirms a total one cent away from the shown one is asked to confirm; the shown one passes.
    const off = await checkout(q.body.quoteId, { ...d.body, confirmedTotal: shown + 0.02 });
    const c = await checkout(q.body.quoteId, { ...d.body, confirmedTotal: shown });
    if (c.status !== 200) { R.finding(`${tag}: checkout refused at the shown total`, `${c.status} ${c.text.slice(0, 160)}`); continue; }
    const order = ordersDB.getById(c.body.orderId);
    const args = lastArgs();
    const session = sessionOfUrl(c.body.sessionUrl);
    const lines = sumLines(args);
    const pieces = c100(order.subtotal) + c100(order.leadTimeSurcharge) + c100(order.shippingCost) + c100(order.paperworkFee);
    const ok = off.status === 409 && c100(order.total) === c100(shown) && lines === c100(shown) && expectedCharge(order).cents === lines && pieces === c100(order.total)
      && Boolean(args.automatic_tax && args.automatic_tax.enabled) === taxOn;
    // Pay it exactly as Stripe reports it (with the stand-in's 7 % when tax is on).
    const w = await h.completed(session.id);
    const paid = ordersDB.getById(order.id);
    const taxCents = session.total_details.amount_tax || 0;
    const settled = paid.status === "paid" && c100(paid.amountPaid) === session.amount_total && c100(paid.total) === lines + taxCents && c100(paid.tax || 0) === taxCents && !paid.attention;
    R.check(ok && settled && w.status === 200, tag, `shown $${shown} order $${order.total} lines ${lines}c tax ${taxCents}c paid $${paid.amountPaid} status ${paid.status}${paid.attention ? " FLAG " + paid.attention : ""} off-by-2c→${off.status}`);
  }

  // ── 2. Two tabs: delivery switched after a session exists ────────────────────────────────────
  console.log("\n2. two tabs: the cheap session must not pay the dear order");
  await settings({ shippingLocalPickup: "on", shippingCarrierAccount: "on" });
  {
    const q = await price(4);
    const a = await checkout(q.body.quoteId, { shippingOption: "pickup" });
    const sA = sessionOfUrl(a.body.sessionUrl);
    const b = await checkout(q.body.quoteId, {}); // tab 2: ship
    const sB = sessionOfUrl(b.body.sessionUrl);
    const order = ordersDB.getById(a.body.orderId);
    R.check(a.body.orderId === b.body.orderId && sA.id !== sB.id && sA.status === "expired" && sA.amount_total < sB.amount_total, "pickup then ship: one order, the pickup session is closed at Stripe", `A ${sA.amount_total}c (${sA.status}) B ${sB.amount_total}c order $${order.total}`);
    // Stripe took the money on A anyway (a race Stripe documents: expire can lose to a payment in flight).
    Object.assign(sA, { status: "complete", payment_status: "paid", payment_intent: "pi_race_A" });
    await h.webhook("checkout.session.completed", sA);
    const after = ordersDB.getById(order.id);
    R.check(after.status !== "paid" && Boolean(after.attention), "the closed pickup session paid late does NOT release the ship order", `status ${after.status}, flag ${after.attention}, shop emails ${h.sent.filter((m) => /owner@shop.test/.test(String(m.to))).length}`);
  }
  {
    // The payment lands first (no webhook yet), then tab 2 switches the delivery choice.
    const q = await price(4);
    const a = await checkout(q.body.quoteId, { shippingOption: "pickup" });
    const sA = sessionOfUrl(a.body.sessionUrl);
    h.pay(sA.id);
    const b = await checkout(q.body.quoteId, {});
    const after = ordersDB.getById(a.body.orderId);
    const shipTotal = (await h.get(`/api/quote/${q.body.quoteId}`, buyer)).body.checkout.options.find((o) => o.method === "ship").total;
    if (after.status === "paid" && after.shippingMethod !== "pickup") R.finding("paid at the PICKUP price, order then switched to SHIP and released", `paid ${after.amountPaid}, order total ${after.total}, ship total ${shipTotal}, method ${after.shippingMethod}`);
    else R.holds("pickup paid, then switched to ship before the webhook: not released as a ship order at the pickup price", `checkout answer ${b.status} ${b.body.code || ""}; order status ${after.status}, method ${after.shippingMethod}, total $${after.total}, paid ${after.amountPaid ?? "-"}, flag ${after.attention || "-"}`);
    if (after.status !== "paid") R.info("…but a buyer who paid the right price for pickup now has an order that is flagged, with its delivery choice overwritten", `method ${after.shippingMethod}, total $${after.total}, amount received ${sA.amount_total / 100}`);
  }

  // ── 3. Amounts and flags sent by the browser ─────────────────────────────────────────────────
  console.log("\n3. nothing the browser sends is an amount");
  await settings({ shippingMethod: "table", shippingRateTable: TABLE, taxMode: "stripe" });
  {
    const q = await price(3);
    const c = await checkout(q.body.quoteId, { shippingCost: 0, total: 1, subtotal: 1, tax: 0, taxExempt: true, taxExemptReason: "resale", taxMode: "off", shippingMode: "included", packedWeightLb: 0.1, shippingOption: "ship", paperworkFee: -50, discount: 99 });
    const order = c.status === 200 ? ordersDB.getById(c.body.orderId) : null;
    R.check(order && c100(order.total) === c100(q.body.orderTotal) && order.taxMode === "stripe" && !order.taxExempt && sumLines(lastArgs()) === c100(q.body.orderTotal), "hand-built body with amounts, weights, modes and an exemption flag changes nothing", order ? `order $${order.total}, taxMode ${order.taxMode}, exempt ${order.taxExempt}` : `${c.status} ${c.text.slice(0, 100)}`);
    const off = await checkout((await price(2)).body.quoteId, { shippingOption: "pickup" });
    R.check(off.status === 400, "a delivery choice that is switched off is refused", `${off.status} ${off.body.code}`);
  }

  // ── 4. Replays, out-of-order events, late payment ────────────────────────────────────────────
  console.log("\n4. replayed and out-of-order events; a lapsed order paid late");
  await settings({});
  {
    const q = await price(2);
    const c = await checkout(q.body.quoteId);
    const s = sessionOfUrl(c.body.sessionUrl);
    // expired arrives BEFORE completed for the same session (out of order), then completed twice.
    await h.webhook("checkout.session.expired", { ...s, status: "expired" });
    const mid = ordersDB.getById(c.body.orderId).status;
    await h.completed(s.id, {});
    await h.completed(s.id, {});
    const o = ordersDB.getById(c.body.orderId);
    const paidMails = h.sent.filter((m) => m.to === "dana@buyer.test" && new RegExp(String(o.id).slice(0, 8), "i").test(m.subject + m.text) && /confirm|received|thank/i.test(m.subject)).length;
    R.info("expired-then-completed for one session", `after expired: ${mid}; after completed x2: ${o.status}, flag ${o.attention || "-"}, amountPaid ${o.amountPaid ?? "-"}, buyer mails ${paidMails}`);
    R.check(o.status === "paid" || Boolean(o.attention), "a payment after an 'expired' event is never dropped (paid, or flagged for the owner)");
  }
  {
    const q = await price(2);
    const c = await checkout(q.body.quoteId);
    const s = sessionOfUrl(c.body.sessionUrl);
    await h.sweep(); // a day later: the order lapses
    const lapsed = ordersDB.getById(c.body.orderId);
    await h.completed(s.id);
    const o = ordersDB.getById(c.body.orderId);
    R.check(lapsed.status === "expired" && o.status !== "paid" ? Boolean(o.attention) : true, "an order that lapsed and is then paid: recorded and flagged, never silently lost", `lapsed ${lapsed.status} → ${o.status}, flag ${o.attention || "-"}`);
    // The quote was given back when the order lapsed: can it be ordered again, and would the buyer then pay twice?
    const again = await checkout(q.body.quoteId);
    R.info("the quote of a lapsed-then-paid order", `second checkout answers ${again.status} ${again.body.code || ""}${again.status === 200 ? " (a second order for the same quote; the first payment sits flagged)" : ""}`);
  }
  {
    // A refund event before the completed event; a refund larger than what was paid.
    const q = await price(2);
    const c = await checkout(q.body.quoteId);
    const s = sessionOfUrl(c.body.sessionUrl);
    h.pay(s.id);
    await h.webhook("charge.refunded", { id: "ch_early", object: "charge", payment_intent: s.payment_intent, amount: s.amount_total, amount_refunded: s.amount_total, currency: "usd", refunded: true, metadata: { orderId: c.body.orderId } });
    const mid = ordersDB.getById(c.body.orderId);
    await h.completed(s.id);
    const o = ordersDB.getById(c.body.orderId);
    R.check(!(o.status === "paid" && !o.attention && !(Number(o.refundedAmount) > 0)), "refund-before-completed does not leave a fully refunded order sitting 'paid' with no mark", `after refund: ${mid.status}/${mid.attention || "-"}; after completed: ${o.status}, refunded ${o.refundedAmount ?? "-"}, flag ${o.attention || "-"}`);
  }

  // ── 5. Weight edge cases under each mode ─────────────────────────────────────────────────────
  console.log("\n5. weights the shipping line is charged from");
  for (const mode of ["formula", "table"]) {
    await settings(mode === "table" ? { shippingMethod: "table", shippingRateTable: TABLE } : {});
    const q = await price(2);
    const stored = quotesDB.getById(q.body.quoteId);
    for (const [label, w] of [["zero", 0], ["negative", -5], ["NaN", NaN], ["huge", 1e9], ["missing", undefined]]) {
      quotesDB.update(q.body.quoteId, { lineItems: stored.lineItems.map((li) => ({ ...li, weight: w === undefined ? undefined : { ...li.weight, total: w } })) });
      const view = (await h.get(`/api/quote/${q.body.quoteId}`, buyer)).body;
      const opt = view.checkout.options[0];
      R.info(`${mode}: stored line weight ${label}`, `page shows shipping ${opt.shippingText} total ${opt.total}; quote total $${q.body.orderTotal}`);
    }
    const c = await checkout(q.body.quoteId);
    const order = c.status === 200 ? ordersDB.getById(c.body.orderId) : null;
    R.check(order && c100(order.total) === c100(q.body.orderTotal), `${mode}: with the stored weights tampered, checkout still charges the real total (it prices again)`, order ? `$${order.total}` : `${c.status} ${c.body.code}`);
  }

  // ── 6. A DXF's units changed during checkout ─────────────────────────────────────────────────
  console.log("\n6. DXF units change around checkout");
  await settings({});
  {
    const up = await h.form("/api/upload", {}, { files: { name: "plate.dxf", data: rectDxf(10, 10) } }, buyer);
    const dxfId = up.body.parts[0].partId;
    const m = h.models.materialsDB.getAll().find((x) => x.slug === "rt-hdpe");
    const cfg = { partId: dxfId, materialSlug: "rt-hdpe", grade: m.grades[0].name, finishSlug: "", quantity: 2, process: "routing", thicknessMm: m.thicknesses[m.thicknesses.length - 1].mm };
    const q = await h.post("/api/quote", { parts: [cfg], leadTimeSlug: "standard" }, buyer);
    if (q.status !== 200) throw new Error(`section 6 setup: ${q.status} ${q.text.slice(0, 200)}`);
    const before = q.body.orderTotal;
    // Tab 2 says the drawing is in millimetres (25.4x smaller) while tab 1 still shows the inch price.
    const u = await h.post(`/api/parts/${dxfId}/units`, { units: "mm", editKey: h.editKeys[dxfId] }, buyer);
    const c = await checkout(q.body.quoteId, { confirmedTotal: before });
    const order = c.status === 200 ? ordersDB.getById(c.body.orderId) : null;
    const now = (await h.get(`/api/quote/${q.body.quoteId}`, buyer)).body.orderTotal;
    R.check(!(order && Math.abs(order.total - before) < 0.01 && Math.abs(now - before) > 0.01), "units → mm in tab 2, pay in tab 1 at the inch total: the buyer is asked, not charged the stale total", `units ${u.status}; inch total $${before}; mm total $${now}; checkout ${c.status} ${c.body.code || ""}${order ? ` order $${order.total}` : ""}`);
    // And the cheap way round: price as mm (small), switch to inch (big), pay the small total.
    const c2 = await checkout(q.body.quoteId, { confirmedTotal: now });
    const small = c2.status === 200 ? ordersDB.getById(c2.body.orderId) : null;
    const u2 = await h.post(`/api/parts/${dxfId}/units`, { units: "in", editKey: h.editKeys[dxfId] }, buyer);
    const part = partsDB.getById(dxfId);
    R.check(u2.status === 409 || !small, "after an order exists the drawing's units cannot be changed under it", `order made ${Boolean(small)} at $${small && small.total}; units→in answered ${u2.status} ${u2.body.code || ""}; stored units ${part.geometry && part.geometry.units}`);
  }

  // ── 7. Promotion codes with tax ──────────────────────────────────────────────────────────────
  console.log("\n7. discounts: only when promotion codes are on, and never hiding a wrong amount");
  await settings({ taxMode: "stripe" });
  {
    const q = await price(2);
    const c = await checkout(q.body.quoteId);
    const s = sessionOfUrl(c.body.sessionUrl);
    const pre = sumLines(lastArgs());
    // Stripe reports a 100 % discount though codes are off, with tax zero.
    Object.assign(s, { amount_total: 0, total_details: { amount_discount: pre, amount_tax: 0 } });
    await h.completed(s.id);
    const o = ordersDB.getById(c.body.orderId);
    R.check(o.status !== "paid", "a 100 % discount on a session opened with codes off does not release the order", `status ${o.status}, flag ${o.attention || "-"}`);
    // Tax larger than the whole charge / tax used to hide a short payment.
    const q2 = await price(2);
    const c2 = await checkout(q2.body.quoteId);
    const s2 = sessionOfUrl(c2.body.sessionUrl);
    const pre2 = sumLines(lastArgs());
    Object.assign(s2, { amount_total: pre2 - 500 + 500, total_details: { amount_discount: 0, amount_tax: 500 } }); // paid the pre-tax figure, "500 of it is tax"
    await h.completed(s2.id);
    const o2 = ordersDB.getById(c2.body.orderId);
    R.check(o2.status !== "paid", "a payment $5 short whose report labels $5 of it as tax is not accepted as paid in full", `status ${o2.status}, flag ${o2.attention || "-"}`);
  }

  // ── 8. Pay twice? ────────────────────────────────────────────────────────────────────────────
  console.log("\n8. one quote, one order, one payment");
  await settings({});
  {
    const q = await price(3);
    h.stripe.delayMs = 150; // Stripe takes a moment: both presses are in flight together
    const [a, b, c3] = await Promise.all([checkout(q.body.quoteId), checkout(q.body.quoteId), checkout(q.body.quoteId)]);
    h.stripe.delayMs = 0;
    const orders = ordersDB.query((o) => o.quoteId === q.body.quoteId);
    const urls = new Set([a, b, c3].filter((r) => r.status === 200).map((r) => r.body.sessionUrl));
    const open = Object.values(h.stripe.sessions).filter((x) => x.metadata && x.metadata.orderId === (orders[0] && orders[0].id) && x.status === "open");
    R.check(orders.length === 1 && urls.size === 1 && open.length === 1, "three presses of pay at once: one order, one payment page", `answers ${[a, b, c3].map((r) => r.status).join(" ")}; orders ${orders.length}; distinct pages ${urls.size}; open sessions at Stripe ${open.length}`);
    await h.completed(open[0].id);
    const again = await checkout(q.body.quoteId);
    const paid = ordersDB.getById(orders[0].id);
    R.check(paid.status === "paid" && again.status === 409 && again.body.code === "quote-already-ordered", "after payment the same quote cannot be checked out again", `order ${paid.status}; second checkout ${again.status} ${again.body.code}`);
    // The same payment reported twice by webhook and once by the return page.
    const mailsBefore = h.sent.length;
    await h.completed(open[0].id);
    const conf = await h.post(`/api/orders/${orders[0].id}/confirm-payment`, {}, buyer);
    const after = ordersDB.getById(orders[0].id);
    R.check(after.status === "paid" && !after.attention && h.sent.length === mailsBefore, "the same payment reported again (webhook, return page): nothing changes, nobody is emailed twice, no 'duplicate payment' flag", `status ${after.status}, flag ${after.attention || "-"}, new emails ${h.sent.length - mailsBefore}, confirm ${conf.status}`);
    // A second, different payment for an order that is already paid (the buyer paid an old page too).
    const q2 = await price(3);
    const c1 = await checkout(q2.body.quoteId);
    const s1 = sessionOfUrl(c1.body.sessionUrl);
    const c2 = await checkout(q2.body.quoteId, { shippingName: "Dana B. Buyer" }); // same amount: the page is handed out again
    const s2 = sessionOfUrl(c2.body.sessionUrl);
    await h.completed(s1.id);
    if (s2.id !== s1.id) {
      Object.assign(s2, { status: "open" });
      await h.completed(s2.id);
      const o = ordersDB.getById(c1.body.orderId);
      R.check(o.status === "paid" && o.attention === "duplicate-payment", "a second payment on another page of the same order is recorded and flagged for a refund", `status ${o.status}, flag ${o.attention}`);
    } else R.holds("a second press with the same amount is handed the same payment page (there is no second page to pay)", `${s1.id}`);
  }

  await settings({});
  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
