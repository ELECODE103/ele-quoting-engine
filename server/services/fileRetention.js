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

module.exports = { startRetentionSweep, sweepOnce, neededUploads };
