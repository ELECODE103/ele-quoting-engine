/**
 * Uploaded-file retention sweep.
 *
 * Customer CAD files shouldn't linger on disk forever. This periodically deletes
 * files in the upload directory older than the retention window. By the time a
 * file ages out, its order has been produced (and the job traveler generated),
 * so the transient upload is safe to remove.
 *
 * Window is configurable via UPLOAD_RETENTION_HOURS (default 168h = 7 days).
 */
const fs = require("fs");
const path = require("path");

function sweepOnce(uploadDir, maxAgeMs) {
  let removed = 0;
  if (!fs.existsSync(uploadDir)) return removed;
  const now = Date.now();
  for (const name of fs.readdirSync(uploadDir)) {
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
      const removed = sweepOnce(uploadDir, maxAgeMs);
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

module.exports = { startRetentionSweep, sweepOnce };
