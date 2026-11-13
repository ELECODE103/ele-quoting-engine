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

// ── Added 2026-11-13 (re-review fixes): the script now runs TWO orders and reports both ──
// The re-review's audit pointed out that the adapted script reorders 3 lines where it was written to
// reorder 100, and that a 100-line order a customer CAN place exists (100 printed cubes, about $1,650).
//   case 1  the dense drawing, as many lines as checkout allows (the adapted case, unchanged)
//   case 2  100 lines of a 12 mm printed cube: the most lines an order can have
// Each case has its own account and address, so one does not use the other's allowances.
(async () => {
  const holes = Number(process.argv[2]) || 4900;
  const nLines = Number(process.argv[3]) || 100;
  const reorders = Number(process.argv[4]) || 3;
  const s = await c.startServer({ stubs: true, env: { REVIEW_STUB_PAY: "1" } });
  try {
    const dense = await runCase(s, { label: "the dense drawing, as many lines as checkout allows", ip: "192.0.2.80", email: "reorder@example.test", nLines, reorders, holes,
      upload: (o) => c.uploadOne(s, "perforated.dxf", c.g.dxfManyHoles(holes), { ...o, fields: { process: "routing" } }), process: "routing", bytes: c.g.dxfManyHoles(holes).length });
    const many = await runCase(s, { label: "100 lines of a 12 mm printed cube: the most lines an order can have", ip: "192.0.2.81", email: "reorder100@example.test", nLines: 100, reorders, holes: 0,
      upload: (o) => c.uploadOne(s, "block.stl", c.g.stlCube(12), o), process: "3d-printing", bytes: c.g.stlCube(12).length });
    c.result({ test: "reorder-block", cases: [dense, many], limitThatApplies: "the pricing gate and runner (per-address and per-account pricing time, one pricing request at a time per sender, the limits on new quotes), then the general API limiter" });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });

async function runCase(s, { label, ip, email, nLines, reorders, holes, upload, process: proc, bytes }) {
  {
    const token = await s.register(email, { ip });
    const data = { length: bytes };
    const part = await upload({ ip, token });
    const { line } = await c.lineFor(s, part.partId, proc, ip);
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
      q = await s.post("/api/quote", { parts: Array.from({ length: lines }, () => ({ ...line, quantity: 1 })), leadTimeSlug: "standard" }, { ip, token, timeoutMs: 300000 });
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
    const out = {
      case: label, holes, fileKb: Math.round(data.length / 1024), linesAskedFor: nLines, lines, orderTotal: q.body.orderTotal,
      checkoutRefusedAsTooLargeAt: refusedAt,
      gateSaysCheckoutIsOpen: !(q.body.gate && q.body.gate.requiresRfq), quoteThroughThePricingRouteMs: quoteMs,
      orderStatus: order && order.status, paid: Boolean(order && order.paidAt),
      reorders: runs,
      healthQuiet: { medianMs: quiet.medianMs, worstMs: quiet.worstMs },
      healthDuringSequentialReorders: { medianMs: during.medianMs, worstMs: during.worstMs, samples: during.samples },
      fourReordersAtOnce: { statuses: parallel, totalMs: parallelMs, healthMedianMs: duringParallel.medianMs, healthWorstMs: duringParallel.worstMs },
    };
    c.log(JSON.stringify(out));
    return out;
  }
}
