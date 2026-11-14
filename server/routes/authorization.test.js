/**
 * Authorisation sweep: every route that takes an id from the client, tried as
 * a guest and as a different signed-in customer.
 * Run: `node server/routes/authorization.test.js`
 *
 * Two parts:
 *   1. An inventory. Every route in the five routers is listed here with who
 *      may call it. A route that is added later and not listed fails the
 *      suite, and every route listed as admin-only or sign-in-only is called
 *      as a guest (401) and as a customer (403) with real ids.
 *   2. Object-level checks. Alice owns a quote, a quote drawing, an order, an
 *      order drawing and a request; Bob and a guest try each one. Firm-quote
 *      links are tampered with, expired, superseded and swapped with login
 *      tokens. Purchase-order acceptance is tried against requests the owner
 *      never quoted.
 */
const assert = require("assert");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { start, runner } = require("../testSupport/harness");

const { test, run } = runner("Authorisation sweep");
const SHIP = { shippingName: "Alice Buyer", shippingAddress: "100 Main St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" };
const PDF = { name: "print.pdf", data: Buffer.from("%PDF-1.4\n% test drawing\n") };

// Who may call each route. "admin": the admin only, and only once two-step
// sign-in is switched on for that account. "admin-account": an admin account
// whether or not it has enrolled — the enrolment endpoints, the only admin
// routes such an account can reach. "auth": any signed-in
// account (the handler then checks ownership — part 2). "open": no sign-in
// (public data, or the id / signed link in the URL is the credential — part 2).
const INVENTORY = {
  // routes/api.js
  "POST /api/upload": "open", // bot-gated: botCheck.test.js
  "POST /api/parts/:partId/units": "open", // edit key + bot gate: botCheck.test.js
  "POST /api/quote": "open",
  "GET /api/quote/:id": "open",
  "GET /api/quote/:id/session": "open",
  "POST /api/quote/:id/drawing": "open",
  "DELETE /api/quote/:id/drawing": "open",
  // A tax-exemption certificate on a quote: same rule as its drawing (the quote's id, and its owner when it has one). taxShipping.test.js
  "POST /api/quote/:id/tax-certificate": "open",
  "DELETE /api/quote/:id/tax-certificate": "open",
  "GET /api/processes": "open",
  "GET /api/materials": "open",
  "GET /api/finishes": "open",
  "GET /api/lead-times": "open",
  "GET /api/admin/materials": "admin",
  "PUT /api/admin/materials/:id": "admin",
  "POST /api/admin/materials": "admin",
  "POST /api/admin/materials/:id/duplicate": "admin",
  "DELETE /api/admin/materials/:id": "admin",
  "GET /api/admin/finishes": "admin",
  "PUT /api/admin/finishes/:id": "admin",
  "POST /api/admin/finishes": "admin",
  "GET /api/admin/pricing/schema": "admin",
  "GET /api/admin/pricing": "admin",
  "PUT /api/admin/pricing": "admin",
  "POST /api/admin/pricing/preview": "admin",
  "POST /api/admin/shipping/preview": "admin",
  "GET /api/admin/catalogue-upgrade": "admin", // which hand-edited prices a catalogue upgrade kept: config/seedCarry.test.js
  "GET /api/admin/pricing/history": "admin",
  "POST /api/admin/pricing/restore/:id": "admin",
  "POST /api/admin/pricing/reset": "admin",
  "GET /api/admin/calibration": "admin",
  "PUT /api/admin/order-items/:id/actuals": "admin",
  "GET /api/admin/lead-times": "admin",
  "PUT /api/admin/lead-times/:id": "admin",
  "GET /api/admin/quotes": "admin",
  "POST /api/admin/quotes/void-open": "admin", // ends the price hold on open quotes: priceIntegrity.test.js
  "GET /api/admin/audit": "admin", // the admin change log: adminCatalog.test.js
  "GET /api/admin/stats": "admin",
  "GET /api/admin/parts": "admin",
  "GET /api/admin/backup/db": "admin",
  "GET /api/admin/backup/json": "admin",
  "GET /api/parts/:partId/download": "admin",
  // routes/partPayloadRoutes.js: a part's preview and measured detail, to whoever may use the part
  // (security/partAccess.js: the owning account, the holder of the edit key, an admin): partOwnership.test.js, partPayloads.test.js
  "GET /api/parts/:partId/mesh": "open",
  "GET /api/parts/:partId/geometry": "open",
  // routes/adminStorage.js: where storage stands, and the owner's clean-up actions (each written to the change log): storagePressure.test.js
  "GET /api/admin/storage": "admin",
  "POST /api/admin/drafts/purge": "admin",
  "DELETE /api/admin/requests/:id/attachment": "admin",
  "DELETE /api/admin/requests/:id": "admin",
  // routes/auth.js
  "POST /api/auth/register": "open",
  "POST /api/auth/admin-setup": "open", // needs the owner's ADMIN_SETUP_CODE, closed once an admin exists: adminSetup.test.js
  "POST /api/auth/login": "open",
  "POST /api/auth/logout": "open",
  "POST /api/auth/logout-all": "auth",
  "GET /api/auth/session": "open",
  "POST /api/auth/verify-email": "open",
  "POST /api/auth/verify-email/resend": "auth",
  "POST /api/auth/password-reset/request": "open",
  "POST /api/auth/password-reset/check": "open",
  "POST /api/auth/password-reset/confirm": "open",
  "GET /api/auth/profile": "auth",
  "PUT /api/auth/profile": "auth",
  "GET /api/auth/2fa": "admin-account",
  "POST /api/auth/2fa/setup": "admin-account",
  "POST /api/auth/2fa/enable": "admin-account",
  "POST /api/auth/2fa/recovery-codes": "admin-account",
  "POST /api/auth/2fa/disable": "admin-account",
  // routes/orders.js
  "POST /api/orders/checkout-session": "auth",
  "POST /api/orders/": "admin",
  "GET /api/orders/": "auth",
  "GET /api/orders/:id": "auth",
  "PUT /api/orders/:id/status": "admin",
  "POST /api/orders/:id/resolve-attention": "admin",
  "GET /api/orders/admin/payment-settings": "admin",
  "POST /api/orders/:id/confirm-payment": "auth",
  "POST /api/orders/:id/cancel": "auth", // the buyer's own unpaid order only (ownedOrder; routes/orderCaps.test.js)
  "POST /api/orders/:id/reorder": "auth",
  "GET /api/orders/:id/drawing": "auth",
  "GET /api/orders/:id/traveler": "admin",
  "GET /api/orders/:id/tax-certificate": "admin", // the buyer's exemption certificate: the shop only
  "GET /api/orders/admin/queue": "admin",
  // routes/rfq.js
  "POST /api/rfq/": "open", // bot-checked: botCheck.test.js
  "GET /api/rfq/admin/list": "admin",
  "PUT /api/rfq/admin/:id": "admin",
  "GET /api/rfq/admin/:id/drawing": "admin",
  "GET /api/rfq/quote/:token": "open",
  "POST /api/rfq/quote/:token/accept": "open",
  "POST /api/rfq/quote/:token/confirm-payment": "open",
  "POST /api/rfq/return/confirm": "open", // needs a return token for that one order: orderLifecycle.test.js
  // The signed link is the credential, as for accepting; only an open quote can be changed. taxShipping.test.js
  "POST /api/rfq/quote/:token/tax-certificate": "open",
  "DELETE /api/rfq/quote/:token/tax-certificate": "open",
  "GET /api/rfq/:id": "open",
  // routes/pdf.js
  "GET /api/pdf/traveler/:orderId": "admin",
  "GET /api/pdf/packing-list/:orderId": "admin",
  "GET /api/pdf/quote/:quoteId": "admin",
  "GET /api/pdf/rfq-response/:rfqId": "admin",
  "GET /api/pdf/order-confirmation/:orderId": "admin",
  "GET /api/pdf/packing-slip/:orderId": "admin",
  "GET /api/pdf/coc/:orderId": "admin",
  "GET /api/pdf/fai": "admin",
};

function routesOf(prefix, router) {
  const out = [];
  for (const layer of router.stack) {
    // A router mounted inside this one with no path of its own (routes/api.js mounts routes/partPayloadRoutes.js and
    // routes/adminStorage.js that way): its routes are this router's routes. (Added at the second integration pass:
    // those routes were not being listed, so nothing here asked who may call them.)
    if (!layer.route && layer.name === "router" && layer.handle && Array.isArray(layer.handle.stack)) {
      assert.ok(layer.regexp && layer.regexp.fast_slash, "a router mounted under a path of its own would need that path added here");
      out.push(...routesOf(prefix, layer.handle));
      continue;
    }
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) out.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
  }
  return out;
}

(async () => {
  const h = await start({ mailer: "configured" });
  const { quotesDB, ordersDB, orderItemsDB, rfqsDB, partsDB, usersDB } = h.models;
  const rfqToken = require("../services/rfqToken");
  const tokens = require("../security/tokens");

  let owner, alice, bob, partId, guestPart, aliceQuote, aliceOrder, aliceRfq, anonQuote, anonRfq, anonQuoted;
  const asGuest = (method, url, json) => h.raw(method, url, { json: method === "GET" ? undefined : (json || {}), headers: { "X-Human-Token": h.humanToken } });
  const as = (token) => (method, url, json) => h.raw(method, url, { json: method === "GET" ? undefined : (json || {}), token, headers: { "X-Human-Token": h.humanToken } });
  const tokenFrom = (mail) => (mail.text.match(/https:\/\/shop\.test\/firm-quote\/(\S+)/) || [])[1];

  async function quoteRfq(rfqId, total = 4250) {
    h.sent.length = 0;
    const r = await h.put(`/api/rfq/admin/${rfqId}`, { status: "quoted", quotedTotal: total, quotedLeadDays: 15 }, owner);
    assert.strictEqual(r.status, 200, r.text);
    return tokenFrom(h.sent.find((m) => /firm quote/.test(m.subject)));
  }

  test("setup: the admin, Alice with a quote, a drawing, a paid order and a request; Bob with nothing; a guest's quote and request", async () => {
    owner = await h.admin("Owner");
    alice = await h.register("alice@buyer.test", "Alice Buyer");
    bob = await h.register("bob@other.test", "Bob Other");
    partId = await h.uploadCube();
    const q = await h.post("/api/quote", { parts: [h.cncConfig(partId, 3)], leadTimeSlug: "standard", notes: "Alice's private note" }, alice);
    aliceQuote = q.body.quoteId;
    assert.strictEqual(quotesDB.getById(aliceQuote).userId, usersDB.getAll().find((u) => u.email === "alice@buyer.test").id);
    assert.strictEqual((await h.form(`/api/quote/${aliceQuote}/drawing`, {}, { drawing: PDF }, alice)).status, 200);
    const c = await h.post("/api/orders/checkout-session", { quoteId: aliceQuote, ...SHIP }, alice);
    assert.strictEqual(c.status, 200, c.text);
    aliceOrder = c.body.orderId;
    h.pay(ordersDB.getById(aliceOrder).stripeSessionId);
    assert.strictEqual((await h.post(`/api/orders/${aliceOrder}/confirm-payment`, {}, alice)).body.status, "paid");
    // A second quote of Alice's that is still a draft (the first became an order).
    const q2 = await h.post("/api/quote", { parts: [h.cncConfig(partId, 4)], leadTimeSlug: "standard", notes: "Alice's draft" }, alice);
    aliceQuote = q2.body.quoteId;
    assert.strictEqual((await h.form(`/api/quote/${aliceQuote}/drawing`, {}, { drawing: PDF }, alice)).status, 200);
    const r = await h.form("/api/rfq", { contactName: "Alice Buyer", email: "alice@buyer.test", phone: "815-555-0101", notes: "Alice's request", ...SHIP }, { drawing: PDF }, alice); // (requests carry the ship-to address since 2026-11-13, review N-05)
    assert.strictEqual(r.status, 201, r.text);
    aliceRfq = r.body.rfqId;
    // A guest's quote and request (no account behind them).
    // (The guest brings a part of their own: Alice's part is Alice's since she priced it signed in.)
    guestPart = await h.uploadCube();
    anonQuote = (await h.post("/api/quote", { parts: [h.cncConfig(guestPart, 500)], leadTimeSlug: "standard" })).body.quoteId;
    assert.ok(anonQuote, "the guest's quote was priced");
    anonRfq = (await h.form("/api/rfq", { quoteId: anonQuote, contactName: "Gil Guest", email: "gil@guest.test", phone: "815-555-0199", notes: "private words", ...SHIP })).body.rfqId;
    anonQuoted = await quoteRfq(anonRfq);
    assert.ok(anonQuoted);
  });

  // ═══ 1. The inventory ═════════════════════════════════════════
  const routers = { "/api": require("./api"), "/api/auth": require("./auth"), "/api/orders": require("./orders"), "/api/rfq": require("./rfq"), "/api/pdf": require("./pdf") };

  test("every route in the app is in the inventory (a new route must say who may call it)", () => {
    const actual = Object.entries(routers).flatMap(([prefix, router]) => routesOf(prefix, router)).sort();
    const listed = Object.keys(INVENTORY).sort();
    assert.deepStrictEqual(actual.filter((r) => !listed.includes(r)), [], "routes missing from the inventory");
    assert.deepStrictEqual(listed.filter((r) => !actual.includes(r)), [], "inventory entries with no route");
  });

  /** A real URL for a route pattern, filled with ids of things that exist and belong to Alice or the shop. */
  function concrete(pattern) {
    const item = orderItemsDB.query((i) => i.orderId === aliceOrder)[0];
    const material = h.models.materialsDB.getAll()[0];
    const leadTime = h.models.leadTimesDB.getAll()[0];
    const finish = h.models.finishesDB.getAll()[0];
    return pattern
      .replace("/admin/materials/:id", `/admin/materials/${material.id}`)
      .replace("/admin/finishes/:id", `/admin/finishes/${finish.id}`)
      .replace("/admin/lead-times/:id", `/admin/lead-times/${leadTime.id}`)
      .replace("/admin/order-items/:id", `/admin/order-items/${item.id}`)
      .replace("/admin/pricing/restore/:id", `/admin/pricing/restore/${crypto.randomUUID()}`)
      .replace("/api/rfq/admin/:id", `/api/rfq/admin/${aliceRfq}`)
      .replace("/api/admin/requests/:id", `/api/admin/requests/${aliceRfq}`)
      .replace("/api/orders/:id", `/api/orders/${aliceOrder}`)
      .replace(":orderId", aliceOrder).replace(":quoteId", aliceQuote).replace(":rfqId", aliceRfq).replace(":partId", partId)
      .replace("/api/pdf/fai", `/api/pdf/fai?orderId=${aliceOrder}`);
  }

  test("every admin-only route answers 401 to a guest and 403 to a signed-in customer, with real ids, and changes nothing", async () => {
    const admin = Object.entries(INVENTORY).filter(([, who]) => who === "admin" || who === "admin-account").map(([route]) => route);
    assert.ok(admin.length >= 40);
    const snapshot = () => JSON.stringify([h.models.materialsDB.getAll().length, h.models.finishesDB.getAll().length, h.models.pricingDB.getAll(), ordersDB.getById(aliceOrder).status, rfqsDB.getById(aliceRfq).status, h.models.leadTimesDB.getAll().map((l) => l.multiplier), ordersDB.getAll().length]);
    const before = snapshot();
    for (const route of admin) {
      const [method, pattern] = route.split(" ");
      const url = concrete(pattern);
      const body = { status: "shipped", quotedTotal: 1, quotedLeadDays: 1, rules: {}, note: "x", name: "X", slug: "x", multiplier: 0.01, quoteId: aliceQuote, password: h.password, code: "000000" };
      const guest = await asGuest(method, url, body);
      assert.strictEqual(guest.status, 401, `${route} as a guest → ${guest.status} ${guest.text.slice(0, 80)}`);
      for (const [name, token] of [["Bob", bob], ["Alice (the owner of the order)", alice]]) {
        const r = await as(token)(method, url, body);
        assert.strictEqual(r.status, 403, `${route} as ${name} → ${r.status} ${r.text.slice(0, 80)}`);
      }
    }
    assert.strictEqual(snapshot(), before);
  });

  test("an admin account without two-step sign-in is refused on every admin route (403, enrolment code) and reaches only the enrolment endpoints", async () => {
    // A second admin account that has not enrolled (the owner's has: h.admin()).
    const pending = await h.register("second-admin@shop.test", "Second Admin");
    const row = usersDB.getAll().find((u) => u.email === "second-admin@shop.test");
    usersDB.update(row.id, { role: "admin" });
    const sessionView = (await h.get("/api/auth/session", pending)).body.user;
    assert.deepStrictEqual([sessionView.role, sessionView.twoFactorEnabled, sessionView.twoFactorRequired], ["admin", false, true]);
    const ownerView = (await h.get("/api/auth/session", owner)).body.user;
    assert.deepStrictEqual([ownerView.role, ownerView.twoFactorEnabled, ownerView.twoFactorRequired], ["admin", true, false]);

    const snapshot = () => JSON.stringify([h.models.materialsDB.getAll().length, h.models.finishesDB.getAll().length, h.models.pricingDB.getAll(), ordersDB.getById(aliceOrder).status, rfqsDB.getById(aliceRfq).status, h.models.leadTimesDB.getAll().map((l) => l.multiplier), ordersDB.getAll().length]);
    const before = snapshot();
    const body = { status: "shipped", quotedTotal: 1, quotedLeadDays: 1, rules: {}, note: "x", name: "X", slug: "x", multiplier: 0.01, quoteId: aliceQuote };
    const adminOnly = Object.entries(INVENTORY).filter(([, who]) => who === "admin").map(([route]) => route);
    assert.ok(adminOnly.length >= 40);
    for (const route of adminOnly) {
      const [method, pattern] = route.split(" ");
      const r = await as(pending)(method, concrete(pattern), body);
      assert.strictEqual(r.status, 403, `${route} as an admin who has not enrolled → ${r.status} ${r.text.slice(0, 80)}`);
      assert.deepStrictEqual(r.body, { error: "Set up two-step sign-in before using the admin pages.", code: "two-factor-enrolment-required" }, route);
    }
    assert.strictEqual(snapshot(), before, "nothing changed");
    // Where the admin role widens what a signed-in account may read, it does not for this account.
    assert.strictEqual((await as(pending)("GET", `/api/orders/${aliceOrder}`)).status, 403);
    assert.strictEqual((await as(pending)("GET", `/api/quote/${aliceQuote}`)).status, 404);
    assert.strictEqual((await as(pending)("GET", `/api/rfq/${aliceRfq}`)).status, 404);
    assert.deepStrictEqual((await as(pending)("GET", "/api/orders")).body, [], "its own (empty) order list, not everyone's");
    // The enrolment endpoints answer on their merits, not with the enrolment refusal.
    const status = await as(pending)("GET", "/api/auth/2fa");
    assert.deepStrictEqual([status.status, status.body.enabled], [200, false]);
    const wrongPw = await as(pending)("POST", "/api/auth/2fa/setup", { password: "not-the-password" });
    assert.deepStrictEqual([wrongPw.status, wrongPw.body.code], [401, "invalid-credentials"]);
    const noSetup = await as(pending)("POST", "/api/auth/2fa/enable", { code: "000000" });
    assert.deepStrictEqual([noSetup.status, noSetup.body.code], [400, "setup-missing"]);
    for (const route of ["/api/auth/2fa/recovery-codes", "/api/auth/2fa/disable"]) {
      const r = await as(pending)("POST", route, { password: h.password, code: "000000" });
      assert.deepStrictEqual([r.status, r.body.code], [409, "not-enabled"], route);
    }
    // Sign-out is always there.
    assert.strictEqual((await as(pending)("POST", "/api/auth/logout")).status, 200);
    assert.strictEqual((await as(pending)("GET", "/api/auth/profile")).status, 401);
    usersDB.update(row.id, { role: "customer" });
  });

  test("every sign-in-only route answers 401 to a guest", async () => {
    const auth = Object.entries(INVENTORY).filter(([, who]) => who === "auth").map(([route]) => route);
    for (const route of auth) {
      const [method, pattern] = route.split(" ");
      const r = await asGuest(method, concrete(pattern), { quoteId: aliceQuote, ...SHIP });
      assert.strictEqual(r.status, 401, `${route} as a guest → ${r.status}`);
    }
  });

  // ═══ 2. Object level: quotes ══════════════════════════════════
  for (const [who, actor] of [["a guest", () => asGuest], ["another customer", () => as(bob)]]) {
    test(`${who} cannot read, reopen, re-price, attach to, check out or request against Alice's quote`, async () => {
      const call = actor();
      const before = JSON.stringify(quotesDB.getById(aliceQuote));
      assert.strictEqual((await call("GET", `/api/quote/${aliceQuote}`)).status, 404);
      const session = await call("GET", `/api/quote/${aliceQuote}/session`);
      assert.strictEqual(session.status, 404);
      assert.ok(!session.text.includes("positions"), "no geometry of Alice's part");
      // Re-pricing with her quote id makes a new quote for the caller; hers is untouched and nothing of hers is carried over.
      // (With a part of the caller's own. Alice's part cannot be priced by anyone else at all: review 2026-11-11, F5.)
      const hers = await call("POST", "/api/quote", { quoteId: aliceQuote, parts: [{ ...h.cncConfig(partId, 9), editKey: h.editKeys[partId] }], leadTimeSlug: "standard" });
      assert.strictEqual(hers.status, 400);
      assert.strictEqual(hers.body.code, "part-not-found", "Alice's part is not found for another caller, even one holding its edit key");
      assert.ok(!hers.text.includes("cube_20mm"), "and nothing about it comes back");
      const own = await h.uploadCube();
      const re = await call("POST", "/api/quote", { quoteId: aliceQuote, parts: [{ ...h.cncConfig(own, 9), editKey: h.editKeys[own] }], leadTimeSlug: "standard" });
      assert.strictEqual(re.status, 200);
      assert.notStrictEqual(re.body.quoteId, aliceQuote);
      assert.strictEqual(re.body.notes, "");
      assert.strictEqual(re.body.drawingFileName, "");
      quotesDB.delete(re.body.quoteId);
      // Drawing: attach and remove.
      const fd = new FormData();
      fd.append("drawing", new Blob([PDF.data]), "evil.pdf");
      const up = await h.raw("POST", `/api/quote/${aliceQuote}/drawing`, { body: fd, token: who === "a guest" ? undefined : bob, headers: { "X-Human-Token": h.humanToken } });
      assert.strictEqual(up.status, 404);
      assert.strictEqual((await call("DELETE", `/api/quote/${aliceQuote}/drawing`)).status, 404);
      // Checkout and a request against it.
      const co = await call("POST", "/api/orders/checkout-session", { quoteId: aliceQuote, ...SHIP });
      assert.strictEqual(co.status, who === "a guest" ? 401 : 403);
      const form = new FormData();
      for (const [k, v] of Object.entries({ quoteId: aliceQuote, contactName: "X", email: "x@y.test" })) form.append(k, v);
      const rq = await h.raw("POST", "/api/rfq", { body: form, token: who === "a guest" ? undefined : bob, headers: { "X-Form-Token": h.formToken("rfq"), "X-Turnstile-Token": "pass" } });
      assert.strictEqual(rq.status, 404);
      assert.strictEqual(JSON.stringify(quotesDB.getById(aliceQuote)), before, "her quote is exactly as it was");
    });
  }

  test("a guest's own quote stays reachable by its id (that id is the guest's credential), without server paths", async () => {
    const g = await asGuest("GET", `/api/quote/${anonQuote}`);
    assert.strictEqual(g.status, 200);
    assert.ok(!("drawingPath" in g.body));
    assert.strictEqual((await asGuest("GET", `/api/quote/${crypto.randomUUID()}`)).status, 404);
    assert.strictEqual((await asGuest("GET", "/api/quote/..%2F..%2Fetc")).status, 404);
  });

  // ═══ 2. Object level: orders ══════════════════════════════════
  for (const [who, actor, denied] of [["a guest", () => asGuest, 401], ["another customer", () => as(bob), 403]]) {
    test(`${who} cannot see, download from, reorder, settle, or change Alice's order`, async () => {
      const call = actor();
      const before = JSON.stringify(ordersDB.getById(aliceOrder));
      const quotes = quotesDB.getAll().length;
      for (const [method, url] of [
        ["GET", `/api/orders/${aliceOrder}`],
        ["GET", `/api/orders/${aliceOrder}/drawing`],
        ["POST", `/api/orders/${aliceOrder}/reorder`],
        ["POST", `/api/orders/${aliceOrder}/confirm-payment`],
        ["GET", `/api/orders/${aliceOrder}/traveler`],
        ["PUT", `/api/orders/${aliceOrder}/status`],
        ["GET", `/api/pdf/traveler/${aliceOrder}`],
        ["GET", `/api/pdf/packing-list/${aliceOrder}`],
        ["GET", `/api/pdf/order-confirmation/${aliceOrder}`],
        ["GET", `/api/pdf/packing-slip/${aliceOrder}`],
        ["GET", `/api/pdf/coc/${aliceOrder}`],
        ["GET", `/api/parts/${partId}/download`],
      ]) {
        const r = await call(method, url, { status: "cancelled" });
        assert.strictEqual(r.status, denied, `${method} ${url} → ${r.status}`);
        assert.ok(!r.text.includes("Alice") && !r.text.includes("100 Main St") && !r.text.includes("%PDF"), `${url} leaked order data`);
      }
      const list = await call("GET", "/api/orders");
      if (denied === 401) assert.strictEqual(list.status, 401);
      else assert.deepStrictEqual(list.body, [], "Bob's order list holds nothing of Alice's");
      assert.strictEqual(JSON.stringify(ordersDB.getById(aliceOrder)), before);
      assert.strictEqual(quotesDB.getAll().length, quotes, "no quote was rebuilt from her order");
    });
  }

  test("Alice herself: her order, drawing and reorder work; the admin-only views of her own order do not; internal notes stay internal", async () => {
    ordersDB.update(aliceOrder, { notes: "INTERNAL: check her credit" });
    const mine = as(alice);
    const o = await mine("GET", `/api/orders/${aliceOrder}`);
    assert.strictEqual(o.status, 200);
    assert.ok(!("notes" in o.body) && !("drawingPath" in o.body) && !o.text.includes("INTERNAL"));
    assert.strictEqual(o.body.hasDrawing, true);
    const d = await mine("GET", `/api/orders/${aliceOrder}/drawing`);
    assert.strictEqual(d.status, 200);
    assert.ok(d.text.startsWith("%PDF"));
    const list = await mine("GET", "/api/orders");
    assert.strictEqual(list.body.length, 1);
    assert.ok(!list.text.includes("INTERNAL") && !list.text.includes("drawingPath"));
    assert.strictEqual((await mine("POST", `/api/orders/${aliceOrder}/reorder`)).status, 201);
    assert.strictEqual((await mine("GET", `/api/orders/${aliceOrder}/traveler`)).status, 403);
    assert.strictEqual((await mine("PUT", `/api/orders/${aliceOrder}/status`, { status: "delivered" })).status, 403);
    // The traveler answer does not say whether an order id exists.
    const missing = await mine("GET", `/api/orders/${crypto.randomUUID()}/traveler`);
    assert.strictEqual(missing.status, 403);
    // The admin sees everything.
    const a = await as(owner)("GET", `/api/orders/${aliceOrder}`);
    assert.strictEqual(a.body.notes, "INTERNAL: check her credit");
  });

  // ═══ 2. Object level: requests ════════════════════════════════
  test("a request with an account behind it is readable by its owner and the admin only", async () => {
    for (const call of [asGuest, as(bob)]) {
      const r = await call("GET", `/api/rfq/${aliceRfq}`);
      assert.strictEqual(r.status, 404);
      assert.ok(!r.text.includes("alice@buyer.test"));
    }
    const mine = await as(alice)("GET", `/api/rfq/${aliceRfq}`);
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.email, "alice@buyer.test");
    assert.ok(!("drawingPath" in mine.body) && !("senderCheck" in mine.body));
    assert.strictEqual((await as(owner)("GET", `/api/rfq/${aliceRfq}`)).body.senderCheck, "turnstile");
    // The drawing she attached is for the admin's download route only.
    for (const call of [asGuest, as(bob), as(alice)]) {
      const r = await call("GET", `/api/rfq/admin/${aliceRfq}/drawing`);
      assert.ok(r.status === 401 || r.status === 403);
      assert.ok(!r.text.startsWith("%PDF"));
    }
    assert.ok((await as(owner)("GET", `/api/rfq/admin/${aliceRfq}/drawing`)).text.startsWith("%PDF"));
  });

  test("a request sent without an account shows only its status to whoever holds its id: no name, email, phone, notes or price", async () => {
    for (const call of [asGuest, as(bob)]) {
      const r = await call("GET", `/api/rfq/${anonRfq}`);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(Object.keys(r.body).sort(), ["createdAt", "id", "reference", "requestType", "status"]);
      for (const secret of ["gil@guest.test", "Gil", "815-555-0199", "private words", "4250", "quotedTotal"]) assert.ok(!r.text.includes(secret), secret);
    }
    assert.strictEqual((await as(owner)("GET", `/api/rfq/${anonRfq}`)).body.email, "gil@guest.test");
    assert.strictEqual((await asGuest("GET", `/api/rfq/${crypto.randomUUID()}`)).status, 404);
  });

  // ═══ 2. Firm-quote links ══════════════════════════════════════
  test("a firm-quote link opens its own quote and nothing else: not a session, not the admin queue, not another request", async () => {
    const view = await asGuest("GET", `/api/rfq/quote/${anonQuoted}`);
    assert.strictEqual(view.status, 200);
    assert.strictEqual(view.body.reference, anonRfq.slice(0, 8).toUpperCase());
    assert.ok(!("id" in view.body) && !("notes" in view.body) && !("phone" in view.body) && !("drawingPath" in view.body));
    // As a login token.
    for (const url of ["/api/orders", "/api/auth/profile", "/api/rfq/admin/list", "/api/admin/stats", `/api/orders/${aliceOrder}`]) {
      assert.strictEqual((await h.raw("GET", url, { token: anonQuoted })).status, 401, url);
    }
    assert.strictEqual((await h.raw("GET", "/api/auth/session", { token: anonQuoted })).body.authenticated, false);
    assert.strictEqual((await h.raw("GET", `/api/rfq/${aliceRfq}`, { token: anonQuoted })).status, 404, "it does not make its holder Alice");
  });

  test("login tokens and other signed values are not firm-quote links", async () => {
    const candidates = {
      "Alice's session": alice,
      "the admin's session": owner,
      "a verified-human token": h.humanToken,
      "a reset link": tokens.sign("password-reset", { rfqId: anonRfq, v: rfqsDB.getById(anonRfq).quoteSentAt }),
      "a session-key token naming the request": jwt.sign({ rfqId: anonRfq, v: rfqsDB.getById(anonRfq).quoteSentAt, exp: Math.floor(Date.now() / 1000) + 3600 }, process.env.JWT_SECRET, { audience: "rfq-quote" }),
      "garbage": "abc.def.ghi",
    };
    for (const [name, token] of Object.entries(candidates)) {
      const r = await asGuest("GET", `/api/rfq/quote/${token}`);
      assert.strictEqual(r.status, 404, name);
      assert.strictEqual(r.body.code, "link-invalid");
      assert.strictEqual((await asGuest("POST", `/api/rfq/quote/${token}/accept`, { method: "po", poNumber: "PO-1", ...SHIP })).status, 404, name);
      assert.strictEqual((await asGuest("POST", `/api/rfq/quote/${token}/confirm-payment`)).status, 404, name);
    }
  });

  test("a tampered link is refused: another request's id, a later expiry, an unsigned copy", async () => {
    const [head, payload, sig] = anonQuoted.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const tampered = {
      "points at Alice's request": [head, enc({ ...claims, rfqId: aliceRfq }), sig].join("."),
      "expiry pushed out": [head, enc({ ...claims, exp: claims.exp + 86400 * 365 }), sig].join("."),
      "alg none": [enc({ alg: "none", typ: "JWT" }), payload, ""].join("."),
      "signature cut": [head, payload, sig.slice(0, -4)].join("."),
    };
    const orders = ordersDB.getAll().length;
    for (const [name, token] of Object.entries(tampered)) {
      assert.strictEqual((await asGuest("GET", `/api/rfq/quote/${token}`)).status, 404, name);
      assert.strictEqual((await asGuest("POST", `/api/rfq/quote/${token}/accept`, { method: "po", poNumber: "PO-1", ...SHIP })).status, 404, name);
    }
    assert.strictEqual(ordersDB.getAll().length, orders);
  });

  test("an expired link and a superseded link are refused, with nothing ordered", async () => {
    const orders = ordersDB.getAll().length;
    const rfq = rfqsDB.getById(anonRfq);
    const expired = rfqToken.sign({ ...rfq, validUntil: new Date(Date.now() - 60e3).toISOString() });
    const e = await asGuest("POST", `/api/rfq/quote/${expired}/accept`, { method: "po", poNumber: "PO-1", ...SHIP });
    assert.strictEqual(e.status, 410);
    assert.strictEqual(e.body.code, "quote-expired");
    // The owner re-sends at a new price: the earlier link is dead.
    const first = anonQuoted;
    anonQuoted = await quoteRfq(anonRfq, 3900);
    const s = await asGuest("POST", `/api/rfq/quote/${first}/accept`, { method: "po", poNumber: "PO-1", ...SHIP });
    assert.strictEqual(s.status, 410);
    assert.strictEqual(s.body.code, "link-superseded");
    assert.strictEqual((await asGuest("GET", `/api/rfq/quote/${first}`)).status, 410);
    assert.strictEqual(ordersDB.getAll().length, orders);
  });

  test("a purchase-order order can only come from a quote the owner sent: not from a new, in-review, declined or lost request", async () => {
    const orders = ordersDB.getAll().length;
    // Alice's request was never quoted: there is no link for it, and one cannot be made without the key.
    assert.strictEqual(rfqsDB.getById(aliceRfq).quoteSentAt, null);
    // Even a correctly signed link stops working the moment the owner takes the quote back.
    for (const status of ["new", "in-review", "declined", "lost"]) {
      rfqsDB.update(anonRfq, { status });
      const r = await asGuest("POST", `/api/rfq/quote/${anonQuoted}/accept`, { method: "po", poNumber: "PO-BOT", ...SHIP });
      assert.strictEqual(r.status, 409, status);
      assert.strictEqual(r.body.code, "not-open");
    }
    assert.strictEqual(ordersDB.getAll().length, orders, "no pending_po order was created");
    assert.strictEqual(ordersDB.query((o) => o.poNumber === "PO-BOT").length, 0);
    rfqsDB.update(anonRfq, { status: "quoted" });
  });

  test("accepting by PO works once for the holder of the live link; the link cannot be reused to stack orders or switch to a card payment", async () => {
    const orders = ordersDB.getAll().length;
    const incomplete = await asGuest("POST", `/api/rfq/quote/${anonQuoted}/accept`, { method: "po", ...SHIP });
    assert.strictEqual(incomplete.status, 400, "a PO number is required");
    const ok = await asGuest("POST", `/api/rfq/quote/${anonQuoted}/accept`, { method: "po", poNumber: "PO-77812", ...SHIP });
    assert.strictEqual(ok.status, 201, ok.text);
    const order = ordersDB.query((o) => o.rfqId === anonRfq)[0];
    assert.strictEqual(order.status, "pending_po");
    assert.strictEqual(order.total, 3900, "the price the owner sent, not one from the request");
    assert.strictEqual(order.userId, null);
    for (const body of [{ method: "po", poNumber: "PO-2", ...SHIP }, { method: "card", ...SHIP }, { method: "po", poNumber: "PO-3", ...SHIP, total: 1, quotedTotal: 1 }]) {
      const again = await asGuest("POST", `/api/rfq/quote/${anonQuoted}/accept`, body);
      assert.strictEqual(again.status, 409);
    }
    assert.strictEqual(ordersDB.getAll().length, orders + 1);
    assert.strictEqual(h.stripe.created.filter((c) => c.metadata && c.metadata.rfqId === anonRfq).length, 0, "no card session was opened for it");
    // The guest's PO order is nobody's account order: no customer can open it by id.
    for (const call of [as(bob), as(alice)]) assert.strictEqual((await call("GET", `/api/orders/${order.id}`)).status, 403);
    assert.strictEqual((await asGuest("GET", `/api/orders/${order.id}`)).status, 401);
    // The link still shows its holder their order, and only theirs.
    const view = await asGuest("GET", `/api/rfq/quote/${anonQuoted}`);
    assert.strictEqual(view.body.order.status, "pending_po");
  });

  test("ids from the client that are not ids: traversal and junk get 404s, never a file or a stack trace", async () => {
    for (const bad of ["..%2F..%2Fdata%2Fquoting.db", "%2e%2e%2f%2e%2e%2fpackage.json", "1%20OR%201=1", "null", "undefined", "%00"]) {
      for (const [call, expected] of [[as(alice), [403, 404]], [as(owner), [404, 400]]]) {
        for (const url of [`/api/orders/${bad}`, `/api/orders/${bad}/drawing`, `/api/rfq/${bad}`, `/api/quote/${bad}`, `/api/quote/${bad}/session`, `/api/parts/${bad}/download`]) {
          const r = await call("GET", url);
          assert.ok([...expected, 404].includes(r.status), `${url} → ${r.status}`);
          assert.ok(!/SQLite format|"dependencies"|at .*\.js:\d+/.test(r.text), `${url} leaked`);
        }
      }
    }
    assert.ok(partsDB.getById(partId));
  });

  await run(h.stop);
})();
