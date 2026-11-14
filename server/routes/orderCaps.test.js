/**
 * The ceilings on unpaid orders, with the REAL numbers, and the two ways an honest buyer stays
 * clear of them (review of 2026-11-13: N-01, and "no test in the suite runs the per-address
 * ceilings"). Run: node server/routes/orderCaps.test.js
 *
 *   per account   3 waiting at once, 8 started and not paid for in 24 hours   (also in orderList.test.js)
 *   per address   5 waiting at once, 16 started and not paid for in 24 hours  (only here)
 *
 * Before: a buyer who reached the card page, went back, changed a quantity and pressed pay again
 * left an unpaid order behind each time; the fourth change was refused for about two hours and the
 * buyer had no way to close anything. Now (a) checking out a changed quote closes the unpaid order
 * of the earlier version in the same step, payment page first; (b) a buyer can cancel their own
 * unpaid order. Both leave an order alone when its payment page cannot be confirmed closed, and a
 * payment that still arrives for a closed order is flagged for the owner.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Unpaid-order ceilings (real numbers), replaced orders and the buyer's own cancel");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };
const sessionOf = (c) => String(c.body.sessionUrl).split("/").pop();

(async () => {
  for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  process.env.UPLOAD_MAX_PARTS_PER_15MIN = "100000";
  const h = await start({ mailer: "configured", orderCaps: true });
  const { ordersDB, quotesDB } = h.models;
  const { limits } = require("../security/limits");
  const lifecycle = require("../services/orderLifecycle");
  let owner;
  let n = 0;
  // Each buyer prices a part of their own (a part belongs to the first account that prices it).
  const parts = new Map();
  const partOf = async (token) => { if (!parts.has(token)) parts.set(token, await h.uploadCube()); return parts.get(token); };

  const newQuote = async (token, qty = 2) => { const partId = await partOf(token); const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, qty)], leadTimeSlug: "standard" }, token); assert.strictEqual(q.status, 200, q.text.slice(0, 200)); return q.body; };
  /** The buyer goes back from the card page and changes the quantity: the builder sends the ordered quote's id with the new configuration. */
  const changeQuote = async (token, quoteId, qty) => { const partId = await partOf(token); const q = await h.post("/api/quote", { quoteId, parts: [h.cncConfig(partId, qty)], leadTimeSlug: "standard" }, token); assert.strictEqual(q.status, 200, q.text.slice(0, 200)); return q.body; };
  const pay = (token, quoteId) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP }, token);
  const buyerAccount = async () => h.register(`buyer-${++n}@caps.test`);
  const waitingOf = (userId) => ordersDB.query((o) => o.userId === userId && o.status === "pending_payment");
  const userIdOf = (email) => h.models.usersDB.query((u) => u.email === email)[0].id;

  test("setup: the real ceilings are in force (3 and 8 per account, 5 and 16 per address)", async () => {
    owner = await h.admin("Owner");
    assert.deepStrictEqual([limits.ordersUnpaidPerAccount, limits.ordersUnpaidNewPerAccountDay, limits.ordersUnpaidPerClient, limits.ordersUnpaidNewPerClientDay], [3, 8, 5, 16]);
  });

  // ── The per-address ceilings ───────────────────────────────────────────────────────────────────
  test("per address, at once: five unpaid orders from one address, whoever's they are; the sixth is refused in words; from another address the same buyer is accepted", async () => {
    const ann = await buyerAccount();
    const bob = await buyerAccount();
    h.ip = "203.0.113.50";
    for (let i = 0; i < 3; i++) assert.strictEqual((await pay(ann, (await newQuote(ann)).quoteId)).status, 200, `Ann ${i + 1}`);
    for (let i = 0; i < 2; i++) assert.strictEqual((await pay(bob, (await newQuote(bob)).quoteId)).status, 200, `Bob ${i + 1}`);
    const q = await newQuote(bob);
    const sixth = await pay(bob, q.quoteId);
    assert.deepStrictEqual([sixth.status, sixth.body.code, sixth.headers.get("retry-after")], [429, "unpaid-orders-limit", "3600"], sixth.text.slice(0, 200));
    assert.ok(/You have 5 orders waiting for payment/.test(sixth.body.error) && /cancel one there/.test(sixth.body.error), sixth.body.error);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 0, "no order was made");
    assert.strictEqual(quotesDB.getById(q.quoteId).status, "draft", "the quote is still the buyer's to check out");
    // Bob is inside his own ceiling of three (he has two): it was the address.
    h.ip = "203.0.113.51";
    assert.strictEqual((await pay(bob, q.quoteId)).status, 200, "from another address Bob is accepted");
    h.ip = "";
  });

  test("per address, in a day: sixteen checkouts started and not paid for from one address; the seventeenth is refused in words; from another address it is accepted", async () => {
    h.ip = "203.0.113.60";
    // Three accounts, each inside its own ceilings (6, 6 and 4 started; each order closed again at once, so none is waiting).
    for (const count of [6, 6, 4]) {
      const who = await buyerAccount();
      for (let i = 0; i < count; i++) {
        const c = await pay(who, (await newQuote(who)).quoteId);
        assert.strictEqual(c.status, 200, c.text.slice(0, 200));
        assert.ok(lifecycle.expireOrder(c.body.orderId, "test: the payment page lapsed"));
      }
    }
    const fresh = await buyerAccount(); // an account that has never checked out
    const q = await newQuote(fresh);
    const seventeenth = await pay(fresh, q.quoteId);
    assert.deepStrictEqual([seventeenth.status, seventeenth.body.code], [429, "unpaid-orders-daily-limit"], seventeenth.text.slice(0, 200));
    assert.ok(/more checkouts started and not paid for than we take in one day/.test(seventeenth.body.error) && /Nothing was charged/.test(seventeenth.body.error));
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.quoteId).length, 0);
    h.ip = "203.0.113.61";
    assert.strictEqual((await pay(fresh, q.quoteId)).status, 200, "the same account from another address");
    h.ip = "";
  });

  test("a paid order frees its place at once, per address as per account", async () => {
    h.ip = "203.0.113.70";
    const who = await buyerAccount();
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await pay(who, (await newQuote(who)).quoteId));
    assert.strictEqual((await pay(who, (await newQuote(who)).quoteId)).status, 429, "the fourth unrelated order is refused: the ceiling itself is unchanged");
    await h.completed(sessionOf(made[0]));
    assert.strictEqual((await pay(who, (await newQuote(who)).quoteId)).status, 200, "after paying for one, the next is accepted");
    h.ip = "";
  });

  // ── N-01 (a): the order a changed quote replaces ───────────────────────────────────────────────
  let honest, honestEmail;
  test("N-01: go back from the card page, change the quantity, pay again, five times over: never refused, one order waiting, each earlier order closed with its payment page expired at Stripe first", async () => {
    honest = await buyerAccount();
    honestEmail = `buyer-${n}@caps.test`;
    const userId = userIdOf(honestEmail);
    let quote = await newQuote(honest, 2);
    let c = await pay(honest, quote.quoteId);
    assert.strictEqual(c.status, 200);
    const chain = [{ quoteId: quote.quoteId, orderId: c.body.orderId, session: sessionOf(c) }];
    for (let change = 1; change <= 5; change++) {
      const next = await changeQuote(honest, quote.quoteId, 2 + change);
      assert.notStrictEqual(next.quoteId, quote.quoteId, "a quote that has been to checkout is forked, not changed in place");
      assert.strictEqual(quotesDB.getById(next.quoteId).replacesQuoteId, chain[0].quoteId, "the fork remembers the first quote of the chain");
      c = await pay(honest, next.quoteId);
      assert.strictEqual(c.status, 200, `change ${change}: ${c.text.slice(0, 200)}`); // (before: change 3 was the fourth order and was refused, 429)
      const before = chain[chain.length - 1];
      const old = ordersDB.getById(before.orderId);
      assert.deepStrictEqual([old.status, Boolean(old.expiredAt), old.attention || ""], ["expired", true, ""], `change ${change}: the earlier order is closed`);
      assert.ok(h.stripe.expired.includes(before.session) && h.stripe.sessions[before.session].status === "expired", `change ${change}: its payment page was expired at Stripe`);
      assert.ok(lifecycle.eventsFor(old.id).some((e) => e.kind === "order-expired" && /the buyer changed the quote/.test(e.detail)), "and the order's history says why");
      assert.deepStrictEqual(waitingOf(userId).map((o) => o.id), [c.body.orderId], `change ${change}: exactly one order is waiting`);
      chain.push({ quoteId: next.quoteId, orderId: c.body.orderId, session: sessionOf(c) });
      quote = next;
    }
    // The order that is waiting is for the last version, at its price.
    const last = ordersDB.getById(c.body.orderId);
    assert.strictEqual(last.total, quote.orderTotal);
    assert.strictEqual(h.stripe.sessions[sessionOf(c)].amount_total, Math.round(quote.orderTotal * 100));
    // A payment that still arrives on a page of a closed order is flagged for the owner: not accepted, not lost.
    const stale = chain[1];
    await h.webhook("checkout.session.completed", { ...h.stripe.sessions[stale.session], status: "complete", payment_status: "paid", payment_intent: "pi_stale_page" });
    const flagged = ordersDB.getById(stale.orderId);
    assert.deepStrictEqual([flagged.status, flagged.attention], ["expired", "late-payment"]);
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "pending_payment", "the live order is not touched by it");
    await h.completed(sessionOf(c));
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "paid");
  });

  test("N-01: the ceilings themselves are kept: the day's total still counts every checkout started and not paid for (the 9th in 24 hours is refused)", async () => {
    const who = await buyerAccount();
    let quote = await newQuote(who, 2);
    let c = await pay(who, quote.quoteId);
    for (let i = 2; i <= 8; i++) {
      quote = await changeQuote(who, quote.quoteId, 2 + i);
      c = await pay(who, quote.quoteId);
      assert.strictEqual(c.status, 200, `checkout ${i}: ${c.text.slice(0, 160)}`);
    }
    quote = await changeQuote(who, quote.quoteId, 20);
    const ninth = await pay(who, quote.quoteId);
    assert.deepStrictEqual([ninth.status, ninth.body.code], [429, "unpaid-orders-daily-limit"]);
    // Refused, so nothing was closed either: the eighth order is still the buyer's to pay for.
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "pending_payment");
  });

  test("N-01: only the buyer's own order of the SAME quote chain is closed: an unrelated unpaid order, and another buyer's, stay", async () => {
    const who = await buyerAccount();
    const other = await buyerAccount();
    const unrelated = await pay(who, (await newQuote(who, 7)).quoteId);
    const theirs = await pay(other, (await newQuote(other, 2)).quoteId);
    const first = await newQuote(who, 2);
    const a = await pay(who, first.quoteId);
    const changed = await changeQuote(who, first.quoteId, 3);
    const b = await pay(who, changed.quoteId);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(ordersDB.getById(a.body.orderId).status, "expired");
    assert.strictEqual(ordersDB.getById(unrelated.body.orderId).status, "pending_payment", "an order for other parts is not touched");
    assert.strictEqual(ordersDB.getById(theirs.body.orderId).status, "pending_payment", "nor anybody else's");
    assert.ok(!h.stripe.expired.includes(sessionOf(unrelated)) && !h.stripe.expired.includes(sessionOf(theirs)));
    // Another buyer cannot use somebody's quote id to close their order: the fork is not linked, and the order is not theirs.
    const poke = await h.post("/api/quote", { quoteId: changed.quoteId, parts: [h.cncConfig(await partOf(other), 4)], leadTimeSlug: "standard" }, other);
    if (poke.status === 200) {
      assert.ok(!quotesDB.getById(poke.body.quoteId).replacesQuoteId, "a quote made from somebody else's quote id is not part of their chain");
      await pay(other, poke.body.quoteId);
    }
    assert.strictEqual(ordersDB.getById(b.body.orderId).status, "pending_payment");
  });

  test("N-01: the earlier page had been PAID (another tab): that order is settled as it stood, no second payment is started, and the buyer is told", async () => {
    const who = await buyerAccount();
    const first = await newQuote(who, 2);
    const a = await pay(who, first.quoteId);
    const changed = await changeQuote(who, first.quoteId, 3);
    // Paid at Stripe; the webhook has not arrived yet.
    Object.assign(h.stripe.sessions[sessionOf(a)], { status: "complete", payment_status: "paid", payment_intent: "pi_other_tab" });
    const created = h.stripe.created.length;
    const b = await pay(who, changed.quoteId);
    assert.deepStrictEqual([b.status, b.body.code, b.body.orderId], [409, "earlier-order-paid", a.body.orderId], b.text.slice(0, 200));
    assert.ok(/has just been paid, so we did not start a second payment/.test(b.body.error));
    const paid = ordersDB.getById(a.body.orderId);
    assert.deepStrictEqual([paid.status, paid.attention || ""], ["paid", ""], "the correct payment is not flagged");
    assert.strictEqual(h.stripe.created.length, created, "no second payment page was opened");
    assert.strictEqual(ordersDB.query((o) => o.quoteId === changed.quoteId).length, 0);
    // If the buyer does want the changed version as well, checking out again makes it: nothing is left to replace.
    assert.strictEqual((await pay(who, changed.quoteId)).status, 200);
  });

  test("N-01: the earlier page CANNOT be confirmed closed: that order is left exactly as it was, and the new order is made beside it", async () => {
    const who = await buyerAccount();
    const first = await newQuote(who, 2);
    const a = await pay(who, first.quoteId);
    const changed = await changeQuote(who, first.quoteId, 3);
    const before = ordersDB.getById(a.body.orderId);
    h.stripe.failExpire = true; // Stripe does not answer the "expire" call
    const b = await pay(who, changed.quoteId);
    h.stripe.failExpire = false;
    assert.strictEqual(b.status, 200, b.text.slice(0, 200));
    const after = ordersDB.getById(a.body.orderId);
    assert.deepStrictEqual([after.status, after.total, after.stripeSessionId], [before.status, before.total, before.stripeSessionId], "left alone");
    assert.strictEqual(h.stripe.sessions[sessionOf(a)].status, "open", "its page is still open, so the order must still be there to take the payment");
    await h.completed(sessionOf(a));
    assert.deepStrictEqual([ordersDB.getById(a.body.orderId).status, ordersDB.getById(a.body.orderId).attention || ""], ["paid", ""]);
  });

  // ── N-01 (b): the buyer's own cancel ───────────────────────────────────────────────────────────
  test("cancel: the buyer cancels their own unpaid order from Your orders: the payment page is expired at Stripe, the order is 'not paid, closed', the quote is theirs again", async () => {
    const who = await buyerAccount();
    const q = await newQuote(who, 2);
    const c = await pay(who, q.quoteId);
    const list = await h.get("/api/orders", who);
    assert.strictEqual(list.body.find((o) => o.id === c.body.orderId).canCancel, true, "Your orders offers Cancel for it");
    const cancel = await h.post(`/api/orders/${c.body.orderId}/cancel`, {}, who);
    assert.deepStrictEqual([cancel.status, cancel.body.cancelled, cancel.body.status, cancel.body.canCancel], [200, true, "expired", false], cancel.text.slice(0, 200));
    assert.ok(h.stripe.expired.includes(sessionOf(c)) && h.stripe.sessions[sessionOf(c)].status === "expired");
    assert.strictEqual(quotesDB.getById(q.quoteId).status, "draft");
    assert.ok(lifecycle.eventsFor(c.body.orderId).some((e) => e.kind === "order-expired" && /cancelled by the buyer/.test(e.detail)));
    // Again: nothing left to cancel. And the quote can be checked out again.
    const twice = await h.post(`/api/orders/${c.body.orderId}/cancel`, {}, who);
    assert.deepStrictEqual([twice.status, twice.body.code], [409, "cancel-not-available"]);
    assert.strictEqual((await pay(who, q.quoteId)).status, 200);
    // A payment that still arrives for the cancelled order is flagged for the owner.
    await h.webhook("checkout.session.completed", { ...h.stripe.sessions[sessionOf(c)], status: "complete", payment_status: "paid", payment_intent: "pi_after_cancel" });
    assert.deepStrictEqual([ordersDB.getById(c.body.orderId).status, ordersDB.getById(c.body.orderId).attention], ["expired", "late-payment"]);
  });

  test("cancel: a place is freed at once: three waiting, the fourth refused, cancel one, the fourth is accepted", async () => {
    const who = await buyerAccount();
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await pay(who, (await newQuote(who, 2 + i)).quoteId));
    const fourth = await newQuote(who, 9);
    assert.strictEqual((await pay(who, fourth.quoteId)).status, 429);
    assert.strictEqual((await h.post(`/api/orders/${made[1].body.orderId}/cancel`, {}, who)).status, 200);
    assert.strictEqual((await pay(who, fourth.quoteId)).status, 200);
  });

  test("cancel: not somebody else's order, not without signing in, not a paid order", async () => {
    const who = await buyerAccount();
    const other = await buyerAccount();
    const c = await pay(who, (await newQuote(who, 2)).quoteId);
    assert.strictEqual((await h.post(`/api/orders/${c.body.orderId}/cancel`, {}, other)).status, 403);
    assert.strictEqual((await h.raw("POST", `/api/orders/${c.body.orderId}/cancel`, { json: {} })).status, 401);
    assert.strictEqual((await h.post("/api/orders/no-such-order/cancel", {}, who)).status, 404);
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "pending_payment");
    await h.completed(sessionOf(c));
    const paid = await h.post(`/api/orders/${c.body.orderId}/cancel`, {}, who);
    assert.deepStrictEqual([paid.status, paid.body.code], [409, "cancel-not-available"]);
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "paid");
  });

  test("cancel: the page had been PAID: the order is settled, not cancelled. The page CANNOT be confirmed closed: the order is left as it was", async () => {
    const who = await buyerAccount();
    const a = await pay(who, (await newQuote(who, 2)).quoteId);
    Object.assign(h.stripe.sessions[sessionOf(a)], { status: "complete", payment_status: "paid", payment_intent: "pi_paid_then_cancel" });
    const r = await h.post(`/api/orders/${a.body.orderId}/cancel`, {}, who);
    assert.deepStrictEqual([r.status, r.body.code], [409, "cancel-order-paid"], r.text.slice(0, 200));
    assert.deepStrictEqual([ordersDB.getById(a.body.orderId).status, ordersDB.getById(a.body.orderId).attention || ""], ["paid", ""]);

    const b = await pay(who, (await newQuote(who, 3)).quoteId);
    h.stripe.failExpire = true;
    const busy = await h.post(`/api/orders/${b.body.orderId}/cancel`, {}, who);
    h.stripe.failExpire = false;
    assert.deepStrictEqual([busy.status, busy.body.code], [502, "payment-session-busy"], busy.text.slice(0, 200));
    assert.ok(/left as it is/.test(busy.body.error) && /Nothing was charged/.test(busy.body.error));
    const still = ordersDB.getById(b.body.orderId);
    assert.deepStrictEqual([still.status, h.stripe.sessions[sessionOf(b)].status], ["pending_payment", "open"]);
    await h.completed(sessionOf(b));
    assert.strictEqual(ordersDB.getById(b.body.orderId).status, "paid", "and it can still be paid for");
  });

  test("cancel: the owner's phone order is not the buyer's to cancel, and is never offered", async () => {
    const who = await buyerAccount();
    const q = await newQuote(who, 2);
    const phone = await h.post("/api/orders", { quoteId: q.quoteId, ...SHIP }, owner);
    assert.strictEqual(phone.status, 201, phone.text.slice(0, 200));
    const row = ordersDB.getById(phone.body.orderId);
    assert.ok(!row.paymentMethod, "a phone order has no payment method on record");
    ordersDB.update(row.id, { userId: userIdOf(`buyer-${n}@caps.test`) }); // even if it were on the buyer's account
    const list = await h.get("/api/orders", who);
    assert.strictEqual(list.body.find((o) => o.id === row.id).canCancel, false);
    const r = await h.post(`/api/orders/${row.id}/cancel`, {}, who);
    assert.deepStrictEqual([r.status, r.body.code], [409, "cancel-not-available"], r.text.slice(0, 200));
    assert.strictEqual(ordersDB.getById(row.id).status, "pending_payment");
  });

  await run(h.stop);
})().catch((err) => { console.error(err); process.exit(1); });
