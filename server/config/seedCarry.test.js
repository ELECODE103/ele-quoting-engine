/**
 * A catalogue upgrade keeps everything the owner changed by hand, and only that.
 * Run: `node server/config/seedCarry.test.js`
 *
 * The database is put back to exactly what a seed version left (the whole catalogue of that version,
 * seedSnapshots/v<N>.json: version 3 is origin/master's), changed the way the owner changes it in
 * Admin, and the real seed is run on it, as a restart runs it.
 *
 * (2026-11-13, re-review F-10 and F-11.) Until then only prices were carried, a row added by hand
 * was deleted, and a missing version marker replaced the whole catalogue. The cases that asserted
 * those three behaviours are rewritten here to the new rule; the price cases are as they were.
 */
const assert = require("assert");
const { start, runner } = require("../testSupport/harness");
const history = require("./seedHistory");
const seedCarry = require("./seedCarry");
const defaults = require("./defaults");

const { test, run } = runner("Catalogue upgrade: what the owner changed by hand is carried over");

(async () => {
  const h = await start();
  const { materialsDB, finishesDB, pricingDB, adminAuditDB } = h.models;
  const { seedDatabase } = require("./seed");
  const bySlug = (db, slug) => db.getAll().find((r) => r.slug === slug) || null;
  const pricesOfRow = (kind, row) => Object.fromEntries(history.PRICE_FIELDS[kind].filter((f) => row[f] !== null && row[f] !== undefined).map((f) => [f, row[f]]));
  const snapshot = (n) => require(`./seedSnapshots/v${n}.json`);
  const CURRENT = defaults.SEED_VERSION;
  let owner;
  // The current catalogue as a fresh database stores it (the harness has just seeded one).
  const stored = (row) => { const { id, createdAt, updatedAt, ...rest } = row; return rest; };
  const asSeeded = { materials: Object.fromEntries(materialsDB.getAll().map((m) => [m.slug, stored(JSON.parse(JSON.stringify(m)))])), finishes: Object.fromEntries(finishesDB.getAll().map((f) => [f.slug, stored(JSON.parse(JSON.stringify(f)))])) };

  const setMarker = (v) => { const r = pricingDB.getAll()[0]; const rules = { ...r.rules }; if (v === undefined) delete rules.seedVersion; else rules.seedVersion = v; pricingDB.update(r.id, { rules }); };
  const marker = () => pricingDB.getAll()[0].rules.seedVersion;
  /** Make the catalogue exactly what a database seeded at version `n` holds. */
  function backToVersion(n) {
    for (const m of materialsDB.getAll()) materialsDB.delete(m.id);
    for (const f of finishesDB.getAll()) finishesDB.delete(f.id);
    for (const m of snapshot(n).materials) materialsDB.insert(m);
    for (const f of snapshot(n).finishes) finishesDB.insert(f);
    setMarker(n);
  }
  /** Run the real seed, collecting what it prints (the log, and the loud lines it sends to the error stream). */
  function seedAgain() {
    const lines = [], loud = [];
    const real = console.log, realError = console.error;
    console.log = (...a) => { lines.push(a.join(" ")); };
    console.error = (...a) => { loud.push(a.join(" ")); };
    try { seedDatabase(); } finally { console.log = real; console.error = realError; }
    lines.loud = loud;
    return lines;
  }
  const everything = () => JSON.stringify([materialsDB.getAll(), finishesDB.getAll()]);

  test("the record of each version: the current version's prices and its whole catalogue are the current defaults (add both when SEED_VERSION goes up)", () => {
    const current = history.pricesOf(CURRENT);
    assert.ok(current, `seedHistory.js has no entry for SEED_VERSION ${CURRENT}: add the new catalogue's prices to it`);
    assert.deepStrictEqual(current.materials, Object.fromEntries(defaults.DEFAULT_MATERIALS.map((m) => [m.slug, pricesOfRow("material", m)])));
    assert.deepStrictEqual(current.finishes, Object.fromEntries(defaults.DEFAULT_FINISHES.map((f) => [f.slug, pricesOfRow("finish", f)])));
    assert.strictEqual(history.pricesOf(1), null, "version 1 is not on record");
    assert.ok(Object.keys(history.pricesOf(3).materials).length === 50 && history.pricesOf(3).materials["sla-tough"], "version 3 is origin/master's catalogue");
    // The whole catalogue, every field: `node scripts/dev/seed-snapshot.js` writes the file for a new version.
    const whole = history.catalogueOf(CURRENT);
    assert.ok(whole, `server/config/seedSnapshots/v${CURRENT}.json is missing: run node scripts/dev/seed-snapshot.js and commit it`);
    assert.deepStrictEqual(snapshot(CURRENT).materials, JSON.parse(JSON.stringify(defaults.DEFAULT_MATERIALS)), "the file is the catalogue in defaults.js");
    assert.deepStrictEqual(snapshot(CURRENT).finishes, JSON.parse(JSON.stringify(defaults.DEFAULT_FINISHES)));
    assert.strictEqual(history.catalogueOf(1), null, "version 1's catalogue is not on record");
    for (const n of [2, 3, CURRENT]) {
      const c = history.catalogueOf(n), p = history.pricesOf(n);
      assert.deepStrictEqual(Object.keys(c.materials).sort(), Object.keys(p.materials).sort(), `version ${n}: the same materials in both records`);
      for (const [slug, row] of Object.entries(c.materials)) assert.deepStrictEqual(pricesOfRow("material", row), p.materials[slug], `v${n} ${slug}`);
      for (const [slug, row] of Object.entries(c.finishes)) assert.deepStrictEqual(pricesOfRow("finish", row), p.finishes[slug], `v${n} ${slug}`);
    }
  });

  test("every field the two tables store is compared, and a database nobody edited has nothing to carry, at every version on record", () => {
    const keys = (db) => [...new Set(db.getAll().flatMap((r) => Object.keys(r)))].filter((k) => !["id", "slug", "createdAt", "updatedAt"].includes(k)).sort();
    assert.deepStrictEqual([...seedCarry.STORED.material].sort(), keys(materialsDB), "seedCarry.STORED.material is every stored field of a material: add a new column to it");
    assert.deepStrictEqual([...seedCarry.STORED.finish].sort(), keys(finishesDB), "seedCarry.STORED.finish is every stored field of a finish");
    for (const n of [2, 3, CURRENT]) {
      backToVersion(n);
      const old = history.catalogueOf(n);
      for (const [kind, db, seed] of [["material", materialsDB, old.materials], ["finish", finishesDB, old.finishes]]) {
        const p = seedCarry.plan(kind, db.getAll(), seed, Object.values(seed));
        assert.deepStrictEqual([p.kept, p.notKept], [[], []], `version ${n} ${kind}s as stored differ from version ${n}'s catalogue`);
      }
    }
  });

  test("setup: the owner signs in", async () => { owner = await h.admin("Owner"); });

  let log, ids;
  test("version 3 → current: everything the owner changed is kept on its slug; what was not touched takes the new catalogue; a slug that is gone is not brought back", async () => {
    backToVersion(3);
    ids = Object.fromEntries(materialsDB.getAll().map((m) => [m.slug, m.id]));
    // The owner's own changes, made the way the admin screens make them.
    materialsDB.update(bySlug(materialsDB, "cnc-delrin").id, { pricePerKg: 12.75 });        // material sold by weight (default 11)
    materialsDB.update(bySlug(materialsDB, "fdm-pla").id, { pricePerCm3: 0.065 });           // printed material (default 0.05)
    finishesDB.update(bySlug(finishesDB, "deburr").id, { pricePerPart: 3.25 });              // a finish (default 2.5); its price per sq in is left alone
    materialsDB.update(bySlug(materialsDB, "sla-tough").id, { pricePerCm3: 0.61, active: false }); // a material the new catalogue no longer has
    materialsDB.insert({ slug: "cnc-house-blend", name: "House blend", category: "Plastic", process: "cnc", subProcess: "milling", pricePerKg: 19, active: true, grades: [] }); // added by hand
    materialsDB.update(bySlug(materialsDB, "cnc-stainless-304").id, { active: true });       // switched ON (the catalogue ships it off)
    materialsDB.update(bySlug(materialsDB, "cnc-uhmw").id, { active: false });               // "we do not stock this"
    finishesDB.update(bySlug(finishesDB, "cnc-bead-blast").id, { active: false });           // a finish switched off
    materialsDB.update(bySlug(materialsDB, "cnc-nylon").id, { machinability: 0.2 });         // slower to cut: changes the price
    const acrylic = bySlug(materialsDB, "rt-acrylic");
    materialsDB.update(acrylic.id, { thicknesses: acrylic.thicknesses.slice(0, 2), grades: [{ name: "Shop grade", density: 1.19 }] }); // what is stocked
    materialsDB.update(bySlug(materialsDB, "aluminum-6061").id, { pricePerKg: null, costPerKg: 55 }); // priced through the other field the admin form accepts
    materialsDB.update(bySlug(materialsDB, "cnc-hdpe").id, { name: "HDPE (natural)" });     // renamed
    materialsDB.delete(bySlug(materialsDB, "cnc-ptfe").id);                                  // deleted
    const auditBefore = adminAuditDB.getAll().length;
    const offBefore = { stainless: asSeeded.materials["cnc-stainless-304"].active, uhmw: asSeeded.materials["cnc-uhmw"].active, blast: asSeeded.finishes["cnc-bead-blast"].active };

    log = seedAgain();

    // Kept: prices.
    assert.strictEqual(bySlug(materialsDB, "cnc-delrin").pricePerKg, 12.75);
    assert.strictEqual(bySlug(materialsDB, "fdm-pla").pricePerCm3, 0.065);
    assert.deepStrictEqual([bySlug(finishesDB, "deburr").pricePerPart, bySlug(finishesDB, "deburr").pricePerSqIn], [3.25, 0.005]);
    // Kept: the switch, both ways, on a material and on a finish.
    assert.strictEqual(offBefore.stainless, false, "the catalogue ships this one switched off");
    assert.strictEqual(bySlug(materialsDB, "cnc-stainless-304").active, true, "switched on by the owner: still on");
    assert.strictEqual(offBefore.uhmw, true);
    assert.strictEqual(bySlug(materialsDB, "cnc-uhmw").active, false, "switched off by the owner: still off");
    assert.strictEqual(bySlug(finishesDB, "cnc-bead-blast").active, false, "a finish switched off stays off");
    // Kept: what the price is worked out from.
    assert.strictEqual(bySlug(materialsDB, "cnc-nylon").machinability, 0.2);
    assert.strictEqual(bySlug(materialsDB, "rt-acrylic").thicknesses.length, 2);
    assert.deepStrictEqual(bySlug(materialsDB, "rt-acrylic").grades, [{ name: "Shop grade", density: 1.19 }]);
    assert.deepStrictEqual([bySlug(materialsDB, "aluminum-6061").pricePerKg, bySlug(materialsDB, "aluminum-6061").costPerKg], [null, 55], "priced through cost per kg, as the owner had it");
    assert.strictEqual(bySlug(materialsDB, "cnc-hdpe").name, "HDPE (natural)");
    // Kept: a row the owner added, whole, and a row the owner deleted stays deleted.
    const house = bySlug(materialsDB, "cnc-house-blend");
    assert.ok(house && house.pricePerKg === 19 && house.name === "House blend", "a material added by hand is still there, as it was");
    assert.strictEqual(bySlug(materialsDB, "cnc-ptfe"), null, "a material the owner deleted is not added back");
    // Not brought back.
    assert.strictEqual(bySlug(materialsDB, "sla-tough"), null, "a material that left the catalogue stays gone");
    // Everything else is the new catalogue: row for row, field for field, in the catalogue's order, then the owner's own rows.
    const expectSlugs = [...defaults.DEFAULT_MATERIALS.map((m) => m.slug).filter((s) => s !== "cnc-ptfe"), "cnc-house-blend"];
    assert.deepStrictEqual(materialsDB.getAll().map((m) => m.slug), expectSlugs);
    assert.deepStrictEqual(finishesDB.getAll().map((f) => f.slug), defaults.DEFAULT_FINISHES.map((f) => f.slug));
    const touched = { "cnc-delrin": ["pricePerKg"], "fdm-pla": ["pricePerCm3"], "cnc-stainless-304": ["active"], "cnc-uhmw": ["active"], "cnc-nylon": ["machinability"], "rt-acrylic": ["thicknesses", "grades"], "aluminum-6061": ["pricePerKg", "costPerKg"], "cnc-hdpe": ["name"] };
    for (const m of defaults.DEFAULT_MATERIALS) {
      if (m.slug === "cnc-ptfe") continue;
      const now = stored(bySlug(materialsDB, m.slug));
      for (const [k, v] of Object.entries(asSeeded.materials[m.slug])) if (!(touched[m.slug] || []).includes(k)) assert.deepStrictEqual(now[k], v, `${m.slug}.${k}`);
    }
    for (const f of defaults.DEFAULT_FINISHES) {
      const now = stored(bySlug(finishesDB, f.slug));
      for (const [k, v] of Object.entries(asSeeded.finishes[f.slug])) if (!(f.slug === "deburr" && k === "pricePerPart") && !(f.slug === "cnc-bead-blast" && k === "active")) assert.deepStrictEqual(now[k], v, `${f.slug}.${k}`);
    }
    // A row that was there before is the same row afterwards (the id the admin screens and the change log know it by).
    assert.strictEqual(bySlug(materialsDB, "cnc-delrin").id, ids["cnc-delrin"]);
    assert.strictEqual(bySlug(materialsDB, "mild-steel").id, ids["mild-steel"]);
    assert.strictEqual(marker(), CURRENT);
    assert.strictEqual(materialsDB.getAll().filter((m) => m.active && !(Number(m.process === "3d-printing" ? m.pricePerCm3 : (m.pricePerKg || m.costPerKg)) > 0)).length, 0, "no active material is without a price");

    // One line per change in the log…
    const kept = log.filter((l) => /Catalogue: kept /.test(l) || /stays removed/.test(l));
    const notKept = log.filter((l) => /Catalogue: could NOT keep your/.test(l));
    assert.strictEqual(kept.length, 14, kept.join("\n"));
    assert.strictEqual(notKept.length, 2, notKept.join("\n"));
    assert.ok(kept.some((l) => /price per kg for Delrin \/ Acetal \(POM\) \(cnc-delrin\): \$12\.75 \(the new catalogue's default is \$11\.00\)/.test(l)), kept.join("\n"));
    assert.ok(kept.some((l) => /kept your on\/off switch for .* \(cnc-uhmw\): off \(the new catalogue's default is on\)/.test(l)), kept.join("\n"));
    assert.ok(kept.some((l) => /kept your on\/off switch for .* \(cnc-stainless-304\): on \(the new catalogue's default is off\)/.test(l)), kept.join("\n"));
    assert.ok(kept.some((l) => /kept your machinability for .* \(cnc-nylon\): 0\.2 /.test(l)), kept.join("\n"));
    assert.ok(kept.some((l) => /kept your thickness list for .* \(rt-acrylic\): 2 thicknesses \(the new catalogue's default is \d+ thicknesses\)/.test(l)), kept.join("\n"));
    assert.ok(kept.some((l) => /kept your grades for .* \(rt-acrylic\): 1 grade \(Shop grade\)/.test(l)), kept.join("\n"));
    assert.ok(kept.some((l) => /kept your cost per kg for .* \(aluminum-6061\): \$55\.00/.test(l)), kept.join("\n"));
    assert.ok(kept.some((l) => /kept the price per kg for .* \(aluminum-6061\) empty, as you had it/.test(l)), kept.join("\n"));
    assert.ok(kept.some((l) => /kept House blend \(cnc-house-blend\), a material you added by hand/.test(l)), kept.join("\n"));
    assert.ok(kept.some((l) => /\(cnc-ptfe\) stays removed: you had deleted this material/.test(l)), kept.join("\n"));
    assert.ok(notKept.some((l) => /price per cm³ for .* \(sla-tough\), \$0\.61: this material is no longer in the catalogue/.test(l)), notKept.join("\n"));
    assert.ok(notKept.some((l) => /on\/off switch for .* \(sla-tough\), off: this material is no longer in the catalogue/.test(l)), notKept.join("\n"));
    assert.ok(log.some((l) => /14 change\(s\) you had made by hand were kept, 2 could not be/.test(l)), log.join("\n"));
    // …and one row per change in the change log.
    const rows = adminAuditDB.getAll().slice(auditBefore);
    assert.deepStrictEqual(rows.map((r) => `${r.action} ${r.target}`).sort(), [
      "edit-kept finish:cnc-bead-blast", "edit-kept material:aluminum-6061", "edit-kept material:cnc-hdpe", "edit-kept material:cnc-nylon", "edit-kept material:cnc-stainless-304", "edit-kept material:cnc-uhmw",
      "edit-kept material:rt-acrylic", "edit-kept material:rt-acrylic", "edit-not-kept material:sla-tough",
      "price-kept finish:deburr", "price-kept material:aluminum-6061", "price-kept material:cnc-delrin", "price-kept material:fdm-pla", "price-not-kept material:sla-tough",
      "removal-kept material:cnc-ptfe", "row-kept material:cnc-house-blend",
    ]);
    assert.ok(rows.every((r) => r.area === "catalogue" && r.entityId === `catalogue-v3-v${CURRENT}` && !r.userId));
    assert.deepStrictEqual(rows.find((r) => r.target === "material:cnc-delrin").changes, { pricePerKg: [11, 12.75] });
    assert.deepStrictEqual(rows.find((r) => r.target === "material:cnc-uhmw").changes, { active: [true, false] });
  });

  test("the admin pricing page is given the same list; a customer is not", async () => {
    const r = await h.get("/api/admin/catalogue-upgrade", owner);
    assert.strictEqual(r.status, 200, r.text);
    const u = r.body.upgrade;
    assert.deepStrictEqual([u.from, u.to, u.kept.length, u.notKept.length], [3, CURRENT, 14, 2]);
    // (2026-11-13: each entry also carries its values as a person reads them, for fields that are not prices.)
    assert.deepStrictEqual(u.kept.find((k) => k.slug === "cnc-delrin"), { kind: "material", slug: "cnc-delrin", name: "Delrin / Acetal (POM)", field: "pricePerKg", fieldLabel: "price per kg", yours: 12.75, newDefault: 11, yoursText: "$12.75", newDefaultText: "$11.00" });
    const off = u.kept.find((k) => k.slug === "cnc-uhmw");
    assert.deepStrictEqual([off.fieldLabel, off.yoursText, off.newDefaultText], ["on/off switch", "off", "on"]);
    assert.strictEqual(u.kept.find((k) => k.slug === "cnc-house-blend").text, "added by you: left as it is");
    assert.strictEqual(u.kept.find((k) => k.slug === "cnc-ptfe").text, "deleted by you: not added back");
    const gone = u.notKept.find((k) => k.slug === "sla-tough" && k.field === "pricePerCm3");
    assert.deepStrictEqual([gone.yours, gone.fieldLabel, gone.reason, gone.yoursText], [0.61, "price per cm³", "this material is no longer in the catalogue", "$0.61"]);
    const buyer = await h.register("dana@buyer.test", "Dana Buyer");
    assert.strictEqual((await h.get("/api/admin/catalogue-upgrade", buyer)).status, 403);
    assert.strictEqual((await h.get("/api/admin/catalogue-upgrade")).status, 401);
  });

  test("a second start changes nothing: nothing moves, nothing more is logged or recorded", () => {
    const before = JSON.stringify([materialsDB.getAll(), finishesDB.getAll(), adminAuditDB.getAll().length]);
    const again = seedAgain();
    assert.strictEqual(JSON.stringify([materialsDB.getAll(), finishesDB.getAll(), adminAuditDB.getAll().length]), before);
    assert.ok(!again.some((l) => /Catalogue:/.test(l)) && again.loud.length === 0, [...again, ...again.loud].join("\n"));
  });

  test("nothing edited: every row takes the new catalogue and the log says there was nothing to carry", () => {
    backToVersion(3);
    const auditBefore = adminAuditDB.getAll().length;
    const lines = seedAgain();
    for (const m of defaults.DEFAULT_MATERIALS) assert.deepStrictEqual(stored(bySlug(materialsDB, m.slug)), asSeeded.materials[m.slug], m.slug);
    for (const f of defaults.DEFAULT_FINISHES) assert.deepStrictEqual(stored(bySlug(finishesDB, f.slug)), asSeeded.finishes[f.slug], f.slug);
    assert.deepStrictEqual(materialsDB.getAll().map((m) => m.slug), defaults.DEFAULT_MATERIALS.map((m) => m.slug), "in the catalogue's order");
    assert.ok(lines.some((l) => /no price had been changed by hand/.test(l)), lines.join("\n"));
    assert.strictEqual(adminAuditDB.getAll().length, auditBefore);
  });

  test("two versions behind (2 → current): an edited price and a switched-off material are kept; everything else is the current catalogue", () => {
    backToVersion(2);
    materialsDB.update(bySlug(materialsDB, "mild-steel").id, { pricePerKg: 42.42 });
    materialsDB.update(bySlug(materialsDB, "cnc-acrylic").id, { active: false });
    seedAgain();
    assert.strictEqual(bySlug(materialsDB, "mild-steel").pricePerKg, 42.42);
    assert.strictEqual(bySlug(materialsDB, "cnc-acrylic").active, false);
    for (const m of defaults.DEFAULT_MATERIALS) {
      const now = stored(bySlug(materialsDB, m.slug));
      for (const [k, v] of Object.entries(asSeeded.materials[m.slug])) if (!(m.slug === "mild-steel" && k === "pricePerKg") && !(m.slug === "cnc-acrylic" && k === "active")) assert.deepStrictEqual(now[k], v, `${m.slug}.${k}`);
    }
    assert.strictEqual(marker(), CURRENT);
  });

  test("a figure that is not a usable price is reported, never carried: zero, a senseless amount, and a price cleared with nothing in its place", () => {
    backToVersion(3);
    materialsDB.update(bySlug(materialsDB, "cnc-uhmw").id, { pricePerKg: 8.1 });      // an ordinary edit
    materialsDB.update(bySlug(materialsDB, "cnc-hdpe").id, { pricePerKg: 0 });        // edited to nothing usable
    materialsDB.update(bySlug(materialsDB, "cnc-nylon").id, { pricePerKg: null });    // cleared, and no cost per kg either
    materialsDB.update(bySlug(materialsDB, "cnc-pvc").id, { pricePerKg: 5e8 });       // senseless
    finishesDB.update(bySlug(finishesDB, "deburr").id, { pricePerPart: null });       // a finish price cleared
    finishesDB.update(bySlug(finishesDB, "cnc-deburr").id, { pricePerPart: 0 });      // a finish may cost nothing
    const lines = seedAgain();
    assert.deepStrictEqual(["cnc-uhmw", "cnc-hdpe", "cnc-nylon", "cnc-pvc"].map((s) => bySlug(materialsDB, s).pricePerKg), [8.1, 6, 13, 6]);
    assert.deepStrictEqual([bySlug(finishesDB, "deburr").pricePerPart, bySlug(finishesDB, "cnc-deburr").pricePerPart], [2.5, 0]);
    const notKept = lines.filter((l) => /could NOT keep/.test(l));
    assert.strictEqual(notKept.length, 4, lines.join("\n"));
    for (const slug of ["cnc-hdpe", "cnc-nylon", "cnc-pvc", "deburr"]) assert.ok(notKept.some((l) => l.includes(`(${slug})`) && /the stored figure is not a usable price/.test(l)), `${slug}: ${notKept.join(" | ")}`);
    // The same from the pure function, row by row.
    const old = history.catalogueOf(3).materials;
    const row = (slug, over) => ({ id: slug, ...old[slug], ...over });
    const p = seedCarry.plan("material", [row("cnc-delrin", {}), row("cnc-uhmw", { pricePerKg: "8.10" }), row("cnc-hdpe", { pricePerKg: 0 }), row("cnc-nylon", { pricePerKg: null })], old, ["cnc-delrin", "cnc-uhmw", "cnc-hdpe", "cnc-nylon"].map((s) => old[s]));
    assert.deepStrictEqual(p.kept.map((e) => [e.slug, e.field, e.yours, e.oldDefault]), [["cnc-uhmw", "pricePerKg", 8.1, 7.5]], "a price equal to the old default is not an edit; one stored as text is read as the number");
    assert.deepStrictEqual(p.notKept.map((e) => [e.slug, e.yours, e.reason]), [["cnc-hdpe", 0, "the stored figure is not a usable price"], ["cnc-nylon", null, "the stored figure is not a usable price"]]);
    assert.deepStrictEqual(p.final.map((r) => r.pricePerKg), [11, 8.1, 6, 13]);
  });

  // ── The version marker (F-11) ──
  for (const [label, value, endsAt] of [["missing", undefined, CURRENT], ["null", null, CURRENT], ["0", 0, CURRENT], ["-1", -1, CURRENT], ["4.5", 4.5, CURRENT], ["the text \"abc\"", "abc", CURRENT], [`the text "${CURRENT}"`, String(CURRENT), CURRENT], ["1 (a version whose catalogue is not on record)", 1, CURRENT], ["99 (newer than this code)", 99, 99]]) {
    test(`marker ${label}: the catalogue is not replaced. Every row stays exactly as it was, and that is said loudly, recorded once and shown on the admin page`, async () => {
      backToVersion(3);
      materialsDB.update(bySlug(materialsDB, "mild-steel").id, { pricePerKg: 123.45 });
      materialsDB.update(bySlug(materialsDB, "cnc-uhmw").id, { active: false });
      materialsDB.insert({ slug: "cnc-house-blend", name: "House blend", category: "Plastic", process: "cnc", subProcess: "milling", pricePerKg: 19, active: true, grades: [] });
      setMarker(value);
      const before = everything();
      const auditBefore = adminAuditDB.getAll().length;
      const lines = seedAgain();
      assert.strictEqual(everything(), before, "not one field of one row moved");
      assert.ok(!lines.some((l) => /Upgrading catalogs|Seeding materials|Seeding finishes/.test(l)), lines.join("\n"));
      assert.ok(lines.loud.some((l) => /CATALOGUE NOT UPDATED/.test(l) && /Nothing was replaced and nothing was added/.test(l)), lines.loud.join("\n"));
      assert.ok(lines.loud.some((l) => /In the current catalogue and not in this database \(8\)/.test(l) && /sla-grey/.test(l)), "the entries the new catalogue has and this database does not are named");
      const rows = adminAuditDB.getAll().slice(auditBefore);
      assert.deepStrictEqual(rows.map((r) => r.action), ["catalogue-kept-as-is"]);
      assert.strictEqual(marker(), endsAt);
      const page = (await h.get("/api/admin/catalogue-upgrade", owner)).body.upgrade;
      assert.ok(/were NOT updated/.test(page.notice) && page.kept.length === 0, JSON.stringify(page).slice(0, 300));
      // The next start: still untouched; nothing more is recorded.
      const again = seedAgain();
      assert.strictEqual(everything(), before);
      assert.strictEqual(adminAuditDB.getAll().length, auditBefore + 1, "recorded once");
      if (endsAt === CURRENT) assert.strictEqual(again.loud.length, 0, "and, the marker now being a version, nothing more is said");
      else assert.ok(again.loud.some((l) => /CATALOGUE NOT UPDATED/.test(l)), "a database newer than the code says so at every start");
    });
  }

  test("the pricing-rules row is gone altogether, the catalogue is there: the catalogue is not replaced", () => {
    backToVersion(3);
    materialsDB.update(bySlug(materialsDB, "mild-steel").id, { pricePerKg: 123.45 });
    const rules = pricingDB.getAll()[0];
    pricingDB.delete(rules.id);
    const before = everything();
    const lines = seedAgain();
    assert.strictEqual(everything(), before);
    assert.ok(lines.loud.some((l) => /CATALOGUE NOT UPDATED/.test(l)), lines.loud.join("\n"));
    assert.strictEqual(marker(), CURRENT, "the rules were seeded again, at the current version");
  });

  test("a material the owner priced only through cost per kg, first in the list: the catalogue is not taken for one from before prices existed", () => {
    backToVersion(CURRENT);
    const first = materialsDB.getAll()[0];
    materialsDB.update(first.id, { pricePerKg: null, pricePerCm3: null, costPerKg: 2.2 });
    materialsDB.update(bySlug(materialsDB, "cnc-delrin").id, { pricePerKg: 12.75 });
    const before = everything();
    const lines = seedAgain();
    assert.strictEqual(everything(), before, lines.join("\n"));
    assert.ok(!lines.some((l) => /re-seeding/.test(l)), lines.join("\n"));
  });

  test("an upgrade that fails part way changes nothing: the catalogue and the marker are as they were, and nothing is recorded", () => {
    backToVersion(3);
    materialsDB.update(bySlug(materialsDB, "cnc-delrin").id, { pricePerKg: 12.75 });
    const before = everything();
    const auditBefore = adminAuditDB.getAll().length;
    const realInsert = finishesDB.insert.bind(finishesDB);
    let n = 0;
    finishesDB.insert = (row) => { if (++n === 5) throw new Error("disk fault (test)"); return realInsert(row); };
    const realError = console.error, realLog = console.log;
    console.error = () => {}; console.log = () => {};
    let threw = null;
    try { seedDatabase(); } catch (err) { threw = err; } finally { finishesDB.insert = realInsert; console.error = realError; console.log = realLog; }
    assert.ok(threw && /disk fault/.test(threw.message), "the start fails, out loud");
    assert.strictEqual(everything(), before, "every material and finish is as it was");
    assert.strictEqual(marker(), 3);
    assert.strictEqual(adminAuditDB.getAll().length, auditBefore);
    // The next start does the whole upgrade.
    seedAgain();
    assert.strictEqual(bySlug(materialsDB, "cnc-delrin").pricePerKg, 12.75);
    assert.strictEqual(marker(), CURRENT);
    assert.ok(bySlug(materialsDB, "sla-grey"));
  });

  await run(h.stop);
})().catch((err) => { console.error(err); process.exit(1); });
