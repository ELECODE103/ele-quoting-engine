/**
 * Prices the owner changed by hand survive a catalogue upgrade.
 *
 * When SEED_VERSION goes up, seed.js replaces the materials and finishes with the new catalogue.
 * Before it does, `collect` reads the old rows and picks out every price that is NOT the default of
 * the version the database was on (seedHistory.js): those are the owner's. After the new catalogue is
 * in, `apply` puts each of them back on the row with the same slug.
 *
 *   carried        the slug is in the new catalogue and is priced by the same field: the owner's price
 *                  replaces the new default
 *   not carried    the slug is gone from the catalogue (it is not brought back), the row was added by
 *                  hand and is not in the catalogue, the new catalogue prices it by another field, or the
 *                  stored price is not a usable amount
 *   everything else takes the new catalogue: a price that was simply the old default gets the new default
 *
 * Every carried price and every one that could not be carried is one line in the start-up log and one
 * row in the admin change log (area "catalogue"); `latest()` reads the newest upgrade back for the
 * admin pricing page. Nothing is carried from a version whose default prices are not on record: there
 * is no way to tell an edited price from a default then, and that is said in the log, once.
 */
const { PRICE_FIELDS, pricesOf } = require("./seedHistory");

const FIELD_WORDS = { pricePerKg: "price per kg", pricePerCm3: "price per cm³", pricePerPart: "price per part", pricePerSqIn: "price per sq in" };
const KIND_WORDS = { material: "material", finish: "finish" };

const amount = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const same = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9);
/** A material is never stored without a price above zero; a finish may cost nothing. */
const usable = (kind, v) => v !== null && (kind === "material" ? v > 0 : v >= 0) && v < 1e7;
const dollars = (v) => (v === null ? "none" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`);

/**
 * The prices in the old catalogue rows that are not the defaults of `fromVersion`.
 * @param {{fromVersion: number, materials: object[], finishes: object[]}} old
 * @returns {{fromVersion: number, known: boolean, edited: Array<{kind, slug, name, field, yours, oldDefault, addedByHand}>}}
 */
function collect({ fromVersion, materials = [], finishes = [] }) {
  const history = pricesOf(fromVersion);
  if (!history) return { fromVersion, known: false, edited: [] };
  const edited = [];
  const scan = (kind, rows, defaults) => {
    for (const row of rows) {
      if (!row || typeof row.slug !== "string" || !row.slug) continue;
      const seeded = Object.prototype.hasOwnProperty.call(defaults, row.slug) ? defaults[row.slug] : null;
      for (const field of PRICE_FIELDS[kind]) {
        const yours = amount(row[field]);
        const oldDefault = seeded ? amount(seeded[field]) : null;
        // A row that was never in the catalogue (added or duplicated in Admin): its prices are all the owner's.
        if (seeded ? same(yours, oldDefault) : yours === null) continue;
        edited.push({ kind, slug: row.slug, name: String(row.name || row.slug).slice(0, 80), field, yours, oldDefault, addedByHand: !seeded });
      }
    }
  };
  scan("material", materials, history.materials);
  scan("finish", finishes, history.finishes);
  return { fromVersion, known: true, edited };
}

/**
 * Put the collected prices on the new catalogue's rows.
 * @returns {{from, to, known, kept: object[], notKept: object[]}} what was done (also logged and recorded)
 */
function apply(collected, { materialsDB, finishesDB, toVersion, log = console.log, audit = require("../services/audit") }) {
  const result = { from: collected.fromVersion, to: toVersion, known: collected.known, kept: [], notKept: [] };
  if (!collected.known) {
    log(`  Catalogue: the default prices of seed v${collected.fromVersion} are not on record, so a price changed by hand cannot be told from a default. No price was carried over: check Admin → Materials and Finishes against your own figures.`);
    return result;
  }
  const tables = { material: materialsDB, finish: finishesDB };
  const upgrade = `catalogue-v${collected.fromVersion}-v${toVersion}`;
  for (const e of collected.edited) {
    const row = tables[e.kind].getAll().find((r) => r.slug === e.slug) || null;
    const newDefault = row ? amount(row[e.field]) : null;
    let reason = "";
    if (!row) reason = e.addedByHand ? `this ${KIND_WORDS[e.kind]} was added by hand and is not in the new catalogue` : `this ${KIND_WORDS[e.kind]} is no longer in the catalogue`;
    else if (newDefault === null) reason = `the new catalogue does not set a ${FIELD_WORDS[e.field]} for this ${KIND_WORDS[e.kind]}`;
    else if (!usable(e.kind, e.yours)) reason = "the stored figure is not a usable price";
    if (reason) {
      result.notKept.push({ ...e, reason });
      log(`  Catalogue: could NOT keep your ${FIELD_WORDS[e.field]} for ${e.name} (${e.slug}), ${dollars(e.yours)}: ${reason}.`);
      audit.record({ actor: null, area: "catalogue", action: "price-not-kept", target: `${e.kind}:${e.slug}`, entityId: upgrade, changes: { [e.field]: [e.yours, null] }, note: `Catalogue v${collected.fromVersion} to v${toVersion}: ${e.name}. Not kept: ${reason}.` });
      continue;
    }
    if (same(e.yours, newDefault)) continue; // the new catalogue already has the owner's figure
    tables[e.kind].update(row.id, { [e.field]: e.yours });
    result.kept.push({ ...e, newDefault });
    log(`  Catalogue: kept your ${FIELD_WORDS[e.field]} for ${e.name} (${e.slug}): ${dollars(e.yours)} (the new catalogue's default is ${dollars(newDefault)}).`);
    audit.record({ actor: null, area: "catalogue", action: "price-kept", target: `${e.kind}:${e.slug}`, entityId: upgrade, changes: { [e.field]: [newDefault, e.yours] }, note: `Catalogue v${collected.fromVersion} to v${toVersion}: ${e.name}. Your price was kept; the default was ${dollars(e.oldDefault)} and is now ${dollars(newDefault)}.` });
  }
  if (collected.edited.length === 0) log(`  Catalogue: no price had been changed by hand, so there was nothing to carry over.`);
  else log(`  Catalogue: ${result.kept.length} price(s) you had changed were kept, ${result.notKept.length} could not be. The list is in Admin → Pricing.`);
  return result;
}

/**
 * The most recent catalogue upgrade that carried, or failed to carry, a price: for the admin pricing page.
 * @returns {null | {from: number, to: number, at: string, kept: object[], notKept: object[]}}
 */
function latest(audit = require("../services/audit")) {
  const rows = audit.list({ area: "catalogue", limit: 1000 }).filter((r) => /^catalogue-v\d+-v\d+$/.test(String(r.entityId || "")) && ["price-kept", "price-not-kept"].includes(r.action));
  if (rows.length === 0) return null;
  const newest = rows[0].entityId; // audit.list is newest first
  const [, from, to] = /^catalogue-v(\d+)-v(\d+)$/.exec(newest);
  const out = { from: Number(from), to: Number(to), at: rows[0].createdAt || null, kept: [], notKept: [] };
  for (const r of rows.filter((x) => x.entityId === newest).reverse()) {
    const [kind, slug] = String(r.target || "").split(":");
    for (const [field, pair] of Object.entries(r.changes || {})) {
      const name = (/^Catalogue v\d+ to v\d+: (.*?)\. (?:Not kept|Your price was kept)/.exec(String(r.note || "")) || [])[1] || slug;
      if (r.action === "price-kept") out.kept.push({ kind, slug, name, field, fieldLabel: FIELD_WORDS[field] || field, yours: pair[1], newDefault: pair[0] });
      else out.notKept.push({ kind, slug, name, field, fieldLabel: FIELD_WORDS[field] || field, yours: pair[0], reason: (/Not kept: (.*)\.$/.exec(String(r.note || "")) || [])[1] || "" });
    }
  }
  return out;
}

module.exports = { collect, apply, latest, FIELD_WORDS };
