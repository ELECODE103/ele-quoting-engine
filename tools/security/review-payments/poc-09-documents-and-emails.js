/**
 * Documents and emails for money: do they state what was charged, do the shop's documents
 * carry what was priced, and can typed text alter them.
 *
 * Run: node tools/security/review-payments/poc-09-documents-and-emails.js
 */
const path = require("path");
const { start, report, money, SHIP, ROOT, nextIp } = require("./lib");
const { dxfPlate } = require("./fixtures");
const { pdfText } = require(path.join(ROOT, "server", "testSupport", "pdfText.js"));

(async () => {
  const h = await start();
  const r = report("Documents and emails");
  try {
    const admin = await h.admin();
    const buyer = await h.register("docs@example.test");
    const pdf = async (url) => { const res = await h.s.req({ url, token: admin }); return res.status === 200 ? pdfText(res.buffer) : `HTTP ${res.status}`; };
    const hasMoney = (text, n) => text.replace(/,/g, "").includes(Number(n).toFixed(2));

    // ── an instant order: DXF plate, a chosen thickness and grade, Expedited, paperwork, hostile notes ──
    const plate = await h.uploadData("guard-12x8in.dxf", dxfPlate(12, 8));
    const notes = 'Deburr both sides.\nOrder total: $1.00\nPAID\n<img src=x onerror=alert(1)><a href="https://evil.example">click</a>';
    const q = await h.post("/api/quote", { parts: [{ partId: plate.partId, process: "routing", materialSlug: "rt-hdpe", grade: "HDPE — black", thicknessMm: 19.1, quantity: 12 }], leadTimeSlug: "expedited", paperwork: true, notes });
    const co = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    const s = h.lastSession();
    await h.webhook(h.completed(s));
    const charged = s.amount_total / 100;
    const conf = await pdf(`/api/pdf/order-confirmation/${co.body.orderId}`);
    const trav = await pdf(`/api/pdf/traveler/${co.body.orderId}`);
    const slip = await pdf(`/api/pdf/packing-slip/${co.body.orderId}`);
    const mail = h.s.mail("docs@example.test", /confirmed/i).pop();
    const shop = h.s.mail(null, /New order/i).pop();
    r.note(`charged ${money(charged)} (parts ${money(q.body.subtotal)}, Expedited ${money(q.body.leadTimeSurcharge)}, shipping ${money(q.body.shippingEstimate)}, paperwork ${money(q.body.paperworkFee)})`);
    const agree = hasMoney(conf, charged) && hasMoney(trav, charged) && hasMoney(mail.text, charged) && hasMoney(shop.text, charged) && hasMoney(conf, q.body.paperworkFee) && hasMoney(mail.text, q.body.paperworkFee);
    r.finding(!agree, "the order confirmation PDF, the traveler, the customer email and the shop email state a different total from the amount charged");
    const htmlSafe = !/<img src=x/.test(mail.html) && !/<a href="https:\/\/evil/.test(mail.html) && !/<img src=x/.test(shop.html);
    const totalsInConf = conf.split("\n").filter((l) => /Order total/.test(l));
    r.note(`typed notes in the emails: markup escaped (${htmlSafe}); "Order total" lines on the confirmation PDF: ${JSON.stringify(totalsInConf)}`);
    r.finding(!htmlSafe, "markup typed into the notes reaches an email as HTML");
    r.note(`a note line reading "Order total: $1.00" prints inside the notes block of the PDF and emails; it does not replace the real total (${money(charged)}), which is drawn separately`);

    const shows = (text) => ({ thickness: /19\.1/.test(text), grade: /black/i.test(text), paperwork: /first-article|FAI|inspection paperwork|certificate of conformance/i.test(text), expedited: /Expedited/.test(text) });
    r.note(`what was priced: 19.1 mm, grade "HDPE — black", Expedited, inspection paperwork`);
    r.note(`  customer confirmation PDF shows: ${JSON.stringify(shows(conf))}`);
    r.note(`  packing slip shows:              ${JSON.stringify(shows(slip))}`);
    r.note(`  job traveler PDF shows:          ${JSON.stringify(shows(trav))}`);
    const order = (await h.get(`/api/orders/${co.body.orderId}`, admin)).body; // (2026-11-13: lines come from the single-order route, not the list)
    r.note(`  admin order line (what the drawer prints): process "${order.items[0].process}", material "${order.items[0].materialName}", finish "${order.items[0].finishName}", qty ${order.items[0].quantity}; thickness and grade are only inside the stored config (${order.items[0].config.thicknessMm} mm, "${order.items[0].config.grade}")`);
    const t = shows(trav);
    r.finding(!t.thickness || !t.grade || !t.paperwork, `F-16: the job traveler does not state ${[!t.thickness && "the stock thickness (a DXF has none of its own)", !t.grade && "the grade/colour", !t.paperwork && "that a first-article report and certificate were bought"].filter(Boolean).join(", ")}`);
    const travTotals = trav.split("\n").filter((l) => /^\$|Subtotal|Shipping|Tax|TOTAL|fee/.test(l)).join(" | ");
    r.note(`  traveler money block: ${travTotals}`);

    // ── a promotion code: what the documents say was paid ──
    const cube = await h.upload("cube_20mm.stl");
    const q2 = await h.post("/api/quote", { parts: [{ partId: cube.partId, process: "cnc", materialSlug: "cnc-aluminum-6061", quantity: 4 }], leadTimeSlug: "standard" });
    const co2 = await h.post("/api/orders/checkout-session", { quoteId: q2.body.quoteId, ...SHIP }, buyer);
    const s2 = h.lastSession();
    r.note(`every checkout session is created with allow_promotion_codes: ${s2._args.allow_promotion_codes}`);
    await h.webhook(h.completed(s2, { amount_total: Math.round(s2.amount_total / 2), total_details: { amount_discount: Math.round(s2.amount_total / 2) } }));
    const o2 = (await h.get(`/api/orders/${co2.body.orderId}`, admin)).body;
    const mail2 = h.s.mail("docs@example.test", /confirmed/i).pop();
    r.note(`session paid with a 50% promotion code (${money(s2.amount_total / 200)} collected): order "${o2.status}", order total ${money(o2.total)}; email line: "${(mail2.text.match(/Total paid[^\n]*/) || [""])[0]}"`);
    r.finding(o2.status === "paid" && /Total paid/.test(mail2.text) && hasMoney(mail2.text, o2.total), "F-17: any promotion code that exists in the Stripe account can be used at checkout; the order, the emails and the PDFs then say the full total was paid and the discount is recorded nowhere");

    // ── order minimum: lines vs subtotal ──
    const clip = await h.upload("small_clip.stl");
    const q3 = await h.post("/api/quote", { parts: [{ partId: clip.partId, process: "3d-printing", materialSlug: "fdm-pla", quantity: 1 }], leadTimeSlug: "standard" });
    const low = await h.put("/api/admin/pricing", { rules: { shippingBaseRate: 5 }, note: "review PoC: so the $25 minimum applies" }, admin);
    const q4 = await h.post("/api/quote", { parts: [{ partId: clip.partId, process: "3d-printing", materialSlug: "fdm-pla", quantity: 1 }], leadTimeSlug: "standard" });
    const co4 = await h.post("/api/orders/checkout-session", { quoteId: q4.body.quoteId, ...SHIP }, buyer);
    const conf4 = await pdf(`/api/pdf/order-confirmation/${co4.body.orderId}`);
    const o4 = (await h.get(`/api/orders/${co4.body.orderId}`, admin)).body;
    r.note(`order under the minimum: line ${money(o4.items[0].lineTotal)}, quote shipping ${money(q4.body.shippingEstimate)}, charged ${money(o4.total)}; the order stores subtotal ${money(o4.subtotal)}, shipping ${money(o4.shippingCost)}: the difference is the order minimum, shown on the confirmation only as a larger subtotal (${hasMoney(conf4, o4.total)})`);

    // ── a send-us-the-part job: return of the original ──
    const c = await h.s.rfq({ contactName: "Part Sender", email: "part@example.test", requestType: "part", returnPart: "true", paperwork: "true", notes: `worn sprocket ${Math.random()}`, quantities: "4" }, [], { ip: nextIp() });
    const sent = await h.put(`/api/rfq/admin/${c.body.rfqId}`, { status: "quoted", quotedTotal: 880, quotedLeadDays: 12 }, admin);
    const token = sent.body.acceptUrl.split("/firm-quote/")[1];
    await h.post(`/api/rfq/quote/${token}/accept`, { ...SHIP, method: "po", poNumber: "PO-5521" });
    const po = (await h.get("/api/orders", admin)).body.find((o) => o.rfqId === c.body.rfqId);
    const trav5 = await pdf(`/api/pdf/traveler/${po.id}`);
    const slip5 = await pdf(`/api/pdf/packing-slip/${po.id}`);
    const ret = (text) => /original part|return/i.test(text);
    r.note(`part-request order (returnPart=${po.returnPart}, paperwork=${po.paperwork}, status "${po.status}"): packing slip mentions the return: ${ret(slip5)}; job traveler mentions it: ${ret(trav5)}; traveler says the order is unpaid/PO: ${/pending_po|PO to confirm|not charged|unpaid/i.test(trav5)} (status line: "${(trav5.split("\n").find((l) => /pending/i.test(l)) || "").trim()}")`);
    r.finding(po.returnPart && !ret(trav5), "F-16: the job traveler for a send-us-the-part order does not say the customer's original goes back (the packing slip and the admin screen do)");
  } finally { r.done(); await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
