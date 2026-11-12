/**
 * Worker-thread side of the parse pool (see parsePool.js).
 *
 * A worker loads the parser once (and, on its first STEP/IGES file, the
 * OpenCascade WASM module), then reads the files the pool hands it, one at a
 * time. The main thread never runs geometry code, so a slow or hostile file
 * cannot stall the site — the pool stops this thread when a file runs out of
 * time or memory, and retires it after a large file or a set number of jobs.
 *
 * The parser and the DFM rules are pure (no database, no pricing rules, no
 * state kept between files), so a result computed here is identical to one
 * computed on the main thread.
 */
const { parentPort } = require("worker_threads");

let parseFile = null;

// Tell the pool which thread this is, so it can read this thread's CPU time from the system
// (/proc on Linux): reading limits are on CPU time, not on the clock, where that is available.
try {
  const tid = require("fs").readlinkSync("/proc/thread-self").split("/").pop();
  if (/^\d+$/.test(tid)) parentPort.postMessage({ hello: true, tid });
} catch { /* not Linux: the pool uses the clock */ }

parentPort.on("message", async (job) => {
  try {
    // Test-only hook, set through the pool's constructor (never from a request):
    // lets a suite hold a worker busy without shipping a pathological file.
    if (job.testDelayMs) {
      const until = Date.now() + job.testDelayMs;
      while (Date.now() < until) { /* spin: a real parse is CPU-bound too */ }
    }
    if (!parseFile) parseFile = require("./fileParser").parseFile;
    const options = { ...(job.options || {}) };
    if (job.buffer) options.buffer = Buffer.from(job.buffer.buffer, job.buffer.byteOffset, job.buffer.byteLength);
    const result = await parseFile(job.filePath, options);
    parentPort.postMessage({ id: job.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id: job.id,
      ok: false,
      error: {
        message: (err && err.message) || "The file could not be read.",
        name: (err && err.name) || "Error",
        code: err && err.code,
        offerRfq: Boolean(err && err.offerRfq),
      },
    });
  }
});
