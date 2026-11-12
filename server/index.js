require("dotenv").config();

const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { ready: dbReady } = require("./models/database");
const { seedDatabase } = require("./config/seed");

// ─── Environment Variable Validation ────────────────────────────
// STRIPE_WEBHOOK_SECRET is required: without it every Stripe event is refused, so a buyer who
// pays and closes the tab stays "awaiting payment" and the shop is never told (review F-18).
const REQUIRED_ENV_PROD = ["JWT_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
if (process.env.NODE_ENV === "production") {
  // Names only: the value of a variable is never printed.
  const missing = REQUIRED_ENV_PROD.filter((key) => !String(process.env[key] || "").trim());
  if (missing.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(", ")}`);
    if (missing.includes("STRIPE_WEBHOOK_SECRET")) {
      console.error("FATAL: STRIPE_WEBHOOK_SECRET is not set, so the server will not start. Without it Stripe cannot tell this site that a customer has paid: orders would stay \"awaiting payment\" and the shop would get no order email. In the Stripe dashboard open Developers > Webhooks, add an endpoint for https://<your site>/api/stripe/webhook, copy its signing secret (it starts with whsec_) and set it as STRIPE_WEBHOOK_SECRET in the host's variables.");
    }
    process.exit(1);
  }
}

// The robot check: in production the keys are required unless the owner waives it in so many
// words (security/botCheckStartup.js). Names only are printed, never a value.
{
  const bot = require("./security/botCheckStartup").check(process.env);
  if (!bot.ok) {
    for (const line of bot.fatal) console.error(line);
    process.exit(1);
  }
  if (bot.warning) console.warn(bot.warning);
}

// A file-encryption key that is set but unusable (too short, a placeholder) is a
// misconfiguration, not a preference: stop the deploy rather than "encrypt" with it.
{
  const keyProblem = require("./services/fileCrypto").configProblem();
  if (keyProblem) {
    console.error(`${process.env.NODE_ENV === "production" ? "FATAL" : "WARNING"}: ${keyProblem}`);
    if (process.env.NODE_ENV === "production") process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Before anything else: a request that arrives on a connection whose previous request was refused
// and is only being drained is not run (security/uploadGuards.js lingerThenClose).
app.use(require("./security/uploadGuards").refuseOnLingering);

// ─── Trust proxy (required behind Railway/load balancer) ─────────
if (process.env.NODE_ENV === "production") {
  // Hops whose X-Forwarded-For entry is believed: Railway's edge is one. Behind a second proxy
  // (Cloudflare in front of Railway) set TRUST_PROXY_HOPS=2, or every visitor shares one rate limit.
  app.set("trust proxy", require("./security/limits").limits.trustProxyHops);
}

// ─── Security Middleware ────────────────────────────────────────
// Content-Security-Policy (no inline or eval script), frame-ancestors, Referrer-Policy,
// Permissions-Policy, HSTS: all in server/security/headers.js, with the reason for each source.
require("./security/headers").install(app, { distDir: path.join(__dirname, "..", "client", "dist") });
require("./ops").install(app); // one canonical host (CANONICAL_HOST / REDIRECT_HOSTS) and the counters behind Admin → System: server/ops

// Rate limiting — generous for normal use, blocks abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: require("./security/limits").limits.rateApiPer15Min, // per client (default 200)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require("./security/clientKey").clientKey,   // IPv6 clients are keyed by /64
  skip: require("./security/rateLimits").skipGeneral,        // health check; quote pricing has its own limiter
  message: { error: "Too many requests, please try again later." },
});
app.use("/api", apiLimiter);

// Stricter limit on file uploads
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: require("./security/limits").limits.rateUploadPer15Min, // default 50
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require("./security/clientKey").clientKey,
  message: { error: "Upload limit reached. Please try again later." },
});
app.use("/api/upload", uploadLimiter);

// Limiters for the other expensive routes: quote pricing, quote session reads,
// DXF unit changes, drawing uploads, PDFs, backups (server/security/rateLimits.js).
require("./security/rateLimits").install(app);

// CORS: the site's own origin and FRONTEND_URL only (plus the dev servers outside production),
// with the headers the app's pages send. Never a reflected origin. See server/security/cors.js.
require("./security/cors").install(app);

// ─── Compression (text assets and HTML; Railway's edge does not gzip for us) ──
app.use(require("compression")());

// ─── Stripe Webhook (raw body — must be before express.json) ────
const stripeWebhook = require("./routes/stripeWebhook");
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

// Request bodies: 1 MB of JSON is far more than any route here sends (the largest is a quote
// configuration of a few KB; files go through multer, not through these parsers). A route that
// ever needs more must raise the limit for itself, not here. JSON_BODY_LIMIT_KB overrides.
app.use(express.json({ limit: require("./security/limits").limits.jsonBodyBytes }));
// No urlencoded parser: no route reads a form-encoded body (forms with files go through multer,
// everything else is JSON). Without it a plain HTML form posted from another site arrives with
// an empty body instead of being parsed into one a JSON route would accept.

// ─── Health Check (no version exposure) ──────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// ─── API Routes ─────────────────────────────────────────────────
require("./security").mount(app); // bot check, form tokens and the gates in front of upload / pricing
const apiRoutes = require("./routes/api");
app.use("/api", apiRoutes);

// Auth routes
const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes);

// Order routes
const orderRoutes = require("./routes/orders");
app.use("/api/orders", orderRoutes);

// RFQ routes (firm-quote requests for production quantities / flagged parts)
// Each request emails the shop and the address the sender typed, so creating
// them is capped per IP well above what a buyer sends and well below a flood.
const rfqCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: require("./security/limits").limits.rateRfqPerHour, // default 20
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require("./security/clientKey").clientKey,
  message: { error: `Too many requests from this address. Call ${require("../shared/brand.json").phone} and we'll take it by phone.` },
});
app.post("/api/rfq", rfqCreateLimiter);
// An attachment is written to disk before the route sees it: hold the storage ceiling and the
// client's daily upload budget first (the RFQ form sends at most one 25 MB file).
app.post("/api/rfq", require("./security/uploadGuards").admit({ chargeDeclared: true, maxRequestBytes: () => 26 * 1024 * 1024 }));
// The site-wide hourly allowance for requests from senders who cannot be verified: when it is used
// up, such a request is refused here, before its attachment is read (the route checks again once it
// knows who the sender is). Requests that carry a robot-check answer or a session go on to the route.
app.post("/api/rfq", require("./security/rfqGate").beforeBody);
const rfqRoutes = require("./routes/rfq");
app.use("/api/rfq", rfqRoutes);

// PDF routes (job travelers, packing lists)
const pdfRoutes = require("./routes/pdf");
app.use("/api/pdf", pdfRoutes);

require("./ops").mountRoutes(app); // admin System status, digest and full backup

// Unknown API paths answer in JSON like the rest of the API (not Express's HTML page).
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// In production, serve the built client
if (process.env.NODE_ENV === "production") {
  // Per-route static HTML, canonical-host and legacy redirects, real 404s and
  // asset caching all live in server/seo.js.
  app.use(require("./seo").createSeoRouter(path.join(__dirname, "..", "client", "dist")));
}

// ─── Error Handler ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status || 500;

  // Log with request context (no stack traces in production responses)
  // The URL is logged without its query string and with tokens removed: a firm-quote link is a credential.
  console.error(`[${new Date().toISOString()}] ${req.method} ${require("./security/redact").redactUrl(req.originalUrl)} → ${status}`);
  if (status === 500) console.error(err.stack);

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large. Maximum size is ${Math.round(require("./security/limits").limits.uploadMaxFileBytes / 1048576)} MB.` });
  }
  // Other upload refusals (multer): too many files, a field we don't read.
  if (err.name === "MulterError") {
    return res.status(400).json({ error: err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? `Upload up to ${require("./security/limits").limits.uploadMaxFiles} part files at a time.` : "That upload couldn't be read. Try again." });
  }
  // A body express could not parse, or one that is too big.
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "The request body isn't valid JSON." });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "The request is too large." });
  // Errors written for the customer (an unsupported file type, say) are safe to show.
  if (err.expose === true && status < 500 && err.message) return res.status(status).json({ error: err.message });

  // CORS errors
  if (err.message && err.message.startsWith("CORS:")) {
    return res.status(403).json({ error: "Not allowed" });
  }

  // Never leak error messages in production
  res.status(status).json({
    error: process.env.NODE_ENV === "production" ? (status < 500 ? "The request could not be processed." : "Internal server error") : err.message,
  });
});

// ─── Start Server (wait for SQLite to be ready) ─────────────────
async function start() {
  console.log("Initializing database...");
  await dbReady;
  seedDatabase();
  if (require("./models").USE_SQLITE) console.log(`  Database file: ${(require("./models/database").fileSize() / 1e6).toFixed(1)} MB`);
  apiRoutes.loadPricingRules();

  // Periodically purge old uploaded customer files (proprietary CAD shouldn't
  // linger). Window via UPLOAD_RETENTION_HOURS (default 7 days).
  // Files behind an order or an open firm-quote request are kept whatever their age.
  const { startRetentionSweep, neededUploads } = require("./services/fileRetention");
  const uploadGuards = require("./security/uploadGuards");
  startRetentionSweep(path.join(uploadGuards.DATA_DIR, "uploads"), { keep: () => neededUploads(require("./models")) });
  // Drawings (instant-quote PDFs, RFQ attachments) no quote, order or request refers to any more.
  require("./services/fileRetention").startDrawingSweep(uploadGuards.DRAWING_DIRS, require("./models"), { onSwept: () => uploadGuards.storage.invalidate() });
  // Part payload files (preview meshes, large geometry detail): each goes when its part row goes;
  // this removes whatever is left without a row (a crash between the two, a file from a failed store).
  require("./services/fileRetention").startPayloadSweep(require("./models").partsDB);
  uploadGuards.storage.hasRoom(0); // logs now if the upload folders are already near or over their ceiling

  // The rows that go with those files: abandoned uploads and lapsed draft
  // quotes leave the database too, so the file (rewritten on every save) stays
  // small. Runs at startup and every six hours.
  const { sweepRows } = require("./services/rowRetention");
  const sweepDatabase = () => {
    try {
      const r = sweepRows(require("./models"));
      if (r.quotes || r.parts) console.log(`Row retention: removed ${r.parts} abandoned part(s) with their payload files and ${r.quotes} lapsed draft quote(s); database ${(r.bytesBefore / 1e6).toFixed(1)} MB → ${(r.bytesAfter / 1e6).toFixed(1)} MB`);
      if (r.parts) uploadGuards.storage.invalidate();
    } catch (err) {
      console.error("Row retention sweep error:", err.message);
    }
  };
  if (require("./models").USE_SQLITE) {
    sweepDatabase();
    const rowTimer = setInterval(sweepDatabase, 6 * 60 * 60 * 1000);
    if (rowTimer.unref) rowTimer.unref();
  }
  // Do the keys we were given open the encrypted files that are already here? With a key set, a part's
  // measurements live in encrypted files, so a changed key with the old one not listed means existing
  // parts cannot be priced or reopened until it is. Say so where it will be seen.
  {
    const check = require("./services/fileCrypto").checkKeysAgainst(uploadGuards.STORAGE_DIRS);
    if (check.locked > 0) {
      console.error("════════════════════════════════════════════════════════════════════");
      console.error(`ERROR: EXISTING FILES CANNOT BE OPENED — ${check.locked} of the ${check.checked} encrypted files on the volume were written under a different key than NORD_FILE_ENC_KEY${process.env.NORD_FILE_ENC_KEY ? "" : " (which is not set)"}.`);
      console.error("  Until this is fixed: parts uploaded before the key changed cannot be priced, reopened or downloaded");
      console.error("  (customers are asked to upload again). New uploads are not affected. Nothing has been deleted.");
      console.error("  Fix: put the earlier key in NORD_FILE_ENC_KEY_PREVIOUS (Railway → Variables) and redeploy.");
      console.error("  See docs/security/file-encryption.md, \"Changing the key\".");
      console.error("════════════════════════════════════════════════════════════════════");
    }
  }
  // What gives way by itself when the database or the file folders fill up, the attachments of
  // closed requests, and uploads left behind by an interrupted parse (services/storagePressure.js).
  require("./services/storagePressure").start(require("./models"));
  {
    const { limits } = require("./security/limits");
    console.log(`  Memory budget: ${limits.memoryBudgetMb} MB (MEMORY_BUDGET_MB) — parse workers ${limits.parseMaxHeapMb} MB heap each, ${limits.parseRssLimitMb} MB for parsing in all; database ceiling ${Math.round(limits.databaseMaxBytes / 1048576)} MB. Set MEMORY_BUDGET_MB to the service's memory limit in Railway.`);
    // A database that was already large before this ceiling existed would have its first visitors
    // refused ("we can't save new quotes right now"). Say so at start-up, where the owner is looking.
    try {
      const used = require("./security/uploadGuards").database.size();
      const max = limits.databaseMaxBytes;
      if (used >= max * 0.5) {
        const mb = (n) => (n / 1048576).toFixed(1);
        console.warn(`  WARNING: the database is already ${mb(used)} MB of its ${mb(max)} MB ceiling (DB_MAX_MB). At ${Math.round(limits.dbSweepFraction * 100)} % unsaved quotes start to be cleared, and at 100 % new quotes and uploads are refused. Set DB_MAX_MB to about four times the database's size (at least 64) and redeploy.`);
      }
    } catch { /* the size is only for this message */ }
  }

  // Unpaid orders whose checkout session has lapsed are closed out as expired (and one that was
  // paid without our hearing of it is settled). At startup and every ten minutes.
  require("./services/orderLifecycle").startSweep();

  // Say at startup what is switched off, so a missing setting is found in the
  // deploy log and not by a customer.
  if (process.env.NODE_ENV === "production") {
    const mailer = require("./services/mailer");
    require("./security").startupWarnings(); // bot check and email verification: what is off, by name
    for (const line of require("./security/testHooks").startupWarnings()) console.warn(line);
    if (!mailer.configured()) {
      console.warn("WARNING: EMAIL_API_KEY / EMAIL_FROM not set — no email is sent: RFQ notices, firm quotes, order confirmations and shipping notices are only logged.");
      console.warn("WARNING: THE SHOP WILL RECEIVE NO ORDER EMAILS. New paid orders, purchase-order orders, payments that need attention, refunds and disputes will appear only in admin until EMAIL_API_KEY and EMAIL_FROM are set.");
    }
    // STRIPE_WEBHOOK_SECRET is required in production (REQUIRED_ENV_PROD above: the server does not start without it).
    if (!/^whsec_/.test(String(process.env.STRIPE_WEBHOOK_SECRET || ""))) console.warn("WARNING: STRIPE_WEBHOOK_SECRET does not look like a Stripe signing secret (those start with whsec_). If it is not the secret of this site's webhook endpoint, every Stripe event will be refused and orders will not be marked paid.");
    {
      const pay = require("./services/orderLifecycle").paymentSettings();
      console.log(`Payments: card checkout sessions stay open ${pay.sessionMinutes} minutes; promotion codes at checkout are ${pay.promotionCodes ? "ON (STRIPE_PROMOTION_CODES)" : "off"}.`);
    }
    if (!process.env.ADMIN_EMAIL) console.warn("WARNING: ADMIN_EMAIL not set — the admin account cannot be set up (ADMIN_EMAIL names its address; ADMIN_SETUP_CODE opens the one-time setup).");
    if (!process.env.FRONTEND_URL) console.warn("WARNING: FRONTEND_URL not set — links in emails use the request's host only when it is one of ours, otherwise the brand URL. Set FRONTEND_URL=https://straightedgemfg.com.");
    if (!process.env.NORD_FILE_ENC_KEY) {
      console.warn("WARNING: NORD_FILE_ENC_KEY not set — customer files are stored UNENCRYPTED on the volume: CAD uploads (data/uploads), drawings attached to instant quotes (data/quote-drawings), RFQ attachments (data/rfq-drawings) and each part's preview mesh and geometry detail (data/part-payloads). Anyone with access to the volume or a volume backup can read them. To turn encryption on, follow docs/security/file-encryption.md (the owner creates the key in Railway).");
    } else {
      console.log("File encryption: on — new CAD uploads, quote drawings, RFQ attachments and part preview meshes are stored encrypted (AES-256-GCM).");
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`\n  ┌─────────────────────────────────────────┐`);
    console.log(`  │  Straightedge quote API on port ${PORT}     │`);
    console.log(`  │  Environment: ${(process.env.NODE_ENV || "development").padEnd(24)}│`);
    console.log(`  │  http://localhost:${PORT}/api               │`);
    console.log(`  └─────────────────────────────────────────┘\n`);
  });
  require("./ops").started(server); // clean stop on SIGTERM, startup alert, five-minute checks, daily digest
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
