#!/usr/bin/env node
/**
 * RR-05: POST /api/orders/:id/reorder prices on the main thread with no memo, no gate and no budget
 * (independent review C2, left open by the fix write-up as "another lane's route").
 * A passing fix: healthWorstMs stays in the tens of milliseconds while reorders run, and a second
 * reorder from the same account waits or is told to retry.
 *
 *   node tools/security/rereview-availability/reorder-block.js [holes=4900] [lines=100] [reorders=3]
 *
 * One signed-in customer (confirmed email), ONE order that was never paid for (checkout started, the
 * Stripe page abandoned; Stripe is the repository's local stand-in), then "reorder" on it.
 * /api/health is polled every 50 ms throughout: it is what every other visitor experiences.
 */
const c = require("./common");

(async () => {
  const holes = Number(process.argv[2]) || 4900;
  const nLines = Number(process.argv[3]) || 100;
  const reorders = Number(process.argv[4]) || 3;
  const s = await c.startServer({ stubs: true, env: { REVIEW_STUB_PAY: "1" } });
  try {
    const ip = "192.0.2.80";
    const token = await s.register("reorder@example.test", { ip });
    const data = c.g.dxfManyHoles(holes);
    const part = await c.uploadOne(s, "perforated.dxf", data, { ip, token, fields: { process: "routing" } });
    const { line } = await c.lineFor(s, part.partId, "routing", ip);
    // ── Adapted 2026-11-12 (second integration pass), not to an easier case ──
    // On the merged tree the order this script was written around can no longer exist, for two reasons that
    // are fixes in their own right: (1) a quote over the big-order line ($5,000) cannot be checked out by a
    // customer at all (it goes to a person), and 100 lines of this drawing come to far more; (2) an order that
    // was never paid for cannot be reordered (RR-14a: 409 reorder-not-available). So the script now makes the
    // LARGEST order a customer can make (it halves the number of lines until checkout is open) and pays for it
    // (the local Stripe stand-in reports the session paid: REVIEW_STUB_PAY, tools/security/review-uploads/preload-stubs.js).
    // Everything after that is as it was: the same reorders, timed the same way, against the same health samples.
    let lines = nLines, q, co, quoteMs = 0;
    const refusedAt = [];
    for (;;) {
      const t0 = Date.now();
      q = await s.post("/api/quote", { parts: Array.from({ length: lines }, () => line), leadTimeSlug: "standard" }, { ip, token, timeoutMs: 300000 });
      quoteMs = Date.now() - t0;
      if (q.status !== 200) throw new Error(`quote failed: ${q.status} ${q.text.slice(0, 200)}`);
      co = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" }, { ip, token });
      if (co.status === 200) break;
      if (co.status === 409 && co.body && co.body.code === "rfq-required" && lines > 1) { refusedAt.push({ lines, total: q.body.orderTotal }); lines = Math.floor(lines / 2); continue; }
      throw new Error(`checkout refused: ${co.status} ${co.text.slice(0, 200)}`);
    }
    const settled = await s.post(`/api/orders/${co.body.orderId}/confirm-payment`, {}, { ip, token });
    const order = (await s.get(`/api/orders/${co.body.orderId}`, { ip, token })).body;
    if (!order || order.status !== "paid") throw new Error(`the order could not be paid through the stand-in: ${settled.status} ${String(settled.text || "").slice(0, 200)} (status ${order && order.status})`);
    // Quiet baseline.
    let mon = c.monitor(s);
    await c.sleep(3000);
    const quiet = await mon.stop();
    // Sequential reorders, timed one by one.
    const runs = [];
    mon = c.monitor(s);
    for (let i = 0; i < reorders; i++) {
      const r0 = Date.now();
      const r = await s.post(`/api/orders/${co.body.orderId}/reorder`, {}, { ip, token, timeoutMs: 600000 });
      runs.push({ status: r.status, ms: Date.now() - r0, code: (r.body && r.body.code) || "" });
    }
    const during = await mon.stop();
    // Four at once from the same account and address: is anything turned away?
    mon = c.monitor(s);
    const p0 = Date.now();
    const parallel = await Promise.all(Array.from({ length: 4 }, () => s.post(`/api/orders/${co.body.orderId}/reorder`, {}, { ip, token, timeoutMs: 600000 }).then((r) => r.status)));
    const parallelMs = Date.now() - p0;
    const duringParallel = await mon.stop();
    c.result({
      test: "reorder-block", holes, dxfKb: Math.round(data.length / 1024), linesAskedFor: nLines, lines, orderTotal: q.body.orderTotal,
      checkoutRefusedAsTooLargeAt: refusedAt,
      gateSaysCheckoutIsOpen: !(q.body.gate && q.body.gate.requiresRfq), quoteThroughThePricingRouteMs: quoteMs,
      orderStatus: order && order.status, paid: Boolean(order && order.paidAt),
      reorders: runs,
      healthQuiet: { medianMs: quiet.medianMs, worstMs: quiet.worstMs },
      healthDuringSequentialReorders: { medianMs: during.medianMs, worstMs: during.worstMs, samples: during.samples },
      fourReordersAtOnce: { statuses: parallel, totalMs: parallelMs, healthMedianMs: duringParallel.medianMs, healthWorstMs: duringParallel.worstMs },
      limitThatApplies: "the pricing gate and runner (per-address and per-account pricing time, one pricing request at a time per sender, the limits on new quotes), then the general API limiter",
    });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
