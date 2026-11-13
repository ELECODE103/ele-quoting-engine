#!/usr/bin/env node
/**
 * Run a proof script with the machine loaded: N busy loops beside it (default 4, the load the
 * availability write-ups and the re-review used on a two-core machine).
 *
 *   node tools/security/rereview-fixes/with-load.js 4 tools/security/rereview-relaunch/checkout-hold.js 100 12
 *
 * The busy loops are stopped when the script ends; its exit code is passed on.
 */
const { spawn } = require("child_process");
const os = require("os");

const n = Math.max(1, Number(process.argv[2]) || 4);
const script = process.argv[3];
if (!script) { console.error("usage: with-load.js <loops> <script> [args...]"); process.exit(2); }
const loops = Array.from({ length: n }, () => spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
const stop = () => { for (const p of loops) { try { p.kill("SIGKILL"); } catch { /* gone */ } } };
process.on("exit", stop);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop(); process.exit(130); });
setTimeout(() => {
  console.log(`[with-load] ${n} busy loops running; load average ${os.loadavg().map((x) => x.toFixed(1)).join(" ")}`);
  const child = spawn(process.execPath, [script, ...process.argv.slice(4)], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => { console.log(`[with-load] load average at the end ${os.loadavg().map((x) => x.toFixed(1)).join(" ")}`); stop(); process.exit(code === null ? 1 : code); });
}, 1500);
