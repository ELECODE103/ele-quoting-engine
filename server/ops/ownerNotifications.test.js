/**
 * Audit: the owner hears about every event that needs him — one email each,
 * to the shop's notification address, with nothing a visitor typed in the
 * subject.
 *
 *   a paid card order            (Stripe webhook)
 *   a purchase-order order       (firm quote accepted on a PO)
 *   a firm-quote request
 *   a send-us-the-part request
 *
 * The emails themselves are the existing ones (emails/templates.js, sent from
 * routes/rfq.js and services/orderEvents.js); this suite pins that each event
 * produces exactly one of them, whatever was typed into the forms.
 * Run: node server/ops/ownerNotifications.test.js
 */
const assert = require("assert");
const harness = require("../testSupport/harness");

const { test, run } = harness.runner("Owner notifications");

const SHOP = "owner@shop.test";
// Free text a visitor controls, each piece recognisable if it leaks into a subject.
// (merge 2026-11-12) Two of these used to carry a line break and markup: a name with "\r\nBcc: …" and a PO number
// with "<script>". The order-lifecycle fixes now refuse both at the door (single-line fields, review F-10), which
// the first and third cases below assert; what is then sent is the nearest thing the forms still take.
const TYPED = {
  contactName: "Zed Qwertyname Bcc: sneak@elsewhere.test",
  company: "Qwertycorp <b>Industries</b>",
  notes: "Qwertynote: please rush, see attached",
  finishNotes: "Qwertyfinish bead blast",
  poNumber: "PO-QWERTY-991 / Rev.B #7",
  shippingName: "Qwertyship Receiving",
};
const REFUSED = { contactName: "Zed Qwertyname\r\nBcc: sneak@elsewhere.test", poNumber: "PO-QWERTY-991 <script>" };
const SHIP = { shippingName: TYPED.shippingName, shippingAddress: "100 Qwertystreet", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" };

function shopMail(h) {
  return h.sent.filter((m) => (Array.isArray(m.to) ? m.to.includes(SHOP) : m.to === SHOP));
}
function assertCleanSubject(subject, label) {
  assert.ok(typeof subject === "string" && subject.length > 0 && subject.length <= 120, `${label}: a short subject`);
  assert.ok(!/[\r\n]/.test(subject), `${label}: one line`);
  assert.ok(!/qwerty/i.test(subject), `${label}: nothing a visitor typed is in the subject — got "${subject}"`);
  assert.ok(!/@|<|>/.test(subject), `${label}: no address and no markup in the subject — got "${subject}"`);
}

(async () => {
  const h = await harness.start({ mailer: "configured" });
  const owner = await h.admin();
  const buyer = await h.register("buyer@oem.test", "Dana Buyer");
  h.sent.length = 0;

  let firmRfqId;

  test("a firm-quote request: one email to the shop, subject is a reference and a count", async () => {
    const partId = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 500)] }, buyer);
    assert.ok(q.body.quoteId, JSON.stringify(q.body).slice(0, 200));
    h.sent.length = 0;
    // A name with a line break and a header in it is refused outright: nothing is stored and nobody is emailed.
    const hostile = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: REFUSED.contactName, email: "buyer@oem.test", company: TYPED.company, notes: TYPED.notes }, {}, buyer);
    assert.deepStrictEqual([hostile.status, hostile.body.code, hostile.body.field, h.sent.length], [400, "field-single-line", "contactName", 0], hostile.text);
    const r = await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: TYPED.contactName, email: "buyer@oem.test", company: TYPED.company, quantities: "500 / 1000", notes: TYPED.notes, finishNotes: TYPED.finishNotes }, {}, buyer);
    assert.strictEqual(r.status, 201, r.text);
    firmRfqId = r.body.rfqId;
    const mail = shopMail(h);
    assert.strictEqual(mail.length, 1, `exactly one shop email, got ${mail.length}`);
    assert.ok(/^RFQ: [0-9A-F]{8} — /.test(mail[0].subject), mail[0].subject);
    assertCleanSubject(mail[0].subject, "firm-quote request");
    assert.ok(/Qwertycorp/.test(mail[0].text), "the typed details are in the body, where they belong");
    assert.strictEqual(mail[0].template, "rfqReceivedShop");
  });

  test("a send-us-the-part request: one email to the shop, subject is a reference", async () => {
    h.sent.length = 0;
    const r = await h.form("/api/rfq", { requestType: "part", contactName: TYPED.contactName, email: "maint@plant.test", company: TYPED.company, notes: TYPED.notes, returnPart: "true" });
    assert.strictEqual(r.status, 201, r.text);
    const mail = shopMail(h);
    assert.strictEqual(mail.length, 1, `exactly one shop email, got ${mail.length}`);
    assert.ok(/^RFQ: [0-9A-F]{8} — /.test(mail[0].subject), mail[0].subject);
    assertCleanSubject(mail[0].subject, "part request");
    assert.strictEqual(mail[0].template, "rfqReceivedShop");
  });

  test("a purchase-order order (firm quote accepted on a PO): one email to the shop, the PO number stays out of the subject", async () => {
    h.sent.length = 0;
    const quoted = await h.put(`/api/rfq/admin/${firmRfqId}`, { status: "quoted", quotedTotal: 4250, quotedLeadDays: 15, quoteNote: "Covers 1,000 pcs." }, owner);
    assert.strictEqual(quoted.status, 200, quoted.text);
    const link = h.sent.find((m) => m.to === "buyer@oem.test" && /firm quote/i.test(m.subject));
    assert.ok(link, "the buyer was sent the firm quote");
    const token = (link.text.match(/\/firm-quote\/(\S+)/) || [])[1];
    assert.strictEqual(shopMail(h).length, 0, "sending a quote is the owner's own action: no notice to himself");
    h.sent.length = 0;
    // A PO number with markup in it is refused; the quote stays open and nobody is emailed.
    const hostile = await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", poNumber: REFUSED.poNumber, ...SHIP });
    assert.deepStrictEqual([hostile.status, hostile.body.code, h.sent.length], [400, "po-number-invalid", 0], hostile.text);
    const r = await h.post(`/api/rfq/quote/${token}/accept`, { method: "po", poNumber: TYPED.poNumber, ...SHIP });
    assert.strictEqual(r.status, 201, r.text);
    const mail = shopMail(h);
    assert.strictEqual(mail.length, 1, `exactly one shop email, got ${mail.length}: ${mail.map((m) => m.subject).join(" | ")}`);
    assert.ok(/purchase order/i.test(mail[0].subject), mail[0].subject);
    assert.ok(/\$4,250\.00/.test(mail[0].subject), "the amount, which the owner set himself");
    assertCleanSubject(mail[0].subject, "PO order");
    assert.ok(mail[0].text.includes("PO-QWERTY-991"), "the PO number is in the body");
    assert.strictEqual(mail[0].template, "rfqAcceptedShop");
  });

  test("a paid card order: one email to the shop when Stripe's webhook arrives, and not a second one when the buyer returns", async () => {
    const partId = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 2)], notes: TYPED.notes }, buyer);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP, customerNotes: TYPED.notes }, buyer);
    assert.strictEqual(c.status, 200, c.text);
    const sessionId = `cs_test_${h.stripe.created.length}`;
    h.sent.length = 0;
    assert.strictEqual(shopMail(h).length, 0, "an unpaid checkout is not an order yet: no email");
    h.pay(sessionId);
    const res = await fetch(`${h.base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "checkout.session.completed", data: { object: h.stripe.sessions[sessionId] } }) });
    assert.strictEqual(res.status, 200);
    let mail = shopMail(h);
    assert.strictEqual(mail.length, 1, `exactly one shop email, got ${mail.length}`);
    assert.ok(/^New order [0-9A-F]{8} — \$[\d,]+\.\d\d$/.test(mail[0].subject), mail[0].subject);
    assertCleanSubject(mail[0].subject, "paid order");
    assert.strictEqual(mail[0].template, "newOrderShop");
    // Stripe retries, and the buyer lands back on the order page: neither sends it again.
    await fetch(`${h.base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "checkout.session.completed", data: { object: h.stripe.sessions[sessionId] } }) });
    const order = h.models.ordersDB.getAll().find((o) => o.stripeSessionId === sessionId);
    await h.post(`/api/orders/${order.id}/confirm-payment`, {}, buyer);
    mail = shopMail(h);
    assert.strictEqual(mail.length, 1, "still one");
  });

  test("every shop notification: plain recipient list, a template name for the log, no typed text in any subject", async () => {
    // Everything sent to the shop during this suite, whatever the event.
    const partId = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 300)] }, buyer);
    h.sent.length = 0;
    await h.form("/api/rfq", { quoteId: q.body.quoteId, contactName: TYPED.contactName, email: "buyer@oem.test", company: TYPED.company, notes: TYPED.notes }, {}, buyer);
    for (const m of shopMail(h)) {
      assertCleanSubject(m.subject, m.template);
      assert.ok(typeof m.template === "string" && /^[A-Za-z]+$/.test(m.template));
    }
  });

  await run(() => h.stop());
})().catch((err) => { console.error(err); process.exit(1); });
