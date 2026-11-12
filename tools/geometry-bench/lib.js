/**
 * Shared pieces of the geometry benchmark: input cache, the measured run of
 * one case in a real parse worker, the result sections (geometry, DFM, price),
 * canonical JSON, hashing and the difference printer.
 *
 * What a result is
 *   geometry  everything parseFile() returns as `geometry` (features, legacy
 *             scalars, the 2D profile of a DXF), with the preview mesh replaced
 *             by its hash and the stopwatch readings (`features.timings`) removed
 *   dfm       parseFile()'s `dfm` and `dfmAll`, plus a DFM run for every
 *             registered process / sub-process with the standard material
 *   price     the order quote and the checkout-or-RFQ gate for the standard
 *             configurations at quantities 1, 10 and 100
 *
 * A file that cannot be parsed has geometry = { error: { message, code, offerRfq } }.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Worker } = require("worker_threads");

// The checkout whose server code is run. GEOMETRY_BENCH_ROOT points the bench at another checkout
// (the baseline commit in a second worktree) so its results can be recorded with these same inputs.
const ROOT = process.env.GEOMETRY_BENCH_ROOT ? path.resolve(process.env.GEOMETRY_BENCH_ROOT) : path.join(__dirname, "..", "..");
const HERE = __dirname;
// GEOMETRY_BENCH_BASELINE names another folder of recorded results (see baseline-step1/README.md).
const BASELINE_DIR = process.env.GEOMETRY_BENCH_BASELINE ? path.resolve(process.env.GEOMETRY_BENCH_BASELINE) : path.join(HERE, "baseline");
const CACHE_DIR = path.join(HERE, ".cache");
// full results of large cases, kept on this machine only (one folder per baseline folder)
const FULL_CACHE_DIR = path.join(CACHE_DIR, path.basename(BASELINE_DIR) === "baseline" ? "full" : "full-" + path.basename(BASELINE_DIR));
const WORKER = path.join(ROOT, "server", "parsers", "parseWorker.js");

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** JSON with object keys sorted, so equal values give equal text. Numbers keep full precision. */
function canonical(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value)); // NaN / Infinity would otherwise all become null
    if (Object.is(value, -0)) return '"-0"';
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return "[" + Array.prototype.map.call(value, canonical).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

// ── inputs ───────────────────────────────────────────────────────────────────
let genKey = null;
/** Changes whenever a generator source file changes, so a stale cached input is never reused. */
function generatorKey() {
  if (genKey) return genKey;
  const h = crypto.createHash("sha256");
  for (const f of ["corpus.js", "gen/mesh.js", "gen/dxf.js", "gen/formats.js"]) h.update(fs.readFileSync(path.join(HERE, f)));
  h.update(fs.readFileSync(path.join(HERE, "..", "..", "server", "geometry", "testMesh.js")));
  h.update(fs.readFileSync(path.join(HERE, "..", "..", "server", "geometry", "dxf", "writer.js")));
  genKey = h.digest("hex").slice(0, 12);
  return genKey;
}
/** Write the case's input to the cache (once) and return its path. */
function inputFile(c) {
  const dir = path.join(CACHE_DIR, "inputs-" + generatorKey());
  const file = path.join(dir, c.id + c.ext);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + ".tmp" + process.pid;
    fs.writeFileSync(tmp, c.build());
    fs.renameSync(tmp, file);
  }
  return file;
}

// ── result sections ──────────────────────────────────────────────────────────
const STANDARD = [
  { key: "routing/sheet/rt-hdpe", process: "routing", subProcess: "sheet", materialSlug: "rt-hdpe", thicknessMm: 6.35 },
  { key: "routing/sheet/rt-hdpe@12.7", process: "routing", subProcess: "sheet", materialSlug: "rt-hdpe", thicknessMm: 12.7 },
  { key: "cnc/milling/cnc-delrin", process: "cnc", subProcess: "milling", materialSlug: "cnc-delrin" },
  { key: "cnc/milling/cnc-aluminum-6061", process: "cnc", subProcess: "milling", materialSlug: "cnc-aluminum-6061" },
  { key: "cnc/turning/cnc-delrin", process: "cnc", subProcess: "turning", materialSlug: "cnc-delrin" },
  { key: "3d-printing/fdm/fdm-abs", process: "3d-printing", subProcess: "fdm", materialSlug: "fdm-abs" },
  { key: "3d-printing/sla/sla-grey", process: "3d-printing", subProcess: "sla", materialSlug: "sla-grey" },
  { key: "3d-printing/sls/sls-nylon-pa12", process: "3d-printing", subProcess: "sls", materialSlug: "sls-nylon-pa12" },
  { key: "sheetmetal//mild-steel", process: "sheetmetal", subProcess: "", materialSlug: "mild-steel" },
];
const QUANTITIES = [1, 10, 100];

/** Hash of everything the price section depends on besides the geometry (rules, materials, finishes). */
function pricingFingerprint() {
  const d = require(path.join(ROOT, "server", "config", "defaults"));
  return sha256(canonical({ rules: d.DEFAULT_PRICING_RULES, materials: d.DEFAULT_MATERIALS, finishes: d.DEFAULT_FINISHES })).slice(0, 16);
}

/**
 * Sections for one parseFile() result (or the error it threw).
 * Runs on the calling thread; `parsed` may have come from a worker.
 */
function sections(parsed, error) {
  if (error) {
    return { geometry: { error: { message: error.message, code: error.code || null, offerRfq: Boolean(error.offerRfq) } }, dfm: null, price: null };
  }
  const { runDFMAnalysis } = require(path.join(ROOT, "server", "parsers", "fileParser"));
  const { PricingEngine } = require(path.join(ROOT, "server", "services", "pricingEngine"));
  const quoteGate = require(path.join(ROOT, "server", "services", "quoteGate"));
  const { resolveProcess } = require(path.join(ROOT, "server", "processes", "registry"));
  const { offeredLayerHeight } = require(path.join(ROOT, "server", "services", "layerHeight"));
  const defaults = require(path.join(ROOT, "server", "config", "defaults"));

  const g = parsed.geometry;
  const geometry = { ...g, fileInfo: { ext: parsed.fileInfo.ext, sizeBytes: parsed.fileInfo.sizeBytes } };
  if (g.meshData) {
    const pos = g.meshData.positions || [];
    geometry.meshData = { ...g.meshData, positions: { count: pos.length, sha256: sha256(Buffer.from(Float64Array.from(pos).buffer)) } };
  }
  if (g.features && g.features.timings) { geometry.features = { ...g.features }; delete geometry.features.timings; }

  const engine = new PricingEngine();
  const dfm = { default: parsed.dfm, all: parsed.dfmAll, standard: {} };
  const price = {};
  for (const cfg of STANDARD) {
    const material = defaults.DEFAULT_MATERIALS.find((m) => m.slug === cfg.materialSlug);
    const def = resolveProcess(cfg.process);
    const finish = defaults.DEFAULT_FINISHES.find((f) => f.slug === (def.defaultFinishSlug || "raw")) || null;
    const thicknessMm = Number(cfg.thicknessMm) > 0 ? Number(cfg.thicknessMm) : ((material.thicknesses && material.thicknesses[2] && material.thicknesses[2].mm) || (material.thicknesses && material.thicknesses[0] && material.thicknesses[0].mm) || 0);
    let d;
    try {
      d = runDFMAnalysis(g, {
        process: cfg.process, subProcess: cfg.subProcess || def.previewSubProcess, thicknessMm,
        materialType: /plastic|composite/i.test(material.category || "") ? "plastic" : "metal",
        materialSlug: material.slug, materialName: material.name,
      });
    } catch (err) { d = { error: err.message }; }
    dfm.standard[cfg.key] = d;
    price[cfg.key] = {};
    for (const quantity of QUANTITIES) {
      try {
        const quote = engine.calculateOrderQuote({
          parts: [{
            partId: "p1", fileName: "part", geometry: g, material, grade: (material.grades && material.grades[0] && material.grades[0].name) || "",
            thicknessMm, finish, quantity, process: cfg.process, subProcess: cfg.subProcess || "",
            layerHeight: offeredLayerHeight(material, undefined), infill: undefined,
          }],
          leadTimeMultiplier: 1,
        });
        const gate = quoteGate.evaluate(quote.lineItems, { p1: d }, engine.rules);
        price[cfg.key][quantity] = { quote, gate };
      } catch (err) { price[cfg.key][quantity] = { error: err.message }; }
    }
  }
  return { geometry, dfm, price };
}

/** Parse on the calling thread (no worker, no measurements): the small corpus in `npm test` runs this way. */
async function runInProcess(c) {
  const { parseFile } = require(path.join(ROOT, "server", "parsers", "fileParser"));
  const buffer = c.build();
  try {
    return { sections: sections(await parseFile("case" + c.ext, { ext: c.ext, buffer, ...(c.options || {}) })), input: { bytes: buffer.length, sha256: sha256(buffer) } };
  } catch (err) {
    return { sections: sections(null, err), input: { bytes: buffer.length, sha256: sha256(buffer) } };
  }
}

/** One-line description of a result for tables: triangles or contours, or the refusal. */
function summarise(sec) {
  const g = sec.geometry;
  if (g.error) return { status: "refused", code: g.error.code || null, message: g.error.message.slice(0, 90), fullMessage: g.error.message.slice(0, 300) };
  if (g.profile2d) return { status: "ok", loops: g.profile2d.loops.length, holes: g.profile2d.holes.length, problems: g.profile2d.problems.length };
  return { status: "ok", triangles: g.triangleCount, holes: g.estimatedHoles, kind: g.features && g.features.shape ? g.features.shape.kind : null, recognised: !(g.features && g.features.error) };
}

/**
 * A refusal that is the code running out of something (memory, the size of a Set or an array,
 * the call stack) rather than an answer about the file: the message, or null.
 */
function resourceFailure(summary) {
  if (!summary || summary.status !== "refused") return null;
  const m = summary.fullMessage || summary.message || "";
  return /maximum size exceeded|out of memory|invalid (array|string|typed array) length|maximum call stack|allocation failed/i.test(m) ? m : null;
}

/** { geometry, dfm, price } → canonical text and hash per section. */
function digest(sec) {
  const text = {}, hash = {};
  for (const k of ["geometry", "dfm", "price"]) { text[k] = canonical(sec[k]); hash[k] = sha256(text[k]); }
  return { text, hash };
}

// ── one measured run in a real parse worker ──────────────────────────────────
/**
 * Parse `file` in server/parsers/parseWorker.js (the production worker code)
 * and measure it. The time limit is not applied; `heapMb` is the worker's
 * old-generation ceiling (production: 768).
 * @returns {Promise<{parsed, error, wallMs, cpuMs, peakHeapMb, peakV8HeapMb, peakRssMb, baseRssMb, stages}>}
 *          peakHeapMb = V8 heap in use + typed-array memory; peakV8HeapMb = the V8 heap alone (what the ceiling counts)
 */
function runInWorker(file, options = {}, { heapMb = 768, warm = true } = {}) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER, { resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    let peakHeap = 0, peakV8 = 0, peakRss = 0, baseRss = 0, sampling = false, t0 = 0, cpu0 = null, done = false;
    const sample = async () => {
      if (sampling || done) return;
      sampling = true;
      try {
        const rss = process.memoryUsage.rss();
        if (rss > peakRss) peakRss = rss;
        if (typeof worker.getHeapStatistics === "function") {
          const h = await worker.getHeapStatistics();
          const used = h.used_heap_size + (h.external_memory || 0);
          if (used > peakHeap) peakHeap = used;
          if (h.used_heap_size > peakV8) peakV8 = h.used_heap_size; // what the worker's heap ceiling counts
        }
      } catch { /* the worker has gone */ }
      sampling = false;
    };
    let timer = null;
    const finish = async (msg, fatal) => {
      if (done) return;
      const wallMs = Date.now() - t0;
      let cpuMs = null;
      try { if (typeof worker.cpuUsage === "function" && cpu0) { const c = await worker.cpuUsage(); cpuMs = (c.user + c.system - cpu0.user - cpu0.system) / 1000; } } catch { /* ignore */ }
      done = true;
      clearInterval(timer);
      await worker.terminate().catch(() => {});
      const mb = (b) => Math.round((b / 1048576) * 10) / 10;
      const base = { wallMs, cpuMs: cpuMs === null ? null : Math.round(cpuMs), peakHeapMb: mb(peakHeap), peakV8HeapMb: mb(peakV8), peakRssMb: mb(peakRss), baseRssMb: mb(baseRss) };
      if (fatal) return resolve({ ...base, parsed: null, error: fatal, stages: null });
      if (!msg.ok) return resolve({ ...base, parsed: null, error: Object.assign(new Error(msg.error.message), { code: msg.error.code, offerRfq: msg.error.offerRfq }), stages: null });
      const f = msg.result.geometry && msg.result.geometry.features;
      resolve({ ...base, parsed: msg.result, error: null, stages: (f && f.timings) || null });
    };
    worker.on("error", (err) => finish(null, Object.assign(new Error(err.code === "ERR_WORKER_OUT_OF_MEMORY" ? `worker out of memory (heap limit ${heapMb} MB)` : err.message), { code: err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "parse-memory" : "worker-error" })));
    const start = async () => {
      if (global.gc) global.gc();
      baseRss = process.memoryUsage.rss();
      try { if (typeof worker.cpuUsage === "function") cpu0 = await worker.cpuUsage(); } catch { cpu0 = null; }
      timer = setInterval(sample, 20);
      t0 = Date.now();
      worker.postMessage({ id: 2, filePath: file, options });
    };
    worker.on("message", (msg) => {
      if (msg.id === 1) return void start();
      finish(msg);
    });
    // A worker in production has usually read a file before (the parser is loaded); the first
    // job here is a 12-triangle box so module loading is not charged to the case.
    if (warm) {
      const tiny = path.join(os.tmpdir(), `geometry-bench-warm-${process.pid}.stl`);
      const b = Buffer.alloc(84 + 50); b.writeUInt32LE(1, 80); b.writeFloatLE(1, 84 + 12 + 12); b.writeFloatLE(1, 84 + 12 + 28);
      fs.writeFileSync(tiny, b);
      worker.postMessage({ id: 1, filePath: tiny, options: {} });
      worker.once("message", () => fs.rmSync(tiny, { force: true }));
    } else start();
  });
}

// ── differences ──────────────────────────────────────────────────────────────
/** Every path where two JSON values differ: [{ path, before, after }] (at most `max`). */
function differences(a, b, max = 40, pathStr = "", out = []) {
  if (out.length >= max) return out;
  if (a === b) return out;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a, tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb || (ta !== "object" && ta !== "array")) { out.push({ path: pathStr || "(root)", before: a, after: b }); return out; }
  if (ta === "array") {
    if (a.length !== b.length) out.push({ path: `${pathStr}.length`, before: a.length, after: b.length });
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < max; i++) differences(a[i], b[i], max, `${pathStr}[${i}]`, out);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of Array.from(keys).sort()) {
    if (out.length >= max) break;
    if (!(k in a)) out.push({ path: `${pathStr}.${k}`, before: undefined, after: b[k] });
    else if (!(k in b)) out.push({ path: `${pathStr}.${k}`, before: a[k], after: undefined });
    else differences(a[k], b[k], max, `${pathStr}.${k}`, out);
  }
  return out;
}
const short = (v) => { const s = v === undefined ? "(absent)" : JSON.stringify(v); return s.length > 160 ? s.slice(0, 157) + "…" : s; };

// ── arguments ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const nxt = argv[i + 1]; if (nxt === undefined || nxt.startsWith("--")) o[k] = true; else { o[k] = nxt; i++; } }
    else o._.push(a);
  }
  return o;
}
/** Cases selected by --size small,medium / --only id,id / --family name / --match regexp. */
function select(cases, args) {
  let list = cases;
  if (args.size) { const s = String(args.size).split(","); list = list.filter((c) => s.includes(c.size)); }
  if (args.family) { const s = String(args.family).split(","); list = list.filter((c) => s.includes(c.family)); }
  if (args.only) { const s = String(args.only).split(","); list = list.filter((c) => s.includes(c.id)); }
  if (args.match) { const re = new RegExp(String(args.match)); list = list.filter((c) => re.test(c.id)); }
  if (args.skip) { const re = new RegExp(String(args.skip)); list = list.filter((c) => !re.test(c.id)); }
  return list;
}

module.exports = {
  ROOT, HERE, BASELINE_DIR, CACHE_DIR, FULL_CACHE_DIR, STANDARD, QUANTITIES,
  sha256, canonical, inputFile, generatorKey, sections, digest, summarise, resourceFailure, pricingFingerprint, runInWorker, runInProcess, differences, short, parseArgs, select,
};
