/**
 * Preloaded into the LOCAL server by stall-probe.js (node --require) to say WHAT held the one
 * thread: it times every database save (the sql.js export and the file write), every garbage
 * collection pause and every answer-building JSON.stringify over 20 ms, and writes one JSON line per
 * event to REREVIEW_PROBE_LOG. It changes nothing the server does. Worker threads skip it.
 */
const { isMainThread } = require("worker_threads");
if (isMainThread && process.env.REREVIEW_PROBE_LOG) {
  const fs = require("fs");
  const { PerformanceObserver, monitorEventLoopDelay, performance } = require("perf_hooks");
  const out = fs.openSync(process.env.REREVIEW_PROBE_LOG, "a");
  const origWrite = fs.writeFileSync;
  const note = (o) => { try { fs.writeSync(out, JSON.stringify({ at: Date.now(), ...o }) + "\n"); } catch { /* best effort */ } };
  const MIN = Number(process.env.REREVIEW_PROBE_MIN_MS) || 20;
  // 1. the file write of a save
  fs.writeFileSync = function timedWrite(file, data, ...rest) {
    if (typeof file !== "string" || !file.endsWith("quoting.db.tmp")) return origWrite.call(this, file, data, ...rest);
    const t = performance.now();
    try { return origWrite.call(this, file, data, ...rest); } finally { note({ type: "db-write", ms: Math.round(performance.now() - t), mb: Number((data.length / 1048576).toFixed(1)) }); }
  };
  // 2. the export that precedes it (sql.js copies the whole database out of its memory)
  require("sql.js")().then((SQL) => {
    const real = SQL.Database.prototype.export;
    SQL.Database.prototype.export = function timedExport() {
      const t = performance.now();
      const r = real.call(this);
      note({ type: "db-export", ms: Math.round(performance.now() - t), mb: Number((r.length / 1048576).toFixed(1)) });
      return r;
    };
  }).catch(() => {});
  // 2b. reading a part's stored measurements back: the file read and the JSON.parse of it (and any other long parse)
  const origRead = fs.readFileSync;
  fs.readFileSync = function timedRead(file, ...rest) {
    if (typeof file !== "string" || !file.includes("part-payloads")) return origRead.call(this, file, ...rest);
    const t = performance.now();
    try { return origRead.call(this, file, ...rest); } finally { const ms = performance.now() - t; if (ms >= MIN) note({ type: "part-file-read", ms: Math.round(ms) }); }
  };
  const origParse = JSON.parse;
  JSON.parse = function timedParse(text, reviver) {
    if (typeof text !== "string" || text.length < 200000) return origParse(text, reviver);
    const t = performance.now();
    try { return origParse(text, reviver); } finally { const ms = performance.now() - t; if (ms >= MIN) note({ type: "json-parse", ms: Math.round(ms), mb: Number((text.length / 1048576).toFixed(1)) }); }
  };
  const origStringify = JSON.stringify;
  JSON.stringify = function timedStringify(...args) {
    const t = performance.now();
    const r = origStringify.apply(this, args);
    const ms = performance.now() - t;
    if (ms >= MIN) note({ type: "json-stringify", ms: Math.round(ms), mb: typeof r === "string" ? Number((r.length / 1048576).toFixed(1)) : 0 });
    return r;
  };
  // 3. garbage collection pauses
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.duration >= MIN) note({ type: "gc", ms: Math.round(e.duration), kind: e.detail && e.detail.kind }); }).observe({ entryTypes: ["gc"] }); } catch { /* not available */ }
  // 4. how long the loop itself was held, each second
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  setInterval(() => { const max = Math.round(h.max / 1e6); if (max >= MIN) note({ type: "loop-max-in-last-second", ms: max }); h.reset(); }, 1000).unref();
}
