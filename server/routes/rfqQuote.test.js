/**
 * Quoted RFQ → customer, end to end against the real routes (Stripe stubbed at
 * the boundary, emails captured). Run: `node server/routes/rfqQuote.test.js`
 *
 * Covers: marking an RFQ quoted emails the price, lead time, validity date and
 * a signed expiring accept link; the link shows the quote; accept by card
 * (order + Stripe checkout) or by PO (order + stored PO number); and the
 * accepted / expired status the admin sees.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Quoted RFQ → customer");
const SHIP = { shippingName: "Pat Purchasing", shippingAddress: "500 Plant Rd", shippingCity: "Rockford", shippingState: "IL", shippingZip: "61101" };
const tokenFrom = (m) => (m.text.match(/https:\/\/shop\.test\/firm-quote\/(\S+)/) || [])[1];

(async () => {
  const h = await start();
  const { rfqsDB, ordersDB, orderItemsDB } = h.models;
  const rfqToken = require("../services/rfqToken");
  const shipBy = require("../services/shipBy");
  let owner, partId;

  async function newRfq(email = "pat@oem.test") {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 500)], leadTimeSlug: "standard" });
    assert.strictEqual(q.body.gate.requiresRfq, true, "500 pieces is gated to RFQ");
    // (The request carries the ship-to address since 2026-11-13, review N-05: the quote is priced for it and accepted to it.)
    const r = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: "Pat Purchasing", email, company: "OEM Co", quantities: "500 / 1000", ...SHIP });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.rfqId;
  }
  async function quoted(rfqId, body = {}) {
    h.sent.length = 0;
    const r = await h.put(`/api/rfq/admin/${rfqId}`, { status: "quoted", quotedTotal: 4250, quotedLeadDays: 15, quoteNote: "Price covers 1,000 pcs in natural Delrin, bagged 10 per.", partQuantities: { [partId]: 1000 }, ...body }, owner);
    assert.strictEqual(r.status, 200, r.text);
    return { res: r.body, mail: h.sent[0], token: tokenFrom(h.sent[0]) };
  }

  test("setup: owner account, a part, an RFQ from a gated quote (shop + buyer emails)", async () => {
    owner = await h.admin("Owner");
    partId = await h.uploadCube();
    h.sent.length = 0;
    const id = await newRfq();
    assert.strictEqual(h.sent.length, 2);
    assert.ok(h.sent.some((m) => m.to === "owner@shop.test" && /^RFQ:/.test(m.subject)));
    assert.ok(h.sent.some((m) => m.to === "pat@oem.test" && m.html.includes("STRAIGHTEDGE")));
    rfqsDB.delete(id);
  });

  test("marking quoted needs a price and a lead time", async () => {
    const id = await newRfq();
    h.sent.length = 0;
    assert.strictEqual((await h.put(`/api/rfq/admin/${id}`, { status: "quoted" }, owner)).status, 400);
    assert.strictEqual((await h.put(`/api/rfq/admin/${id}`, { status: "quoted", quotedTotal: 4250 }, owner)).status, 400);
    assert.strictEqual(h.sent.length, 0);
    assert.strictEqual(rfqsDB.getById(id).status, "new");
  });

  let rfqId, token;
  test("marking quoted emails the customer the price, lead time, validity date and a signed link", async () => {
    rfqId = await newRfq();
    const { res, mail, token: t } = await quoted(rfqId);
    token = t;
    assert.strictEqual(h.sent.length, 1);
    assert.strictEqual(mail.to, "pat@oem.test");
    assert.strictEqual(mail.replyTo, "owner@shop.test");
    assert.ok(mail.subject.includes("$4,250.00"));
    assert.ok(mail.text.includes("$4,250.00"));
    assert.ok(mail.text.includes("15 business days"));
    assert.ok(mail.text.includes(shipBy.formatShipBy(shipBy.shipByDate(15))));
    const rfq = rfqsDB.getById(rfqId);
    const validText = new Date(rfq.validUntil).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" });
    assert.ok(mail.text.includes(`Good until: ${validText}`), "validity date in the email");
    assert.ok(mail.text.includes("Price covers 1,000 pcs"));
    assert.ok(mail.text.includes("x 1000"), "quoted quantity, not the builder's 500");
    assert.ok(token, "accept link present");
    assert.ok(mail.html.includes(`https://shop.test/firm-quote/${token}`));
    const days = (new Date(rfq.validUntil) - Date.now()) / 864e5;
    assert.ok(days > 29.9 && days <= 30);
    assert.strictEqual(res.status, "quoted");
    assert.strictEqual(res.quoteSent, true);
    assert.strictEqual(res.emailSent, false, "reported honestly: the mailer is not configured in tests");
    assert.ok(res.acceptUrl.includes("/firm-quote/"), "admin gets the link to send by hand");
  });

  test("the link is signed, names this RFQ, expires with the quote, and is not a login token", async () => {
    const claim = rfqToken.verify(token);
    assert.strictEqual(claim.rfqId, rfqId);
    assert.strictEqual(claim.expired, false);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    assert.strictEqual(payload.exp, Math.floor(new Date(rfqsDB.getById(rfqId).validUntil).getTime() / 1000));
    // Tampering with the payload breaks the signature.
    const forged = { ...payload, rfqId: "someone-elses" };
    const bad = [token.split(".")[0], Buffer.from(JSON.stringify(forged)).toString("base64url"), token.split(".")[2]].join(".");
    assert.strictEqual(rfqToken.verify(bad), null);
    assert.strictEqual((await h.get(`/api/rfq/quote/${bad}`)).status, 404);
    assert.strictEqual((await h.get("/api/rfq/quote/garbage")).status, 404);
    // The quote link must not work as an account token anywhere.
    assert.strictEqual((await h.get("/api/orders", token)).status, 401);
    assert.strictEqual((await h.get("/api/rfq/admin/list", token)).status, 401);
    // ...and a login token is not a quote link.
    assert.strictEqual((await h.get(`/api/rfq/quote/${owner}`)).status, 404);
  });

  test("the accept page data shows the quote, without an account", async () => {
    const r = await h.get(`/api/rfq/quote/${token}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, "quoted");
    assert.strictEqual(r.body.quotedTotal, 4250);
    assert.strictEqual(r.body.quotedLeadDays, 15);
    assert.strictEqual(r.body.shipBy, shipBy.shipByDate(15));
    assert.ok(r.body.validUntil);
    assert.strictEqual(r.body.parts[0].fileName, "cube_20mm.stl");
    assert.strictEqual(r.body.parts[0].quantity, 1000);
    assert.ok(r.body.parts[0].materialName);
    assert.strictEqual(r.body.order, null);
    assert.ok(!("drawingPath" in r.body) && !("id" in r.body));
  });

  test("accept needs a method, a ship-to address, and a PO number for PO", async () => {
    assert.strictEqual((await h.post(`/api/rfq/quote/${token}/accept`, { ...SHIP })).status, 400);
    assert.strictEqual((await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", ...SHIP })).status, 400);
    // (review of 2026-11-13, N-05) This quote was priced for the address on its request, so accepting it no longer
    // needs the address typed again (that is the next case). A request that came WITHOUT an address still needs
    // one before anything else happens:
    const bare = await h.form("/api/rfq", { contactName: "Pat Purchasing", email: "bare@oem.test", quantities: "10" });
    const bareQuote = await quoted(bare.body.rfqId, { partQuantities: undefined, quotedTotal: 300, quotedLeadDays: 5 });
    const noAddress = await h.post(`/api/rfq/quote/${bareQuote.token}/accept`, { method: "po", poNumber: "PO-1" });
    assert.deepStrictEqual([noAddress.status, noAddress.body.code], [400, "address-required"]);
    assert.strictEqual(rfqsDB.getById(bare.body.rfqId).status, "quoted");
    rfqsDB.delete(bare.body.rfqId);
    assert.strictEqual(rfqsDB.getById(rfqId).status, "quoted");
    assert.strictEqual(ordersDB.getAll().length, 0);
  });

  test("accept by PO: order recorded with the PO number, nothing charged, both sides emailed", async () => {
    h.sent.length = 0;
    const stripeCalls = h.stripe.created.length;
    const r = await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", poNumber: "PO-77812", ...SHIP });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.sessionUrl, null);
    assert.strictEqual(h.stripe.created.length, stripeCalls, "Stripe is not touched for a PO");
    const rfq = rfqsDB.getById(rfqId);
    assert.strictEqual(rfq.status, "accepted");
    assert.strictEqual(rfq.acceptedVia, "po");
    assert.strictEqual(rfq.poNumber, "PO-77812");
    assert.ok(rfq.acceptedAt);
    const order = ordersDB.getById(rfq.orderId);
    assert.strictEqual(order.status, "pending_po");
    assert.strictEqual(order.paymentMethod, "po");
    assert.strictEqual(order.poNumber, "PO-77812");
    assert.strictEqual(order.total, 4250);
    assert.strictEqual(order.rfqId, rfqId);
    assert.strictEqual(order.shipBy, shipBy.shipByDate(15));
    assert.strictEqual(order.customerEmail, "pat@oem.test");
    const items = orderItemsDB.query((i) => i.orderId === order.id);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].quantity, 1000);
    assert.strictEqual(items[0].lineTotal, 4250);
    assert.strictEqual(items[0].partId, partId);
    assert.strictEqual(h.sent.length, 2);
    const shop = h.sent.find((m) => m.to === "owner@shop.test");
    const buyer = h.sent.find((m) => m.to === "pat@oem.test");
    // The PO number is typed by the customer: it is in the body, never in a subject line.
    assert.ok(!shop.subject.includes("PO-77812") && /purchase order/.test(shop.subject));
    assert.ok(shop.text.includes("PO number: PO-77812"));
    assert.ok(/Nothing has been charged/.test(shop.text));
    assert.ok(buyer.text.includes("PO-77812"));
    assert.ok(buyer.text.includes(shipBy.formatShipBy(order.shipBy)));
  });

  test("the admin queue shows it accepted, by PO, with the order", async () => {
    const list = await h.get("/api/rfq/admin/list", owner);
    const row = list.body.find((x) => x.id === rfqId);
    assert.strictEqual(row.status, "accepted");
    assert.strictEqual(row.acceptedVia, "po");
    assert.strictEqual(row.poNumber, "PO-77812");
    assert.strictEqual(row.orderStatus, "pending_po");
    assert.strictEqual(row.acceptUrl, null, "no open link once accepted");
    assert.ok(!("drawingPath" in row));
    const queue = await h.get("/api/orders/admin/queue", owner);
    assert.ok(queue.body.some((o) => o.id === row.orderId), "PO order is in the production queue");
  });

  test("a quote can't be accepted twice, and can't be re-quoted after acceptance", async () => {
    const again = await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", poNumber: "PO-2", ...SHIP });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body.code, "already-accepted");
    assert.strictEqual(ordersDB.getAll().length, 1);
    const requote = await h.put(`/api/rfq/admin/${rfqId}`, { status: "quoted", quotedTotal: 1, quotedLeadDays: 1 }, owner);
    assert.strictEqual(requote.status, 409);
    // The link still opens as the buyer's order page.
    const view = await h.get(`/api/rfq/quote/${token}`);
    assert.strictEqual(view.body.status, "accepted");
    assert.strictEqual(view.body.order.status, "pending_po");
  });

  let cardRfq, cardToken;
  test("accept by card: order awaiting payment and a Stripe checkout for the quoted total", async () => {
    cardRfq = await newRfq("casey@oem.test");
    ({ token: cardToken } = await quoted(cardRfq, { quotedTotal: 1999.5, quotedLeadDays: 10 }));
    h.sent.length = 0;
    const before = h.stripe.created.length;
    const r = await h.post(`/api/rfq/quote/${cardToken}/accept`, { method: "card", ...SHIP });
    assert.strictEqual(r.status, 201, r.text);
    assert.ok(r.body.sessionUrl.startsWith("https://checkout.stripe.test/"));
    assert.strictEqual(h.stripe.created.length, before + 1);
    const args = h.stripe.created[before];
    assert.strictEqual(args.line_items[0].price_data.unit_amount, 199950);
    assert.strictEqual(args.customer_email, "casey@oem.test");
    const rfq = rfqsDB.getById(cardRfq);
    // Stripe is given the order id and a short-lived return token, never the quote link (it is a credential).
    assert.ok(args.success_url.startsWith(`https://shop.test/firm-quote/return?o=${rfq.orderId}&r=`) && args.success_url.endsWith("&paid=true"), args.success_url);
    assert.strictEqual(args.cancel_url, `https://shop.test/firm-quote/return?o=${rfq.orderId}&cancelled=true`);
    assert.ok(!JSON.stringify(args).includes(cardToken), "the accept link is not in anything sent to Stripe");
    assert.strictEqual(rfq.status, "accepted");
    assert.strictEqual(rfq.acceptedVia, "card");
    const order = ordersDB.getById(rfq.orderId);
    assert.strictEqual(order.status, "pending_payment");
    assert.strictEqual(order.total, 1999.5);
    assert.strictEqual(args.metadata.orderId, order.id);
    assert.strictEqual(h.sent.length, 1, "shop is told; the buyer's confirmation waits for payment");
    assert.strictEqual(h.sent[0].to, "owner@shop.test");
  });

  test("card checkout abandoned → the same link restarts payment for the same order", async () => {
    const orders = ordersDB.getAll().length;
    const r = await h.post(`/api/rfq/quote/${cardToken}/accept`, { method: "card", ...SHIP });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.sessionUrl);
    assert.strictEqual(ordersDB.getAll().length, orders, "no second order");
    const po = await h.post(`/api/rfq/quote/${cardToken}/accept`, { method: "po", poNumber: "PO-9", ...SHIP });
    assert.strictEqual(po.status, 409);
  });

  test("payment clears → order paid, confirmation to the buyer with a working order link", async () => {
    const order = ordersDB.getById(rfqsDB.getById(cardRfq).orderId);
    h.pay(order.stripeSessionId);
    h.sent.length = 0;
    const r = await h.post(`/api/rfq/quote/${cardToken}/confirm-payment`, {});
    assert.strictEqual(r.status, 200);
    const paid = ordersDB.getById(order.id);
    assert.strictEqual(paid.status, "paid");
    assert.strictEqual(paid.shipBy, shipBy.shipByDate(10));
    const buyer = h.sent.find((m) => m.to === "casey@oem.test");
    assert.ok(buyer && /confirmed/.test(buyer.subject));
    assert.ok(h.sent.some((m) => m.to === "owner@shop.test" && /New order/.test(m.subject)));
    const link = tokenFrom(buyer);
    assert.ok(link, "RFQ buyers have no account, so the email links to the signed page");
    const view = await h.get(`/api/rfq/quote/${link}`);
    assert.strictEqual(view.status, 200);
    assert.strictEqual(view.body.order.status, "paid");
    const list = await h.get("/api/rfq/admin/list", owner);
    assert.strictEqual(list.body.find((x) => x.id === cardRfq).orderStatus, "paid");
  });

  test("if Stripe is down, nothing is recorded and the quote stays open", async () => {
    const id = await newRfq("sam@oem.test");
    const { token: t } = await quoted(id);
    const orders = ordersDB.getAll().length;
    const lines = orderItemsDB.getAll().length;
    h.stripe.failNext = true;
    const r = await h.post(`/api/rfq/quote/${t}/accept`, { method: "card", ...SHIP });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(rfqsDB.getById(id).status, "quoted");
    assert.strictEqual(ordersDB.getAll().length, orders);
    assert.strictEqual(orderItemsDB.getAll().length, lines);
    // and it can still be accepted afterwards
    assert.strictEqual((await h.post(`/api/rfq/quote/${t}/accept`, { method: "card", ...SHIP })).status, 201);
  });

  test("a revised quote sends a new link and retires the old one", async () => {
    const id = await newRfq("rev@oem.test");
    const first = await quoted(id);
    await new Promise((r) => setTimeout(r, 5));
    const second = await quoted(id, { quotedTotal: 3900 });
    assert.strictEqual(h.sent.length, 1);
    assert.ok(second.mail.subject.includes("$3,900.00"));
    assert.notStrictEqual(second.token, first.token);
    const old = await h.get(`/api/rfq/quote/${first.token}`);
    assert.strictEqual(old.status, 410);
    assert.strictEqual(old.body.code, "link-superseded");
    assert.strictEqual((await h.get(`/api/rfq/quote/${second.token}`)).body.quotedTotal, 3900);
    // Saving the same quote again without changes doesn't re-email the customer.
    h.sent.length = 0;
    await h.put(`/api/rfq/admin/${id}`, { status: "quoted", quotedTotal: 3900, quotedLeadDays: 15, quoteNote: "Price covers 1,000 pcs in natural Delrin, bagged 10 per." }, owner);
    assert.strictEqual(h.sent.length, 0);
    await h.put(`/api/rfq/admin/${id}`, { status: "quoted", resend: true }, owner);
    assert.strictEqual(h.sent.length, 1, "explicit resend does");
  });

  test("past its validity date the link stops working and the admin sees it expired", async () => {
    const id = await newRfq("late@oem.test");
    await quoted(id);
    // Turn the clock forward by moving the quote's dates 31 days back.
    const past = new Date(Date.now() - 864e5).toISOString();
    const rfq = rfqsDB.update(id, { validUntil: past });
    const expiredToken = rfqToken.sign(rfq);
    assert.strictEqual(rfqToken.verify(expiredToken).expired, true);
    const view = await h.get(`/api/rfq/quote/${expiredToken}`);
    assert.strictEqual(view.status, 410);
    assert.strictEqual(view.body.code, "quote-expired");
    const accept = await h.post(`/api/rfq/quote/${expiredToken}/accept`, { method: "po", poNumber: "PO-LATE", ...SHIP });
    assert.strictEqual(accept.status, 410);
    assert.strictEqual(rfqsDB.getById(id).status, "expired");
    assert.strictEqual(rfqsDB.getById(id).orderId, null);
    const list = await h.get("/api/rfq/admin/list", owner);
    assert.strictEqual(list.body.find((x) => x.id === id).status, "expired");
    // The shop can refresh it: quoting again reopens it with a new 30 days.
    const again = await quoted(id, { resend: true });
    assert.strictEqual(rfqsDB.getById(id).status, "quoted");
    assert.strictEqual((await h.get(`/api/rfq/quote/${again.token}`)).status, 200);
  });

  test("an RFQ with no online quote attached still becomes a one-line order", async () => {
    const r = await h.form("/api/rfq", { contactName: "No Cad", email: "nocad@plant.test", notes: "Broken UHMW guide, photo attached", ...SHIP });
    const { token: t } = await quoted(r.body.rfqId, { partQuantities: undefined, quotedTotal: 300, quotedLeadDays: 5 });
    const a = await h.post(`/api/rfq/quote/${t}/accept`, { method: "po", poNumber: "VERBAL-1", ...SHIP });
    assert.strictEqual(a.status, 201, a.text);
    const order = ordersDB.getById(rfqsDB.getById(r.body.rfqId).orderId);
    const items = orderItemsDB.query((i) => i.orderId === order.id);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].lineTotal, 300);
  });

  test("a phone photo (HEIC) is accepted; an attachment we don't take is refused in words, not a 500", async () => {
    // The start of a real iPhone photo: an ISO media "ftyp" box with the "heic" brand (the contents are checked, not just the name).
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(48)]);
    const ok = await h.form("/api/rfq", { contactName: "Sam Maint", email: "sam@plant.test" }, { drawing: { name: "IMG_0042.HEIC", data: heic } });
    assert.strictEqual(ok.status, 201, ok.text);
    // A file that only has the name of a photo is refused, in words, and not kept.
    const fake = await h.form("/api/rfq", { contactName: "Sam Maint", email: "sam@plant.test", notes: "not a photo" }, { drawing: { name: "IMG_0043.HEIC", data: Buffer.from("fake heic bytes") } });
    assert.deepStrictEqual([fake.status, fake.body.code], [400, "content-mismatch"]);
    const bad = await h.form("/api/rfq", { contactName: "Sam Maint", email: "sam@plant.test" }, { drawing: { name: "setup.exe", data: Buffer.from("MZ") } });
    assert.strictEqual(bad.status, 400);
    assert.ok(/isn't accepted/.test(bad.body.error));
  });

  test("a send-the-part request answers with a reference and the ship-to address, and emails both to the buyer", async () => {
    const shipFrom = require("../config/shipFrom.json");
    h.sent.length = 0;
    const r = await h.form("/api/rfq", { requestType: "part", contactName: "Sam Maint", email: "sam@plant.test", quantities: "2 now", notes: "NO DRAWING. The customer is sending the part.\nWhat it is and does: UHMW carton guide, worn on the leading edge" });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.reference, String(r.body.rfqId).slice(0, 8).toUpperCase(), "the reference is the short request id");
    assert.deepStrictEqual(r.body.shipTo.lines, [shipFrom.address, `${shipFrom.city}, ${shipFrom.state} ${shipFrom.zip}`]);
    assert.ok(r.body.shipTo.name, "addressed to the business");
    const buyer = h.sent.find((m) => m.to === "sam@plant.test");
    assert.ok(buyer, "buyer email sent");
    for (const body of [buyer.text, buyer.html]) {
      assert.ok(body.includes(r.body.reference), "reference in the email");
      assert.ok(body.includes(shipFrom.address) && body.includes(shipFrom.zip), "ship-to address in the email");
    }
    assert.ok(!/photo/i.test(buyer.text), "the buyer is asked for the part, not a photo");
    const shop = h.sent.find((m) => m.to === "owner@shop.test");
    assert.ok(shop && shop.text.includes(r.body.reference) && /ship the part/i.test(shop.text), "the shop is told a part is on its way");
    assert.ok(rfqsDB.getById(r.body.rfqId).notes.startsWith("NO DRAWING."), "the request details stay in the notes");
  });

  test("an ordinary firm-quote request never carries the ship-to address", async () => {
    const shipFrom = require("../config/shipFrom.json");
    h.sent.length = 0;
    const plain = await h.form("/api/rfq", { contactName: "Pat Purchasing", email: "pat@oem.test", quantities: "250 / 500" });
    assert.strictEqual(plain.status, 201, plain.text);
    assert.strictEqual(plain.body.shipTo, undefined);
    assert.strictEqual(plain.body.reference, undefined);
    assert.ok(h.sent.every((m) => !m.text.includes(shipFrom.address) && !m.html.includes(shipFrom.address)), "no street address in the emails");
    // From the quote tool the request is about the uploaded parts, whatever the form says.
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 500)], leadTimeSlug: "standard" });
    const gated = await h.form("/api/rfq", { requestType: "part", quoteId: q.body.quoteId, contactName: "Pat Purchasing", email: "pat@oem.test" });
    assert.strictEqual(gated.status, 201, gated.text);
    assert.strictEqual(gated.body.shipTo, undefined);
  });

  // ─── Owner decisions, 2026-11-11: paperwork on request; the original part goes back ───
  const { pdfText } = require("../testSupport/pdfText");
  const documents = require("../services/documents");
  const flat = (t) => t.replace(/\s+/g, " ");

  test("firm-quote form: the paperwork box is stored, the shop is told to price it in, and the admin queue shows it", async () => {
    h.sent.length = 0;
    const r = await h.form("/api/rfq", { contactName: "Pat Purchasing", email: "pat@oem.test", quantities: "250 / 500", paperwork: "true" });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.paperwork, true);
    const rfq = rfqsDB.getById(r.body.rfqId);
    assert.strictEqual(rfq.paperwork, true, "a real column, not a line in the notes");
    assert.strictEqual(rfq.returnPart, false);
    const shop = h.sent.find((m) => m.to === "owner@shop.test");
    assert.ok(shop.text.includes("Customer asked for a first-article inspection report and a certificate of conformance — include them in the price."));
    assert.ok(shop.text.includes("FAI + CoC: YES — price it in"));
    const buyer = h.sent.find((m) => m.to === "pat@oem.test");
    assert.ok(/You asked for a first-article inspection report and a certificate of conformance/.test(buyer.text));
    const row = (await h.get("/api/rfq/admin/list", owner)).body.find((x) => x.id === r.body.rfqId);
    assert.strictEqual(row.paperwork, true);
  });

  test("a request without the box: nothing is assumed, and the shop email says it was not requested", async () => {
    h.sent.length = 0;
    const r = await h.form("/api/rfq", { contactName: "Pat Purchasing", email: "pat@oem.test", quantities: "250", paperwork: "false" });
    assert.strictEqual(rfqsDB.getById(r.body.rfqId).paperwork, false);
    const shop = h.sent.find((m) => m.to === "owner@shop.test");
    assert.ok(shop.text.includes("FAI + CoC: Not requested"));
    assert.ok(!/include them in the price/.test(shop.text));
    const none = await h.form("/api/rfq", { contactName: "Pat Purchasing", email: "pat@oem.test" });
    assert.strictEqual(rfqsDB.getById(none.body.rfqId).paperwork, false, "a post that does not mention it is a no");
  });

  test("the firm quote says whether the price includes the paperwork: email, quote page and PDF agree", async () => {
    const yes = await h.form("/api/rfq", { contactName: "Pat Purchasing", email: "pat@oem.test", quantities: "250", paperwork: "true", ...SHIP });
    const q = await quoted(yes.body.rfqId, { partQuantities: undefined, quotedTotal: 900, quotedLeadDays: 10 });
    const included = "This price includes a first-article inspection report and a signed certificate of conformance, shipped with the parts.";
    assert.ok(q.mail.text.includes(included) && q.mail.html.includes("first-article inspection report and a signed certificate of conformance"));
    assert.ok(q.mail.text.includes("Inspection paperwork: First-article report and certificate of conformance: included"));
    const page = await h.get(`/api/rfq/quote/${q.token}`);
    assert.strictEqual(page.body.paperwork, true);
    assert.deepStrictEqual(page.body.covers, [included]);
    const pdf = flat(pdfText(await documents.buildQuotePdf({ rfq: rfqsDB.getById(yes.body.rfqId) })));
    assert.ok(pdf.includes(included), "RFQ response PDF states it");

    const no = await h.form("/api/rfq", { contactName: "Pat Purchasing", email: "pat@oem.test", quantities: "250" });
    const q2 = await quoted(no.body.rfqId, { partQuantities: undefined, quotedTotal: 800, quotedLeadDays: 10 });
    assert.ok(/were not requested, so this price does not include them/.test(q2.mail.text));
    assert.ok(q2.mail.text.includes("Inspection paperwork: Not requested, not included"));
    const page2 = await h.get(`/api/rfq/quote/${q2.token}`);
    assert.strictEqual(page2.body.paperwork, false);
    assert.strictEqual(page2.body.covers.length, 1);
    const pdf2 = flat(pdfText(await documents.buildQuotePdf({ rfq: rfqsDB.getById(no.body.rfqId) })));
    assert.ok(/were not requested, so this price does not include them/.test(pdf2));
    assert.ok(!/return/i.test(q2.mail.text.split("Review and accept")[0]), "nothing about returning a part on an ordinary request");

    // Accepted: the order is flagged for the shop, with no separate amount (it is inside the quoted price).
    h.sent.length = 0;
    const a = await h.post(`/api/rfq/quote/${q.token}/accept`, { method: "po", poNumber: "PO-FAI-1", ...SHIP });
    assert.strictEqual(a.status, 201, a.text);
    const order = ordersDB.getById(rfqsDB.getById(yes.body.rfqId).orderId);
    assert.strictEqual(order.paperwork, true);
    assert.strictEqual(order.paperworkFee, 0);
    assert.strictEqual(order.total, 900);
    assert.strictEqual(order.subtotal, 900, "the quoted total is the whole order: nothing is added on top");
    const toShop = h.sent.find((m) => m.to === "owner@shop.test");
    assert.ok(/FAI \+ CoC ORDERED/.test(toShop.text));
    const toBuyer = h.sent.find((m) => m.to === "pat@oem.test");
    assert.ok(toBuyer.text.includes("First-article inspection report and certificate of conformance (included in the quoted price)"));
    const items = orderItemsDB.query((i) => i.orderId === order.id);
    const oc = flat(pdfText(await documents.buildOrderConfirmationPdf({ order, items })));
    assert.ok(/Inspection paperwork Included/.test(oc) && /ordered, included in the quoted price/.test(oc));
    assert.ok(/First-article inspection report \(ordered\)/.test(pdfText(await documents.buildPackingSlipPdf({ order, items }))));
    assert.strictEqual((await h.get(`/api/orders/${order.id}`, owner)).body.paperwork, true, "the admin drawer gets the flag");
  });

  test("from the quote tool: a box ticked on the online quote carries into the request unless the form says otherwise", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 500)], leadTimeSlug: "standard", paperwork: true });
    assert.strictEqual(q.body.paperwork, true);
    const carried = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: "Pat Purchasing", email: "pat@oem.test" });
    assert.strictEqual(rfqsDB.getById(carried.body.rfqId).paperwork, true);
    assert.ok(Math.abs(rfqsDB.getById(carried.body.rfqId).budgetTotal - q.body.orderTotal) < 0.005, "the budgetary total the owner sees includes the fee the buyer saw");
    const q2 = await h.post("/api/quote", { parts: [h.cncConfig(partId, 500)], leadTimeSlug: "standard", paperwork: true });
    const unticked = await h.form("/api/rfq", { quoteId: q2.body.quoteId, contactName: "Pat Purchasing", email: "pat@oem.test", paperwork: "false" });
    assert.strictEqual(rfqsDB.getById(unticked.body.rfqId).paperwork, false, "the form's own answer wins");
  });

  test("send-the-part request with the return box ticked: stored, and the shop is reminded to price the return shipping in", async () => {
    h.sent.length = 0;
    const r = await h.form("/api/rfq", { requestType: "part", returnPart: "true", contactName: "Sam Maint", email: "sam@plant.test", quantities: "2 now", notes: "NO DRAWING. The customer is sending the part.\nWhat it is and does: UHMW carton guide", ...SHIP });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.returnPart, true);
    const rfq = rfqsDB.getById(r.body.rfqId);
    assert.strictEqual(rfq.requestType, "part");
    assert.strictEqual(rfq.returnPart, true);
    const shop = h.sent.find((m) => m.to === "owner@shop.test");
    for (const body of [shop.text, shop.html]) assert.ok(body.includes("Customer wants the original back — include return shipping in the price."), "the reminder, in both bodies");
    assert.ok(shop.text.includes("Original part back: YES — price in the return shipping"));
    const buyer = h.sent.find((m) => m.to === "sam@plant.test");
    assert.ok(/Shipping the part to us is at your cost/.test(buyer.text));
    assert.ok(/we send it back with the finished parts, and the price we quote includes that return shipping/.test(buyer.text));
    assert.ok(!/within \d|business day/i.test(buyer.text.split("--")[0]), "no promise about how soon the price follows (part-quote-time is unconfirmed)");
    assert.ok(!/drop/i.test(buyer.text), "nothing about drop-off");
    const row = (await h.get("/api/rfq/admin/list", owner)).body.find((x) => x.id === r.body.rfqId);
    assert.strictEqual(row.returnPart, true);
    assert.strictEqual(row.requestType, "part");

    // Quoted → the customer is told the price includes the return; then accepted → the order says to send it back.
    const q = await quoted(r.body.rfqId, { partQuantities: undefined, quotedTotal: 412, quotedLeadDays: 8, quoteNote: "2 pcs in natural UHMW." });
    const returns = "This price includes shipping your original part back to you with the finished parts.";
    assert.ok(q.mail.text.includes(returns) && q.mail.html.includes("shipping your original part back"));
    assert.ok(q.mail.text.includes("Original part: Returned with your order: return shipping included"));
    const page = await h.get(`/api/rfq/quote/${q.token}`);
    assert.strictEqual(page.body.returnPart, true);
    assert.ok(page.body.covers.includes(returns));
    assert.ok(flat(pdfText(await documents.buildQuotePdf({ rfq: rfqsDB.getById(r.body.rfqId) }))).includes(returns), "the PDF says so too");
    h.sent.length = 0;
    const a = await h.post(`/api/rfq/quote/${q.token}/accept`, { method: "po", poNumber: "PO-PART-1", ...SHIP });
    assert.strictEqual(a.status, 201, a.text);
    const order = ordersDB.getById(rfqsDB.getById(r.body.rfqId).orderId);
    assert.strictEqual(order.returnPart, true);
    assert.strictEqual(order.total, 412, "no separate return-shipping charge: it is in the quoted price");
    assert.ok(/RETURN THE ORIGINAL/.test(h.sent.find((m) => m.to === "owner@shop.test").text));
    assert.ok(/Your original part comes back in the box/.test(h.sent.find((m) => m.to === "sam@plant.test").text));
    const items = orderItemsDB.query((i) => i.orderId === order.id);
    assert.ok(/Customer's original part, returned/.test(pdfText(await documents.buildPackingSlipPdf({ order, items }))), "the packer is told to put it in the box");
  });

  test("send-the-part request with the box unticked: no reminder, and the quote says the part is not coming back", async () => {
    h.sent.length = 0;
    const r = await h.form("/api/rfq", { requestType: "part", returnPart: "false", contactName: "Sam Maint", email: "sam@plant.test", notes: "NO DRAWING. Keep the old one." });
    assert.strictEqual(r.body.returnPart, false);
    assert.strictEqual(rfqsDB.getById(r.body.rfqId).returnPart, false);
    const shop = h.sent.find((m) => m.to === "owner@shop.test");
    assert.ok(!shop.text.includes("Customer wants the original back"));
    assert.ok(shop.text.includes("Original part back: No"));
    assert.ok(/You did not ask for the original back/.test(h.sent.find((m) => m.to === "sam@plant.test").text));
    const q = await quoted(r.body.rfqId, { partQuantities: undefined, quotedTotal: 380, quotedLeadDays: 8 });
    assert.ok(/does not include returning it/.test(q.mail.text));
    // The owner can change what the price covers before sending (the customer phoned to add both):
    // the re-sent quote states the new facts, and the old link is retired.
    const q3 = await quoted(r.body.rfqId, { partQuantities: undefined, quotedTotal: 460, quotedLeadDays: 8, paperwork: true, returnPart: true });
    assert.strictEqual(q3.res.quoteSent, true);
    assert.strictEqual(rfqsDB.getById(r.body.rfqId).paperwork, true);
    assert.strictEqual(rfqsDB.getById(r.body.rfqId).returnPart, true);
    assert.ok(/This price includes a first-article inspection report/.test(q3.mail.text) && /includes shipping your original part back/.test(q3.mail.text));
    assert.strictEqual((await h.get(`/api/rfq/quote/${q.token}`)).status, 410, "the earlier link is superseded");
    // A change to what the price covers alone is a revision: it re-sends.
    const q4 = await quoted(r.body.rfqId, { partQuantities: undefined, quotedTotal: 460, quotedLeadDays: 8, paperwork: false });
    assert.strictEqual(q4.res.quoteSent, true);
    assert.ok(/does not include them/.test(q4.mail.text));
    assert.strictEqual((await h.put(`/api/rfq/admin/${r.body.rfqId}`, { paperwork: true }, undefined)).status, 401, "only the owner can change it");
    // The box means something only on a part request.
    const drawing = await h.form("/api/rfq", { returnPart: "true", contactName: "Pat Purchasing", email: "pat@oem.test" });
    assert.strictEqual(rfqsDB.getById(drawing.body.rfqId).returnPart, false);
    assert.strictEqual(drawing.body.returnPart, undefined);
  });

  await run(h.stop);
})();
