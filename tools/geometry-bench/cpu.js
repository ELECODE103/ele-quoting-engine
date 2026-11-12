#!/usr/bin/env node
/**
 * CPU time of parsing a case on this thread, best of N runs. Wall-clock time is
 * useless on a shared machine; process CPU time is not affected by other load
 * (it does include V8's own helper threads).
 *
 *   node tools/geometry-bench/cpu.js <id> [id…] [--runs 3]
 */
const fs = require("fs");
const path = require("path");
const { byId } = require("./corpus");
const lib = require("./lib");

(async () => {
  const args = lib.parseArgs(process.argv.slice(2));
  const { parseFile } = require(path.join(lib.ROOT, "server", "parsers", "fileParser"));
  for (const id of args._) {
    const c = byId(id);
    if (!c) { console.error(`unknown case ${id}`); continue; }
    const buffer = fs.readFileSync(lib.inputFile(c));
    let best = Infinity, note = "";
    for (let r = 0; r < (Number(args.runs) || 3); r++) {
      if (global.gc) global.gc();
      const c0 = process.cpuUsage();
      try { await parseFile("case" + c.ext, { ext: c.ext, buffer, ...(c.options || {}) }); } catch (err) { note = ` (refused: ${err.message.slice(0, 50)})`; }
      const u = process.cpuUsage(c0);
      best = Math.min(best, (u.user + u.system) / 1000);
    }
    console.log(`${id.padEnd(34)} ${best.toFixed(0).padStart(7)} ms cpu${note}`);
  }
})();
