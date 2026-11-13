/**
 * A refund that Stripe reports before it reports the payment (independent re-review 2026-11-12, F-07).
 * Run: node server/services/refundBeforePaid.test.js
 *
 * Stripe does not promise the order its events arrive in. Before: a full refund delivered before
 * "checkout.session.completed" left the order paid, with the whole amount shown as refunded, no flag,
 * and still in the work queue; the same two events the usual way round ended "refunded". The first
 * case below fails on that code.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("A refund reported before the payment");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

let h, models, admin, n = 0;
async function unpaid() {
  const email = `refund${++n}@buyer.test`;
  const token = await h.register(email);
  const data = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl"));
  const up = await h.form("/api/upload", {}, { files: { name: "cube_20mm.stl", data } }, token);
  const q = await h.post("/api/quote", { parts: [h.cncConfig(up.body.parts[0].partId, 1)], leadTimeSlug: "standard" }, token);
  const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, token);
  assert.strictEqual(c.status, 200, c.text.slice(0, 200));
  h.sent.length = 0;
  return { email, token, orderId: c.body.orderId, sessionId: String(c.body.sessionUrl).split("/").pop() };
}
const order = (id) => models.ordersDB.getById(id);
const refundEvent = (o, session, cents) => h.webhook("charge.refunded", { id: `ch_${o.sessionId}`, object: "charge", payment_intent: session.payment_intent, amount: session.amount_total, amount_captured: session.amount_total, amount_refunded: cents, currency: "usd", refunded: cents >= session.amount_total, metadata: { orderId: o.orderId } });
const state = (id) => { const x = order(id); return { status: x.status, refunded: Math.round(Number(x.refundedAmount || 0) * 100), paid: Math.round(Number(x.amountPaid || 0) * 100), attention: x.attention || null, hasPaidAt: Boolean(x.paidAt), paymentId: Boolean(x.stripePaymentId) }; };
const inQueue = async (id) => { const r = await h.get("/api/orders/admin/queue", admin); assert.strictEqual(r.status, 200, r.text.slice(0, 200)); return JSON.stringify(r.body).includes(id); };

test("setup", async () => {
  h = await start({ mailer: "configured" });
  models = h.models;
  admin = await h.admin();
});

test("refunded in full, the refund reported first: the order ends refunded and out of the queue, exactly as when the two arrive the usual way round", async () => {
  // The usual way round.
  const usual = await unpaid();
  const s1 = h.pay(usual.sessionId);
  await h.webhook("checkout.session.completed", s1);
  assert.strictEqual(await inQueue(usual.orderId), true, "a paid order is in the work queue");
  await refundEvent(usual, s1, s1.amount_total);
  const want = state(usual.orderId);
  assert.deepStrictEqual([want.status, want.refunded, want.attention], ["refunded", s1.amount_total, null]);

  // The refund first.
  const early = await unpaid();
  const s2 = h.pay(early.sessionId); // Stripe has the payment; nothing has been reported yet
  const r1 = await refundEvent(early, s2, s2.amount_total);
  assert.strictEqual(r1.status, 200, r1.text);
  assert.strictEqual(order(early.orderId).status, "pending_payment", "not yet reported paid");
  const r2 = await h.webhook("checkout.session.completed", s2);
  assert.strictEqual(r2.status, 200, r2.text);
  const got = state(early.orderId);
  assert.deepStrictEqual({ ...got, refunded: got.refunded - s2.amount_total, paid: got.paid - s2.amount_total }, { ...want, refunded: want.refunded - s1.amount_total, paid: want.paid - s1.amount_total }, "the same end state");
  assert.strictEqual(got.status, "refunded");
  assert.strictEqual(await inQueue(early.orderId), false, "a refunded order is not in the work queue");
  // The buyer is not sent "your order is confirmed" for an order whose money has gone back; the shop was told of the refund, once.
  assert.strictEqual(h.sent.filter((m) => m.to === early.email).length, 0, h.sent.map((m) => `${m.to}: ${m.subject}`).join(" | "));
  assert.strictEqual(h.sent.filter((m) => /refunded in full/i.test(m.subject)).length, 1, h.sent.map((m) => `${m.to}: ${m.subject}`).join(" | "));
  assert.strictEqual(h.sent.filter((m) => /new order/i.test(m.subject)).length, 0);
  // Both events again, either way round: nothing moves and nobody is written to.
  const before = JSON.stringify(order(early.orderId));
  const mails = h.sent.length;
  await h.webhook("checkout.session.completed", s2);
  await refundEvent(early, s2, s2.amount_total);
  assert.strictEqual(JSON.stringify(order(early.orderId)), before);
  assert.strictEqual(h.sent.length, mails);
});

test("refunded in part, the refund reported first: the order ends paid with the part refunded shown, as the usual way round, and the buyer gets the confirmation", async () => {
  const usual = await unpaid();
  const s1 = h.pay(usual.sessionId);
  await h.webhook("checkout.session.completed", s1);
  await refundEvent(usual, s1, 1000);
  const want = state(usual.orderId);
  assert.deepStrictEqual([want.status, want.refunded], ["paid", 1000]);

  const early = await unpaid();
  const s2 = h.pay(early.sessionId);
  await refundEvent(early, s2, 1000);
  await h.webhook("checkout.session.completed", s2);
  const got = state(early.orderId);
  assert.deepStrictEqual({ ...got, paid: 0 }, { ...want, paid: 0 });
  assert.strictEqual(await inQueue(early.orderId), true, "still to be made");
  assert.strictEqual(h.sent.filter((m) => m.to === early.email).length, 1, "the buyer's confirmation");
  assert.strictEqual(h.sent.filter((m) => /new order/i.test(m.subject)).length, 1);
});

test("the payment is found by the sweep instead of by its event, after the refund: the same end", async () => {
  const early = await unpaid();
  const s = h.pay(early.sessionId);
  await refundEvent(early, s, s.amount_total);
  const r = await h.post(`/api/orders/${early.orderId}/confirm-payment`, {}, early.token); // the return page asks Stripe
  assert.strictEqual(r.status, 200, r.text.slice(0, 200));
  assert.strictEqual(order(early.orderId).status, "refunded");
  assert.strictEqual(await inQueue(early.orderId), false);
});

run(() => h.stop());
