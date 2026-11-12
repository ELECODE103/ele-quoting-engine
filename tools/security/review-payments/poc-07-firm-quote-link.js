/**
 * Firm quotes and purchase orders: the signed link, the amount charged, PO acceptance.
 *
 * Run: node tools/security/review-payments/poc-07-firm-quote-link.js
 */
const path = require("path");
const { start, report, money, SHIP, ROOT, nextIp } = require("./lib");

(async () => {
  // Stripe's session-create call is given 250 ms, as over a real network (it matters for the concurrent accepts).
  const h = await start({ env: { SE_REVIEW_STRIPE_DELAY_MS: "250" } });
  const r = report("Firm quote link and purchase orders");
  try {
    const admin = await h.admin();
    const buyerToken = await h.register("fq-account@example.test");
    let n = 0;
    /** A request sent from the form, quoted by the owner; returns the emailed link's token. */
    async function quoted(total = 1500, days = 10) {
      const email = `fq${++n}@example.test`;
      const c = await h.s.rfq({ contactName: `Buyer ${n}`, email, company: "Acme Conveyors", notes: `job ${n} ${Math.random()}`, quantities: "250", process: "cnc" }, [], { ip: nextIp() });
      if (c.status !== 201) throw new Error(`rfq create ${c.status}: ${c.text}`);
      const q = await h.put(`/api/rfq/admin/${c.body.rfqId}`, { status: "quoted", quotedTotal: total, quotedLeadDays: days }, admin);
      if (q.status !== 200 || !q.body.acceptUrl) throw new Error(`quote send ${q.status}: ${q.text}`);
      const mail = h.s.mail(email, /quote/i).pop();
      const token = q.body.acceptUrl.split("/firm-quote/")[1];
      return { id: c.body.rfqId, email, token, mailed: Boolean(mail && mail.text.includes(token)) };
    }
    const view = (t) => h.get(`/api/rfq/quote/${t}`);
    const accept = (t, body) => h.post(`/api/rfq/quote/${t}/accept`, { ...SHIP, ...body });

    // ── the token ──
    const a = await quoted(1500);
    const b = await quoted(90);
    const [hd, pl, sg] = a.token.split(".");
    const head = JSON.parse(Buffer.from(hd, "base64url"));
    const claims = JSON.parse(Buffer.from(pl, "base64url"));
    r.note(`link emailed to the address on the request: ${a.mailed}; token header ${JSON.stringify(head)}; claims ${Object.keys(claims).join(", ")} (amt: the amount the link was issued for, in cents: ${claims.amt})`);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = {
      "alg none": `${b64({ alg: "none", typ: "JWT" })}.${pl}.`,
      "signature removed": `${hd}.${pl}.`,
      "A's signature on B's claims": `${hd}.${b.token.split(".")[1]}.${sg}`,
      "rfqId swapped to the $90 quote": `${hd}.${b64({ ...claims, rfqId: b.id })}.${sg}`,
      "expiry pushed out": `${hd}.${b64({ ...claims, exp: claims.exp + 1e7 })}.${sg}`,
      "a login session token": buyerToken,
    };
    const out = {};
    for (const [k, t] of Object.entries(forged)) out[k] = (await view(t)).status;
    r.note(`forged links: ${JSON.stringify(out)}`);
    r.finding(Object.values(out).some((s) => s === 200), "a forged or altered quote link opens a quote");
    const asSession = await h.get("/api/orders", a.token);
    r.finding(asSession.status === 200, `a quote link works as a login token (got ${asSession.status})`);

    // ── revise / withdraw ──
    const rev = await h.put(`/api/rfq/admin/${a.id}`, { status: "quoted", quotedTotal: 1800 }, admin);
    const oldAfterRevise = await accept(a.token, { method: "po", poNumber: "PO-1" });
    r.note(`owner re-sends at $1,800: old link -> ${oldAfterRevise.status} (${oldAfterRevise.body.code})`);
    const newToken = rev.body.acceptUrl.split("/firm-quote/")[1];
    await h.put(`/api/rfq/admin/${a.id}`, { status: "declined" }, admin);
    const afterWithdraw = await accept(newToken, { method: "po", poNumber: "PO-1" });
    r.note(`owner withdraws (status "declined"): current link -> ${afterWithdraw.status} (${afterWithdraw.body.code})`);
    r.finding(oldAfterRevise.status === 201 || afterWithdraw.status === 201, "a superseded or withdrawn quote can still be accepted");

    // ── F-09: price edited without re-sending ──
    const c = await quoted(1500);
    const seen = (await view(c.token)).body.quotedTotal;
    const edit = await h.put(`/api/rfq/admin/${c.id}`, { quotedTotal: 2500 }, admin);
    const acc = await accept(c.token, { method: "card" });
    const s = h.lastSession(); // (updated with the order-lifecycle fixes: there may be no session at all now)
    r.note(`buyer opens the link and sees ${money(seen)}; owner saves a new total of $2,500 without pressing send (quoteSent: ${edit.body.quoteSent}, new email: ${Boolean(edit.body.emailSent)}, link invalidated: ${Boolean(edit.body.linkInvalidated)}); buyer presses accept on the page they have open: ${acc.status} (${acc.body.code || "ok"}), Stripe amount ${s ? money(s.amount_total / 100) : "none: no session was made"}; opening the link again: ${(await view(c.token)).status}`);
    r.finding(acc.status === 201 && Boolean(s) && s.amount_total === 250000, "F-09: saving a new total without re-sending leaves the emailed link live at the new amount: no new email, and the accept request does not say which price the buyer agreed to");
    const resent = await h.put(`/api/rfq/admin/${c.id}`, { status: "quoted" }, admin);
    const fresh = resent.body.acceptUrl.split("/firm-quote/")[1];
    const lied = await accept(fresh, { method: "card", seenTotal: 1500 });
    r.note(`owner sends it again at $2,500: the new link shows ${money((await view(fresh)).body.quotedTotal)}; an accept that says the buyer saw $1,500 -> ${lied.status} (${lied.body.code})`);
    r.finding(lied.status === 201, "F-09: an accept that names a different total from the quote's is honoured");
    const d = await quoted(1500);
    await h.put(`/api/rfq/admin/${d.id}`, { quotedTotal: 0 }, admin);
    const zero = await accept(d.token, { method: "po", poNumber: "PO-ZERO" });
    const orders = (await h.get("/api/orders", admin)).body;
    const zeroOrder = orders.find((o) => o.rfqId === d.id);
    r.note(`owner saves a total of 0 on a quote that is out: PO acceptance -> ${zero.status} (${zero.body.code || "ok"}); order ${zeroOrder ? `"${zeroOrder.status}" for ${money(zeroOrder.total)}` : "none"}`);
    r.finding(Boolean(zeroOrder), "F-09b: a quote whose total was saved as 0 after sending can be accepted on a PO as a $0.00 order in the production queue");

    // ── purchase orders ──
    const e = await quoted(4200);
    const noPo = await accept(e.token, { method: "po", poNumber: "  " });
    const po = await accept(e.token, { method: "po", poNumber: "PO-778\nPAID IN FULL - SHIP TODAY", shippingName: "Someone Else", shippingAddress: "9 Other Rd" });
    const po2 = await accept(e.token, { method: "po", poNumber: "PO-779" });
    const card2 = await accept(e.token, { method: "card" });
    const eo = (await h.get("/api/orders", admin)).body.find((o) => o.rfqId === e.id);
    const inQueue = (await h.get("/api/orders/admin/queue", admin)).body.some((o) => o.id === eo.id);
    // (Updated with the order-lifecycle fixes: a PO number with a line break is refused, so the script then places the order with a clean one.)
    r.note(`PO without a number: ${noPo.status}; PO number with a line break in it: ${po.status} (${po.body.code || "accepted"}); then PO-779: ${po2.status}; card after PO: ${card2.status}`);
    r.note(`order: "${eo.status}", ${money(eo.total)}, ship to "${eo.shippingName}", PO number stored as ${JSON.stringify(eo.poNumber)}; listed in the production queue: ${inQueue}`);
    r.finding(po.status === 201, "F-10: a PO number with a line break in it is accepted");
    r.finding((po.status === 201 && po2.status === 201) || card2.status === 201, "a quote can be accepted more than once in sequence");
    const { pdfText } = require(path.join(ROOT, "server", "testSupport", "pdfText.js"));
    const trav = await h.s.req({ url: `/api/pdf/traveler/${eo.id}`, token: admin });
    const lines = pdfText(trav.buffer).split("\n");
    const i = lines.findIndex((l) => /Customer PO/.test(l));
    r.note(`traveler lines: ${JSON.stringify(lines.slice(i, i + 2))}`);
    r.finding(i >= 0 && /PAID IN FULL/.test(lines[i + 1] || "") && !/Customer PO/.test(lines[i + 1] || ""), "F-10: a line break typed into the PO number puts a separate line of the buyer's text on the job traveler (\"PAID IN FULL - SHIP TODAY\")");

    // ── concurrent accepts ──
    const f = await quoted(3000);
    const [x1, x2] = await Promise.all([accept(f.token, { method: "card" }), accept(f.token, { method: "card" })]);
    const fo = (await h.get("/api/orders", admin)).body.filter((o) => o.rfqId === f.id);
    r.note(`two card accepts at once: ${x1.status}, ${x2.status}; orders created: ${fo.length} (${fo.map((o) => o.status).join(", ")})`);
    const g = await quoted(3000);
    const [y1, y2] = await Promise.all([accept(g.token, { method: "card" }), accept(g.token, { method: "po", poNumber: "PO-RACE" })]);
    const go = (await h.get("/api/orders", admin)).body.filter((o) => o.rfqId === g.id);
    r.note(`card and PO at once: ${y1.status}, ${y2.status}; orders created: ${go.length} (${go.map((o) => `${o.status}/${o.paymentMethod}`).join(", ")})`);
    if (fo.length > 1) r.note(`  both orders have their own open Stripe session for ${money(fo[0].total)}; the quote record points at only one of them`);
    r.finding(fo.length > 1 || go.length > 1, "F-11: two accepts sent at the same moment both succeed: one quote, two orders (the check and the status change are separated by the call to Stripe)");

    // ── control: the same race on the instant path ──
    const racer = await h.register("fq-race@example.test");
    const cube = await h.upload("cube_20mm.stl");
    const cfg = (quantity) => ({ partId: cube.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity });
    const iq = await h.post("/api/quote", { parts: [cfg(1)], leadTimeSlug: "standard" }, racer);
    const [c1, c2] = await Promise.all([h.post("/api/orders/checkout-session", { quoteId: iq.body.quoteId, ...SHIP }, racer), h.post("/api/orders/checkout-session", { quoteId: iq.body.quoteId, ...SHIP }, racer)]);
    r.finding(c1.body.orderId !== c2.body.orderId, `two checkout requests at once for one instant quote make two orders (${c1.status}, ${c2.status}; same order: ${c1.body.orderId === c2.body.orderId})`);
    // Re-pricing the quote in place while its checkout request is waiting on Stripe.
    const iq2 = await h.post("/api/quote", { parts: [cfg(1)], leadTimeSlug: "standard" }, racer);
    const flying = h.post("/api/orders/checkout-session", { quoteId: iq2.body.quoteId, ...SHIP }, racer);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await h.post("/api/quote", { quoteId: iq2.body.quoteId, parts: [cfg(90)], leadTimeSlug: "standard" }, racer);
    const landed = await flying;
    const ls = h.lastSession();
    const lo = (await h.get(`/api/orders/${landed.body.orderId}`, racer)).body;
    const lq = (await h.get(`/api/quote/${iq2.body.quoteId}`, racer)).body;
    r.note(`quote re-priced to 90 pcs while its 1-piece checkout was in flight: order ${lo.items[0].quantity} pc, ${money(lo.total)}, Stripe ${money(ls.amount_total / 100)}; the quote row now reads ${lq.lineItems[0].quantity} pcs, ${money(lq.orderTotal)}, status "${lq.status}"`);
    r.finding(Math.abs(lo.total - ls.amount_total / 100) > 0.005 || lo.items[0].quantity !== 1, "re-pricing a quote during its checkout makes the order and the charge disagree");

    // ── what Stripe is told (review section 8; added with the order-lifecycle fixes) ──
    const urls = h.sessions().filter((x) => x.metadata && x.metadata.rfqId).map((x) => `${x._args.success_url} ${x._args.cancel_url}`);
    const leaked = urls.filter((u) => /firm-quote\/eyJ/.test(u) || u.includes(f.token) || u.includes(g.token));
    r.note(`return URLs given to Stripe for firm-quote orders: ${urls.length} pairs, e.g. ${(urls[0] || "").split(" ")[1]}`);
    r.finding(leaked.length > 0, "the firm-quote link (a credential) is placed in the return URLs sent to Stripe");

    // ── amount paid vs amount quoted ──
    const k = await quoted(1234.567);
    const ka = await accept(k.token, { method: "card", total: 1, quotedTotal: 1, amount: 100 });
    const ks = h.lastSession();
    r.note(`quoted $1,234.567 with a client-sent total of 1: accept ${ka.status}, Stripe amount ${money(ks.amount_total / 100)}`);
    r.finding(ks.amount_total !== 123457, "the buyer can change the amount of a firm quote");
    await h.webhook(h.completed(ks, { amount_subtotal: 100, amount_total: 100 }));
    const ko = (await h.get("/api/orders", admin)).body.find((o) => o.rfqId === k.id);
    r.finding(ko.status === "paid", `a firm-quote order settled with a $1.00 event is marked paid (got "${ko.status}")`);
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
