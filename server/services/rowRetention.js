/**
 * Database row retention.
 *
 * The upload sweep (fileRetention.js) removes old CAD files; this removes the
 * database rows that go with them, and with each part row its payload files
 * (the preview mesh and any large geometry detail under data/part-payloads:
 * models/partsStore.js deletes them when the row is deleted). Every write
 * rewrites the whole database file, so without this the file only gets bigger
 * and every save gets slower.
 *
 * Kept, whatever their age:
 *   - parts on an order that was not cancelled, or on an RFQ still in play
 *   - quotes that became an order or an RFQ, and their parts
 *   - draft quotes still inside their price hold, and their parts
 * Removed:
 *   - draft quotes whose hold has run out (expiresAt passed; for old rows with
 *     no expiry, last touched more than `quoteDays` ago)
 *   - draft quotes of visitors without an account that were never opened again,
 *     QUOTE_ANON_DRAFT_HOURS (48 h) after they were last priced
 *   - parts older than the upload window that none of the above refers to
 */
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const OPEN_RFQ = ["new", "in-review", "quoted", "accepted", "won"];
const { limits } = require("../security/limits");

const time = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/** The part ids a stored quote row names, without unpacking its priced lines. */
function quotePartIds(row) {
  const ids = new Set();
  const lines = row.lineItems;
  const list = Array.isArray(lines) ? lines : (lines && Array.isArray(lines.pool) ? lines.pool : []);
  for (const li of list) if (li && li.partId) ids.add(li.partId);
  for (const c of row.config?.parts || []) if (c && c.partId) ids.add(c.partId);
  return ids;
}

/** Roughly how many bytes a quote row takes in the database. */
function quoteRowBytes(row) {
  let n = 400;
  for (const key of ["lineItems", "config", "gate"]) {
    if (row[key] === undefined || row[key] === null) continue;
    try { n += JSON.stringify(row[key]).length; } catch { /* not counted */ }
  }
  return n + String(row.notes || "").length;
}

/**
 * Who refers to what, in one pass over the tables. Pure: deletes nothing.
 *
 * A draft quote is LIVE until its price hold runs out — except the draft of a
 * visitor without an account that was never opened again, which lapses
 * QUOTE_ANON_DRAFT_HOURS (48 h) after it was last priced. (Most quotes are
 * someone trying the tool once; a buyer who comes back, or signs in, keeps the
 * full hold.)
 *
 * @returns {{
 *   expiredQuotes: string[],                 draft quotes that have lapsed
 *   keepQuotes: Set<string>,                 every quote that stays
 *   partsProtected: Set<string>,             parts on a live order, an open request, a quote that became one,
 *                                            or a signed-in customer's (or a reopened) live quote
 *   partsOnAnonymousDrafts: Map<string, Array>,  parts only a never-reopened no-account draft refers to → those drafts
 *   anonymousDrafts: Array<{id, lastActivity, bytes, partIds}>   live no-account drafts no order or request refers to
 * }}
 */
function references({ ordersDB, orderItemsDB, rfqsDB, quotesDB }, opts = {}) {
  const now = opts.now || Date.now();
  const quoteMaxAge = (opts.quoteDays || 30) * DAY;
  const anonMaxAge = (opts.anonDraftHours || limits.anonDraftHours) * HOUR;

  const partsProtected = new Set();
  const keepQuotes = new Set();
  const referenced = new Set(); // quotes an order or a request came from

  const orders = ordersDB.getAll();
  const live = new Set(orders.filter((o) => o.status !== "cancelled").map((o) => o.id));
  for (const o of orders) if (o.quoteId) referenced.add(o.quoteId);
  for (const it of orderItemsDB.getAll()) if (it.partId && live.has(it.orderId)) partsProtected.add(it.partId);
  for (const r of rfqsDB.getAll()) {
    if (r.quoteId) referenced.add(r.quoteId);
    if (OPEN_RFQ.includes(r.status)) for (const p of r.parts || []) if (p.partId) partsProtected.add(p.partId);
  }

  // The rows as stored (lines still packed): only ids and dates are read here.
  const quotes = quotesDB ? (quotesDB.table || quotesDB).getAll() : [];
  const expiredQuotes = [];
  const anonymousDrafts = [];
  const softParts = new Map();
  for (const q of quotes) {
    const isDraft = !q.status || q.status === "draft";
    const expires = time(q.expiresAt);
    const touched = time(q.updatedAt) ?? time(q.createdAt);
    const opened = time(q.lastOpenedAt);
    // A row with no usable date is left alone rather than guessed at.
    const holdOver = expires != null ? expires < now : touched != null && now - touched > quoteMaxAge;
    const anonymous = !q.userId;
    const abandoned = anonymous && opened == null && touched != null && now - touched > anonMaxAge;
    if (isDraft && (holdOver || abandoned) && !referenced.has(q.id)) { expiredQuotes.push(q.id); continue; }
    keepQuotes.add(q.id);
    const partIds = quotePartIds(q);
    if (isDraft && anonymous && !referenced.has(q.id)) {
      const draft = { id: q.id, lastActivity: Math.max(touched || 0, opened || 0) || null, bytes: quoteRowBytes(q), partIds, reopened: opened != null };
      anonymousDrafts.push(draft);
      // A draft somebody came back to protects its files like a customer's quote; one nobody reopened only softly.
      if (draft.reopened) { for (const id of partIds) partsProtected.add(id); }
      else for (const id of partIds) { if (!softParts.has(id)) softParts.set(id, []); softParts.get(id).push(draft); }
    } else {
      for (const id of partIds) partsProtected.add(id);
    }
  }
  const partsOnAnonymousDrafts = new Map();
  for (const [id, drafts] of softParts) if (!partsProtected.has(id)) partsOnAnonymousDrafts.set(id, drafts);
  return { expiredQuotes, keepQuotes, partsProtected, partsOnAnonymousDrafts, anonymousDrafts, now };
}

/** Which rows may go. Pure: reads the tables, deletes nothing. */
function plan(models, opts = {}) {
  const now = opts.now || Date.now();
  const partMaxAge = (opts.partHours || Number(process.env.UPLOAD_RETENTION_HOURS) || 168) * 60 * 60 * 1000;
  const refs = references(models, { ...opts, now });
  const staleParts = [];
  for (const p of models.partsDB.getAll()) {
    if (refs.partsProtected.has(p.id) || refs.partsOnAnonymousDrafts.has(p.id)) continue;
    const created = time(p.createdAt);
    if (created != null && now - created > partMaxAge) staleParts.push(p.id);
  }
  return { expiredQuotes: refs.expiredQuotes, staleParts };
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

module.exports = { plan, sweepRows, references, quotePartIds, OPEN_RFQ };
