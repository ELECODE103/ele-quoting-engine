/**
 * A paid order's emails are owed until they are sent (independent re-review 2026-11-12, F-05).
 * Run: node server/services/owedEmails.test.js
 *
 * Before: the payment was written and marked "handled", and the buyer's confirmation and the shop's
 * new-order notice were sent after it from memory. A process killed between the two left a paid
 * order nobody was told about (5 of 8 and 7 of 8 kills in the reviewer's runs), and Stripe's second
 * delivery of the event was answered "duplicate" and sent nothing. Each case below fails on that code.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Emails owed for a paid order");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

let h, models, lifecycle, owed, mailer, buyer, n = 0;
// The mail provider: takes a message (true) or refuses it (false), as the test says.
let providerUp = true;
const mailFor = (order, re) => h.sent.filter((m) => re.test(m.subject) && (m.text || "").includes(String(order).slice(0, 8).toUpperCase()));
const rowsOf = (orderId) => models.emailsOwedDB.query((r) => r.orderId === orderId);
const confirmations = (email) => h.sent.filter((m) => m.to === email && /order|Order/.test(m.subject) && !/New order|needs|attention/i.test(m.subject));
const shopNew = () => h.sent.filter((m) => /new order/i.test(m.subject));

/** A fresh account with an unpaid order. */
async function unpaid() {
  const email = `owed${++n}@buyer.test`;
  const token = await h.register(email);
  const data = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "vet-quotes", "parts", "cube_20mm.stl"));
  const up = await h.form("/api/upload", {}, { files: { name: "cube_20mm.stl", data } }, token);
  assert.strictEqual(up.status, 200, up.text.slice(0, 200));
  const q = await h.post("/api/quote", { parts: [h.cncConfig(up.body.parts[0].partId, 1)], leadTimeSlug: "standard" }, token);
  assert.strictEqual(q.status, 200, q.text.slice(0, 200));
  const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, token);
  assert.strictEqual(c.status, 200, c.text.slice(0, 200));
  h.sent.length = 0;
  return { email, token, orderId: c.body.orderId, sessionId: String(c.body.sessionUrl).split("/").pop() };
}

test("setup", async () => {
  h = await start({ mailer: "configured" });
  models = h.models;
  lifecycle = require("./orderLifecycle");
  owed = require("./owedEmails");
  mailer = require("./mailer");
  // The harness records what would be sent. Here it also answers as the provider does.
  const record = mailer.send;
  mailer.send = async (m) => { if (!providerUp) return false; await record(m); return true; };
  await h.admin();
  buyer = null;
});

test("an ordinary payment: the buyer and the shop get one email each, and what was owed is on record as sent", async () => {
  const o = await unpaid();
  const r = await h.completed(o.sessionId);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(models.ordersDB.getById(o.orderId).status, "paid");
  assert.strictEqual(confirmations(o.email).length, 1, h.sent.map((m) => `${m.to}: ${m.subject}`).join(" | "));
  assert.strictEqual(shopNew().length, 1);
  const rows = rowsOf(o.orderId);
  assert.deepStrictEqual(rows.map((x) => [x.kind, x.result, Boolean(x.doneAt)]).sort(), [["order-paid-buyer", "sent", true], ["order-paid-shop", "sent", true]]);
  // The same payment reported again, by Stripe and by the return page: nothing more is sent.
  await h.completed(o.sessionId);
  await h.post(`/api/orders/${o.orderId}/confirm-payment`, {}, o.token);
  await owed.deliver();
  assert.strictEqual(confirmations(o.email).length, 1);
  assert.strictEqual(shopNew().length, 1);
});

test("the process dies after the payment is written and before any email goes: Stripe's second delivery of the same event sends both, once", async () => {
  const o = await unpaid();
  const eventId = "evt_test_killed_before_mail";
  // What a killed process leaves: the payment applied (one database change), the event's row not yet written, no email.
  const session = h.pay(o.sessionId);
  const applied = lifecycle.applySession(o.orderId, session, { eventId, source: "stripe" });
  assert.strictEqual(applied.outcome, "paid");
  assert.strictEqual(models.ordersDB.getById(o.orderId).status, "paid");
  assert.strictEqual(h.sent.length, 0, "nobody has been told");
  assert.deepStrictEqual(rowsOf(o.orderId).map((x) => [x.kind, x.doneAt || null]).sort(), [["order-paid-buyer", null], ["order-paid-shop", null]], "and that is on record, in the same change as the payment");
  // Stripe sends the event again.
  const again = await h.webhook("checkout.session.completed", session, { id: eventId });
  assert.strictEqual(again.status, 200, again.text);
  assert.strictEqual(confirmations(o.email).length, 1, h.sent.map((m) => `${m.to}: ${m.subject}`).join(" | "));
  assert.strictEqual(shopNew().length, 1);
  // And again, and the return page: nothing more.
  await h.webhook("checkout.session.completed", session, { id: eventId });
  await h.post(`/api/orders/${o.orderId}/confirm-payment`, {}, o.token);
  assert.strictEqual(confirmations(o.email).length, 1);
  assert.strictEqual(shopNew().length, 1);
  assert.ok(rowsOf(o.orderId).every((x) => x.result === "sent"));
});

test("the same, and no second event ever comes: the next start sends both, once", async () => {
  const o = await unpaid();
  lifecycle.applySession(o.orderId, h.pay(o.sessionId), { eventId: "evt_test_never_again", source: "stripe" });
  assert.strictEqual(h.sent.length, 0);
  const r = await owed.deliver(); // what server/index.js runs at start-up (owedEmails.start())
  assert.strictEqual(r.sent, 2, JSON.stringify(r));
  assert.strictEqual(confirmations(o.email).length, 1);
  assert.strictEqual(shopNew().length, 1);
  const twice = await owed.deliver();
  assert.deepStrictEqual([twice.sent, confirmations(o.email).length, shopNew().length], [0, 1, 1]);
});

test("the mail provider refuses the messages: they stay owed, are not hammered, and go once it takes them", async () => {
  const o = await unpaid();
  providerUp = false;
  const r = await h.completed(o.sessionId);
  assert.strictEqual(r.status, 200, "the payment is acknowledged whatever the mail provider does");
  assert.strictEqual(models.ordersDB.getById(o.orderId).status, "paid");
  assert.strictEqual(h.sent.length, 0);
  assert.deepStrictEqual(rowsOf(o.orderId).map((x) => [x.kind, x.attempts, x.doneAt || null]).sort(), [["order-paid-buyer", 1, null], ["order-paid-shop", 1, null]]);
  providerUp = true;
  // Straight away: it was refused a moment ago, so it waits (one minute after the first refusal).
  const soon = await owed.deliver({ orderId: o.orderId });
  assert.deepStrictEqual([soon.sent, soon.waiting], [0, 2]);
  assert.strictEqual(h.sent.length, 0);
  // A minute and a bit later.
  const later = await owed.deliver({ now: Date.now() + 61 * 1000 });
  assert.strictEqual(later.sent, 2, JSON.stringify(later));
  assert.strictEqual(confirmations(o.email).length, 1);
  assert.strictEqual(shopNew().length, 1);
  // Never owed for ever: a day after it was owed it is given up, out loud.
  const o2 = await unpaid();
  providerUp = false;
  await h.completed(o2.sessionId);
  const realError = console.error; const said = [];
  console.error = (...a) => said.push(a.join(" "));
  let gave;
  try { gave = await owed.deliver({ now: Date.now() + owed.GIVE_UP_MS + 60 * 1000 }); } finally { console.error = realError; providerUp = true; }
  assert.strictEqual(gave.closed, 2, JSON.stringify(gave));
  assert.ok(said.filter((l) => /GAVE UP after a day/.test(l) && l.includes(o2.orderId.slice(0, 8))).length === 2, said.join("\n"));
  assert.ok(rowsOf(o2.orderId).every((x) => x.result === "gave-up" && x.doneAt));
});

test("the webhook and the return page arrive together: one confirmation, one shop notice", async () => {
  const o = await unpaid();
  const session = h.pay(o.sessionId);
  const real = mailer.send;
  mailer.send = async (m) => { await new Promise((r) => setTimeout(r, 30)); return real(m); }; // a provider that takes a moment
  try {
    await Promise.all([
      h.webhook("checkout.session.completed", session),
      h.post(`/api/orders/${o.orderId}/confirm-payment`, {}, o.token),
      h.webhook("checkout.session.completed", session),
      owed.deliver(),
    ]);
    await owed.deliver();
  } finally { mailer.send = real; }
  assert.strictEqual(confirmations(o.email).length, 1, h.sent.map((m) => `${m.to}: ${m.subject}`).join(" | "));
  assert.strictEqual(shopNew().length, 1);
});

test("a payment that needs the owner's look is owed its notice the same way: killed before it goes, sent by the second delivery, once", async () => {
  const o = await unpaid();
  const session = h.pay(o.sessionId);
  const short = { ...session, amount_total: session.amount_total - 500 };
  const eventId = "evt_test_short_payment";
  const applied = lifecycle.applySession(o.orderId, short, { eventId, source: "stripe" });
  assert.strictEqual(applied.outcome, "payment-mismatch");
  assert.strictEqual(models.ordersDB.getById(o.orderId).attention, "payment-mismatch");
  assert.strictEqual(h.sent.length, 0);
  assert.deepStrictEqual(rowsOf(o.orderId).map((x) => [x.kind, x.doneAt || null]), [["payment-notice-shop", null]]);
  await h.webhook("checkout.session.completed", short, { id: eventId });
  const notices = h.sent.filter((m) => /does not match|needs|attention|mismatch/i.test(`${m.subject} ${m.text}`));
  assert.strictEqual(notices.length, 1, h.sent.map((m) => `${m.to}: ${m.subject}`).join(" | "));
  assert.strictEqual(confirmations(o.email).length, 0, "the buyer is not told an unpaid order is paid");
  await h.webhook("checkout.session.completed", short, { id: eventId });
  assert.strictEqual(h.sent.length, 1);
});

test("all of it or none of it: if the record of the payment cannot be written, the order is not paid and nothing is owed", async () => {
  const o = await unpaid();
  const store = require("../models/lifecycleStore").paymentEventsDB;
  const realInsert = store.insert.bind(store);
  store.insert = () => { throw new Error("disk fault (test)"); };
  let threw = null;
  try { lifecycle.applySession(o.orderId, h.pay(o.sessionId), { eventId: "evt_test_fault", source: "stripe" }); } catch (err) { threw = err; } finally { store.insert = realInsert; }
  assert.ok(threw && /disk fault/.test(threw.message));
  assert.strictEqual(models.ordersDB.getById(o.orderId).status, "pending_payment", "not half applied");
  assert.strictEqual(rowsOf(o.orderId).length, 0);
  // Stripe sends it again and it goes through whole.
  const r = await h.completed(o.sessionId);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(models.ordersDB.getById(o.orderId).status, "paid");
  assert.strictEqual(confirmations(o.email).length, 1);
  assert.strictEqual(shopNew().length, 1);
});

run(() => h.stop());
