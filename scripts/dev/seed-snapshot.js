#!/usr/bin/env node
/**
 * Write the whole-catalogue file of the current seed version: server/config/seedSnapshots/v<N>.json.
 *
 *   node scripts/dev/seed-snapshot.js
 *
 * Run it when SEED_VERSION goes up (server/config/defaults.js) and commit the file. The catalogue
 * upgrade tells what the owner changed by hand from what was a default by comparing a row with the
 * file of the version the database was seeded from (server/config/seedCarry.js), so every version
 * that was ever live needs its file. A file that already exists and differs is not overwritten
 * unless you pass --force: a version's catalogue must not change after databases were seeded from it.
 */
const fs = require("fs");
const path = require("path");
const d = require("../../server/config/defaults");

const file = path.join(__dirname, "..", "..", "server", "config", "seedSnapshots", `v${d.SEED_VERSION}.json`);
const text = `${JSON.stringify({ seedVersion: d.SEED_VERSION, materials: d.DEFAULT_MATERIALS, finishes: d.DEFAULT_FINISHES }, null, 1)}\n`;
if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== text && !process.argv.includes("--force")) {
  console.error(`${path.relative(process.cwd(), file)} exists and is not the catalogue in defaults.js.\nIf the catalogue changed, SEED_VERSION must go up (a new file). To replace this one anyway: --force`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, text);
console.log(`${path.relative(process.cwd(), file)}: ${d.DEFAULT_MATERIALS.length} materials, ${d.DEFAULT_FINISHES.length} finishes`);
