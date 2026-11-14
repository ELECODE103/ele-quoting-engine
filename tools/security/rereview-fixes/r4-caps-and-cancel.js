#!/usr/bin/env node
/**
 * Review conditions (2026-11-13), N-01: an honest buyer is not locked out by their own changes.
 *
 *   node tools/security/rereview-fixes/r4-caps-and-cancel.js
 *
 * Beside the reviewer's r3-caps-and-lists.js, whose section 1 can no longer express one case as
 * written: it takes "the oldest unpaid order" after six changes and expects paying for its quote to
 * hand that same order back. That order is now closed when the next version is checked out, so
 * there is no oldest unpaid order to go back to; here the order that IS waiting is the one resumed.
 *
 * In-process harness started with { orderCaps: true } (the real ceilings: 3 unpaid at once and 8 new
 * a day per account, 5 and 16 per address), Stripe stand-in, mail captured.
 */
const assert = require("assert");
const { report, SHIP } = require("../rereview-relaunch/lib");
const { start } = require("../../../server/testSupport/harness");

(async () => {
  for (const k of ["QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY", "QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY"]) process.env[k] = "100000";
  const h = await start({ mailer: "configured", orderCaps: true });
  const R = report();
  const { ordersDB } = h.models;
  const limits = require("../../../server/security/limits").limits;
  R.info("ceilings in force in this run", `per account ${limits.ordersUnpaidPerAccount} at once / ${limits.ordersUnpaidNewPerAccountDay} a day; per address ${limits.ordersUnpaidPerClient} at once / ${limits.ordersUnpaidNewPerClientDay} a day`);
  const IP = "203.0.113.50";
  const pay = (token, quoteId, body = {}) => h.raw("POST", "/api/orders/checkout-session", { json: { quoteId, ...SHIP, ...body }, token, ip: IP });
  const sessionOf = (c) => String(c.body.sessionUrl).split("/").pop();

  console.log("\n1. an honest customer who goes back and changes the quantity, six times");
  const dana = await h.register("dana@buyer.test", "Dana Buyer");
  const part = await h.uploadCube();
  const quote = async (qty, quoteId) => { const q = await h.post("/api/quote", { parts: [h.cncConfig(part, qty)], leadTimeSlug: "standard", ...(quoteId ? { quoteId } : {}) }, dana); assert.strictEqual(q.status, 200, q.text); return q.body; };
  {
    let quoteId = null;
    let refusedAt = null;
    let last = null;
    const pages = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      const q = await quote(1 + attempt, quoteId);
      quoteId = q.quoteId;
      const c = await pay(dana, quoteId);
      if (c.status !== 200) { refusedAt = `${attempt}: ${c.status} ${c.body.code}`; break; }
      last = c;
      pages.push(sessionOf(c));
    }
    R.check(!refusedAt, "six changes of quantity, six checkouts: never refused (the review: refused on change 4)", refusedAt || "");
    const mine = ordersDB.query((o) => o.customerEmail === "dana@buyer.test");
    const waiting = mine.filter((o) => o.status === "pending_payment");
    R.check(waiting.length === 1 && waiting[0].id === last.body.orderId, "one order is waiting: the last version", `${mine.length} orders made, ${waiting.length} waiting, ${mine.filter((o) => o.status === "expired").length} closed`);
    R.check(pages.slice(0, -1).every((id) => h.stripe.expired.includes(id) && h.stripe.sessions[id].status === "expired") && h.stripe.sessions[pages[pages.length - 1]].status === "open", "each earlier payment page was expired at Stripe; the last one is open", `${pages.length - 1} expired, 1 open`);
    const resume = await pay(dana, quoteId);
    R.check(resume.status === 200 && resume.body.orderId === last.body.orderId && sessionOf(resume) === sessionOf(last), "going back to pay for the order that is waiting gives the same order and the same payment page");
    // A payment on one of the closed pages.
    await h.webhook("checkout.session.completed", { ...h.stripe.sessions[pages[0]], status: "complete", payment_status: "paid", payment_intent: "pi_stale" });
    const first = mine.find((o) => o.stripeSessionId === pages[0]) || ordersDB.query((o) => o.stripeSessionId === pages[0])[0];
    const now = ordersDB.getById(first.id);
    R.check(now.status === "expired" && now.attention === "late-payment", "a payment that still arrives on a closed order's page is flagged for the owner, not accepted and not lost", `${now.status} / ${now.attention}`);
  }

  console.log("\n2. the buyer's own cancel");
  {
    const erin = await h.register("erin@buyer.test", "Erin Buyer");
    const p = await h.uploadCube();
    const made = [];
    for (let i = 0; i < 3; i++) { const q = await h.post("/api/quote", { parts: [h.cncConfig(p, 2 + i)], leadTimeSlug: "standard" }, erin); made.push(await h.raw("POST", "/api/orders/checkout-session", { json: { quoteId: q.body.quoteId, ...SHIP }, token: erin, ip: "203.0.113.77" })); }
    const q4 = await h.post("/api/quote", { parts: [h.cncConfig(p, 9)], leadTimeSlug: "standard" }, erin);
    const fourth = await h.raw("POST", "/api/orders/checkout-session", { json: { quoteId: q4.body.quoteId, ...SHIP }, token: erin, ip: "203.0.113.77" });
    R.check(fourth.status === 429 && fourth.body.code === "unpaid-orders-limit", "three unrelated unpaid orders: the fourth is still refused (the ceiling is kept)", `${fourth.status} ${fourth.body.code}`);
    console.log(`  the buyer reads: "${fourth.body.error}"`);
    const list = (await h.get("/api/orders", erin)).body;
    R.check(list.filter((o) => o.canCancel).length === 3, "Your orders offers Cancel for each of the three");
    const cancel = await h.post(`/api/orders/${made[0].body.orderId}/cancel`, {}, erin);
    R.check(cancel.status === 200 && cancel.body.status === "expired" && h.stripe.expired.includes(sessionOf(made[0])), "the buyer cancels one: it is closed and its payment page is expired at Stripe", `${cancel.status} ${cancel.body.status}`);
    const retry = await h.raw("POST", "/api/orders/checkout-session", { json: { quoteId: q4.body.quoteId, ...SHIP }, token: erin, ip: "203.0.113.77" });
    R.check(retry.status === 200, "and the fourth order is accepted at once", `${retry.status}`);
    const other = await h.register("mallory@buyer.test", "Mallory");
    const theirs = await h.post(`/api/orders/${made[1].body.orderId}/cancel`, {}, other);
    R.check(theirs.status === 403 && ordersDB.getById(made[1].body.orderId).status === "pending_payment", "another customer cannot cancel it", `${theirs.status}`);
    h.stripe.failExpire = true;
    const busy = await h.post(`/api/orders/${made[1].body.orderId}/cancel`, {}, erin);
    h.stripe.failExpire = false;
    R.check(busy.status === 502 && ordersDB.getById(made[1].body.orderId).status === "pending_payment", "when the payment page cannot be confirmed closed, the order is left as it was", `${busy.status} ${busy.body.code}: "${busy.body.error}"`);
  }

  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
