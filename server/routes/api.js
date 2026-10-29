const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { parseFile } = require("../parsers/fileParser");
const { PricingEngine } = require("../services/pricingEngine");
const quoteGate = require("../services/quoteGate");
const { runDFMAnalysis, defaultProcessSlug } = require("../parsers/fileParser");
const { materialsDB, finishesDB, leadTimesDB, pricingDB, quotesDB, partsDB, pricingAuditDB, ordersDB, orderItemsDB } = require("../models");
const ruleSchema = require("../config/ruleSchema");
const { createPricingAdmin } = require("../services/pricingAdmin");
const pricingPreview = require("../services/pricingPreview");
const calibration = require("../services/calibration");
const { resolveProcess, activeProcesses } = require("../processes/registry");
const { authenticate, optionalAuth, requireAdmin } = require("./auth");
const { sanitizeString, isValidSlug, nonNegativeNumber, positiveInt } = require("../middleware/validate");
const { validateFileContent } = require("../middleware/fileValidator");
const fileCrypto = require("../services/fileCrypto");

const router = express.Router();

// ─── FILE UPLOAD CONFIG ──────────────────────────────────────
const uploadDir = path.join(__dirname, "..", "..", "data", "uploads");
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
const pricingAdmin = createPricingAdmin({ pricingDB, auditDB: pricingAuditDB });

/**
 * Load the stored pricing rules (admin-tuned) into the engine. Called once at
 * startup after the DB is seeded, and after every admin save. The effective
 * set is schema defaults ← legacy DEFAULT_PRICING_RULES ← the stored blob.
 */
function loadPricingRules() {
  // Schema defaults with the stored (admin-tuned) values laid over them, each
  // one validated and clamped — a database from an older version always
  // yields a complete, sane rule set.
  pricingEngine.rules = pricingAdmin.currentRules();
  return pricingEngine.rules;
}

// ─── Admin field whitelists (prevent mass assignment) ────────
// Every material field the pricing models read (pricePerKg / pricePerCm3,
// machinability, materialClass, stockForms, wasteFactor, feedClass,
// grades[].density, thicknesses, density, layer heights) plus the catalog
// fields (name, category, color, active, description).
const MATERIAL_FIELDS = ["name", "slug", "process", "subProcess", "category", "density", "costPerKg", "pricePerKg", "pricePerCm3", "machinability", "materialClass", "stockForms", "wasteFactor", "feedClass", "costPerSheet", "grades", "thicknesses", "layerHeights", "defaultLayerHeight", "active", "description", "color"];
const MATERIAL_NUMBER_FIELDS = { density: [0, 30], costPerKg: [0, 10000], pricePerKg: [0, 10000], pricePerCm3: [0, 100], machinability: [0.05, 10], costPerSheet: [0, 100000], defaultLayerHeight: [0.01, 2], wasteFactor: [0, 2] };
const FEED_CLASSES = ruleSchema.FEED_CLASSES;
const FINISH_FIELDS = ["name", "slug", "process", "costPerSqMm", "costFlat", "minCost", "active", "description", "category"];
// Pricing rules are whitelisted and range-checked by the rule schema (config/ruleSchema.js) in services/pricingAdmin.js.
const LEAD_TIME_FIELDS = ["name", "slug", "days", "multiplier", "active", "description"];

/** Pick only allowed fields from an object */
function whitelist(body, allowedFields) {
  const cleaned = {};
  for (const key of allowedFields) {
    if (body[key] !== undefined) {
      cleaned[key] = body[key];
    }
  }
  return cleaned;
}

// ═══════════════════════════════════════════════════════════════
// FILE UPLOAD & PARSING
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/upload
 * Upload one or more CAD files, parse geometry, return analysis.
 * Requires authentication. Files validated for magic bytes.
 */
router.post("/upload", upload.array("files", 20), validateFileContent, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const results = [];
    const errors = [];
    for (const file of req.files) {
      try {
        const parsed = await parseFile(file.path);

        // Encrypt the stored file at rest now that parsing is done (no-op unless
        // NORD_FILE_ENC_KEY is configured). Returns the path actually on disk.
        const storedPath = fileCrypto.encryptFileInPlace(file.path);
        const storedName = path.basename(storedPath);

        // Store part in DB
        const part = partsDB.insert({
          fileName: file.originalname,
          storedName: storedName,
          filePath: storedPath,
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
            // Recognised features (server/geometry/SCHEMA.md): holes, pockets,
            // slots, walls, access, stock, confidence. Mesh data stays in meshPreview.
            features: parsed.geometry.features || null,
          },
          dfm: parsed.dfm,
          dfmAll: parsed.dfmAll,
          meshPreview: {
            positions: parsed.geometry.meshData?.positions || [],
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
router.post("/quote", optionalAuth, (req, res) => {
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
    const dfmByPartId = {};
    for (const config of partConfigs) {
      const part = partsDB.getById(config.partId);
      if (!part) {
        return res.status(400).json({ error: `Part not found: ${config.partId}` });
      }
      const material = materialsDB.getAll().find((m) => m.slug === config.materialSlug);
      if (!material) {
        return res.status(400).json({ error: `Material not found: ${config.materialSlug}` });
      }

      const defaultFinishSlug = resolveProcess(config.process).defaultFinishSlug || 'raw';
      const finish = finishesDB.getAll().find((f) => f.slug === (config.finishSlug || defaultFinishSlug)) || null;

      const process = config.process || material.process || defaultProcessSlug();
      const thicknessMm = config.thicknessMm || material.thicknesses?.[2]?.mm || material.thicknesses?.[0]?.mm || 0;
      pricingParts.push({
        partId: config.partId,
        fileName: part.fileName,
        geometry: part.geometry,
        material,
        grade: config.grade || material.grades?.[0]?.name || '',
        thicknessMm,
        finish,
        quantity: config.quantity || 1,
        process,
        subProcess: config.subProcess || '',
        // Pass through only when actually provided — `|| 0` made an unset infill
        // look like an intentional 0% (the engine then under-costed FDM material).
        layerHeight: config.layerHeight != null ? Number(config.layerHeight) : undefined,
        infill: config.infill != null ? Number(config.infill) : undefined,
      });

      // DFM for the chosen process/material/thickness — drives the checkout-vs-RFQ gate.
      dfmByPartId[config.partId] = runDFMAnalysis(part.geometry, {
        process,
        subProcess: config.subProcess || resolveProcess(process).previewSubProcess,
        thicknessMm,
        materialType: /plastic|composite/i.test(material.category || "") ? "plastic" : "metal",
        // Material identity for material-aware thresholds (acrylic brittle, nylon moisture, PEEK cost …)
        materialSlug: material.slug,
        materialName: material.name,
      });
    }

    // Rush multiplier: the rate card's table wins when it names this lead time,
    // else the lead-time record's own multiplier.
    const rushTable = pricingEngine.rules.rushMultipliers || {};
    const leadTimeMultiplier = Number.isFinite(Number(rushTable[leadTimeSlug])) && Number(rushTable[leadTimeSlug]) >= 1
      ? Number(rushTable[leadTimeSlug]) : leadTime.multiplier;
    const quote = pricingEngine.calculateOrderQuote({
      parts: pricingParts,
      leadTimeMultiplier,
    });

    // Instant checkout or RFQ? Stored with the quote so checkout can enforce it.
    const gate = quoteGate.evaluate(quote.lineItems, dfmByPartId, pricingEngine.rules);

    // Store quote
    const savedQuote = quotesDB.insert({
      ...quote,
      gate,
      leadTimeSlug,
      status: "draft",
      // Bind the quote to the user when signed in; anonymous quotes (public
      // quoting / guest-before-login) stay unbound and remain readable by id.
      userId: req.user?.userId || null,
    });

    res.json({
      quoteId: savedQuote.id,
      ...quote,
      gate,
      dfmByPartId: Object.fromEntries(
        Object.entries(dfmByPartId).map(([id, d]) => [id, { summary: d.summary, checks: d.checks }])
      ),
    });
  } catch (err) {
    console.error("Quote error:", err);
    res.status(500).json({ error: "Quote calculation failed. Please try again." });
  }
});

/**
 * GET /api/quote/:id
 */
router.get("/quote/:id", optionalAuth, (req, res) => {
  const quote = quotesDB.getById(req.params.id);
  if (!quote) return res.status(404).json({ error: "Quote not found" });
  // If the quote is bound to a user, only that user (or an admin) may read it.
  // Anonymous quotes (no userId) remain publicly readable by id (UUID) so the
  // public quote and guest-before-login flows keep working.
  if (quote.userId && (!req.user || (req.user.userId !== quote.userId && req.user.role !== "admin"))) {
    return res.status(404).json({ error: "Quote not found" });
  }
  res.json(quote);
});

// ═══════════════════════════════════════════════════════════════
// MATERIALS & CONFIG (public)
// ═══════════════════════════════════════════════════════════════

router.get("/processes", (req, res) => {
  res.json(activeProcesses());
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
// ADMIN — Materials CRUD (whitelisted fields)
// ═══════════════════════════════════════════════════════════════
router.get("/admin/materials", authenticate, requireAdmin, (req, res) => {
  res.json(materialsDB.getAll());
});

/**
 * Validate the whitelisted material fields: numbers in range, feed class from
 * the known set, grades/thicknesses/layerHeights in the shapes pricing reads.
 * Returns { ok, error, values }.
 */
function validateMaterial(body) {
  const safe = whitelist(body, MATERIAL_FIELDS);
  for (const [k, [min, max]] of Object.entries(MATERIAL_NUMBER_FIELDS)) {
    if (safe[k] === undefined || safe[k] === null || safe[k] === "") { if (k in safe) safe[k] = null; continue; }
    const n = Number(safe[k]);
    if (!Number.isFinite(n) || n < min || n > max) return { ok: false, error: `${k} must be a number between ${min} and ${max}` };
    safe[k] = n;
  }
  for (const k of ["name", "slug", "process", "subProcess", "category", "description", "color"]) {
    if (safe[k] !== undefined && safe[k] !== null) safe[k] = sanitizeString(String(safe[k]), k === "description" ? 1000 : 120);
  }
  if (safe.slug !== undefined && safe.slug !== null && !isValidSlug(safe.slug)) return { ok: false, error: "slug may only contain lowercase letters, digits and dashes" };
  if (safe.active !== undefined) safe.active = Boolean(safe.active);
  if (safe.feedClass !== undefined && safe.feedClass !== null && safe.feedClass !== "" && !FEED_CLASSES.includes(safe.feedClass)) {
    return { ok: false, error: `feedClass must be one of ${FEED_CLASSES.join(", ")}` };
  }
  if (safe.grades !== undefined) {
    if (!Array.isArray(safe.grades)) return { ok: false, error: "grades must be a list" };
    safe.grades = safe.grades.map((g) => ({ name: sanitizeString(String(g?.name || ""), 120), density: Number(g?.density) }));
    if (safe.grades.some((g) => !g.name || !Number.isFinite(g.density) || g.density <= 0 || g.density > 1)) {
      return { ok: false, error: "every grade needs a name and a density in lb/in³ (0–1)" };
    }
  }
  if (safe.thicknesses !== undefined) {
    if (!Array.isArray(safe.thicknesses)) return { ok: false, error: "thicknesses must be a list" };
    safe.thicknesses = safe.thicknesses.map((t) => {
      const mm = Number(t?.mm);
      const inch = t?.inch !== undefined && t?.inch !== "" && t?.inch !== null ? Number(t.inch) : Number((mm / 25.4).toFixed(4));
      return { mm, inch, label: sanitizeString(String(t?.label || `${mm} mm`), 40) };
    });
    if (safe.thicknesses.some((t) => !Number.isFinite(t.mm) || t.mm <= 0 || t.mm > 300 || !Number.isFinite(t.inch))) {
      return { ok: false, error: "every thickness needs a size in mm (0–300)" };
    }
    safe.thicknesses.sort((a, b) => a.mm - b.mm);
  }
  if (safe.layerHeights !== undefined) {
    if (!Array.isArray(safe.layerHeights)) return { ok: false, error: "layerHeights must be a list" };
    safe.layerHeights = safe.layerHeights.map(Number);
    if (safe.layerHeights.some((h) => !Number.isFinite(h) || h <= 0 || h > 2)) return { ok: false, error: "layer heights must be in mm (0–2)" };
    safe.layerHeights.sort((a, b) => a - b);
  }
  return { ok: true, values: safe };
}

router.put("/admin/materials/:id", authenticate, requireAdmin, (req, res) => {
  const v = validateMaterial(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const updated = materialsDB.update(req.params.id, v.values);
  if (!updated) return res.status(404).json({ error: "Material not found" });
  res.json(updated);
});

router.post("/admin/materials", authenticate, requireAdmin, (req, res) => {
  const v = validateMaterial(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (!v.values.name || !v.values.slug) return res.status(400).json({ error: "name and slug are required" });
  const material = materialsDB.insert({ active: false, ...v.values });
  res.status(201).json(material);
});

/**
 * POST /api/admin/materials/:id/duplicate
 * Copy a material (inactive, "-copy" slug) so the owner can add a grade or a
 * price variant without typing the whole record.
 */
router.post("/admin/materials/:id/duplicate", authenticate, requireAdmin, (req, res) => {
  const src = materialsDB.getById(req.params.id);
  if (!src) return res.status(404).json({ error: "Material not found" });
  const { id, createdAt, updatedAt, ...rest } = src;
  const taken = new Set(materialsDB.getAll().map((m) => m.slug));
  let slug = `${src.slug}-copy`;
  for (let n = 2; taken.has(slug); n++) slug = `${src.slug}-copy-${n}`;
  const copy = materialsDB.insert({ ...rest, slug, name: `${src.name} (copy)`, active: false });
  res.status(201).json(copy);
});

router.delete("/admin/materials/:id", authenticate, requireAdmin, (req, res) => {
  const deleted = materialsDB.delete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Material not found" });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Finishes CRUD (whitelisted fields)
// ═══════════════════════════════════════════════════════════════

router.get("/admin/finishes", authenticate, requireAdmin, (req, res) => {
  res.json(finishesDB.getAll());
});
router.put("/admin/finishes/:id", authenticate, requireAdmin, (req, res) => {
  const safe = whitelist(req.body, FINISH_FIELDS);
  const updated = finishesDB.update(req.params.id, safe);
  if (!updated) return res.status(404).json({ error: "Finish not found" });
  res.json(updated);
});

router.post("/admin/finishes", authenticate, requireAdmin, (req, res) => {
  const safe = whitelist(req.body, FINISH_FIELDS);
  const finish = finishesDB.insert(safe);
  res.status(201).json(finish);
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Pricing console
//   schema   → the rule descriptors the console renders
//   pricing  → GET current values / PUT validated changes (+ note → audit log)
//   preview  → price 6 reference parts with candidate rules, no save
//   history / restore / reset
// ═══════════════════════════════════════════════════════════════

router.get("/admin/pricing/schema", authenticate, requireAdmin, (req, res) => {
  res.json({ groups: ruleSchema.RULE_GROUPS, rules: ruleSchema.RULE_SCHEMA });
});

router.get("/admin/pricing", authenticate, requireAdmin, (req, res) => {
  res.json(loadPricingRules());
});

/**
 * PUT /api/admin/pricing
 * Body: { rules: { key: value, … }, note: "why" }  — or the legacy flat form
 * { key: value, …, note }. Partial updates are fine; every key is validated
 * against the schema (unknown keys and out-of-range values are rejected).
 */
router.put("/admin/pricing", authenticate, requireAdmin, (req, res) => {
  const body = req.body || {};
  const { rules: wrapped, note, ...flat } = body;
  const candidate = wrapped && typeof wrapped === "object" ? wrapped : flat;
  const result = pricingAdmin.save(candidate, { note, user: req.user });
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error, errors: result.errors || [] });
  const rules = loadPricingRules();
  res.json({ rules, audit: result.audit ? { id: result.audit.id, createdAt: result.audit.createdAt } : null, unchanged: !!result.unchanged });
});

/**
 * POST /api/admin/pricing/preview
 * Body: { rules: { key: value, … } } — candidate values (partial OK) layered on
 * the saved rules. Returns prices for the reference parts under the candidate
 * and under the saved rules, so the console can show before/after.
 */
router.post("/admin/pricing/preview", authenticate, requireAdmin, (req, res) => {
  try {
    const candidate = (req.body && req.body.rules && typeof req.body.rules === "object") ? req.body.rules : (req.body || {});
    const v = ruleSchema.validateRules(candidate, { partial: true });
    if (!v.ok) return res.status(400).json({ error: v.errors[0].message, errors: v.errors });
    const saved = pricingAdmin.currentRules();
    const merged = { ...saved, ...v.values };
    const out = pricingPreview.run(merged, saved, { materials: materialsDB.getAll() });
    res.json(out);
  } catch (err) {
    console.error("Pricing preview error:", err);
    res.status(500).json({ error: "Preview failed" });
  }
});

router.get("/admin/pricing/history", authenticate, requireAdmin, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json(pricingAdmin.history({ limit }));
});

router.post("/admin/pricing/restore/:id", authenticate, requireAdmin, (req, res) => {
  const result = pricingAdmin.restore(req.params.id, { note: req.body?.note, user: req.user });
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error, errors: result.errors || [] });
  res.json({ rules: loadPricingRules(), audit: result.audit ? { id: result.audit.id, createdAt: result.audit.createdAt } : null });
});

router.post("/admin/pricing/reset", authenticate, requireAdmin, (req, res) => {
  const result = pricingAdmin.reset({ note: req.body?.note, user: req.user });
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error, errors: result.errors || [] });
  res.json({ rules: loadPricingRules(), audit: result.audit ? { id: result.audit.id, createdAt: result.audit.createdAt } : null });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Calibration (engine minutes vs. what the job actually took)
// ═══════════════════════════════════════════════════════════════

router.get("/admin/calibration", authenticate, requireAdmin, (req, res) => {
  try {
    const rows = calibration.buildRows(ordersDB.getAll(), orderItemsDB.getAll());
    const summary = calibration.summarize(rows, pricingAdmin.currentRules());
    res.json({ items: rows, summary, minSamples: calibration.MIN_SAMPLES, statuses: calibration.COMPLETED_STATUSES });
  } catch (err) {
    console.error("Calibration error:", err);
    res.status(500).json({ error: "Could not build the calibration table" });
  }
});

/**
 * PUT /api/admin/order-items/:id/actuals
 * Body: { actualMinutes: number|null, actualNotes: string }
 * Machine minutes per piece the job really took (excluding setup).
 */
router.put("/admin/order-items/:id/actuals", authenticate, requireAdmin, (req, res) => {
  const item = orderItemsDB.getById(req.params.id);
  if (!item) return res.status(404).json({ error: "Order item not found" });
  const updates = {};
  if (req.body.actualMinutes !== undefined) {
    if (req.body.actualMinutes === null || req.body.actualMinutes === "") {
      updates.actualMinutes = null;
    } else {
      const n = Number(req.body.actualMinutes);
      if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: "actualMinutes must be a number of minutes (0–100000)" });
      updates.actualMinutes = n;
    }
    updates.actualRecordedAt = new Date().toISOString();
  }
  if (req.body.actualNotes !== undefined) updates.actualNotes = sanitizeString(String(req.body.actualNotes || ""), 500);
  const updated = orderItemsDB.update(item.id, updates);
  res.json(updated);
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Lead Times (whitelisted fields)
// ═══════════════════════════════════════════════════════════════

router.get("/admin/lead-times", authenticate, requireAdmin, (req, res) => {
  res.json(leadTimesDB.getAll());
});

router.put("/admin/lead-times/:id", authenticate, requireAdmin, (req, res) => {
  const safe = whitelist(req.body, LEAD_TIME_FIELDS);
  const updated = leadTimesDB.update(req.params.id, safe);
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

router.get("/admin/stats", authenticate, requireAdmin, (req, res) => {
  try {
    const { ordersDB } = require("../models");
    const quotes = quotesDB.getAll();
    const parts = partsDB.getAll();
    const orders = ordersDB.getAll();

    // Fulfilled order statuses — money we actually got (or will get on shipment)
    const PAID_STATUSES = ["paid", "received", "in_production", "quality_check", "packing", "shipped", "delivered"];
    const paidOrders = orders.filter((o) => PAID_STATUSES.includes(o.status));
    const paidRevenue = paidOrders.reduce((sum, o) => sum + (o.total || 0), 0);

    // Open pipeline: draft quotes waiting to be purchased
    const openQuotes = quotes.filter((q) => q.status === "draft").length;

    // Activity: parts uploaded in the last 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const uploads30d = parts.filter((p) => {
      const t = p.createdAt ? new Date(p.createdAt).getTime() : 0;
      return t >= cutoff;
    }).length;

    res.json({
      // New, real metrics
      totalOrders: paidOrders.length,
      paidRevenue,
      openQuotes,
      uploads30d,
      // Legacy fields kept for backwards compatibility
      totalQuotes: quotes.length,
      totalParts: parts.length,
      totalRevenue: paidRevenue,
      avgOrderValue: paidOrders.length > 0 ? paidRevenue / paidOrders.length : 0,
      quotesToday: quotes.filter((q) => {
        const d = new Date(q.createdAt);
        const today = new Date();
        return d.toDateString() === today.toDateString();
      }).length,
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to compute stats" });
  }
});

// ADMIN — Parts / All Uploads (newest first, filters orphans)
router.get("/admin/parts", authenticate, requireAdmin, (req, res) => {
  try {
    const parts = partsDB.getAll();
    // Sort newest first
    parts.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    // Strip heavy fields (geometry meshData, dfm) to keep payload small
    const slim = parts.map((p) => ({
      id: p.id,
      fileName: p.fileName,
      storedName: p.storedName,
      fileSize: p.fileSize,
      createdAt: p.createdAt,
      boundingBox: p.geometry?.boundingBox || null,
      volume: p.geometry?.volume || null,
      triangleCount: p.geometry?.triangleCount || null,
    }));
    res.json(slim);
  } catch (err) {
    console.error("Admin parts list error:", err);
    res.status(500).json({ error: "Failed to retrieve parts" });
  }
});

// ———————————————————————————————————————————————————————————
// ADMIN — Database Backup
// Downloads the SQLite database file for safekeeping.
// IMPORTANT: Railway uses ephemeral storage — the database
// resets on every deploy. Download backups before deploying.
// ———————————————————————————————————————————————————————————

router.get("/admin/backup/db", authenticate, requireAdmin, (req, res) => {
  const { saveToDisk, DB_PATH } = require("../models/database");
  try {
    // Flush in-memory changes to disk before sending
    saveToDisk();
    if (!fs.existsSync(DB_PATH)) {
      return res.status(404).json({ error: "Database file not found" });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    res.setHeader("Content-Disposition", `attachment; filename="nordmfg-backup-${timestamp}.db"`);
    res.setHeader("Content-Type", "application/x-sqlite3");
    const stream = fs.createReadStream(DB_PATH);
    stream.pipe(res);
  } catch (err) {
    console.error("Backup error:", err);
    res.status(500).json({ error: "Backup failed" });
  }
});

// JSON export of all data (portable backup, no SQLite dependency to restore)
router.get("/admin/backup/json", authenticate, requireAdmin, (req, res) => {
  try {
    const { ordersDB } = require("../models");
    const backup = {
      exportedAt: new Date().toISOString(),
      version: "1.0",
      data: {
        materials: materialsDB.getAll(),
        finishes: finishesDB.getAll(),
        pricingRules: pricingDB.getAll(),
        leadTimes: leadTimesDB.getAll(),
        quotes: quotesDB.getAll(),
        parts: partsDB.getAll(),
        orders: ordersDB.getAll(),
      },
    };
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    res.setHeader("Content-Disposition", `attachment; filename="nordmfg-backup-${timestamp}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.json(backup);
  } catch (err) {
    console.error("JSON backup error:", err);
    res.status(500).json({ error: "Backup failed" });
  }
});

router.get("/parts/:partId/download", authenticate, requireAdmin, (req, res) => {
  const part = partsDB.getById(req.params.partId);
  if (!part) return res.status(404).json({ error: "Part not found" });
  const safeName = path.basename(part.storedName || "");
  if (!safeName) return res.status(404).json({ error: "No file" });
  const filePath = path.join(uploadDir, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing on disk" });
  // Encrypted-at-rest files are decrypted in memory for the download.
  if (fileCrypto.isEncryptedPath(safeName)) {
    try {
      const buf = fileCrypto.decryptToBuffer(filePath);
      const downloadName = part.fileName || safeName.replace(/\.enc$/, "");
      res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(buf);
    } catch (err) {
      console.error("Decrypt error:", err.message);
      return res.status(500).json({ error: "Failed to read file" });
    }
  }
  res.download(filePath, part.fileName || safeName);
});

module.exports = router;
module.exports.loadPricingRules = loadPricingRules;
