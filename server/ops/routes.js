/**
 * Admin-only operations routes. Every one of them goes through the same
 * sign-in and admin checks as the rest of the admin area (routes/auth.js:
 * a signed-in account, the admin role read from the database, two-step
 * sign-in enrolled, the CSRF token on anything that is not a GET).
 *
 *   GET  /api/admin/system/status          what Admin → System shows
 *   GET  /api/admin/system/digest/preview  today's digest as text, without sending it
 *   POST /api/admin/system/digest          send the digest now, to the shop's address
 *   POST /api/admin/system/email-test      check the email settings and send one test
 *                                          message to the shop's own address
 *   GET  /api/admin/backup/full            one .tar.gz of the database and every
 *                                          customer-file folder (ops/backupArchive.js)
 *
 * /api/admin/backup/* is already limited to 12 an hour per client
 * (security/rateLimits.js). The system routes get their own small budget here.
 */
const express = require("express");
const status = require("./status");
const digest = require("./digest");
const emailCheck = require("./emailCheck");
const backupArchive = require("./backupArchive");
const state = require("./state");

let backupRunning = false;

function createRouter() {
  const router = express.Router();
  const { authenticate, requireAdmin } = require("../routes/auth");
  const { limiter } = require("../security/rateLimits");
  const admin = [authenticate, requireAdmin];

  router.use("/admin/system", limiter({ windowMs: 15 * 60 * 1000, max: 120, message: "Too many requests to the system page. Try again in a few minutes." }));
  // Sending is rarer than looking: a handful an hour is plenty for a person and useless to anyone else.
  const sendLimit = limiter({ windowMs: 60 * 60 * 1000, max: 10, message: "That is enough test messages for now. Try again in an hour." });

  router.get("/admin/system/status", admin, (req, res) => {
    res.json(status.collect());
  });

  router.get("/admin/system/digest/preview", admin, (req, res) => {
    const m = digest.build();
    res.json({ subject: m.subject, text: m.text });
  });

  router.post("/admin/system/digest", sendLimit, admin, async (req, res, next) => {
    try {
      const r = await digest.send(Date.now(), { scheduled: false });
      res.json({ sent: r.sent, reason: r.reason || null });
    } catch (err) { next(err); }
  });

  router.post("/admin/system/email-test", sendLimit, admin, async (req, res, next) => {
    try {
      const r = await emailCheck.run({ send: true });
      res.json(r);
    } catch (err) { next(err); }
  });

  router.get("/admin/backup/full", admin, async (req, res, next) => {
    if (backupRunning) return res.status(409).json({ error: "A full backup is already being prepared. Wait for it to finish.", code: "backup-running" });
    const database = require("../models/database");
    const uploadGuards = require("../security/uploadGuards");
    let planned;
    try {
      database.saveToDisk(); // what is in memory is on disk before it is read
      planned = backupArchive.plan({ dataDir: uploadGuards.DATA_DIR, dbPath: database.DB_PATH });
    } catch (err) { return next(err); }
    const limit = backupArchive.maxBytes();
    if (planned.totalBytes > limit) {
      return res.status(413).json({
        error: `The data is ${Math.round(planned.totalBytes / 1048576)} MB, more than a download backup holds (${Math.round(limit / 1048576)} MB, BACKUP_MAX_MB). Use a Railway volume backup instead: the service → Backups.`,
        code: "backup-too-large",
      });
    }
    backupRunning = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="straightedge-full-backup-${stamp}.tar.gz"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const fileCrypto = require("../services/fileCrypto");
      const report = await backupArchive.write(res, {
        planned,
        meta: { build: status.build().commit, fileEncryption: fileCrypto.isEnabled() ? "on: files ending .enc need the same NORD_FILE_ENC_KEY to open" : "off" },
      });
      state.set("backup.lastFullAt", new Date().toISOString());
      console.log(`Full backup downloaded by an admin: ${report.files} files, ${(report.bytes / 1e6).toFixed(1)} MB before compression.`);
    } catch (err) {
      // The download is already under way: all that can be done is to cut it, so the browser shows a failed download
      // rather than a file that looks whole. (A cut archive is refused by the restore tool: it has no manifest.)
      console.error("Full backup failed part-way:", err.code || err.name);
      res.destroy(err);
    } finally {
      backupRunning = false;
    }
  });

  return router;
}

module.exports = { createRouter };
