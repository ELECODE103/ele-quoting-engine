/**
 * A units change does not price the sender's saved quotes inside the request (re-review 2026-11-12, F-13).
 * Run: node server/routes/unitsRefresh.test.js
 *
 * Before: the units route priced every draft that held the part, in one step, before it answered:
 * 25 drafts of 100 lines stopped the site for 0.6 to 0.75 s per change, and the change could be
 * repeated back and forth with nothing but the general request limit in the way. Each case below
 * fails on that code.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const { rectDxf } = require("../testSupport/shapes");

const { test, run } = runner("Units change: saved quotes are priced afterwards, in pieces");
const SHIP = { shippingName: "Pat Buyer", shippingAddress: "1 Main St", shippingCity: "Springfield", shippingState: "IL", shippingZip: "62701" };

(async () => {
  for (const k of ["QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY", "QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY"]) process.env[k] = "100000";
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000";
  const h = await start({ mailer: "configured" });
  const { partsDB, quotesDB, materialsDB } = h.models;
  const api = require("./api");
  const pricingMemo = require("../services/pricingMemo");
  const material = materialsDB.getAll().find((m) => m.slug === "rt-acrylic");
  const thicknesses = material.thicknesses.map((t) => t.mm);
  let buyer, buyerId;

  /** A plate drawn in inches on `drafts` saved quotes of `lines` lines each, read as millimetres. */
  async function plateOnDrafts(name, drafts, lines) {
    const up = await h.form("/api/upload", {}, { files: { name, data: rectDxf(20, 20, 1) } }, buyer);
    assert.strictEqual(up.status, 200, up.text);
    const partId = up.body.parts[0].partId;
    const setUnits = (units) => h.post(`/api/parts/${partId}/units`, { units, editKey: h.editKeys[partId] }, buyer);
    assert.strictEqual((await setUnits("mm")).status, 200);
    await api.draftRefresh.idle();
    const ids = [];
    for (let d = 0; d < drafts; d++) {
      const parts = Array.from({ length: lines }, (_, k) => ({ partId, materialSlug: "rt-acrylic", grade: material.grades[0].name, finishSlug: "", quantity: 1 + ((d + k) % 4), process: "routing", thicknessMm: thicknesses[k % thicknesses.length] }));
      const q = await h.post("/api/quote", { parts, leadTimeSlug: "standard" }, buyer);
      assert.strictEqual(q.status, 200, q.text.slice(0, 200));
      ids.push(q.body.quoteId);
    }
    const totals = () => ids.map((id) => quotesDB.getById(id).orderTotal);
    return { partId, setUnits, ids, totals };
  }
  const fingerprints = (ids) => ids.map((id) => quotesDB.getById(id).config.integrity.fingerprint);
  const width = (partId) => Math.round(partsDB.getById(partId).geometry.boundingBox.width);

  test("setup", async () => {
    await h.admin("Owner");
    buyer = await h.register("flip@buyer.test");
    buyerId = h.models.usersDB.getAll().find((u) => u.email === "flip@buyer.test").id;
  });

  test("the units answer comes back before any saved quote is priced; they are then priced one at a time through the pricing runner, on the sender's allowance, and end at the new price", async () => {
    const p = await plateOnDrafts("six.dxf", 6, 12);
    const mmTotals = p.totals();
    const before = { fp: fingerprints(p.ids), stats: { ...api.draftRefresh.stats }, used: pricingMemo.usedMs(`user:${buyerId}`), jobs: pricingMemo.stats() };
    const r = await p.setUnits("in");
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(width(p.partId), 508, "the part itself is stored at its new size when the answer is sent");
    // Not one of them was priced inside the request.
    assert.deepStrictEqual(fingerprints(p.ids), before.fp, "no saved quote was priced inside the units request");
    assert.strictEqual(api.draftRefresh.stats.priced, before.stats.priced);
    const done = await api.draftRefresh.idle();
    assert.ok(Array.isArray(done));
    const inchTotals = p.totals();
    for (let i = 0; i < p.ids.length; i++) assert.ok(inchTotals[i] > mmTotals[i] * 1.5, `draft ${i}: ${mmTotals[i]} → ${inchTotals[i]}`);
    assert.strictEqual(api.draftRefresh.stats.priced - before.stats.priced, 6, "each of the six was priced once");
    assert.ok(pricingMemo.usedMs(`user:${buyerId}`) > before.used, "and the work was charged to the account that changed the units");
    for (const id of p.ids) assert.ok(!quotesDB.getById(id).config.integrity.stale);
  });

  test("checkout in the gap, before a saved quote has been priced again, is still refused with the new price: the fingerprint carries the part's revision", async () => {
    const p = await plateOnDrafts("gap.dxf", 3, 1);
    const mmTotals = p.totals();
    const r = await p.setUnits("in");
    assert.strictEqual(r.status, 200, r.text);
    // Straight away: the last of the three has certainly not been priced yet.
    const last = p.ids[p.ids.length - 1];
    const c = await h.post("/api/orders/checkout-session", { quoteId: last, confirmedTotal: mmTotals[mmTotals.length - 1], ...SHIP }, buyer);
    assert.deepStrictEqual([c.status, c.body.code], [409, "quote-changed"], c.text.slice(0, 200));
    assert.ok(c.body.newTotal > mmTotals[mmTotals.length - 1] + 1, `the price of the part read in inches: ${mmTotals[mmTotals.length - 1]} → ${c.body.newTotal}`);
    await api.draftRefresh.idle();
  });

  test("a firm-quote request in the gap is not made from the old price: it is refused with words, and goes through once the quote has been priced again", async () => {
    const p = await plateOnDrafts("request.dxf", 2, 3);
    const mmTotals = p.totals();
    const r = await p.setUnits("in");
    assert.strictEqual(r.status, 200, r.text);
    const last = p.ids[p.ids.length - 1];
    const early = await h.form("/api/rfq", { contactName: "Pat Buyer", email: "flip@buyer.test", quoteId: last, notes: "please quote" }, {}, buyer);
    assert.deepStrictEqual([early.status, early.body.code], [409, "quote-part-changed"], early.text.slice(0, 200));
    assert.ok(/Reopen the quote/.test(early.body.error) && /Nothing was sent/.test(early.body.error), early.body.error);
    assert.strictEqual(h.models.rfqsDB.query((x) => x.quoteId === last).length, 0, "no request exists");
    assert.strictEqual(quotesDB.getById(last).status, "draft");
    await api.draftRefresh.idle();
    const later = await h.form("/api/rfq", { contactName: "Pat Buyer", email: "flip@buyer.test", quoteId: last, notes: "please quote, again" }, {}, buyer);
    assert.strictEqual(later.status, 201, later.text.slice(0, 200));
    const rfq = h.models.rfqsDB.getById(later.body.rfqId);
    assert.ok(rfq.budgetTotal > mmTotals[mmTotals.length - 1] * 1.5, `the request carries the price of the part as stored: ${mmTotals[mmTotals.length - 1]} → ${rfq.budgetTotal}`);
  });

  test("a sender who has used the hour's pricing allowance gets the units change, and the saved quotes are only marked to be priced again: no pricing is done for them", async () => {
    // (One line each: read in inches, six lines of this plate pack to over 50 lb, which since F-03 is a firm
    // quote for its freight; this case is about the price, so the quotes are kept inside the parcel limits.)
    const p = await plateOnDrafts("spent.dxf", 4, 1);
    const mmTotals = p.totals();
    const prev = process.env.QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR;
    const usedBefore = pricingMemo.usedMs(`user:${buyerId}`);
    process.env.QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR = "1";
    pricingMemo.usage.add(`user:${buyerId}`, 1500);
    const before = { ...api.draftRefresh.stats };
    try {
      const r = await p.setUnits("in");
      assert.strictEqual(r.status, 200, r.text);
      await api.draftRefresh.idle();
    } finally { if (prev === undefined) delete process.env.QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR; else process.env.QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR = prev; }
    assert.strictEqual(api.draftRefresh.stats.priced, before.priced, "nothing was priced");
    assert.strictEqual(api.draftRefresh.stats.markedStale - before.markedStale, 4);
    assert.strictEqual(pricingMemo.usedMs(`user:${buyerId}`), usedBefore + 1500, "no pricing time was spent");
    assert.deepStrictEqual(p.totals(), mmTotals, "their stored totals are as they were");
    for (const id of p.ids) assert.strictEqual(quotesDB.getById(id).config.integrity.stale, true, "and each is marked");
    // Nothing can be ordered at the old price.
    const c = await h.post("/api/orders/checkout-session", { quoteId: p.ids[0], confirmedTotal: mmTotals[0], ...SHIP }, buyer);
    assert.deepStrictEqual([c.status, c.body.code], [409, "quote-changed"], c.text.slice(0, 200));
    pricingMemo.resetForTests();
  });

  test("units changed twice in a row: the first follow-up gives way to the second, and every saved quote ends at the price of the units the part ended with", async () => {
    const p = await plateOnDrafts("twice.dxf", 5, 8);
    const mmTotals = p.totals();
    const a = p.setUnits("in");
    const first = await a;
    assert.strictEqual(first.status, 200, first.text);
    const second = await p.setUnits("mm");
    assert.strictEqual(second.status, 200, second.text);
    await api.draftRefresh.idle();
    assert.strictEqual(width(p.partId), 20);
    const end = p.totals();
    for (let i = 0; i < p.ids.length; i++) {
      const q = quotesDB.getById(p.ids[i]);
      assert.ok(Math.abs(end[i] - mmTotals[i]) < 0.011 && !q.config.integrity.stale, `draft ${i}: ${mmTotals[i]} → ${end[i]}${q.config.integrity.stale ? " (stale)" : ""}`);
    }
  });

  test("more units changes in ten minutes than a person makes are refused with words, and the part is left as it was", async () => {
    const p = await plateOnDrafts("many.dxf", 1, 2);
    api.draftRefresh.resetForTests();
    const prev = process.env.UNITS_CHANGES_PER_CLIENT_10MIN;
    process.env.UNITS_CHANGES_PER_CLIENT_10MIN = "3";
    try {
      let units = "in";
      for (let i = 0; i < 3; i++) { const r = await p.setUnits(units); assert.strictEqual(r.status, 200, r.text); units = units === "in" ? "mm" : "in"; }
      const w = width(p.partId);
      const rev = partsDB.getRow(p.partId).geometryRev;
      const refused = await p.setUnits(units);
      assert.deepStrictEqual([refused.status, refused.body.code], [429, "units-rate-limited"], refused.text);
      assert.ok(/Wait a few minutes/.test(refused.body.error) && Number(refused.headers.get("retry-after")) > 0, refused.text);
      assert.strictEqual(width(p.partId), w);
      assert.strictEqual(partsDB.getRow(p.partId).geometryRev, rev, "nothing was read or stored for the refused change");
      // (Every call of this suite comes from its own address: it was the ACCOUNT that was counted.)
      // A visitor without an account is counted by address.
      api.draftRefresh.resetForTests();
      h.ip = "198.51.100.77";
      const up = await h.form("/api/upload", {}, { files: { name: "anon.dxf", data: rectDxf(20, 20, 1) } });
      assert.strictEqual(up.status, 200, up.text);
      const anonId = up.body.parts[0].partId;
      const anonUnits = (u) => h.post(`/api/parts/${anonId}/units`, { units: u, editKey: h.editKeys[anonId] });
      for (const u of ["mm", "in", "mm"]) assert.strictEqual((await anonUnits(u)).status, 200);
      const anonRefused = await anonUnits("in");
      assert.deepStrictEqual([anonRefused.status, anonRefused.body.code], [429, "units-rate-limited"], anonRefused.text);
      h.ip = "198.51.100.78";
      assert.strictEqual((await anonUnits("in")).status, 200, "another address is not held back by it");
    } finally {
      h.ip = ""; if (prev === undefined) delete process.env.UNITS_CHANGES_PER_CLIENT_10MIN; else process.env.UNITS_CHANGES_PER_CLIENT_10MIN = prev; api.draftRefresh.resetForTests(); }
    await api.draftRefresh.idle();
  });

  run(() => h.stop());
})();
