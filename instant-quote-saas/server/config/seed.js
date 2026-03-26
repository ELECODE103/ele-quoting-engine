/**
 * Seeds the database with default materials, finishes, lead times, and pricing rules.
 */
const { JsonDB } = require("../models/db");
const {
  DEFAULT_MATERIALS,
  DEFAULT_FINISHES,
  DEFAULT_LEAD_TIMES,
  DEFAULT_PRICING_RULES,
} = require("./defaults");

function seedDatabase() {
  const materialsDB = new JsonDB("materials");
  const finishesDB = new JsonDB("finishes");
  const leadTimesDB = new JsonDB("lead_times");
  const pricingDB = new JsonDB("pricing_rules");

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

  console.log("  Database ready.");
}

module.exports = { seedDatabase };
