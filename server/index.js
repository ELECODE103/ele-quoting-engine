const express = require("express");
const cors = require("cors");
const path = require("path");
const { seedDatabase } = require("./config/seed");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// API routes
const apiRoutes = require("./routes/api");
app.use("/api", apiRoutes);

// Serve uploaded file thumbnails (mesh data)
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

// In production, serve the built client
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "..", "client", "dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "client", "dist", "index.html"));
  });
}

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Maximum size is 100MB." });
  }
  res.status(500).json({ error: err.message || "Internal server error" });
});

// Seed database and start
console.log("Initializing database...");
seedDatabase();

app.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────────┐`);
  console.log(`  │  Instant Quote API running on port ${PORT}  │`);
  console.log(`  │  http://localhost:${PORT}/api               │`);
  console.log(`  └─────────────────────────────────────────┘\n`);
});
