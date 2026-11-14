#!/usr/bin/env node
/**
 * Second re-review (2026-11-13), F-10 and F-11: the catalogue upgrade against odd catalogues and odd
 * version markers.
 *
 *   node tools/security/rereview-fixes/r3-catalogue-odd.js
 *
 * In-process harness; the real seed (server/config/seed.js seedDatabase) is run on a database prepared
 * each way, as a restart runs it. For every case: the seed must not throw (a throw at start-up is a site
 * that does not start), must be the same after a second start, and must not lose an owner's edit without
 * a line that says so.
 *
 *   A  markers on a CURRENT (version 4) catalogue that carries owner edits: missing, null, 0, -1, "4",
 *      "3", "abc", 4.5, 3.0, 99, 1000, true, [4], {}, NaN (stored as null), 1, 2, and no rules row at all
 *   B  a version-3 catalogue with owner edits, upgraded, when the catalogue is odd: two rows with one
 *      slug, a row with no slug, a renamed slug, slugs named like JavaScript built-ins, fields of the
 *      wrong type, absurd prices, every material deleted, every finish deleted, only one material left
 *   C  the two older "re-seed" checks: a catalogue in which no row has a price field the check knows
 */
const assert = require("assert");
const { liftPacing, report } = require("../rereview-relaunch/lib");
const { start } = require("../../../server/testSupport/harness");
const seedCarry = require("../../../server/config/seedCarry");
const defaults = require("../../../server/config/defaults");

(async () => {
  liftPacing();
  const h = await start();
  const R = report();
  const { materialsDB, finishesDB, pricingDB } = h.models;
  const { seedDatabase } = require("../../../server/config/seed");
  const audit = require("../../../server/services/audit");
  const V = defaults.SEED_VERSION;
  const v3 = seedCarry.catalogueOf(3);
  const rulesSeed = JSON.parse(JSON.stringify(pricingDB.getAll()[0].rules));
  const strip = ({ id, createdAt, updatedAt, ...row }) => row;
  const by = (db, slug) => db.getAll().find((r) => r.slug === slug) || null;
  const clear = () => { for (const m of materialsDB.getAll()) materialsDB.delete(m.id); for (const f of finishesDB.getAll()) finishesDB.delete(f.id); };
  const setMarker = (v) => {
    let r = pricingDB.getAll()[0];
    if (!r) { pricingDB.insert({ rules: rulesSeed }); r = pricingDB.getAll()[0]; }
    const rules = { ...rulesSeed }; if (v === undefined) delete rules.seedVersion; else rules.seedVersion = v;
    pricingDB.update(r.id, { rules });
  };
  const marker = () => { const r = pricingDB.getAll()[0]; return r ? r.rules.seedVersion : "(no rules row)"; };
  const toV = (n) => { clear(); const cat = n === V ? { materials: Object.fromEntries(defaults.DEFAULT_MATERIALS.map((m) => [m.slug, m])), finishes: Object.fromEntries(defaults.DEFAULT_FINISHES.map((f) => [f.slug, f])) } : seedCarry.catalogueOf(n); for (const m of Object.values(cat.materials)) materialsDB.insert(strip(m)); for (const f of Object.values(cat.finishes)) finishesDB.insert(strip(f)); setMarker(n); };
  /** Run the seed as a restart does. Returns its log lines, or the error it threw. */
  function restart() {
    const lines = []; const real = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a) => lines.push(a.join(" "));
    let threw = null;
    try { seedDatabase(); } catch (err) { threw = err; } finally { Object.assign(console, real); }
    return { lines, threw };
  }
  const snapshot = () => JSON.stringify({ m: materialsDB.getAll().map(strip).sort((a, b) => String(a.slug).localeCompare(String(b.slug))), f: finishesDB.getAll().map(strip).sort((a, b) => String(a.slug).localeCompare(String(b.slug))) });
  const priceOf = (m) => (m.process === "3d-printing" ? m.pricePerCm3 : (m.pricePerKg || m.costPerKg));
  const unpriced = () => materialsDB.getAll().filter((m) => m.active && !(Number(priceOf(m)) > 0)).map((m) => m.slug);

  // ── A. markers on a current catalogue ──
  console.log("\nA. the version marker, on a current catalogue that carries the owner's edits");
  const EDIT_A = "cnc-delrin", EDIT_OFF = "stainless-304";
  const markers = [["missing", undefined], ["null", null], ["0", 0], ["-1", -1], ['"4" as text', "4"], ['"3" as text', "3"], ['"abc"', "abc"], ["4.5", 4.5], ["3.0 (the number 3: a real downgrade marker)", 3.0], ["99", 99], ["1000", 1000], ["true", true], ["[4]", [4]], ["{}", {}], ["1", 1], ["2", 2]];
  for (const [label, value] of markers) {
    toV(V);
    materialsDB.update(by(materialsDB, EDIT_A).id, { pricePerKg: 123.45, machinability: 0.31 });
    materialsDB.update(by(materialsDB, EDIT_OFF).id, { active: false });
    materialsDB.insert({ slug: "owner-added", name: "Owner added", category: "Plastic", process: "cnc", subProcess: "milling", density: 1.2, pricePerKg: 50, machinability: 0.5, active: true });
    const gone = by(materialsDB, "cnc-peek"); if (gone) materialsDB.delete(gone.id);
    setMarker(value);
    const before = snapshot();
    const r1 = restart();
    const a = by(materialsDB, EDIT_A), off = by(materialsDB, EDIT_OFF);
    const kept = a && a.pricePerKg === 123.45 && a.machinability === 0.31 && off && off.active === false && Boolean(by(materialsDB, "owner-added")) && !by(materialsDB, "cnc-peek");
    const mid = snapshot();
    const r2 = restart();
    const ok = !r1.threw && !r2.threw && kept && snapshot() === mid && unpriced().length === 0;
    R.check(ok, `marker ${label}: the start does not fail, every edit is kept, a second start changes nothing`, `threw: ${r1.threw ? r1.threw.message : "no"}; price ${a && a.pricePerKg}, machinability ${a && a.machinability}, switched-off stays off ${off && off.active === false}, owner's row kept ${Boolean(by(materialsDB, "owner-added"))}, deleted row stays deleted ${!by(materialsDB, "cnc-peek")}; rows changed by the start: ${before === mid ? "none" : "some"}; marker afterwards ${JSON.stringify(marker())}; said CATALOGUE NOT UPDATED: ${r1.lines.some((l) => /CATALOGUE NOT UPDATED/.test(l))}`);
  }
  {
    toV(V);
    materialsDB.update(by(materialsDB, EDIT_A).id, { pricePerKg: 123.45 });
    for (const r of pricingDB.getAll()) pricingDB.delete(r.id);
    const r1 = restart();
    const a = by(materialsDB, EDIT_A);
    R.check(!r1.threw && a && a.pricePerKg === 123.45 && pricingDB.getAll().length === 1, "the pricing-rules row is gone altogether: the start does not fail, the catalogue is left alone, a rules row is made", `threw: ${r1.threw ? r1.threw.message : "no"}; price ${a && a.pricePerKg}; marker afterwards ${JSON.stringify(marker())}`);
  }

  // ── B. odd catalogues through a real upgrade (3 → current) ──
  console.log(`\nB. odd catalogues through the upgrade from version 3 to ${V}`);
  const SLUG = Object.keys(v3.materials).find((s) => defaults.DEFAULT_MATERIALS.some((m) => m.slug === s) && v3.materials[s].pricePerKg);
  const cases = {
    "two rows with the same slug, edited differently": () => { const row = strip(by(materialsDB, SLUG)); materialsDB.update(by(materialsDB, SLUG).id, { pricePerKg: 77 }); materialsDB.insert({ ...row, pricePerKg: 88, name: "Second copy" }); return { expectPrice: [77, 88] }; },
    "a row with no slug": () => { materialsDB.insert({ name: "No slug", category: "Plastic", process: "cnc", density: 1.1, pricePerKg: 9, active: true }); materialsDB.update(by(materialsDB, SLUG).id, { pricePerKg: 77 }); return { expectPrice: [77] }; },
    "a renamed slug": () => { materialsDB.update(by(materialsDB, SLUG).id, { slug: `${SLUG}-renamed`, pricePerKg: 77 }); return { renamed: `${SLUG}-renamed` }; },
    "rows whose slugs are JavaScript built-in names": () => { for (const s of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) materialsDB.insert({ slug: s, name: `Row ${s}`, category: "Plastic", process: "cnc", density: 1.1, pricePerKg: 9, active: true }); materialsDB.update(by(materialsDB, SLUG).id, { pricePerKg: 77 }); return { expectPrice: [77], builtins: true }; },
    "fields of the wrong type on an edited row": () => { materialsDB.update(by(materialsDB, SLUG).id, { pricePerKg: 77, grades: "not a list", thicknesses: { a: 1 }, machinability: "fast", name: "X".repeat(5000) }); return { expectPrice: [77] }; },
    "an absurd price, a negative price and a text price": () => { const [a, b, c] = Object.keys(v3.materials).filter((s) => defaults.DEFAULT_MATERIALS.some((m) => m.slug === s) && v3.materials[s].pricePerKg).slice(1, 4); materialsDB.update(by(materialsDB, a).id, { pricePerKg: 1e12 }); materialsDB.update(by(materialsDB, b).id, { pricePerKg: -5 }); materialsDB.update(by(materialsDB, c).id, { pricePerKg: "abc" }); return { noUnpriced: true }; },
    "every material deleted": () => { for (const m of materialsDB.getAll()) materialsDB.delete(m.id); return { allMaterialsDeleted: true }; },
    "every finish deleted": () => { for (const f of finishesDB.getAll()) finishesDB.delete(f.id); return { allFinishesDeleted: true }; },
    "one material left, switched off": () => { for (const m of materialsDB.getAll()) if (m.slug !== SLUG) materialsDB.delete(m.id); materialsDB.update(by(materialsDB, SLUG).id, { active: false, pricePerKg: 77 }); return { expectPrice: [77], onlyOne: true }; },
  };
  for (const [label, prepare] of Object.entries(cases)) {
    toV(3);
    const want = prepare();
    const r1 = restart();
    const mid = snapshot();
    const r2 = restart();
    const mats = materialsDB.getAll();
    const notes = [];
    if (r1.threw) notes.push(`THE START THREW: ${r1.threw.message}`);
    if (r2.threw) notes.push(`the second start threw: ${r2.threw.message}`);
    if (snapshot() !== mid) notes.push("a second start changed the catalogue again");
    if (want.expectPrice) { const got = mats.filter((m) => m.slug === SLUG).map((m) => m.pricePerKg); if (!want.expectPrice.every((p) => got.includes(p)) && !r1.lines.some((l) => l.includes(SLUG))) notes.push(`the edited price of ${SLUG} is gone and no line names it (now ${JSON.stringify(got)})`); }
    if (want.renamed && !by(materialsDB, want.renamed)) notes.push("the renamed row was removed");
    if (want.renamed && by(materialsDB, SLUG) && !r1.lines.some((l) => l.includes(SLUG))) notes.push(`${SLUG} came back under its old slug and nothing says so`);
    if (want.builtins && ["__proto__", "constructor", "toString"].some((s) => !by(materialsDB, s))) notes.push("a row with a built-in name was dropped");
    if (want.noUnpriced && unpriced().length) notes.push(`active materials left without a usable price: ${unpriced().join(", ")}`);
    // (Rows that are NEW in the current catalogue arrive whatever the owner had deleted: that is right.
    // What must not come back is a row the old catalogue had and the owner removed.)
    const cameBack = mats.filter((m) => v3.materials[m.slug] && !(want.onlyOne && m.slug === SLUG)).map((m) => m.slug);
    if ((want.allMaterialsDeleted || want.onlyOne) && cameBack.length) notes.push(`materials the owner had deleted are back: ${cameBack.length}`);
    const finsBack = finishesDB.getAll().filter((f) => v3.finishes[f.slug]).length;
    if (want.allFinishesDeleted && finsBack) notes.push(`the owner had deleted every finish; after the SECOND start ${finsBack} of them are back (an empty table is seeded afresh), and that start prints only "Seeding finishes..."`);
    const absurd = mats.filter((m) => Number(m.pricePerKg) > 1e7 || Number(m.pricePerKg) < 0).map((m) => `${m.slug} $${m.pricePerKg}`);
    if (absurd.length) notes.push(`a price that is not a usable amount is in force: ${absurd.join(", ")}`);
    const said = r1.lines.filter((l) => /could NOT keep|kept|stays removed|NOT UPDATED/i.test(l)).length;
    if (r1.threw) R.finding(`${label}: the start fails`, notes.join("; "));
    else if (notes.length) R.finding(`${label}`, `${notes.join("; ")} (lines the start printed about what it kept or could not keep: ${said}; marker afterwards ${marker()})`);
    else R.holds(`${label}: the start does not fail and nothing of the owner's is lost unsaid`, `materials ${mats.length}, finishes ${finishesDB.getAll().length}, lines printed about edits: ${said}, marker afterwards ${marker()}`);
  }

  // ── C. the two older re-seed checks ──
  console.log("\nC. the older re-seed checks (a catalogue in which NO row has a price field the check knows)");
  {
    toV(V);
    // The owner keeps one material and prices it through a field the old check does not read. Not likely; it is what the check does.
    for (const m of materialsDB.getAll()) if (m.slug !== EDIT_A) materialsDB.delete(m.id);
    materialsDB.update(by(materialsDB, EDIT_A).id, { pricePerKg: null, pricePerCm3: null, costPerKg: null, active: false });
    finishesDB.update(finishesDB.getAll()[0].id, { active: false, pricePerPart: 42 });
    const finSlug = finishesDB.getAll()[0].slug;
    const r1 = restart();
    const back = materialsDB.getAll().length;
    const fin = by(finishesDB, finSlug);
    if (back > 1 || !(fin && fin.pricePerPart === 42)) R.info("a catalogue whose only material has no price in any field: the whole catalogue is replaced by the defaults at the next start", `materials after the start: ${back}; the edited finish price is ${fin ? fin.pricePerPart : "gone"}; lines: ${r1.lines.filter((l) => /re-seeding|Seeding/.test(l)).join(" | ")}`);
    else R.holds("a catalogue whose only material has no price is left alone");
  }
  const logged = audit.list({ area: "catalogue", limit: 500 }).length;
  R.info("rows written to the admin change log (area 'catalogue') during this run", String(logged));

  const f = R.done();
  await h.stop();
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
