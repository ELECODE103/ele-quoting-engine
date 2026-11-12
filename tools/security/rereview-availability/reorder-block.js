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
  const s = await c.startServer({ stubs: true });
  try {
    const ip = "192.0.2.80";
    const token = await s.register("reorder@example.test", { ip });
    const data = c.g.dxfManyHoles(holes);
    const part = await c.uploadOne(s, "perforated.dxf", data, { ip, token, fields: { process: "routing" } });
    const { line } = await c.lineFor(s, part.partId, "routing", ip);
    const t0 = Date.now();
    const q = await s.post("/api/quote", { parts: Array.from({ length: nLines }, () => line), leadTimeSlug: "standard" }, { ip, token, timeoutMs: 300000 });
    const quoteMs = Date.now() - t0;
    if (q.status !== 200) throw new Error(`quote failed: ${q.status} ${q.text.slice(0, 200)}`);
    const co = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" }, { ip, token });
    if (co.status !== 200) throw new Error(`checkout refused: ${co.status} ${co.text.slice(0, 200)}`);
    const order = (await s.get(`/api/orders/${co.body.orderId}`, { ip, token })).body;
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
      test: "reorder-block", holes, dxfKb: Math.round(data.length / 1024), lines: nLines,
      gateSaysCheckoutIsOpen: !(q.body.gate && q.body.gate.requiresRfq), quoteThroughThePricingRouteMs: quoteMs,
      orderStatus: order && order.status, paid: Boolean(order && order.paidAt),
      reorders: runs,
      healthQuiet: { medianMs: quiet.medianMs, worstMs: quiet.worstMs },
      healthDuringSequentialReorders: { medianMs: during.medianMs, worstMs: during.worstMs, samples: during.samples },
      fourReordersAtOnce: { statuses: parallel, totalMs: parallelMs, healthMedianMs: duringParallel.medianMs, healthWorstMs: duringParallel.worstMs },
      limitThatApplies: "the general API limiter only: 200 requests per 15 minutes per address",
    });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
