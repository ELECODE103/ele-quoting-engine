const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { parseFile } = require("../parsers/fileParser");
const { PricingEngine } = require("../services/pricingEngine");
const { materialsDB, finishesDB, leadTimesDB, pricingDB, quotesDB, partsDB } = require("../models");
const { MANUFACTURING_PROCESSES } = require("../config/defaults");
const { authenticate, requireAdmin } = require("./auth");
const { sanitizeString, isValidSlug } = require("../middleware/validate");

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
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB  fileFilter: (req, file, cb) => {
    const allowed = [".step", ".stp", ".stl", ".3mf", ".iges", ".igs"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}`));
    }
  },
});

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
            estimatedHoles: parsed.geometry.estimatedHoles,            estimatedBends: parsed.geometry.estimatedBends,
            estimatedSlots: parsed.geometry.estimatedSlots,
            units: parsed.geometry.units,
          },
          dfm: parsed.dfm,
          dfmAll: parsed.dfmAll,
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
    res.status(500).json({ error: "Upload failed. Please try again." });
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
 *   parts: [{ partId, materialSlug, grade, thicknessMm, finishSlug, quantity, process, subProcess, layerHeight, infill }],
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

      const defaultFinishSlug = config.process === 'cnc' ? 'cnc-as-machined' : config.process === '3d-printing' ? '3dp-as-printed' : 'raw';
      const finish = finishesDB.getAll().find((f) => f.slug === (config.finishSlug || defaultFinishSlug)) || null;

      pricingParts.push({
        partId: config.partId,
        fileName: part.fileName,
        geometry: part.geometry,
        material,
        grade: config.grade || material.grades?.[0]?.name || '',
        thicknessMm: config.thicknessMm || material.thicknesses?.[2]?.mm || material.thicknesses?.[0]?.mm || 0,
        finish,
        quantity: config.quantity || 1,
        process: config.process || 'sheetmetal',
        subProcess: config.subProcess || '',
        layerHeight: config.layerHeight || 0,
        infill: config.infill || 0,
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
    res.status(500).json({ error: "Quote calculation failed. Please try again." });
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

router.get("/processes", (req, res) => {
  res.json(MANUFACTURING_PROCESSES.filter(p => p.active));
});
router.get("/materials", (req, res) => {
  let mats = materialsDB.getAll().filter((m) => m.active);
  if (req.query.process) {
    // Materials without a process field are legacy sheet metal
    mats = mats.filter((m) => (m.process || 'sheetmetal') === req.query.process);
  }
  if (req.query.subProcess) {
    mats = mats.filter((m) => m.subProcess === req.query.subProcess);
  }
  res.json(mats);
});

router.get("/finishes", (req, res) => {
  let fins = finishesDB.getAll().filter((f) => f.active);
  if (req.query.process) {
    // Finishes without a process field are legacy sheet metal
    fins = fins.filter((f) => (f.process || 'sheetmetal') === req.query.process);
  }
  res.json(fins);
});

router.get("/lead-times", (req, res) => {
  res.json(leadTimesDB.getAll().filter((lt) => lt.active));
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Materials CRUD
// ═══════════════════════════════════════════════════════════════
router.get("/admin/materials", authenticate, requireAdmin, (req, res) => {
  res.json(materialsDB.getAll());
});

router.put("/admin/materials/:id", authenticate, requireAdmin, (req, res) => {
  const updated = materialsDB.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Material not found" });
  res.json(updated);
});

router.post("/admin/materials", authenticate, requireAdmin, (req, res) => {
  const material = materialsDB.insert(req.body);
  res.status(201).json(material);
});

router.delete("/admin/materials/:id", authenticate, requireAdmin, (req, res) => {
  const deleted = materialsDB.delete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Material not found" });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Finishes CRUD
// ═══════════════════════════════════════════════════════════════

router.get("/admin/finishes", authenticate, requireAdmin, (req, res) => {
  res.json(finishesDB.getAll());
});
router.put("/admin/finishes/:id", authenticate, requireAdmin, (req, res) => {
  const updated = finishesDB.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Finish not found" });
  res.json(updated);
});

router.post("/admin/finishes", authenticate, requireAdmin, (req, res) => {
  const finish = finishesDB.insert(req.body);
  res.status(201).json(finish);
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Pricing Rules
// ═══════════════════════════════════════════════════════════════

router.get("/admin/pricing", authenticate, requireAdmin, (req, res) => {
  const rules = pricingDB.getAll();
  res.json(rules[0] || {});
});

router.put("/admin/pricing", authenticate, requireAdmin, (req, res) => {
  const rules = pricingDB.getAll();
  if (rules.length > 0) {
    const updated = pricingDB.update(rules[0].id, req.body);
    // Update engine
    Object.assign(pricingEngine.rules, req.body);
    res.json(updated);
  } else {    const created = pricingDB.insert(req.body);
    res.json(created);
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Lead Times
// ═══════════════════════════════════════════════════════════════

router.get("/admin/lead-times", authenticate, requireAdmin, (req, res) => {
  res.json(leadTimesDB.getAll());
});

router.put("/admin/lead-times/:id", authenticate, requireAdmin, (req, res) => {
  const updated = leadTimesDB.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Lead time not found" });
  res.json(updated);
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Quotes / Orders
// ═══════════════════════════════════════════════════════════════

router.get("/admin/quotes", authenticate, requireAdmin, (req, res) => {
  const quotes = quotesDB.getAll().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(quotes);
});

router.get("/admin/stats", authenticate, requireAdmin, (req, res) => {  const quotes = quotesDB.getAll();
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