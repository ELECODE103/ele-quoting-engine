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
const apiRoutes = require("./routes/api");
app.use("/api", apiRoutes);

// Auth routes
const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes);

// Order routes
const orderRoutes = require("./routes/orders");
app.use("/api/orders", orderRoutes);

// RFQ routes (firm-quote requests for production quantities / flagged parts)
const rfqRoutes = require("./routes/rfq");
app.use("/api/rfq", rfqRoutes);

// PDF routes (job travelers, packing lists)
const pdfRoutes = require("./routes/pdf");
app.use("/api/pdf", pdfRoutes);

// In production, serve the built client
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "..", "client", "dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "client", "dist", "index.html"));
  });
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

  // CORS errors
  if (err.message && err.message.startsWith("CORS:")) {
    return res.status(403).json({ error: "Not allowed" });
  }

  // Never leak error messages in production
  res.status(status).json({
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});

// ─── Start Server (wait for SQLite to be ready) ─────────────────
async function start() {
  console.log("Initializing database...");
  await dbReady;
  seedDatabase();
  apiRoutes.loadPricingRules();

  // Periodically purge old uploaded customer files (proprietary CAD shouldn't
  // linger). Window via UPLOAD_RETENTION_HOURS (default 7 days).
  const { startRetentionSweep } = require("./services/fileRetention");
  startRetentionSweep(path.join(__dirname, "..", "data", "uploads"));

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
