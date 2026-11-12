/**
 * Shared helpers for the independent upload/parser review (2026-11-11).
 * Everything here drives a LOCAL server started by server/testSupport/liveServer.js
 * (the real server/index.js, production mode, throwaway data folder and secrets).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const live = require("../../../server/testSupport/liveServer");

const PRELOAD = path.join(__dirname, "preload-stubs.js");
// One throwaway signing secret per script run, so a server restarted on the same folder still
// recognises the sessions and keys it issued before the restart (as a real redeploy does).
const RUN_SECRET = crypto.randomBytes(32).toString("hex");

/**
 * Start the server. opts.env overrides; opts.stubs loads preload-stubs.js (Stripe + Turnstile answered locally);
 * opts.turnstile switches the bot check on with throwaway keys (implies stubs).
 */
async function startServer(opts = {}) {
  const env = { PARSE_CONCURRENCY: "2", JWT_SECRET: RUN_SECRET, ...(opts.env || {}) };
  if (opts.turnstile) {
    env.TURNSTILE_SITE_KEY = `review-site-${crypto.randomBytes(6).toString("hex")}`;
    env.TURNSTILE_SECRET_KEY = `review-secret-${crypto.randomBytes(12).toString("hex")}`;
  }
  if (opts.mail) {
    env.REVIEW_STUB_MAIL = "1";
    env.EMAIL_API_KEY = "review-not-a-key";
    env.EMAIL_FROM = "Straightedge <quotes@straightedge.test>";
  }
  if (opts.stubs || opts.turnstile || opts.mail) {
    env.REVIEW_STUBS = "1";
    env.NODE_OPTIONS = `--require ${PRELOAD}`;
  }
  const s = await live.start({ env, tmpDir: opts.tmpDir, prepare: opts.prepare });
  s.pid = s.child.pid;
  return s;
}

/** Resident memory of a process in MB (Linux /proc). */
function rssMb(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch { return 0; }
}

/**
 * Poll GET /api/health and the server's RSS while something else runs.
 * @returns {{stop: () => {worstMs:number, medianMs:number, samples:number, failures:number, peakRssMb:number, baseRssMb:number}}}
 */
function monitor(s, { everyMs = 50, killAboveMb = 4500 } = {}) {
  const lat = [];
  let failures = 0;
  let peak = rssMb(s.pid);
  const base = peak;
  let stopped = false;
  let inFlight = 0;
  const tick = async () => {
    if (stopped) return;
    const r = rssMb(s.pid);
    if (r > peak) peak = r;
    if (r > killAboveMb) { try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ } }
    if (inFlight > 40) return; // do not pile up when the loop is stalled; the stalled ones record the stall
    inFlight++;
    const t0 = process.hrtime.bigint();
    try {
      const res = await live.request(s.port, { url: "/api/health", timeoutMs: 120000 });
      if (res.status !== 200) failures++;
      lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
    } catch { failures++; }
    inFlight--;
  };
  const timer = setInterval(tick, everyMs);
  return {
    peak: () => peak,
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (let i = 0; i < 100 && inFlight > 0; i++) await new Promise((r) => setTimeout(r, 50));
      const sorted = [...lat].sort((a, b) => a - b);
      return {
        worstMs: Math.round(sorted[sorted.length - 1] || 0),
        medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] || 0),
        samples: sorted.length, failures, peakRssMb: peak, baseRssMb: base,
      };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Names in a data folder of the running server. */
function ls(s, name) { try { return fs.readdirSync(path.join(s.dataDir, name)); } catch { return []; } }
function dirBytes(s, name) {
  let n = 0;
  for (const f of ls(s, name)) { try { n += fs.statSync(path.join(s.dataDir, name, f)).size; } catch { /* gone */ } }
  return n;
}

/** Live worker threads of the server process (Linux: tasks named "node" beyond the main thread are not reliable; count WorkerThread ids). */
function threadCount(pid) {
  try { return fs.readdirSync(`/proc/${pid}/task`).length; } catch { return 0; }
}

function scratch(name) {
  const dir = process.env.REVIEW_SCRATCH || path.join(require("os").tmpdir(), "sec-review-uploads");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

module.exports = { startServer, monitor, rssMb, sleep, ls, dirBytes, threadCount, scratch, live, PRELOAD };
