/**
 * Checkout funnel, end to end against the real routes (Stripe stubbed at the
 * boundary, emails captured). Run: `node server/routes/checkoutFunnel.test.js`
 *
 * Covers: one quote row per session with a 30-day hold, ship-by dates instead
 * of multipliers, a guest's quote and parts surviving register/sign-in, the
 * order emails, the order page data, reorder, and notes + drawing on the
 * instant path.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Checkout funnel");
const QUOTE_ID = "3f0c7c1e-58a4-4d0b-9b57-5f0a4e7b9a11";
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

(async () => {
  const h = await start();
  const { quotesDB, ordersDB, orderItemsDB, leadTimesDB } = h.models;
  const shipBy = require("../services/shipBy");
  let partId, buyer, orderId;

  // ─── Gap 6: one quote row per session ──────────────────────
  test("a guest uploads and prices without an account", async () => {
    partId = await h.uploadCube();
    const r = await h.post("/api/quote", { quoteId: QUOTE_ID, parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard", process: "cnc" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.quoteId, QUOTE_ID, "the session's quote id is kept");
    assert.ok(r.body.orderTotal > 0);
    // Inspection paperwork is opt-in: an ordinary quote carries none, and says what it would cost.
    assert.strictEqual(r.body.paperwork, false);
    assert.strictEqual(r.body.paperworkFee, 0);
    assert.ok(r.body.paperworkOffer.fee > 0);
    assert.ok(Math.abs(r.body.subtotal + r.body.leadTimeSurcharge + r.body.paperworkFee + r.body.shippingEstimate - r.body.orderTotal) < 0.005, "subtotal + lead-time fee + paperwork + shipping = total");
  });

  test("re-pricing updates the same row instead of inserting drafts", async () => {
    for (const qty of [3, 4, 5, 6, 7]) {
      const r = await h.post("/api/quote", { quoteId: QUOTE_ID, parts: [h.cncConfig(partId, qty)], leadTimeSlug: "expedited", process: "cnc" });
      assert.strictEqual(r.body.quoteId, QUOTE_ID);
    }
    assert.strictEqual(quotesDB.getAll().length, 1, "six price refreshes, one quote row");
    const q = quotesDB.getById(QUOTE_ID);
    assert.strictEqual(q.lineItems[0].quantity, 7);
    assert.strictEqual(q.leadTimeSlug, "expedited");
    assert.strictEqual(q.config.parts[0].quantity, 7);
  });

  test("the price is held 30 days and the date is returned to the customer", async () => {
    const r = await h.post("/api/quote", { quoteId: QUOTE_ID, parts: [h.cncConfig(partId, 7)], leadTimeSlug: "expedited", process: "cnc" });
    const days = (new Date(r.body.expiresAt) - Date.now()) / 864e5;
    assert.ok(days > 29.9 && days <= 30, `expires in ${days} days`);
    const g = await h.get(`/api/quote/${QUOTE_ID}`);
    assert.strictEqual(g.body.expiresAt, r.body.expiresAt);
    assert.strictEqual(g.body.expired, false);
  });

  test("a quote id that isn't a UUID is ignored, not trusted", async () => {
    const r = await h.post("/api/quote", { quoteId: "../../etc", parts: [h.cncConfig(partId, 1)], leadTimeSlug: "standard" });
    assert.strictEqual(r.status, 200);
    assert.notStrictEqual(r.body.quoteId, "../../etc");
    quotesDB.delete(r.body.quoteId);
  });

  // ─── Gap 4: ship-by dates ──────────────────────────────────
  test("the quote carries a ship-by date and dated lead-time options, no multipliers", async () => {
    const r = await h.post("/api/quote", { quoteId: QUOTE_ID, parts: [h.cncConfig(partId, 7)], leadTimeSlug: "expedited", process: "cnc" });
    const expedited = leadTimesDB.getAll().find((lt) => lt.slug === "expedited");
    assert.strictEqual(r.body.shipBy, shipBy.shipByDate(expedited));
    assert.ok(shipBy.isBusinessDay(r.body.shipBy));
    assert.ok(r.body.leadTimeOptions.length >= 2);
    for (const o of r.body.leadTimeOptions) {
      assert.ok(isDate(o.shipBy), `${o.slug} has a date`);
      assert.ok(shipBy.isBusinessDay(o.shipBy));
      assert.ok(!("multiplier" in o), "multiplier is not sent to the customer in the option list");
      assert.ok(o.surcharge >= 0);
    }
    const opt = r.body.leadTimeOptions.find((o) => o.slug === "expedited");
    assert.ok(Math.abs(opt.surcharge - r.body.leadTimeSurcharge) < 0.005, "option surcharge matches the engine's");
  });

  test("lead-time list is dated and still admin-editable (days text drives the date)", async () => {
    const owner = await h.admin("Owner");
    const list = await h.get("/api/admin/lead-times", owner);
    const std = list.body.find((lt) => lt.slug === "standard");
    const before = (await h.get("/api/lead-times")).body.find((lt) => lt.slug === "standard").shipBy;
    const put = await h.put(`/api/admin/lead-times/${std.id}`, { days: "12 business days", multiplier: 1.1 }, owner);
    assert.strictEqual(put.status, 200);
    const after = (await h.get("/api/lead-times")).body.find((lt) => lt.slug === "standard");
    assert.strictEqual(after.multiplier, 1.1);
    assert.strictEqual(after.shipBy, shipBy.shipByDate(12));
    assert.notStrictEqual(after.shipBy, before);
    await h.put(`/api/admin/lead-times/${std.id}`, { days: std.days, multiplier: std.multiplier }, owner);
  });

  // ─── Gap 1: the quote survives register / sign-in ──────────
  test("the builder can reopen the guest's quote: parts, mesh and config intact", async () => {
    const r = await h.get(`/api/quote/${QUOTE_ID}/session`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.leadTimeSlug, "expedited");
    assert.strictEqual(r.body.process, "cnc");
    assert.strictEqual(r.body.parts.length, 1);
    const p = r.body.parts[0];
    assert.strictEqual(p.partId, partId);
    assert.strictEqual(p.quantity, 7);
    assert.strictEqual(p.fileName, "cube_20mm.stl");
    assert.strictEqual(r.body.paperwork, false, "the paperwork box comes back as the buyer left it");
    assert.ok(p.meshPreview.positions.length > 0, "preview mesh comes back");
    assert.ok(p.geometry.boundingBox && !p.geometry.meshData);
  });

  test("after registering, the same quote and parts are there and checkout works", async () => {
    buyer = await h.register("dana@buyer.test", "Dana Buyer");
    const s = await h.get(`/api/quote/${QUOTE_ID}/session`, buyer);
    assert.strictEqual(s.body.parts[0].partId, partId);
    assert.strictEqual(s.body.parts[0].quantity, 7);
    const q = await h.get(`/api/quote/${QUOTE_ID}`, buyer);
    const r = await h.post("/api/orders/checkout-session", { quoteId: QUOTE_ID, ...SHIP }, buyer);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.body.sessionUrl.startsWith("https://checkout.stripe.test/"));
    orderId = r.body.orderId;
    const order = ordersDB.getById(orderId);
    assert.strictEqual(order.status, "pending_payment");
    assert.strictEqual(order.customerEmail, "dana@buyer.test");
    assert.ok(Math.abs(order.total - q.body.orderTotal) < 0.005);
    assert.strictEqual(order.leadTimeName, "Expedited");
    assert.ok(isDate(order.shipBy));
    const items = orderItemsDB.query((i) => i.orderId === orderId);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].partId, partId);
    assert.strictEqual(items[0].quantity, 7);
    assert.ok(items[0].materialName, "material name stored, not just the slug");
    // What went to Stripe
    const args = h.stripe.created[0];
    assert.strictEqual(args.line_items[0].price_data.unit_amount, Math.round(order.total * 100));
    assert.strictEqual(args.line_items.length, 1, "no paperwork ordered, so one Stripe line");
    assert.strictEqual(order.paperwork, false);
    assert.strictEqual(order.paperworkFee, 0);
    assert.ok(Math.abs(order.subtotal + order.leadTimeSurcharge + order.paperworkFee + order.shippingCost - order.total) < 0.01, "order lines add up to the total");
    assert.strictEqual(args.success_url, `https://shop.test/orders/${orderId}?paid=true`);
    assert.strictEqual(args.metadata.orderId, orderId);
  });

  test("the anonymous quote is now bound to the buyer and closed to others", async () => {
    const q = quotesDB.getById(QUOTE_ID);
    assert.strictEqual(q.status, "ordered");
    assert.ok(q.userId, "bound to the new account");
    assert.strictEqual((await h.get(`/api/quote/${QUOTE_ID}`)).status, 404, "guests can no longer read it");
    assert.strictEqual((await h.get(`/api/quote/${QUOTE_ID}/session`)).status, 404);
    assert.strictEqual((await h.get(`/api/quote/${QUOTE_ID}`, buyer)).status, 200);
  });

  test("re-pricing an ordered quote forks a new draft; the order's quote is untouched", async () => {
    const before = quotesDB.getById(QUOTE_ID);
    const r = await h.post("/api/quote", { quoteId: QUOTE_ID, parts: [h.cncConfig(partId, 1)], leadTimeSlug: "standard" }, buyer);
    assert.notStrictEqual(r.body.quoteId, QUOTE_ID);
    assert.strictEqual(quotesDB.getById(QUOTE_ID).orderTotal, before.orderTotal);
    // A stranger sending the same id can't overwrite it either.
    // (Since the review of 2026-11-11 the buyer's part is the buyer's: a stranger cannot price it at all,
    // so the stranger brings a part of their own.)
    const theirs = await h.post("/api/quote", { quoteId: QUOTE_ID, parts: [h.cncConfig(partId, 1)], leadTimeSlug: "standard" });
    assert.strictEqual(theirs.status, 400);
    assert.strictEqual(theirs.body.code, "part-not-found", "the buyer's part is not found for anyone else");
    const strangerPart = await h.uploadCube();
    const stranger = await h.post("/api/quote", { quoteId: QUOTE_ID, parts: [h.cncConfig(strangerPart, 1)], leadTimeSlug: "standard" });
    assert.strictEqual(stranger.status, 200, stranger.text);
    assert.notStrictEqual(stranger.body.quoteId, QUOTE_ID);
    assert.strictEqual(quotesDB.getById(QUOTE_ID).lineItems[0].quantity, 7);
  });

  test("an expired quote can't be checked out", async () => {
    const r = await h.post("/api/quote", { parts: [h.cncConfig(partId, 1)], leadTimeSlug: "standard" }, buyer);
    quotesDB.update(r.body.quoteId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const c = await h.post("/api/orders/checkout-session", { quoteId: r.body.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 410);
    assert.strictEqual(c.body.code, "quote-expired");
    assert.strictEqual((await h.get(`/api/quote/${r.body.quoteId}`, buyer)).body.expired, true);
  });

  // ─── Gap 3 + 5: paid → emails, order page data ─────────────
  test("returning from Stripe before payment clears leaves the order pending and sends nothing", async () => {
    h.sent.length = 0;
    const r = await h.post(`/api/orders/${orderId}/confirm-payment`, {}, buyer);
    assert.strictEqual(r.body.status, "pending_payment");
    assert.strictEqual(h.sent.length, 0);
  });

  test("payment → order paid, confirmation to the customer, notification to the shop", async () => {
    h.pay("cs_test_1");
    const r = await h.post(`/api/orders/${orderId}/confirm-payment`, {}, buyer);
    assert.strictEqual(r.body.status, "paid");
    const order = ordersDB.getById(orderId);
    assert.ok(order.paidAt);
    assert.strictEqual(order.shipBy, shipBy.shipByDate(order.leadDays));
    assert.strictEqual(h.sent.length, 2);
    const toCustomer = h.sent.find((m) => m.to === "dana@buyer.test");
    const toShop = h.sent.find((m) => m.to === "owner@shop.test");
    assert.ok(toCustomer && toShop, "one to the buyer, one to ADMIN_EMAIL");
    assert.ok(/confirmed/i.test(toCustomer.subject));
    assert.ok(toCustomer.text.includes("cube_20mm.stl"));
    assert.ok(toCustomer.text.includes(shipBy.formatShipBy(order.shipBy)), "ship-by date in the email");
    assert.ok(toCustomer.text.includes(`https://shop.test/orders/${orderId}`));
    assert.ok(toCustomer.html.includes("STRAIGHTEDGE"));
    assert.ok(/New order/i.test(toShop.subject));
    assert.ok(toShop.text.includes("dana@buyer.test"));
    // Not ordered, so not claimed: no paperwork line to the customer, and the shop is told it was not ordered.
    assert.ok(!/first-article|certificate of conformance/i.test(toCustomer.text));
    assert.ok(toShop.text.includes("FAI + CoC: Not ordered"));
    const priced = toCustomer.text.split("\n").filter((l) => /^\s+- /.test(l)).map((l) => Number((l.match(/\$([\d,]+\.\d{2})$/) || [])[1]?.replace(/,/g, ""))).filter(Number.isFinite);
    assert.ok(Math.abs(priced.reduce((a, b) => a + b, 0) - order.total) < 0.01, "the email's lines add up to the total paid");
  });

  test("the webhook arriving afterwards is a no-op (no duplicate emails)", async () => {
    h.sent.length = 0;
    const event = { type: "checkout.session.completed", data: { object: h.stripe.sessions.cs_test_1 } };
    const res = await fetch(`${h.base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(h.sent.length, 0);
    assert.strictEqual(ordersDB.getById(orderId).status, "paid");
  });

  test("the order page gets line items, quantities, material, ship-by, status — and no internal notes", async () => {
    ordersDB.update(orderId, { notes: "internal: customer is price-sensitive" });
    const r = await h.get(`/api/orders/${orderId}?paid=true`, buyer);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, "paid");
    assert.ok(isDate(r.body.shipBy));
    assert.strictEqual(r.body.leadTimeName, "Expedited");
    assert.strictEqual(r.body.items[0].quantity, 7);
    assert.ok(r.body.items[0].materialName);
    assert.ok(!("notes" in r.body), "internal notes are not sent to the customer");
    assert.ok(!("drawingPath" in r.body));
    assert.strictEqual(r.body.paperwork, false);
    assert.ok(Math.abs(r.body.subtotal + r.body.leadTimeSurcharge + r.body.paperworkFee + r.body.shippingCost - r.body.total) < 0.01, "what the order page shows adds up");
  });

  test("a second order paid by webhook, with a promo code, is still a clean paid order", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard" }, buyer);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    const sid = h.stripe.created.length;
    const session = h.stripe.sessions[`cs_test_${sid}`];
    h.pay(session.id, { amount_total: Math.round(session.amount_subtotal * 0.9) }); // 10% promo
    h.sent.length = 0;
    const res = await fetch(`${h.base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "checkout.session.completed", data: { object: session } }) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "paid");
    assert.strictEqual(h.sent.length, 2);
  });

  test("a charged amount that doesn't match the order goes to the shop for review, not to the customer", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 3)], leadTimeSlug: "standard" }, buyer);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    const session = h.stripe.sessions[`cs_test_${h.stripe.created.length}`];
    h.pay(session.id, { amount_subtotal: 100, amount_total: 100 });
    h.sent.length = 0;
    await fetch(`${h.base}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "checkout.session.completed", data: { object: session } }) });
    assert.strictEqual(ordersDB.getById(c.body.orderId).status, "paid_amount_mismatch");
    assert.strictEqual(h.sent.length, 1);
    assert.strictEqual(h.sent[0].to, "owner@shop.test");
    assert.ok(/Needs review/.test(h.sent[0].text));
  });

  test("shipped with tracking → one email with the tracking link; saving again doesn't resend", async () => {
    const owner = await h.adminLogin();
    h.sent.length = 0;
    const r = await h.put(`/api/orders/${orderId}/status`, { status: "shipped", carrier: "UPS", trackingNumber: "1Z999AA10123456784" }, owner);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.customerEmailed, true);
    assert.strictEqual(h.sent.length, 1);
    const m = h.sent[0];
    assert.strictEqual(m.to, "dana@buyer.test");
    assert.ok(/shipped/i.test(m.subject));
    assert.ok(m.text.includes("1Z999AA10123456784"));
    assert.ok(m.html.includes("https://www.ups.com/track?tracknum=1Z999AA10123456784"));
    await h.put(`/api/orders/${orderId}/status`, { status: "shipped", carrier: "UPS", trackingNumber: "1Z999AA10123456784", notes: "left at dock" }, owner);
    assert.strictEqual(h.sent.length, 1, "no second email");
    const view = await h.get(`/api/orders/${orderId}`, buyer);
    assert.strictEqual(view.body.trackingNumber, "1Z999AA10123456784");
    assert.ok(view.body.trackingUrl.includes("ups.com"));
    assert.ok(view.body.shippedAt);
  });

  test("shipped without tracking, then tracking added → a second email carries it", async () => {
    const owner = await h.adminLogin();
    const other = ordersDB.getAll().find((o) => o.id !== orderId && o.status === "paid");
    h.sent.length = 0;
    await h.put(`/api/orders/${other.id}/status`, { status: "shipped" }, owner);
    assert.strictEqual(h.sent.length, 1);
    assert.ok(!h.sent[0].text.includes("Tracking number"));
    await h.put(`/api/orders/${other.id}/status`, { status: "shipped", carrier: "FedEx", trackingNumber: "771234567890" }, owner);
    assert.strictEqual(h.sent.length, 2);
    assert.ok(h.sent[1].html.includes("fedex.com"));
  });

  test("moving through other statuses sends no email", async () => {
    const owner = await h.adminLogin();
    const pending = ordersDB.getAll().find((o) => o.status === "paid_amount_mismatch");
    h.sent.length = 0;
    await h.put(`/api/orders/${pending.id}/status`, { status: "in_production" }, owner);
    assert.strictEqual(h.sent.length, 0);
  });

  // ─── Gap 5: reorder ────────────────────────────────────────
  test("reorder rebuilds a draft quote with the same parts and configuration", async () => {
    const before = quotesDB.getAll().length;
    const r = await h.post(`/api/orders/${orderId}/reorder`, {}, buyer);
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(quotesDB.getAll().length, before + 1);
    const q = quotesDB.getById(r.body.quoteId);
    assert.strictEqual(q.status, "draft");
    assert.strictEqual(q.leadTimeSlug, "expedited");
    const s = await h.get(`/api/quote/${r.body.quoteId}/session`, buyer);
    assert.strictEqual(s.body.parts.length, 1);
    assert.strictEqual(s.body.parts[0].partId, partId);
    assert.strictEqual(s.body.parts[0].quantity, 7);
    assert.strictEqual(s.body.parts[0].materialSlug, h.cncConfig(partId).materialSlug);
    assert.ok(s.body.parts[0].meshPreview.positions.length > 0);
  });

  test("only the owner can reorder or read an order", async () => {
    const stranger = await h.register("stranger@else.test", "Someone Else");
    assert.strictEqual((await h.post(`/api/orders/${orderId}/reorder`, {}, stranger)).status, 403);
    assert.strictEqual((await h.get(`/api/orders/${orderId}`, stranger)).status, 403);
    assert.strictEqual((await h.post(`/api/orders/${orderId}/confirm-payment`, {}, stranger)).status, 403);
  });

  // ─── Stretch: notes + drawing on the instant path ──────────
  test("notes and a PDF drawing ride from the quote to the order without changing the price", async () => {
    const id = "9b2f6a55-0c1d-4e6f-8a3b-2d7c5e1f4a90";
    const plain = await h.post("/api/quote", { quoteId: id, parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard" }, buyer);
    const noted = await h.post("/api/quote", { quoteId: id, parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard", notes: "The 0.500 bore is the one that matters." }, buyer);
    assert.strictEqual(noted.body.orderTotal, plain.body.orderTotal, "notes don't change the price");
    const bad = await h.form(`/api/quote/${id}/drawing`, {}, { drawing: { name: "print.pdf", data: Buffer.from("not a pdf at all") } }, buyer);
    assert.strictEqual(bad.status, 400);
    const exe = await h.form(`/api/quote/${id}/drawing`, {}, { drawing: { name: "print.exe", data: Buffer.from("%PDF-1.4") } }, buyer);
    assert.strictEqual(exe.status, 400);
    const up = await h.form(`/api/quote/${id}/drawing`, {}, { drawing: { name: "bracket-rev-B.pdf", data: Buffer.from("%PDF-1.4\n%test drawing\n") } }, buyer);
    assert.strictEqual(up.status, 200, up.text);
    assert.strictEqual(up.body.drawingFileName, "bracket-rev-B.pdf");
    const again = await h.post("/api/quote", { quoteId: id, parts: [h.cncConfig(partId, 2)], leadTimeSlug: "standard" }, buyer);
    assert.strictEqual(again.body.orderTotal, plain.body.orderTotal, "a drawing doesn't change the price");
    assert.strictEqual(again.body.drawingFileName, "bracket-rev-B.pdf", "re-pricing keeps the drawing");
    assert.strictEqual(again.body.notes, "The 0.500 bore is the one that matters.");
    assert.ok(!("drawingPath" in (await h.get(`/api/quote/${id}`, buyer)).body), "server path is not exposed");

    const c = await h.post("/api/orders/checkout-session", { quoteId: id, ...SHIP }, buyer);
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.customerNotes, "The 0.500 bore is the one that matters.");
    assert.strictEqual(order.drawingFileName, "bracket-rev-B.pdf");
    const owner = await h.adminLogin();
    const dl = await fetch(`${h.base}/api/orders/${order.id}/drawing`, { headers: { Authorization: `Bearer ${owner}` } });
    assert.strictEqual(dl.status, 200);
    assert.ok((await dl.text()).startsWith("%PDF"));
    const adminView = await h.get(`/api/orders/${order.id}`, owner);
    assert.strictEqual(adminView.body.hasDrawing, true);
    assert.strictEqual(adminView.body.customerNotes, "The 0.500 bore is the one that matters.");

    // Paid → both emails mention the drawing review.
    h.pay(`cs_test_${h.stripe.created.length}`);
    h.sent.length = 0;
    await h.post(`/api/orders/${order.id}/confirm-payment`, {}, buyer);
    const toCustomer = h.sent.find((m) => m.to === "dana@buyer.test");
    assert.ok(toCustomer.text.includes("We review drawings before cutting"));
    assert.ok(toCustomer.text.includes("bracket-rev-B.pdf"));
  });

  // ─── Launch QA: what the catalog hides cannot be bought, and orders add up ──
  test("materials, finishes and lead times the catalog does not list are refused by the API", async () => {
    const { materialsDB } = h.models;
    const sls = materialsDB.getAll().find((m) => m.subProcess === "sls" && m.active);
    assert.ok(sls, "the seed carries an SLS material the owner has not confirmed");
    // (As the buyer: the part is theirs. Each refusal is checked by its code, so a 400 for any other reason cannot pass for it.)
    const hidden = await h.post("/api/quote", { parts: [{ partId, materialSlug: sls.slug, quantity: 1, process: "3d-printing", subProcess: "sls" }] }, buyer);
    assert.strictEqual(hidden.status, 400);
    assert.strictEqual(hidden.body.code, "material-not-offered");
    const off = materialsDB.getAll().find((m) => m.process === "cnc" && !m.active);
    if (off) {
      const inactive = await h.post("/api/quote", { parts: [{ ...h.cncConfig(partId, 1), materialSlug: off.slug, grade: "" }] }, buyer);
      assert.strictEqual(inactive.status, 400, "an inactive material is refused");
      assert.strictEqual(inactive.body.code, "material-not-offered");
    }
    const pla = materialsDB.getAll().find((m) => m.subProcess === "fdm" && m.active);
    const dyed = await h.post("/api/quote", { parts: [{ partId, materialSlug: pla.slug, finishSlug: "3dp-vapor-smooth", quantity: 1, process: "3d-printing", subProcess: "fdm" }] }, buyer);
    assert.strictEqual(dyed.status, 400);
    assert.strictEqual(dyed.body.code, "finish-not-offered");
    for (const slug of ["rush", "same-day"]) {
      const fast = await h.post("/api/quote", { parts: [h.cncConfig(partId, 1)], leadTimeSlug: slug }, buyer);
      assert.strictEqual(fast.status, 400, `${slug} cannot be priced`);
      assert.strictEqual(fast.body.code, "lead-time-not-offered");
    }
  });

  // Until the review of 2026-11-11 a quantity that was not a whole number of pieces was turned into one
  // (2.7 → 2, −4 → 1) and priced. Nothing a request sends is replaced by another value now: it is refused.
  test("quantities are whole pieces: anything else is refused, not rounded", async () => {
    for (const quantity of [2.7, -4, 0, "three"]) {
      const r = await h.post("/api/quote", { parts: [{ ...h.cncConfig(partId, 1), quantity }] }, buyer);
      assert.strictEqual(r.status, 400, `${quantity}: ${r.text}`);
      if (typeof quantity === "number") assert.strictEqual(r.body.code, "quantity-invalid");
      assert.strictEqual(r.body.lineItems, undefined);
    }
    const ok = await h.post("/api/quote", { parts: [{ ...h.cncConfig(partId, 1), quantity: 3 }] }, buyer);
    assert.strictEqual(ok.body.lineItems[0].quantity, 3);
  });

  test("a stored quote on a lead time that is no longer offered cannot be checked out", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 1)], leadTimeSlug: "standard" }, buyer);
    quotesDB.update(q.body.quoteId, { leadTimeSlug: "same-day" }); // as an older database would hold it
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 409);
    assert.strictEqual(c.body.code, "lead-time-unavailable");
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 0);
  });

  test("a quote saved before the 30-day hold existed expires 30 days after it was last priced", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 1)], leadTimeSlug: "standard" }, buyer);
    const { getDatabase } = require("../models/database");
    getDatabase().run("UPDATE quotes SET expires_at = NULL, updated_at = ?, created_at = ? WHERE id = ?", [new Date(Date.now() - 40 * 864e5).toISOString(), new Date(Date.now() - 40 * 864e5).toISOString(), q.body.quoteId]);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 410);
  });

  test("coming back from a cancelled Stripe page pays for the same order, not a second one", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 4)], leadTimeSlug: "standard" }, buyer);
    const first = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    const second = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP, shippingAddress: "200 Dock Rd" }, buyer);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.orderId, first.body.orderId);
    // Review 2026-11-11 (F8): the order's Stripe session is still open for the same amount, so the buyer
    // is sent back to it; a new one is not minted for every return. (This used to assert "a fresh Stripe session".)
    assert.strictEqual(second.body.sessionUrl, first.body.sessionUrl, "the same Stripe session, while it is open and the amount is unchanged");
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 1);
    assert.strictEqual(ordersDB.getById(first.body.orderId).shippingAddress, "200 Dock Rd", "the corrected address is kept");
  });

  test("when Stripe is down no unpayable order is left behind", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 6)], leadTimeSlug: "standard" }, buyer);
    h.stripe.failNext = true;
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    assert.strictEqual(c.status, 500);
    assert.strictEqual(ordersDB.query((o) => o.quoteId === q.body.quoteId).length, 0);
    assert.strictEqual(quotesDB.getById(q.body.quoteId).status, "draft", "the quote can still be bought");
  });

  test("the order shows what the total is made of: parts, lead-time fee, shipping", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 5)], leadTimeSlug: "expedited" }, buyer);
    assert.ok(q.body.leadTimeSurcharge > 0 && q.body.shippingEstimate > 0);
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    const order = ordersDB.getById(c.body.orderId);
    assert.ok(Math.abs(order.subtotal - q.body.subtotal) < 0.005, "subtotal is the parts");
    assert.ok(Math.abs(order.subtotal + order.leadTimeSurcharge + order.shippingCost - order.total) < 0.01, "the lines add up to the total");
    assert.strictEqual(order.paperworkFee, 0, "and none of it is paperwork nobody asked for");
    const lines = orderItemsDB.query((i) => i.orderId === order.id).reduce((s, i) => s + i.lineTotal, 0);
    assert.ok(Math.abs(lines - order.subtotal) < 0.01, "line items add up to the subtotal");
    h.pay(`cs_test_${h.stripe.created.length}`);
    h.sent.length = 0;
    await h.post(`/api/orders/${order.id}/confirm-payment`, {}, buyer);
    const mail = h.sent.find((m) => m.to === "dana@buyer.test");
    assert.ok(/Expedited lead time/.test(mail.text) && /Shipping/.test(mail.text), "the email lists the fee and shipping");
    const pdf = await require("../services/documents").buildOrderConfirmationPdf({ order: ordersDB.getById(order.id), items: orderItemsDB.query((i) => i.orderId === order.id) });
    assert.ok(pdf.length > 2000);
  });

  test("the same order with the paperwork box ticked: one more line everywhere, and it still adds up", async () => {
    const plain = await h.post("/api/quote", { parts: [h.cncConfig(partId, 5)], leadTimeSlug: "expedited" }, buyer);
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 5)], leadTimeSlug: "expedited", paperwork: true }, buyer);
    const fee = q.body.paperworkFee;
    assert.ok(fee > 0 && q.body.paperwork === true);
    assert.ok(Math.abs(q.body.orderTotal - plain.body.orderTotal - fee) < 0.005, "ticking the box adds the fee and nothing else");
    assert.ok(Math.abs(q.body.leadTimeSurcharge - plain.body.leadTimeSurcharge) < 0.005, "the expedited surcharge is not charged on the paperwork");
    const c = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, buyer);
    const order = ordersDB.getById(c.body.orderId);
    assert.strictEqual(order.paperwork, true);
    assert.ok(Math.abs(order.subtotal + order.leadTimeSurcharge + order.paperworkFee + order.shippingCost - order.total) < 0.01, "subtotal + lead-time fee + paperwork + shipping = total");
    const args = h.stripe.created[h.stripe.created.length - 1];
    assert.strictEqual(args.line_items.reduce((s, li) => s + li.price_data.unit_amount, 0), Math.round(order.total * 100), "Stripe is asked for the whole total");
    assert.strictEqual(args.line_items[1].price_data.unit_amount, Math.round(fee * 100));
    h.pay(`cs_test_${h.stripe.created.length}`);
    h.sent.length = 0;
    const paid = await h.post(`/api/orders/${order.id}/confirm-payment`, {}, buyer);
    assert.strictEqual(paid.body.status, "paid", "paying both lines settles the order");
    const mail = h.sent.find((m) => m.to === "dana@buyer.test");
    assert.ok(/First-article inspection report and certificate of conformance/.test(mail.text));
    const view = await h.get(`/api/orders/${order.id}`, buyer);
    assert.strictEqual(view.body.paperwork, true);
    assert.strictEqual(view.body.paperworkFee, fee);
  });

  test("reorder brings the buyer's notes and drawing along", async () => {
    const withDrawing = ordersDB.getAll().find((o) => o.drawingFileName === "bracket-rev-B.pdf");
    const r = await h.post(`/api/orders/${withDrawing.id}/reorder`, {}, buyer);
    assert.strictEqual(r.status, 201);
    const s = await h.get(`/api/quote/${r.body.quoteId}/session`, buyer);
    assert.strictEqual(s.body.notes, "The 0.500 bore is the one that matters.");
    assert.strictEqual(s.body.drawingFileName, "bracket-rev-B.pdf");
    const again = await h.post("/api/quote", { quoteId: r.body.quoteId, parts: s.body.parts.map(({ partId, materialSlug, quantity, process, subProcess }) => ({ partId, materialSlug, quantity, process, subProcess })), leadTimeSlug: "standard" }, buyer);
    assert.strictEqual(again.body.drawingFileName, "bracket-rev-B.pdf", "re-pricing the reorder keeps the drawing");
  });

  test("an order without payment can only be created by the shop", async () => {
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 1)], leadTimeSlug: "standard" }, buyer);
    assert.strictEqual((await h.post("/api/orders", { quoteId: q.body.quoteId }, buyer)).status, 403);
  });

  await run(h.stop);
})();
