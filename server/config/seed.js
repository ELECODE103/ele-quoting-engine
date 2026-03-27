/**
 * Seeds the database with default materials, finishes, lead times, and pricing rules.
 */
const {
  materialsDB,
  finishesDB,
  leadTimesDB,
  pricingDB,
  processesDB,
} = require("../models");
const {
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

    if (pricingDB.getAll().length === 0) {
      console.log("  Seeding pricing rules...");
      pricingDB.insert({ name: "default", ...DEFAULT_PRICING_RULES });
    }

    if (processesDB.getAll().length === 0) {
      console.log("  Seeding processes...");
      for (const proc of MANUFACTURING_PROCESSES) {
        processesDB.insert(proc);
      }
    }

    console.log("  Database ready.");
  } catch (err) {
    console.error("  Database seed failed:", err.message);
    throw err;
  }
}

module.exports = { seedDatabase };
