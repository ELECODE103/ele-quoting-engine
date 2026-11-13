/**
 * The catalogue upgrade (server/config/seed.js + seedCarry.js), tried the awkward ways (re-review 2026-11-12, area 6).
 *
 *   node tools/security/rereview-relaunch/catalogue-upgrade.js
 *
 * A database is put back to seed version 3 (origin/master's catalogue, from seedHistory.js), edited the
 * way the owner edits it in Admin, and the real seed is run on it, as a restart runs it.
 * Exit code 1 when a material is left at a wrong or zero price, a price lands on another material, or
 * something the owner set is lost without a line that says so.
 */
const { liftPacing, report } = require("./lib");
const { start } = require("../../../server/testSupport/harness");
const history = require("../../../server/config/seedHistory");
const defaults = require("../../../server/config/defaults");

(async () => {
  liftPacing();
  const h = await start();
  const R = report();
  const { materialsDB, finishesDB, pricingDB } = h.models;
  const { seedDatabase } = require("../../../server/config/seed");
  const by = (db, slug) => db.getAll().find((r) => r.slug === slug) || null;
  const v3 = history.pricesOf(3), v4 = history.pricesOf(4), v2 = history.pricesOf(2);
  const seeded = JSON.parse(JSON.stringify(materialsDB.getAll()));
  const seededFin = JSON.parse(JSON.stringify(finishesDB.getAll()));
  const setMarker = (v) => { const r = pricingDB.getAll()[0]; const rules = { ...r.rules }; if (v === undefined) delete rules.seedVersion; else rules.seedVersion = v; pricingDB.update(r.id, { rules }); };
  const marker = () => pricingDB.getAll()[0].rules.seedVersion;
  function toVersion(n) {
    const old = history.pricesOf(n);
    for (const m of materialsDB.getAll()) materialsDB.delete(m.id);
    for (const f of finishesDB.getAll()) finishesDB.delete(f.id);
    for (const [slug, p] of Object.entries(old.materials)) {
      const cur = seeded.find((m) => m.slug === slug);
      const { id, createdAt, updatedAt, ...row } = cur || { slug, name: `Old ${slug}`, category: "SLA", process: "3d-printing", subProcess: "sla", density: 1.1, active: true };
      materialsDB.insert({ ...row, pricePerKg: p.pricePerKg ?? null, pricePerCm3: p.pricePerCm3 ?? null });
    }
    for (const [slug, p] of Object.entries(old.finishes)) {
      const cur = seededFin.find((f) => f.slug === slug);
      const { id, createdAt, updatedAt, ...row } = cur || { slug, name: slug, process: "cnc", active: true };
      finishesDB.insert({ ...row, pricePerPart: p.pricePerPart ?? null, pricePerSqIn: p.pricePerSqIn ?? null });
    }
    setMarker(n);
  }
  function restart() { const lines = []; const real = console.log; console.log = (...a) => lines.push(a.join(" ")); try { seedDatabase(); } finally { console.log = real; } return lines; }
  const priceOf = (m) => (m.process === "3d-printing" ? m.pricePerCm3 : (m.pricePerKg || m.costPerKg));
  const zeroPriced = () => materialsDB.getAll().filter((m) => m.active && !(Number(priceOf(m)) > 0)).map((m) => m.slug);

  const gone = Object.keys(v3.materials).filter((s) => !v4.materials[s]);
  const kept = Object.keys(v3.materials).filter((s) => v4.materials[s] && v3.materials[s].pricePerKg);
  const moved = Object.keys(v3.materials).filter((s) => v4.materials[s] && JSON.stringify(v3.materials[s]) !== JSON.stringify(v4.materials[s]));
  console.log(`v3 → v4: ${gone.length} material(s) leave (${gone.join(", ")}), ${Object.keys(v4.materials).length - Object.keys(v3.materials).length + gone.length} arrive, ${moved.length} change default price`);

  // ── 1. v3 → v4 with every kind of edit ──
  console.log("\n1. a version-3 database edited by the owner, then the upgrade");
  toVersion(3);
  const [a, b, c, d, e] = kept;
  materialsDB.update(by(materialsDB, a).id, { pricePerKg: 99.5 });                                   // a plain price edit
  materialsDB.update(by(materialsDB, gone[0]).id, { pricePerCm3: 7.77 });                           // a price on a slug that leaves
  materialsDB.update(by(materialsDB, b).id, { active: false });                                      // "we do not stock this"
  const bMach = by(materialsDB, c).machinability;
  materialsDB.update(by(materialsDB, c).id, { machinability: 0.2, wasteFactor: 0.9 });              // slower to cut, more waste: changes the price
  const dThick = by(materialsDB, d).thicknesses;
  materialsDB.update(by(materialsDB, d).id, { thicknesses: (dThick || []).slice(0, 1), grades: [{ name: "Shop grade", density: 0.05 }] }); // stock list and density
  materialsDB.update(by(materialsDB, e).id, { pricePerKg: null, costPerKg: 55 });                    // priced through the other field the admin form accepts
  materialsDB.insert({ slug: "owner-added-ultem", name: "Ultem (added by owner)", category: "Plastic", process: "cnc", subProcess: "milling", density: 1.27, pricePerKg: 180, machinability: 0.5, active: true });
  const fin = finishesDB.getAll().find((f) => Number(f.pricePerPart) > 0);
  finishesDB.update(fin.id, { pricePerPart: Number(fin.pricePerPart) + 4, active: false });
  const log1 = restart();
  const A = by(materialsDB, a), B = by(materialsDB, b), C = by(materialsDB, c), D = by(materialsDB, d), E = by(materialsDB, e), F = by(finishesDB, fin.slug);
  const said = (re) => log1.some((l) => re.test(l));
  R.check(A.pricePerKg === 99.5, `a price changed by hand is kept (${a})`, `$${A.pricePerKg}`);
  R.check(!by(materialsDB, gone[0]) && said(new RegExp(`could NOT keep.*${gone[0]}`)), `a price on a material that leaves the catalogue is not brought back, and the log says so (${gone[0]})`);
  R.check(marker() === defaults.SEED_VERSION && zeroPriced().length === 0, "the marker is at the new version and no active material is without a price", `marker ${marker()}, unpriced: ${zeroPriced().join(",") || "none"}`);
  if (B.active !== false) R.finding(`a material the owner switched OFF is back ON after the upgrade, and nothing says so (${b})`, `active: ${B.active}; lines in the log naming it: ${log1.filter((l) => l.includes(b)).length}. The site now sells a material the shop said it does not offer.`);
  else R.holds("a switched-off material stays off");
  if (C.machinability !== 0.2) R.finding(`machinability and waste factor the owner set are back at the defaults, and nothing says so (${c})`, `machinability ${C.machinability} (owner had 0.2, default ${bMach}); wasteFactor ${C.wasteFactor}. Both are inputs to the price.`);
  else R.holds("machinability is kept");
  if ((D.thicknesses || []).length !== 1 || (D.grades || [])[0].name !== "Shop grade") R.finding(`the owner's stock thickness list and grade are back at the defaults, and nothing says so (${d})`, `thicknesses ${(D.thicknesses || []).length} (owner had 1), grade ${(D.grades || [])[0] && (D.grades || [])[0].name}`);
  else R.holds("thickness list and grades are kept");
  R.info(`a material priced through costPerKg (the admin form accepts it in place of pricePerKg) (${e})`, `after: pricePerKg ${E.pricePerKg}, costPerKg ${E.costPerKg}; v4 default ${v4.materials[e].pricePerKg}; log lines: ${log1.filter((l) => l.includes(`(${e})`)).map((l) => l.trim().slice(0, 110)).join(" | ") || "none"}`);
  if (E.pricePerKg !== 55 && E.costPerKg !== 55) R.finding(`a price the owner set through costPerKg is lost (${e})`, `the row is priced at ${priceOf(E)} again; the log line about it reads as if a "none" price had been carried`);
  const added = by(materialsDB, "owner-added-ultem");
  if (!added) R.check(said(/owner-added-ultem/), "a material the owner added by hand is deleted by the upgrade; the log says so", log1.filter((l) => /owner-added-ultem/.test(l)).map((l) => l.trim().slice(0, 140)).join(" | ") || "NOT A WORD");
  else R.holds("a material added by hand survives");
  R.check(F.pricePerPart === Number(fin.pricePerPart) + 4, "a finish price changed by hand is kept", `$${F.pricePerPart}`);
  if (F.active !== false) R.finding(`a finish the owner switched OFF is back ON after the upgrade (${fin.slug})`, `active: ${F.active}`);

  // ── 2. run it again: nothing moves ──
  console.log("\n2. a second start");
  const before2 = JSON.stringify([materialsDB.getAll().map((m) => [m.slug, m.pricePerKg, m.pricePerCm3]), finishesDB.getAll().map((f) => [f.slug, f.pricePerPart])]);
  const log2 = restart();
  R.check(before2 === JSON.stringify([materialsDB.getAll().map((m) => [m.slug, m.pricePerKg, m.pricePerCm3]), finishesDB.getAll().map((f) => [f.slug, f.pricePerPart])]) && !log2.some((l) => /Upgrading catalogs/.test(l)), "a second start changes nothing");

  // ── 3. an edit that equals the new default; two versions behind ──
  console.log("\n3. an edit equal to the new default; a database two versions behind");
  toVersion(3);
  const mv = moved[0] || kept[5];
  materialsDB.update(by(materialsDB, mv).id, v4.materials[mv].pricePerKg ? { pricePerKg: v4.materials[mv].pricePerKg } : { pricePerCm3: v4.materials[mv].pricePerCm3 });
  restart();
  R.check(JSON.stringify({ pricePerKg: by(materialsDB, mv).pricePerKg ?? undefined, pricePerCm3: by(materialsDB, mv).pricePerCm3 ?? undefined }) === JSON.stringify({ pricePerKg: v4.materials[mv].pricePerKg, pricePerCm3: v4.materials[mv].pricePerCm3 }), `an edit that happens to equal the new default ends at that figure (${mv})`);
  toVersion(2);
  const k2 = Object.keys(v2.materials).find((s) => v4.materials[s] && v2.materials[s].pricePerKg);
  materialsDB.update(by(materialsDB, k2).id, { pricePerKg: 42.42 });
  const log3 = restart();
  const untouched = Object.keys(v2.materials).filter((s) => v4.materials[s] && s !== k2).filter((s) => JSON.stringify([by(materialsDB, s).pricePerKg ?? null, by(materialsDB, s).pricePerCm3 ?? null]) !== JSON.stringify([v4.materials[s].pricePerKg ?? null, v4.materials[s].pricePerCm3 ?? null]));
  R.check(by(materialsDB, k2).pricePerKg === 42.42 && untouched.length === 0 && marker() === 4, "version 2 → 4: the edited price is kept and every other material is at the version-4 default", `${k2} $${by(materialsDB, k2).pricePerKg}; not at the v4 default: ${untouched.join(",") || "none"}`);

  // ── 4. the version marker ──
  console.log("\n4. a database already on version 4, with prices the owner has changed, and a marker that is missing or wrong");
  for (const [label, value] of [["missing", undefined], ["null", null], ["0", 0], ["the text \"4\"", "4"], ["the text \"abc\"", "abc"], ["3 (one behind, on a version-4 catalogue)", 3], ["99", 99], ["-1", -1], ["4.5", 4.5]]) {
    toVersion(4);
    const k = Object.keys(v4.materials).find((s) => v4.materials[s].pricePerKg);
    materialsDB.update(by(materialsDB, k).id, { pricePerKg: 123.45 });
    const newest = Object.keys(v4.materials).find((s) => !v3.materials[s]);
    materialsDB.update(by(materialsDB, newest).id, v4.materials[newest].pricePerCm3 ? { pricePerCm3: 9.99 } : { pricePerKg: 9.99 });
    setMarker(value);
    const log = restart();
    const kNow = by(materialsDB, k).pricePerKg, nNow = by(materialsDB, newest);
    const nKept = nNow && (nNow.pricePerCm3 === 9.99 || nNow.pricePerKg === 9.99);
    const reseeded = log.some((l) => /Upgrading catalogs/.test(l));
    const detail = `re-seeded: ${reseeded}; ${k} now $${kNow} (owner had 123.45); ${newest} ${nKept ? "kept" : "back at the default"}; marker now ${JSON.stringify(marker())}; log: ${log.filter((l) => /Catalogue|Upgrading/.test(l)).map((l) => l.trim().slice(0, 150)).join(" | ") || "nothing"}`;
    if (kNow !== 123.45 || !nKept) R.finding(`marker ${label}: prices the owner changed on a version-4 database are overwritten at the next start`, detail);
    else R.holds(`marker ${label}: the owner's prices stand`, detail);
  }

  // ── 5. can the owner's own buttons move the marker? ──
  console.log("\n5. the owner's own buttons: reset the rules, restore an old save");
  toVersion(4); setMarker(4);
  const owner = await h.admin("Owner");
  const save = await h.put("/api/admin/pricing", { rules: { shippingBaseRate: 13 }, note: "re-review" }, owner);
  const reset = await h.post("/api/admin/pricing/reset", { note: "re-review reset" }, owner);
  const hist = (await h.get("/api/admin/pricing/history", owner)).body;
  const oldest = Array.isArray(hist) ? hist[hist.length - 1] : (hist.entries || [])[(hist.entries || []).length - 1];
  const restore = oldest ? await h.post(`/api/admin/pricing/restore/${oldest.id}`, {}, owner) : { status: "no history" };
  R.check(marker() === 4, "after a save, a reset and a restore the marker is still 4", `save ${save.status}, reset ${reset.status}, restore ${restore.status}; marker ${JSON.stringify(marker())}`);

  // ── 6. could a carried price land on a different material? ──
  console.log("\n6. slugs that mean something else in the new catalogue");
  const names3 = Object.fromEntries(seeded.map((m) => [m.slug, m.name]));
  const fieldMoved = Object.keys(v3.materials).filter((s) => v4.materials[s] && Object.keys(v3.materials[s]).join() !== Object.keys(v4.materials[s]).join());
  R.check(fieldMoved.length === 0, "no slug is priced by a different field in version 4 than in version 3", fieldMoved.join(",") || `${Object.keys(v3.materials).filter((s) => v4.materials[s]).length} shared slugs checked`);
  R.info("whether a shared slug names the same material in both versions cannot be checked from the repository: seedHistory.js records prices only, not names", `version-4 names are in defaults.js (${Object.keys(names3).length}); version-3 names were read by eye against origin/master (see the report)`);

  const f = R.done();
  await h.stop();
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
