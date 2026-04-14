require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { ready: dbReady } = require("./models/database");
const { seedDatabase } = require("./config/seed");

// âââ Environment Variable Validation ââââââââââââââââââââââââââââ
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

// âââ Trust proxy (required behind Railway/load balancer) âââââââââ
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// âââ Security Middleware ââââââââââââââââââââââââââââââââââââââââ
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

// Rate limiting â generous for normal use, blocks abuse
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

// CORS â allow dev and production origins
const allowedOrigins = [
  "http://localhost:3001",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("CORS: Origin not allowed"));
        }
      }
    : true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400, // Cache preflight for 24 hours
}));

// âââ Stripe Webhook (raw body â must be before express.json) ââââ
const stripeWebhook = require("./routes/stripeWebhook");
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// âââ Health Check (no version exposure) ââââââââââââââââââââââââââ
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// âââ API Routes âââââââââââââââââââââââââââââââââââââââââââââââââ
const apiRoutes = require("./routes/api");
app.use("/api", apiRoutes);

// Auth routes
const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes);

// Order routes
const orderRoutes = require("./routes/orders");
app.use("/api/orders", orderRoutes);

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

// âââ Error Handler ââââââââââââââââââââââââââââââââââââââââââââââ
app.use((err, req, res, next) => {
  const status = err.status || 500;

  // Log with request context (no stack traces in production responses)
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} â ${status}`);
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

// âââ Start Server (wait for SQLite to be ready) âââââââââââââââââ
async function start() {
  console.log("Initializing database...");
  await dbReady;
  seedDatabase();

  app.listen(PORT, () => {
    console.log(`\n  âââââââââââââââââââââââââââââââââââââââââââ`);
    console.log(`  â  Instant Quote API running on port ${PORT}  â`);
    console.log(`  â  Environment: ${(process.env.NODE_ENV || "development").padEnd(24)}â`);
    console.log(`  â  http://localhost:${PORT}/api               â`);
    console.log(`  âââââââââââââââââââââââââââââââââââââââââââ\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
