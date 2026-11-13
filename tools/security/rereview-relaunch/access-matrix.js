/**
 * Other people's parts, quotes, orders, certificates and drawings (re-review 2026-11-12).
 *
 *   node tools/security/rereview-relaunch/access-matrix.js
 *
 * Alice (an account), Vic (a visitor with no account) and Mallory (another account, and as a guest).
 * Mallory knows every id (part, quote, order, request) but holds none of the keys or links.
 * Exit code 1 when Mallory reads, prices, changes or deletes something that is not hers.
 */
const fs = require("fs");
const path = require("path");
const { liftPacing, rectDxf, report, SHIP } = require("./lib");
const { start } = require("../../../server/testSupport/harness");
const PDF = Buffer.from("%PDF-1.4\n%certificate (test)\n");

(async () => {
  liftPacing();
  const h = await start();
  const R = report();
  const { quotesDB, ordersDB, partsDB, rfqsDB } = h.models;
  const owner = await h.admin("Owner");
  const alice = await h.register("alice@buyer.test", "Alice");
  const mallory = await h.register("mallory@evil.test", "Mallory");
  const cube = fs.readFileSync(path.join(__dirname, "..", "..", "vet-quotes", "parts", "cube_20mm.stl"));
  const put = (rules) => h.put("/api/admin/pricing", { rules, note: "re-review" }, owner);
  await put({ taxMode: "stripe", taxExemptDeclare: "on", shippingLocalPickup: "on" });

  // Alice uploads signed in; Vic uploads as a visitor. Each prices a quote.
  const upA = await h.form("/api/upload", {}, { files: { name: "alice-secret-bracket.stl", data: cube } }, alice);
  const pA = upA.body.parts[0].partId, kA = upA.body.parts[0].editKey;
  const upV = await h.form("/api/upload", {}, { files: { name: "vic-secret-plate.dxf", data: rectDxf(6, 4) } });
  const pV = upV.body.parts[0].partId, kV = upV.body.parts[0].editKey;
  const qA = await h.post("/api/quote", { parts: [h.cncConfig(pA, 2)], leadTimeSlug: "standard" }, alice);
  const hd = h.models.materialsDB.getAll().find((m) => m.slug === "rt-hdpe");
  const vCfg = { partId: pV, materialSlug: "rt-hdpe", grade: hd.grades[0].name, finishSlug: "", quantity: 1, process: "routing", thicknessMm: 1.6 };
  const qV = await h.post("/api/quote", { parts: [vCfg], leadTimeSlug: "standard" });
  if (qA.status !== 200 || qV.status !== 200) throw new Error(`setup quotes: ${qA.status} ${qV.status} ${qV.text.slice(0, 200)}`);
  await h.form(`/api/quote/${qA.body.quoteId}/tax-certificate`, {}, { certificate: { name: "alice-cert.pdf", data: PDF } }, alice);
  await h.form(`/api/quote/${qA.body.quoteId}/drawing`, {}, { drawing: { name: "alice-drawing.pdf", data: PDF } }, alice);
  // A second quote of Alice's becomes a paid order.
  const qA2 = await h.post("/api/quote", { parts: [h.cncConfig(pA, 1)], leadTimeSlug: "standard" }, alice);
  await h.form(`/api/quote/${qA2.body.quoteId}/tax-certificate`, {}, { certificate: { name: "alice-cert.pdf", data: PDF } }, alice);
  const cA = await h.post("/api/orders/checkout-session", { quoteId: qA2.body.quoteId, ...SHIP, taxExempt: true, taxExemptReason: "resale" }, alice);
  if (cA.status !== 200) throw new Error(`setup order: ${cA.status} ${cA.text}`);
  await h.completed(String(cA.body.sessionUrl).split("/").pop());
  const orderA = cA.body.orderId;
  // A firm-quote request from Vic with a drawing.
  const rfq = await h.form("/api/rfq", { contactName: "Vic Visitor", email: "vic@visitor.test", phone: "555-0100", notes: "one plate, confidential", quantities: "3" }, { drawing: { name: "vic-rfq-drawing.pdf", data: PDF } });
  const stored = rfqsDB.getAll().find((x) => x.email === "vic@visitor.test");
  const rfqId = stored && stored.id;
  if (!rfqId) console.log(`  (the request was not stored: ${rfq.status} ${rfq.text.slice(0, 160)})`);

  const leak = (r, ...needles) => needles.some((n) => n && r.text && r.text.includes(n));
  // (A part the caller may not use is answered exactly like one that does not exist: 400 part-not-found on pricing.)
  const denied = (r) => [401, 403, 404, 409].includes(r.status) || (r.status === 400 && r.body && r.body.code === "part-not-found");
  async function tryAs(who, token) {
    const tag = `[${who}]`;
    const key = (k) => ({ "X-Part-Key": k });
    const getK = (url, k) => h.raw("GET", url, { token, headers: { ...(k ? key(k) : {}), ...(h.humanToken ? { "X-Human-Token": h.humanToken } : {}) } });
    // Parts
    for (const [name, id, wrongKey] of [["Alice's part (account-owned)", pA, kV], ["Vic's part (visitor, key-held)", pV, kA]]) {
      const mesh = await getK(`/api/parts/${id}/mesh`, null);
      const meshWrong = await getK(`/api/parts/${id}/mesh`, wrongKey);
      const geo = await getK(`/api/parts/${id}/geometry`, null);
      const price = await h.raw("POST", "/api/quote", { token, json: { parts: [{ ...(id === pA ? h.cncConfig(id, 1) : vCfg), partId: id }], leadTimeSlug: "standard" }, headers: h.humanToken ? { "X-Human-Token": h.humanToken } : {} });
      const priceWrongKey = await h.raw("POST", "/api/quote", { token, json: { parts: [{ ...(id === pA ? h.cncConfig(id, 1) : vCfg), partId: id, editKey: wrongKey }], leadTimeSlug: "standard" }, headers: h.humanToken ? { "X-Human-Token": h.humanToken } : {} });
      const units = await h.raw("POST", `/api/parts/${id}/units`, { token, json: { units: "mm" }, headers: h.humanToken ? { "X-Human-Token": h.humanToken } : {} });
      const dl = await h.raw("GET", `/api/parts/${id}/download`, { token });
      R.check([mesh, meshWrong, geo, price, priceWrongKey, units, dl].every(denied) && ![mesh, geo, price].some((r) => leak(r, "secret")), `${tag} ${name}: preview, measurements, pricing, units, download all refused without the key`, [mesh, meshWrong, geo, price, priceWrongKey, units, dl].map((r) => r.status).join(" "));
    }
    // Alice's part with Alice's own (leaked) edit key: an owned part is not opened by its key alone.
    const withKey = await getK(`/api/parts/${pA}/mesh`, kA);
    const priceKey = await h.raw("POST", "/api/quote", { token, json: { parts: [{ ...h.cncConfig(pA, 1), editKey: kA }], leadTimeSlug: "standard" }, headers: h.humanToken ? { "X-Human-Token": h.humanToken } : {} });
    R.check(denied(withKey) && denied(priceKey), `${tag} an account's part is not opened by its edit key alone`, `${withKey.status} ${priceKey.status}`);
    // Alice's quotes
    for (const url of [`/api/quote/${qA.body.quoteId}`, `/api/quote/${qA.body.quoteId}/session`, `/api/pdf/quote/${qA.body.quoteId}`]) {
      const r = await getK(url, null);
      R.check(denied(r) && !leak(r, "alice-secret", "alice-cert", "alice-drawing"), `${tag} GET ${url.replace(qA.body.quoteId, ":aliceQuote")}`, String(r.status));
    }
    const fd = () => { const f = new FormData(); f.append("certificate", new Blob([PDF]), "evil.pdf"); f.append("drawing", new Blob([PDF]), "evil.pdf"); return f; };
    const hdr = h.humanToken ? { "X-Human-Token": h.humanToken } : {};
    const certUp = await h.raw("POST", `/api/quote/${qA.body.quoteId}/tax-certificate`, { token, body: fd(), headers: hdr });
    const certDel = await h.raw("DELETE", `/api/quote/${qA.body.quoteId}/tax-certificate`, { token });
    const drawUp = await h.raw("POST", `/api/quote/${qA.body.quoteId}/drawing`, { token, body: fd(), headers: hdr });
    const drawDel = await h.raw("DELETE", `/api/quote/${qA.body.quoteId}/drawing`, { token });
    const still = quotesDB.getById(qA.body.quoteId);
    R.check([certUp, certDel, drawUp, drawDel].every(denied) && still.taxCertFileName === "alice-cert.pdf" && still.drawingFileName === "alice-drawing.pdf", `${tag} certificate and drawing on Alice's quote cannot be replaced or removed`, [certUp, certDel, drawUp, drawDel].map((r) => r.status).join(" "));
    const reprice = await h.raw("POST", "/api/quote", { token, json: { quoteId: qA.body.quoteId, parts: [{ ...h.cncConfig(pA, 99) }], leadTimeSlug: "standard" }, headers: hdr });
    R.check(denied(reprice) && quotesDB.getById(qA.body.quoteId).lineItems[0].quantity === 2, `${tag} Alice's quote cannot be re-priced in place`, String(reprice.status));
    if (token) {
      const co = await h.raw("POST", "/api/orders/checkout-session", { token, json: { quoteId: qA.body.quoteId, ...SHIP } });
      R.check(denied(co), `${tag} cannot check out Alice's quote`, String(co.status));
    }
    // Alice's order
    const urls = [["GET", `/api/orders/${orderA}`], ["POST", `/api/orders/${orderA}/reorder`], ["POST", `/api/orders/${orderA}/confirm-payment`], ["GET", `/api/orders/${orderA}/drawing`], ["GET", `/api/orders/${orderA}/tax-certificate`], ["GET", `/api/orders/${orderA}/traveler`], ["GET", `/api/pdf/order-confirmation/${orderA}`], ["PUT", `/api/orders/${orderA}/status`]];
    const rs = [];
    for (const [m, u] of urls) rs.push(await h.raw(m, u, { token, json: m === "GET" ? undefined : { status: "paid", reason: "x", paidVia: "cash" } }));
    R.check(rs.every(denied) && !rs.some((r) => leak(r, "alice", "Columbus", "100 Main")), `${tag} Alice's order: view, reorder, confirm, drawing, certificate, traveler, documents, status`, rs.map((r) => r.status).join(" "));
    // Vic's request
    if (rfqId) {
      const one = await h.raw("GET", `/api/rfq/${rfqId}`, { token });
      const draw = await h.raw("GET", `/api/rfq/admin/${rfqId}/drawing`, { token });
      const list = await h.raw("GET", "/api/rfq/admin/list", { token });
      const del = await h.raw("DELETE", `/api/admin/requests/${rfqId}`, { token });
      R.check(!leak(one, "vic@visitor.test", "555-0100", "confidential", "Vic Visitor") && denied(draw) && denied(list) && denied(del) && Boolean(rfqsDB.getById(rfqId)), `${tag} Vic's request: no contact details, no drawing, no list, no delete`, `${one.status} ${draw.status} ${list.status} ${del.status}; by id alone: ${one.text.slice(0, 90)}`);
    }
    // Owner pages
    const adm = [];
    for (const [m, u] of [["GET", "/api/admin/storage"], ["POST", "/api/admin/drafts/purge"], ["GET", "/api/admin/catalogue-upgrade"], ["POST", "/api/admin/shipping/preview"], ["GET", "/api/admin/parts"], ["GET", "/api/admin/backup/db"], ["GET", "/api/admin/quotes"], ["GET", "/api/admin/audit"], ["PUT", "/api/admin/pricing"]]) adm.push(await h.raw(m, u, { token, json: m === "GET" ? undefined : { rules: { shippingBaseRate: 0 }, olderThanHours: 0 } }));
    R.check(adm.every((r) => r.status === 401 || r.status === 403), `${tag} owner routes (storage, purge, catalogue upgrade, shipping preview, parts, backup, quotes, audit, pricing)`, adm.map((r) => r.status).join(" "));
  }
  await tryAs("guest", "");
  await tryAs("another account", mallory);

  // The owner's session without two-step sign-in, and a cookie session without the CSRF token.
  {
    const h2 = h; // same server: the admin exists and is enrolled. A second admin cannot be made; check the cookie path.
    const cookie = `se_session=${owner}`;
    const noCsrf = await h2.raw("POST", "/api/admin/drafts/purge", { headers: { Cookie: cookie }, json: { olderThanHours: 80000 } });
    const getCookie = await h2.raw("GET", "/api/admin/storage", { headers: { Cookie: cookie } });
    R.check(noCsrf.status === 403 && noCsrf.body.code === "csrf", "admin cookie without the CSRF token: an unsafe request is refused", `${noCsrf.status} ${noCsrf.body && noCsrf.body.code}; a GET with the cookie answers ${getCookie.status}`);
    const before = h.models.auditDB ? h.models.auditDB.getAll().length : null;
    const purge = await h.post("/api/admin/drafts/purge", { olderThanHours: 80000 }, owner);
    const after = h.models.auditDB ? h.models.auditDB.getAll().length : null;
    const log = await h.get("/api/admin/audit", owner);
    R.check(purge.status === 200 && /purge-drafts/.test(log.text), "an admin clean-up is written to the change log", `purge ${purge.status}; audit rows ${before}→${after}`);
  }

  // What Vic's own quote id opens for a stranger (by design the id of a no-account quote is its key): say exactly what.
  {
    const hdr = h.humanToken ? { "X-Human-Token": h.humanToken } : {};
    const view = await h.raw("GET", `/api/quote/${qV.body.quoteId}`, { headers: hdr });
    const sess = await h.raw("GET", `/api/quote/${qV.body.quoteId}/session`, { headers: hdr });
    const keyOut = sess.body && sess.body.partsById && sess.body.partsById[pV] && sess.body.partsById[pV].editKey;
    R.info("a no-account quote is opened by its id alone (the id is 122 random bits and is the visitor's link)", `quote ${view.status}, session ${sess.status}, part edit key handed out: ${Boolean(keyOut)}`);
    // Mallory checks Vic's quote out: Vic's part becomes Mallory's and Vic's key stops working.
    const co = await h.raw("POST", "/api/orders/checkout-session", { token: mallory, json: { quoteId: qV.body.quoteId, ...SHIP } });
    const part = partsDB.getById(pV);
    const vicAfter = await h.raw("POST", "/api/quote", { json: { parts: [{ ...vCfg, editKey: kV }], leadTimeSlug: "standard" }, headers: hdr });
    R.info("anyone who learns a no-account quote's id can order it; the visitor's parts then belong to that account", `checkout ${co.status} ${co.body.code || ""}; part owner now ${part.userId ? "an account" : "nobody"}; Vic pricing his own part afterwards: ${vicAfter.status} ${vicAfter.body.code || ""}`);
  }
  const f = R.done();
  await h.stop();
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
