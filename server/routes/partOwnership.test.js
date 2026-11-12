/**
 * Parts belong to whoever uploaded them (independent review 2026-11-11, F5).
 * Run: node server/routes/partOwnership.test.js
 *
 * Before: any signed-in user who learned a part id could put that part in a quote of their own,
 * read its measurements, file name and preview, be handed its edit key, and change its units.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const { boxStl, rectDxf } = require("../testSupport/shapes");

const { test, run } = runner("Part ownership (F5)");
const SHIP = { shippingName: "A", shippingAddress: "1 A St", shippingCity: "C", shippingState: "IL", shippingZip: "60000" };

(async () => {
  const h = await start({ mailer: "configured" });
  const { partsDB, quotesDB, usersDB } = h.models;
  const tokens = require("../security/tokens");
  const idOf = (email) => usersDB.getAll().find((u) => u.email === email).id;
  const human = () => ({ "X-Human-Token": h.humanToken });
  // Exactly what is given, nothing added (no edit key unless the test puts one in).
  const price = (parts, token, extra = {}) => h.raw("POST", "/api/quote", { json: { parts, leadTimeSlug: "standard", ...extra }, token, headers: human() });
  const upload = async (name, data, token, fields = {}) => {
    const r = await h.form("/api/upload", fields, { files: { name, data } }, token);
    assert.strictEqual(r.status, 200, r.text);
    return r.body.parts[0];
  };
  const cnc = (partId, over = {}) => ({ partId, materialSlug: "cnc-delrin", process: "cnc", quantity: 2, ...over });
  const routed = (partId, over = {}) => ({ partId, materialSlug: "rt-hdpe", process: "routing", thicknessMm: 6.35, quantity: 1, ...over });
  const units = (partId, value, { token, key } = {}) => h.raw("POST", `/api/parts/${partId}/units`, { json: { units: value }, token, headers: { ...human(), ...(key ? { "X-Part-Key": key } : {}) } });
  const notFound = (r, what) => { assert.deepStrictEqual([r.status, r.body.code], [400, "part-not-found"], `${what}: ${r.text.slice(0, 160)}`); assert.ok(!/a\.stl|a\.dxf|positions|boundingBox/.test(r.text), `${what}: nothing about the part comes back`); };

  let owner, alice, bob, aPart, aDxf;
  test("setup: the admin, Alice (who uploads a model and a drawing while signed in) and Bob", async () => {
    owner = await h.admin();
    alice = await h.register("alice@buyer.test", "Alice");
    bob = await h.register("bob@buyer.test", "Bob");
    aPart = await upload("a.stl", boxStl([60, 40, 20]), alice);
    aDxf = await upload("a.dxf", rectDxf(40, 30, 4), alice, { process: "routing" });
    assert.strictEqual(partsDB.getById(aPart.partId).userId, idOf("alice@buyer.test"), "an upload made while signed in belongs to that account");
    assert.ok(aPart.editKey && aDxf.editKey);
  });

  test("another account, or a guest, cannot price Alice's part — with its id alone or with its edit key — and the answer is the same as for a part that does not exist", async () => {
    const missing = await price([cnc("00000000-0000-4000-8000-000000000000")], bob);
    notFound(missing, "a part that does not exist");
    for (const [who, token] of [["Bob", bob], ["a guest", undefined]]) {
      const byId = await price([cnc(aPart.partId)], token);
      notFound(byId, `${who}, id alone`);
      assert.deepStrictEqual(byId.body.error, missing.body.error);
      notFound(await price([cnc(aPart.partId, { editKey: aPart.editKey })], token), `${who}, with Alice's edit key`);
      notFound(await price([cnc(aPart.partId, { editKey: tokens.partEditKey(aPart.partId) })], token), `${who}, with a correctly computed key`);
      notFound(await price([routed(aDxf.partId, { editKey: aDxf.editKey })], token), `${who}, the drawing`);
      // …nor in a quote alongside a part of their own.
      const own = await upload("own.stl", boxStl(20), token);
      notFound(await price([cnc(own.partId, { editKey: own.editKey }), cnc(aPart.partId, { editKey: aPart.editKey })], token), `${who}, mixed with their own part`);
      // …nor change its units, with or without the key.
      for (const key of [undefined, aDxf.editKey]) assert.strictEqual((await units(aDxf.partId, "in", { token, key })).status, 404, `${who} changing the units`);
    }
    assert.strictEqual(partsDB.getById(aDxf.partId).geometry.boundingBox.width, 40, "the drawing is the size Alice uploaded");
    assert.strictEqual(quotesDB.getAll().filter((q) => (q.config?.parts || []).some((p) => p.partId === aPart.partId || p.partId === aDxf.partId)).length, 0, "no quote holds her parts");
    // Alice herself needs no key: the account is the proof.
    const hers = await price([cnc(aPart.partId), routed(aDxf.partId)], alice);
    assert.strictEqual(hers.status, 200, hers.text);
    assert.strictEqual((await units(aDxf.partId, "mm", { token: alice, key: aDxf.editKey })).status, 200);
    // And the admin can price a customer's part (a phone order) without it becoming the admin's.
    assert.strictEqual((await price([cnc(aPart.partId)], owner)).status, 200);
    assert.strictEqual(partsDB.getById(aPart.partId).userId, idOf("alice@buyer.test"));
  });

  test("a quote never hands out a part its reader may not use: geometry, file name, preview and edit key stay with the owner", async () => {
    const hers = await price([cnc(aPart.partId), routed(aDxf.partId)], alice);
    const mine = await h.get(`/api/quote/${hers.body.quoteId}/session`, alice);
    assert.deepStrictEqual(mine.body.parts.map((p) => [p.partId, p.fileName, Boolean(p.editKey), Boolean(p.geometry)]), [[aPart.partId, "a.stl", true, true], [aDxf.partId, "a.dxf", true, true]]);
    for (const token of [bob, undefined]) {
      assert.strictEqual((await h.raw("GET", `/api/quote/${hers.body.quoteId}/session`, { token })).status, 404);
      assert.strictEqual((await h.raw("GET", `/api/quote/${hers.body.quoteId}`, { token })).status, 404);
    }
    // A quote of Bob's that somehow names Alice's part (a row from before this rule): the part is left out of what Bob gets.
    const bobPart = await upload("b.stl", boxStl(20), bob);
    const own = await price([cnc(bobPart.partId)], bob);
    const row = quotesDB.getById(own.body.quoteId);
    quotesDB.update(row.id, { config: { ...row.config, parts: [...row.config.parts, cnc(aPart.partId), routed(aDxf.partId)] } });
    const leaked = await h.get(`/api/quote/${row.id}/session`, bob);
    assert.strictEqual(leaked.status, 200);
    assert.deepStrictEqual(leaked.body.parts.map((p) => p.partId), [bobPart.partId], "only Bob's own part");
    assert.ok(!leaked.text.includes("a.stl") && !leaked.text.includes("a.dxf") && !leaked.text.includes(aPart.editKey) && !leaked.text.includes(aDxf.editKey));
    // …and it cannot be checked out or priced again with her parts in it.
    const co = await h.post("/api/orders/checkout-session", { quoteId: row.id, ...SHIP }, bob);
    assert.deepStrictEqual([co.status, co.body.code, co.body.reason], [409, "quote-needs-update", "part-not-found"], co.text);
    assert.strictEqual((await h.raw("GET", `/api/parts/${aPart.partId}/download`, { token: bob })).status, 403, "the file itself is the admin's to download, as before");
  });

  let gPart, gDxf, guestQuote;
  test("a visitor without an account holds their parts by the edit key the upload gave their browser: no key, no part", async () => {
    gPart = await upload("g.stl", boxStl([50, 30, 10]));
    gDxf = await upload("g.dxf", rectDxf(60, 40, 4), undefined, { process: "routing" });
    assert.strictEqual(partsDB.getById(gPart.partId).userId, null);
    notFound(await price([cnc(gPart.partId)]), "the visitor's own part without its key");
    notFound(await price([cnc(gPart.partId, { editKey: aPart.editKey })]), "with another part's key");
    notFound(await price([cnc(gPart.partId, { editKey: "x".repeat(40) })], bob), "an account guessing a key");
    notFound(await price([cnc(gPart.partId)], bob), "an account with the id alone");
    const ok = await price([cnc(gPart.partId, { editKey: gPart.editKey }), routed(gDxf.partId, { editKey: gDxf.editKey })]);
    assert.strictEqual(ok.status, 200, ok.text);
    guestQuote = ok.body.quoteId;
    const stored = quotesDB.getById(guestQuote);
    assert.ok(!JSON.stringify(stored).includes(gPart.editKey), "the key is never stored with the quote");
    assert.strictEqual(stored.userId, null);
    // Reloading the page: the quote (whose id is the visitor's credential) gives the parts and their keys back.
    const reopened = await h.raw("GET", `/api/quote/${guestQuote}/session`, {});
    assert.deepStrictEqual(reopened.body.parts.map((p) => [p.partId, p.editKey]), [[gPart.partId, gPart.editKey], [gDxf.partId, gDxf.editKey]]);
    assert.strictEqual((await units(gDxf.partId, "in")).status, 404, "units: not without the key");
    assert.strictEqual((await units(gDxf.partId, "in", { key: gDxf.editKey })).status, 200);
    assert.strictEqual((await units(gDxf.partId, "mm", { key: gDxf.editKey })).status, 200);
  });

  test("hand-over: when that visitor registers and carries on, the parts and the draft quote become the account's — and the key alone stops working", async () => {
    const carol = await h.register("carol@buyer.test", "Carol");
    // The page reopens the quote after the sign-in detour and prices it again, sending the keys it holds.
    const session = await h.raw("GET", `/api/quote/${guestQuote}/session`, { token: carol });
    const configs = session.body.parts.map(({ partId, materialSlug, process, quantity, thicknessMm, editKey }) => ({ partId, materialSlug, process, quantity, thicknessMm, editKey }));
    const again = await price(configs, carol, { quoteId: guestQuote });
    assert.strictEqual(again.status, 200, again.text);
    assert.strictEqual(again.body.quoteId, guestQuote, "the same draft quote");
    const carolId = idOf("carol@buyer.test");
    assert.strictEqual(quotesDB.getById(guestQuote).userId, carolId, "the draft quote is Carol's");
    assert.deepStrictEqual([partsDB.getById(gPart.partId).userId, partsDB.getById(gDxf.partId).userId], [carolId, carolId], "and so are the parts");
    // From here the account is the proof, and the key by itself opens nothing.
    assert.strictEqual((await price([cnc(gPart.partId)], carol)).status, 200, "Carol, without the key");
    notFound(await price([cnc(gPart.partId, { editKey: gPart.editKey })]), "a guest holding the old key");
    notFound(await price([cnc(gPart.partId, { editKey: gPart.editKey })], bob), "Bob holding the old key");
    assert.strictEqual((await units(gDxf.partId, "in", { key: gDxf.editKey })).status, 404);
    assert.strictEqual((await units(gDxf.partId, "in", { token: bob, key: gDxf.editKey })).status, 404);
    assert.strictEqual((await h.raw("GET", `/api/quote/${guestQuote}/session`, {})).status, 404, "the quote is no longer readable by its id alone");
    // Carol checks out; reorder later needs no key either.
    const co = await h.post("/api/orders/checkout-session", { quoteId: guestQuote, ...SHIP }, carol);
    assert.strictEqual(co.status, 200, co.text);
    // (relaunch merge, re-review RR-14) Reorder is for an order that was paid for: before payment it is refused,
    // whoever asks. What this case holds is that the reorder of Carol's order needs no part key, so pay it first.
    assert.strictEqual((await h.post(`/api/orders/${co.body.orderId}/reorder`, {}, carol)).body.code, "reorder-not-available");
    assert.strictEqual((await h.completed(h.models.ordersDB.getById(co.body.orderId).stripeSessionId)).status, 200);
    const re = await h.post(`/api/orders/${co.body.orderId}/reorder`, {}, carol);
    assert.strictEqual(re.status, 201, re.text);
    assert.strictEqual((await h.post(`/api/orders/${co.body.orderId}/reorder`, {}, bob)).status, 403);
  });

  test("hand-over at checkout: a visitor who signs in only at the pay step — the parts of the quote they buy become theirs", async () => {
    const p = await upload("late.stl", boxStl(22));
    const q = await price([cnc(p.partId, { editKey: p.editKey })]);
    const dave = await h.register("dave@buyer.test", "Dave");
    const co = await h.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, dave);
    assert.strictEqual(co.status, 200, co.text);
    const daveId = idOf("dave@buyer.test");
    assert.strictEqual(partsDB.getById(p.partId).userId, daveId);
    assert.strictEqual(quotesDB.getById(q.body.quoteId).userId, daveId);
    notFound(await price([cnc(p.partId, { editKey: p.editKey })], bob), "Bob, after the hand-over");
  });

  await run(() => h.stop());
})();
