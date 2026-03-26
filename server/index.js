require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { ready: dbReady } = require("./models/database");
const { seedDatabase } = require("./config/seed");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,   // let the React app load scripts
  crossOriginEmbedderPolicy: false,
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

app.use(cors({
  origin: process.env.NODE_ENV === "production" ? allowedOrigins : true,
  credentials: true,
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ─── Health Check ───────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: require("../package.json").version,
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

// PDF routes (job travelers, packing lists)
const pdfRoutes = require("./routes/pdf");
app.use("/api/pdf", pdfRoutes);

// Serve uploaded file thumbnails
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

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
  const message = err.message || "Internal server error";

  // Log with request context
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${status}: ${message}`);
  if (status === 500) console.error(err.stack);

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 100MB." });
  }

  res.status(status).json({
    error: process.env.NODE_ENV === "production" ? "Internal server error" : message,
  });
});

// ─── Start Server (wait for SQLite to be ready) ─────────────────
async function start() {
  console.log("Initializing database...");
  await dbReady;
  seedDatabase();

  app.listen(PORT, () => {
    console.log(`\n  ┌─────────────────────────────────────────┐`);
    console.log(`  │  Instant Quote API running on port ${PORT}  │`);
    console.log(`  │  Environment: ${(process.env.NODE_ENV || "development").padEnd(24)}│`);
    console.log(`  │  http://localhost:${PORT}/api               │`);
    console.log(`  └─────────────────────────────────────────┘\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});