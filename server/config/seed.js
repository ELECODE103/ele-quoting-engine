/**
 * Seeds the database with default materials, finishes, lead times, and pricing rules.
 */
const {
  materialsDB,
  finishesDB,
  leadTimesDB,
  pricingDB,
  processesDB,
  usersDB,
} = require("../models");
const {
  SEED_VERSION,
  DEFAULT_MATERIALS,
  DEFAULT_FINISHES,
  DEFAULT_LEAD_TIMES,
  DEFAULT_PRICING_RULES,
  MANUFACTURING_PROCESSES,
} = require("./defaults");

function seedDatabase() {
  try {
    // Detect stale data: if materials exist but lack the 'process' field, re-seed
    const existingMats = materialsDB.getAll();
    if (existingMats.length > 0 && !existingMats[0].process) {
      console.log("  Upgrading database: re-seeding with multi-process data...");
      for (const m of existingMats) materialsDB.delete(m.id);
      const existingFins = finishesDB.getAll();
      for (const f of existingFins) finishesDB.delete(f.id);
      const existingPricing = pricingDB.getAll();
      for (const p of existingPricing) pricingDB.delete(p.id);
      const existingProcs = processesDB.getAll();
      for (const proc of existingProcs) processesDB.delete(proc.id);
    }

    // Detect missing pricing columns: re-seed materials & finishes if pricing data is null
    const existingMats2 = materialsDB.getAll();
    if (existingMats2.length > 0 && existingMats2[0].pricePerKg == null && existingMats2[0].pricePerCm3 == null) {
      console.log("  Upgrading database: re-seeding materials and finishes with pricing data...");
      for (const m of existingMats2) materialsDB.delete(m.id);
      const existingFins2 = finishesDB.getAll();
      for (const f of existingFins2) finishesDB.delete(f.id);
    }

    // Seed-version upgrade: when the default catalogs change (SEED_VERSION bump),
    // replace materials/finishes/processes on an existing database. Quotes,
    // orders, parts and users are untouched; pricing rules are merged below.
    const existingRules = pricingDB.getAll()[0];
    const dbSeedVersion = existingRules?.rules?.seedVersion || 1;
    if (materialsDB.getAll().length > 0 && dbSeedVersion < SEED_VERSION) {
      console.log(`  Upgrading catalogs: seed v${dbSeedVersion} → v${SEED_VERSION} (materials, finishes, processes)...`);
      for (const m of materialsDB.getAll()) materialsDB.delete(m.id);
      for (const f of finishesDB.getAll()) finishesDB.delete(f.id);
      for (const proc of processesDB.getAll()) processesDB.delete(proc.id);
    }

    // Only seed if empty
    if (materialsDB.getAll().length === 0) {
      console.log("  Seeding materials...");
      for (const mat of DEFAULT_MATERIALS) {
        materialsDB.insert(mat);
      }
    }

    if (finishesDB.getAll().length === 0) {
      console.log("  Seeding finishes...");
      for (const fin of DEFAULT_FINISHES) {
        finishesDB.insert(fin);
      }
    }

    // Detect missing lead time days: re-seed if days field is null
    const existingLTs = leadTimesDB.getAll();
    if (existingLTs.length > 0 && !existingLTs[0].days) {
      console.log("  Upgrading database: re-seeding lead times with days data...");
      for (const lt of existingLTs) leadTimesDB.delete(lt.id);
    }

    if (leadTimesDB.getAll().length === 0) {
      console.log("  Seeding lead times...");
      for (const lt of DEFAULT_LEAD_TIMES) {
        leadTimesDB.insert(lt);
      }
    }

    // Pricing rules are stored as one JSON blob under `rules` (the rules_json
    // column). Merge in any keys the stored blob is missing (new process rates
    // etc.) without overwriting values tuned in the admin panel.
    if (pricingDB.getAll().length === 0) {
      console.log("  Seeding pricing rules...");
      pricingDB.insert({ rules: { ...DEFAULT_PRICING_RULES, seedVersion: SEED_VERSION } });
    } else {
      const stored = pricingDB.getAll()[0];
      const current = (stored.rules && typeof stored.rules === "object") ? stored.rules : {};
      let added = 0;
      const merged = { ...current };
      for (const [k, v] of Object.entries(DEFAULT_PRICING_RULES)) {
        if (merged[k] === undefined || merged[k] === null) { merged[k] = v; added++; }
      }
      if (added > 0 || (current.seedVersion || 1) < SEED_VERSION) {
        merged.seedVersion = SEED_VERSION;
        pricingDB.update(stored.id, { rules: merged });
        console.log(`  Pricing rules: added ${added} new key(s), seed v${SEED_VERSION}.`);
      }
    }

    if (processesDB.getAll().length === 0) {
      console.log("  Seeding processes...");
      for (const proc of MANUFACTURING_PROCESSES) {
        processesDB.insert(proc);
      }
    }

    // --- Auto-promote owner to admin based on ADMIN_EMAIL env var ---
    const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
    if (adminEmail) {
      const owner = usersDB.getAll().find((u) => u.email === adminEmail);
      if (owner && owner.role !== "admin") {
        usersDB.update(owner.id, { role: "admin" });
        console.log(`  Promoted ${adminEmail} to admin role.`);
      } else if (owner) {
        console.log(`  Admin user ${adminEmail} already has admin role.`);
      } else {
        console.log(`  ADMIN_EMAIL set to ${adminEmail} but no matching user yet.`);
      }
    }

    console.log("  Database ready.");
  } catch (err) {
    console.error("  Database seed failed:", err.message);
    throw err;
  }
}

module.exports = { seedDatabase };
