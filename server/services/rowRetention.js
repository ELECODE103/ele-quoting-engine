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
  const { unpackLines, unpackValue } = require("../models/quotesStore");
  const ids = new Set();
  if (typeof row.partIds === "string" && row.partIds) { for (const id of row.partIds.split(",")) ids.add(id); return ids; }
  const lines = unpackLines(row.lineItems);
  for (const li of Array.isArray(lines) ? lines : []) if (li && li.partId) ids.add(li.partId);
  const config = unpackValue(row.config);
  for (const c of config?.parts || []) if (c && c.partId) ids.add(c.partId);
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

/** Rows of a table through SQL when the table has it (no JSON column is parsed), else through getAll(). */
function light(db, sql, fromRow) {
  if (db && typeof db._query === "function") return db._query(sql);
  return db ? db.getAll().map(fromRow) : [];
}

/** Order states that mean "this order is over and nothing was or will be made for it" (services/orderState.js on the order-lifecycle branch uses the same names). */
const ORDER_OVER = ["cancelled", "expired"];
/** An order with a card session open and nothing collected yet. */
const ORDER_UNPAID = ["pending_payment"];
/** A request the shop has not opened yet. */
const RFQ_UNANSWERED = ["new"];

/** Who holds a row: the account when there is one, else the client it came from. */
const holderOf = (userId, clientTag) => (userId ? `user:${userId}` : `tag:${clientTag || ""}`);

/**
 * Who refers to what, in one pass over the tables. Pure: deletes nothing. Reads ids, dates,
 * sizes and holders with SQL; no quote's lines and no part's geometry is read or parsed
 * (independent re-review 2026-11-12, RR-11: the pass used to load and parse every row).
 *
 * A draft quote is LIVE until its price hold runs out — except the draft of a
 * visitor without an account that was never opened again, which lapses
 * QUOTE_ANON_DRAFT_HOURS (48 h) after it was last priced.
 *
 * How strongly a part is held, strongest first:
 *   hard   on an order that is being worked on or was paid for, on an unpaid order in its first
 *          ORDER_UNPAID_PROTECT_HOURS, or on a request the shop has taken up. Never removed.
 *   soft   nothing paid, nothing answered: on a request nobody at the shop has opened, on an
 *          account's saved quote or a reopened draft, on an order never paid for after its first
 *          hours. Kept by every scheduled sweep; under storage pressure kept only inside the
 *          holder's protected share (services/storagePressure.js).
 *   weak   only a never-reopened no-account draft refers to it.
 *   (none) nothing refers to it.
 * An order that is cancelled or expired holds nothing.
 *
 * @returns {{
 *   expiredQuotes: string[],                 draft quotes that have lapsed
 *   keepQuotes: Set<string>,                 every quote that stays
 *   partsProtected: Set<string>,             hard and soft together: what a scheduled sweep must keep
 *   partsHard: Set<string>,
 *   partsOnAnonymousDrafts: Map<string, Array>,  weak: part → the drafts that name it
 *   anonymousDrafts: Array,                  live no-account drafts no order or request came from
 *   drafts: Array<{id, holder, userId, clientTag, bytes, created, lastActivity, partIds, anonymous, reopened}>
 *                                            every live draft no order or request came from, whoever holds it
 *   softRequests: Array<{id, holder, drawingPath, drawingBytes, created}>   unanswered requests with an attachment
 * }}
 */
function references({ ordersDB, orderItemsDB, rfqsDB, quotesDB }, opts = {}) {
  const now = opts.now || Date.now();
  const quoteMaxAge = (opts.quoteDays || 30) * DAY;
  const anonMaxAge = (opts.anonDraftHours || limits.anonDraftHours) * HOUR;
  const unpaidHardMs = limits.orderUnpaidProtectHours * HOUR;

  const partsHard = new Set();
  const partsSoft = new Set();
  const keepQuotes = new Set();
  const referenced = new Set(); // quotes an order or a request came from

  const orders = light(ordersDB, "SELECT id, quote_id, status, created_at FROM orders", (o) => ({ id: o.id, quote_id: o.quoteId, status: o.status, created_at: o.createdAt }));
  const orderClass = new Map(); // order id → "hard" | "soft"
  for (const o of orders) {
    if (o.quote_id) referenced.add(o.quote_id);
    if (ORDER_OVER.includes(o.status)) continue;
    const created = time(o.created_at);
    const young = created == null || now - created < unpaidHardMs;
    orderClass.set(o.id, ORDER_UNPAID.includes(o.status) && !young ? "soft" : "hard");
  }
  for (const it of light(orderItemsDB, "SELECT order_id, part_id FROM order_items WHERE part_id IS NOT NULL", (i) => ({ order_id: i.orderId, part_id: i.partId }))) {
    const cls = orderClass.get(it.order_id);
    if (cls === "hard") partsHard.add(it.part_id); else if (cls === "soft") partsSoft.add(it.part_id);
  }
  const softRequests = [];
  for (const r of light(rfqsDB, "SELECT id, quote_id, user_id, client_tag, status, parts_json, drawing_path, drawing_bytes, created_at FROM rfqs", (x) => ({ id: x.id, quote_id: x.quoteId, user_id: x.userId, client_tag: x.clientTag, status: x.status, parts_json: x.parts, drawing_path: x.drawingPath, drawing_bytes: x.drawingBytes, created_at: x.createdAt }))) {
    if (r.quote_id) referenced.add(r.quote_id);
    if (!OPEN_RFQ.includes(r.status)) continue;
    const unanswered = RFQ_UNANSWERED.includes(r.status);
    let parts = r.parts_json;
    if (typeof parts === "string") { try { parts = JSON.parse(parts); } catch { parts = []; } }
    for (const p of Array.isArray(parts) ? parts : []) if (p && p.partId) (unanswered ? partsSoft : partsHard).add(p.partId);
    if (unanswered && r.drawing_path) softRequests.push({ id: r.id, holder: holderOf(r.user_id, r.client_tag), drawingPath: r.drawing_path, drawingBytes: Number(r.drawing_bytes) || 0, created: time(r.created_at) || 0 });
  }

  const quotes = !quotesDB ? [] : typeof quotesDB.meta === "function" ? quotesDB.meta()
    : (quotesDB.table || quotesDB).getAll().map((q) => ({ id: q.id, userId: q.userId || "", clientTag: q.clientTag || "", status: q.status || "draft", createdAt: q.createdAt, updatedAt: q.updatedAt, expiresAt: q.expiresAt, lastOpenedAt: q.lastOpenedAt, bytes: quoteRowBytes(q), partIds: [...quotePartIds(q)] }));
  const expiredQuotes = [];
  const anonymousDrafts = [];
  const drafts = [];
  const softParts = new Map();
  for (const q of quotes) {
    const isDraft = !q.status || q.status === "draft";
    const expires = time(q.expiresAt);
    const created = time(q.createdAt);
    const touched = time(q.updatedAt) ?? created;
    const opened = time(q.lastOpenedAt);
    // A row with no usable date is left alone rather than guessed at.
    const holdOver = expires != null ? expires < now : touched != null && now - touched > quoteMaxAge;
    const anonymous = !q.userId;
    const abandoned = anonymous && opened == null && touched != null && now - touched > anonMaxAge;
    if (isDraft && (holdOver || abandoned) && !referenced.has(q.id)) { expiredQuotes.push(q.id); continue; }
    keepQuotes.add(q.id);
    const partIds = q.partIds || [];
    if (isDraft && !referenced.has(q.id)) {
      const draft = { id: q.id, holder: holderOf(q.userId, q.clientTag), userId: q.userId || "", clientTag: q.clientTag || "", bytes: q.bytes, created: created || 0, lastActivity: Math.max(touched || 0, opened || 0) || null, partIds, anonymous, reopened: opened != null };
      drafts.push(draft);
      if (anonymous) anonymousDrafts.push(draft);
      // A draft somebody came back to, or an account's, holds its files softly; one nobody reopened only weakly.
      if (!anonymous || draft.reopened) { for (const id of partIds) partsSoft.add(id); }
      else for (const id of partIds) { if (!softParts.has(id)) softParts.set(id, []); softParts.get(id).push(draft); }
    } else {
      // The quote an order or a request came from: its parts are held as that order or request holds them, and at least softly.
      for (const id of partIds) partsSoft.add(id);
    }
  }
  const partsProtected = new Set([...partsHard, ...partsSoft]);
  const partsOnAnonymousDrafts = new Map();
  for (const [id, list] of softParts) if (!partsProtected.has(id)) partsOnAnonymousDrafts.set(id, list);
  return { expiredQuotes, keepQuotes, partsProtected, partsHard, partsOnAnonymousDrafts, anonymousDrafts, drafts, softRequests, now };
}

/** Which rows may go. Pure: reads the tables, deletes nothing. */
function plan(models, opts = {}) {
  const now = opts.now || Date.now();
  const partMaxAge = (opts.partHours || Number(process.env.UPLOAD_RETENTION_HOURS) || 168) * 60 * 60 * 1000;
  const refs = references(models, { ...opts, now });
  const staleParts = [];
  const parts = typeof models.partsDB.rowSizes === "function" ? models.partsDB.rowSizes() : models.partsDB.getAll();
  for (const p of parts) {
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

module.exports = { plan, sweepRows, references, quotePartIds, holderOf, OPEN_RFQ, ORDER_OVER, ORDER_UNPAID, RFQ_UNANSWERED };
