/**
 * A catalogue upgrade keeps the prices the owner changed by hand, and only those.
 * Run: `node server/config/seedCarry.test.js`
 *
 * The database is put back to how seed version 3 left it (origin/master's catalogue: the prices in
 * seedHistory.js), with a handful of prices changed the way the owner changes them, and the real
 * seed is run on it.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const history = require("./seedHistory");
const seedCarry = require("./seedCarry");
const defaults = require("./defaults");

const { test, run } = runner("Catalogue upgrade: prices changed by hand are carried over");

(async () => {
  const h = await start();
  const { materialsDB, finishesDB, pricingDB, adminAuditDB } = h.models;
  const { seedDatabase } = require("./seed");
  const bySlug = (db, slug) => db.getAll().find((r) => r.slug === slug) || null;
  const pricesOfRow = (kind, row) => Object.fromEntries(history.PRICE_FIELDS[kind].filter((f) => row[f] !== null && row[f] !== undefined).map((f) => [f, row[f]]));
  let owner;
  // A row of the current catalogue as a fresh database stores it (the harness has just seeded one).
  const asSeeded = Object.fromEntries(materialsDB.getAll().map((m) => [m.slug, JSON.parse(JSON.stringify(m))]));

  /** Make the catalogue what a version-3 database holds: version 3's slugs at version 3's default prices. */
  function backToVersion3() {
    const v3 = history.pricesOf(3);
    for (const m of materialsDB.getAll()) {
      if (!v3.materials[m.slug]) materialsDB.delete(m.id);
      else materialsDB.update(m.id, { pricePerKg: v3.materials[m.slug].pricePerKg ?? null, pricePerCm3: v3.materials[m.slug].pricePerCm3 ?? null });
    }
    for (const [slug, p] of Object.entries(v3.materials)) {
      if (!bySlug(materialsDB, slug)) materialsDB.insert({ slug, name: `Old ${slug}`, category: "SLA", process: "3d-printing", subProcess: "sla", density: 1.1, active: true, ...p });
    }
    for (const f of finishesDB.getAll()) finishesDB.update(f.id, { pricePerPart: v3.finishes[f.slug].pricePerPart ?? null, pricePerSqIn: v3.finishes[f.slug].pricePerSqIn ?? null });
    const rules = pricingDB.getAll()[0];
    pricingDB.update(rules.id, { rules: { ...rules.rules, seedVersion: 3 } });
  }
  /** Run the real seed, collecting what it prints. */
  function seedAgain() {
    const lines = [];
    const real = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try { seedDatabase(); } finally { console.log = real; }
    return lines;
  }

  test("the record of each version's prices: the current version's entry is the current catalogue (add an entry when SEED_VERSION goes up)", () => {
    const current = history.pricesOf(defaults.SEED_VERSION);
    assert.ok(current, `seedHistory.js has no entry for SEED_VERSION ${defaults.SEED_VERSION}: add the new catalogue's prices to it`);
    assert.deepStrictEqual(current.materials, Object.fromEntries(defaults.DEFAULT_MATERIALS.map((m) => [m.slug, pricesOfRow("material", m)])));
    assert.deepStrictEqual(current.finishes, Object.fromEntries(defaults.DEFAULT_FINISHES.map((f) => [f.slug, pricesOfRow("finish", f)])));
    assert.strictEqual(history.pricesOf(1), null, "version 1 is not on record");
    assert.ok(Object.keys(history.pricesOf(3).materials).length === 50 && history.pricesOf(3).materials["sla-tough"], "version 3 is origin/master's catalogue");
  });

  test("setup: the owner signs in", async () => { owner = await h.admin("Owner"); });

  let log;
  test("version 3 → current: an edited price is kept on its slug; an untouched one takes the new catalogue; a slug that is gone is not brought back", async () => {
    backToVersion3();
    // The owner's own figures, set the way the admin screens set them.
    materialsDB.update(bySlug(materialsDB, "cnc-delrin").id, { pricePerKg: 12.75 });        // material sold by weight (default 11)
    materialsDB.update(bySlug(materialsDB, "fdm-pla").id, { pricePerCm3: 0.065 });           // printed material (default 0.05)
    finishesDB.update(bySlug(finishesDB, "deburr").id, { pricePerPart: 3.25 });              // a finish (default 2.5); its price per sq in is left alone
    materialsDB.update(bySlug(materialsDB, "sla-tough").id, { pricePerCm3: 0.61 });          // a material the new catalogue no longer has
    materialsDB.insert({ slug: "cnc-house-blend", name: "House blend", category: "Plastic", process: "cnc", subProcess: "milling", pricePerKg: 19, active: true, grades: [] }); // added by hand
    const auditBefore = adminAuditDB.getAll().length;

    log = seedAgain();

    // Kept.
    assert.strictEqual(bySlug(materialsDB, "cnc-delrin").pricePerKg, 12.75);
    assert.strictEqual(bySlug(materialsDB, "fdm-pla").pricePerCm3, 0.065);
    assert.deepStrictEqual([bySlug(finishesDB, "deburr").pricePerPart, bySlug(finishesDB, "deburr").pricePerSqIn], [3.25, 0.005]);
    // Not brought back.
    assert.strictEqual(bySlug(materialsDB, "sla-tough"), null, "a material that left the catalogue stays gone");
    assert.strictEqual(bySlug(materialsDB, "cnc-house-blend"), null, "a row that was never in the catalogue is not carried");
    // Everything else is the new catalogue, row for row and price for price.
    assert.strictEqual(materialsDB.getAll().length, defaults.DEFAULT_MATERIALS.length);
    assert.strictEqual(finishesDB.getAll().length, defaults.DEFAULT_FINISHES.length);
    for (const m of defaults.DEFAULT_MATERIALS) {
      if (["cnc-delrin", "fdm-pla"].includes(m.slug)) continue;
      assert.deepStrictEqual(pricesOfRow("material", bySlug(materialsDB, m.slug)), pricesOfRow("material", m), m.slug);
    }
    for (const f of defaults.DEFAULT_FINISHES) if (f.slug !== "deburr") assert.deepStrictEqual(pricesOfRow("finish", bySlug(finishesDB, f.slug)), pricesOfRow("finish", f), f.slug);
    // The other fields of a row whose price was kept are the new catalogue's too (only the price is carried).
    const { id: _i, createdAt: _c, updatedAt: _u, pricePerKg: _p, ...restNew } = asSeeded["cnc-delrin"];
    assert.ok(Object.keys(restNew).length >= 8);
    for (const [k, v] of Object.entries(restNew)) assert.deepStrictEqual(bySlug(materialsDB, "cnc-delrin")[k], v, `cnc-delrin.${k}`);
    assert.strictEqual(pricingDB.getAll()[0].rules.seedVersion, defaults.SEED_VERSION);

    // One line per price in the log…
    const kept = log.filter((l) => /Catalogue: kept your/.test(l));
    const notKept = log.filter((l) => /Catalogue: could NOT keep your/.test(l));
    assert.strictEqual(kept.length, 3, log.join("\n"));
    assert.strictEqual(notKept.length, 2, log.join("\n"));
    assert.ok(kept.some((l) => /price per kg for Delrin \/ Acetal \(POM\) \(cnc-delrin\): \$12\.75 \(the new catalogue's default is \$11\.00\)/.test(l)), kept.join("\n"));
    assert.ok(notKept.some((l) => /\(sla-tough\), \$0\.61: this material is no longer in the catalogue/.test(l)), notKept.join("\n"));
    assert.ok(notKept.some((l) => /\(cnc-house-blend\), \$19\.00: this material was added by hand and is not in the new catalogue/.test(l)), notKept.join("\n"));
    assert.ok(log.some((l) => /3 price\(s\) you had changed were kept, 2 could not be/.test(l)));
    // …and one row per price in the change log.
    const rows = adminAuditDB.getAll().slice(auditBefore);
    assert.deepStrictEqual(rows.map((r) => `${r.action} ${r.target}`).sort(), ["price-kept finish:deburr", "price-kept material:cnc-delrin", "price-kept material:fdm-pla", "price-not-kept material:cnc-house-blend", "price-not-kept material:sla-tough"]);
    assert.ok(rows.every((r) => r.area === "catalogue" && r.entityId === `catalogue-v3-v${defaults.SEED_VERSION}` && !r.userId));
    assert.deepStrictEqual(rows.find((r) => r.target === "material:cnc-delrin").changes, { pricePerKg: [11, 12.75] });
  });

  test("the admin pricing page is given the same list; a customer is not", async () => {
    const r = await h.get("/api/admin/catalogue-upgrade", owner);
    assert.strictEqual(r.status, 200, r.text);
    const u = r.body.upgrade;
    assert.deepStrictEqual([u.from, u.to, u.kept.length, u.notKept.length], [3, defaults.SEED_VERSION, 3, 2]);
    assert.deepStrictEqual(u.kept.find((k) => k.slug === "cnc-delrin"), { kind: "material", slug: "cnc-delrin", name: "Delrin / Acetal (POM)", field: "pricePerKg", fieldLabel: "price per kg", yours: 12.75, newDefault: 11 });
    const gone = u.notKept.find((k) => k.slug === "sla-tough");
    assert.deepStrictEqual([gone.yours, gone.fieldLabel, gone.reason], [0.61, "price per cm³", "this material is no longer in the catalogue"]);
    const buyer = await h.register("dana@buyer.test", "Dana Buyer");
    assert.strictEqual((await h.get("/api/admin/catalogue-upgrade", buyer)).status, 403);
    assert.strictEqual((await h.get("/api/admin/catalogue-upgrade")).status, 401);
  });

  test("a second start changes nothing: no price moves, nothing more is logged or recorded", () => {
    const before = JSON.stringify([materialsDB.getAll(), finishesDB.getAll(), adminAuditDB.getAll().length]);
    const again = seedAgain();
    assert.strictEqual(JSON.stringify([materialsDB.getAll(), finishesDB.getAll(), adminAuditDB.getAll().length]), before);
    assert.ok(!again.some((l) => /Catalogue:/.test(l)), again.join("\n"));
  });

  test("nothing edited: every price takes the new catalogue and the log says there was nothing to carry", () => {
    backToVersion3();
    const auditBefore = adminAuditDB.getAll().length;
    const lines = seedAgain();
    for (const m of defaults.DEFAULT_MATERIALS) assert.deepStrictEqual(pricesOfRow("material", bySlug(materialsDB, m.slug)), pricesOfRow("material", m), m.slug);
    assert.ok(lines.some((l) => /no price had been changed by hand/.test(l)), lines.join("\n"));
    assert.strictEqual(adminAuditDB.getAll().length, auditBefore);
  });

  test("a version whose default prices are not on record carries nothing, and says so once", () => {
    backToVersion3();
    materialsDB.update(bySlug(materialsDB, "cnc-delrin").id, { pricePerKg: 12.75 });
    const rules = pricingDB.getAll()[0];
    pricingDB.update(rules.id, { rules: { ...rules.rules, seedVersion: 1 } });
    const lines = seedAgain();
    assert.strictEqual(bySlug(materialsDB, "cnc-delrin").pricePerKg, 11, "the new catalogue's price: an edit cannot be told from a default");
    assert.strictEqual(lines.filter((l) => /default prices of seed v1 are not on record/.test(l)).length, 1, lines.join("\n"));
  });

  test("what counts as edited: a price equal to the old default is not; a cleared or senseless figure is reported, never carried", () => {
    const rows = [
      { slug: "cnc-delrin", name: "Delrin", pricePerKg: 11 },                 // the old default
      { slug: "cnc-uhmw", name: "UHMW", pricePerKg: "8.10" },                 // edited (stored as text)
      { slug: "cnc-hdpe", name: "HDPE", pricePerKg: 0 },                      // edited to nothing usable
      { slug: "cnc-nylon", name: "Nylon", pricePerKg: null },                 // cleared
    ];
    const c = seedCarry.collect({ fromVersion: 3, materials: rows, finishes: [] });
    assert.deepStrictEqual(c.edited.map((e) => [e.slug, e.yours, e.oldDefault]), [["cnc-uhmw", 8.1, 7.5], ["cnc-hdpe", 0, 6], ["cnc-nylon", null, 13]]);
    const table = (list) => ({ getAll: () => list, update: (id, u) => Object.assign(list.find((r) => r.id === id), u) });
    const fresh = [{ id: 1, slug: "cnc-uhmw", pricePerKg: 7.5 }, { id: 2, slug: "cnc-hdpe", pricePerKg: 6 }, { id: 3, slug: "cnc-nylon", pricePerKg: 13 }];
    const out = seedCarry.apply(c, { materialsDB: table(fresh), finishesDB: table([]), toVersion: 4, log: () => {}, audit: { record: () => {} } });
    assert.deepStrictEqual(fresh.map((r) => r.pricePerKg), [8.1, 6, 13]);
    assert.deepStrictEqual([out.kept.map((k) => k.slug), out.notKept.map((k) => [k.slug, k.reason])], [["cnc-uhmw"], [["cnc-hdpe", "the stored figure is not a usable price"], ["cnc-nylon", "the stored figure is not a usable price"]]]);
  });

  await run(h.stop);
})().catch((err) => { console.error(err); process.exit(1); });
