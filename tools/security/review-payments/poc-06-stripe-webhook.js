/**
 * Stripe session and webhook: signature handling, replay, event shapes, and every
 * non-webhook way an order can move to paid.
 *
 * Runs the server three ways: with a webhook secret (production), with none, and with
 * an empty one; plus a non-production start with the test switch to show what it opens.
 *
 * Run: node tools/security/review-payments/poc-06-stripe-webhook.js
 */
const { start, report, money, SHIP } = require("./lib");

async function newPendingOrder(h, buyer, qty = 2) {
  const cube = await h.upload("cube_20mm.stl");
  const q = await h.post("/api/quote", { parts: [{ partId: cube.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity: qty }], leadTimeSlug: "standard" });
  const co = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
  return { orderId: co.body.orderId, session: h.lastSession(), quoteId: q.body.quoteId };
}

(async () => {
  const r = report("Stripe webhook and payment state");
  let h = await start();
  try {
    const buyer = await h.register("hook@example.test");
    const other = await h.register("hook-other@example.test");
    const admin = await h.admin();
    const status = async (id) => (await h.get(`/api/orders/${id}`, admin)).body.status;
    const shopNotices = () => h.s.mail(null, /New order/i).length;

    // ── signature ──
    let o = await newPendingOrder(h, buyer);
    const ev = h.completed(o.session);
    const tries = {
      "no signature header": await h.webhook(ev, { sign: false }),
      "signed with another secret": await h.webhook(ev, { sign: "whsec_not_the_servers_secret" }),
      "signature 10 minutes old": await h.webhook(ev, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
      "valid signature, body changed after signing": await (async () => { const sdk = require("../../../node_modules/stripe")("sk_test_x"); const payload = JSON.stringify(ev); const header = sdk.webhooks.generateTestHeaderString({ payload, secret: h.whsec }); return h.webhook(null, { header, rawBody: payload.replace(/"amount_total":\d+/, '"amount_total":1') }); })(),
      "valid signature, Content-Type text/plain": await h.webhook(ev, { contentType: "text/plain" }),
      "header 'v1=' with no timestamp": await h.webhook(ev, { header: "v1=00" }),
    };
    r.note(Object.entries(tries).map(([k, v]) => `${k}: ${v.status}`).join("; "));
    r.finding(Object.values(tries).some((v) => v.status === 200) || (await status(o.orderId)) !== "pending_payment", "an unsigned, mis-signed, stale or altered event is accepted");

    // ── valid event, then replays ──
    const before = shopNotices();
    const ok = await h.webhook(ev);
    const again = await h.webhook(ev);
    const again2 = await h.webhook(h.completed(o.session)); // same session, new event id
    r.note(`valid event: ${ok.status}, order "${await status(o.orderId)}"; replayed twice: ${again.status}, ${again2.status}; shop "new order" emails sent: ${shopNotices() - before}`);
    r.finding(shopNotices() - before !== 1, "a replayed checkout.session.completed re-runs the paid step (duplicate emails / state change)");

    // ── amount, currency, session identity ──
    o = await newPendingOrder(h, buyer);
    await h.webhook(h.completed(o.session, { amount_subtotal: 100, amount_total: 100 }));
    const st1 = await status(o.orderId);
    const queue = (await h.get("/api/orders/admin/queue", admin)).body.some((x) => x.id === o.orderId);
    const put = await h.put(`/api/orders/${o.orderId}/status`, { status: "paid_amount_mismatch" }, admin);
    r.note(`event says $1.00 was charged for a ${money(o.session.amount_total / 100)} order: order "${st1}"; in the admin production queue: ${queue}; admin can set that status by hand: ${put.status}`);
    r.finding(st1 === "paid", "an event with a lower amount marks the order plainly paid");

    o = await newPendingOrder(h, buyer);
    await h.webhook(h.completed(o.session, { amount_subtotal: undefined, amount_total: undefined }));
    const stNoAmount = await status(o.orderId);
    o = await newPendingOrder(h, buyer);
    await h.webhook(h.completed(o.session, { amount_subtotal: 0, amount_total: 0 }));
    const stZero = await status(o.orderId);
    r.note(`signed event with no amounts: "${stNoAmount}"; with amount 0: "${stZero}"`);
    r.finding(stNoAmount === "paid" || stZero === "paid", "F-06a: a signed event that carries no amount, or amount 0, marks the order paid without comparing anything (orderEvents.js:126 skips the check when the amount is falsy)");

    o = await newPendingOrder(h, buyer);
    await h.webhook(h.completed(o.session, { currency: "jpy" }));
    const stCur = await status(o.orderId);
    r.finding(stCur === "paid", `F-06b: currency is not compared: an event for ${o.session.amount_total} JPY (about ${money(o.session.amount_total / 150)}) settles a ${money(o.session.amount_total / 100)} order as "${stCur}"`);

    o = await newPendingOrder(h, buyer);
    await h.webhook(h.completed({ id: "cs_live_made_elsewhere", object: "checkout.session", amount_total: o.session.amount_total, amount_subtotal: o.session.amount_total, currency: "usd", metadata: { orderId: o.orderId } }));
    const stForeign = await status(o.orderId);
    r.finding(stForeign === "paid", `F-06c: the event's session id is not compared with the session the server created for the order: a signed event for session "cs_live_made_elsewhere" settles it ("${stForeign}")`);

    o = await newPendingOrder(h, buyer);
    await h.webhook(h.completed(o.session, { payment_status: "unpaid" }));
    const stUnpaid = await status(o.orderId);
    await h.webhook({ id: "evt_x", type: "checkout.session.async_payment_failed", data: { object: o.session } });
    await h.webhook({ id: "evt_y", type: "checkout.session.expired", data: { object: { ...o.session, status: "expired" } } });
    // (Updated with the order-lifecycle fixes: an expired-session event now closes the unpaid order out as "expired", which is not "paid".)
    const stAfterExpired = await status(o.orderId);
    r.note(`unpaid event: "${stUnpaid}"; after the failed and expired events: "${stAfterExpired}"`);
    r.finding(stUnpaid !== "pending_payment" || !["pending_payment", "expired"].includes(stAfterExpired), "an unpaid / failed / expired session event marks the order paid");

    // ── events the server does not handle ──
    o = await newPendingOrder(h, buyer);
    await h.webhook(h.completed(o.session));
    const refund = await h.webhook({ id: "evt_r", type: "charge.refunded", data: { object: { id: "ch_1", amount_refunded: o.session.amount_total, metadata: { orderId: o.orderId } } } });
    const dispute = await h.webhook({ id: "evt_d", type: "charge.dispute.created", data: { object: { id: "dp_1", amount: o.session.amount_total } } });
    const stRefunded = await status(o.orderId);
    r.note(`charge.refunded: ${refund.status}; charge.dispute.created: ${dispute.status}; order afterwards: "${stRefunded}"`);
    const inQueueAfter = (await h.get("/api/orders/admin/queue", admin)).body.some((x) => x.id === o.orderId);
    r.note(`  still in the production queue: ${inQueueAfter}; emails to the shop about it: ${h.s.mail(null, /refunded|disputed/i).length}`);
    r.finding(stRefunded === "paid", "F-07: a refund or dispute in Stripe changes nothing here: the order stays \"paid\" and in the production queue");
    const noMeta = await h.webhook(h.completed({ id: "cs_other_product", amount_total: 500, metadata: {} }));
    r.note(`checkout.session.completed with no orderId (a payment link or another site on the same Stripe account): ${noMeta.status} — Stripe retries non-2xx for days and can disable the endpoint`);
    r.finding(noMeta.status !== 200, "I-1: a completed checkout that is not one of our orders is answered with an error, so Stripe keeps retrying it");

    // ── the other ways to "paid" ──
    o = await newPendingOrder(h, buyer);
    const c1 = await h.post(`/api/orders/${o.orderId}/confirm-payment`, {}, buyer);
    const c2 = await h.post(`/api/orders/${o.orderId}/confirm-payment`, {}, other);
    const visit = await h.get(`/orders/${o.orderId}?paid=true`, buyer);
    const s3 = await h.put(`/api/orders/${o.orderId}/status`, { status: "paid" }, buyer);
    r.note(`unpaid session: confirm-payment by the buyer -> ${c1.status} "${c1.body.status}"; by another account -> ${c2.status}; opening the success URL -> ${visit.status}, order "${await status(o.orderId)}"; buyer calling the admin status route -> ${s3.status}`);
    r.finding((await status(o.orderId)) !== "pending_payment", "an order can be moved to paid without a paid Stripe session");
    h.pay(o.session.id, { amount_subtotal: 100, amount_total: 100 });
    const c3 = await h.post(`/api/orders/${o.orderId}/confirm-payment`, {}, buyer);
    r.note(`session paid for $1.00 instead of ${money(o.session.amount_total / 100)}: confirm-payment -> "${c3.body.status}"`);
    r.finding(c3.body.status === "paid", "confirm-payment accepts a session paid for a different amount");

    // a second session for the same order: both stay payable
    // (Checks updated with the order-lifecycle fixes, 2026-11-11: the script now counts OPEN sessions and looks
    //  at what happens to a second, different payment, instead of assuming a second session was made.)
    o = await newPendingOrder(h, buyer);
    const reuse = await h.post("/api/orders/checkout-session", { quoteId: o.quoteId, ...SHIP }, buyer);
    const open = () => h.sessions().filter((x) => x.metadata && x.metadata.orderId === o.orderId && x.status === "open" && x.payment_status !== "paid");
    r.note(`"pay" clicked twice: same order reused (${reuse.body.orderId === o.orderId}); open Stripe sessions for it: ${open().map((x) => x.id).join(", ")}`);
    r.finding(open().length > 1, "F-08: pressing pay twice leaves two payable Stripe sessions for one order");
    // Force the situation anyway: the order is paid, and then a second, different payment for it arrives.
    await h.webhook(h.completed(o.session));
    const attentionBefore = h.s.mail(null, /needs attention/i).length;
    const second = await h.webhook(h.completed({ ...o.session, id: "cs_test_review_second_payment", payment_intent: "pi_review_second" }));
    const after = (await h.get(`/api/orders/${o.orderId}`, admin)).body;
    r.note(`a second payment for the paid order: webhook ${second.status} ${second.text}; order "${after.status}", flagged "${after.attention}"; "needs attention" emails to the shop: ${h.s.mail(null, /needs attention/i).length - attentionBefore}`);
    r.finding(!after.attention || h.s.mail(null, /needs attention/i).length - attentionBefore !== 1, "F-08: a second payment for an order that is already paid is acknowledged and ignored (taken by Stripe, recorded nowhere, nobody told)");
    await h.stop();

    // ── no secret / empty secret, production ──
    for (const [label, secret] of [["no STRIPE_WEBHOOK_SECRET", null], ["STRIPE_WEBHOOK_SECRET=\"\"", ""]]) {
      // (Updated with the order-lifecycle fixes: the server no longer starts in this configuration; the script says so and moves on.)
      try {
        h = await start({ webhookSecret: secret, env: secret === "" ? { STRIPE_WEBHOOK_SECRET: "" } : {} });
      } catch (err) {
        h = null;
        const line = String(err.output || err.message).split("\n").find((l) => /FATAL: Missing required/.test(l)) || "";
        r.note(`${label}, NODE_ENV=production: the server does not start (exit ${err.exitCode}): ${line.trim()}`);
        r.finding(err.exitCode !== 1 || !/STRIPE_WEBHOOK_SECRET/.test(line), `F-18: ${label}: the server starts in production without a webhook secret`);
        continue;
      }
      r.finding(true, `F-18: ${label}: the server starts in production without a webhook secret`);
      const b = await h.register("hook2@example.test");
      const p = await newPendingOrder(h, b);
      const unsigned = await h.webhook(h.completed(p.session), { sign: false });
      const selfSigned = await h.webhook(h.completed(p.session), { sign: "" });
      const st = (await h.get(`/api/orders/${p.orderId}`, b)).body.status;
      r.note(`${label}, NODE_ENV=production, SE_TEST_HOOKS=1: unsigned event ${unsigned.status}, event signed with an empty secret ${selfSigned.status}, order "${st}"`);
      r.finding(st !== "pending_payment", `${label}: unsigned events are honoured in production`);
      h.pay(p.session.id);
      const c = await h.post(`/api/orders/${p.orderId}/confirm-payment`, {}, b);
      r.note(`  with webhooks refused the order still settles when the buyer returns: confirm-payment -> "${c.body.status}"`);
      await h.stop();
    }

    // ── what the test switch opens outside production ──
    const live = require("../../../server/testSupport/liveServer");
    for (const [label, env] of [["NODE_ENV=staging, SE_TEST_HOOKS=1, no secret", { NODE_ENV: "staging", SE_TEST_HOOKS: "1" }], ["NODE_ENV=staging, no test switch, no secret", { NODE_ENV: "staging", SE_TEST_HOOKS: "" }]]) {
      h = await start({ webhookSecret: null, env });
      const res = await h.webhook({ id: "evt_z", type: "checkout.session.completed", data: { object: { id: "cs_x", metadata: { orderId: "00000000-0000-4000-8000-000000000000" } } } }, { sign: false });
      r.note(`${label}: unsigned event -> ${res.status} ${res.text.slice(0, 60)} (404 "Order not found" means the event was parsed and acted on)`);
      await h.stop();
    }
    h = null;
  } finally { r.done(); if (h) await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
