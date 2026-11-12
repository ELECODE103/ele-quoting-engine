/**
 * The facts behind Admin → System, the daily digest and the alerts, gathered
 * in one place so the three always agree.
 *
 * No secret, key, token or email address is ever returned: a setting is
 * reported as on or off (or, for a host name or a number, by its value).
 */
const fs = require("fs");
const events = require("./events");
const state = require("./state");
const canonicalHost = require("./canonicalHost");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const EXPIRY_SOON_DAYS = 3;

// Order statuses the code knows today. Anything else found in the database is still counted and
// listed (and marked as new to this page), so a status added later is never silently dropped.
const KNOWN_ORDER_STATUSES = new Set([
  "pending_payment", "pending_po", "paid", "paid_amount_mismatch", "received", "in_production",
  "quality_check", "packing", "shipped", "delivered", "cancelled",
]);
// Statuses that mean a person should look, by name or by the words in the name (so that
// "needs_attention", "disputed", "partially_refunded", "expired" are picked up when they exist).
const ATTENTION_WORDS = /attention|mismatch|dispute|refund|expired|failed|review|chargeback/i;

function needsAttention(status) {
  return ATTENTION_WORDS.test(String(status || ""));
}

function shortCommit(value) {
  const v = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(v) ? v.slice(0, 12) : "";
}

function build() {
  return {
    commit: shortCommit(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || process.env.GIT_COMMIT) || "unknown",
    branch: /^[\w./-]{1,100}$/.test(process.env.RAILWAY_GIT_BRANCH || "") ? process.env.RAILWAY_GIT_BRANCH : "",
    deploymentId: /^[\w-]{1,80}$/.test(process.env.RAILWAY_DEPLOYMENT_ID || "") ? process.env.RAILWAY_DEPLOYMENT_ID : "",
    node: process.version,
    environment: process.env.NODE_ENV || "development",
  };
}

/**
 * Every protection that depends on a setting, as on/off.
 * `critical` ones are the subject of the startup alert.
 */
function protections() {
  const turnstile = require("../security/turnstile");
  const fileCrypto = require("../services/fileCrypto");
  const testHooks = require("../security/testHooks");
  const mailer = require("../services/mailer");
  const list = [
    { key: "bot-check", label: "Bot check (Cloudflare Turnstile)", on: turnstile.configured(), critical: true, fix: "Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY." },
    { key: "file-encryption", label: "Customer files encrypted on the volume", on: fileCrypto.isEnabled(), critical: true, fix: "Set NORD_FILE_ENC_KEY (docs/security/file-encryption.md)." },
    { key: "jwt-secret", label: "Session secret at least 32 characters", on: (process.env.JWT_SECRET || "").length >= 32, critical: true, fix: "Set JWT_SECRET to a long random value (this signs everyone out and resets two-step enrolment)." },
    { key: "test-hooks-off", label: "Test-only behaviour switched off", on: !testHooks.enabled(), critical: true, fix: "Remove SE_TEST_HOOKS from the service variables." },
    { key: "stripe-webhook-secret", label: "Stripe webhook signing secret set", on: Boolean(process.env.STRIPE_WEBHOOK_SECRET), critical: true, fix: "Set STRIPE_WEBHOOK_SECRET from the endpoint's page in Stripe." },
    { key: "mailer", label: "Email sending configured", on: mailer.configured(), critical: true, fix: "Set EMAIL_API_KEY and EMAIL_FROM. Until then no order, request, confirmation or alert email is sent." },
    { key: "csp-enforced", label: "Browser content policy enforced", on: process.env.CSP_REPORT_ONLY !== "true", critical: true, fix: "Remove CSP_REPORT_ONLY from the service variables." },
    { key: "notify-address", label: "Shop notification address set (RFQ_NOTIFY_TO)", on: Boolean(process.env.RFQ_NOTIFY_TO), critical: false, fix: "Set RFQ_NOTIFY_TO; without it notices go to ADMIN_EMAIL, then to the address printed on the site." },
    { key: "admin-email", label: "Owner account named (ADMIN_EMAIL)", on: Boolean(process.env.ADMIN_EMAIL), critical: false, fix: "Set ADMIN_EMAIL." },
    { key: "frontend-url", label: "Public address for links set (FRONTEND_URL)", on: Boolean(process.env.FRONTEND_URL), critical: false, fix: "Set FRONTEND_URL to the https address of the canonical host." },
    { key: "canonical-host", label: "Canonical host set (CANONICAL_HOST)", on: Boolean(canonicalHost.readConfig().canonical), critical: false, fix: "Set CANONICAL_HOST and REDIRECT_HOSTS at domain cutover." },
    { key: "admin-recovery-unset", label: "One-shot admin recovery setting removed", on: !process.env.ADMIN_RECOVERY, critical: false, fix: "Remove ADMIN_RECOVERY: it repeats its action on every start." },
  ];
  return list;
}

function criticalOff() {
  return protections().filter((p) => p.critical && !p.on);
}

function storage() {
  const uploadGuards = require("../security/uploadGuards");
  const { limits } = require("../security/limits");
  const used = uploadGuards.storage.usage();
  const max = limits.storageMaxBytes;
  const dbUsed = uploadGuards.database.size();
  const dbMax = limits.databaseMaxBytes;
  let volume = null;
  try {
    if (typeof fs.statfsSync === "function") {
      const s = fs.statfsSync(uploadGuards.DATA_DIR);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      if (total > 0) volume = { totalBytes: total, freeBytes: free, percentUsed: Math.round(((total - free) / total) * 1000) / 10 };
    }
  } catch { /* not every platform reports it */ }
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    warnPercent: Math.round(limits.storageWarnFraction * 100),
    files: { usedBytes: used, maxBytes: max, percent: pct(used, max) },
    database: { usedBytes: dbUsed, maxBytes: dbMax, percent: pct(dbUsed, dbMax) },
    volume,
  };
}

function hoursSince(iso, now) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.max(0, (now - t) / HOUR_MS) : null;
}

/** Orders, requests and quotes, as counts and references. No names, addresses or notes. */
function business(now = Date.now()) {
  const { ordersDB, rfqsDB, quotesDB } = require("../models");
  const shortId = require("../emails/templates").shortId;
  const orders = ordersDB.getAll();
  const byStatus = {};
  for (const o of orders) { const s = String(o.status || "unknown"); byStatus[s] = (byStatus[s] || 0) + 1; }
  const statuses = Object.keys(byStatus).sort().map((s) => ({ status: s, count: byStatus[s], known: KNOWN_ORDER_STATUSES.has(s), attention: needsAttention(s) }));
  const recentOrders = orders
    .filter((o) => { const h = hoursSince(o.createdAt, now); return h !== null && h <= 24; })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((o) => ({ reference: shortId(o.id), status: String(o.status || "unknown"), total: Number(o.total) || 0, paymentMethod: String(o.paymentMethod || (o.poNumber ? "purchase order" : "card")), createdAt: o.createdAt }));
  const attentionOrders = orders.filter((o) => needsAttention(o.status)).map((o) => ({ reference: shortId(o.id), status: String(o.status), total: Number(o.total) || 0 }));

  const rfqs = rfqsDB.getAll();
  const open = rfqs.filter((r) => r.status === "new" || r.status === "in-review" || r.status === "in_review");
  const openRequests = open
    .map((r) => ({ reference: shortId(r.id), type: r.requestType === "part" ? "send-us-the-part" : "firm quote", status: r.status, ageHours: Math.round((hoursSince(r.createdAt, now) || 0) * 10) / 10 }))
    .sort((a, b) => b.ageHours - a.ageHours);
  const soon = now + EXPIRY_SOON_DAYS * DAY_MS;
  const firmExpiring = rfqs
    .filter((r) => r.status === "quoted" && r.validUntil && Date.parse(r.validUntil) > now && Date.parse(r.validUntil) <= soon)
    .map((r) => ({ reference: shortId(r.id), validUntil: r.validUntil, total: Number(r.quotedTotal) || 0 }));
  const draftExpiring = quotesDB.getAll().filter((q) => q.status === "draft" && q.expiresAt && Date.parse(q.expiresAt) > now && Date.parse(q.expiresAt) <= soon).length;

  return {
    orders: { total: orders.length, statuses, last24h: recentOrders, needingAttention: attentionOrders },
    requests: { open: openRequests.length, oldestHours: openRequests.length ? openRequests[0].ageHours : 0, list: openRequests.slice(0, 25) },
    quotes: { expirySoonDays: EXPIRY_SOON_DAYS, firmExpiring, draftExpiring },
  };
}

function parsing() {
  try { return require("../parsers/parsePool").pool.stats(); } catch { return null; }
}

function hosts() {
  const cfg = canonicalHost.readConfig();
  return {
    canonical: cfg.canonical || "",
    redirects: [...cfg.redirects],
    noindex: [...cfg.noindex],
    hstsAllHosts: cfg.hstsAllHosts,
    frontendUrlHost: canonicalHost.cleanHost(process.env.FRONTEND_URL),
    problems: cfg.problems,
  };
}

const RESETS_ON_RESTART = [
  "Every counter under “Since the last restart” (failed emails, webhook answers, server errors, sign-in pauses, parse timeouts and busy refusals).",
  "The list of recent events and of alerts raised.",
  "Rate limits, per-address upload budgets and the parse queue (as before; see the hardening reports).",
];
const SURVIVES_RESTART = [
  "When each alert was last emailed, and the day the last digest went out (data/ops/state.json on the volume).",
  "Orders, requests, quotes, storage and database sizes: read from the database and the volume each time.",
];

function collect(now = Date.now()) {
  const digest = require("./digest");
  const alerts = require("./alerts");
  return {
    generatedAt: new Date(now).toISOString(),
    build: build(),
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: new Date(events.startedAt).toISOString(),
    previousRun: state.get("run.previous", null),
    hosts: hosts(),
    protections: protections().map(({ key, label, on, critical, fix }) => ({ key, label, on, critical, fix: on ? "" : fix })),
    storage: storage(),
    business: business(now),
    parsing: parsing(),
    events: events.snapshot(),
    alerts: alerts.snapshot(),
    digest: digest.describe(now),
    backups: { lastFullDownloadAt: state.get("backup.lastFullAt", null) },
    resetsOnRestart: RESETS_ON_RESTART,
    survivesRestart: SURVIVES_RESTART,
  };
}

module.exports = { collect, build, protections, criticalOff, storage, business, parsing, hosts, needsAttention, KNOWN_ORDER_STATUSES, EXPIRY_SOON_DAYS };
