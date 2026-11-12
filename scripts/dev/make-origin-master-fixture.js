/**
 * How server/models/fixtures/origin-master-orders.db was made (2026-11-11), kept so it can be made again.
 *
 * Run with the code of origin/master, not this branch:
 *
 *   mkdir /tmp/om && git archive origin/master | tar -x -C /tmp/om && cd /tmp/om && npm install
 *   node <this repo>/scripts/dev/make-origin-master-fixture.js <this repo>/server/models/fixtures/origin-master-orders.db
 *
 * It uses origin/master's own test harness (Stripe stubbed, mail captured) to make a database
 * holding a paid order, an order awaiting payment, a quoted firm quote, a firm quote accepted on
 * a PO and one accepted by card and not yet paid, and copies the database file to argv[2] with a
 * .json beside it naming the rows. No real data: test addresses, the harness's fixed test
 * signing secret and a throwaway password.
 *
 * server/models/orderLifecycleMigration.test.js opens a copy of that file with today's code.
 */
const fs = require("fs");
const path = require("path");
(async () => {
  const root = process.cwd();
  const h = await require(path.join(root, "server", "testSupport", "harness")).start();
  const SHIP = { shippingName: "Legacy Buyer", shippingAddress: "1 Fixture St", shippingCity: "Testville", shippingState: "IL", shippingZip: "60000", shippingCountry: "US" };
  const owner = await h.register("owner@shop.test", "Owner");
  const buyer = await h.register("legacy-buyer@fixture.test", "Legacy Buyer");
  const partId = await h.uploadCube();
  // 1. a paid order
  const q1 = await h.post("/api/quote", { parts: [h.cncConfig(partId, 3)], leadTimeSlug: "standard" }, buyer);
  const c1 = await h.post("/api/orders/checkout-session", { quoteId: q1.body.quoteId, ...SHIP }, buyer);
  if (c1.status !== 200) throw new Error("checkout 1: " + c1.text);
  h.pay(h.models.ordersDB.getById(c1.body.orderId).stripeSessionId);
  const paid = await h.post(`/api/orders/${c1.body.orderId}/confirm-payment`, {}, buyer);
  if (paid.body.status !== "paid") throw new Error("not paid: " + paid.text);
  // 2. an order awaiting payment
  const q2 = await h.post("/api/quote", { parts: [h.cncConfig(partId, 5)], leadTimeSlug: "standard" }, buyer);
  const c2 = await h.post("/api/orders/checkout-session", { quoteId: q2.body.quoteId, ...SHIP }, buyer);
  if (c2.status !== 200) throw new Error("checkout 2: " + c2.text);
  // 3. a quoted firm quote (sent, not accepted)
  const r3 = await h.form("/api/rfq", { contactName: "Legacy Quoted", email: "legacy-quoted@fixture.test", company: "Fixture Co", notes: "quoted, not yet accepted", quantities: "250" });
  if (r3.status !== 201) throw new Error("rfq 3: " + r3.text);
  h.sent.length = 0;
  const s3 = await h.put(`/api/rfq/admin/${r3.body.rfqId}`, { status: "quoted", quotedTotal: 1850, quotedLeadDays: 12 }, owner);
  if (s3.status !== 200) throw new Error("quote 3: " + s3.text);
  const link3 = (h.sent.map((m) => (m.text.match(/firm-quote\/(\S+)/) || [])[1]).filter(Boolean))[0];
  // 4. a firm quote accepted on a PO (an order "PO to confirm")
  const r4 = await h.form("/api/rfq", { contactName: "Legacy Po", email: "legacy-po@fixture.test", notes: "accepted on a PO", quantities: "40" });
  h.sent.length = 0;
  await h.put(`/api/rfq/admin/${r4.body.rfqId}`, { status: "quoted", quotedTotal: 640, quotedLeadDays: 8 }, owner);
  const link4 = (h.sent.map((m) => (m.text.match(/firm-quote\/(\S+)/) || [])[1]).filter(Boolean))[0];
  const a4 = await h.post(`/api/rfq/quote/${link4}/accept`, { method: "po", poNumber: "PO-LEGACY-7", ...SHIP });
  if (a4.status !== 201) throw new Error("accept 4: " + a4.text);
  // 5. a firm quote accepted by card, payment not finished
  const r5 = await h.form("/api/rfq", { contactName: "Legacy Card", email: "legacy-card@fixture.test", notes: "accepted by card, unpaid", quantities: "12" });
  h.sent.length = 0;
  await h.put(`/api/rfq/admin/${r5.body.rfqId}`, { status: "quoted", quotedTotal: 990, quotedLeadDays: 6 }, owner);
  const link5 = (h.sent.map((m) => (m.text.match(/firm-quote\/(\S+)/) || [])[1]).filter(Boolean))[0];
  const a5 = await h.post(`/api/rfq/quote/${link5}/accept`, { method: "card", ...SHIP });
  if (a5.status !== 201) throw new Error("accept 5: " + a5.text);

  // 6. a saved quote that was never ordered (added 2026-11-12 for scripts/dev/upgrade-proof.js; made last, so the
  //    rows above are exactly what they were when the committed fixture was written, which predates this step)
  const q6 = await h.post("/api/quote", { parts: [h.cncConfig(partId, 4)], leadTimeSlug: "standard" }, buyer);
  if (q6.status !== 200) throw new Error("quote 6: " + q6.text);

  const out = process.argv[2];
  fs.copyFileSync(process.env.QUOTING_DB_PATH, out);
  fs.writeFileSync(out.replace(/\.db$/, ".json"), JSON.stringify({
    madeWith: "origin/master", jwtSecret: "test-secret (the test harness's fixed value; not a real secret)",
    buyer: { email: "legacy-buyer@fixture.test", password: "Passw0rd1" },
    paidOrder: c1.body.orderId, pendingOrder: c2.body.orderId, pendingQuote: q2.body.quoteId,
    savedQuote: q6.body.quoteId, savedQuoteTotal: q6.body.total,
    quotedRfq: r3.body.rfqId, quotedLink: link3,
    poRfq: r4.body.rfqId, poLink: link4,
    cardRfq: r5.body.rfqId, cardLink: link5,
    sessions: Object.fromEntries(Object.entries(h.stripe.sessions).map(([id, s]) => [id, { amount_total: s.amount_total, orderId: s.metadata.orderId, payment_status: s.payment_status }])),
  }, null, 2));
  console.log("fixture written:", out, fs.statSync(out).size, "bytes");
  await h.stop();
})().catch((e) => { console.error(e); process.exit(1); });
