/**
 * Uploaded-file retention sweep.
 *
 * Customer CAD files shouldn't linger on disk forever. This periodically deletes
 * files in the upload directory older than the retention window, except the
 * ones the caller says are still needed (`opts.keep`): a part that was ordered,
 * or that sits in a firm-quote request still in play, keeps its file. A quote
 * nobody ordered loses its file after the window, as the site says.
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
 * Stored names of the uploads still needed: every part on an order that was not
 * cancelled, and every part on an RFQ that is new, in review, quoted or accepted.
 */
function neededUploads({ ordersDB, orderItemsDB, rfqsDB, partsDB }) {
  const partIds = new Set();
  const live = new Set(ordersDB.getAll().filter((o) => o.status !== "cancelled").map((o) => o.id));
  for (const it of orderItemsDB.getAll()) if (it.partId && live.has(it.orderId)) partIds.add(it.partId);
  for (const r of rfqsDB.getAll()) {
    if (["new", "in-review", "quoted", "accepted", "won"].includes(r.status)) for (const p of r.parts || []) if (p.partId) partIds.add(p.partId);
  }
  const names = new Set();
  for (const id of partIds) {
    const part = partsDB.getById(id);
    if (part && part.storedName) names.add(path.basename(part.storedName));
  }
  return names;
}

/**
 * File names (basenames) of every drawing, and every tax-exemption certificate,
 * a quote, an order or a firm-quote request still points at. Anything else in data/quote-drawings and
 * data/rfq-drawings is an orphan: an attachment whose request was refused
 * after the file was written, a drawing the buyer replaced or removed, or the
 * drawing of a draft quote that lapsed and was deleted.
 */
function referencedDrawings({ quotesDB, ordersDB, rfqsDB }) {
  const names = new Set();
  for (const db of [quotesDB, ordersDB, rfqsDB]) {
    for (const row of db.getAll()) {
      if (row.drawingPath) names.add(path.basename(row.drawingPath));
      // A tax-exemption certificate is stored beside the drawings (services/taxCertificates.js) and is kept the same way.
      if (row.taxCertPath) names.add(path.basename(row.taxCertPath));
    }
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

module.exports = { startRetentionSweep, sweepOnce, neededUploads, referencedDrawings, sweepDrawings, startDrawingSweep, startPayloadSweep };
