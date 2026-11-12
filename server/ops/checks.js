/**
 * The conditions that raise an alert (ops/alerts.js), checked every five
 * minutes and once at startup.
 *
 *   storage-high        upload folders at or above the warning line (80 %) of UPLOAD_DIR_MAX_MB
 *   database-high       database file at or above the warning line of DB_MAX_MB
 *   volume-low          the volume itself at least 90 % full (OPS_VOLUME_ALERT_PERCENT; 101 = never)
 *   webhook-rejected    3 or more Stripe webhooks refused for a bad signature in an hour
 *   webhook-failing     3 or more Stripe webhooks answered with any other failure in an hour
 *   mail-failing        3 or more customer-facing emails failed in an hour
 *   server-errors       5 or more server errors (5xx) in 15 minutes
 *   orders-attention    orders in a state that needs a person (mismatch, dispute, refund, …)
 *   startup-protections at startup: a critical protection is off
 *   previous-run-crash  at startup: the previous run ended in a crash
 *   previous-run-killed at startup: the previous run was killed (out of memory, or no draining time)
 *
 * Thresholds: OPS_WEBHOOK_FAIL_THRESHOLD, OPS_MAIL_FAIL_THRESHOLD (per hour),
 * OPS_ERROR_THRESHOLD (per 15 minutes). The storage line is the same
 * UPLOAD_DIR_WARN_PERCENT the upload guard already logs at.
 */
const crypto = require("crypto");
const events = require("./events");
const alerts = require("./alerts");
const status = require("./status");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function envInt(name, def, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
}

const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** The conditions that are true right now, as alerts ready to raise. */
function evaluate(now = Date.now()) {
  const out = [];
  const st = status.storage();

  if (st.files.percent >= st.warnPercent) {
    out.push({
      key: "storage-high",
      title: `Upload storage is ${Math.round(st.files.percent)}% full`,
      lines: [
        `Customer files use ${mb(st.files.usedBytes)} of the ${mb(st.files.maxBytes)} ceiling. At 100% new uploads are refused and visitors are told to email their files.`,
        "To make room: decline spam requests in Admin → RFQs (their files are then swept), shorten UPLOAD_RETENTION_HOURS, or raise UPLOAD_DIR_MAX_MB if the volume has space.",
      ],
      facts: [["Used", mb(st.files.usedBytes)], ["Ceiling (UPLOAD_DIR_MAX_MB)", mb(st.files.maxBytes)]],
    });
  }
  if (st.database.percent >= st.warnPercent) {
    out.push({
      key: "database-high",
      title: `The database is ${Math.round(st.database.percent)}% of its ceiling`,
      lines: [
        `The database file is ${mb(st.database.usedBytes)}; uploads are refused past ${mb(st.database.maxBytes)}. Every save rewrites the whole file, so a large database also slows the site.`,
        "Old draft quotes and unused parts are removed automatically every six hours. If it keeps growing, raise DB_MAX_MB and ask for the rows to be looked at.",
      ],
      facts: [["Database file", mb(st.database.usedBytes)], ["Ceiling (DB_MAX_MB)", mb(st.database.maxBytes)]],
    });
  }
  if (st.volume && st.volume.percentUsed >= envInt("OPS_VOLUME_ALERT_PERCENT", 90, 1, 101)) {
    out.push({
      key: "volume-low",
      title: `The Railway volume is ${Math.round(st.volume.percentUsed)}% full`,
      lines: [
        `Only ${mb(st.volume.freeBytes)} is free on the volume that holds the database and customer files. If it fills, saves fail.`,
        "Grow the volume in Railway (the service → the volume → Settings), or remove old volume backups and files.",
      ],
    });
  }

  const hookLimit = envInt("OPS_WEBHOOK_FAIL_THRESHOLD", 3, 1, 1000);
  const rejected = events.countSince("webhookRejected", HOUR, now);
  if (rejected >= hookLimit) {
    out.push({
      key: "webhook-rejected",
      title: "Stripe webhooks are being refused (signature)",
      lines: [
        `${rejected} webhook deliveries in the last hour failed signature verification. Either STRIPE_WEBHOOK_SECRET does not match the endpoint in Stripe, or someone other than Stripe is calling the address.`,
        "Paid orders are still marked paid when the buyer returns to the order page. In Stripe → Developers → Webhooks, open the endpoint, compare its signing secret with the Railway variable, and resend any failed events.",
      ],
    });
  }
  const hookFailed = events.countSince("webhookFailed", HOUR, now) + events.countSince("webhookRefused", HOUR, now);
  if (hookFailed >= hookLimit) {
    out.push({
      key: "webhook-failing",
      title: "Stripe webhooks are failing",
      lines: [
        `${hookFailed} webhook deliveries in the last hour were answered with an error (not a signature problem). Look at the endpoint's delivery log in Stripe for the status codes, and at the Railway deploy log around the same times.`,
      ],
    });
  }

  const mailLimit = envInt("OPS_MAIL_FAIL_THRESHOLD", 3, 1, 1000);
  const mailFailed = events.countSince("mailFailedCustomerFacing", HOUR, now);
  if (mailFailed >= mailLimit) {
    out.push({
      key: "mail-failing",
      title: "Emails are failing to send",
      lines: [
        `${mailFailed} emails failed in the last hour: order confirmations, request notices or account emails may not have arrived. The deploy log names the template and Resend's error for each.`,
        "Check the Resend dashboard (domain still verified, key active, sending limit not reached), then press “Send a test email” in Admin → System.",
      ],
    });
  }

  const errorLimit = envInt("OPS_ERROR_THRESHOLD", 5, 1, 10000);
  const errors = events.countSince("serverError", 15 * MIN, now);
  if (errors >= errorLimit) {
    out.push({
      key: "server-errors",
      title: "The site is answering with server errors",
      lines: [
        `${errors} requests in the last 15 minutes ended in a server error. Open the Railway deploy log and look for lines ending in “→ 500” and the error printed under each.`,
        "If it started right after a deploy, roll back to the previous deployment in Railway (the runbook's rollback section).",
      ],
    });
  }

  const attention = status.business(now).orders.needingAttention;
  if (attention.length) {
    const byStatus = {};
    for (const o of attention) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    out.push({
      key: "orders-attention",
      title: `${attention.length} order${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} a look`,
      lines: ["These orders are in a state that needs a person. Open Admin → Orders."],
      facts: Object.keys(byStatus).sort().map((s) => [s, String(byStatus[s])]),
      cooldownMs: 24 * HOUR,
    });
  }
  return out;
}

/** What is wrong at startup, as at most two alerts. */
function evaluateStartup(previousRun) {
  const out = [];
  const off = status.criticalOff();
  if (off.length) {
    // The key changes when the set of problems changes, so fixing one and leaving another tells the owner again.
    const fingerprint = crypto.createHash("sha256").update(off.map((p) => p.key).sort().join(",")).digest("hex").slice(0, 10);
    out.push({
      key: `startup-protections:${fingerprint}`,
      title: `The site started with ${off.length} protection${off.length === 1 ? "" : "s"} switched off`,
      lines: ["Each line below is a setting that is missing or wrong. The site is running, but without that protection."],
      facts: off.map((p) => [p.label, p.fix]),
      cooldownMs: 24 * HOUR,
    });
  }
  if (previousRun && previousRun.ended === "killed") {
    // Neither a clean stop nor an error: the process was killed. With the draining time set (15 s) a deploy
    // stops cleanly, so what is left is the container running out of memory or the host going away.
    out.push({
      key: "previous-run-killed",
      title: "The site was killed and restarted",
      lines: [
        "The previous run ended without a clean stop and without an error of its own: it was killed from outside. The usual cause is the container running out of memory while reading a very large or hostile upload; the other is a deploy with the draining time still at 0.",
        "Check Railway → the service → Metrics → Memory around the time of the restart, and Settings → Deploy → draining time (15 seconds). If memory hit the service's limit, raise the limit or lower MEMORY_BUDGET_MB (runbook, step 3).",
      ],
    });
  }
  if (previousRun && previousRun.ended === "crash") {
    out.push({
      key: "previous-run-crash",
      title: "The site restarted after a crash",
      lines: [
        `The previous run stopped on an error${previousRun.errorName ? ` (${previousRun.errorName})` : ""} and Railway started it again. The deploy log of the previous deployment has the details.`,
        "Once is worth a look. If this message repeats, roll back to the previous deployment (the runbook's rollback section).",
      ],
    });
  }
  return out;
}

async function run(now = Date.now(), opt = {}) {
  const results = [];
  const active = new Set();
  for (const a of evaluate(now)) {
    active.add(a.key);
    try { results.push({ key: a.key, ...(await alerts.raise(a.key, a, { now, ...opt })) }); } catch (err) { console.error("[ops] alert failed:", err.name); }
  }
  // A condition that has cleared leaves the status page.
  for (const k of ["storage-high", "database-high", "volume-low", "webhook-rejected", "webhook-failing", "mail-failing", "server-errors", "orders-attention"]) if (!active.has(k)) alerts.clear(k);
  return results;
}

async function runStartup(previousRun, opt = {}) {
  const results = [];
  for (const a of evaluateStartup(previousRun)) {
    try { results.push({ key: a.key, ...(await alerts.raise(a.key, a, opt)) }); } catch (err) { console.error("[ops] alert failed:", err.name); }
  }
  return results;
}

module.exports = { evaluate, evaluateStartup, run, runStartup };
