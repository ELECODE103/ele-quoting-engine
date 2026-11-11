require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { ready: dbReady } = require("./models/database");
const { seedDatabase } = require("./config/seed");

// ─── Environment Variable Validation ────────────────────────────
const REQUIRED_ENV_PROD = ["JWT_SECRET", "STRIPE_SECRET_KEY"];
if (process.env.NODE_ENV === "production") {
  const missing = REQUIRED_ENV_PROD.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Trust proxy (required behind Railway/load balancer) ─────────
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ─── Security Middleware ────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: [
        "'self'",
        "https://api.stripe.com",
        "https://checkout.stripe.com",
        "https://*.stripe.com",
      ],
      frameSrc: [
        "'self'",
        "https://checkout.stripe.com",
        "https://js.stripe.com",
        "https://*.stripe.com",
      ],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", "https://checkout.stripe.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
  // Strict transport security
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// Rate limiting — generous for normal use, blocks abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 200,                     // per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api", apiLimiter);

// Stricter limit on file uploads
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: "Upload limit reached. Please try again later." },
});
app.use("/api/upload", uploadLimiter);

// CORS — allow dev and production origins
const allowedOrigins = [
  "http://localhost:3001",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

// Same-origin requests (module scripts send an Origin header) are always fine,
// whatever FRONTEND_URL says — otherwise a domain change takes the whole site
// down until the env var catches up. Unknown cross-origin callers simply get
// no CORS headers (the browser blocks them) instead of a 403 for everyone.
app.use((req, res, next) => cors({
  origin: process.env.NODE_ENV === "production"
    ? (origin, callback) => {
        if (!origin) return callback(null, true);            // curl, server-to-server
        try { if (new URL(origin).host === req.get("host")) return callback(null, true); } catch { /* fall through */ }
        callback(null, allowedOrigins.includes(origin));
      }
    : true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400, // Cache preflight for 24 hours
})(req, res, next));

// ─── Compression (text assets and HTML; Railway's edge does not gzip for us) ──
app.use(require("compression")());

// ─── Stripe Webhook (raw body — must be before express.json) ────
const stripeWebhook = require("./routes/stripeWebhook");
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

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
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: `Too many requests from this address. Call ${require("../shared/brand.json").phone} and we'll take it by phone.` },
});
app.post("/api/rfq", rfqCreateLimiter);
const rfqRoutes = require("./routes/rfq");
app.use("/api/rfq", rfqRoutes);

// PDF routes (job travelers, packing lists)
const pdfRoutes = require("./routes/pdf");
app.use("/api/pdf", pdfRoutes);

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
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${status}`);
  if (status === 500) console.error(err.stack);

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 100MB." });
  }
  // Other upload refusals (multer): too many files, a field we don't read.
  if (err.name === "MulterError") {
    return res.status(400).json({ error: err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? "Upload up to 20 part files at a time." : "That upload couldn't be read. Try again." });
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
  startRetentionSweep(path.join(__dirname, "..", "data", "uploads"), { keep: () => neededUploads(require("./models")) });

  // The rows that go with those files: abandoned uploads and lapsed draft
  // quotes leave the database too, so the file (rewritten on every save) stays
  // small. Runs at startup and every six hours.
  const { sweepRows } = require("./services/rowRetention");
  const sweepDatabase = () => {
    try {
      const r = sweepRows(require("./models"));
      if (r.quotes || r.parts) console.log(`Row retention: removed ${r.parts} abandoned part(s) and ${r.quotes} lapsed draft quote(s); database ${(r.bytesBefore / 1e6).toFixed(1)} MB → ${(r.bytesAfter / 1e6).toFixed(1)} MB`);
    } catch (err) {
      console.error("Row retention sweep error:", err.message);
    }
  };
  if (require("./models").USE_SQLITE) {
    sweepDatabase();
    const rowTimer = setInterval(sweepDatabase, 6 * 60 * 60 * 1000);
    if (rowTimer.unref) rowTimer.unref();
  }

  // Say at startup what is switched off, so a missing setting is found in the
  // deploy log and not by a customer.
  if (process.env.NODE_ENV === "production") {
    const mailer = require("./services/mailer");
    require("./security").startupWarnings(); // bot check and email verification: what is off, by name
    if (!mailer.configured()) console.warn("WARNING: EMAIL_API_KEY / EMAIL_FROM not set — no email is sent: RFQ notices, firm quotes, order confirmations and shipping notices are only logged.");
    if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn("WARNING: STRIPE_WEBHOOK_SECRET not set — Stripe webhooks are refused; orders are marked paid only when the buyer returns to the order page.");
    if (!process.env.ADMIN_EMAIL) console.warn("WARNING: ADMIN_EMAIL not set — no account will be given the admin role.");
    if (!process.env.FRONTEND_URL) console.warn("WARNING: FRONTEND_URL not set — links in emails are built from the request's Host header.");
    if (!process.env.NORD_FILE_ENC_KEY) console.warn("WARNING: NORD_FILE_ENC_KEY not set — uploaded CAD files are stored unencrypted.");
  }

  app.listen(PORT, () => {
    console.log(`\n  ┌─────────────────────────────────────────┐`);
    console.log(`  │  Straightedge quote API on port ${PORT}     │`);
    console.log(`  │  Environment: ${(process.env.NODE_ENV || "development").padEnd(24)}│`);
    console.log(`  │  http://localhost:${PORT}/api               │`);
    console.log(`  └─────────────────────────────────────────┘\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
