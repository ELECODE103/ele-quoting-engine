/**
 * Database row retention.
 *
 * The upload sweep (fileRetention.js) removes old CAD files; this removes the
 * database rows that go with them. A part row carries the parsed geometry and
 * preview mesh, so abandoned uploads are what make the database file grow —
 * and every write rewrites the whole file. Without this the file only gets
 * bigger and every save gets slower.
 *
 * Kept, whatever their age:
 *   - parts on an order that was not cancelled, or on an RFQ still in play
 *   - quotes that became an order or an RFQ, and their parts
 *   - draft quotes still inside their price hold, and their parts
 * Removed:
 *   - draft quotes whose hold has run out (expiresAt passed; for old rows with
 *     no expiry, last touched more than `quoteDays` ago)
 *   - parts older than the upload window that none of the above refers to
 */
const DAY = 24 * 60 * 60 * 1000;
const OPEN_RFQ = ["new", "in-review", "quoted", "accepted", "won"];

const time = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/** Which rows may go. Pure: reads the tables, deletes nothing. */
function plan({ ordersDB, orderItemsDB, rfqsDB, partsDB, quotesDB }, opts = {}) {
  const now = opts.now || Date.now();
  const partMaxAge = (opts.partHours || Number(process.env.UPLOAD_RETENTION_HOURS) || 168) * 60 * 60 * 1000;
  const quoteMaxAge = (opts.quoteDays || 30) * DAY;

  const keepParts = new Set();
  const keepQuotes = new Set();

  const orders = ordersDB.getAll();
  const live = new Set(orders.filter((o) => o.status !== "cancelled").map((o) => o.id));
  for (const o of orders) if (o.quoteId) keepQuotes.add(o.quoteId);
  for (const it of orderItemsDB.getAll()) if (it.partId && live.has(it.orderId)) keepParts.add(it.partId);
  for (const r of rfqsDB.getAll()) {
    if (r.quoteId) keepQuotes.add(r.quoteId);
    if (OPEN_RFQ.includes(r.status)) for (const p of r.parts || []) if (p.partId) keepParts.add(p.partId);
  }

  const quotes = quotesDB.getAll();
  const expiredQuotes = [];
  for (const q of quotes) {
    const isDraft = !q.status || q.status === "draft";
    const expires = time(q.expiresAt);
    const touched = time(q.updatedAt) ?? time(q.createdAt);
    // A row with no usable date is left alone rather than guessed at.
    const lapsed = expires != null ? expires < now : touched != null && now - touched > quoteMaxAge;
    if (isDraft && lapsed && !keepQuotes.has(q.id)) { expiredQuotes.push(q.id); continue; }
    keepQuotes.add(q.id);
    for (const li of q.lineItems || []) if (li && li.partId) keepParts.add(li.partId);
    for (const c of q.config?.parts || []) if (c && c.partId) keepParts.add(c.partId);
  }

  const staleParts = [];
  for (const p of partsDB.getAll()) {
    if (keepParts.has(p.id)) continue;
    const created = time(p.createdAt);
    if (created != null && now - created > partMaxAge) staleParts.push(p.id);
  }
  return { expiredQuotes, staleParts };
}

/**
 * Delete what plan() found, in one batch, then compact the file.
 * @returns {{ quotes: number, parts: number, bytesBefore: number, bytesAfter: number }}
 */
function sweepRows(models, opts = {}) {
  const database = opts.database || require("../models/database");
  const { expiredQuotes, staleParts } = plan(models, opts);
  const bytesBefore = database.fileSize ? database.fileSize() : 0;
  if (expiredQuotes.length === 0 && staleParts.length === 0) return { quotes: 0, parts: 0, bytesBefore, bytesAfter: bytesBefore };
  database.batch(() => {
    for (const id of expiredQuotes) models.quotesDB.delete(id);
    for (const id of staleParts) models.partsDB.delete(id);
  });
  if (database.compact) database.compact();
  const bytesAfter = database.fileSize ? database.fileSize() : 0;
  return { quotes: expiredQuotes.length, parts: staleParts.length, bytesBefore, bytesAfter };
}

module.exports = { plan, sweepRows };
