/**
 * Validity windows, checked by moving the stored dates (in-process test harness, same routes):
 * a 30-day instant quote and a 30-day firm quote cannot be bought after they lapse.
 *
 * Run: node tools/security/review-payments/poc-11-expiry-in-process.js
 */
const path = require("path");
const { report, SHIP, ROOT } = require("./lib");

(async () => {
  const h = await require(path.join(ROOT, "server", "testSupport", "harness")).start();
  const r = report("Validity windows (in-process)");
  try {
    const { quotesDB, rfqsDB, ordersDB } = h.models;
    const buyer = await h.register("expiry@example.test");
    const admin = await h.admin();
    const partId = await h.uploadCube();
    const past = new Date(Date.now() - 60000).toISOString();

    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId)], leadTimeSlug: "standard" });
    const first = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    quotesDB.update(q.body.quoteId, { expiresAt: past });
    const afterExpiry = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    r.note(`instant quote: checkout before expiry ${first.status}; a second "pay" on the same unpaid order after expiry ${afterExpiry.status} (${afterExpiry.body.code})`);
    r.finding(afterExpiry.status === 200, "an expired instant quote can still open a checkout session");
    // The session made before expiry stays payable at Stripe (24 h by default) and settles normally.
    h.pay(Object.keys(h.stripe.sessions).pop());
    const settle = await h.post(`/api/orders/${first.body.orderId}/confirm-payment`, {}, buyer);
    r.note(`a Stripe session opened before the quote lapsed is still honoured when paid: order "${settle.body.status}" (bounded by Stripe's own session lifetime)`);
    const c = await h.form("/api/rfq", { contactName: "Late Buyer", email: "late@example.test", notes: "expiry check" });
    const sent = await h.put(`/api/rfq/admin/${c.body.rfqId}`, { status: "quoted", quotedTotal: 900, quotedLeadDays: 5 }, admin);
    const token = sent.body.acceptUrl.split("/firm-quote/")[1];
    rfqsDB.update(c.body.rfqId, { validUntil: past });
    const stale = await h.post(`/api/rfq/quote/${token}/accept`, { ...SHIP, method: "po", poNumber: "PO-LATE" });
    r.note(`firm quote past its validity date (link not yet expired by its own clock): accept -> ${stale.status} (${stale.body.code}); request status now "${rfqsDB.getById(c.body.rfqId).status}"`);
    r.finding(stale.status === 201 || ordersDB.getAll().some((o) => o.rfqId === c.body.rfqId), "an expired firm quote can be accepted");
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
