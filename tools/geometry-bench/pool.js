/**
 * Runs corpus cases, each in its own process (run-case.js), a few at a time.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");
const lib = require("./lib");

/**
 * @param {object[]} list cases
 * @param {{jobs?:number, heap?:number, capMs?:number, onResult:(c, result|null, fullText|null, error|null)=>void}} o
 *        capMs: stop a case that runs longer than this (the error passed to onResult has code "CAP")
 */
async function runMany(list, o) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "geometry-bench-"));
  // Inputs first, in separate short-lived processes, so generating a 25 MB mesh is not counted in a case's memory.
  for (let i = 0; i < list.length; i += 20) {
    const ids = list.slice(i, i + 20).map((c) => c.id).join(",");
    const r = spawnSync(process.execPath, ["--max-old-space-size=4096", path.join(__dirname, "gen.js"), "--ensure", ids], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) throw new Error(`could not generate inputs: ${ids}`);
  }
  let next = 0;
  const one = () => new Promise((resolve) => {
    const c = list[next++];
    if (!c) return resolve(false);
    const out = path.join(tmp, c.id + ".json");
    const child = spawn(process.execPath, ["--expose-gc", path.join(__dirname, "run-case.js"), c.id, out, "--heap", String(o.heap || 768)], { stdio: ["ignore", "inherit", "pipe"] });
    let err = "", timedOut = false;
    child.stderr.on("data", (d) => { err += d; });
    const cap = o.capMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, o.capMs) : null;
    child.on("close", (code) => {
      if (cap) clearTimeout(cap);
      if (timedOut) o.onResult(c, null, null, Object.assign(new Error(`not finished after ${Math.round(o.capMs / 60000)} minutes`), { code: "CAP" }));
      else if (code !== 0 || !fs.existsSync(out)) o.onResult(c, null, null, new Error(`run-case exited ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`));
      else {
        const result = JSON.parse(fs.readFileSync(out, "utf8"));
        const full = zlib.gunzipSync(fs.readFileSync(out + ".full")).toString("utf8");
        fs.rmSync(out, { force: true }); fs.rmSync(out + ".full", { force: true });
        o.onResult(c, result, full, null);
      }
      resolve(true);
    });
  });
  const lane = async () => { while (await one()) { /* next */ } };
  await Promise.all(Array.from({ length: Math.max(1, o.jobs || 1) }, lane));
  fs.rmSync(tmp, { recursive: true, force: true });
}

const fmtMs = (ms) => (ms == null ? "–" : ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

module.exports = { runMany, fmtMs };
