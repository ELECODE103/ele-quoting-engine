#!/usr/bin/env node
/**
 * Review conditions (2026-11-13): section E of the reviewer's `r3-shipping-firm-f06.js`, on its own.
 *
 *   node tools/security/rereview-fixes/r4-f06-race.js [rounds=200]
 *
 * WHY THIS FILE EXISTS. The reviewer's script stops in its section D: it asks for a firm quote with
 * no ship-to address and expects an order to exist after accepting it, and since N-05 was fixed that
 * acceptance goes back to the owner instead. Section E (F-06: tab 1 pays for pickup while tab 2
 * switches the same order to shipping) comes after D, so the script no longer reaches it. Nothing in
 * section E depends on a firm quote. It is copied here unchanged, with the few lines of set-up it
 * uses from the top of that script, so the measurement can still be made.
 *
 * In-process harness, Stripe stand-in, mail captured; nothing leaves the machine.
 */
const assert = require("assert");
const { liftPacing, report, SHIP } = require("../rereview-relaunch/lib");
const { start } = require("../../../server/testSupport/harness");

const ROUNDS = Number(process.argv[2]) || 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  liftPacing();
  process.env.UPLOAD_MAX_PARTS_PER_15MIN = "100000";
  const h = await start({ mailer: "configured" });
  const R = report();
  const { ordersDB } = h.models;
  const owner = await h.admin("Owner");
  const buyer = await h.register("dana@buyer.test", "Dana Buyer");
  const cube = await h.uploadCube();
  const cubeQuote = async (qty = 2, token = buyer) => { const q = await h.post("/api/quote", { parts: [h.cncConfig(cube, qty)], leadTimeSlug: "standard" }, token); assert.strictEqual(q.status, 200, q.text); return q.body; };
  const checkout = (quoteId, body = {}, token = buyer) => h.post("/api/orders/checkout-session", { quoteId, ...SHIP, ...body }, token);
  const settings = async (over) => { const r = await h.put("/api/admin/pricing", { rules: over, note: "second re-review" }, owner); assert.strictEqual(r.status, 200, r.text); };

  // ── E. F-06 under a race (the reviewer's section, unchanged) ──────────────────────────────────
  console.log(`\nE. F-06: tab 1 pays for pickup while tab 2 switches to shipping, ${ROUNDS} rounds`);
  {
    await settings({ shippingLocalPickup: "on" });
    process.env.ORDERS_UNPAID_PER_ACCOUNT = "100000"; process.env.ORDERS_UNPAID_PER_CLIENT = "100000"; process.env.ORDERS_UNPAID_NEW_PER_ACCOUNT_DAY = "100000"; process.env.ORDERS_UNPAID_NEW_PER_CLIENT_DAY = "100000";
    const tally = { rounds: 0, paid: 0, paidPickup: 0, paidShip: 0, unpaid: 0, flagged: 0, wrongAmount: 0, tab2: {}, payerSkipped: 0, doubleCharged: 0 };
    const flaggedExamples = [];
    const sessionsOf = (orderId) => Object.values(h.stripe.sessions).filter((s) => s.metadata && s.metadata.orderId === orderId);
    for (let i = 0; i < ROUNDS; i++) {
      h.stripe.delayMs = [0, 1, 3, 8][i % 4];
      const q = await cubeQuote(2 + (i % 7));
      const a = await checkout(q.quoteId, { shippingOption: "pickup" });
      assert.strictEqual(a.status, 200, a.text);
      const orderId = a.body.orderId;
      const pickupTotal = ordersDB.getById(orderId).total;
      const jitter = () => Math.floor(Math.random() * 14);
      let charged = 0;
      // The buyer in tab 1: pays whatever page of this order is open at Stripe at that instant
      // (Stripe takes money only on an open page), and Stripe then tells the site by webhook.
      const payer = (async () => {
        await sleep(jitter());
        const open = sessionsOf(orderId).find((s) => s.status === "open");
        if (!open) { tally.payerSkipped++; return; }
        Object.assign(open, { payment_status: "paid", status: "complete", payment_intent: `pi_f06_${i}` });
        charged += open.amount_total;
        await sleep(jitter());
        await h.webhook("checkout.session.completed", open);
      })();
      const tab2 = (async () => { await sleep(jitter()); return checkout(q.quoteId, {}); })();
      const back = (async () => { await sleep(jitter() + 5); return h.post(`/api/orders/${orderId}/confirm-payment`, {}, buyer); })();
      const [, t2] = await Promise.all([payer, tab2, back]);
      await sleep(15);
      // A buyer handed a second page by tab 2 may pay that one too if the first payment had not shown yet.
      const o = ordersDB.getById(orderId);
      tally.rounds++;
      tally.tab2[`${t2.status}${t2.body.code ? " " + t2.body.code : ""}`] = (tally.tab2[`${t2.status}${t2.body.code ? " " + t2.body.code : ""}`] || 0) + 1;
      if (o.attention) { tally.flagged++; if (flaggedExamples.length < 4) flaggedExamples.push(`round ${i}: ${o.status}, flag ${o.attention}, method ${o.shippingMethod}, order $${o.total}, pickup was $${pickupTotal}, charged $${charged / 100}, stripe delay ${h.stripe.delayMs} ms, tab 2 → ${t2.status}; "${String(o.attentionNote || "").slice(0, 150)}"`); }
      if (o.status === "paid") {
        tally.paid++;
        if (o.shippingMethod === "pickup") tally.paidPickup++; else tally.paidShip++;
        if (Math.round(o.amountPaid * 100) !== charged || Math.round(o.total * 100) !== charged) { tally.wrongAmount++; if (flaggedExamples.length < 6) flaggedExamples.push(`round ${i}: PAID with amounts that differ: order $${o.total}, amountPaid $${o.amountPaid}, charged $${charged / 100}, method ${o.shippingMethod}`); }
      } else tally.unpaid++;
      if (charged > 0 && o.status !== "paid" && !o.attention) { tally.wrongAmount++; flaggedExamples.push(`round ${i}: charged $${charged / 100} and the order is ${o.status} with no flag`); }
    }
    h.stripe.delayMs = 0;
    R.info("what happened", JSON.stringify(tally));
    R.check(tally.flagged === 0, `a correct payment is never flagged (${tally.flagged} of ${tally.rounds} rounds flagged)`, flaggedExamples.join(" || "));
    R.check(tally.wrongAmount === 0, "every paid order is at the amount that was charged, and no charge is left without a paid or flagged order", `${tally.wrongAmount} of ${tally.rounds}`);
  }

  const findings = R.done();
  await h.stop();
  process.exit(findings ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
