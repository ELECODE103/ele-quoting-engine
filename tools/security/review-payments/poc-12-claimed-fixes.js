/**
 * Claims from docs/security/hardening-2026-11-11-{server,accounts,integration}.md that touch
 * money, re-tested by attack where the other scripts had not already done so.
 *
 * Run: node tools/security/review-payments/poc-12-claimed-fixes.js
 */
const { start, report, money, SHIP } = require("./lib");

(async () => {
  const r = report("Claimed fixes re-tested");
  // FRONTEND_URL unset, so the base for Stripe's return URLs and firm-quote links must come from the server's own list.
  let h = await start({ env: { FRONTEND_URL: "" } });
  try {
    const admin = await h.admin();
    const buyer = await h.register("claims@example.test");
    const cube = await h.upload("cube_20mm.stl");
    const cfg = { partId: cube.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity: 3 };

    // accounts 8b — Host header in Stripe return URLs and firm-quote links
    const q = await h.post("/api/quote", { parts: [cfg], leadTimeSlug: "standard" });
    const co = await h.s.req({ method: "POST", url: "/api/orders/checkout-session", json: { quoteId: q.body.quoteId, ...SHIP }, token: buyer, headers: { Host: "evil.example", "X-Forwarded-Host": "evil.example", Origin: "https://evil.example" }, ip: "198.51.77.1" });
    const s = h.lastSession();
    r.note(`checkout with Host: evil.example (FRONTEND_URL unset): ${co.status}; success_url ${s._args.success_url.replace(/[0-9a-f-]{36}/, "<order>")}`);
    r.finding(/evil\.example/.test(s._args.success_url + s._args.cancel_url), "accounts 8b: a forged Host header reaches Stripe's return URLs");
    const c = await h.s.rfq({ contactName: "Host Check", email: "hostcheck@example.test", notes: "host header", ...SHIP }, [], { ip: "198.51.77.2" }); // (review of 2026-11-13, N-05: a request carries its ship-to address, and the acceptance further down ships there)
    const sent = await h.s.req({ method: "PUT", url: `/api/rfq/admin/${c.body.rfqId}`, json: { status: "quoted", quotedTotal: 500, quotedLeadDays: 5 }, token: admin, headers: { Host: "evil.example" }, ip: "198.51.77.3" });
    const mail = h.s.mail("hostcheck@example.test", /quote/i).pop();
    r.finding(/evil\.example/.test(sent.body.acceptUrl + (mail ? mail.text : "")), `accounts 8b: a forged Host header reaches the emailed firm-quote link (${(sent.body.acceptUrl || "").split("/firm-quote/")[0]})`);

    // accounts 2a — typed text in subjects
    const token = sent.body.acceptUrl.split("/firm-quote/")[1];
    await h.post(`/api/rfq/quote/${token}/accept`, { ...SHIP, method: "po", poNumber: "PO-9\r\nBcc: someone@evil.example", shippingName: "Line\r\nBreak" });
    const subjects = h.s.mail(null, /./).map((m) => m.subject);
    r.finding(subjects.some((x) => /PO-9|Bcc|\r|\n|Line/.test(x)), `accounts 2a: typed text or a line break reaches an email subject (${subjects.length} subjects checked)`);

    // review-fixes: the cube above now belongs to the buyer who checked out with it (F5), so the anonymous
    // requests below use copies of it that nobody has bought.
    const cubeB = await h.upload("cube_20mm.stl");
    const cubeC = await h.upload("cube_20mm.stl");
    const cfgB = { ...cfg, partId: cubeB.partId };
    const cfgC = { ...cfg, partId: cubeC.partId };
    // server "request bodies" — price, status, owner, gate, expiry and id from the body
    const fixedId = "11111111-2222-4333-8444-555555555555";
    const inj = await h.post("/api/quote", { parts: [cfgB], leadTimeSlug: "standard", quoteId: fixedId, status: "ordered", userId: "someone-else", gate: { requiresRfq: false, reasons: [] }, expiresAt: "2099-01-01T00:00:00Z", orderTotal: 1, subtotal: 1, lineItems: [], id: "x" });
    const saved = (await h.get(`/api/quote/${inj.body.quoteId}`)).body;
    r.note(`quote sent with status, userId, gate, expiresAt, orderTotal and a quoteId of the sender's choosing: stored status "${saved.status}", owner ${saved.userId}, total ${money(saved.orderTotal)}, expires ${String(saved.expiresAt).slice(0, 10)}, id ${saved.id === fixedId ? "the one the sender chose" : "server-made"}`);
    r.finding(saved.status !== "draft" || saved.userId || saved.orderTotal < 50 || /^2099/.test(saved.expiresAt), "server: price, status, owner or expiry can be set from the body");
    r.note(`  (the id of a NEW quote is taken from the request when it is an unused UUID — api.js:666; harmless on its own, but the report's "id cannot be set" is not exact)`);
    const gated = await h.post("/api/quote", { parts: [{ ...cfgB, quantity: 500 }], leadTimeSlug: "standard", gate: { requiresRfq: false, reasons: [] } });
    const coG = await h.post("/api/orders/checkout-session", { quoteId: gated.body.quoteId, ...SHIP, gate: { requiresRfq: false } }, buyer);
    r.finding(coG.status === 200, `server: the gate can be cleared from the body (checkout ${coG.status})`);

    // server 12 / integration F1 — blank lead-time multiplier; finish price edits take effect
    const lt = (await h.get("/api/admin/lead-times", admin)).body.find((l) => l.slug === "expedited");
    const blank = await h.put(`/api/admin/lead-times/${lt.id}`, { multiplier: null }, admin);
    const still = await h.post("/api/quote", { parts: [cfgC], leadTimeSlug: "expedited" });
    r.finding(blank.status === 200 || still.status !== 200 || !Number.isFinite(still.body.orderTotal), `server 12: a blank lead-time multiplier is stored or breaks pricing (save ${blank.status}, Expedited quote ${still.status})`);
    const fin = (await h.get("/api/admin/finishes", admin)).body.find((f) => f.slug === "cnc-bead-blast");
    const f0 = await h.post("/api/quote", { parts: [{ ...cfgC, finishSlug: "cnc-bead-blast" }], leadTimeSlug: "standard" });
    await h.put(`/api/admin/finishes/${fin.id}`, { pricePerPart: fin.pricePerPart + 20 }, admin);
    const f1 = await h.post("/api/quote", { parts: [{ ...cfgC, finishSlug: "cnc-bead-blast" }], leadTimeSlug: "standard" });
    r.note(`bead blast +$20 per part in admin: 3 pcs ${money(f0.body.orderTotal)} -> ${money(f1.body.orderTotal)}`);
    r.finding(!(f1.body.orderTotal > f0.body.orderTotal + 60), "integration F1: a finish price edited in admin does not change the next quote");

    // server 13 — DXF units after an order / a request (the fix as claimed)
    const { dxfPlate } = require("./fixtures");
    const p1 = await h.uploadData("a.dxf", dxfPlate(10, 6));
    const q1 = await h.post("/api/quote", { parts: [{ partId: p1.partId, process: "routing", materialSlug: "rt-hdpe", thicknessMm: 6.35, quantity: 2 }], leadTimeSlug: "standard" });
    const noKey = await h.post(`/api/parts/${p1.partId}/units`, { units: "mm" });
    const wrongKey = await h.post(`/api/parts/${p1.partId}/units`, { units: "mm" }, undefined, { "X-Part-Key": cube.editKey });
    const beforeOrder = await h.post(`/api/parts/${p1.partId}/units`, { units: "mm" }, undefined, { "X-Part-Key": p1.editKey });
    await h.post("/api/orders/checkout-session", { quoteId: q1.body.quoteId, ...SHIP }, buyer);
    // review-fixes: after checkout the part is the buyer's account's: the key alone no longer finds it (404), and the
    // buyer, signed in and holding the key, is told it is locked (409) — which is what this check was written to see.
    const q1After = (await h.get(`/api/quote/${q1.body.quoteId}`, buyer)).body;
    const afterOrderKeyOnly = await h.post(`/api/parts/${p1.partId}/units`, { units: "in" }, undefined, { "X-Part-Key": p1.editKey });
    const afterOrder = await h.post(`/api/parts/${p1.partId}/units`, { units: "in" }, buyer, { "X-Part-Key": p1.editKey });
    const p2 = await h.uploadData("b.dxf", dxfPlate(10, 6));
    const q2 = await h.post("/api/quote", { parts: [{ partId: p2.partId, process: "routing", materialSlug: "rt-hdpe", thicknessMm: 6.35, quantity: 2 }], leadTimeSlug: "standard" });
    await h.s.rfq({ contactName: "Units", email: "units@example.test", quoteId: q2.body.quoteId, notes: "units" }, [], { ip: "198.51.77.9" });
    const afterRfq = await h.post(`/api/parts/${p2.partId}/units`, { units: "mm" }, undefined, { "X-Part-Key": p2.editKey });
    r.note(`units change: no key ${noKey.status}; another part's key ${wrongKey.status}; with the key, part on a priced quote but no order yet ${beforeOrder.status}; after the order ${afterOrder.status}; part on a firm-quote request ${afterRfq.status}`);
    r.finding(afterOrder.status !== 409 || afterRfq.status !== 409 || noKey.status === 200 || wrongKey.status === 200, "server 13 / accounts: units can be changed without the key, or after an order or request exists");
    r.note(`  after the order, with the key but no account: ${afterOrderKeyOnly.status}; the quote priced before the units change: ${money(q1.body.orderTotal)}, the same quote as the order was made from it: ${money(q1After.orderTotal)}`);
    // review-fixes: the size can still be corrected before ordering (a buyer fixing inches/millimetres needs that);
    // what matters is that the saved quote is priced again at once, so this counts only if the old price survives.
    r.finding(beforeOrder.status === 200 && Math.abs(q1After.orderTotal - q1.body.orderTotal) < 0.005, "server 13 is incomplete: the lock starts at the order, not at the price, so the size can still change between pricing and paying while the quote keeps its price (F-01, poc-01)");
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
