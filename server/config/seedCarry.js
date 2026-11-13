/**
 * What the owner changed by hand survives a catalogue upgrade.
 *
 * When SEED_VERSION goes up, seed.js brings the materials and finishes of an existing database to
 * the new catalogue. Until 2026-11-13 it replaced every row and put back prices only: a material
 * the owner had switched off came back on sale, and machinability, the thickness list, grades and a
 * price set through "cost per kg" went back to the defaults without a word (re-review 2026-11-12,
 * F-10). And a version marker that was missing or damaged was read as "the oldest version", which
 * replaced everything (F-11).
 *
 * Now each row is merged, field by field, by slug. Three things are compared: the row as it is in
 * the database, the catalogue the database was seeded from (seedSnapshots/v<N>.json, every field of
 * every row of that version), and the new catalogue.
 *
 *   a field that still holds the old catalogue's value    takes the new catalogue's value
 *   a field the owner changed (anything else)             keeps the owner's value
 *   a row the owner added (its slug was never in the      kept whole, as it is
 *     catalogue), or changed, whose slug the new
 *     catalogue also has
 *   a row the owner deleted                               stays deleted
 *   a row whose slug left the catalogue                   removed, as before; every field the owner
 *                                                         had changed on it is reported
 *   a carried price that is not a usable amount, or a     not carried: the new catalogue's price is
 *     material left with no price at all                  used and the figure is reported
 *
 * "Every field" is every field the tables store (STORED below). Three fields of a material that the
 * admin form shows are NOT stored by the database and never have been (materialClass, stockForms,
 * wasteFactor: the pricing uses its built-in values for them), so there is nothing of the owner's
 * to carry there.
 *
 * Every carried change and every one that could not be carried is one line in the start-up log and
 * one row in the admin change log (area "catalogue"); `latest()` reads the newest upgrade back for
 * the admin pricing page.
 *
 * The version marker (rules.seedVersion). Only a whole number from 1 to the current version is a
 * version. When the catalogue has rows and the marker is missing, is not such a number, or names a
 * version whose catalogue is not on record, the version the rows came from cannot be established:
 * NOTHING is replaced, nothing is added, the rows stay exactly as they are, and that is said loudly
 * in the log, recorded in the change log and shown on the admin pricing page (`unknownOrigin`).
 */
const { PRICE_FIELDS, catalogueOf } = require("./seedHistory");

/** The fields each table stores (models/database.js), less the row's own bookkeeping. A test holds this against a stored row. */
const STORED = {
  material: ["name", "category", "process", "subProcess", "density", "costPerKg", "pricePerKg", "pricePerCm3", "machinability", "defaultLayerHeight", "color", "grades", "thicknesses", "layerHeights", "feedClass", "active", "description"],
  finish: ["name", "process", "pricePerPart", "pricePerSqIn", "costPerDm2", "minCost", "leadDays", "active"],
};
const NUMERIC = new Set(["density", "costPerKg", "pricePerKg", "pricePerCm3", "machinability", "defaultLayerHeight", "pricePerPart", "pricePerSqIn", "costPerDm2", "minCost", "leadDays"]);
/** Every field that is an amount of money (a material may be priced through costPerKg when pricePerKg is empty). */
const MONEY = { material: ["pricePerKg", "pricePerCm3", "costPerKg"], finish: ["pricePerPart", "pricePerSqIn", "costPerDm2", "minCost"] };

const FIELD_WORDS = {
  pricePerKg: "price per kg", pricePerCm3: "price per cm³", pricePerPart: "price per part", pricePerSqIn: "price per sq in",
  costPerKg: "cost per kg", costPerDm2: "price per dm²", minCost: "minimum charge", leadDays: "lead days",
  active: "on/off switch", name: "name", category: "category", process: "process", subProcess: "sub-process", density: "density",
  machinability: "machinability", defaultLayerHeight: "default layer height", color: "colour", grades: "grades", thicknesses: "thickness list",
  layerHeights: "layer heights", feedClass: "feed class", description: "description",
};
const KIND_WORDS = { material: "material", finish: "finish" };

const blank = (v) => v === null || v === undefined || v === "";
const amount = (v) => (blank(v) || !Number.isFinite(Number(v)) ? null : Number(v));
/** A stored value in the one form two values are compared in: nothing is null, a number field is a number, lists and objects have their keys in order. */
function norm(field, v) {
  if (blank(v)) return null;
  if (NUMERIC.has(field)) return amount(v);
  if (field === "active") return Boolean(v);
  return v;
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => !blank(v[k])).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function same(field, a, b) {
  const x = norm(field, a), y = norm(field, b);
  if (x === null || y === null) return x === y;
  if (typeof x === "number" && typeof y === "number") return Math.abs(x - y) <= 1e-9;
  return canonical(x) === canonical(y);
}
/** A material is never stored without a price above zero; a finish may cost nothing. */
const usable = (kind, v) => v !== null && (kind === "material" ? v > 0 : v >= 0) && v < 1e7;
const dollars = (v) => (v === null || v === undefined ? "none" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`);
const isMoney = (kind, field) => MONEY[kind].includes(field);
/** A value as a person reads it in the log and on the admin page. */
function show(kind, field, v) {
  const n = norm(field, v);
  if (n === null) return "none";
  if (isMoney(kind, field)) return dollars(n);
  if (field === "active") return n ? "on" : "off";
  if (typeof n === "number") return String(n);
  if (typeof n === "string") return n.length > 60 ? `"${n.slice(0, 57)}…"` : `"${n}"`;
  if (Array.isArray(n)) {
    if (field === "thicknesses") return `${n.length} thickness${n.length === 1 ? "" : "es"}`;
    if (field === "grades") return `${n.length} grade${n.length === 1 ? "" : "s"}${n.length && n[0] && n[0].name ? ` (${n.slice(0, 3).map((g) => g && g.name).filter(Boolean).join(", ")}${n.length > 3 ? ", …" : ""})` : ""}`;
    const text = JSON.stringify(n);
    return text.length > 60 ? `${n.length} entries` : text;
  }
  const text = JSON.stringify(n);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
const nameOf = (row, slug) => String((row && row.name) || slug).slice(0, 80);
/** What a material is priced by: per cm³ when printed, otherwise per kg (through either field). */
function effectivePrice(kind, row) {
  if (kind !== "material") return 1;
  return row.process === "3d-printing" ? amount(row.pricePerCm3) : (amount(row.pricePerKg) || amount(row.costPerKg));
}

/**
 * Read the version marker of a database.
 * @param {object|null|undefined} rulesRow  the pricing-rules row ({ rules: { seedVersion } }), or nothing when there is none
 * @param {number} current                  SEED_VERSION
 * @returns {{ state: "valid"|"missing"|"invalid"|"ahead", version: number|null, raw: any }}
 */
function readMarker(rulesRow, current) {
  const rules = rulesRow && rulesRow.rules && typeof rulesRow.rules === "object" ? rulesRow.rules : null;
  const raw = rules ? rules.seedVersion : undefined;
  if (raw === undefined || raw === null) return { state: "missing", version: null, raw: raw === undefined ? null : raw };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return { state: "invalid", version: null, raw };
  if (raw > current) return { state: "ahead", version: raw, raw };
  return { state: "valid", version: raw, raw };
}

/**
 * Work out one table's upgrade. Pure: nothing is read or written.
 * @param {"material"|"finish"} kind
 * @param {object[]} rows      the table as it is
 * @param {Object<string, object>} oldSeed  the catalogue the database was seeded from, by slug
 * @param {object[]} newSeed   the new catalogue, in its order
 * @returns {{ final: object[], kept: object[], notKept: object[] }}  `final`: the rows the table should hold, in order
 */
function plan(kind, rows, oldSeed, newSeed) {
  const fields = STORED[kind];
  const kept = [], notKept = [], final = [];
  const bySlug = new Map();
  const extras = []; // rows with no slug, or a second row of a slug: nothing can be matched, so they are left as they are
  for (const row of rows) {
    if (!row || typeof row.slug !== "string" || !row.slug || bySlug.has(row.slug)) { if (row) extras.push(row); continue; }
    bySlug.set(row.slug, row);
  }
  const has = (o, slug) => Object.prototype.hasOwnProperty.call(o, slug);
  const inNew = new Set(newSeed.map((r) => r.slug));

  for (const fresh of newSeed) {
    const slug = fresh.slug;
    const mine = bySlug.get(slug);
    const old = has(oldSeed, slug) ? oldSeed[slug] : null;
    if (!mine) {
      // In the catalogue the database came from and not in the database: the owner deleted it.
      if (old) kept.push({ kind, slug, name: nameOf(old, slug), field: null, what: "removed", yours: null, newDefault: null });
      else final.push({ ...fresh });
      continue;
    }
    const name = nameOf(mine, slug);
    const merged = { ...fresh, id: mine.id, createdAt: mine.createdAt };
    const carried = []; // [field, yours, newDefault]
    for (const field of fields) {
      // Never in the old catalogue: the whole row is the owner's own.
      const edited = old ? !same(field, mine[field], old[field]) : true;
      if (!edited || same(field, mine[field], fresh[field])) continue;
      const yours = norm(field, mine[field]);
      if (isMoney(kind, field) && yours !== null && !usable(kind, yours)) {
        notKept.push({ kind, slug, name, field, yours, oldDefault: old ? norm(field, old[field]) : null, reason: "the stored figure is not a usable price" });
        continue;
      }
      if (kind === "finish" && PRICE_FIELDS.finish.includes(field) && yours === null) {
        notKept.push({ kind, slug, name, field, yours, oldDefault: old ? norm(field, old[field]) : null, reason: "the stored figure is not a usable price" });
        continue;
      }
      merged[field] = yours;
      carried.push([field, yours, norm(field, fresh[field])]);
    }
    // A material must end with a price. If clearing a price left it with none, the cleared fields take the new catalogue's figure.
    if (!(effectivePrice(kind, merged) > 0)) {
      for (let i = carried.length - 1; i >= 0; i--) {
        const [field, yours] = carried[i];
        if (!isMoney(kind, field) || yours !== null) continue;
        merged[field] = fresh[field];
        carried.splice(i, 1);
        notKept.push({ kind, slug, name, field, yours, oldDefault: old ? norm(field, old[field]) : null, reason: "the stored figure is not a usable price" });
      }
    }
    for (const [field, yours, newDefault] of carried) kept.push({ kind, slug, name, field, what: "field", yours, newDefault, oldDefault: old ? norm(field, old[field]) : null });
    final.push(merged);
  }

  for (const [slug, mine] of bySlug) {
    if (inNew.has(slug)) continue;
    const name = nameOf(mine, slug);
    if (!has(oldSeed, slug)) {
      // Added by hand (or duplicated in Admin): it is the owner's, and it stays.
      final.push({ ...mine });
      kept.push({ kind, slug, name, field: null, what: "added", yours: null, newDefault: null });
      continue;
    }
    // It left the catalogue: not brought back. What the owner had changed on it is reported.
    const old = oldSeed[slug];
    for (const field of fields) {
      if (same(field, mine[field], old[field])) continue;
      notKept.push({ kind, slug, name, field, yours: norm(field, mine[field]), oldDefault: norm(field, old[field]), reason: `this ${KIND_WORDS[kind]} is no longer in the catalogue` });
    }
  }
  for (const row of extras) final.push({ ...row });
  return { final, kept, notKept };
}

/**
 * Bring the materials and finishes to the new catalogue, keeping what the owner changed.
 * Call inside one database change (seed.js does). Logs and records every change kept or not kept.
 * @returns {{ from, to, known: true, kept: object[], notKept: object[] }}
 */
function upgrade({ fromVersion, toVersion, oldCatalogue, newMaterials, newFinishes, materialsDB, finishesDB, log = console.log, audit = require("../services/audit") }) {
  const tables = [["material", materialsDB, oldCatalogue.materials, newMaterials], ["finish", finishesDB, oldCatalogue.finishes, newFinishes]];
  const result = { from: fromVersion, to: toVersion, known: true, kept: [], notKept: [] };
  for (const [kind, db, oldSeed, newSeed] of tables) {
    const rows = db.getAll();
    const p = plan(kind, rows, oldSeed, newSeed);
    for (const row of rows) db.delete(row.id);
    for (const row of p.final) db.insert(row);
    result.kept.push(...p.kept);
    result.notKept.push(...p.notKept);
  }
  report(result, { log, audit });
  return result;
}

function report(result, { log, audit }) {
  const id = `catalogue-v${result.from}-v${result.to}`;
  const versions = `Catalogue v${result.from} to v${result.to}`;
  for (const e of result.notKept) {
    const words = FIELD_WORDS[e.field] || e.field;
    log(`  Catalogue: could NOT keep your ${words} for ${e.name} (${e.slug}), ${show(e.kind, e.field, e.yours)}: ${e.reason}.`);
    audit.record({ actor: null, area: "catalogue", action: ACTIONS[isPriceField(e) ? "price" : "edit"].notKept, target: `${e.kind}:${e.slug}`, entityId: id, changes: { [e.field]: [e.yours, null] }, note: `${versions}: ${e.name}. Not kept: ${e.reason}.` });
  }
  for (const e of result.kept) {
    const thing = KIND_WORDS[e.kind];
    if (e.what === "added") {
      log(`  Catalogue: kept ${e.name} (${e.slug}), a ${thing} you added by hand: it is not in the catalogue and was left as it is.`);
      audit.record({ actor: null, area: "catalogue", action: "row-kept", target: `${e.kind}:${e.slug}`, entityId: id, changes: {}, note: `${versions}: ${e.name}. Kept: you added this ${thing} by hand; it was left as it is.` });
    } else if (e.what === "removed") {
      log(`  Catalogue: ${e.name} (${e.slug}) stays removed: you had deleted this ${thing}, and the new catalogue still lists it. Add it again in Admin if you want it back.`);
      audit.record({ actor: null, area: "catalogue", action: "removal-kept", target: `${e.kind}:${e.slug}`, entityId: id, changes: {}, note: `${versions}: ${e.name}. Kept: you had deleted this ${thing}; it was not added back.` });
    } else {
      const words = FIELD_WORDS[e.field] || e.field;
      if (e.yours === null) log(`  Catalogue: kept the ${words} for ${e.name} (${e.slug}) empty, as you had it (the new catalogue's default is ${show(e.kind, e.field, e.newDefault)}).`);
      else log(`  Catalogue: kept your ${words} for ${e.name} (${e.slug}): ${show(e.kind, e.field, e.yours)} (the new catalogue's default is ${show(e.kind, e.field, e.newDefault)}).`);
      audit.record({
        actor: null, area: "catalogue", action: ACTIONS[isPriceField(e) ? "price" : "edit"].kept, target: `${e.kind}:${e.slug}`, entityId: id, changes: { [e.field]: [e.newDefault, e.yours] },
        note: isPriceField(e)
          ? `${versions}: ${e.name}. Your price was kept; the default was ${dollars(e.oldDefault)} and is now ${dollars(e.newDefault)}.`
          : `${versions}: ${e.name}. Kept: your ${words}, ${show(e.kind, e.field, e.yours)}; the new catalogue's default is ${show(e.kind, e.field, e.newDefault)}.`,
      });
    }
  }
  if (result.kept.length === 0 && result.notKept.length === 0) log("  Catalogue: no price had been changed by hand and no other setting either, so there was nothing to carry over.");
  else log(`  Catalogue: ${result.kept.length} change(s) you had made by hand were kept, ${result.notKept.length} could not be. The list is in Admin → Pricing.`);
}
// The change log's names for what happened to one field (a price keeps the names it had before 2026-11-13).
const ACTIONS = { price: { kept: "price-kept", notKept: "price-not-kept" }, edit: { kept: "edit-kept", notKept: "edit-not-kept" } };
const isPriceField = (e) => Boolean(e.field) && PRICE_FIELDS[e.kind].includes(e.field);

/**
 * The catalogue has rows and the version they came from cannot be established: nothing is touched.
 * Said loudly in the log (every start, until the marker is right), and recorded once in the change log.
 * @param {{ marker: object, toVersion: number, materialsDB, finishesDB, newMaterials: object[], newFinishes: object[] }} o
 * @returns {{ from: null, to: number, known: false, reason: string, missing: string[] }}
 */
function unknownOrigin({ marker, toVersion, materialsDB, finishesDB, newMaterials, newFinishes, log = console.error, audit = require("../services/audit") }) {
  const stored = marker.state === "missing" ? "missing" : JSON.stringify(marker.raw);
  const why = marker.state === "missing" ? "the catalogue version recorded with the pricing rules is missing"
    : marker.state === "invalid" ? `the catalogue version recorded with the pricing rules is not a version number (${stored})`
      : marker.state === "ahead" ? `the database says its catalogue is version ${marker.version}, which is newer than this code's version ${toVersion}`
        : `the catalogue of version ${marker.version} is not on record, so a change made by hand cannot be told from a default`;
  const have = { material: new Set(materialsDB.getAll().map((r) => r.slug)), finish: new Set(finishesDB.getAll().map((r) => r.slug)) };
  const missing = [
    ...newMaterials.filter((r) => !have.material.has(r.slug)).map((r) => `material ${r.name} (${r.slug})`),
    ...newFinishes.filter((r) => !have.finish.has(r.slug)).map((r) => `finish ${r.name} (${r.slug})`),
  ];
  const sentence = `The material and finish lists were NOT updated to catalogue version ${toVersion}: ${why}. Nothing was replaced and nothing was added: every material and finish is exactly as it was.`;
  log("════════════════════════════════════════════════════════════════════");
  log(`CATALOGUE NOT UPDATED: ${sentence}`);
  if (missing.length) log(`  In the current catalogue and not in this database (${missing.length}): ${missing.slice(0, 40).join("; ")}${missing.length > 40 ? "; …" : ""}. Add the ones you want in Admin → Materials / Finishes.`);
  log("  Check Admin → Materials and Finishes against what you sell before taking orders.");
  log("════════════════════════════════════════════════════════════════════");
  const id = `catalogue-kept-v${toVersion}-${marker.state}${marker.state === "ahead" ? `-${marker.version}` : ""}`;
  // A marker that is missing or senseless is put right by seed.js after this, so this is said once.
  // A database newer than the code stays that way until the code is: said at every start, recorded once.
  const already = marker.state === "ahead" && audit.list({ area: "catalogue", entityId: id, limit: 5 }).some((r) => r.action === "catalogue-kept-as-is");
  if (!already) {
    audit.record({ actor: null, area: "catalogue", action: "catalogue-kept-as-is", target: "catalogue", entityId: id, changes: { seedVersion: [marker.state === "missing" ? null : marker.raw, marker.state === "ahead" ? marker.raw : toVersion] },
      // (A change-log note holds 500 characters: the names are in the start-up log.)
      note: `${sentence}${missing.length ? ` ${missing.length} entr${missing.length === 1 ? "y" : "ies"} of the current catalogue ${missing.length === 1 ? "is" : "are"} not in yours; the start-up log names ${missing.length === 1 ? "it" : "them"}.` : ""}` });
  }
  return { from: null, to: toVersion, known: false, reason: why, missing };
}

/**
 * The most recent catalogue upgrade that carried, or failed to carry, something, or the most recent
 * time the catalogue was left alone because its version could not be established: for the admin pricing page.
 * @returns {null | {from: number|null, to: number, at: string, kept: object[], notKept: object[], notice?: string}}
 */
function latest(audit = require("../services/audit")) {
  const KEPT = ["price-kept", "edit-kept", "row-kept", "removal-kept"];
  const NOT_KEPT = ["price-not-kept", "edit-not-kept"];
  const rows = audit.list({ area: "catalogue", limit: 1000 }).filter((r) => (/^catalogue-v\d+-v\d+$/.test(String(r.entityId || "")) && [...KEPT, ...NOT_KEPT].includes(r.action)) || r.action === "catalogue-kept-as-is");
  if (rows.length === 0) return null;
  const first = rows[0]; // audit.list is newest first
  if (first.action === "catalogue-kept-as-is") {
    const to = Number((/^catalogue-kept-v(\d+)-/.exec(String(first.entityId || "")) || [])[1]) || null;
    return { from: null, to, at: first.createdAt || null, kept: [], notKept: [], notice: String(first.note || "") };
  }
  const newest = first.entityId;
  const [, from, to] = /^catalogue-v(\d+)-v(\d+)$/.exec(newest);
  const out = { from: Number(from), to: Number(to), at: first.createdAt || null, kept: [], notKept: [] };
  for (const r of rows.filter((x) => x.entityId === newest).reverse()) {
    const [kind, slug] = String(r.target || "").split(":");
    const name = (/^Catalogue v\d+ to v\d+: (.*?)\. (?:Not kept|Your price was kept|Kept)/.exec(String(r.note || "")) || [])[1] || slug;
    if (r.action === "row-kept" || r.action === "removal-kept") {
      out.kept.push({ kind, slug, name, field: null, fieldLabel: "", what: r.action === "row-kept" ? "added" : "removed", text: r.action === "row-kept" ? "added by you: left as it is" : "deleted by you: not added back" });
      continue;
    }
    for (const [field, pair] of Object.entries(r.changes || {})) {
      const fieldLabel = FIELD_WORDS[field] || field;
      if (KEPT.includes(r.action)) out.kept.push({ kind, slug, name, field, fieldLabel, yours: pair[1], newDefault: pair[0], yoursText: show(kind, field, pair[1]), newDefaultText: show(kind, field, pair[0]) });
      else out.notKept.push({ kind, slug, name, field, fieldLabel, yours: pair[0], yoursText: show(kind, field, pair[0]), reason: (/Not kept: (.*)\.$/.exec(String(r.note || "")) || [])[1] || "" });
    }
  }
  return out;
}

module.exports = { STORED, readMarker, plan, upgrade, unknownOrigin, latest, FIELD_WORDS, catalogueOf };
