/**
 * The admin catalog and its change log (payments review 2026-11-11: F-13, F-14, F-15).
 * Run: node server/routes/adminCatalog.test.js
 *
 * Before: a material saved with a blank price was stored and priced at a figure built into the
 * code; the multiplier on the Lead Times tab was saved, shown and never used; and nothing but the
 * rate card recorded who had changed what.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const { boxStl } = require("../testSupport/shapes");

const { test, run } = runner("Admin catalog, lead-time multiplier and change log");
const SHIP = { shippingName: "Pat", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

(async () => {
  const h = await start({ mailer: "configured" });
  const { materialsDB, finishesDB, leadTimesDB, adminAuditDB, ordersDB } = h.models;
  const api = require("./api");
  let owner, buyer, part;
  const quote = (leadTimeSlug = "standard", token = buyer) => h.post("/api/quote", { parts: [{ partId: part, materialSlug: "cnc-delrin", process: "cnc", quantity: 4 }], leadTimeSlug }, token);
  const log = (area) => adminAuditDB.getAll().filter((e) => !area || e.area === area);

  test("setup", async () => {
    owner = await h.admin();
    buyer = await h.register("pat@buyer.test", "Pat");
    const up = await h.form("/api/upload", {}, { files: { name: "p.stl", data: boxStl(30) } }, buyer);
    part = up.body.parts[0].partId;
  });

  test("F-13: a material cannot be saved with a blank, zero, negative or non-numeric price — on create, on edit, or when switched on", async () => {
    const delrin = materialsDB.getAll().find((m) => m.slug === "cnc-delrin");
    const before = (await quote()).body.orderTotal;
    for (const pricePerKg of ["", null, 0, "0", -4, "abc", "  "]) {
      const r = await h.put(`/api/admin/materials/${delrin.id}`, { pricePerKg }, owner);
      assert.strictEqual(r.status, 400, `pricePerKg ${JSON.stringify(pricePerKg)} → ${r.status} ${r.text.slice(0, 120)}`);
    }
    assert.strictEqual(materialsDB.getById(delrin.id).pricePerKg, delrin.pricePerKg, "nothing was stored");
    assert.strictEqual((await quote()).body.orderTotal, before, "and the price of a part in it has not moved");
    // A printed material is sold by the cm³.
    const pla = materialsDB.getAll().find((m) => m.slug === "fdm-pla");
    for (const pricePerCm3 of ["", 0, null]) assert.strictEqual((await h.put(`/api/admin/materials/${pla.id}`, { pricePerCm3 }, owner)).status, 400);
    assert.strictEqual((await h.put(`/api/admin/materials/${pla.id}`, { pricePerKg: "" }, owner)).status, 200, "a blank in a field its process does not use is fine");
    // A record that has no usable price (from before this rule) cannot be switched on, or edited at all, until it has one.
    const stray = materialsDB.insert({ name: "Stray", slug: "stray-cnc", process: "cnc", active: false, pricePerKg: null });
    assert.deepStrictEqual([(await h.put(`/api/admin/materials/${stray.id}`, { active: true }, owner)).status, materialsDB.getById(stray.id).active], [400, false]);
    assert.strictEqual((await h.put(`/api/admin/materials/${stray.id}`, { active: true, pricePerKg: 12 }, owner)).status, 200);
    materialsDB.delete(stray.id);
    // A real change still saves, and is priced from.
    assert.strictEqual((await h.put(`/api/admin/materials/${delrin.id}`, { pricePerKg: delrin.pricePerKg * 2 }, owner)).status, 200);
    assert.ok((await quote()).body.orderTotal > before);
    assert.strictEqual((await h.put(`/api/admin/materials/${delrin.id}`, { pricePerKg: delrin.pricePerKg }, owner)).status, 200);
    assert.strictEqual((await quote()).body.orderTotal, before);
    // Finishes and lead times: a blank, negative or non-numeric figure is refused (a finish may cost nothing — "as machined" does).
    const deburr = finishesDB.getAll().find((f) => f.slug === "cnc-deburr");
    for (const pricePerPart of ["", null, -1, "abc"]) assert.strictEqual((await h.put(`/api/admin/finishes/${deburr.id}`, { pricePerPart }, owner)).status, 400, `finish ${JSON.stringify(pricePerPart)}`);
    assert.strictEqual(finishesDB.getById(deburr.id).pricePerPart, deburr.pricePerPart);
    const expedited = leadTimesDB.getAll().find((l) => l.slug === "expedited");
    for (const multiplier of ["", null, 0, 0.5, -2, "abc"]) assert.strictEqual((await h.put(`/api/admin/lead-times/${expedited.id}`, { multiplier }, owner)).status, 400, `multiplier ${JSON.stringify(multiplier)}`);
    assert.strictEqual(leadTimesDB.getById(expedited.id).multiplier, 1.35);
  });

  test("F-14: one multiplier per lead time — the Lead Times tab shows what is charged, and an edit there changes what is charged", async () => {
    const expedited = leadTimesDB.getAll().find((l) => l.slug === "expedited");
    const charged = async () => { const q = (await quote("expedited")).body; return Math.round((q.leadTimeSurcharge / q.subtotal + 1) * 1000) / 1000; };
    // Today: 1.35 on the tab, 1.35 on the rate card, 1.35 charged.
    assert.deepStrictEqual([expedited.multiplier, api.loadPricingRules().rushMultipliers.expedited, await charged()], [1.35, 1.35, 1.35]);
    // The owner sets 2× on the Lead Times tab. It used to be saved, shown, and ignored (quotes kept charging 1.35×).
    const saved = await h.put(`/api/admin/lead-times/${expedited.id}`, { multiplier: 2 }, owner);
    assert.strictEqual(saved.status, 200, saved.text);
    assert.strictEqual(saved.body.multiplier, 2);
    assert.deepStrictEqual([(await h.get("/api/admin/lead-times", owner)).body.find((l) => l.slug === "expedited").multiplier, (await h.get("/api/admin/pricing", owner)).body.rushMultipliers.expedited, await charged()], [2, 2, 2], "tab, rate card and charge agree");
    // The other way round: the rate card is edited, and the tab follows.
    assert.strictEqual((await h.put("/api/admin/pricing", { rules: { rushMultipliers: { standard: 1, expedited: 1.5, rush: 1.85, "same-day": 2.5 } }, note: "test" }, owner)).status, 200);
    assert.deepStrictEqual([(await h.get("/api/admin/lead-times", owner)).body.find((l) => l.slug === "expedited").multiplier, await charged()], [1.5, 1.5]);
    // A value the rate card would refuse is refused on the tab too, and nothing moves.
    assert.strictEqual((await h.put(`/api/admin/lead-times/${expedited.id}`, { multiplier: 7 }, owner)).status, 400);
    assert.deepStrictEqual([leadTimesDB.getById(expedited.id).multiplier, await charged()], [1.5, 1.5]);
    // The migration: a database where the tab shows a number that was never charged (the old state)
    // is brought into step with what IS charged at the next start — the charge does not move.
    assert.strictEqual((await h.post("/api/admin/pricing/reset", { note: "test: defaults" }, owner)).status, 200);
    leadTimesDB.update(expedited.id, { multiplier: 2 }); // shown as 2× by the old admin screen; charged 1.35×
    const before = await quote("expedited");
    api.loadPricingRules(); // what startup does
    assert.strictEqual(leadTimesDB.getById(expedited.id).multiplier, 1.35, "the displayed number now equals the charged number");
    const after = await quote("expedited");
    assert.strictEqual(after.body.orderTotal, before.body.orderTotal, "and what a customer is charged did not change");
    assert.strictEqual(await charged(), 1.35);
    // Other fields of a lead time still save on their own.
    assert.strictEqual((await h.put(`/api/admin/lead-times/${expedited.id}`, { days: "3-5 business days" }, owner)).status, 200);
    assert.strictEqual(await charged(), 1.35);
  });

  test("F-15: the admin change log — who changed what and when, for materials, finishes, lead times, the rate card, voided quotes and order status; append-only; nothing secret or typed by a customer", async () => {
    const start = log().length;
    const delrin = materialsDB.getAll().find((m) => m.slug === "cnc-delrin");
    const anodize = finishesDB.getAll().find((f) => f.slug === "cnc-anodize-clear");
    const expedited = leadTimesDB.getAll().find((l) => l.slug === "expedited");
    await h.put(`/api/admin/materials/${delrin.id}`, { pricePerKg: 12.5, description: "x".repeat(400) }, owner);
    await h.put(`/api/admin/materials/${delrin.id}`, { pricePerKg: 12.5 }, owner); // no change: no entry
    await h.put(`/api/admin/finishes/${anodize.id}`, { pricePerPart: 0 }, owner);
    await h.put(`/api/admin/lead-times/${expedited.id}`, { multiplier: 1.4 }, owner);
    await h.put("/api/admin/pricing", { rules: { marginPercent: 0.52 }, note: "the reason, in the owner's words" }, owner);
    const made = await h.post("/api/admin/materials", { name: "Test", slug: "test-mat", process: "cnc", pricePerKg: 3 }, owner);
    await h.del(`/api/admin/materials/${made.body.id}`, owner);
    const q = await quote();
    const co = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP, shippingName: "Customer Name Here" }, buyer);
    assert.strictEqual(co.status, 200, co.text);
    assert.strictEqual((await h.put(`/api/orders/${co.body.orderId}/status`, { status: "paid", notes: "customer said: call me on 555-0100" }, owner)).status, 200);
    assert.strictEqual((await h.put(`/api/orders/${co.body.orderId}/status`, { status: "shipped", trackingNumber: "1Z999", carrier: "UPS" }, owner)).status, 200);
    await h.post("/api/admin/quotes/void-open", { note: "after the margin change" }, owner);

    const entries = log().slice(start);
    const find = (area, action) => entries.filter((e) => e.area === area && e.action === action);
    assert.deepStrictEqual(find("material", "update").map((e) => [e.target, e.changes.pricePerKg]), [["cnc-delrin", [11, 12.5]]], "one entry for the real change, none for the no-op");
    assert.deepStrictEqual(find("finish", "update")[0].changes, { pricePerPart: [8, 0] }, "anodize set to $0 is on record");
    assert.deepStrictEqual(find("lead-time", "update")[0].changes, { multiplier: [1.35, 1.4] });
    assert.ok(find("rate-card", "save").some((e) => /marginPercent/.test(e.changes.rules[1])));
    assert.ok(find("rate-card", "save").some((e) => /rushMultipliers/.test(e.changes.rules[1])), "the multiplier edit is a rate-card change too");
    assert.deepStrictEqual([find("material", "create").length, find("material", "delete").length], [1, 1]);
    assert.deepStrictEqual(find("order", "status").map((e) => e.changes.status), [["pending_payment", "paid"], ["paid", "shipped"]], "an order marked paid by hand is on record");
    assert.deepStrictEqual(find("order", "status")[1].changes.tracking, [null, "set"]);
    assert.strictEqual(find("quotes", "void-open").length, 1);
    for (const e of entries) {
      assert.strictEqual(e.userEmail, process.env.ADMIN_EMAIL, "who");
      assert.ok(!Number.isNaN(new Date(e.createdAt).getTime()), "when");
    }
    const all = JSON.stringify(entries);
    for (const secret of ["555-0100", "Customer Name Here", "1Z999", h.adminPassword, "x".repeat(100), "password", "totp", "the reason, in the owner's words"]) assert.ok(!all.includes(secret), `the log carries ${secret.slice(0, 20)}`);
    // Shown in the admin; nobody else reads it; nothing edits or removes a line.
    const shown = await h.get("/api/admin/audit", owner);
    assert.strictEqual(shown.status, 200);
    assert.ok(shown.body.length >= entries.length && shown.body[0].createdAt >= shown.body[shown.body.length - 1].createdAt, "newest first");
    assert.deepStrictEqual(Object.keys(shown.body[0]).sort(), ["action", "area", "changes", "createdAt", "id", "target", "userEmail"]);
    assert.strictEqual((await h.get("/api/admin/audit", buyer)).status, 403);
    assert.strictEqual((await h.raw("GET", "/api/admin/audit", {})).status, 401);
    const count = log().length;
    for (const [method, url] of [["DELETE", "/api/admin/audit"], ["PUT", "/api/admin/audit"], ["POST", "/api/admin/audit"], ["DELETE", `/api/admin/audit/${entries[0].id}`], ["PUT", `/api/admin/audit/${entries[0].id}`]]) {
      assert.strictEqual((await h.raw(method, url, { json: {}, token: owner })).status, 404, `${method} ${url}`);
    }
    assert.strictEqual(log().length, count);
    assert.deepStrictEqual(Object.keys(require("../services/adminAudit")).sort(), ["diff", "list", "record"], "the module can only add and read");
    assert.strictEqual(ordersDB.getById(co.body.orderId).status, "shipped");
    await h.post("/api/admin/pricing/reset", { note: "test: defaults" }, owner);
  });

  await run(() => h.stop());
})();
