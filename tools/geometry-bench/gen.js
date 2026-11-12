#!/usr/bin/env node
/**
 * Write a corpus input to disk.
 *
 *   node tools/geometry-bench/gen.js --list                 every case: id, size, format, nominal count
 *   node tools/geometry-bench/gen.js <id> [out-file]        write one input (default: the bench cache), print its path
 *   node tools/geometry-bench/gen.js --ensure id,id,…       make sure these are in the cache (used by snapshot / compare)
 */
const fs = require("fs");
const { cases, byId } = require("./corpus");
const { inputFile, parseArgs } = require("./lib");

const args = parseArgs(process.argv.slice(2));
if (args.list) {
  for (const c of cases) console.log(`${c.id.padEnd(40)} ${c.size.padEnd(7)} ${c.ext.padEnd(5)} ${c.n == null ? "" : c.n}`);
  console.log(`${cases.length} cases`);
} else if (args.ensure) {
  for (const id of String(args.ensure).split(",")) { const c = byId(id); if (!c) throw new Error(`unknown case ${id}`); inputFile(c); }
} else {
  const c = byId(args._[0]);
  if (!c) { console.error(`unknown case ${args._[0] || ""} — try --list`); process.exit(2); }
  if (args._[1]) { fs.writeFileSync(args._[1], c.build()); console.log(args._[1]); } else console.log(inputFile(c));
}
