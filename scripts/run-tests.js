#!/usr/bin/env node
/**
 * Runs every server/**\/*.test.js and client/src/**\/*.test.js in its own
 * process (the suites are plain `node file.test.js` scripts). Exits non-zero
 * if any suite fails.
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

const tests = [
  ...findTests(path.join(__dirname, "..", "server")),
  ...findTests(path.join(__dirname, "..", "client", "src")),
];
// Some suites read the built client (server/security/headers.test.js asserts the policy on real pages and
// on a hashed asset; crossBranch and seo read prerendered pages). A fresh clone has no client/dist, and those
// assertions must run, not be skipped: build it once here when it is missing. An existing build is left alone.
const dist = path.join(__dirname, "..", "client", "dist", "index.html");
if (!fs.existsSync(dist) && process.env.RUN_TESTS_NO_BUILD !== "1") {
  console.log("client/dist is not built: building it once so the suites that read the built pages can run (npm run build)…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const b = spawnSync(npm, ["run", "build"], { cwd: path.join(__dirname, ".."), stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, NODE_ENV: "production" } });
  if (b.status !== 0 || !fs.existsSync(dist)) { console.error("✗ the client build failed; run `NODE_ENV=production npm run build` to see why"); process.exit(1); }
}

let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [t], { stdio: "inherit" });
  if (r.status !== 0) { failed++; console.error(`\n✗ ${path.relative(process.cwd(), t)} exited ${r.status}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} suites passed`);
process.exit(failed ? 1 : 0);
