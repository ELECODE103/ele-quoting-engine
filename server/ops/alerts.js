/**
 * Alerts: one email to the shop when something needs a person, and not the
 * same email again every few minutes.
 *
 *   raise(key, { title, lines, facts })
 *
 * `key` names the condition ("storage-high", "webhook-rejected", …). For each
 * key at most one email goes out per cooldown (OPS_ALERT_COOLDOWN_HOURS,
 * default 6), and at most OPS_ALERT_MAX_PER_DAY (default 12) alert emails go
 * out in any 24 hours whatever the keys. Both limits are remembered on the
 * volume (ops/state.js), so a crash loop or a run of redeploys cannot get
 * round them.
 *
 * Every alert that passes its cooldown is also written to the deploy log as
 * one line starting with "ALERT", whether or not email is configured, and is
 * kept (in memory) for the admin System page.
 *
 * An alert never carries customer text: titles and lines are written here and
 * in ops/checks.js from fixed words and numbers.
 */
const state = require("./state");
const opsEmails = require("./opsEmails");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function envNumber(name, def, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}
const cooldownMs = () => envNumber("OPS_ALERT_COOLDOWN_HOURS", 6, 0.01, 168) * HOUR_MS;
const maxPerDay = () => Math.floor(envNumber("OPS_ALERT_MAX_PER_DAY", 12, 1, 200));

const KEY_RE = /^[a-z0-9][a-z0-9:._-]{0,80}$/;

// In memory, for the status page: key → { key, title, firstAt, lastAt, lastEmailedAt, times }
const seen = new Map();

function adminUrl() {
  const base = String(process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return /^https?:\/\//.test(base) ? `${base}/admin` : undefined;
}

/**
 * @param {string} key
 * @param {{title: string, lines?: string[], facts?: Array<[string,string]>, cooldownMs?: number}} alert
 * @param {object} [opt] for tests: { now, mailer, log }
 * @returns {Promise<{suppressed: boolean, emailed: boolean, reason?: string}>}
 */
async function raise(key, alert, opt = {}) {
  if (!KEY_RE.test(String(key))) throw new Error("alert key must be a short lower-case label");
  const now = typeof opt.now === "number" ? opt.now : Date.now();
  const mailer = opt.mailer || require("../services/mailer");
  const log = opt.log || ((line) => console.error(line));

  const entry = seen.get(key) || { key, title: alert.title, firstAt: new Date(now).toISOString(), times: 0, lastEmailedAt: null };
  entry.title = alert.title;
  entry.lastAt = new Date(now).toISOString();
  entry.times += 1;
  seen.set(key, entry);

  const last = state.get("alerts.lastRaised", {});
  const cool = typeof alert.cooldownMs === "number" ? alert.cooldownMs : cooldownMs();
  if (last[key] && now - last[key] < cool) return { suppressed: true, emailed: false, reason: "cooldown" };

  // Passed the cooldown: it is logged now, emailed if possible.
  last[key] = now;
  for (const k of Object.keys(last)) if (now - last[k] > 30 * DAY_MS) delete last[k];
  state.set("alerts.lastRaised", last);
  log(`ALERT [${key}] ${alert.title}${alert.lines && alert.lines[0] ? ` — ${alert.lines[0]}` : ""}${alert.facts && alert.facts.length ? ` [${alert.facts.map((f) => f[0]).join("; ")}]` : ""}`);

  if (!mailer.configured()) return { suppressed: false, emailed: false, reason: "mailer-not-configured" };

  const sentTimes = (state.get("alerts.emailTimes", []) || []).filter((t) => now - t < DAY_MS);
  if (sentTimes.length >= maxPerDay()) {
    log(`ALERT email not sent for [${key}]: the limit of ${maxPerDay()} alert emails in 24 hours is reached. See Admin → System.`);
    return { suppressed: false, emailed: false, reason: "daily-cap" };
  }
  const ok = await mailer.send({ to: mailer.shopNotifyAddress(), ...opsEmails.alertEmail({ title: alert.title, lines: alert.lines || [], facts: alert.facts || [], adminUrl: adminUrl() }) });
  if (ok) {
    sentTimes.push(now);
    state.set("alerts.emailTimes", sentTimes);
    entry.lastEmailedAt = new Date(now).toISOString();
  }
  return { suppressed: false, emailed: Boolean(ok), reason: ok ? undefined : "send-failed" };
}

/** For the status page: what has been raised since the process started, newest first. */
function snapshot() {
  return [...seen.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

/** A condition that is no longer true drops off the status page (its cooldown is kept). */
function clear(key) {
  seen.delete(key);
}

function reset() {
  seen.clear();
}

module.exports = { raise, snapshot, clear, reset, cooldownMs, maxPerDay };
