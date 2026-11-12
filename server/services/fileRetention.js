/**
 * Uploaded-file retention sweep.
 *
 * Customer CAD files shouldn't linger on disk forever. This periodically deletes
 * files in the upload directory older than the retention window, except the
 * ones the caller says are still needed (`opts.keep`): a part that was ordered,
 * that sits in a firm-quote request still in play, or that is on a saved quote
 * that can still be ordered keeps its file. Once nothing that can become an
 * order refers to a file, it goes after the window.
 *
 * Window is configurable via UPLOAD_RETENTION_HOURS (default 168h = 7 days).
 */
const fs = require("fs");
const path = require("path");

/**
 * @param {string} uploadDir
 * @param {number} maxAgeMs
 * @param {Set<string>|null} [keep] stored file names that must not be removed,
 *        whatever their age: the CAD behind an order or an open firm-quote request.
 */
function sweepOnce(uploadDir, maxAgeMs, keep = null) {
  let removed = 0;
  if (!fs.existsSync(uploadDir)) return removed;
  const now = Date.now();
  for (const name of fs.readdirSync(uploadDir)) {
    if (keep && keep.has(name)) continue;
    const fp = path.join(uploadDir, name);
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fp);
        removed++;
      }
    } catch (_) {
      /* skip files we can't stat/remove */
    }
  }
  return removed;
}

function startRetentionSweep(uploadDir, opts = {}) {
  const hours = opts.hours || Number(process.env.UPLOAD_RETENTION_HOURS) || 168;
  const intervalMs = opts.intervalMs || 6 * 60 * 60 * 1000; // every 6h
  const maxAgeMs = hours * 60 * 60 * 1000;

  const run = () => {
    try {
      const removed = sweepOnce(uploadDir, maxAgeMs, typeof opts.keep === "function" ? opts.keep() : null);
      if (removed > 0) {
        console.log(`File retention: removed ${removed} upload(s) older than ${hours}h`);
      }
    } catch (err) {
      console.error("File retention sweep error:", err.message);
    }
  };

  run(); // once at startup
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref(); // don't keep the process alive for the sweep
  return timer;
}

/**
 * Stored names of the uploads still needed: every part on an order that was
 * not cancelled, every part on a request that is new, in review, quoted or
 * accepted, and every part on a saved quote that can still be ordered.
 *
 * The last one is new (independent review 2026-11-11, H5): files used to be
 * deleted at 7 days while the quote stayed orderable for 30, so an order placed
 * on day 8 arrived without its CAD file. A file now lives as long as anything
 * that can turn into an order refers to it (services/rowRetention.js
 * `references` decides what is live).
 */
function neededUploads(models) {
  const { partsDB } = models;
  const refs = require("./rowRetention").references(models);
  const partIds = new Set([...refs.partsProtected, ...refs.partsOnAnonymousDrafts.keys()]);
  const names = new Set();
  for (const id of partIds) {
    const part = typeof partsDB.getRow === "function" ? partsDB.getRow(id) : partsDB.getById(id);
    if (part && part.storedName) names.add(path.basename(part.storedName));
  }
  return names;
}

/**
 * Are the uploaded files of these parts still on disk?
 * For checkout and the request form: a quote whose file is gone must not turn
 * into an order the shop has no model for — the buyer is asked to upload the
 * file again instead.
 *
 * @param {string[]} partIds
 * @param {{ partsDB?: object, uploadDir?: string }} [opt]
 * @returns {{ ok: boolean, missing: Array<{ partId: string, fileName: string }>, message?: string, code?: string }}
 *          `message` / `code` ("part-file-missing") are ready to send when ok is false.
 */
function partFilesPresent(partIds, opt = {}) {
  const partsDB = opt.partsDB || require("../models").partsDB;
  const uploadDir = opt.uploadDir || path.join(require("../security/uploadGuards").DATA_DIR, "uploads");
  const missing = [];
  for (const id of new Set((partIds || []).filter((x) => typeof x === "string" && x))) {
    const part = typeof partsDB.getRow === "function" ? partsDB.getRow(id) : partsDB.getById(id);
    const stored = part && part.storedName ? path.basename(String(part.storedName)) : "";
    if (!part || !stored || !fs.existsSync(path.join(uploadDir, stored))) missing.push({ partId: id, fileName: (part && part.fileName) || "" });
  }
  if (missing.length === 0) return { ok: true, missing };
  const names = missing.map((m) => m.fileName).filter(Boolean);
  const which = names.length === 0 ? "one of the files on this quote" : names.length === 1 ? names[0] : `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
  return {
    ok: false,
    missing,
    code: "part-file-missing",
    message: `We no longer have ${which} on our server. Please upload ${names.length > 1 ? "the files" : "the file"} again and we'll pick up where you left off.`,
  };
}

/**
 * File names (basenames) of every drawing a quote, an order or a firm-quote
 * request still points at. Anything else in data/quote-drawings and
 * data/rfq-drawings is an orphan: an attachment whose request was refused
 * after the file was written, a drawing the buyer replaced or removed, or the
 * drawing of a draft quote that lapsed and was deleted.
 */
function referencedDrawings({ quotesDB, ordersDB, rfqsDB }) {
  const names = new Set();
  for (const db of [quotesDB, ordersDB, rfqsDB]) {
    for (const row of db.getAll()) if (row.drawingPath) names.add(path.basename(row.drawingPath));
  }
  return names;
}

/**
 * Sweep the drawing folders: remove files no row refers to once they are older
 * than `orphanHours` (default 24 — long enough that a file is never taken from
 * under a request still being submitted). Referenced drawings are never
 * removed here, whatever their age.
 * @returns {number} files removed
 */
function sweepDrawings(dirs, models, opts = {}) {
  const maxAgeMs = (opts.orphanHours || Number(process.env.DRAWING_ORPHAN_HOURS) || 24) * 60 * 60 * 1000;
  const keep = referencedDrawings(models);
  let removed = 0;
  for (const dir of dirs) removed += sweepOnce(dir, maxAgeMs, keep);
  return removed;
}

/** Run sweepDrawings at startup and every six hours. `onSwept` is told how many files went. */
function startDrawingSweep(dirs, models, opts = {}) {
  const run = () => {
    try {
      const removed = sweepDrawings(dirs, models, opts);
      if (removed > 0) console.log(`File retention: removed ${removed} drawing file(s) no quote, order or request refers to`);
      if (typeof opts.onSwept === "function") opts.onSwept(removed);
    } catch (err) {
      console.error("Drawing retention sweep error:", err.message);
    }
  };
  run();
  const timer = setInterval(run, opts.intervalMs || 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

/**
 * Part payload files (data/part-payloads) are deleted with their part's row.
 * This sweep is the backstop: at startup and every six hours it removes any
 * payload file no row accounts for, and temporary files left by a crash.
 */
function startPayloadSweep(partsDB, opts = {}) {
  const run = () => {
    try {
      const r = partsDB.sweepPayloads(opts);
      if (r.removed > 0) console.log(`File retention: removed ${r.removed} part payload file(s) with no part row (${(r.bytes / 1e6).toFixed(1)} MB)`);
    } catch (err) {
      console.error("Part payload sweep error:", err.message);
    }
  };
  run();
  const timer = setInterval(run, opts.intervalMs || 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { startRetentionSweep, sweepOnce, neededUploads, partFilesPresent, referencedDrawings, sweepDrawings, startDrawingSweep, startPayloadSweep };
