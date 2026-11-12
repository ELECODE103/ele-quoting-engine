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

// The order states are the state machine's (services/orderState.js STATES): pending_payment, pending_po, paid,
// received, in_production, quality_check, packing, shipped, delivered, expired, cancelled, refunded, and
// paid_amount_mismatch (written by earlier versions only). Anything else found in the database is still
// counted and listed (and marked as new to this page), so a status added later is never silently dropped.
const orderState = require("../services/orderState");
const KNOWN_ORDER_STATUSES = new Set(orderState.STATES);

// What asks for a person is NOT a status in the real state machine: it is a flag an order carries while it
// keeps its status (`order.attention`: duplicate-payment, late-payment, payment-mismatch, zero-payment,
// dispute, refund-problem — orderState.ATTENTION). Two more things are treated the same way here: the one
// legacy status that meant "paid, under review" (paid_amount_mismatch), and — so that a state added later is
// picked up without a change here — any status whose NAME says so (attention, mismatch, dispute, failed…).
// Refunded, partly refunded and expired are finished states or plain facts: counted and listed, never an
// alert (an alert about them would never clear).
const ATTENTION_WORDS = /attention|mismatch|duplicate|late[-_ ]?payment|under[-_ ]?review|needs[-_ ]?review|payment[-_ ]?review|disput|chargeback|failed/i;

/** Does a status NAME ask for a person? (For statuses this code does not know; the real flag is `order.attention`.) */
function needsAttention(status) {
  return ATTENTION_WORDS.test(String(status || ""));
}

/** Why an order needs the owner, or null: the state machine's flag first, then the status name. */
function attentionOf(order) {
  if (!order) return null;
  const flag = typeof order.attention === "string" ? order.attention : "";
  if (flag) return { code: flag.slice(0, 40), label: orderState.ATTENTION[flag] || flag.replace(/[-_]+/g, " ").slice(0, 40) };
  if (needsAttention(order.status)) return { code: String(order.status), label: KNOWN_ORDER_STATUSES.has(order.status) ? orderState.label(order.status) : String(order.status).slice(0, 40) };
  return null;
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
    { key: "unprivileged-user", label: "Server runs as an unprivileged user (not root)", on: !(typeof process.getuid === "function" && process.getuid() === 0), critical: false, fix: "In Railway, clear the service's Custom Start Command and remove RAILWAY_RUN_UID so the image's own start-up (docker-entrypoint.sh) is used." },
    { key: "admin-recovery-unset", label: "One-shot admin recovery setting removed", on: !process.env.ADMIN_RECOVERY, critical: false, fix: "Remove ADMIN_RECOVERY: it repeats its action on every start." },
    // The one-time admin setup code (security/adminAccount.js) has done its job once an admin account exists: it no
    // longer opens anything, and the startup log asks for it to be removed. Only whether it is set is reported.
    { key: "admin-setup-code-unset", label: "One-time admin setup code removed (ADMIN_SETUP_CODE)", on: !process.env.ADMIN_SETUP_CODE, critical: false, fix: "Remove ADMIN_SETUP_CODE once the admin account has been set up (with ADMIN_RECOVERY, if that was used to reopen setup)." },
  ];
  return list;
}

function criticalOff() {
  try { return protections().filter((p) => p.critical && !p.on); } catch { return []; }
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
  const flaggedByStatus = {};
  for (const o of orders) if (attentionOf(o)) { const s = String(o.status || "unknown"); flaggedByStatus[s] = (flaggedByStatus[s] || 0) + 1; }
  // `label` is the state machine's own name for the state (orderState.label), as the admin screens word it.
  const statuses = Object.keys(byStatus).sort().map((s) => ({ status: s, label: KNOWN_ORDER_STATUSES.has(s) ? orderState.label(s) : s, count: byStatus[s], known: KNOWN_ORDER_STATUSES.has(s), attention: Boolean(flaggedByStatus[s]), flagged: flaggedByStatus[s] || 0 }));
  const recentOrders = orders
    .filter((o) => { const h = hoursSince(o.createdAt, now); return h !== null && h <= 24; })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((o) => ({ reference: shortId(o.id), status: String(o.status || "unknown"), total: Number(o.total) || 0, paymentMethod: String(o.paymentMethod || (o.poNumber ? "purchase order" : "card")), createdAt: o.createdAt }));
  const attentionOrders = orders.filter((o) => attentionOf(o)).map((o) => ({ reference: shortId(o.id), status: String(o.status), reason: attentionOf(o).code, reasonLabel: attentionOf(o).label, total: Number(o.total) || 0 }));
  // Facts an order carries beside its status (not states, and not alerts): money partly sent back, a dispute still open.
  const partlyRefunded = orders.filter((o) => o.status !== "refunded" && Number(o.refundedAmount) > 0).length;
  const disputesOpen = orders.filter((o) => o.disputeStatus === "open").length;

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
    orders: { total: orders.length, statuses, last24h: recentOrders, needingAttention: attentionOrders, partlyRefunded, disputesOpen },
    requests: { open: openRequests.length, oldestHours: openRequests.length ? openRequests[0].ageHours : 0, list: openRequests.slice(0, 25) },
    quotes: { expirySoonDays: EXPIRY_SOON_DAYS, firmExpiring, draftExpiring },
  };
}

/** How card payments are set (services/orderLifecycle.js paymentSettings): on/off and numbers, never a key. */
function payments() {
  const p = require("../services/orderLifecycle").paymentSettings();
  return { cardPayments: Boolean(p.cardPayments), webhookSecret: Boolean(p.webhookSecret), promotionCodes: Boolean(p.promotionCodes), sessionMinutes: Number(p.sessionMinutes) || 0, shopEmails: Boolean(p.shopEmails) };
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
    seen: canonicalHost.seenHosts(),
    problems: cfg.problems,
  };
}

const RESETS_ON_RESTART = [
  "Every counter under “Since the last restart” (failed emails, webhook answers, server errors, sign-in waits, parse timeouts and busy refusals).",
  "The list of recent events and of alerts raised.",
  "Rate limits, per-address upload budgets and the parse queue (as before; see the hardening reports).",
];
const SURVIVES_RESTART = [
  "When each alert was last emailed, and the day the last digest went out (data/ops/state.json on the volume).",
  "Orders, requests, quotes, storage and database sizes: read from the database and the volume each time.",
];

/**
 * One section of the report. The sections read other modules' internals (the upload guard, the
 * parse pool, the models), which other branches are changing: if one of them is renamed or not
 * there, that section is reported as unavailable and the rest of the report still goes out.
 */
function section(name, fn, fallback) {
  try { return fn(); } catch (err) {
    if (!section.warned.has(name)) { section.warned.add(name); console.warn(`[ops] status section "${name}" is unavailable (${err.name || "Error"})`); }
    return fallback;
  }
}
section.warned = new Set();

const EMPTY_STORAGE = { warnPercent: 80, files: { usedBytes: 0, maxBytes: 0, percent: 0 }, database: { usedBytes: 0, maxBytes: 0, percent: 0 }, volume: null, unavailable: true };
const EMPTY_BUSINESS = { orders: { total: 0, statuses: [], last24h: [], needingAttention: [], partlyRefunded: 0, disputesOpen: 0 }, requests: { open: 0, oldestHours: 0, list: [] }, quotes: { expirySoonDays: EXPIRY_SOON_DAYS, firmExpiring: [], draftExpiring: 0 }, unavailable: true };

/**
 * "Limits and budgets": where the site stands against each ceiling the availability work set, read
 * from the modules that enforce them. (Until the second integration pass this was a list of guessed
 * getter names; these are the real ones.) Each source is asked on its own: one that throws, or
 * returns something that is not plain numbers and short words, is left out and the rest still show.
 *
 *   memory         security/limits.js             the budget everything else is derived from
 *   pricing        security/pricingGate.js stats() and services/pricingMemo.js stats()
 *   draftQuotes    security/quoteGuards.js stats()
 *   confirmationEmail, shopNotices   services/mailer.js capCounters()
 *   unverifiedRequests               security/botGuard.js unverifiedRequestStats()
 *   cleanUp        services/storagePressure.js status()   what the server last removed by itself
 *   fileParsing    parsers/parsePool.js pool.stats()      the counters the availability work added
 *   answers        security/answerCeiling.js counters
 *
 * The same figures, with the per-holder detail, are at GET /api/admin/storage.
 */
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && obj[k] !== undefined).map((k) => [k, obj[k]]));
const BUDGET_SOURCES = [
  ["memory", () => {
    const { limits } = require("../security/limits");
    return { budgetMb: limits.memoryBudgetMb, parseWorkerHeapMb: limits.parseMaxHeapMb, parsingTogetherMb: limits.parseRssLimitMb, parsingAloneMb: limits.parseRssSoloLimitMb, processCeilingMb: limits.parseRssCeilingMb, databaseCeilingMb: Math.round(limits.databaseMaxBytes / 1048576) };
  }],
  ["pricing", () => {
    const gate = require("../security/pricingGate").stats();
    const runner = require("../services/pricingMemo").stats();
    return { inFlight: gate.inFlight, admitted: gate.admitted, toldToWait: gate.refusedClient, overHourlyAllowance: gate.refusedBudget, tooManyLines: gate.refusedLines, waitingLight: runner.lightWaiting, waitingHeavy: runner.heavyWaiting, priced: runner.finished, tooSlow: runner.refusedSlow, toldBusy: runner.refusedBusy, longestPieceMs: runner.longestPieceMs };
  }],
  ["draftQuotes", () => {
    const q = require("../security/quoteGuards").stats();
    return { created: q.created, refusedTooManyNew: q.refusedRate, refusedAllowanceFull: q.refusedBytes, refusedDatabaseFull: q.refusedDatabase, refusedRepricedTooOften: q.refusedReprice, madeRoomWithOwnIdleDrafts: q.replacedOwn };
  }],
  ["confirmationEmail", () => {
    const m = require("../services/mailer").capCounters().unconfirmed;
    return pick(m, ["capPerHour", "sentThisHour", "firstFewThisHour", "heldThisHour", "waitingToBeSent", "sentLaterSinceStart", "turnedAwaySinceStart"]);
  }],
  ["shopNotices", () => pick(require("../services/mailer").capCounters().shop, ["capPerHour", "sentThisHour", "heldThisHour"])],
  ["unverifiedRequests", () => pick(require("../security/botGuard").unverifiedRequestStats(), ["capPerHour", "acceptedThisHour", "firstFewThisHour", "refusedSinceStart"])],
  ["cleanUp", () => {
    const st = require("../services/storagePressure").status();
    const last = (r) => (r ? { at: String(r.at || "").slice(0, 16).replace("T", " "), removedDrafts: r.removedDrafts || 0, removedUploads: r.removedUploads || 0, removedParts: r.removedParts || 0 } : null);
    return {
      databaseCleanUpAtPercent: st.database.sweepAtPercent, databaseVisitorsPausedAtPercent: st.database.anonymousRefusedAtPercent,
      filesCleanUpAtPercent: st.files.evictAtPercent, filesVisitorsPausedAtPercent: st.files.anonymousRefusedAtPercent,
      lastDatabaseCleanUp: last(st.database.lastRelief), lastFilesCleanUp: last(st.files.lastRelief),
    };
  }],
  ["fileParsing", () => pick(require("../parsers/parsePool").pool.stats(), ["overBudget", "queueFullForClient", "rerunAlone", "shortOfRoom"])],
  ["answers", () => { const c = require("../security/answerCeiling").counters; return { refusedTooLarge: c.refused, largestBytes: c.largestBytes }; }],
];
function plain(value, depth = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "string") return /^[\w .:%/-]{0,60}$/.test(value) ? value : undefined; // short words only: never an address or free text
  if (depth >= 2 || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 20)) {
    const p = plain(v, depth + 1);
    if (p !== undefined && /^[A-Za-z][\w]{0,40}$/.test(k)) out[k] = p;
  }
  return out;
}
function extras() {
  const out = {};
  for (const [name, read] of BUDGET_SOURCES) {
    try {
      const value = plain(read());
      if (value !== undefined && value !== null && (typeof value !== "object" || Object.keys(value).length > 0)) out[name] = value;
    } catch { /* that module is not usable right now: left out, the rest still show */ }
  }
  return out;
}

function safeStorage() { return section("storage", storage, EMPTY_STORAGE); }
function safeBusiness(now) { return section("business", () => business(now), EMPTY_BUSINESS); }

function collect(now = Date.now()) {
  const digest = require("./digest");
  const alerts = require("./alerts");
  return {
    generatedAt: new Date(now).toISOString(),
    build: build(),
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: new Date(events.startedAt).toISOString(),
    previousRun: state.get("run.previous", null),
    hosts: section("hosts", hosts, { canonical: "", redirects: [], noindex: [], hstsAllHosts: false, frontendUrlHost: "", seen: [], problems: [] }),
    protections: section("protections", () => protections().map(({ key, label, on, critical, fix }) => ({ key, label, on, critical, fix: on ? "" : fix })), []),
    storage: safeStorage(),
    business: safeBusiness(now),
    parsing: parsing(),
    payments: section("payments", payments, null),
    extras: extras(),
    events: events.snapshot(),
    alerts: alerts.snapshot(),
    digest: section("digest", () => digest.describe(now), null),
    backups: { lastFullDownloadAt: state.get("backup.lastFullAt", null) },
    resetsOnRestart: RESETS_ON_RESTART,
    survivesRestart: SURVIVES_RESTART,
  };
}

module.exports = { collect, build, protections, criticalOff, storage: safeStorage, business: safeBusiness, parsing, hosts, extras, BUDGET_SOURCES, payments, section, plain, needsAttention, attentionOf, KNOWN_ORDER_STATUSES, EXPIRY_SOON_DAYS };
