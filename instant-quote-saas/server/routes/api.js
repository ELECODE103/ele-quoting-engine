const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { parseFile } = require("../parsers/fileParser");
const { PricingEngine } = require("../services/pricingEngine");
const { JsonDB } = require("../models/db");

const router = express.Router();

// ─── FILE UPLOAD CONFIG ──────────────────────────────────────
const uploadDir = path.join(__dirname, "..", "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = [".step", ".stp", ".stl", ".3mf", ".iges", ".igs", ".dxf", ".svg"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}`));
    }
  },
});

// DB instances
const materialsDB = new JsonDB("materials");
const finishesDB = new JsonDB("finishes");
const leadTimesDB = new JsonDB("lead_times");
const pricingDB = new JsonDB("pricing_rules");
const quotesDB = new JsonDB("quotes");
const partsDB = new JsonDB("parts");

const pricingEngine = new PricingEngine();

// ═══════════════════════════════════════════════════════════════
// FILE UPLOAD & PARSING
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/upload
 * Upload one or more CAD files, parse geometry, return analysis.
 */
router.post("/upload", upload.array("files", 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const results = [];
    const errors = [];

    for (const file of req.files) {
      try {
        const parsed = await parseFile(file.path);

        // Store part in DB
        const part = partsDB.insert({
          fileName: file.originalname,
          storedName: file.filename,
          filePath: file.path,
          fileSize: file.size,
          geometry: parsed.geometry,
          dfm: parsed.dfm,
        });

        results.push({
          partId: part.id,
          fileName: file.originalname,
          geometry: {
            boundingBox: parsed.geometry.boundingBox,
            surfaceArea: parsed.geometry.surfaceArea,
            volume: parsed.geometry.volume,
            triangleCount: parsed.geometry.triangleCount,
            estimatedThickness: parsed.geometry.estimatedThickness,
            flatWidth: parsed.geometry.flatWidth,
            flatHeight: parsed.geometry.flatHeight,
            flatArea: parsed.geometry.flatArea,
            estimatedPerimeter: parsed.geometry.estimatedPerimeter,
            estimatedHoles: parsed.geometry.estimatedHoles,
            estimatedBends: parsed.geometry.estimatedBends,
            estimatedSlots: parsed.geometry.estimatedSlots,
            units: parsed.geometry.units,
          },
          dfm: parsed.dfm,
          meshPreview: {
            positions: parsed.geometry.meshData?.positions?.slice(0, 30000) || [],
            triangleCount: parsed.geometry.meshData?.triangleCount || 0,
          },
        });
      } catch (err) {
        errors.push({
          fileName: file.originalname,
          error: err.message,
        });
      }
    }

    res.json({ parts: results, errors });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed: " + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// INSTANT QUOTE
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/quote
 * Calculate instant quote for configured parts.
 *
 * Body: {
 *   parts: [{ partId, materialSlug, grade, thicknessMm, finishSlug, quantity }],
 *   leadTimeSlug: "standard" | "expedited" | "rush" | "same-day"
 * }
 */
router.post("/quote", (req, res) => {
  try {
    const { parts: partConfigs, leadTimeSlug = "standard" } = req.body;

    if (!partConfigs || !Array.isArray(partConfigs) || partConfigs.length === 0) {
      return res.status(400).json({ error: "No parts configured" });
    }

    const leadTime = leadTimesDB.getAll().find((lt) => lt.slug === leadTimeSlug);
    if (!leadTime) {
      return res.status(400).json({ error: "Invalid lead time" });
    }

    // Build pricing input
    const pricingParts = [];
    for (const config of partConfigs) {
      const part = partsDB.getById(config.partId);
      if (!part) {
        return res.status(400).json({ error: `Part not found: ${config.partId}` });
      }

      const material = materialsDB.getAll().find((m) => m.slug === config.materialSlug);
      if (!material) {
        return res.status(400).json({ error: `Material not found: ${config.materialSlug}` });
      }

      const finish = finishesDB.getAll().find((f) => f.slug === (config.finishSlug || "raw"));

      pricingParts.push({
        partId: config.partId,
        fileName: part.fileName,
        geometry: part.geometry,
        material,
        grade: config.grade || material.grades[0].name,
        thicknessMm: config.thicknessMm || material.thicknesses[2]?.mm || material.thicknesses[0].mm,
        finish,
        quantity: config.quantity || 1,
      });
    }

    const quote = pricingEngine.calculateOrderQuote({
      parts: pricingParts,
      leadTimeMultiplier: leadTime.multiplier,
    });

    // Store quote
    const savedQuote = quotesDB.insert({
      ...quote,
      leadTimeSlug,
      status: "draft",
    });

    res.json({ quoteId: savedQuote.id, ...quote });
  } catch (err) {
    console.error("Quote error:", err);
    res.status(500).json({ error: "Quote calculation failed: " + err.message });
  }
});

/**
 * GET /api/quote/:id
 */
router.get("/quote/:id", (req, res) => {
  const quote = quotesDB.getById(req.params.id);
  if (!quote) return res.status(404).json({ error: "Quote not found" });
  res.json(quote);
});

// ═══════════════════════════════════════════════════════════════
// MATERIALS & CONFIG (public)
// ═══════════════════════════════════════════════════════════════

router.get("/materials", (req, res) => {
  res.json(materialsDB.getAll().filter((m) => m.active));
});

router.get("/finishes", (req, res) => {
  res.json(finishesDB.getAll().filter((f) => f.active));
});

router.get("/lead-times", (req, res) => {
  res.json(leadTimesDB.getAll().filter((lt) => lt.active));
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Materials CRUD
// ═══════════════════════════════════════════════════════════════

router.get("/admin/materials", (req, res) => {
  res.json(materialsDB.getAll());
});

router.put("/admin/materials/:id", (req, res) => {
  const updated = materialsDB.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Material not found" });
  res.json(updated);
});

router.post("/admin/materials", (req, res) => {
  const material = materialsDB.insert(req.body);
  res.status(201).json(material);
});

router.delete("/admin/materials/:id", (req, res) => {
  const deleted = materialsDB.delete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Material not found" });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Finishes CRUD
// ═══════════════════════════════════════════════════════════════

router.get("/admin/finishes", (req, res) => {
  res.json(finishesDB.getAll());
});

router.put("/admin/finishes/:id", (req, res) => {
  const updated = finishesDB.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Finish not found" });
  res.json(updated);
});

router.post("/admin/finishes", (req, res) => {
  const finish = finishesDB.insert(req.body);
  res.status(201).json(finish);
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Pricing Rules
// ═══════════════════════════════════════════════════════════════

router.get("/admin/pricing", (req, res) => {
  const rules = pricingDB.getAll();
  res.json(rules[0] || {});
});

router.put("/admin/pricing", (req, res) => {
  const rules = pricingDB.getAll();
  if (rules.length > 0) {
    const updated = pricingDB.update(rules[0].id, req.body);
    // Update engine
    Object.assign(pricingEngine.rules, req.body);
    res.json(updated);
  } else {
    const created = pricingDB.insert(req.body);
    res.json(created);
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Lead Times
// ═══════════════════════════════════════════════════════════════

router.get("/admin/lead-times", (req, res) => {
  res.json(leadTimesDB.getAll());
});

router.put("/admin/lead-times/:id", (req, res) => {
  const updated = leadTimesDB.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Lead time not found" });
  res.json(updated);
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Quotes / Orders
// ═══════════════════════════════════════════════════════════════

router.get("/admin/quotes", (req, res) => {
  const quotes = quotesDB.getAll().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(quotes);
});

router.get("/admin/stats", (req, res) => {
  const quotes = quotesDB.getAll();
  const parts = partsDB.getAll();
  const totalRevenue = quotes.reduce((sum, q) => sum + (q.orderTotal || 0), 0);
  const avgOrderValue = quotes.length > 0 ? totalRevenue / quotes.length : 0;

  res.json({
    totalQuotes: quotes.length,
    totalParts: parts.length,
    totalRevenue,
    avgOrderValue,
    quotesToday: quotes.filter((q) => {
      const d = new Date(q.createdAt);
      const today = new Date();
      return d.toDateString() === today.toDateString();
    }).length,
  });
});

module.exports = router;
