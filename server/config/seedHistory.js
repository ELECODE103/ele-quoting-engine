/**
 * The catalogue prices each seed version shipped with (server/config/defaults.js at that version).
 *
 * Why this exists. When SEED_VERSION goes up, server/config/seed.js replaces the materials and finishes in an
 * existing database with the new catalogue. A price the owner changed by hand in Admin must survive that; a price
 * that was simply the old default must not (it takes the new default). The only way to tell the two apart is to
 * know what the old default WAS. server/config/seedCarry.js reads it from here.
 *
 * Where the figures come from (git, read 2026-11-12):
 *   version 2   server/config/defaults.js at commit d38c1fe
 *   version 3   server/config/defaults.js at commit 2105c0b, which is the file on origin/master: the one
 *               commit that carried version 3, so every database seeded at version 3 was seeded with these
 *   version 4   the file as it is now (commit 1dbc763: the eight-resin SLA catalogue)
 * Versions 2 and 3 have the same prices for every material and finish (the bump changed other fields).
 * Version 1 predates slugs with prices on record here; a database still on it carries nothing across.
 *
 * WHEN YOU BUMP SEED_VERSION: add the new version here, with the prices of the new catalogue, and write
 * its whole-catalogue file (see catalogueOf at the end of this file). The test (seedCarry.test.js) fails
 * until both equal the current defaults.
 *
 * Only prices are listed: materials by slug (pricePerKg for stock sold by weight, pricePerCm3 for printed
 * materials), finishes by slug (pricePerPart, pricePerSqIn). A field that is absent was not set in that version.
 */
const V3_MATERIALS = {
  "mild-steel": { pricePerKg: 1.1 },
  "stainless-304": { pricePerKg: 3.8 },
  "stainless-316": { pricePerKg: 5.2 },
  "aluminum-5052": { pricePerKg: 4.5 },
  "aluminum-6061": { pricePerKg: 5 },
  "copper-c110": { pricePerKg: 12 },
  "brass-c260": { pricePerKg: 8.5 },
  "cnc-delrin": { pricePerKg: 11 },
  "cnc-uhmw": { pricePerKg: 7.5 },
  "cnc-hdpe": { pricePerKg: 6 },
  "cnc-nylon": { pricePerKg: 13 },
  "cnc-peek": { pricePerKg: 130 },
  "cnc-ultem": { pricePerKg: 65 },
  "cnc-ptfe": { pricePerKg: 28 },
  "cnc-polycarbonate": { pricePerKg: 10 },
  "cnc-acrylic": { pricePerKg: 8 },
  "cnc-pvc": { pricePerKg: 6 },
  "cnc-polypropylene": { pricePerKg: 6 },
  "cnc-g10": { pricePerKg: 22 },
  "cnc-phenolic": { pricePerKg: 19 },
  "cnc-aluminum-6061": { pricePerKg: 7 },
  "cnc-brass-360": { pricePerKg: 12 },
  "cnc-aluminum-7075": { pricePerKg: 10 },
  "cnc-stainless-304": { pricePerKg: 6 },
  "cnc-mild-steel-1018": { pricePerKg: 3 },
  "rt-hdpe": { pricePerKg: 5.5 },
  "rt-uhmw": { pricePerKg: 7 },
  "rt-delrin": { pricePerKg: 11 },
  "rt-nylon": { pricePerKg: 13 },
  "rt-polycarbonate": { pricePerKg: 10 },
  "rt-acrylic": { pricePerKg: 8 },
  "rt-pvc": { pricePerKg: 6 },
  "rt-polypropylene": { pricePerKg: 6 },
  "rt-g10": { pricePerKg: 22 },
  "rt-phenolic": { pricePerKg: 19 },
  "rt-aluminum-6061": { pricePerKg: 7 },
  "fdm-pla": { pricePerCm3: 0.05 },
  "fdm-abs": { pricePerCm3: 0.06 },
  "fdm-petg": { pricePerCm3: 0.06 },
  "fdm-nylon": { pricePerCm3: 0.12 },
  "fdm-tpu": { pricePerCm3: 0.1 },
  "fdm-cf-nylon": { pricePerCm3: 0.25 },
  "sla-standard": { pricePerCm3: 0.12 },
  "sla-tough": { pricePerCm3: 0.18 },
  "sla-flexible": { pricePerCm3: 0.2 },
  "sla-dental": { pricePerCm3: 0.35 },
  "sls-nylon-pa12": { pricePerCm3: 0.15 },
  "sls-nylon-pa11": { pricePerCm3: 0.18 },
  "sls-glass-filled-nylon": { pricePerCm3: 0.22 },
  "sls-tpu": { pricePerCm3: 0.28 },
};

const V3_FINISHES = {
  "raw": { pricePerPart: 0, pricePerSqIn: 0 },
  "deburr": { pricePerPart: 2.5, pricePerSqIn: 0.005 },
  "deburr-grain": { pricePerPart: 4, pricePerSqIn: 0.012 },
  "powder-black": { pricePerPart: 8, pricePerSqIn: 0.035 },
  "powder-white": { pricePerPart: 8, pricePerSqIn: 0.035 },
  "powder-custom": { pricePerPart: 14, pricePerSqIn: 0.045 },
  "anodize-clear": { pricePerPart: 6, pricePerSqIn: 0.028 },
  "anodize-black": { pricePerPart: 7, pricePerSqIn: 0.032 },
  "zinc-plate": { pricePerPart: 5, pricePerSqIn: 0.022 },
  "cnc-as-machined": { pricePerPart: 0, pricePerSqIn: 0 },
  "cnc-deburr": { pricePerPart: 2.5, pricePerSqIn: 0.004 },
  "cnc-polish-clear": { pricePerPart: 6, pricePerSqIn: 0.02 },
  "cnc-bead-blast": { pricePerPart: 5, pricePerSqIn: 0.015 },
  "cnc-anodize-clear": { pricePerPart: 8, pricePerSqIn: 0.032 },
  "cnc-anodize-black": { pricePerPart: 9, pricePerSqIn: 0.035 },
  "cnc-powder-coat": { pricePerPart: 10, pricePerSqIn: 0.038 },
  "cnc-anodize-color": { pricePerPart: 12, pricePerSqIn: 0.04 },
  "cnc-nickel-plate": { pricePerPart: 10, pricePerSqIn: 0.035 },
  "cnc-chrome-plate": { pricePerPart: 15, pricePerSqIn: 0.045 },
  "cnc-passivation": { pricePerPart: 4, pricePerSqIn: 0.01 },
  "cnc-black-oxide": { pricePerPart: 4, pricePerSqIn: 0.012 },
  "rt-as-cut": { pricePerPart: 0, pricePerSqIn: 0 },
  "rt-deburr": { pricePerPart: 1.5, pricePerSqIn: 0.003 },
  "rt-chamfer": { pricePerPart: 3, pricePerSqIn: 0.004 },
  "rt-polish-clear": { pricePerPart: 5, pricePerSqIn: 0.015 },
  "rt-masking-kept": { pricePerPart: 0, pricePerSqIn: 0 },
  "3dp-as-printed": { pricePerPart: 0, pricePerSqIn: 0 },
  "3dp-support-removal": { pricePerPart: 3, pricePerSqIn: 0.005 },
  "3dp-sanding": { pricePerPart: 6, pricePerSqIn: 0.018 },
  "3dp-vapor-smooth": { pricePerPart: 8, pricePerSqIn: 0.025 },
  "3dp-primer-paint": { pricePerPart: 12, pricePerSqIn: 0.04 },
  "3dp-dyeing": { pricePerPart: 5, pricePerSqIn: 0.015 },
};

// Version 4: the four SLA materials of version 3 were replaced by eight; nothing else changed price.
const V4_MATERIALS = { ...V3_MATERIALS };
for (const slug of ["sla-standard","sla-tough","sla-flexible","sla-dental"]) delete V4_MATERIALS[slug];
Object.assign(V4_MATERIALS, {
  "sla-grey": { pricePerCm3: 0.08 },
  "sla-white": { pricePerCm3: 0.08 },
  "sla-clear": { pricePerCm3: 0.08 },
  "sla-tough-1500": { pricePerCm3: 0.15 },
  "sla-tough-2000": { pricePerCm3: 0.15 },
  "sla-rigid-10k": { pricePerCm3: 0.3 },
  "sla-high-temp": { pricePerCm3: 0.2 },
  "sla-esd": { pricePerCm3: 0.23 },
});

const SEED_PRICES = {
  2: { materials: V3_MATERIALS, finishes: V3_FINISHES },
  3: { materials: V3_MATERIALS, finishes: V3_FINISHES },
  4: { materials: V4_MATERIALS, finishes: V3_FINISHES },
};

/** The fields that are prices, per kind of catalogue row. */
const PRICE_FIELDS = { material: ["pricePerKg", "pricePerCm3"], finish: ["pricePerPart", "pricePerSqIn"] };

/** The prices of one seed version, or null when that version is not on record. */
function pricesOf(version) {
  return Object.prototype.hasOwnProperty.call(SEED_PRICES, version) ? SEED_PRICES[version] : null;
}

/**
 * The whole catalogue of one seed version: every field of every material and finish, by slug
 * (seedSnapshots/v<N>.json), or null when that version is not on record. This is what a row in the
 * database is compared with to tell what the owner changed (seedCarry.js).
 *
 * Where the files come from: versions 2 and 3 were read from git (the commits named above) on
 * 2026-11-13; from version 4 on, a file is the catalogue in defaults.js at that version, written by
 *     node scripts/dev/seed-snapshot.js
 * WHEN YOU BUMP SEED_VERSION: run that script and commit the new file. seedCarry.test.js fails
 * until the file for the current SEED_VERSION equals the current catalogue.
 */
const snapshots = new Map();
function catalogueOf(version) {
  if (!Number.isInteger(version) || version < 1) return null;
  if (!snapshots.has(version)) {
    let found = null;
    try {
      const file = require(`./seedSnapshots/v${version}.json`);
      const bySlug = (rows) => Object.fromEntries((rows || []).filter((r) => r && typeof r.slug === "string" && r.slug).map((r) => [r.slug, r]));
      if (file && file.seedVersion === version) found = { materials: bySlug(file.materials), finishes: bySlug(file.finishes) };
    } catch { /* not on record */ }
    snapshots.set(version, found);
  }
  return snapshots.get(version);
}

module.exports = { SEED_PRICES, PRICE_FIELDS, pricesOf, catalogueOf };
