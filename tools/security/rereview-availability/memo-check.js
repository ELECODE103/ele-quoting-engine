#!/usr/bin/env node
/**
 * Item 6 of the re-review: can the pricing memo hand one visitor another's price, or keep a price
 * past a change of configuration or an admin price change? (Checks; expected: `problems` is empty.)
 * Also shows RR-14: reorder keeps one configuration per part (rows.reorderOfOnePartInTwoThicknesses).
 *
 *   node tools/security/rereview-availability/memo-check.js
 */
const c = require("./common");

(async () => {
  // ── Adapted 2026-11-12 (second integration pass), not to an easier case ──
  // As written, this script compared a quote with the reorder of an order that had never been paid, and
  // priced its last step as a visitor on a part the buyer had since claimed. On the merged tree both are
  // refused before any pricing (an unpaid order has nothing to reorder: RR-14a; a claimed part is its
  // owner's), so the comparison came back empty and was reported as a difference. The order is now paid
  // through the local Stripe stand-in (REVIEW_STUB_PAY, tools/security/review-uploads/preload-stubs.js)
  // and the last step is priced by the part's owner. The lines, parts and options are the same.
  // Reorder has gone through the per-request memo since availability-fixes round 2 (RR-05), so step 2a
  // now compares two routes that both use it; memo against no memo is compared in process by
  // server/routes/pricingAvailability.test.js ("prices exactly as line-by-line pricing does").
  const s = await c.startServer({ stubs: true, env: { REVIEW_STUB_PAY: "1" } });
  try {
    const problems = [];
    const A = "198.51.100.61"; const B = "203.0.113.61";
    const part = await c.uploadOne(s, "plate.dxf", c.g.dxfPlate(40), { ip: A, fields: { process: "routing" } });
    const mats = (await s.get("/api/materials?process=routing", { ip: A })).body;
    const m0 = mats[0]; const m1 = mats.find((m) => m.slug !== m0.slug);
    const th = (m) => (m.thicknesses || []).map((t) => t.mm);
    const base = { partId: part.partId, materialSlug: m0.slug, quantity: 1, process: "routing", thicknessMm: th(m0)[0] };
    const price = async (line, o = {}) => { let q; for (let i = 0; i < 8; i++) { q = await s.post("/api/quote", { parts: [line], leadTimeSlug: o.lead || "standard", ...(o.quoteId ? { quoteId: o.quoteId } : {}) }, { ip: o.ip || A, headers: o.headers, ...(o.token ? { token: o.token } : {}) }); if (q.status !== 429) break; await c.sleep(1200); } return q; };
    const b0 = await price(base);
    const each = (q) => q.body.lineItems[0].perUnit.final;
    // 1. Every change of configuration changes the answer (nothing stale within or across requests).
    const variants = { quantity: { ...base, quantity: 50 }, thickness: { ...base, thicknessMm: th(m0)[th(m0).length - 1] }, material: { ...base, materialSlug: m1.slug, thicknessMm: th(m1)[0] } };
    const rows = { base: each(b0) };
    for (const [k, v] of Object.entries(variants)) { const q = await price(v, { quoteId: b0.body.quoteId }); rows[k] = q.status === 200 ? each(q) : q.body; if (q.status === 200 && each(q) === each(b0)) problems.push(`changing ${k} did not change the unit price`); }
    const leads = (await s.get("/api/lead-times", { ip: A })).body.filter((l) => l.slug !== "standard");
    if (leads[0]) { const q = await price(base, { lead: leads[0].slug }); rows[`lead time ${leads[0].slug}`] = q.status === 200 ? q.body.orderTotal : q.body; if (q.status === 200 && q.body.orderTotal === b0.body.orderTotal) problems.push("changing the lead time did not change the total"); }
    // 2. In one request: the same part on several lines with different options prices each line by its own options.
    const mixed = await s.post("/api/quote", { parts: [base, variants.quantity, variants.thickness, base], leadTimeSlug: "standard" }, { ip: A });
    const got = mixed.body.lineItems.map((l) => l.perUnit.final);
    rows.oneRequestFourLines = got;
    // (A line's unit price in a four-line order is not its price alone: the engine shares set-up across an order.
    //  So the comparison is with the SAME four lines priced by the one route that does not use the memo: reorder.)
    if (got[0] !== got[3] || got[0] === got[1] || got[0] === got[2]) problems.push("lines of one request did not each get their own price");
    const buyer = await s.register("memo-buyer@example.test", { ip: A });
    const ship = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };
    const viaReorder = async (lines) => {
      const memo = await s.post("/api/quote", { parts: lines, leadTimeSlug: "standard" }, { ip: A, token: buyer });
      const co = await s.post("/api/orders/checkout-session", { quoteId: memo.body.quoteId, ...ship }, { ip: A, token: buyer });
      if (co.status !== 200) return { skipped: `checkout refused (${co.status} ${co.body && co.body.code})` };
      const paid = await s.post(`/api/orders/${co.body.orderId}/confirm-payment`, {}, { ip: A, token: buyer });
      const re = await s.post(`/api/orders/${co.body.orderId}/reorder`, {}, { ip: A, token: buyer });
      if (re.status !== 201) return { skipped: `reorder refused (${re.status} ${re.body && re.body.code}; payment step answered ${paid.status})` };
      const plain = (await s.get(`/api/quote/${re.body.quoteId}`, { ip: A, token: buyer })).body;
      const x = memo.body.lineItems.map((l) => l.perUnit.final); const y = (plain.lineItems || []).map((l) => l.perUnit.final);
      return { withMemo: { each: x, total: memo.body.orderTotal }, withoutMemoViaReorder: { each: y, total: plain.orderTotal }, identical: JSON.stringify(x) === JSON.stringify(y) && memo.body.orderTotal === plain.orderTotal };
    };
    // 2a. Memo against no memo, on lines reorder carries faithfully: two different parts, different quantities.
    const part2 = await c.uploadOne(s, "plate-2.dxf", c.g.dxfPlate(12), { ip: A, token: buyer, fields: { process: "routing" } });
    rows.memoAgainstThePlainPath = await viaReorder([base, variants.quantity, { ...variants.thickness, partId: part2.partId }, base]);
    if (rows.memoAgainstThePlainPath.skipped) problems.push(`the comparison with reorder could not be run: ${rows.memoAgainstThePlainPath.skipped}`);
    else if (rows.memoAgainstThePlainPath.identical !== true) problems.push("the quote and its reorder priced the same lines differently");
    // 2b. RR-14 (not the memo): reorder keeps ONE configuration per part, so the same part ordered in two thicknesses comes back in one.
    rows.reorderOfOnePartInTwoThicknesses = await viaReorder([base, variants.thickness]);
    // 3. Two visitors at the same moment, different options, twenty times: each always gets its own.
    let crossed = 0;
    for (let i = 0; i < 20; i++) {
      const [qa, qb] = await Promise.all([price(base, { ip: A }), price(variants.quantity, { ip: B })]);
      if (qa.status === 200 && qb.status === 200 && (each(qa) !== rows.base || each(qb) !== rows.quantity)) crossed++;
    }
    rows.concurrentPairsWithAWrongPrice = crossed;
    if (crossed) problems.push(`${crossed} of 20 concurrent pairs got a price that was not theirs`);
    // 4. The owner changes a price: the very next pricing uses it.
    const admin = await s.admin({ ip: "198.51.100.1" });
    const h = await s.browser(admin);
    const list = (await s.get("/api/admin/materials", { ip: "198.51.100.1", headers: h })).body;
    const row = list.find((m) => m.slug === m0.slug);
    const field = ["costPerSheet", "pricePerKg", "costPerKg"].find((f) => Number(row[f]) > 0);
    const mine = await price(base, { token: buyer });
    rows.sameLineAsItsOwnerBeforeTheChange = mine.status === 200 ? each(mine) : mine.body;
    const put = await s.req({ method: "PUT", url: `/api/admin/materials/${row.id}`, json: { [field]: Number(row[field]) * 3 }, ip: "198.51.100.1", headers: h });
    const after = await price(base, { token: buyer });
    rows.afterTheOwnerTripled = { field, putStatus: put.status, unitPrice: after.status === 200 ? each(after) : after.body };
    if (put.status !== 200 || mine.status !== 200 || after.status !== 200) problems.push("the price-change step could not be run");
    else if (each(after) === each(mine)) problems.push("a price change by the owner was not used by the next pricing");
    c.result({ test: "memo-check", problems, rows, note: "the memo lives for one request (services/pricingMemo.js run() makes a new one each call), so there is nothing to grow between requests" });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
