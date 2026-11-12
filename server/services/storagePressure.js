/**
 * What the server does by itself when the database or the file folders fill
 * up, so that the owner does not have to (independent review 2026-11-11, H3
 * and H4). Before this, reaching either ceiling closed uploads to every
 * customer for a week to a month, a restart did not help, and nothing in the
 * admin panel cleared it.
 *
 * The order things give way, least valuable first:
 *
 *   DATABASE (DB_MAX_MB)
 *     always                 lapsed drafts and abandoned parts go on schedule (rowRetention.js)
 *     at DB_SWEEP_PERCENT    the oldest draft quotes of visitors without an account, that no
 *       (80 %)               order or request refers to and nobody has touched for
 *                            DRAFT_SWEEP_MIN_AGE_MINUTES, are removed and the file compacted
 *     at the anonymous       NEW draft quotes and NEW uploads from visitors without a confirmed
 *       share (85 %)         account are refused (re-pricing a quote they have open still works)
 *     at 100 %               new drafts and uploads from confirmed accounts are refused too
 *     never refused          checkout, sign-in, orders, payment notices, the admin
 *
 *   FILES (UPLOAD_DIR_MAX_MB)
 *     always                 uploads past their retention, orphan drawings, payloads with no part
 *     at UPLOAD_DIR_WARN_PERCENT (80 %)
 *                            1. uploads no quote, order or request refers to, oldest first
 *                            2. uploads only a no-account draft refers to, oldest first (the draft
 *                               goes with them) — each untouched for STORAGE_EVICT_MIN_AGE_MINUTES
 *     at the anonymous share (85 %)   new uploads from visitors without a confirmed account refused
 *     at 100 %               everyone's new uploads refused
 *     never removed          a file on an order, on an open request, or on a signed-in
 *                            customer's quote that can still be ordered
 *
 * Also here: the attachments of requests that are closed (declined, lost,
 * expired) are deleted RFQ_CLOSED_ATTACHMENT_DAYS after they closed; uploads
 * left on disk with no part row (a crash mid-parse) are deleted after
 * UPLOAD_ORPHAN_MINUTES; and the admin's own actions — delete a request with
 * its attachment, purge old no-account drafts.
 */
const fs = require("fs");
const path = require("path");
const { limits } = require("../security/limits");
const rowRetention = require("./rowRetention");

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const CLOSED_RFQ = ["declined", "lost", "expired"];

const state = {
  lastDatabaseRelief: null,   // { at, removedDrafts, bytesBefore, bytesAfter }
  lastStorageRelief: null,    // { at, removedUploads, removedDrafts, bytesBefore, bytesAfter }
  lastAttachmentSweep: null,  // { at, removed }
  lastOrphanSweep: null,      // { at, removed }
  running: false,
  nudgedAt: 0,
};

const guards = () => require("../security/uploadGuards");
const uploadsDir = () => path.join(guards().DATA_DIR, "uploads");
const time = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); return true; } catch (err) { if (err.code !== "ENOENT") console.error(`Storage: could not remove a file (${err.code || "error"})`); return false; }
}

// ─── Database ────────────────────────────────────────────────

/**
 * Remove the oldest no-account drafts until the database is back under its
 * sweep line (or there are none left to remove), then compact the file.
 * @param {object} models
 * @param {{ force?: boolean, now?: number, database?: object, minAgeMs?: number }} [opt]
 * @returns {null | { removedDrafts: number, bytesBefore: number, bytesAfter: number }}
 */
function relieveDatabase(models, opt = {}) {
  const database = opt.database || require("../models/database");
  const now = opt.now || Date.now();
  const max = limits.databaseMaxBytes;
  const bytesBefore = database.fileSize();
  if (!opt.force && bytesBefore < max * limits.dbSweepFraction) return null;
  const target = max * Math.max(0.1, limits.dbSweepFraction - 0.2);
  const minAgeMs = opt.minAgeMs ?? limits.draftSweepMinAgeMinutes * MIN;

  const refs = rowRetention.references(models, { now });
  const candidates = refs.anonymousDrafts
    .filter((d) => d.lastActivity == null || now - d.lastActivity >= minAgeMs)
    .sort((a, b) => (a.lastActivity || 0) - (b.lastActivity || 0));
  const need = bytesBefore - target;
  let freed = 0;
  const ids = [...refs.expiredQuotes];
  for (const d of candidates) {
    if (freed >= need) break;
    ids.push(d.id);
    freed += d.bytes;
  }
  if (ids.length === 0) {
    const result = { removedDrafts: 0, bytesBefore, bytesAfter: bytesBefore };
    state.lastDatabaseRelief = { at: new Date(now).toISOString(), ...result };
    return result;
  }
  database.batch(() => { for (const id of ids) models.quotesDB.delete(id); });
  if (database.compact) database.compact();
  const bytesAfter = database.fileSize();
  const result = { removedDrafts: ids.length, bytesBefore, bytesAfter };
  state.lastDatabaseRelief = { at: new Date(now).toISOString(), ...result };
  console.warn(`Database at ${Math.round((bytesBefore / max) * 100)}% of its ceiling: removed ${ids.length} old draft quote(s) of visitors without an account; ${mb(bytesBefore)} MB → ${mb(bytesAfter)} MB.`);
  return result;
}

/**
 * The admin's "clear old drafts" action: every no-account draft that no order
 * or request refers to and that nobody has touched for `olderThanHours`.
 */
function purgeAnonymousDrafts(models, { olderThanHours = 48, now = Date.now(), database = require("../models/database") } = {}) {
  const hours = Math.max(0, Number(olderThanHours) || 0);
  const refs = rowRetention.references(models, { now });
  const ids = refs.anonymousDrafts.filter((d) => d.lastActivity == null || now - d.lastActivity >= hours * 60 * MIN).map((d) => d.id);
  const bytesBefore = database.fileSize ? database.fileSize() : 0;
  if (ids.length) {
    database.batch(() => { for (const id of ids) models.quotesDB.delete(id); });
    if (database.compact) database.compact();
  }
  const bytesAfter = database.fileSize ? database.fileSize() : 0;
  return { removedDrafts: ids.length, keptDrafts: refs.anonymousDrafts.length - ids.length, bytesBefore, bytesAfter };
}

// ─── Files ───────────────────────────────────────────────────

/** Remove one part: its upload, its row, its payload files. Returns the bytes freed. */
function evictPart(models, row) {
  const bytes = (Number(row.fileSize) || 0) + (Number(row.meshBytes) || 0) + (Number(row.detailBytes) || 0);
  const stored = path.basename(String(row.storedName || ""));
  if (stored) unlinkQuiet(path.join(uploadsDir(), stored));
  models.partsDB.delete(row.id);
  return bytes;
}

/**
 * Evict uploads until the folders are back under the warning line less a
 * margin. Never touches a file on an order, an open request or a signed-in
 * customer's live quote.
 * @returns {null | { removedUploads, removedDrafts, bytesBefore, bytesAfter }}
 */
function relieveStorage(models, opt = {}) {
  const g = guards();
  const now = opt.now || Date.now();
  const max = limits.storageMaxBytes;
  const bytesBefore = g.storage.scan();
  if (!opt.force && bytesBefore < max * limits.storageWarnFraction) return null;
  const target = max * Math.max(0.1, limits.storageWarnFraction - 0.15);
  const minAgeMs = opt.minAgeMs ?? limits.storageEvictMinAgeMinutes * MIN;
  const database = opt.database || require("../models/database");

  const refs = rowRetention.references(models, { now });
  const rows = models.partsDB.getAll()
    .map((p) => ({ row: p, created: time(p.createdAt) || 0 }))
    .filter((p) => !refs.partsProtected.has(p.row.id) && now - p.created >= minAgeMs)
    .sort((a, b) => a.created - b.created);

  let used = bytesBefore;
  let removedUploads = 0;
  const removedDraftIds = new Set();
  const evict = (list) => {
    for (const { row } of list) {
      if (used <= target) return;
      used -= evictPart(models, row);
      removedUploads++;
    }
  };
  database.batch(() => {
    // 1. Nothing refers to it.
    evict(rows.filter((p) => !refs.partsOnAnonymousDrafts.has(p.row.id)));
    // 2. Only no-account drafts refer to it, and none of those was touched recently: the drafts go too.
    if (used > target) {
      const second = rows.filter((p) => {
        const drafts = refs.partsOnAnonymousDrafts.get(p.row.id);
        return drafts && drafts.every((d) => d.lastActivity == null || now - d.lastActivity >= minAgeMs);
      });
      for (const { row } of second) {
        if (used <= target) break;
        for (const d of refs.partsOnAnonymousDrafts.get(row.id)) {
          if (!removedDraftIds.has(d.id)) { removedDraftIds.add(d.id); models.quotesDB.delete(d.id); }
        }
        used -= evictPart(models, row);
        removedUploads++;
      }
    }
  });
  g.storage.invalidate();
  const bytesAfter = g.storage.scan();
  const result = { removedUploads, removedDrafts: removedDraftIds.size, bytesBefore, bytesAfter };
  state.lastStorageRelief = { at: new Date(now).toISOString(), ...result };
  if (removedUploads) console.warn(`File storage at ${Math.round((bytesBefore / max) * 100)}% of its ceiling: removed ${removedUploads} upload(s) that no order, open request or customer's saved quote refers to; ${mb(bytesBefore)} MB → ${mb(bytesAfter)} MB.`);
  return result;
}

/**
 * Uploads on disk that no part row names (the process was killed mid-parse):
 * removed once they are older than UPLOAD_ORPHAN_MINUTES. A file being parsed
 * right now is younger than that.
 */
function sweepOrphanUploads(models, { now = Date.now(), minAgeMs = limits.uploadOrphanMinutes * MIN } = {}) {
  const dir = uploadsDir();
  let names;
  try { names = fs.readdirSync(dir); } catch { return { removed: 0 }; }
  if (names.length === 0) return { removed: 0 };
  const known = new Set(models.partsDB.storedNames());
  let removed = 0;
  for (const name of names) {
    if (known.has(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile() && now - st.mtimeMs >= minAgeMs && unlinkQuiet(path.join(dir, name))) removed++;
    } catch { /* gone already */ }
  }
  state.lastOrphanSweep = { at: new Date(now).toISOString(), removed };
  if (removed) { guards().storage.invalidate(); console.log(`File retention: removed ${removed} upload(s) that no part refers to (left by an interrupted upload)`); }
  return { removed };
}

/** Is this stored drawing still the drawing of anything other than request `exceptRfqId`? */
function drawingUsedElsewhere(models, drawingPath, exceptRfqId) {
  if (!drawingPath) return false;
  return models.quotesDB.table.getAll().some((q) => q.drawingPath === drawingPath)
    || models.ordersDB.getAll().some((o) => o.drawingPath === drawingPath)
    || models.rfqsDB.getAll().some((r) => r.id !== exceptRfqId && r.drawingPath === drawingPath);
}

/** Delete a stored drawing if it sits in one of our drawing folders. */
function removeDrawingFile(drawingPath) {
  const resolved = path.resolve(String(drawingPath || ""));
  if (!guards().DRAWING_DIRS.some((d) => path.dirname(resolved) === path.resolve(d))) return false;
  const ok = unlinkQuiet(resolved);
  if (ok) guards().storage.invalidate();
  return ok;
}

/**
 * Attachments of requests that are over: a request declined, lost or expired
 * more than RFQ_CLOSED_ATTACHMENT_DAYS ago gives its attachment back. The
 * request row stays (the shop's record of who asked for what).
 */
function sweepClosedRequestAttachments(models, { now = Date.now(), graceMs = limits.rfqClosedAttachmentDays * DAY } = {}) {
  let removed = 0;
  for (const r of models.rfqsDB.getAll()) {
    if (!r.drawingPath) continue;
    // A quoted request past its validity date is expired whether or not anyone has looked at it since.
    const validUntil = time(r.validUntil);
    const closedAt = CLOSED_RFQ.includes(r.status)
      ? (time(r.updatedAt) ?? time(r.createdAt))
      : (r.status === "quoted" && validUntil != null && validUntil < now ? validUntil : null);
    if (closedAt == null || now - closedAt < graceMs) continue;
    if (!drawingUsedElsewhere(models, r.drawingPath, r.id)) removeDrawingFile(r.drawingPath);
    models.rfqsDB.update(r.id, { drawingPath: "", attachmentRemovedAt: new Date(now).toISOString() });
    removed++;
  }
  state.lastAttachmentSweep = { at: new Date(now).toISOString(), removed };
  if (removed) console.log(`File retention: removed the attachment of ${removed} closed request(s)`);
  return { removed };
}

// ─── Admin actions ───────────────────────────────────────────

/**
 * Delete a request and its attachment.
 * @returns {{ ok: true, attachmentRemoved: boolean } | { ok: false, status: number, error: string, code: string }}
 */
function deleteRequest(models, id) {
  const r = models.rfqsDB.getById(id);
  if (!r) return { ok: false, status: 404, error: "Request not found", code: "not-found" };
  if (r.orderId) return { ok: false, status: 409, error: "This request became an order, so it is part of the order's record and cannot be deleted. Cancel the order instead.", code: "request-has-order" };
  let attachmentRemoved = false;
  if (r.drawingPath && !drawingUsedElsewhere(models, r.drawingPath, r.id)) attachmentRemoved = removeDrawingFile(r.drawingPath);
  models.rfqsDB.delete(r.id);
  // The quote it came from is an ordinary draft again, so it lapses like one.
  if (r.quoteId) {
    const q = models.quotesDB.table.getById(r.quoteId);
    const others = models.rfqsDB.getAll().some((x) => x.quoteId === r.quoteId);
    if (q && q.status === "rfq" && !others && !models.ordersDB.getAll().some((o) => o.quoteId === q.id)) models.quotesDB.update(q.id, { status: "draft" });
  }
  return { ok: true, attachmentRemoved };
}

/** Delete only a request's attachment (the request stays). */
function deleteRequestAttachment(models, id) {
  const r = models.rfqsDB.getById(id);
  if (!r) return { ok: false, status: 404, error: "Request not found", code: "not-found" };
  if (!r.drawingPath) return { ok: true, attachmentRemoved: false };
  const removed = drawingUsedElsewhere(models, r.drawingPath, r.id) ? false : removeDrawingFile(r.drawingPath);
  models.rfqsDB.update(r.id, { drawingPath: "", attachmentRemovedAt: new Date().toISOString() });
  return { ok: true, attachmentRemoved: removed };
}

// ─── Scheduling ──────────────────────────────────────────────

/** One pass: cheap checks first; the heavy work only when a line has been crossed. */
function tick(models, opt = {}) {
  if (state.running) return;
  state.running = true;
  try {
    if (models.USE_SQLITE !== false) relieveDatabase(models, opt);
    const relieved = relieveStorage(models, opt);
    if (relieved && relieved.removedUploads === 0) sweepOrphanUploads(models, opt);
  } catch (err) {
    console.error("Storage pressure check failed:", err.message);
  } finally {
    state.running = false;
  }
}

/** Ask for a pass soon (after an insert found a line crossed). At most one every 20 seconds. */
function nudge(models) {
  const now = Date.now();
  if (now - state.nudgedAt < 20 * 1000) return;
  state.nudgedAt = now;
  const t = setTimeout(() => tick(models), 50);
  if (t.unref) t.unref();
}

/** Start the periodic passes: pressure every 5 minutes, the slow sweeps at startup and hourly. */
function start(models, opt = {}) {
  const slow = () => {
    try { sweepOrphanUploads(models); sweepClosedRequestAttachments(models); } catch (err) { console.error("Storage sweep failed:", err.message); }
  };
  slow();
  tick(models);
  const fast = setInterval(() => tick(models), opt.intervalMs || 5 * MIN);
  const hourly = setInterval(slow, opt.slowIntervalMs || 60 * MIN);
  if (fast.unref) fast.unref();
  if (hourly.unref) hourly.unref();
  return { fast, hourly };
}

/** For the status page (server/ops): where both ceilings stand and what was last done about them. */
function status() {
  const g = guards();
  const dbMax = limits.databaseMaxBytes;
  const fileMax = limits.storageMaxBytes;
  const dbUsed = g.database.size();
  const fileUsed = g.storage.usage();
  return {
    database: { bytes: dbUsed, maxBytes: dbMax, percent: Math.round((dbUsed / dbMax) * 100), sweepAtPercent: Math.round(limits.dbSweepFraction * 100), anonymousRefusedAtPercent: Math.round((1 - limits.dbReservedFraction) * 100), lastRelief: state.lastDatabaseRelief },
    files: { bytes: fileUsed, maxBytes: fileMax, percent: Math.round((fileUsed / fileMax) * 100), evictAtPercent: Math.round(limits.storageWarnFraction * 100), anonymousRefusedAtPercent: Math.round((1 - limits.storageReservedFraction) * 100), lastRelief: state.lastStorageRelief },
    lastAttachmentSweep: state.lastAttachmentSweep,
    lastOrphanSweep: state.lastOrphanSweep,
  };
}

module.exports = {
  relieveDatabase, relieveStorage, purgeAnonymousDrafts,
  sweepOrphanUploads, sweepClosedRequestAttachments,
  deleteRequest, deleteRequestAttachment,
  tick, nudge, start, status, state,
};
