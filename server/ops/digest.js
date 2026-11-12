/**
 * The daily digest: one email each morning with what happened and what is
 * waiting, so the owner does not have to open the admin pages or the deploy
 * log to know the site is healthy.
 *
 * Sent at OPS_DIGEST_HOUR (0–23, default 7) Central time — the time zone is
 * fixed to America/Chicago, daylight saving included — and only when the
 * mailer is configured. Which day's digest went out last is kept on the volume
 * (ops/state.js), so a restart neither repeats nor skips one: if the service
 * was down at the hour, the digest goes out when it is next up that day.
 * OPS_DIGEST=off switches the schedule off; the admin button still works.
 *
 * Contents: orders in the last 24 hours and every order status with its count,
 * under the order state machine's own names (services/orderState.js; a status
 * this code has never heard of is listed, not dropped), orders flagged for the
 * owner, requests
 * waiting for a quote, quotes about to lapse, storage and database against
 * their ceilings, and the counters from ops/events.js. References and amounts
 * only: no customer name, address, note or file name.
 */
const events = require("./events");
const state = require("./state");
const status = require("./status");
const opsEmails = require("./opsEmails");

const TIME_ZONE = "America/Chicago";
const MAX_ATTEMPTS_PER_DAY = 3;

function digestHour() {
  const n = Number(process.env.OPS_DIGEST_HOUR);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 7;
}
function scheduleOn() {
  return String(process.env.OPS_DIGEST || "").trim().toLowerCase() !== "off";
}

/** The date ("2026-11-12") and hour (0–23) in Central time for an instant. */
function centralParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

function longDate(now) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(now));
}
function centralTime(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "unknown";
  return `${new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(t))} Central`;
}

/** The state machine's own name for an order status ("awaiting payment", "PO to confirm"); an unknown one as it is. */
const stateName = (st) => (status.KNOWN_ORDER_STATUSES.has(st) ? require("../services/orderState").label(st) : String(st));
const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;
const age = (hours) => (hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} h`);

// Parse-pool counters only ever go up; the digest reports the change since the last one.
let poolAtLastDigest = null;

/** Build the digest for `now`. Pure apart from reading the database and the counters. */
function build(now = Date.now()) {
  const biz = status.business(now);
  const st = status.storage();
  const counted = events.digestCounts();
  const c = counted.counts;
  const pool = status.parsing() || {};
  const prev = poolAtLastDigest || {};
  const poolDelta = (k) => Math.max(0, (pool[k] || 0) - (prev[k] || 0));
  const off = status.criticalOff();
  const extras = status.extras();

  const sections = [];

  const newOrders = biz.orders.last24h;
  sections.push({
    title: "New orders, last 24 hours",
    summary: newOrders.length ? `${newOrders.length} · ${money(newOrders.reduce((s, o) => s + o.total, 0))}` : "none",
    rows: newOrders.slice(0, 20).map((o) => [`Order ${o.reference}`, `${money(o.total)} · ${stateName(o.status)} · ${o.paymentMethod}`]),
  });

  sections.push({
    title: "All orders by status",
    summary: String(biz.orders.total),
    // Every status found in the database is listed under the state machine's own name for it (services/orderState.js:
    // "awaiting payment", "PO to confirm", "expired", "refunded"…), including ones this code does not know yet.
    rows: [
      ...biz.orders.statuses.map((s) => [`${s.label || s.status}${s.known ? "" : " (new status)"}${s.flagged ? ` — ${s.flagged === s.count ? "" : `${s.flagged} `}need${s.flagged === 1 ? "s" : ""} a look` : ""}`, String(s.count)]),
      ...(biz.orders.partlyRefunded ? [["of these, partly refunded (still active)", String(biz.orders.partlyRefunded)]] : []),
      ...(biz.orders.disputesOpen ? [["of these, with a payment dispute open", String(biz.orders.disputesOpen)]] : []),
    ],
  });

  // Orders flagged for the owner (a payment the site would not settle on its own, a dispute, a refund problem):
  // the state machine's flag, in the words the admin order list uses. Cleared in Admin → Orders with a note.
  if (biz.orders.needingAttention.length) {
    sections.push({
      title: "Orders needing a look",
      summary: String(biz.orders.needingAttention.length),
      rows: biz.orders.needingAttention.slice(0, 20).map((o) => [`Order ${o.reference}`, `${o.reasonLabel || o.reason} · ${stateName(o.status)} · ${money(o.total)}`]),
    });
  }

  sections.push({
    title: "Requests waiting for a quote",
    summary: biz.requests.open ? `${biz.requests.open} · oldest ${age(biz.requests.oldestHours)}` : "none",
    rows: biz.requests.list.slice(0, 15).map((r) => [`Request ${r.reference}`, `${r.type} · waiting ${age(r.ageHours)}`]),
  });

  sections.push({
    title: `Quotes lapsing within ${biz.quotes.expirySoonDays} days`,
    summary: `${biz.quotes.firmExpiring.length} firm · ${biz.quotes.draftExpiring} instant`,
    rows: biz.quotes.firmExpiring.slice(0, 15).map((q) => [`Firm quote ${q.reference}`, `${money(q.total)} · until ${centralTime(q.validUntil)}`]),
  });

  sections.push({
    title: "Storage",
    summary: st.unavailable ? "not available" : st.files.percent >= st.warnPercent || st.database.percent >= st.warnPercent ? "NEAR A CEILING" : "ok",
    rows: [
      ["Customer files", `${mb(st.files.usedBytes)} of ${mb(st.files.maxBytes)} (${st.files.percent}%)`],
      ["Database", `${mb(st.database.usedBytes)} of ${mb(st.database.maxBytes)} (${st.database.percent}%)`],
      ...(st.volume ? [["Railway volume", `${st.volume.percentUsed}% used, ${mb(st.volume.freeBytes)} free`]] : []),
    ],
  });

  const trouble = (c.mailFailed || 0) + (c.webhookRejected || 0) + (c.webhookFailed || 0) + (c.webhookRefused || 0) + (c.serverError || 0);
  sections.push({
    title: `Since ${centralTime(counted.since)}`,
    summary: trouble ? "SEE BELOW" : "nothing failed",
    rows: [
      ["Emails sent / failed", `${c.mailSent || 0} / ${c.mailFailed || 0}`],
      ["Stripe webhooks ok / bad signature / other failure", `${c.webhookOk || 0} / ${c.webhookRejected || 0} / ${(c.webhookFailed || 0) + (c.webhookRefused || 0)}`],
      ["Server errors (5xx)", String(c.serverError || 0)],
      // (The per-address lock is gone. What is counted now: the "wrong passwords tried on your account" notice,
      //  sent at most once a day per account, and sign-in attempts answered "wait" — try-later, account-busy, two-factor-paused.)
      ["Sign-in: accounts sent a wrong-passwords notice / attempts told to wait", `${c.signinPauseStarted || 0} / ${c.signinPaused || 0}`],
      ["Uploads refused: storage full", String(c.storageRefused || 0)],
      ["File parsing: timed out / told “busy” / out of memory", `${poolDelta("timedOut")} / ${poolDelta("busy")} / ${poolDelta("outOfMemory")}`],
      ["Requests turned away by a rate limit", String(c.rateLimited || 0)],
    ],
  });

  // Figures other modules offer when they are there (mail cap, memory budget, draft-quote counts…): shown as given.
  const extraRows = [];
  for (const [name, value] of Object.entries(extras)) {
    if (value && typeof value === "object") extraRows.push([name, Object.entries(value).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ").slice(0, 200)]);
    else extraRows.push([name, String(value)]);
  }
  if (extraRows.length) sections.push({ title: "Limits and budgets", summary: String(extraRows.length), rows: extraRows });

  if (off.length) {
    sections.push({ title: "Protections switched off", summary: String(off.length), rows: off.map((p) => [p.label, p.fix]) });
  }

  const headlineBits = [
    `${newOrders.length} new order${newOrders.length === 1 ? "" : "s"}`,
    `${biz.requests.open} request${biz.requests.open === 1 ? "" : "s"} waiting`,
    biz.orders.needingAttention.length ? `${biz.orders.needingAttention.length} order${biz.orders.needingAttention.length === 1 ? "" : "s"} needing a look` : null,
    trouble ? `${trouble} failure${trouble === 1 ? "" : "s"} to check` : "nothing failed",
    off.length ? `${off.length} protection${off.length === 1 ? "" : "s"} off` : null,
  ].filter(Boolean);

  const base = String(process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return opsEmails.digestEmail({
    dateLabel: longDate(now),
    headline: `${headlineBits.join(" · ")}.`,
    sections,
    adminUrl: /^https?:\/\//.test(base) ? `${base}/admin` : undefined,
    footnote: `The failure counts are kept in memory and start again when the site restarts (last start: ${centralTime(new Date(events.startedAt).toISOString())}). Orders, requests and sizes are read from the database and the volume.`,
  });
}

/**
 * Send the digest now.
 * @param {object} [opt]
 * @param {boolean} [opt.scheduled] the daily run: marks the day as done and starts the counters again
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function send(now = Date.now(), opt = {}) {
  const mailer = opt.mailer || require("../services/mailer");
  if (!mailer.configured()) return { sent: false, reason: "mailer-not-configured" };
  const message = build(now);
  const ok = await mailer.send({ to: mailer.shopNotifyAddress(), ...message });
  if (ok && opt.scheduled) {
    events.markDigestSent(now);
    poolAtLastDigest = { ...(status.parsing() || {}) };
  }
  if (ok) state.set("digest.lastSentAt", new Date(now).toISOString());
  return ok ? { sent: true } : { sent: false, reason: "send-failed" };
}

const attempts = { date: "", count: 0 };

/** Called every minute: sends today's digest once the hour has come, if it has not gone out yet. */
async function tick(now = Date.now(), opt = {}) {
  if (!scheduleOn()) return { sent: false, reason: "schedule-off" };
  const mailer = opt.mailer || require("../services/mailer");
  if (!mailer.configured()) return { sent: false, reason: "mailer-not-configured" };
  const { date, hour } = centralParts(now);
  if (hour < digestHour()) return { sent: false, reason: "before-hour" };
  if (state.get("digest.lastDate") === date) return { sent: false, reason: "already-sent" };
  if (attempts.date !== date) { attempts.date = date; attempts.count = 0; }
  if (attempts.count >= MAX_ATTEMPTS_PER_DAY) return { sent: false, reason: "gave-up-today" };
  attempts.count += 1;
  const r = await send(now, { ...opt, scheduled: true });
  if (r.sent) state.set("digest.lastDate", date);
  else if (attempts.count >= MAX_ATTEMPTS_PER_DAY) console.error(`[ops] the daily digest could not be sent after ${MAX_ATTEMPTS_PER_DAY} tries today; it will be tried again tomorrow.`);
  return r;
}

function describe(now = Date.now()) {
  const mailer = require("../services/mailer");
  return {
    schedule: scheduleOn() ? "on" : "off",
    hourCentral: digestHour(),
    timeZone: TIME_ZONE,
    mailerConfigured: mailer.configured(),
    lastDate: state.get("digest.lastDate", null),
    lastSentAt: state.get("digest.lastSentAt", null),
    centralNow: centralParts(now),
  };
}

function resetForTests() {
  attempts.date = ""; attempts.count = 0; poolAtLastDigest = null;
}

module.exports = { build, send, tick, describe, centralParts, digestHour, TIME_ZONE, resetForTests };
