#!/usr/bin/env node
/**
 * Runs every server/**\/*.test.js in its own process (the suites are plain
 * `node file.test.js` scripts). Exits non-zero if any suite fails.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function findTests(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "fixtures") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findTests(p, out);
    else if (e.name.endsWith(".test.js")) out.push(p);
  }
  return out.sort();
}

const tests = findTests(path.join(__dirname, "..", "server"));
let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [t], { stdio: "inherit" });
  if (r.status !== 0) { failed++; console.error(`\n✗ ${path.relative(process.cwd(), t)} exited ${r.status}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} suites passed`);
process.exit(failed ? 1 : 0);
