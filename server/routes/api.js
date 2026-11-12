const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { randomUUID: uuidv4 } = require("crypto"); // RFC 4122 v4, same format the uuid package produced
const { pool: parsePool } = require("../parsers/parsePool");
const { PricingEngine } = require("../services/pricingEngine");
const quoteGate = require("../services/quoteGate");
const { runDFMAnalysis, defaultProcessSlug } = require("../parsers/fileParser");
const { materialsDB, finishesDB, leadTimesDB, pricingDB, quotesDB, partsDB, pricingAuditDB, ordersDB, orderItemsDB } = require("../models");
const ruleSchema = require("../config/ruleSchema");
const { createPricingAdmin } = require("../services/pricingAdmin");
const pricingPreview = require("../services/pricingPreview");
const calibration = require("../services/calibration");
const { activeProcesses } = require("../processes/registry");
const quoteIntegrity = require("../services/quoteIntegrity"); // the whitelist, the price floor and the fingerprint every price passes through
const partAccess = require("../security/partAccess");        // who may use an uploaded part
const adminAudit = require("../services/adminAudit");        // append-only log of admin changes
const { authenticate, optionalAuth, requireAdmin } = require("./auth");
const { sanitizeString, isValidSlug, isValidUUID, nonNegativeNumber, positiveInt } = require("../middleware/validate");
const shipBy = require("../services/shipBy");
const { validateFileContent } = require("../middleware/fileValidator");
const fileCrypto = require("../services/fileCrypto");
const dxf = require("../geometry/dxf");
const { limits } = require("../security/limits");
const uploadGuards = require("../security/uploadGuards");
const { clientKey } = require("../security/clientKey");
const brand = require("../../shared/brand.json");

const shopFacts = require("../shopFacts");
const { offeredLayerHeight } = require("../services/layerHeight"); // hides catalog options the owner has not confirmed
const router = express.Router();

// ─── FILE UPLOAD CONFIG ──────────────────────────────────────
// Where files land is decided here and nowhere else: a fixed folder and a
// server-generated name (a random UUID plus an extension from the allow-list).
// Nothing the client sends — file name, field name, path — is ever part of a
// path on disk.
const uploadDir = path.join(uploadGuards.DATA_DIR, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const CAD_EXTENSIONS = [".step", ".stp", ".stl", ".3mf", ".iges", ".igs", ".dxf"];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // The fileFilter has already refused anything else; never trust that alone.
    if (!CAD_EXTENSIONS.includes(ext)) return cb(new Error("unsupported extension"));
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  // Size and count are admin-tunable (UPLOAD_MAX_FILE_MB, UPLOAD_MAX_FILES); the
  // rest bounds the multipart parser itself: a handful of short text fields.
  limits: {
    fileSize: limits.uploadMaxFileBytes,
    files: limits.uploadMaxFiles,
    fields: 10,
    fieldSize: 16 * 1024,
    fieldNameSize: 100,
    parts: limits.uploadMaxFiles + 10,
    headerPairs: 50,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (CAD_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error(`We can't read ${uploadGuards.safeFileName(ext, "that kind of").slice(0, 12) || "that kind of"} files here. Upload a STEP, STL, IGES or 3MF model, or a DXF for a flat routed part.`), { status: 400, expose: true }));
    }
  },
});

const mbOf = (bytes) => Math.round(bytes / (1024 * 1024));

/**
 * Receive the files of POST /upload. Upload refusals are answered here, in
 * words, with the limits that are actually in force (multer removes anything
 * it had already written when it refuses a request).
 */
function receiveCadFiles(req, res, next) {
  upload.array("files", limits.uploadMaxFiles)(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `That file is over ${mbOf(limits.uploadMaxFileBytes)} MB, the most the instant quote reads. Send it to us for a firm quote, or export it at a coarser resolution.`, code: "file-too-large", offerRfq: true });
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_PART_COUNT") {
      return res.status(400).json({ error: `Upload up to ${limits.uploadMaxFiles} part files at a time.`, code: "too-many-files" });
    }
    if (err.expose === true && err.message) return res.status(err.status || 400).json({ error: err.message });
    // Anything else at this stage is a body the multipart parser could not make sense of
    // (a broken boundary, a malformed part header, a connection cut short): the sender's error, not ours.
    return res.status(400).json({ error: "That upload couldn't be read. Try again." });
  });
}

/** Delete a file we decided not to keep; never throws. Resolves once it is gone. */
async function discard(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Could not remove a refused upload:", err.code || err.message);
  }
}

/** What the customer is told when a file could not be parsed. `code`/`offerRfq` let the client offer the firm-quote form. */
function parseFailure(fileName, err) {
  const out = { fileName };
  // A parser running off the end of a truncated file throws a RangeError; say what to do, not where the buffer ended.
  if (err instanceof RangeError || err.name === "RangeError" || /out of range/i.test(err.message || "")) {
    out.error = "This file is damaged or incomplete. Re-export it from your CAD program and upload again.";
  } else if (err.fromParser || err.expose) {
    out.error = err.message; // written for the customer (parser, pool)
  } else {
    console.error("Upload: unexpected parse error:", err);
    out.error = "This file could not be read. Re-export it from your CAD program and upload again.";
  }
  if (err.code && typeof err.code === "string" && /^[a-z0-9-]+$/.test(err.code)) out.code = err.code;
  if (err.offerRfq) out.offerRfq = true;
  return out;
}

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
  syncLeadTimeMultipliers(pricingEngine.rules);
  return pricingEngine.rules;
}

/**
 * ONE number per lead time (payments review 2026-11-11, F-14). What a customer is charged for a
 * lead time has always come from the rate card's rush table (rules.rushMultipliers) whenever it
 * names that lead time; the multiplier on the lead-time record was only read for a lead time the
 * table does not name. The Lead Times admin tab edited the record, so its number was shown, saved
 * and never used. Nothing about what is charged changes here: the record is brought into step
 * with the rate card (at startup and after every rate-card change), and an edit on the Lead Times
 * tab is written to the rate card (PUT /admin/lead-times/:id), so the two can never differ again.
 */
function syncLeadTimeMultipliers(rules) {
  const table = (rules && rules.rushMultipliers) || {};
  let changed = 0;
  for (const lt of leadTimesDB.getAll()) {
    if (!Object.prototype.hasOwnProperty.call(table, lt.slug)) continue;
    const charged = Number(table[lt.slug]);
    if (!Number.isFinite(charged) || charged < 1 || Number(lt.multiplier) === charged) continue;
    leadTimesDB.update(lt.id, { multiplier: charged });
    changed++;
  }
  if (changed) console.log(`  Lead times: ${changed} multiplier(s) on the Lead Times tab brought into step with the rate card (what is charged did not change).`);
  return changed;
}

// ─── Admin field whitelists (prevent mass assignment) ────────
// Every material field the pricing models read (pricePerKg / pricePerCm3,
// machinability, materialClass, stockForms, wasteFactor, feedClass,
// grades[].density, thicknesses, density, layer heights) plus the catalog
// fields (name, category, color, active, description).
const MATERIAL_FIELDS = ["name", "slug", "process", "subProcess", "category", "density", "costPerKg", "pricePerKg", "pricePerCm3", "machinability", "materialClass", "stockForms", "wasteFactor", "feedClass", "costPerSheet", "grades", "thicknesses", "layerHeights", "defaultLayerHeight", "active", "description", "color"];
const MATERIAL_NUMBER_FIELDS = { density: [0, 30], costPerKg: [0, 10000], pricePerKg: [0, 10000], pricePerCm3: [0, 100], machinability: [0.05, 10], costPerSheet: [0, 100000], defaultLayerHeight: [0.01, 2], wasteFactor: [0, 2] };
const FEED_CLASSES = ruleSchema.FEED_CLASSES;
// A finish's price is what the pricing models read (processes/shared.js): a charge per part
// (pricePerPart, else minCost), per square inch of surface (pricePerSqIn) and per square decimetre
// (costPerDm2). These are the columns the table has and the names the admin panel sends. The list
// used to name costPerSqMm and costFlat, which are neither: an edit to "Per Part" in the panel was
// dropped without a word and the old price came back.
const FINISH_FIELDS = ["name", "slug", "process", "pricePerPart", "pricePerSqIn", "costPerDm2", "minCost", "active"];
// Names an older client might still send for a price. They are not stored, so they are refused out loud.
const FINISH_UNSTORED_PRICE_FIELDS = ["costPerSqMm", "costFlat"];
// Pricing rules are whitelisted and range-checked by the rule schema (config/ruleSchema.js) in services/pricingAdmin.js.
const LEAD_TIME_FIELDS = ["name", "slug", "days", "multiplier", "active", "description"];

/**
 * Check the whitelisted fields of a small admin record against a type spec:
 *   { field: ["string", maxLength] | ["slug"] | ["boolean"] | ["number", min, max] }
 * Strings are sanitized, numbers must be finite and in range (an empty field
 * from the admin form arrives as NaN → null and is refused, not stored).
 * Returns { ok, error, values }.
 */
function validateTyped(safe, spec) {
  const values = {};
  for (const [key, value] of Object.entries(safe)) {
    const rule = spec[key];
    if (!rule) continue;
    const [type, a, b] = rule;
    if (type === "boolean") {
      values[key] = value === true || value === 1 || value === "true";
    } else if (type === "number") {
      const n = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
      if (!Number.isFinite(n) || n < a || n > b) return { ok: false, error: `${key} must be a number between ${a} and ${b}` };
      values[key] = n;
    } else if (type === "slug") {
      if (!isValidSlug(value)) return { ok: false, error: `${key} may only contain lowercase letters, digits and dashes` };
      values[key] = value;
    } else {
      if (typeof value !== "string" && typeof value !== "number") return { ok: false, error: `${key} must be text` };
      const text = sanitizeString(String(value), a || 200);
      if (!text && key === "name") return { ok: false, error: "name cannot be empty" };
      values[key] = text;
    }
  }
  return { ok: true, values };
}
const FINISH_SPEC = { name: ["string", 120], slug: ["slug"], process: ["string", 40], pricePerPart: ["number", 0, 100000], pricePerSqIn: ["number", 0, 1000], costPerDm2: ["number", 0, 100000], minCost: ["number", 0, 100000], active: ["boolean"] };

/** The whitelisted, typed fields of a finish from an admin request; a price under a name we do not store is an error, not a no-op. */
function validateFinish(body) {
  const b = body || {};
  const unstored = FINISH_UNSTORED_PRICE_FIELDS.find((k) => b[k] !== undefined);
  if (unstored) return { ok: false, error: `${unstored} is not a field of a finish. Its prices are pricePerPart, pricePerSqIn, costPerDm2 and minCost.` };
  return validateTyped(whitelist(b, FINISH_FIELDS), FINISH_SPEC);
}
// A lead-time multiplier below 1 would be a discount for rushing, and null breaks the price: 1–10 only.
const LEAD_TIME_SPEC = { name: ["string", 120], slug: ["slug"], days: ["string", 80], multiplier: ["number", 1, 10], active: ["boolean"], description: ["string", 1000] };

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

const DXF_ROUTING_ONLY = "A DXF is a 2D profile, so it can only be quoted for CNC routing (sheet and plate cut on the router). Switch the process to CNC routing and upload it again, or upload a STEP, STL, IGES or 3MF model for machining or printing.";

/** What the client needs to show a part: geometry summary, DFM, and a 3D mesh or a 2D profile. */
function partPayload(part, parsed) {
  const g = parsed.geometry;
  return {
    partId: part.id,
    fileName: part.fileName,
    geometry: {
      boundingBox: g.boundingBox,
      surfaceArea: g.surfaceArea,
      volume: g.volume,
      triangleCount: g.triangleCount,
      estimatedThickness: g.estimatedThickness,
      flatWidth: g.flatWidth,
      flatHeight: g.flatHeight,
      flatArea: g.flatArea,
      estimatedPerimeter: g.estimatedPerimeter,
      estimatedHoles: g.estimatedHoles,
      estimatedBends: g.estimatedBends,
      estimatedSlots: g.estimatedSlots,
      units: g.units,
      // Recognised features (server/geometry/SCHEMA.md): holes, pockets,
      // slots, walls, access, stock, confidence. Mesh data stays in meshPreview.
      features: g.features || null,
      // 2D input (DXF): the loops for the SVG preview, units, and what was skipped.
      ...(dxf.is2D(g) ? { sourceFormat: "dxf", is2D: true, sourceUnit: g.sourceUnit, profile2d: g.profile2d } : {}),
    },
    dfm: parsed.dfm,
    dfmAll: parsed.dfmAll,
    meshPreview: {
      positions: g.meshData?.positions || [],
      triangleCount: g.meshData?.triangleCount || 0,
    },
  };
}

/**
 * POST /api/upload
 * Upload one or more CAD files, parse geometry, return analysis.
 * Open to anonymous visitors (a part is addressed by its unguessable id). What
 * bounds it: file size and count, the per-address rate limit and daily byte
 * budget, the storage and database ceilings (security/uploadGuards.js), a
 * content check per format (middleware/fileValidator.js), and parsing in a
 * worker under a time and memory budget (parsers/parsePool.js). A file that is
 * refused or fails to parse is deleted before the answer is sent.
 *
 * Optional form field `process`: the process the customer has selected. A
 * .dxf is a 2D profile and is only accepted for routing — with any other
 * process it is refused with a message that offers routing (code
 * "dxf-routing-only"). Send the field before the files.
 */
router.post(
  "/upload",
  // Before anything is written: room on disk, and this client's daily byte budget.
  uploadGuards.admit({ addsRows: true, maxRequestBytes: () => limits.uploadMaxFiles * limits.uploadMaxFileBytes + 1024 * 1024 }),
  receiveCadFiles,
  (req, res, next) => {
    // Everything received counts against the client's budget, kept or not.
    uploadGuards.account(req, { received: (req.files || []).reduce((sum, f) => sum + (f.size || 0), 0) });
    next();
  },
  validateFileContent,
  async (req, res) => {
  // Files this request has put on disk and not yet handed to a part record.
  // Whatever is still in here when the request ends — an error, a busy server,
  // a client that hung up — is deleted.
  const pending = new Set((req.files || []).map((f) => f.path));
  let current = null;
  let gone = false;
  res.on("close", () => {
    if (res.writableEnded) return;
    gone = true; // the client went away: stop working for it
    if (current) current.cancel();
  });
  try {
    const errors = [];
    for (const r of req.rejectedFiles || []) {
      const name = uploadGuards.safeFileName(r.fileName);
      const isDxf = /\.dxf$/i.test(name);
      errors.push({
        fileName: name,
        error: isDxf
          ? "This does not look like a DXF file (a DWG renamed to .dxf will not work). Export the part outline as DXF from your CAD program and upload again."
          : "The file's contents do not match its extension. Re-export it from your CAD program and upload again.",
        code: "content-mismatch",
      });
    }
    if (!req.files || req.files.length === 0) {
      if (errors.length) return res.json({ parts: [], errors });
      return res.status(400).json({ error: "No files uploaded" });
    }

    const selectedProcess = typeof req.body?.process === "string" ? req.body.process.trim() : "";
    const client = req.uploadClientKey || clientKey(req);
    const results = [];
    let busy = null;
    for (const file of req.files) {
      const fileName = uploadGuards.safeFileName(file.originalname);
      if (gone) break;
      if (busy) { errors.push({ fileName, error: busy.message, code: "busy" }); continue; }
      try {
        const isDxfFile = path.extname(file.originalname).toLowerCase() === ".dxf";
        if (isDxfFile && selectedProcess && selectedProcess !== "routing") {
          errors.push({ fileName, error: DXF_ROUTING_ONLY, code: "dxf-routing-only", offerProcess: "routing" });
          continue;
        }
        // Parsed in a worker thread, under a time and memory budget (parsers/parsePool.js).
        current = parsePool.run({ filePath: file.path, sizeBytes: file.size, client });
        const parsed = await current;
        current = null;

        // Encrypt the stored file at rest now that parsing is done (no-op unless
        // NORD_FILE_ENC_KEY is configured). Returns the path actually on disk.
        const storedPath = await fileCrypto.encryptFile(file.path);
        pending.delete(file.path);
        pending.add(storedPath);
        const storedName = path.basename(storedPath);

        // Store the part: scalars in the database row, the preview mesh (and any other large
        // payload) in files under data/part-payloads (models/partsStore.js).
        const part = partsDB.insert({
          fileName,
          storedName: storedName,
          filePath: storedPath,
          fileSize: file.size,
          geometry: parsed.geometry,
          dfm: parsed.dfm,
          // The part belongs to the account that uploaded it; without one, to the holder of its edit key.
          userId: req.user?.userId || null,
        });
        pending.delete(storedPath); // the part row owns the file now
        uploadGuards.storage.add(file.size);
        // What we keep of the file besides the file (its preview mesh can be several times the size of a
        // small, dense STL) counts against the sender's daily budget too.
        uploadGuards.budget.add(client, (Number(part.meshBytes) || 0) + (Number(part.detailBytes) || 0));

        results.push(partPayload(part, parsed));
      } catch (err) {
        current = null;
        if (err.code === "cancelled") break;
        if (err.code === "busy") { busy = err; errors.push({ fileName, error: err.message, code: "busy" }); continue; }
        if (err.name === "PayloadError") {
          // The file was read, but what we keep of it could not be stored (the storage ceiling, or the disk).
          // Nothing of this part was kept: its upload is deleted with the rest of `pending`.
          console.error(`Upload: part data not stored (${err.code})`);
          errors.push(err.code === "storage-full"
            ? { fileName, error: uploadGuards.FULL_MESSAGE, code: "storage-full" }
            : { fileName, error: `We couldn't store this file just now. Try again in a minute, or email it to ${brand.email}.`, code: "store-failed" });
          continue;
        }
        errors.push(parseFailure(fileName, err));
      }
    }

    if (gone) return;
    // Refused files are off the disk before the answer goes out.
    await Promise.all([...pending].map(discard));
    pending.clear();
    // Nothing got through because the parsers are saturated: say so with the status a client can act on.
    if (busy && results.length === 0) {
      res.set("Retry-After", String(busy.retryAfter || 60));
      return res.status(503).json({ error: busy.message, code: "busy", retryAfterSeconds: busy.retryAfter || 60, parts: [], errors });
    }
    res.json({ parts: results, errors });
  } catch (err) {
    console.error("Upload error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Upload failed. Please try again." });
  } finally {
    for (const p of pending) discard(p);
  }
});

/**
 * POST /api/parts/:partId/units   { units: "mm" | "in" }
 * Set (or confirm) the drawing units of an uploaded DXF. The file is read
 * again at the chosen scale, so every tolerance, DFM check and location is
 * computed in real millimetres, and the stored part is replaced. Returns the
 * same payload as an upload. The gates in front of it (security/index.js) ask
 * for the verified-human token when the bot check is on and for the part's
 * edit key (X-Part-Key, handed to the uploader with the upload answer): the
 * part id alone is not enough to change a part.
 */
router.post("/parts/:partId/units", async (req, res) => {
  try {
    const units = req.body?.units;
    if (units !== "mm" && units !== "in") return res.status(400).json({ error: 'units must be "mm" or "in"' });
    const part = isValidUUID(req.params.partId) ? partsDB.getById(req.params.partId) : null;
    if (!part) return res.status(404).json({ error: "Part not found" });
    if (!dxf.is2D(part.geometry)) return res.status(400).json({ error: "Units can only be chosen for a DXF. STEP, IGES and 3MF carry their own units; STL is read as millimetres." });
    // The shop builds from the stored geometry of an ordered part. Once a part is on an order
    // its units are settled: changing them here would change the size on the traveler.
    // (The gate in security/index.js makes the same check, and covers firm-quote requests too, before
    // this route is reached; it is repeated here so the route is safe wherever the router is mounted.)
    if (orderItemsDB.getAll().some((it) => it.partId === part.id)) {
      return res.status(409).json(require("../security").PART_LOCKED);
    }
    const safeName = path.basename(part.storedName || "");
    const filePath = path.join(uploadDir, safeName);
    if (!safeName || !fs.existsSync(filePath)) return res.status(410).json({ error: "The uploaded file is no longer on our server. Upload it again." });
    let parsed;
    try {
      // Read again in a worker, like the upload. An encrypted file is decrypted in memory and handed over.
      const encrypted = fileCrypto.isEncryptedPath(safeName);
      const buffer = encrypted ? await fileCrypto.decryptFile(filePath) : undefined;
      parsed = await parsePool.run({ filePath, options: { ext: ".dxf", units }, buffer, sizeBytes: part.fileSize || 0, client: clientKey(req) });
    } catch (err) {
      if (err.name === "FileCryptoError") {
        console.error(`Units: stored DXF could not be decrypted (${err.code})`);
        return res.status(500).json({ error: "Could not change the units. Please upload the file again." });
      }
      if (err.code === "busy") {
        res.set("Retry-After", String(err.retryAfter || 60));
        return res.status(503).json({ error: err.message, code: "busy" });
      }
      // e.g. two outlines that were one loop at the other scale's weld tolerance
      const failure = parseFailure(part.fileName, err);
      return res.status(422).json({ error: failure.error, ...(failure.code ? { code: failure.code } : {}) });
    }
    const updated = partsDB.update(part.id, { geometry: parsed.geometry, dfm: parsed.dfm }) || { ...part, geometry: parsed.geometry };
    // The part is not the part that was priced any more: every draft quote that holds it is priced
    // again now (or marked stale when it cannot be), so no stored total outlives the size it was for.
    refreshDraftQuotesFor(part.id);
    res.json(partPayload({ id: part.id, fileName: updated.fileName || part.fileName }, parsed));
  } catch (err) {
    if (err.name === "PayloadError" && err.code === "storage-full") {
      res.set("Retry-After", "3600");
      return res.status(503).json({ error: uploadGuards.FULL_MESSAGE, code: "storage-full" });
    }
    console.error("Units error:", err);
    res.status(500).json({ error: "Could not change the units. Please try again." });
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
const QUOTE_VALID_DAYS = 30;
const CONFIG_FIELDS = ["partId", "materialSlug", "grade", "thicknessMm", "finishSlug", "quantity", "process", "subProcess", "layerHeight", "infill"];
// Every line is priced and DFM-checked on the main thread, so a quote is capped.
// The builder adds parts ten at a time; a job of more lines than this is a firm quote.
const MAX_QUOTE_LINES = 100;
const MAX_QUANTITY = quoteIntegrity.MAX_QUANTITY;

/**
 * A part configuration from a request body, reduced to the known fields in the
 * shapes pricing expects: short strings, plain numbers. Returns null when it
 * is not an object or a field has the wrong kind of value (an array where a
 * slug should be, say) — the request is then refused, not guessed at.
 */
function cleanConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  // `editKey` proves the sender may use a part uploaded without an account (security/partAccess.js); it is never stored.
  for (const key of ["partId", "materialSlug", "grade", "finishSlug", "process", "subProcess", "editKey"]) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v.length > 120) return null;
    out[key] = v;
  }
  for (const key of ["thicknessMm", "quantity", "layerHeight", "infill"]) {
    const v = raw[key];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : (typeof v === "string" ? Number(v) : NaN);
    if (!Number.isFinite(n)) return null;
    out[key] = n;
  }
  // Nothing is clamped or rounded here: a quantity that is not a whole number of pieces within
  // the limit is refused by the whitelist (services/quoteIntegrity.js), not turned into another one.
  return out;
}

function quoteError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, expose: true, extra });
}

/** The rate card's rush table wins when it names this lead time, else the lead-time record's own multiplier. */
function rushMultiplier(leadTime) {
  const fromTable = Number((pricingEngine.rules.rushMultipliers || {})[leadTime.slug]);
  return Number.isFinite(fromTable) && fromTable >= 1 ? fromTable : leadTime.multiplier;
}

/**
 * Price a set of configured parts. Shared by the quote builder (POST /quote)
 * and reorder. Throws quoteError(400) for a bad lead time, part or material.
 * `paperwork` adds the first-article report + certificate of conformance fee as its own line.
 * @returns {{ quote, gate, dfmByPartId, leadTime }}
 */
function priceQuote(partConfigs, leadTimeSlug = "standard", { paperwork = false, access = {} } = {}) {
  // THE CHOKE POINT. Every price the site shows, stores or charges is computed here: the
  // instant quote, a saved quote, a reorder, and the re-pricing at checkout. What may be priced
  // is a whitelist (quoteIntegrity.resolveLine): a registered, active process; a listed material
  // of that process; grade, sub-process, thickness, finish, layer height and quantity from the
  // catalog entry they belong to. Nothing unknown is replaced by a default.
  const rules = pricingEngine.rules;
  quoteIntegrity.assertRulesComplete(rules);
  // A lead time the shop has not confirmed it offers cannot be bought, even by a hand-built request.
  const leadTime = quoteIntegrity.resolveLeadTime(leadTimeSlug, leadTimesDB.getAll());
  const materials = materialsDB.getAll();
  const finishes = finishesDB.getAll();

  // Build pricing input
  const pricingParts = [];
  const dfmByLine = []; // one DFM result per line: its process, its material, its thickness
  const lines = [];
  const parts = [];
  for (const config of partConfigs) {
    const part = isValidUUID(config.partId) ? partsDB.getById(config.partId) : null;
    // A part the caller may not use is answered exactly like one that does not exist.
    if (!part || !partAccess.canUse(part, { ...access, key: config.editKey })) {
      throw quoteError(400, "Part not found. Upload the file again.", { code: "part-not-found", partId: typeof config.partId === "string" ? config.partId.slice(0, 64) : undefined });
    }
    // A part whose measurements are kept in a file (a very detailed model) cannot be priced from a
    // partial copy: if that file cannot be read, say so instead of quoting a wrong number.
    if (part.payloadError) {
      throw quoteError(409, `${part.fileName}: we can no longer read what we measured from this file. Upload it again and it will be priced as before.`, { partId: config.partId, code: "part-data-unavailable" });
    }
    const line = quoteIntegrity.resolveLine(config, { part, materials, finishes });
    lines.push(line);
    parts.push(part);
    pricingParts.push({
      partId: config.partId,
      fileName: part.fileName,
      geometry: part.geometry,
      material: line.material,
      grade: line.grade,
      thicknessMm: line.thicknessMm,
      finish: line.finish,
      quantity: line.quantity,
      process: line.process,
      subProcess: line.subProcess,
      // Only where the process has the option, and only a value the material offers.
      layerHeight: line.layerHeight,
      infill: line.infill,
    });

    // DFM for the chosen process/material/thickness — drives the checkout-vs-RFQ gate.
    dfmByLine.push(runDFMAnalysis(part.geometry, {
      process: line.process,
      subProcess: line.subProcess,
      thicknessMm: line.thicknessMm,
      materialType: /plastic|composite/i.test(line.material.category || "") ? "plastic" : "metal",
      // Material identity for material-aware thresholds (acrylic brittle, nylon moisture, PEEK cost …)
      materialSlug: line.material.slug,
      materialName: line.material.name,
    }));
  }
  // Anodize and powder coat go out to a finisher, so those parts ship on Standard only.
  if (!shopFacts.leadTimeAllowsFinishes(leadTime, lines.map((l) => l.finish.slug))) {
    throw quoteError(400, `Anodize and powder coat are sent out to a finisher, so a part with either one ships on the Standard lead time. Choose Standard, or a finish done here.`, { code: "finish-lead-time" });
  }

  const leadTimeMultiplier = rushMultiplier(leadTime);
  let quote;
  try {
    quote = pricingEngine.calculateOrderQuote({
      parts: pricingParts,
      leadTimeMultiplier,
      paperwork: paperwork === true,
    });
  } catch (err) {
    // The engine could not produce a price (its own guard against NaN, or a model that threw).
    quoteIntegrity.reportToOwner("pricing engine error", { error: String(err && err.message).slice(0, 160), parts: lines.map((l) => ({ partId: l.normalized.partId, process: l.process, material: l.material.slug })) });
    throw new quoteIntegrity.Refusal(422, "price-check-failed", "We couldn't price this setup automatically. Send us the part and we'll quote it by hand.", { offerRfq: true });
  }
  // The floor under every computed price: refused and reported to the owner, never sold, when it fails.
  quoteIntegrity.assertSane(quote, lines, parts, rules);

  // Instant checkout or RFQ? Stored with the quote so checkout can enforce it.
  // Each line is judged on its own DFM result; quantities and totals are summed over the lines
  // of a part, over identical geometry, and over the order (services/quoteGate.js).
  const geometryKeys = parts.map((p) => quoteIntegrity.geometryHash(p.geometry));
  const gate = quoteIntegrity.withIntegrityReasons(quoteGate.evaluate(quote.lineItems, dfmByLine, rules, { geometryKeys }), lines, parts);
  // For the page, which shows one DFM panel per part: when a part is on several lines, the
  // result of the line that needs the most attention (never the last one's by accident).
  const dfmByPartId = {};
  const severity = (d) => (d.summary?.manufacturable === false ? 1e6 : 0) + (d.summary?.failCount || 0) * 1000 + (d.summary?.warnCount || 0);
  lines.forEach((l, i) => {
    const id = l.normalized.partId;
    if (!dfmByPartId[id] || severity(dfmByLine[i]) > severity(dfmByPartId[id])) dfmByPartId[id] = dfmByLine[i];
  });
  // What exactly was priced (stored geometry + validated configuration), for checkout to compare.
  const integrity = quoteIntegrity.fingerprintQuote({ lines, parts, leadTimeSlug: leadTime.slug, paperwork: paperwork === true, rules, leadTimeMultiplier, gate });

  return { quote, gate, dfmByPartId, dfmByLine, leadTime, leadTimeMultiplier, integrity, parts };
}

/** Ship-by date and surcharge in dollars for every active lead time, for the option list. */
function leadTimeOptions(subtotal, finishSlugs = []) {
  return leadTimesDB.getAll().filter((lt) => lt.active && shopFacts.leadTimeListed(lt)).map((lt) => ({
    slug: lt.slug,
    name: lt.name,
    shipBy: shipBy.shipByDate(lt),
    surcharge: Math.max(0, (subtotal || 0) * ((rushMultiplier(lt) || 1) - 1)),
    // false when a sent-out finish (anodize, powder coat) rules this lead time out
    available: shopFacts.leadTimeAllowsFinishes(lt, finishSlugs),
  }));
}

/** The paperwork checkbox as sent by the builder (JSON true) or a form ("true", "1", "on"). */
function wantsPaperwork(v) {
  return v === true || v === 1 || v === "true" || v === "1" || v === "on";
}

/** May this requester re-price (update in place) this stored quote? */
function quoteEditableBy(quote, user) {
  return quote.status === "draft" && (!quote.userId || quote.userId === user?.userId);
}

/**
 * Price the parts and save the result as a draft quote. One row per builder
 * session: when `quoteId` names a draft the requester may edit, that row is
 * updated; otherwise a row is inserted (under `quoteId` if it is unused).
 * Every re-price restarts the 30-day price hold.
 */
function saveQuote({ parts: rawConfigs, leadTimeSlug = "standard", quoteId, process: builderProcess, notes, paperwork }, user, { access = {} } = {}) {
  if (!Array.isArray(rawConfigs) || rawConfigs.length === 0) throw quoteError(400, "No parts configured");
  if (rawConfigs.length > MAX_QUOTE_LINES) {
    throw quoteError(400, `An instant quote holds up to ${MAX_QUOTE_LINES} lines. For a larger job, send us the files for a firm quote.`, { code: "too-many-lines", offerRfq: true });
  }
  const partConfigs = rawConfigs.map(cleanConfig);
  if (partConfigs.some((c) => !c || !c.partId)) throw quoteError(400, "The quote request is not in the expected format.");
  if (typeof leadTimeSlug !== "string") throw quoteError(400, "Invalid lead time", { code: "lead-time-not-offered", field: "leadTime" });
  // The only thing the client says about the paperwork is yes or no. The fee is
  // worked out here from the rate card and the number of lines; any amount sent
  // with the request is ignored.
  const priced = priceQuote(partConfigs, leadTimeSlug, { paperwork: wantsPaperwork(paperwork), access: { user, ...access } });
  // A visitor who uploaded without an account and has since signed in: the parts are theirs now.
  // (Not an admin pricing a customer's part on their behalf.)
  if (user && user.userId && !partAccess.isAdmin(user)) for (const part of priced.parts) partAccess.claim(part, user, partsDB);
  const config = {
    process: sanitizeString(String(builderProcess || partConfigs[0]?.process || ""), 40),
    parts: partConfigs.map((c) => whitelist(c, CONFIG_FIELDS)),
    // The fingerprint of what was priced; checkout prices again and compares (services/quoteIntegrity.js).
    integrity: priced.integrity,
  };
  const existing = isValidUUID(quoteId) ? quotesDB.getById(quoteId) : null;
  const record = {
    ...priced.quote,
    gate: priced.gate,
    config,
    leadTimeSlug,
    status: "draft",
    expiresAt: new Date(Date.now() + QUOTE_VALID_DAYS * 864e5).toISOString(),
    // Bind the quote to the user when signed in; anonymous quotes (public
    // quoting / guest-before-login) stay unbound and remain readable by id.
    userId: user?.userId || null,
  };
  if (notes !== undefined) record.notes = sanitizeString(String(notes || ""), 2000);
  let saved;
  if (existing && quoteEditableBy(existing, user)) {
    saved = quotesDB.update(existing.id, { ...record, userId: user?.userId || existing.userId || null });
  } else {
    // A quote that has moved on (ordered, sent as an RFQ) is forked, keeping the buyer's notes and drawing.
    const carry = existing && (!existing.userId || existing.userId === user?.userId)
      ? { notes: existing.notes || "", drawingFileName: existing.drawingFileName || "", drawingPath: existing.drawingPath || "" }
      : {};
    saved = quotesDB.insert(!existing && isValidUUID(quoteId) ? { id: quoteId, ...record } : { ...carry, ...record });
  }
  return { saved, ...priced };
}

// ─── Stored quotes: priced again before anything is charged ────

/** The saved configuration of a stored quote (quotes from before it was saved: rebuilt from the priced lines). */
function storedConfigs(quote) {
  return quote.config?.parts || (quote.lineItems || []).map((li) => ({
    partId: li.partId, quantity: li.quantity, process: li.meta?.process, subProcess: li.meta?.subProcess,
    materialSlug: li.meta?.materialSlug, grade: li.meta?.grade, finishSlug: li.meta?.finishSlug,
    ...(Number(li.meta?.thicknessMm) > 0 ? { thicknessMm: li.meta.thicknessMm } : {}),
  }));
}

/**
 * Price a stored quote again from its saved configuration, through the same
 * choke point as a new quote: each part's CURRENT stored geometry, the CURRENT
 * rules and catalog, the whitelist, the floor, and the gate run again.
 * Throws what priceQuote throws.
 */
function repriceStoredQuote(quote, user) {
  const configs = storedConfigs(quote).map(cleanConfig);
  if (configs.length === 0 || configs.some((c) => !c || !c.partId)) {
    throw new quoteIntegrity.Refusal(400, "config-invalid", "This quote can't be priced as it was saved.");
  }
  // The parts were authorised when they went into this quote; the caller owns (or holds) the quote.
  return priceQuote(configs, quote.leadTimeSlug || "standard", { paperwork: Boolean(quote.paperwork), access: { user, allowAnonymous: true } });
}

/**
 * The check in front of every order and every Stripe session made from an
 * instant quote: price the stored quote again and compare (quoteIntegrity.judgeCheckout).
 *
 * @returns {{ok: true, quote, priced, basis} | {ok: false, status: number, body: object}}
 *   ok: `quote` is the row to build the order from (refreshed when today's price is the stored
 *   price), `priced.integrity` is the snapshot to keep with the order.
 *   not ok: the refusal to send — `quote-changed` (with the quote at today's price, already
 *   saved for the buyer to confirm), `quote-needs-update`, `rfq-required`, `price-check-failed`.
 */
function verifyQuoteForOrder(quote, user, { confirmedTotal } = {}) {
  let priced;
  try {
    priced = repriceStoredQuote(quote, user);
  } catch (err) {
    if (!err.expose) throw err;
    const code = err.extra?.code || err.code || "";
    if (code === "price-check-failed" || code === "pricing-unavailable") {
      return { ok: false, status: err.status === 503 ? 503 : 409, body: { error: err.message, ...(err.extra || {}) } };
    }
    return { ok: false, status: 409, body: { error: "Something on this quote is no longer available the way it was priced. Reopen the quote to see today's options and price.", code: "quote-needs-update", reason: code || null, reopen: true } };
  }
  const verdict = quoteIntegrity.judgeCheckout({ quote, priced, isAdmin: partAccess.isAdmin(user) });
  if (verdict.action === "review") {
    return { ok: false, status: 409, body: { error: "This quote needs a firm quote from us before it can be ordered", code: "rfq-required", reasons: verdict.reasons } };
  }
  const changed = (current, previousTotal) => ({
    ok: false,
    status: 409,
    body: {
      error: "The price of this quote has changed since it was last priced. Check the new total, then continue to payment.",
      code: "quote-changed",
      previousTotal,
      newTotal: current.orderTotal,
      // A quote that is no longer a draft cannot be re-priced in place: the builder makes a new one from it.
      reopen: current.status !== "draft",
      quote: quoteView(current),
    },
  });
  if (verdict.action === "changed") {
    let current = quote;
    if (quote.status === "draft") {
      // Save today's price, so the buyer is looking at the number they will be charged when they confirm.
      current = quotesDB.update(quote.id, {
        ...priced.quote,
        gate: priced.gate,
        config: { ...(quote.config || {}), parts: storedConfigs(quote), integrity: priced.integrity },
        expiresAt: new Date(Date.now() + QUOTE_VALID_DAYS * 864e5).toISOString(),
      });
    }
    console.warn(`[quote-integrity] quote ${String(quote.id).slice(0, 8)} re-priced at checkout: ${verdict.previousTotal} → ${verdict.newTotal} (${verdict.why})`);
    return changed(current.status === "draft" ? current : { ...quote, orderTotal: verdict.newTotal }, verdict.previousTotal);
  }
  // The stored row is left as it is: its total is today's price (or a held one), and the checks the
  // order routes make on a stored quote still see exactly what was stored.
  const current = quote;
  // The total the buyer's page was showing when they pressed pay, when the page says so.
  if (confirmedTotal !== undefined && confirmedTotal !== null) {
    const seen = Number(confirmedTotal);
    if (!Number.isFinite(seen) || Math.abs(seen - Number(current.orderTotal)) > 0.01) return changed(current, Number.isFinite(seen) ? seen : null);
  }
  return { ok: true, quote: current, priced, basis: verdict.basis };
}

/**
 * A part's stored geometry changed (a DXF's units): price every draft quote
 * that holds it again, in place. A draft that cannot be priced as it stands
 * (the new size needs a setting it does not have) is marked stale instead;
 * either way checkout prices again before it charges.
 */
function refreshDraftQuotesFor(partId) {
  let touched = 0;
  for (const q of quotesDB.query((x) => x.status === "draft" && storedConfigs(x).some((c) => c && c.partId === partId))) {
    try {
      // Server-side refresh on behalf of the quote's owner (a part that belongs to another account stays closed).
      const priced = repriceStoredQuote(q, q.userId ? { userId: q.userId } : null);
      quotesDB.update(q.id, {
        ...priced.quote,
        gate: priced.gate,
        config: { ...(q.config || {}), parts: storedConfigs(q), integrity: priced.integrity },
        expiresAt: new Date(Date.now() + QUOTE_VALID_DAYS * 864e5).toISOString(),
      });
    } catch (err) {
      if (!err.expose) console.error("Draft quote refresh error:", err.message);
      quotesDB.update(q.id, { config: { ...(q.config || {}), integrity: { ...(q.config?.integrity || {}), v: 1, stale: true, staleAt: new Date().toISOString() } } });
    }
    touched++;
  }
  return touched;
}

router.post("/quote", optionalAuth, (req, res) => {
  try {
    const { parts: partConfigs } = req.body;

    if (!partConfigs || !Array.isArray(partConfigs) || partConfigs.length === 0) {
      return res.status(400).json({ error: "No parts configured" });
    }

    const { saved, quote, gate, dfmByPartId, dfmByLine, leadTime } = saveQuote(req.body, req.user);

    res.json({
      quoteId: saved.id,
      ...quote,
      gate,
      expiresAt: saved.expiresAt,
      notes: saved.notes || "",
      drawingFileName: saved.drawingFileName || "",
      shipBy: shipBy.shipByDate(leadTime),
      leadTimeOptions: leadTimeOptions(quote.subtotal, (req.body.parts || []).map((c) => c && c.finishSlug)),
      dfmByPartId: Object.fromEntries(
        Object.entries(dfmByPartId).map(([id, d]) => [id, { summary: d.summary, checks: d.checks }])
      ),
      // The same, line by line (a part can be on more than one line, in more than one process).
      dfmByLine: dfmByLine.map((d) => ({ summary: d.summary, checks: d.checks })),
    });
  } catch (err) {
    if (err.expose) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    console.error("Quote error:", err);
    res.status(500).json({ error: "Quote calculation failed. Please try again." });
  }
});

/** A stored quote as the customer may see it: no server paths, plus the live ship-by date. */
function quoteView(quote) {
  const { drawingPath, ...safe } = quote;
  const leadTime = leadTimesDB.getAll().find((lt) => lt.slug === quote.leadTimeSlug);
  return {
    ...safe,
    // Quotes saved before the paperwork option existed have neither column.
    paperwork: Boolean(quote.paperwork),
    paperworkFee: Number(quote.paperworkFee) || 0,
    leadTimeName: leadTime?.name || "",
    shipBy: leadTime ? shipBy.shipByDate(leadTime) : null,
    expired: Boolean(quote.expiresAt && new Date(quote.expiresAt) < new Date()),
  };
}

/** Load a quote the requester may read, or answer 404. Anonymous quotes are readable by id (UUID). */
function readableQuote(req, res) {
  const quote = quotesDB.getById(req.params.id);
  // If the quote is bound to a user, only that user (or an admin) may read it.
  if (!quote || (quote.userId && (!req.user || (req.user.userId !== quote.userId && req.user.role !== "admin")))) {
    res.status(404).json({ error: "Quote not found" });
    return null;
  }
  return quote;
}

/**
 * GET /api/quote/:id
 */
router.get("/quote/:id", optionalAuth, (req, res) => {
  const quote = readableQuote(req, res);
  if (quote) res.json(quoteView(quote));
});

/**
 * GET /api/quote/:id/session
 * Everything the quote builder needs to reopen a quote: each part's geometry
 * and preview mesh with the configuration it was priced at. Used after the
 * sign-in / register detour, on reload, and by reorder.
 */
router.get("/quote/:id/session", optionalAuth, (req, res) => {
  const quote = readableQuote(req, res);
  if (!quote) return;
  // Quotes saved before the builder config was stored: rebuild it from the priced lines.
  const configs = quote.config?.parts || (quote.lineItems || []).map((li) => ({
    partId: li.partId, quantity: li.quantity, process: li.meta?.process, subProcess: li.meta?.subProcess,
    materialSlug: li.meta?.materialSlug, grade: li.meta?.grade, finishSlug: li.meta?.finishSlug,
  }));
  const parts = [];
  for (const config of configs) {
    // The preview mesh is read from the part's file here, and only here.
    const part = partsDB.getById(config.partId, { mesh: true });
    if (!part) continue;
    // A part that belongs to an account is shown (and its edit key handed out) to that account only;
    // a part uploaded without one goes with the quote that holds it.
    if (!partAccess.canUse(part, { user: req.user, allowAnonymous: true })) continue;
    const { meshData, ...geometry } = part.geometry || {};
    parts.push({
      ...config,
      fileName: part.fileName,
      geometry,
      dfm: part.dfm,
      meshPreview: { positions: meshData?.positions || [], triangleCount: meshData?.triangleCount || 0 },
      // The quote still opens and prices without its 3D preview (the mesh file is missing or cannot be decrypted).
      ...(part.meshError ? { previewUnavailable: true } : {}),
    });
  }
  res.json({
    quoteId: quote.id,
    status: quote.status,
    process: quote.config?.process || parts[0]?.process || "",
    leadTimeSlug: quote.leadTimeSlug || "standard",
    paperwork: Boolean(quote.paperwork),
    notes: quote.notes || "",
    drawingFileName: quote.drawingFileName || "",
    parts,
  });
});

// ─── Drawing on the instant path ─────────────────────────────
// An optional PDF the buyer attaches to a quote. It rides along to the order
// and the admin view; it never changes the price.
const quoteDrawingDir = path.join(uploadGuards.DATA_DIR, "quote-drawings");
if (!fs.existsSync(quoteDrawingDir)) fs.mkdirSync(quoteDrawingDir, { recursive: true });

const drawingUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, quoteDrawingDir),
    filename: (req, file, cb) => cb(null, `${uuidv4()}.pdf`), // server-generated; nothing from the client
  }),
  limits: { fileSize: limits.drawingMaxBytes, files: 1, fields: 5, fieldSize: 4 * 1024, fieldNameSize: 100, parts: 8, headerPairs: 50 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === ".pdf") cb(null, true);
    else cb(Object.assign(new Error("The drawing must be a PDF"), { status: 400, expose: true }));
  },
});

/** Is this the stored drawing of any other quote, order or request? (A reorder or a firm-quote request carries the same file along.) */
function drawingInUseElsewhere(drawingPath, exceptQuoteId) {
  if (!drawingPath) return false;
  const { rfqsDB } = require("../models");
  return quotesDB.getAll().some((q) => q.id !== exceptQuoteId && q.drawingPath === drawingPath)
    || ordersDB.getAll().some((o) => o.drawingPath === drawingPath)
    || rfqsDB.getAll().some((r) => r.drawingPath === drawingPath);
}

router.post(
  "/quote/:id/drawing",
  optionalAuth,
  (req, res, next) => {
    // Who may attach is settled before a byte of the file is accepted.
    const quote = readableQuote(req, res);
    if (!quote) return;
    if (!quoteEditableBy(quote, req.user)) return res.status(409).json({ error: "This quote can no longer be changed" });
    req.quote = quote;
    next();
  },
  uploadGuards.admit({ maxRequestBytes: () => limits.drawingMaxBytes + 64 * 1024 }),
  (req, res) => {
  const quote = req.quote;
  drawingUpload.single("drawing")(req, res, async (err) => {
    const drawingMb = mbOf(limits.drawingMaxBytes);
    if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code === "LIMIT_FILE_SIZE" ? `The drawing is over ${drawingMb} MB` : (err.expose ? err.message : "That upload couldn't be read. Try again.") });
    if (!req.file) return res.status(400).json({ error: "No drawing attached" });
    let stored = req.file.path;
    try {
      uploadGuards.account(req, { received: req.file.size });
      // Extension is not proof: a PDF starts with "%PDF-".
      const head = Buffer.alloc(5);
      const fd = await fs.promises.open(stored, "r");
      try { await fd.read(head, 0, 5, 0); } finally { await fd.close(); }
      if (head.toString("latin1") !== "%PDF-") {
        await discard(stored);
        return res.status(400).json({ error: "That file isn't a PDF" });
      }
      // Encrypted at rest like the CAD files (no-op unless NORD_FILE_ENC_KEY is set).
      stored = await fileCrypto.encryptFile(stored);
      const previous = quote.drawingPath;
      const updated = quotesDB.update(quote.id, { drawingFileName: uploadGuards.safeFileName(req.file.originalname, "drawing.pdf"), drawingPath: stored });
      uploadGuards.storage.add(req.file.size);
      // The file this one replaces goes, unless an order, a request or another quote still points at it.
      if (previous && previous !== stored && path.dirname(path.resolve(previous)) === path.resolve(quoteDrawingDir) && !drawingInUseElsewhere(previous, quote.id)) await discard(previous);
      res.json({ drawingFileName: updated.drawingFileName });
    } catch (e) {
      console.error("Drawing upload error:", e.message);
      await discard(stored);
      if (!res.headersSent) res.status(500).json({ error: "Could not attach the drawing. Please try again." });
    }
  });
});

router.delete("/quote/:id/drawing", optionalAuth, async (req, res) => {
  const quote = readableQuote(req, res);
  if (!quote) return;
  if (!quoteEditableBy(quote, req.user)) return res.status(409).json({ error: "This quote can no longer be changed" });
  const previous = quote.drawingPath;
  quotesDB.update(quote.id, { drawingFileName: "", drawingPath: "" });
  // Removed means removed: the file goes too, unless something else still points at it.
  if (previous && path.dirname(path.resolve(previous)) === path.resolve(quoteDrawingDir) && !drawingInUseElsewhere(previous, quote.id)) await discard(previous);
  res.json({ drawingFileName: "" });
});

// ═══════════════════════════════════════════════════════════════
// MATERIALS & CONFIG (public)
// ═══════════════════════════════════════════════════════════════

router.get("/processes", (req, res) => {
  res.json(activeProcesses());
});
router.get("/materials", (req, res) => {
  // Listed materials of processes the site offers: nothing of a process that is switched off.
  const offered = new Set(activeProcesses().map((p) => p.slug));
  let mats = materialsDB.getAll().filter((m) => m.active && shopFacts.materialListed(m) && offered.has(m.process));
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
  // Listed finishes of processes the site offers (the sheet-metal finishes are in the table but that process is off).
  const offered = new Set(activeProcesses().map((p) => p.slug));
  let fins = finishesDB.getAll().filter((f) => f.active && shopFacts.finishListed(f) && offered.has(f.process));
  if (req.query.process) {
    // Finishes without a process field are legacy sheet metal
    fins = fins.filter((f) => (f.process || 'sheetmetal') === req.query.process);
  }
  // A finish that only goes on some materials (anodize on aluminum, edge polish on clear sheet)
  // says which, so the page lists it only where it can be ordered. Same rule as the pricing whitelist.
  const mats = materialsDB.getAll().filter((m) => quoteIntegrity.materialOffered(m));
  res.json(fins.map((f) => {
    const own = mats.filter((m) => m.process === f.process);
    const fits = own.filter((m) => quoteIntegrity.finishFitsMaterial(f, m));
    return fits.length === own.length ? f : { ...f, materialSlugs: fits.map((m) => m.slug) };
  }));
});

router.get("/lead-times", (req, res) => {
  res.json(leadTimesDB.getAll().filter((lt) => lt.active && shopFacts.leadTimeListed(lt)).map((lt) => ({ ...lt, shipBy: shipBy.shipByDate(lt) })));
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

/**
 * A material is never stored without the price its process is charged from (payments review
 * 2026-11-11, F-13): a blank or zero price used to be saved as "no price" and the part was then
 * priced at a figure built into the pricing code. Printed materials are sold by the cm³, everything
 * else by the kilo. Checked on the record as it will be stored (what was there plus this change).
 * @returns {string|null}
 */
function materialPriceProblem(record) {
  const usable = (v) => { const n = Number(v); return v !== null && v !== undefined && v !== "" && Number.isFinite(n) && n > 0; };
  if (record.process === "3d-printing") {
    if (!usable(record.pricePerCm3)) return "pricePerCm3 must be a price above zero ($ per cm³): a printed material cannot be saved without one";
    return null;
  }
  if (!usable(record.pricePerKg) && !usable(record.costPerKg)) return "pricePerKg must be a price above zero ($ per kg): a material cannot be saved without one";
  return null;
}
const MATERIAL_AUDIT_FIELDS = MATERIAL_FIELDS.filter((f) => f !== "description");

router.put("/admin/materials/:id", authenticate, requireAdmin, (req, res) => {
  const v = validateMaterial(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  const before = materialsDB.getById(req.params.id);
  if (!before) return res.status(404).json({ error: "Material not found" });
  const problem = materialPriceProblem({ ...before, ...v.values });
  if (problem) return res.status(400).json({ error: problem, code: "price-required" });
  const updated = materialsDB.update(req.params.id, v.values);
  if (!updated) return res.status(404).json({ error: "Material not found" });
  adminAudit.record(req.user, { area: "material", action: "update", target: updated.slug, changes: adminAudit.diff(before, updated, MATERIAL_AUDIT_FIELDS) });
  res.json(updated);
});

router.post("/admin/materials", authenticate, requireAdmin, (req, res) => {
  const v = validateMaterial(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (!v.values.name || !v.values.slug) return res.status(400).json({ error: "name and slug are required" });
  const problem = materialPriceProblem(v.values);
  if (problem) return res.status(400).json({ error: problem, code: "price-required" });
  const material = materialsDB.insert({ active: false, ...v.values });
  adminAudit.record(req.user, { area: "material", action: "create", target: material.slug, changes: adminAudit.diff({}, material, MATERIAL_AUDIT_FIELDS) });
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
  adminAudit.record(req.user, { area: "material", action: "duplicate", target: copy.slug, changes: { from: [null, src.slug] } });
  res.status(201).json(copy);
});

router.delete("/admin/materials/:id", authenticate, requireAdmin, (req, res) => {
  const gone = materialsDB.getById(req.params.id);
  const deleted = materialsDB.delete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Material not found" });
  adminAudit.record(req.user, { area: "material", action: "delete", target: gone ? gone.slug : req.params.id, changes: gone ? { pricePerKg: [gone.pricePerKg ?? null, null], pricePerCm3: [gone.pricePerCm3 ?? null, null] } : {} });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Finishes CRUD (whitelisted fields)
// ═══════════════════════════════════════════════════════════════

router.get("/admin/finishes", authenticate, requireAdmin, (req, res) => {
  res.json(finishesDB.getAll());
});
router.put("/admin/finishes/:id", authenticate, requireAdmin, (req, res) => {
  const v = validateFinish(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const before = finishesDB.getById(req.params.id);
  const updated = finishesDB.update(req.params.id, v.values);
  if (!updated) return res.status(404).json({ error: "Finish not found" });
  adminAudit.record(req.user, { area: "finish", action: "update", target: updated.slug, changes: adminAudit.diff(before, updated, FINISH_FIELDS) });
  res.json(updated);
});

router.post("/admin/finishes", authenticate, requireAdmin, (req, res) => {
  const v = validateFinish(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (!v.values.name || !v.values.slug) return res.status(400).json({ error: "name and slug are required" });
  const finish = finishesDB.insert(v.values);
  adminAudit.record(req.user, { area: "finish", action: "create", target: finish.slug, changes: adminAudit.diff({}, finish, FINISH_FIELDS) });
  res.status(201).json(finish);
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Pricing console
//   schema   → the rule descriptors the console renders
//   pricing  → GET current values / PUT validated changes (+ note → audit log)
//   preview  → price 6 reference parts with candidate rules, no save
//   history / restore / reset
// ═══════════════════════════════════════════════════════════════

/** A rate-card change in the admin change log: which rules moved (the values and the note are in the pricing history). */
function logRateCard(user, action, result) {
  if (!result || !result.audit) return;
  adminAudit.record(user, { area: "rate-card", action, target: "pricing rules", changes: { rules: [null, Object.keys(result.audit.diff || {}).slice(0, 40).join(", ")] } });
}

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
  logRateCard(req.user, "save", result);
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
  logRateCard(req.user, "restore", result);
  res.json({ rules: loadPricingRules(), audit: result.audit ? { id: result.audit.id, createdAt: result.audit.createdAt } : null });
});

router.post("/admin/pricing/reset", authenticate, requireAdmin, (req, res) => {
  const result = pricingAdmin.reset({ note: req.body?.note, user: req.user });
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error, errors: result.errors || [] });
  logRateCard(req.user, "reset", result);
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
  const v = validateTyped(whitelist(req.body || {}, LEAD_TIME_FIELDS), LEAD_TIME_SPEC);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const before = leadTimesDB.getById(req.params.id);
  if (!before) return res.status(404).json({ error: "Lead time not found" });
  // The multiplier that is charged lives in the rate card's rush table. An edit here is written
  // there (validated and recorded like any rate-card change), so this tab shows what is charged.
  if (v.values.multiplier !== undefined && Number(v.values.multiplier) !== Number(before.multiplier)) {
    const table = pricingAdmin.currentRules().rushMultipliers || {};
    if (Object.prototype.hasOwnProperty.call(table, before.slug)) {
      const saved = pricingAdmin.save({ rushMultipliers: { ...table, [before.slug]: Number(v.values.multiplier) } }, { note: `Lead Times tab: ${before.name || before.slug} multiplier`, user: req.user });
      if (!saved.ok) return res.status(saved.status || 400).json({ error: saved.error, errors: saved.errors || [] });
      logRateCard(req.user, "save", saved);
    }
  }
  const updated = leadTimesDB.update(req.params.id, v.values);
  if (!updated) return res.status(404).json({ error: "Lead time not found" });
  loadPricingRules(); // the engine and the lead-time records agree from this request on
  adminAudit.record(req.user, { area: "lead-time", action: "update", target: updated.slug, changes: adminAudit.diff(before, updated, LEAD_TIME_FIELDS.filter((f) => f !== "description")) });
  res.json(leadTimesDB.getById(req.params.id));
});

// ═══════════════════════════════════════════════════════════════
// ADMIN — Quotes / Orders
// ═══════════════════════════════════════════════════════════════

router.get("/admin/quotes", authenticate, requireAdmin, (req, res) => {
  const quotes = quotesDB.getAll().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(quotes);
});

/**
 * POST /api/admin/quotes/void-open   { note }
 * For use after a price change the owner does not want to honour on quotes already saved: ends
 * the price hold on every open (draft) quote now. Nothing is deleted — the buyer's parts and
 * setup stay — but checkout answers "this price has expired" until the quote is reopened and
 * priced at today's rules. Quotes that are already orders or firm-quote requests are not touched.
 */
router.post("/admin/quotes/void-open", authenticate, requireAdmin, (req, res) => {
  const note = sanitizeString(String(req.body?.note || ""), 200);
  const now = new Date();
  const ended = new Date(now.getTime() - 1000).toISOString();
  let voided = 0;
  require("../models/database").batch(() => {
    for (const q of quotesDB.query((x) => x.status === "draft" && !(x.expiresAt && new Date(x.expiresAt) < now))) {
      quotesDB.update(q.id, { expiresAt: ended, config: { ...(q.config || {}), integrity: { ...(q.config?.integrity || {}), voidedAt: now.toISOString() } } });
      voided++;
    }
  });
  adminAudit.record(req.user, { area: "quotes", action: "void-open", target: "open quotes", changes: { voided: [null, voided], ...(note ? { note: [null, note] } : {}) } });
  res.json({ voided });
});

/** GET /api/admin/audit — the admin change log, newest first: who changed what and when. */
router.get("/admin/audit", authenticate, requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(adminAudit.list({ limit: req.query.limit }).map(({ id, createdAt, userEmail, area, action, target, changes }) => ({ id, createdAt, userEmail, area, action, target, changes })));
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
    // Only the list's own columns (rows hold no mesh; this keeps dfm and detail out too)
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
// The database lives on the Railway volume mounted at /app/data
// (the service's Volumes setting), so it survives deploys and restarts. A backup
// is still worth taking before a risky change: a volume is one
// disk, not a copy. The file holds every account's password hash
// and the encrypted two-step secret — keep it like a credential.
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
    res.setHeader("Content-Disposition", `attachment; filename="straightedge-backup-${timestamp}.db"`);
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
      // Each part's preview mesh, and the geometry detail of very detailed models, are files under
      // data/part-payloads on the volume, not rows: they are not in this export (nor in the .db file).
      notIncluded: ["data/part-payloads (preview meshes, large geometry detail)", "data/uploads, data/quote-drawings, data/rfq-drawings (customer files)"],
    };
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    res.setHeader("Content-Disposition", `attachment; filename="straightedge-backup-${timestamp}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.json(backup);
  } catch (err) {
    console.error("JSON backup error:", err);
    res.status(500).json({ error: "Backup failed" });
  }
});

router.get("/parts/:partId/download", authenticate, requireAdmin, async (req, res) => {
  const part = isValidUUID(req.params.partId) ? partsDB.getById(req.params.partId) : null;
  if (!part) return res.status(404).json({ error: "Part not found" });
  // The stored name is server-generated; basename() all the same, so a row can never point outside the folder.
  const safeName = path.basename(part.storedName || "");
  if (!safeName) return res.status(404).json({ error: "No file" });
  const filePath = path.join(uploadDir, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing on disk" });
  // Encrypted-at-rest files are decrypted in memory; the name goes through Express's header encoder.
  await fileCrypto.sendDownload(res, filePath, part.fileName || safeName.replace(/\.enc$/, ""));
});

module.exports = router;
module.exports.loadPricingRules = loadPricingRules;
module.exports.saveQuote = saveQuote;
module.exports.priceQuote = priceQuote;
module.exports.repriceStoredQuote = repriceStoredQuote;
module.exports.verifyQuoteForOrder = verifyQuoteForOrder;
module.exports.refreshDraftQuotesFor = refreshDraftQuotesFor;
module.exports.wantsPaperwork = wantsPaperwork;
module.exports.QUOTE_VALID_DAYS = QUOTE_VALID_DAYS;
