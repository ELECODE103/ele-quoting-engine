/**
 * F-03  Ways to get an instant price and a checkout for work the quote gate sends to a person.
 *
 *  a. quantity limit (100 per line): split a production run across lines of one quote
 *  b. big-ticket limit ($5,000 per line): split across lines; there is no limit on the order total
 *  c. DFM / envelope result is stored per part, not per line: a second line for the same
 *     part in a process where it passes replaces the failing result of the first line
 *  d. the gate result is frozen on the saved quote: tightening the limits in admin does
 *     not stop a quote priced earlier from checking out
 *
 * Run: node tools/security/review-payments/poc-03-gate-bypass.js
 */
const { start, report, money, SHIP } = require("./lib");
const { stlBox } = require("./fixtures");

(async () => {
  const h = await start();
  const r = report("F-03 quote gate bypasses");
  try {
    const quote = (parts, extra = {}) => h.post("/api/quote", { parts, leadTimeSlug: "standard", ...extra });
    const gateOf = (q) => q.body.gate ? (q.body.gate.reasons.map((x) => x.code).join(",") || "none") : `refused: ${q.body.error}`;
    const buyer = await h.register("gate@example.test");
    const admin = await h.admin();
    const checkout = async (q) => { const co = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer); return { co, session: co.status === 200 ? h.lastSession() : null }; };

    // a. quantity split
    const cube = await h.upload("cube_20mm.stl");
    const line = (quantity) => ({ partId: cube.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity });
    const one = await quote([line(500)]);
    const blocked = await checkout(one);
    r.note(`500 pcs on one line: ${money(one.body.orderTotal)}, gate: ${gateOf(one)}; checkout ${blocked.co.status} (${blocked.co.body.code || ""})`);
    const split = await quote([line(100), line(100), line(100), line(100), line(100)]);
    const a = await checkout(split);
    r.note(`500 pcs as 5 lines of 100: ${money(split.body.orderTotal)}, gate: ${gateOf(split)}; checkout ${a.co.status}, Stripe amount ${a.session ? money(a.session.amount_total / 100) : "-"}`);
    r.finding(one.body.gate.requiresRfq && a.co.status === 200, `a 500-piece run checks out without review when split into 5 lines of 100 (the limit is per line, never summed per part or per order)`);
    const max = await quote(Array.from({ length: 100 }, () => line(100)));
    r.note(`100 lines x 100 pcs (10,000 pcs): ${max.status === 200 ? `${money(max.body.orderTotal)}, gate: ${gateOf(max)}` : max.body.error}`);

    // b. big-ticket split
    const tray = await h.upload("pocketed_tray.stl");
    const t = (quantity) => ({ partId: tray.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity });
    const big = await quote([t(60)]);
    const bigSplit = await quote([t(20), t(20), t(20)]);
    const b = await checkout(bigSplit);
    r.note(`60 trays on one line: ${money(big.body.orderTotal)}, gate: ${gateOf(big)}`);
    r.note(`60 trays as 3 lines of 20: ${money(bigSplit.body.orderTotal)}, gate: ${gateOf(bigSplit)}; checkout ${b.co.status}`);
    r.finding(big.body.gate.reasons.some((x) => x.code === "big-ticket") && b.co.status === 200 && bigSplit.body.orderTotal > 5000, `an order of ${money(bigSplit.body.orderTotal)} checks out with no review: the $5,000 limit looks at each line, not at the order`);

    // c. same part on two lines: the last line's DFM result stands for both
    const longBar = await h.uploadData("bar-700x120x25.stl", stlBox(700, 120, 25.4));
    const cncLine = { partId: longBar.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity: 5 };
    const alone = await quote([cncLine]);
    r.note(`700 mm bar, cnc x5 alone: ${money(alone.body.orderTotal)}, gate: ${gateOf(alone)}`);
    const routed = { partId: longBar.partId, process: "routing", materialSlug: "rt-hdpe", thicknessMm: 25.4, quantity: 1 };
    const routedAlone = await quote([routed]);
    r.note(`same bar, routing x1 alone: ${money(routedAlone.body.orderTotal)}, gate: ${gateOf(routedAlone)}`);
    const both = await quote([cncLine, routed]);
    const reversed = await quote([routed, cncLine]);
    r.note(`cnc x5 + routing x1 (same part): gate: ${gateOf(both)}; lines in the other order: gate: ${gateOf(reversed)}`);
    const c = await checkout(both);
    r.finding(alone.body.gate.requiresRfq && !both.body.gate.requiresRfq && c.co.status === 200, `a CNC line the gate stops on its own (${gateOf(alone)}) checks out for ${c.session ? money(c.session.amount_total / 100) : "-"} when a routing line for the same part is added after it`);

    // d. gate frozen on the saved quote
    const before = await quote([line(60)]);
    const save = await h.put("/api/admin/pricing", { rules: { rfqQuantityThreshold: 25, bigTicketLineTotal: 500 }, note: "review PoC: tighten the gate" }, admin);
    const after = await quote([line(60)]);
    const d = await checkout(before);
    r.note(`60 pcs priced before the limits were tightened: gate ${gateOf(before)}; admin save ${save.status}; the same request now: gate ${gateOf(after)}`);
    r.note(`checkout of the earlier quote after the change: ${d.co.status}`);
    r.finding(after.body.gate.requiresRfq && d.co.status === 200, "a quote priced before the owner tightened the gate still checks out (for up to 30 days)");
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
