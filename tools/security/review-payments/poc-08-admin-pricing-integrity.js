/**
 * Admin-side price integrity: what the pricing screens accept, what the site then sells at,
 * and what is written down when prices change.
 *
 * Run: node tools/security/review-payments/poc-08-admin-pricing-integrity.js
 */
const { start, report, money, SHIP } = require("./lib");

(async () => {
  const h = await start();
  const r = report("Admin pricing integrity");
  try {
    const admin = await h.admin();
    const buyer = await h.register("adminprice@example.test");
    const block = await h.upload("bracket_block.stl");
    const cube = await h.upload("cube_20mm.stl");
    const mats = (await h.get("/api/admin/materials", admin)).body;
    const priciest = mats.filter((m) => m.process === "cnc" && m.active).sort((a, b) => (b.pricePerKg || 0) - (a.pricePerKg || 0))[0];
    const body = (slug = priciest.slug, extra = {}) => ({ parts: [{ partId: block.partId, process: "cnc", materialSlug: slug, quantity: 25 }], leadTimeSlug: "standard", ...extra });
    // review-fixes: priced by the signed-in buyer who checks out below (a part belongs to the account that buys it: F5); a refusal keeps its code.
    const price = async (b = body()) => { const q = await h.post("/api/quote", b, buyer); return q.status === 200 ? q.body : { error: q.body.error, code: q.body.code, status: q.status }; };
    const history = async () => (await h.get("/api/admin/pricing/history", admin)).body.length;

    // ── rules: bounds ──
    const bad = {
      "margin 100%": { marginPercent: 1 }, "margin 95%": { marginPercent: 0.95 }, "margin negative": { marginPercent: -0.2 }, "margin blank": { marginPercent: "" }, "margin null": { marginPercent: null },
      "margin NaN text": { marginPercent: "abc" }, "margin 1e999": { marginPercent: "1e999" }, "mill rate 0": { cncMachineRatePerHour: 0 }, "minimum order -5": { minimumOrderTotal: -5 },
      "paperwork fee -10": { paperworkFeePerPart: -10 }, "expedited multiplier 0.5": { rushMultipliers: { expedited: 0.5 } }, "expedited multiplier blank": { rushMultipliers: { expedited: "" } },
      "quantity break 100% off": { volumeDiscounts: [{ minQty: 1, discount: 1 }] }, "quantity break negative": { volumeDiscounts: [{ minQty: 1, discount: -0.5 }] },
      "unknown key": { freeShipping: true }, "__proto__": JSON.parse('{"__proto__":{"marginPercent":0}}'), "threshold 0": { rfqQuantityThreshold: 0 }, "threshold 2.5": { rfqQuantityThreshold: 2.5 },
    };
    const accepted = [];
    for (const [k, rules] of Object.entries(bad)) { const s = await h.put("/api/admin/pricing", { rules, note: "review PoC" }, admin); if (s.status === 200 && !s.body.unchanged) accepted.push(k); }
    const noNote = await h.put("/api/admin/pricing", { rules: { marginPercent: 0.5 } }, admin);
    r.note(`${Object.keys(bad).length} out-of-range or malformed rule values sent; accepted: ${accepted.length ? accepted.join(", ") : "none"}; a save with no note: ${noNote.status}`);
    r.finding(accepted.length > 0, "the rule schema accepts a value that makes prices zero, negative or NaN");
    await h.post("/api/admin/pricing/reset", { note: "review PoC reset" }, admin);

    // ── rules: the lowest legal settings, and whether the site sells at them ──
    const normal = await price(body("cnc-aluminum-6061"));
    const low = await h.put("/api/admin/pricing", { note: "review PoC: every floor at its legal minimum", rules: { marginPercent: 0, minimumPartPrice: 0, minimumOrderTotal: 0, shippingBaseRate: 0, shippingPerKg: 0, cncMachineRatePerHour: 20, laborRatePerHour: 10, nestingEfficiencyBonus: 0.9, volumeDiscounts: [{ minQty: 1, discount: 0.9 }] } }, admin);
    const floor = await price(body("cnc-aluminum-6061"));
    const co = floor.quoteId ? await h.post("/api/orders/checkout-session", { quoteId: floor.quoteId, ...SHIP }, buyer) : { status: 0 };
    r.note(`25 brackets in aluminum: ${money(normal.orderTotal)} at the shipped rules; with margin 0, floors 0, shipping 0, mill rate $20/h and a 90% quantity break (save ${low.status}): ${floor.quoteId ? money(floor.orderTotal) : `REFUSED ${floor.status} ${floor.code} — ${floor.error}`}; checkout ${co.status || "not reached"}`);
    r.finding(co.status === 200 && floor.orderTotal < normal.orderTotal * 0.1, `F-12: nothing refuses to sell at a price far under cost: each value is inside its own range, and checkout only refuses a total of zero or less (orders.js:85)`);
    await h.post("/api/admin/pricing/reset", { note: "review PoC reset" }, admin);

    // ── materials: blank and zero prices ──
    const before = await price();
    const h0 = await history();
    const blank = await h.put(`/api/admin/materials/${priciest.id}`, { pricePerKg: "" }, admin);
    const afterBlank = await price();
    const zero = await h.put(`/api/admin/materials/${priciest.id}`, { pricePerKg: 0 }, admin);
    const afterZero = await price();
    r.note(`${priciest.name} at $${priciest.pricePerKg}/kg, 25 brackets: ${money(before.orderTotal)} (material ${money(before.lineItems[0].perUnit.material)} each)`);
    r.note(`price field saved blank: ${blank.status}, stored as ${JSON.stringify(blank.body.pricePerKg)} -> ${money(afterBlank.orderTotal)} (material ${money(afterBlank.lineItems[0].perUnit.material)} each); saved as 0: ${zero.status} -> ${money(afterZero.orderTotal)} (material ${money(afterZero.lineItems[0].perUnit.material)} each)`);
    r.finding(blank.status === 200 && afterBlank.orderTotal < before.orderTotal - 1, `F-13: a material saved with a blank (or 0) price is not refused: it is priced at a built-in $1/kg and still sold`);
    await h.put(`/api/admin/materials/${priciest.id}`, { pricePerKg: priciest.pricePerKg }, admin);
    const mach = await h.put(`/api/admin/materials/${priciest.id}`, { machinability: "" }, admin);
    const afterMach = await price();
    r.note(`machinability saved blank: ${mach.status}, stored ${JSON.stringify(mach.body.machinability)} -> ${afterMach.orderTotal ? money(afterMach.orderTotal) : afterMach.error} (was ${money(before.orderTotal)}): a blank is read as the slowest material there is`);
    await h.put(`/api/admin/materials/${priciest.id}`, { machinability: priciest.machinability }, admin);

    // ── lead time multiplier: two places, one wins silently ──
    const lts = (await h.get("/api/admin/lead-times", admin)).body;
    const exp = lts.find((l) => l.slug === "expedited");
    const e0 = await price(body("cnc-aluminum-6061", { leadTimeSlug: "expedited" }));
    const tries = {};
    for (const v of ["", null, 0, 0.5, "abc", 11]) tries[JSON.stringify(v)] = (await h.put(`/api/admin/lead-times/${exp.id}`, { multiplier: v }, admin)).status;
    const set2 = await h.put(`/api/admin/lead-times/${exp.id}`, { multiplier: 2 }, admin);
    const e1 = await price(body("cnc-aluminum-6061", { leadTimeSlug: "expedited" }));
    r.note(`lead-time multiplier blank/0/0.5/text/11: ${JSON.stringify(tries)}`);
    r.note(`Expedited multiplier set to 2 on the lead-time record: ${set2.status}, stored ${set2.body.multiplier}; Expedited quote before ${money(e0.orderTotal)} (x${e0.leadTimeMultiplier}), after ${money(e1.orderTotal)} (x${e1.leadTimeMultiplier})`);
    r.finding(set2.status === 200 && e1.leadTimeMultiplier === e0.leadTimeMultiplier, "F-14: the multiplier saved on a lead time is never used for Standard/Expedited: the rate card's rush table always wins (api.js:496), so the edit saves and changes nothing");
    const fin = (await h.get("/api/admin/finishes", admin)).body.find((f) => f.slug === "cnc-anodize-clear");
    const finBlank = await h.put(`/api/admin/finishes/${fin.id}`, { pricePerPart: "" }, admin);
    r.note(`finish price saved blank: ${finBlank.status} (${finBlank.body.error || ""})`);

    // ── what is written down ──
    await h.put(`/api/admin/finishes/${fin.id}`, { pricePerPart: 0, pricePerSqIn: 0 }, admin);
    const h1 = await history();
    await h.put("/api/admin/pricing", { rules: { marginPercent: 0.45 }, note: "review PoC: margin" }, admin);
    const h2 = await history();
    const last = (await h.get("/api/admin/pricing/history", admin)).body[0];
    r.note(`pricing history entries: ${h0} before; ${h1} after 5 material edits, 1 lead-time edit and 1 finish edit (anodize set to $0); ${h2} after one rule change -> entry: ${last.userEmail}, "${last.note}", ${JSON.stringify(last.diff)}`);
    r.finding(h1 === h0, "F-15: changes to a material's price, a finish's price or a lead time leave no record (only the rate card is logged); order status changes, including a hand-set \"paid\", are not logged either");
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
