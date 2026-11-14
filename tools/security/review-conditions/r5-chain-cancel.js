#!/usr/bin/env node
/**
 * Review of the review-conditions fixes (2026-11-13), N-01: "checking out a changed quote closes the
 * unpaid order it replaces" and "a buyer can cancel their own unpaid order". Attacked.
 *
 *   node tools/security/review-conditions/r5-chain-cancel.js [raceRounds=200]
 *
 * In-process harness with the REAL ceilings (3 unpaid at once / 8 a day per account; 5 / 16 per
 * address), Stripe stand-in, mail captured.
 *
 *   1  what replace must never close: another customer's order, an unrelated quote's order, a phone
 *      order, a purchase-order order, a firm-quote card order, a flagged order, a paid order
 *   2  payment in flight: version 1 is paid at the moment version 2 is checked out (four orderings,
 *      then a race of N rounds). Never: charged with the order closed and not flagged
 *   3  the ceilings: how many honest changes in a day; can replace or cancel be looped to get under
 *      them; how many payment pages one account can open at Stripe in a day
 *   4  cancel: someone else's, paid, in production, firm quote, purchase order, phone, flagged,
 *      signed out, cookie without the CSRF token, twice, page paid a moment before, Stripe not answering
 */
const assert = require("assert");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const { report, SHIP, sleep } = require(path.join(ROOT, "tools/security/rereview-relaunch/lib"));
const { start } = require(path.join(ROOT, "server/testSupport/harness"));

const ROUNDS = Number(process.argv[2]) || 200;

(async () => {
  for (const k of ["QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY", "QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY"]) process.env[k] = "100000";
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  process.env.UPLOAD_MAX_PARTS_PER_15MIN = "100000";
  const h = await start({ mailer: "configured", orderCaps: true });
  const R = report();
  const { ordersDB, quotesDB, rfqsDB } = h.models;
  const limits = require(path.join(ROOT, "server/security/limits")).limits;
  const owner = await h.admin("Owner");
  let ipSeq = 10;
  const person = async (email) => ({ email, token: await h.register(email, "Buyer"), ip: `203.0.113.${++ipSeq}`, part: await h.uploadCube() });
  const priced = async (p, qty, quoteId, part) => { h.ip = p.ip; try { return await h.post("/api/quote", { parts: [h.cncConfig(part || p.part, qty)], leadTimeSlug: "standard", ...(quoteId ? { quoteId } : {}) }, p.token); } finally { h.ip = ""; } };
  const quote = async (p, qty, quoteId, part) => { const q = await priced(p, qty, quoteId, part); assert.strictEqual(q.status, 200, q.text); return q.body.quoteId; };
  const pay = (p, quoteId, body = {}) => h.raw("POST", "/api/orders/checkout-session", { json: { quoteId, ...SHIP, ...body }, token: p.token, ip: p.ip });
  const sid = (c) => String(c.body.sessionUrl).split("/").pop();
  const st = (id) => { const o = ordersDB.getById(id); return o ? `${o.status}${o.attention ? `/${o.attention}` : ""}` : "gone"; };

  console.log("\n1. what replacing must never close");
  {
    const dana = await person("dana@buyer.test");
    const mallory = await person("mallory@buyer.test");
    // Dana: an unrelated unpaid order (quote U), and a chain A1 → A2.
    const u = await quote(dana, 2); const cu = await pay(dana, u);
    const a1 = await quote(dana, 3); const c1 = await pay(dana, a1);
    // Mallory re-prices "Dana's quote" and checks hers out.
    const mq = await priced(mallory, 4, a1);
    const mrow = mq.status === 200 ? quotesDB.getById(mq.body.quoteId) : null;
    const mc = mq.status === 200 ? await pay(mallory, mq.body.quoteId) : { status: 0, body: {} };
    R.check(st(c1.body.orderId) === "pending_payment" && st(cu.body.orderId) === "pending_payment" && !(mrow && mrow.replacesQuoteId), "another customer who names Dana's quote id when pricing does not join Dana's chain, and her checkout closes nothing of Dana's", `Mallory's quote ${mq.status}${mrow ? `, replaces: ${mrow.replacesQuoteId || "nothing"}` : ""}; her checkout ${mc.status}; Dana's orders ${st(c1.body.orderId)}, ${st(cu.body.orderId)}`);
    const a2 = await quote(dana, 5, a1); const c2 = await pay(dana, a2);
    R.check(c2.status === 200 && st(c1.body.orderId) === "expired" && st(cu.body.orderId) === "pending_payment" && st(c2.body.orderId) === "pending_payment", "Dana's changed quote closes the order of its earlier version and NOT her order for an unrelated quote", `v1 ${st(c1.body.orderId)}, unrelated ${st(cu.body.orderId)}, v2 ${st(c2.body.orderId)}`);
    R.check(h.stripe.sessions[sid(c1)].status === "expired" && h.stripe.sessions[sid(cu)].status === "open", "at Stripe: the replaced page is expired, the unrelated one is open");
    const told = h.sent.filter((m) => m.to === dana.email && /closed|cancel/i.test(m.subject || "")).length;
    R.info("emails to the buyer about the order that was closed by her own change", `${told}`);
    // The same quote session, but DIFFERENT parts: is that "a changed quote"?
    const other = await h.uploadCube();
    const b1 = await quote(dana, 9, a2, other);
    const cb = await pay(dana, b1);
    R.info("the buyer comes back from the card page, swaps the part for a DIFFERENT part in the same quote and checks out: the first order is closed as 'replaced'", `checkout ${cb.status}; order for the first part: ${st(c2.body.orderId)}; she cannot hold both unpaid at once (paying the first before starting the second does work)`);
    // back to the earlier version: its quote is a draft again
    const back = await pay(dana, a2);
    R.info("…and going back to pay for the first one closes the second", `checkout ${back.status}; first-part order now ${back.body.orderId ? st(back.body.orderId) : "?"}; second-part order ${cb.body.orderId ? st(cb.body.orderId) : "?"}`);
  }
  {
    // A flagged order, a paid order, a phone order, a firm-quote card order and a PO order made from quotes of the buyer's chain.
    const erin = await person("erin@buyer.test");
    const q1 = await quote(erin, 2); const c1 = await pay(erin, q1);
    await h.webhook("checkout.session.completed", { ...h.stripe.sessions[sid(c1)], status: "complete", payment_status: "paid", payment_intent: "pi_short", amount_total: 100, amount_subtotal: 100 });
    const q2 = await quote(erin, 3, q1); const c2 = await pay(erin, q2);
    R.check(st(c1.body.orderId) === "pending_payment/payment-mismatch", "an order flagged for the owner (a payment that did not match) is not closed when its quote is changed and checked out", `${st(c1.body.orderId)}; new checkout ${c2.status}`);
    await h.completed(sid(c2));
    const q3 = await quote(erin, 4, q2); const c3 = await pay(erin, q3);
    R.check(st(c2.body.orderId) === "paid", "a PAID order is not touched when its quote is changed and checked out again", `${st(c2.body.orderId)}; new checkout ${c3.status}`);

    const fay = await person("fay@buyer.test");
    const fq = await quote(fay, 2);
    const phone = await h.post("/api/orders", { quoteId: fq, ...SHIP }, owner);
    const fq2 = await quote(fay, 3, fq); const fc2 = await pay(fay, fq2);
    const prow = ordersDB.getById(phone.body.orderId);
    R.check(phone.status === 201 && prow.status === "pending_payment" && !prow.attention, "a PHONE order the owner made from the buyer's quote is not closed when the buyer changes that quote and checks out", `phone order ${st(phone.body.orderId)} (payment method ${JSON.stringify(prow.paymentMethod)}), quote was ${quotesDB.getById(fq).status}, fork replaces ${quotesDB.getById(fq2).replacesQuoteId || "nothing"}; checkout ${fc2.status}`);

    for (const method of ["card", "po"]) {
      const gus = await person(`gus-${method}@buyer.test`);
      const gq = await quote(gus, 2);
      const r = await h.form("/api/rfq", { quoteId: gq, contactName: "Gus", email: gus.email, notes: "x", ...SHIP }, {}, gus.token);
      assert.strictEqual(r.status, 201, r.text);
      await h.put(`/api/rfq/admin/${r.body.rfqId}`, { quotedTotal: 480, quotedLeadDays: 7, status: "quoted" }, owner);
      const mail = [...h.sent].reverse().find((m) => m.to === gus.email && /firm-quote\//.test(m.text || ""));
      const link = (mail.text.match(/firm-quote\/([A-Za-z0-9._~-]+)/) || [])[1];
      const a = await h.raw("POST", `/api/rfq/quote/${link}/accept`, { json: { method, ...(method === "po" ? { poNumber: "PO-1" } : {}), shippingName: "Gus", seenTotal: 480 } });
      const firmId = rfqsDB.getById(r.body.rfqId).orderId;
      const before = st(firmId);
      const g2 = await priced(gus, 5, gq);
      const gc = g2.status === 200 ? await pay(gus, g2.body.quoteId) : { status: g2.status, body: g2.body };
      const cancel = await h.post(`/api/orders/${firmId}/cancel`, {}, gus.token);
      R.check(a.status === 201 && st(firmId) === before, `a firm-quote order (${method === "po" ? "purchase order" : "card"}) is not closed when the buyer re-prices the same quote and checks out, and cannot be cancelled by the buyer`, `firm order ${before} → ${st(firmId)}; re-price ${g2.status}, checkout ${gc.status} ${gc.body && gc.body.code || ""}; cancel ${cancel.status} ${cancel.body.code}`);
    }
  }

  console.log("\n2. version 1 is paid while version 2 is being checked out");
  {
    const ivy = await person("ivy@buyer.test");
    // (a) paid at Stripe, the webhook has not arrived yet
    let q1 = await quote(ivy, 2); let c1 = await pay(ivy, q1);
    h.pay(sid(c1));
    let q2 = await quote(ivy, 3, q1); let c2 = await pay(ivy, q2);
    const made = ordersDB.query((o) => o.quoteId === q2).length;
    R.check(c2.status === 409 && c2.body.code === "earlier-order-paid" && st(c1.body.orderId) === "paid" && made === 0, "(a) paid at Stripe a moment before, webhook not yet here: the earlier order is settled, NO second payment is started, the buyer is told", `${c2.status} ${c2.body.code}; v1 ${st(c1.body.orderId)}; orders for v2: ${made}`);
    console.log(`     the buyer reads: "${c2.body.error}"`);
    const late = await h.completed(sid(c1));
    R.check(late.status === 200 && st(c1.body.orderId) === "paid" && ordersDB.query((o) => o.userId === ordersDB.getById(c1.body.orderId).userId && o.paidAt).length === 1, "    the webhook then arrives: still one paid order, nothing flagged", `${late.body.outcome}`);
    // (b) the webhook arrived first
    const jo = await person("jo@buyer.test");
    q1 = await quote(jo, 2); c1 = await pay(jo, q1);
    await h.completed(sid(c1));
    q2 = await quote(jo, 3, q1); c2 = await pay(jo, q2);
    R.info("(b) paid AND the webhook already handled, then the changed quote is checked out", `${c2.status}${c2.status === 200 ? ": a second order is made and the buyer is sent to pay for it, with no word that the first was just paid (as before this change)" : ` ${c2.body.code}`}; v1 ${st(c1.body.orderId)}`);
    // (c) Stripe takes money on a page the site had expired (Stripe says this cannot happen)
    const kay = await person("kay@buyer.test");
    q1 = await quote(kay, 2); c1 = await pay(kay, q1);
    q2 = await quote(kay, 3, q1); c2 = await pay(kay, q2);
    await h.webhook("checkout.session.completed", { ...h.stripe.sessions[sid(c1)], status: "complete", payment_status: "paid", payment_intent: "pi_after_expiry" });
    R.check(st(c1.body.orderId) === "expired/late-payment" && st(c2.body.orderId) === "pending_payment", "(c) a payment reported on the replaced page AFTER it was closed: flagged 'late payment' for the owner, the order is not reopened, the new order is untouched", `v1 ${st(c1.body.orderId)}, v2 ${st(c2.body.orderId)}`);
    const shop = h.sent.filter((m) => m.to === "owner@shop.test" && /late|after|payment/i.test(m.subject || "")).pop();
    R.check(Boolean(shop), "    and the owner is emailed about it", shop ? shop.subject : "no email");
    // (d) Stripe does not answer when asked to close the earlier page
    const lee = await person("lee@buyer.test");
    q1 = await quote(lee, 2); c1 = await pay(lee, q1);
    q2 = await quote(lee, 3, q1);
    h.stripe.failExpire = true;
    const realRetrieve = require(path.join(ROOT, "server/services/stripeClient")).get().checkout.sessions.retrieve;
    require(path.join(ROOT, "server/services/stripeClient")).get().checkout.sessions.retrieve = async () => { throw new Error("stripe unavailable"); };
    c2 = await pay(lee, q2);
    require(path.join(ROOT, "server/services/stripeClient")).get().checkout.sessions.retrieve = realRetrieve;
    h.stripe.failExpire = false;
    R.check(st(c1.body.orderId) === "pending_payment" && h.stripe.sessions[sid(c1)].status === "open", "(d) Stripe does not answer: the earlier order and its page are left exactly as they were", `checkout of v2: ${c2.status} ${c2.body.code || ""}; v1 ${st(c1.body.orderId)}; orders waiting ${ordersDB.query((o) => o.customerEmail === lee.email && o.status === "pending_payment").length}`);
  }
  {
    // The race. Each round: v1 at the card page; then, at the same moment, "Stripe" marks v1 paid and
    // sends the webhook after 0 to 12 ms, while the buyer checks out v2. Stripe's stand-in answers
    // after 0 to 6 ms. Counted: every way a round can end.
    const ends = {}; let bad = 0; const badRows = [];
    for (let i = 0; i < ROUNDS; i++) {
      const p = await person(`race-${i}@buyer.test`);
      const q1 = await quote(p, 2); const c1 = await pay(p, q1);
      const q2 = await quote(p, 3, q1);
      const s1 = sid(c1);
      h.stripe.delayMs = Math.floor(Math.random() * 7);
      const payer = (async () => {
        await sleep(Math.floor(Math.random() * 13));
        // A page that has been expired can no longer be paid: that is Stripe's rule, and the stand-in's.
        if (h.stripe.sessions[s1].status !== "open") return "page-was-closed";
        h.pay(s1);
        await sleep(Math.floor(Math.random() * 4));
        await h.webhook("checkout.session.completed", h.stripe.sessions[s1]);
        return "paid";
      })();
      const [paid, c2] = await Promise.all([payer, pay(p, q2)]);
      h.stripe.delayMs = 0;
      const o1 = ordersDB.getById(c1.body.orderId);
      const o2 = c2.body && c2.body.orderId && c2.body.orderId !== o1.id ? ordersDB.getById(c2.body.orderId) : ordersDB.query((o) => o.quoteId === q2)[0] || null;
      const end = `v1 paid at Stripe: ${paid === "paid" ? "yes" : "no"} | v1 ${o1.status}${o1.attention ? `/${o1.attention}` : ""} | v2 checkout ${c2.status}${c2.status === 200 ? "" : ` ${c2.body.code}`} | v2 order ${o2 ? o2.status : "none"}`;
      ends[end] = (ends[end] || 0) + 1;
      const chargedAndClosedUnflagged = paid === "paid" && o1.status !== "paid" && !o1.attention;
      const closedButPageOpen = o1.status === "expired" && h.stripe.sessions[s1].status === "open";
      const twoPagesOpen = h.stripe.sessions[s1].status === "open" && o2 && o2.stripeSessionId && h.stripe.sessions[o2.stripeSessionId] && h.stripe.sessions[o2.stripeSessionId].status === "open";
      if (chargedAndClosedUnflagged || closedButPageOpen || twoPagesOpen) { bad++; badRows.push(end); }
    }
    R.check(bad === 0, `the race, ${ROUNDS} rounds: never "charged, order closed, not flagged"; never a closed order with a page still open; never two pages open for the two versions`, bad ? badRows.slice(0, 4).join(" || ") : "");
    for (const [k, n] of Object.entries(ends).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)} of ${ROUNDS}: ${k}`);
  }

  console.log("\n3. the ceilings");
  R.info("ceilings in force in this run", `per account ${limits.ordersUnpaidPerAccount} at once / ${limits.ordersUnpaidNewPerAccountDay} a day; per address ${limits.ordersUnpaidPerClient} at once / ${limits.ordersUnpaidNewPerClientDay} a day`);
  {
    const max = await person("max@buyer.test");
    let quoteId = null; let refusedAt = 0; let last = null; let msg = "";
    const pagesBefore = h.stripe.seq;
    for (let n = 1; n <= 20; n++) { quoteId = await quote(max, 1 + n, quoteId); const c = await pay(max, quoteId); if (c.status !== 200) { refusedAt = n; msg = `${c.status} ${c.body.code}: "${c.body.error}"`; break; } last = c; }
    R.info(`an honest buyer who keeps going back to change the quantity: checkout number ${refusedAt} is refused (so ${refusedAt - 2} changes after the first checkout go through in a day)`, msg);
    const resume = last ? await pay(max, ordersDB.getById(last.body.orderId).quoteId) : { status: 0, body: {} };
    R.check(resume.status === 200 && resume.body.orderId === last.body.orderId, "after the refusal the last version that was accepted can still be paid for", `${resume.status}`);
    const cancel = await h.post(`/api/orders/${last.body.orderId}/cancel`, {}, max.token);
    const after = await pay(max, quoteId);
    R.check(cancel.status === 200 && after.status === 429, "cancelling does not get under the day's ceiling: the next checkout is still refused", `cancel ${cancel.status}; next checkout ${after.status} ${after.body.code}`);
    R.info("payment pages one account opened at Stripe before it was stopped", `${h.stripe.seq - pagesBefore}`);
    const waiting = ordersDB.query((o) => o.customerEmail === max.email && o.status === "pending_payment").length;
    R.info("orders of that account left waiting / closed", `${waiting} waiting, ${ordersDB.query((o) => o.customerEmail === max.email && o.status === "expired").length} closed`);
    // A buyer who has used the day's eight and then wants to PAY: how?
    const ned = await person("ned@buyer.test");
    let nq = null; let nlast = null;
    for (let n = 1; n <= 8; n++) { nq = await quote(ned, 1 + n, nq); nlast = await pay(ned, nq); }
    const c9 = await pay(ned, await quote(ned, 30, nq));
    const waitingNed = ordersDB.query((o) => o.customerEmail === ned.email && o.status === "pending_payment");
    R.info("after eight checkouts the buyer wants one more change: refused; what is left to pay is the eighth version", `ninth ${c9.status} ${c9.body.code}; waiting orders ${waitingNed.length}`);
    await h.completed(sid(nlast));
    const c10 = await pay(ned, await quote(ned, 31, nq));
    R.info("…and once that one is paid, a further checkout the same day", `${c10.status} ${c10.body.code || ""} (a paid order is not counted, so the count is back to seven)`);
  }
  {
    // Cancel in a loop: does every round cost one of the day's eight?
    const oli = await person("oli@buyer.test");
    let rounds = 0; let stop = "";
    const q = await quote(oli, 2);
    for (let i = 0; i < 20; i++) { const c = await pay(oli, q); if (c.status !== 200) { stop = `${c.status} ${c.body.code}`; break; } const x = await h.post(`/api/orders/${c.body.orderId}/cancel`, {}, oli.token); if (x.status !== 200) { stop = `cancel ${x.status}`; break; } rounds++; }
    R.check(rounds === limits.ordersUnpaidNewPerAccountDay, `check out and cancel in a loop stops at the day's ceiling (${limits.ordersUnpaidNewPerAccountDay})`, `${rounds} rounds, then ${stop}`);
  }
  {
    // One address, many accounts: the address ceiling with replace.
    const ip = "198.51.100.200"; let made = 0; let stop = "";
    for (let a = 0; a < 6 && !stop; a++) {
      const p = await person(`shared-${a}@buyer.test`); p.ip = ip;
      let qid = null;
      for (let n = 0; n < 8; n++) { qid = await quote(p, 2 + n, qid); const c = await pay(p, qid); if (c.status !== 200) { stop = `account ${a + 1}, checkout ${n + 1}: ${c.status} ${c.body.code}`; break; } made++; }
    }
    R.check(made === limits.ordersUnpaidNewPerClientDay, `accounts behind one address, each changing its quote over and over: stopped at the address's day ceiling (${limits.ordersUnpaidNewPerClientDay})`, `${made} checkouts, then ${stop}`);
  }

  console.log("\n4. cancel");
  {
    const pat = await person("pat@buyer.test");
    const quinn = await person("quinn@buyer.test");
    const q = await quote(pat, 2); const c = await pay(pat, q);
    const id = c.body.orderId;
    const anon = await h.raw("POST", `/api/orders/${id}/cancel`, { json: {} });
    const other = await h.post(`/api/orders/${id}/cancel`, {}, quinn.token);
    const cookieOnly = await h.raw("POST", `/api/orders/${id}/cancel`, { json: {}, headers: { Cookie: `se_session=${pat.token}` } });
    const cookieForm = await h.raw("POST", `/api/orders/${id}/cancel`, { headers: { Cookie: `se_session=${pat.token}`, "Content-Type": "text/plain", Origin: "https://evil.example" } });
    const unknown = await h.post("/api/orders/00000000-0000-4000-8000-000000000000/cancel", {}, pat.token);
    R.check(anon.status === 401 && other.status === 403 && st(id) === "pending_payment", "signed out: 401. Another customer: 403. The order is untouched", `${anon.status}, ${other.status}; unknown id ${unknown.status}`);
    R.check(cookieOnly.status === 403 && cookieForm.status === 403 && st(id) === "pending_payment", "the session cookie WITHOUT the page's CSRF token (what another site could make a browser send): 403", `${cookieOnly.status} ${cookieOnly.body && cookieOnly.body.code}, ${cookieForm.status} ${cookieForm.body && cookieForm.body.code}`);
    h.stripe.failExpire = true;
    const realRetrieve = require(path.join(ROOT, "server/services/stripeClient")).get().checkout.sessions.retrieve;
    require(path.join(ROOT, "server/services/stripeClient")).get().checkout.sessions.retrieve = async () => { throw new Error("stripe unavailable"); };
    const busy = await h.post(`/api/orders/${id}/cancel`, {}, pat.token);
    require(path.join(ROOT, "server/services/stripeClient")).get().checkout.sessions.retrieve = realRetrieve;
    h.stripe.failExpire = false;
    R.check(busy.status === 502 && st(id) === "pending_payment" && h.stripe.sessions[sid(c)].status === "open", "Stripe not answering: the order and its page are left as they were", `${busy.status} ${busy.body.code}`);
    // cancel and a checkout of the same order at the same moment
    h.stripe.delayMs = 30;
    const [x1, x2] = await Promise.all([pay(pat, q, { shippingAddress: "200 Other St" }), h.post(`/api/orders/${id}/cancel`, {}, pat.token)]);
    h.stripe.delayMs = 0;
    const o = ordersDB.getById(id);
    const openPages = Object.values(h.stripe.sessions).filter((s) => s.metadata && s.metadata.orderId === id && s.status === "open").length;
    R.check((o.status === "expired" && openPages === 0) || (o.status === "pending_payment" && openPages === 1), "cancel and a checkout of the same order at the same moment: either closed with no page open, or waiting with exactly one", `checkout ${x1.status} ${x1.body.code || ""}, cancel ${x2.status} ${x2.body.code || ""}; order ${st(id)}, open pages ${openPages}`);
    // a page paid a moment before the cancel
    const q2 = await quote(pat, 3); const c2 = await pay(pat, q2);
    h.pay(sid(c2));
    const paidCancel = await h.post(`/api/orders/${c2.body.orderId}/cancel`, {}, pat.token);
    R.check(paidCancel.status === 409 && paidCancel.body.code === "cancel-order-paid" && st(c2.body.orderId) === "paid", "the page was paid a moment before Cancel was pressed: the order is settled, not cancelled, and the buyer is told", `${paidCancel.status} ${paidCancel.body.code}; ${st(c2.body.orderId)}`);
    const again = await h.post(`/api/orders/${c2.body.orderId}/cancel`, {}, pat.token);
    await h.put(`/api/orders/${c2.body.orderId}/status`, { status: "in_production" }, owner);
    const inProd = await h.post(`/api/orders/${c2.body.orderId}/cancel`, {}, pat.token);
    R.check(again.status === 409 && inProd.status === 409 && ordersDB.getById(c2.body.orderId).status !== "expired" && ordersDB.getById(c2.body.orderId).status !== "cancelled", "a paid order and an order in production cannot be cancelled by the buyer", `${again.status} ${again.body.code}; ${inProd.status} ${inProd.body.code}; order ${st(c2.body.orderId)}`);
    // cancel, then cancel again, then a payment that still arrives
    const q3 = await quote(pat, 4); const c3 = await pay(pat, q3);
    const k1 = await h.post(`/api/orders/${c3.body.orderId}/cancel`, {}, pat.token);
    const k2 = await h.post(`/api/orders/${c3.body.orderId}/cancel`, {}, pat.token);
    await h.webhook("checkout.session.completed", { ...h.stripe.sessions[sid(c3)], status: "complete", payment_status: "paid", payment_intent: "pi_after_cancel" });
    R.check(k1.status === 200 && k2.status === 409 && st(c3.body.orderId) === "expired/late-payment", "cancelled; a second cancel is refused; a payment that still arrives is flagged for the owner", `${k1.status}, ${k2.status} ${k2.body.code}; ${st(c3.body.orderId)}`);
    const view = (await h.get("/api/orders", pat.token)).body.find((x) => x.id === c3.body.orderId);
    R.info("what the cancelled-then-paid order looks like to the buyer in Your orders", `status "${view.status}", canCancel ${view.canCancel}`);
    // a phone order made for this buyer
    const pq = await quote(pat, 6);
    const phone = await h.post("/api/orders", { quoteId: pq, ...SHIP }, owner);
    const pc = await h.post(`/api/orders/${phone.body.orderId}/cancel`, {}, pat.token);
    R.check(pc.status >= 400 && st(phone.body.orderId) === "pending_payment", "the buyer cannot cancel an order the owner took by phone", `${pc.status} ${pc.body.code || ""}`);
  }

  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
