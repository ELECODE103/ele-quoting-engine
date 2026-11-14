#!/usr/bin/env node
/**
 * Second re-review (2026-11-13), F-07: does the ORDER in which Stripe's events arrive change where an
 * order ends up?
 *
 *   node tools/security/rereview-fixes/r3-event-orderings.js
 *
 * In-process harness, Stripe stand-in, nothing leaves the machine. For one paid checkout the script
 * delivers a set of events in EVERY order (and with every event repeated), and compares the end state:
 * status, flag, refunded amount, whether the order is in the production queue, and how many
 * confirmations the buyer got. The sets:
 *
 *   completed + full refund                      completed + part refund + full refund
 *   completed + expired (same session)           completed + dispute opened + dispute lost
 *   completed + dispute opened + full refund     async_payment_succeeded + full refund
 *   closed-unpaid-by-the-clean-up, then: completed; completed + full refund (both orders)
 *
 * A FINDING is printed when two orderings of the same events end in different states, when a fully
 * refunded order ends in the production queue with no flag, when a payment is lost (neither paid nor
 * flagged), or when the buyer is sent more than one confirmation.
 */
const assert = require("assert");
const { liftPacing, report, SHIP } = require("../rereview-relaunch/lib");
const { start } = require("../../../server/testSupport/harness");

function permutations(a) {
  if (a.length <= 1) return [a];
  const out = [];
  a.forEach((x, i) => { for (const rest of permutations([...a.slice(0, i), ...a.slice(i + 1)])) out.push([x, ...rest]); });
  return out;
}

(async () => {
  liftPacing();
  const h = await start({ mailer: "configured" });
  const R = report();
  const { ordersDB } = h.models;
  const lifecycle = require("../../../server/services/orderLifecycle");
  const orderState = require("../../../server/services/orderState");
  const buyer = await h.register("dana@buyer.test", "Dana Buyer");
  const partId = await h.uploadCube();
  let n = 0;

  /** A fresh order with an open payment page, and the events that can be delivered for it. */
  async function fresh() {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 2 + (n++ % 5))], leadTimeSlug: "standard" }, buyer);
    assert.strictEqual(q.status, 200, q.text);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    const s = h.stripe.sessions[String(c.body.sessionUrl).split("/").pop()];
    const pi = `pi_r3_${n}`;
    const total = s.amount_total;
    const paidSession = () => ({ ...s, payment_status: "paid", status: "complete", payment_intent: pi });
    const charge = (refunded) => ({ id: `ch_r3_${n}`, object: "charge", payment_intent: pi, amount: total, amount_captured: total, amount_refunded: refunded, currency: "usd", refunded: refunded >= total, metadata: { orderId: c.body.orderId } });
    const dispute = (status) => ({ id: `dp_r3_${n}`, object: "dispute", payment_intent: pi, amount: total, status, reason: "fraudulent", metadata: { orderId: c.body.orderId } });
    const ev = {
      C: () => { Object.assign(s, { payment_status: "paid", status: "complete", payment_intent: pi }); return h.webhook("checkout.session.completed", paidSession()); },
      A: () => { Object.assign(s, { payment_status: "paid", status: "complete", payment_intent: pi }); return h.webhook("checkout.session.async_payment_succeeded", paidSession()); },
      R: () => { Object.assign(s, { payment_intent: pi }); return h.webhook("charge.refunded", charge(total)); },
      P: () => { Object.assign(s, { payment_intent: pi }); return h.webhook("charge.refunded", charge(Math.floor(total / 3))); },
      X: () => h.webhook("checkout.session.expired", { ...s, status: "expired", payment_status: "unpaid", payment_intent: null }),
      D: () => { Object.assign(s, { payment_intent: pi }); return h.webhook("charge.dispute.created", dispute("needs_response")); },
      L: () => { Object.assign(s, { payment_intent: pi }); return h.webhook("charge.dispute.closed", dispute("lost")); },
    };
    return { orderId: c.body.orderId, ev, total, session: s };
  }
  const endState = (orderId) => {
    const o = ordersDB.getById(orderId);
    const idTag = String(orderId).slice(0, 8).toUpperCase();
    const confirmations = h.sent.filter((m) => m.to === "dana@buyer.test" && /order|confirm|received|thank/i.test(m.subject || "") && !/closed|refund/i.test(m.subject || "") && (String(m.subject || "") + String(m.text || "")).toUpperCase().includes(idTag)).length;
    return { status: o.status, flag: o.attention || "-", refunded: Number(o.refundedAmount) || 0, amountPaid: o.amountPaid ?? null, inQueue: orderState.WORK_QUEUE.includes(o.status) && orderState.isWork(o), confirmations };
  };
  // (The refunded AMOUNT differs from order to order, so it is compared as none / part / all of what was charged.)
  const key = (e, total) => `${e.status}|${e.flag}|refunded ${e.refunded <= 0 ? "none" : total && Math.round(e.refunded * 100) >= total ? "all" : "part"}|queue ${e.inQueue}`;

  async function compare(label, letters, { judge } = {}) {
    const results = [];
    for (const perm of permutations(letters)) {
      for (const repeat of [false, true]) {
        const f = await fresh();
        for (const l of perm) { const r = await f.ev[l](); assert.ok(r.status === 200, `${l}: webhook ${r.status} ${r.text}`); if (repeat) { const again = await f.ev[l](); assert.ok(again.status === 200, `${l} again: ${again.status}`); } }
        results.push({ perm: perm.join(">") + (repeat ? " (each twice)" : ""), end: endState(f.orderId), total: f.total });
      }
    }
    const kinds = new Map();
    for (const r of results) { const k = key(r.end, r.total); if (!kinds.has(k)) kinds.set(k, []); kinds.get(k).push(r.perm); }
    const detail = [...kinds.entries()].map(([k, perms]) => `[${k}] ← ${perms.join(", ")}`).join("  ;  ");
    R.check(kinds.size === 1, `${label}: every ordering ends in the same state`, detail);
    const many = results.filter((r) => r.end.confirmations > 1);
    R.check(many.length === 0, `${label}: the buyer is never sent more than one confirmation`, many.map((r) => `${r.perm}: ${r.end.confirmations}`).join("; "));
    if (judge) judge(results);
    return results;
  }

  console.log("\n1. the same events in every order");
  await compare("completed + full refund", ["C", "R"], { judge: (rs) => R.check(rs.every((r) => r.end.status === "refunded" && !r.end.inQueue), "completed + full refund: ends 'refunded' and out of the work queue", rs.map((r) => `${r.perm}: ${r.end.status}`).join("; ")) });
  await compare("async payment succeeded + full refund", ["A", "R"], { judge: (rs) => R.check(rs.every((r) => r.end.status === "refunded" && !r.end.inQueue), "async succeeded + full refund: ends 'refunded'", rs.map((r) => `${r.perm}: ${r.end.status}`).join("; ")) });
  await compare("completed + part refund", ["C", "P"], { judge: (rs) => R.check(rs.every((r) => r.end.status === "paid" && r.end.refunded > 0), "completed + part refund: stays paid with the part refund on record", rs.map((r) => `${r.perm}: ${r.end.status}/${r.end.refunded}`).join("; ")) });
  // (Stripe's charge.refunded carries a RUNNING total, so "part then full" has one meaningful order for P and R; C moves around them.)
  for (const seq of [["C", "P", "R"], ["P", "C", "R"], ["P", "R", "C"]]) {
    const f = await fresh();
    for (const l of seq) await f.ev[l]();
    const e = endState(f.orderId);
    R.check(e.status === "refunded" && !e.inQueue, `part refund then full refund, completed at position ${seq.indexOf("C") + 1}: ends 'refunded'`, `${seq.join(">")}: ${e.status}, flag ${e.flag}, refunded ${e.refunded}, in queue ${e.inQueue}`);
  }
  // (Stripe cannot send both "expired" and "completed" for ONE session, so this pair is informative only:
  // what matters is that the payment is never dropped.)
  for (const seq of [["C", "X"], ["X", "C"]]) {
    const f = await fresh();
    for (const l of seq) await f.ev[l]();
    const e = endState(f.orderId);
    R.check(e.status === "paid" || e.flag !== "-", `completed + expired for one session (${seq.join(">")}): the payment is never dropped (paid, or flagged)`, `${e.status}, flag ${e.flag}`);
  }
  await compare("completed + dispute opened", ["C", "D"], { judge: (rs) => R.check(rs.every((r) => r.end.flag === "dispute"), "completed + dispute opened: flagged 'dispute' whichever comes first", rs.map((r) => `${r.perm}: ${r.end.status}/${r.end.flag}`).join("; ")) });
  for (const seq of [["C", "D", "L"], ["D", "C", "L"], ["D", "L", "C"]]) {
    const f = await fresh();
    for (const l of seq) await f.ev[l]();
    const e = endState(f.orderId);
    R.check(e.flag === "dispute", `dispute opened then lost, completed at position ${seq.indexOf("C") + 1}: still flagged for the owner`, `${seq.join(">")}: ${e.status}, flag ${e.flag}`);
  }
  for (const seq of [["C", "D", "R"], ["D", "R", "C"], ["R", "D", "C"], ["D", "C", "R"]]) {
    const f = await fresh();
    for (const l of seq) await f.ev[l]();
    const e = endState(f.orderId);
    R.check(e.status === "refunded" && !e.inQueue, `dispute + full refund + completed (${seq.join(">")}): ends 'refunded', not in the queue`, `${e.status}, flag ${e.flag}, refunded ${e.refunded}, in queue ${e.inQueue}`);
  }

  console.log("\n2. an order the storage clean-up closed unpaid (F-12), then the money events");
  {
    const f = await fresh();
    const closed = await lifecycle.closeUnderPressure(f.orderId, {});
    const afterClose = endState(f.orderId);
    R.check(closed.outcome === "closed" && afterClose.status === "expired" && f.session.status === "expired", "closed to make room: the order is 'expired' and its payment page is closed at Stripe", `outcome ${closed.outcome}, order ${afterClose.status}, session ${f.session.status}`);
    // Stripe took the money anyway (the expire lost a race with a payment in flight), and says so.
    await f.ev.C();
    const paidLate = endState(f.orderId);
    R.check(paidLate.status !== "paid" && paidLate.flag !== "-", "…then paid anyway: not released, flagged for the owner (the money is not lost sight of)", `${paidLate.status}, flag ${paidLate.flag}, amountPaid ${paidLate.amountPaid}`);
    await f.ev.C();
    R.check(key(endState(f.orderId), f.total) === key(paidLate, f.total), "…the same payment reported again changes nothing");
    await f.ev.R();
    const refunded = endState(f.orderId);
    R.check(!refunded.inQueue && refunded.status !== "paid", "…then refunded in full: not in the work queue", `${refunded.status}, flag ${refunded.flag}, refunded ${refunded.refunded}`);
    R.info("end state of closed → paid late → refunded", JSON.stringify(refunded));
  }
  {
    const f = await fresh();
    await lifecycle.closeUnderPressure(f.orderId, {});
    await f.ev.R();
    await f.ev.C();
    const e = endState(f.orderId);
    R.check(e.status !== "paid" && !e.inQueue, "closed → refund reported → payment reported: never 'paid', never in the queue", JSON.stringify(e));
    // The other order of the same two events (above) ends with the flag cleared ("refunded in full"); this one keeps it.
    if (e.flag !== "-") R.info("…but in this order of events the order stays flagged 'late payment' although the money has already gone back", `flag ${e.flag}, refunded $${e.refunded}; with payment-then-refund the flag is cleared`);
  }
  {
    // The owner marks a lapsed order paid by hand, and then Stripe's events arrive for the old page.
    const f = await fresh();
    await lifecycle.closeUnderPressure(f.orderId, {});
    const owner = await h.admin("Owner");
    const moved = await h.put(`/api/orders/${f.orderId}/status`, { status: "paid", reason: "paid by cheque 1041", paidVia: "check" }, owner);
    await f.ev.C();
    const e = endState(f.orderId);
    // Not possible at Stripe as far as its documentation goes (a page the site expired cannot be paid), so INFO:
    // it shows what the site would do if Stripe ever reported it.
    R.info("closed → marked paid by hand → the old (closed) card page reported paid", `manual move ${moved.status}; ${JSON.stringify(e)}${e.flag === "-" && e.status === "paid" ? " :: the card payment is treated as a repeat and NOT flagged as a second payment" : ""}`);
  }

  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
