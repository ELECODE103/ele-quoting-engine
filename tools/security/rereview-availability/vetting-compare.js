#!/usr/bin/env node
/**
 * Regression check for the claim "the 300-quote vetting run is identical before and after the fixes".
 * A passing result: rowsThatDiffer is 0.
 *
 *   node tools/security/rereview-availability/vetting-compare.js [baseRef=hardening-2026-11-11]
 *
 * The committed tools/vet-quotes/results.csv is older than both branches (its totals are not yet in
 * whole cents), so it is not the baseline. Instead the server of the branch the fixes started from is
 * taken from git (`git archive <baseRef> server shared package.json`, read-only) into a throwaway
 * folder and started there with this worktree's node_modules; the same harness and the same part
 * library (this branch's tools/vet-quotes) are run against it and against this branch's server, with
 * results written to throwaway folders. Every row of the two results.csv files is compared; the
 * quote-id column is ignored. Nothing in the repository is overwritten.
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("./common");

const ROOT = c.live.ROOT;
const baseRef = process.argv[2] || "hardening-2026-11-11";

function vet(base, out) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "vet-quotes", "run_vetting.js"), "--base", base, "--out", out], { encoding: "utf8", env: { ...process.env, NO_PROXY: "localhost,127.0.0.1" }, maxBuffer: 64 * 1024 * 1024, timeout: 25 * 60 * 1000 });
  const csv = path.join(out, "results.csv");
  return { exit: r.status, summary: String(r.stdout || "").trim().split("\n").filter((l) => /Sanity checks/.test(l)).pop() || "", rows: fs.existsSync(csv) ? fs.readFileSync(csv, "utf8").trim().split("\n") : [] };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-rereview-vet-"));
  let sBase = null; let sFix = null;
  try {
    // The branch the fixes started from, as git has it.
    const baseDir = path.join(tmp, "base");
    fs.mkdirSync(baseDir, { recursive: true });
    const commit = execFileSync("git", ["rev-parse", "--short", baseRef], { cwd: ROOT }).toString().trim();
    execFileSync("tar", ["-x", "-C", baseDir], { input: execFileSync("git", ["archive", baseRef, "server", "shared", "package.json"], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 }) });
    process.env.NODE_PATH = path.join(ROOT, "node_modules"); // the child server resolves its packages here
    sBase = await require(path.join(baseDir, "server", "testSupport", "liveServer.js")).start({});
    const outBase = path.join(tmp, "out-base"); fs.mkdirSync(outBase);
    const a = vet(sBase.base, outBase);
    await sBase.stop(); sBase = null;
    sFix = await c.startServer();
    const outFix = path.join(tmp, "out-fix"); fs.mkdirSync(outFix);
    const b = vet(sFix.base, outFix);
    const strip = (line) => line.slice(0, line.lastIndexOf(",")); // the last column is the quote id
    const differ = [];
    for (let i = 0; i < Math.max(a.rows.length, b.rows.length); i++) if (strip(a.rows[i] || "") !== strip(b.rows[i] || "")) differ.push(i);
    c.result({
      test: "vetting-compare", base: `${baseRef} (${commit})`, baseRun: { exit: a.exit, quotes: a.rows.length - 1, summary: a.summary }, thisBranchRun: { exit: b.exit, quotes: b.rows.length - 1, summary: b.summary },
      rowsThatDiffer: differ.length,
      firstDifferences: differ.slice(0, 3).map((i) => { const x = (a.rows[i] || "").split(","); const y = (b.rows[i] || "").split(","); const header = a.rows[0].split(","); const cols = header.filter((h, k) => h !== "quoteId" && x[k] !== y[k]); return { row: i, part: x[0], columns: cols.slice(0, 6) }; }),
    });
  } finally {
    if (sBase) await sBase.stop().catch(() => {});
    if (sFix) await sFix.stop().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
