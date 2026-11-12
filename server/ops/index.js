/**
 * Operations: everything that keeps the site up and tells the owner when it
 * is not. server/index.js calls three functions, one line each:
 *
 *   require("./ops").install(app)       early, right after the security headers:
 *                                       one canonical host (ops/canonicalHost.js)
 *                                       and the response counter (ops/observer.js)
 *   require("./ops").mountRoutes(app)   with the other API routers: the admin
 *                                       System routes and the full backup
 *   require("./ops").started(server)    once listening: clean shutdown on SIGTERM,
 *                                       the startup alert, the five-minute checks
 *                                       and the daily digest
 *
 * Settings (all optional; .env.example lists them):
 *   CANONICAL_HOST, REDIRECT_HOSTS, NOINDEX_HOSTS, HSTS_ALL_HOSTS
 *   OPS_DIGEST_HOUR, OPS_DIGEST, OPS_ALERT_COOLDOWN_HOURS, OPS_ALERT_MAX_PER_DAY,
 *   OPS_ERROR_THRESHOLD, OPS_MAIL_FAIL_THRESHOLD, OPS_WEBHOOK_FAIL_THRESHOLD
 *   SHUTDOWN_GRACE_MS, BACKUP_MAX_MB
 */
const canonicalHost = require("./canonicalHost");
const observer = require("./observer");
const events = require("./events");
const state = require("./state");

const CHECK_EVERY_MS = 5 * 60 * 1000;
const DIGEST_TICK_MS = 60 * 1000;

function install(app) {
  const cfg = canonicalHost.install(app);
  app.use(observer.middleware);
  observer.watchMailer();
  return cfg;
}

function mountRoutes(app) {
  app.use("/api", require("./routes").createRouter());
}

/** How the previous run ended, worked out from what it left in the state file. */
function rollRunRecord() {
  const last = state.get("run.current", null);
  let previous = null;
  if (last && typeof last === "object") {
    previous = {
      startedAt: last.startedAt || null,
      endedAt: last.endedAt || null,
      // "clean": it handled SIGTERM. "crash": it stopped on an error. Neither: it was killed
      // (Railway's draining time ran out, the container ran out of memory, or the host went away).
      ended: last.ended === "clean" || last.ended === "crash" ? last.ended : "killed",
      errorName: typeof last.errorName === "string" ? last.errorName.slice(0, 60) : "",
      commit: last.commit || "",
    };
  }
  state.set("run.previous", previous);
  state.set("run.current", { startedAt: new Date(events.startedAt).toISOString(), commit: require("./status").build().commit });
  return previous;
}

function started(server, opt = {}) {
  const production = process.env.NODE_ENV === "production";
  const previousRun = rollRunRecord();

  require("./shutdown").install(server, {
    onStopped: () => {
      const cur = state.get("run.current", {}) || {};
      state.set("run.current", { ...cur, ended: "clean", endedAt: new Date().toISOString() });
    },
  });

  // Watches a crash go by without changing what happens next (the process still exits non-zero and
  // Railway restarts it): the next start can then say that it followed a crash.
  process.on("uncaughtExceptionMonitor", (err) => {
    try {
      const cur = state.get("run.current", {}) || {};
      state.set("run.current", { ...cur, ended: "crash", endedAt: new Date().toISOString(), errorName: String((err && err.name) || "Error").replace(/[^\w.-]/g, "").slice(0, 60) });
    } catch { /* the crash goes on as it would have */ }
  });

  const hosts = canonicalHost.describe();
  for (const line of hosts.lines) console.log(line);
  for (const line of hosts.warnings) console.warn(line);

  if (!production && !opt.force) return { previousRun };

  const checks = require("./checks");
  const digest = require("./digest");
  setImmediate(() => { checks.runStartup(previousRun).catch((err) => console.error("[ops] startup check failed:", err.name)); });
  const checkTimer = setInterval(() => { checks.run().catch((err) => console.error("[ops] check failed:", err.name)); }, CHECK_EVERY_MS);
  const digestTimer = setInterval(() => { digest.tick().catch((err) => console.error("[ops] digest failed:", err.name)); }, DIGEST_TICK_MS);
  if (checkTimer.unref) checkTimer.unref();
  if (digestTimer.unref) digestTimer.unref();
  console.log(`[ops] alerts ${require("../services/mailer").configured() ? "by email and in this log" : "in this log only (email is not configured)"}; daily digest ${digest.describe().schedule === "on" ? `at ${digest.digestHour()}:00 Central` : "switched off"}.`);
  return { previousRun, checkTimer, digestTimer };
}

module.exports = { install, mountRoutes, started };
