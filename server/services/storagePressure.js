/**
 * What the server does by itself when the database or the file folders fill
 * up, so that the owner does not have to (independent review 2026-11-11, H3
 * and H4). Before this, reaching either ceiling closed uploads to every
 * customer for a week to a month, a restart did not help, and nothing in the
 * admin panel cleared it.
 *
 * Who gives way: whoever holds the most, first (independent re-review 2026-11-12, RR-01, RR-02,
 * RR-08: "oldest idle first" removed the quiet customer's row while the flooding sender's rows,
 * which it kept fresh, survived). A "holder" is an account, or for rows with no account the
 * address tag they came from. A pass lowers the heaviest holder to the level of the next one, then
 * both to the next, and so on, until enough is freed: it never takes a row from a lighter holder
 * while a heavier one still has removable rows above it.
 *
 *   DATABASE (DB_MAX_MB)
 *     always                 lapsed drafts and abandoned parts go on schedule (rowRetention.js)
 *     on every save          one sender cannot hold more than its allowance of draft quotes
 *                            (QUOTE_DRAFT_KB_PER_CLIENT / _PER_ACCOUNT, security/quoteGuards.js)
 *     at DB_SWEEP_PERCENT    from the heaviest holder down: uploaded parts nothing refers to (each
 *       (80 %)               holder keeps its newest LOOSE_PARTS_KEEP_PER_HOLDER), then draft quotes
 *                            no order or request came from, oldest first — an account's too — each
 *                            holder keeping its newest DRAFT_KEEP_KB_PER_HOLDER. Then the file is compacted.
 *     at the anonymous       NEW draft quotes and NEW uploads from visitors without a confirmed
 *       share (85 %)         account are refused (re-pricing a quote they have open still works)
 *     at 100 %               new drafts and uploads from confirmed accounts are refused too
 *     never refused          checkout, sign-in, orders, payment notices, the admin
 *     never removed          a row made in the last DRAFT_SWEEP_MIN_AGE_MINUTES; a signed-in
 *                            customer's part in its first CUSTOMER_PART_KEEP_MINUTES; a quote an
 *                            order or a request came from
 *
 *   FILES (UPLOAD_DIR_MAX_MB)
 *     always                 uploads past their retention, orphan drawings, payloads with no part
 *     on every upload        one sender cannot store more than UPLOAD_STORED_MB_PER_IP / _PER_ACCOUNT
 *     at UPLOAD_DIR_WARN_PERCENT (80 %), from the heaviest holder down, within a holder in this order:
 *                            1. uploads no quote, order or request refers to
 *                            2. uploads only a no-account draft refers to (the draft goes with them)
 *                            3. what is held softly — files on a request nobody at the shop has
 *                               taken up, on a saved quote, on an order that was never paid for
 *                               once its payment page has closed, or on one that is cancelled or
 *                               expired — beyond the holder's UPLOAD_PROTECTED_MB_PER_HOLDER
 *                            4. still over the line: unpaid orders are closed, heaviest holder
 *                               first (payment page closed at Stripe, buyer emailed), and their
 *                               files then go by rule 3 (relieveUnpaidOrders below)
 *     at the anonymous share (85 %)   new uploads from visitors without a confirmed account refused
 *     at 100 %               everyone's new uploads refused
 *     never removed          a file on an order that was paid for or is being worked on, or on a
 *                            request the shop has taken up; a file in its first
 *                            STORAGE_EVICT_MIN_AGE_MINUTES; a signed-in customer's part in its
 *                            first CUSTOMER_PART_KEEP_MINUTES
 *
 * A pass works in pieces of about 40 ms with the event loop turning between them (RR-11), and one
 * that found nothing it may remove is not repeated for PRESSURE_BACKOFF_MINUTES.
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
  databaseQuietUntil: 0,      // a database pass found nothing it may remove: not again before this
  storageQuietUntil: 0,
};

const guards = () => require("../security/uploadGuards");
const uploadsDir = () => path.join(guards().DATA_DIR, "uploads");
const time = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); return true; } catch (err) { if (err.code !== "ENOENT") console.error(`Storage: could not remove a file (${err.code || "error"})`); return false; }
}

// ─── Who gives way ───────────────────────────────────────────
//
// Independent re-review 2026-11-12 (RR-01, RR-02, RR-08), the rule both passes now follow:
//
//   Removal goes to whoever holds the most, first. Every sender (an account, or the client a
//   no-account row came from) has a list of what could be removed from them and how many bytes
//   that is. The pass finds the level at which enough is freed and takes each sender down to
//   that level, oldest first: the heaviest holder loses the most, and a sender who is under
//   the level loses nothing. A visitor with one quote or one part is the last to be touched;
//   a flood from a few senders is levelled before anybody else is looked at.
//
// It used to go by idle time ("untouched for 5 minutes"), which a script renews by re-pricing
// and a person does not: the flood stayed and the visitor's quote went.

/** The level L at which Σ max(0, held − L) ≥ need, never below `floor`. `held` is an array of numbers. */
function levelFor(held, need, floor = 0) {
  const sorted = [...held].sort((x, y) => y - x);
  let top = sorted.length ? sorted[0] : 0;
  if (!(need > 0)) return top;
  // Lower the level from the heaviest holder down, one step per holder.
  let freed = 0;
  for (let i = 0; i < sorted.length; i++) {
    const next = Math.max(floor, i + 1 < sorted.length ? sorted[i + 1] : floor);
    const step = (top - next) * (i + 1);
    if (freed + step >= need) return Math.max(floor, top - (need - freed) / (i + 1));
    freed += step;
    top = next;
    if (top <= floor) break;
  }
  return floor;
}

/**
 * Take from each holder, in the order its items are listed, until what it still has is at or
 * under the level — the heaviest holder first, and no further than `need` (items are whole rows
 * or files, so the last holders reached may keep what the level alone would have taken).
 * Between holders of the same weight, the one whose next item is least valuable and oldest goes first.
 * @param {Map<string, Array<{bytes:number, rank?:number, created?:number}>>} byHolder
 * @returns {Array} the items to remove
 */
function levelDown(byHolder, need, floor = 0) {
  if (!(need > 0)) return [];
  const holders = [...byHolder].map(([holder, items]) => ({ holder, items, total: items.reduce((sum, it) => sum + it.bytes, 0) })).filter((h) => h.items.length);
  const level = levelFor(holders.map((h) => h.total), need, floor);
  holders.sort((x, y) => (y.total - x.total) || ((x.items[0].rank || 0) - (y.items[0].rank || 0)) || ((x.items[0].created || 0) - (y.items[0].created || 0)));
  const out = [];
  let freed = 0;
  for (const h of holders) {
    let left = h.total;
    for (const it of h.items) {
      if (left <= level || freed >= need) break;
      out.push(it);
      left -= it.bytes;
      freed += it.bytes;
    }
    if (freed >= need) break;
  }
  return out;
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * After a pass that found nothing it may remove: when to look again. PRESSURE_BACKOFF_MINUTES,
 * or sooner if something was spared only for being new and stops being new before then (a pass
 * that came while the flood's rows were two minutes old must not sleep five minutes on that).
 */
function quietUntil(nextMatureAt, now = Date.now()) {
  const backoff = Date.now() + limits.pressureBackoffMinutes * MIN;
  if (nextMatureAt == null) return backoff;
  return Math.min(backoff, Date.now() + Math.max(1000, nextMatureAt - now + 1000));
}

/** Run `work` over `items` a few at a time, letting the event loop turn between groups (never more than ~`budgetMs` at a stretch). */
async function inPieces(items, work, { budgetMs = 40, sync = false } = {}) {
  let i = 0;
  let longest = 0;
  while (i < items.length) {
    const t0 = Date.now();
    require("../models/database").deferred(() => {
      while (i < items.length && Date.now() - t0 < budgetMs) work(items[i++]);
    });
    longest = Math.max(longest, Date.now() - t0);
    if (!sync && i < items.length) await turn();
  }
  return longest;
}

// ─── Database ────────────────────────────────────────────────

// ─── Orders that were never paid, in the database ─────────────
//
// An order line is about 3 kB (its configuration, its cost build-up and the snapshot of what was
// priced). An order that lapsed unpaid keeps its lines for good, and nothing stops an account from
// starting more (within the ceilings of security/orderCaps.js): a few accounts could walk the
// database to its ceiling with checkouts they never paid for. So, under pressure only:
//
//   lapsed   the LINES of orders that closed unpaid (lapsed, or cancelled before any payment) more
//            than an hour ago are removed, from whoever
//            holds the most first. The order's own row stays (a few hundred bytes), marked
//            linesClearedAt: it is still in the lists as "not paid, closed", and a payment that
//            arrives for it is still flagged for the owner. Its quote went back to the buyer as a
//            draft when it lapsed, so nothing a buyer can still use is lost. Never: an order that
//            was paid, refunded or flagged, a firm-quote order, or one with any money event on record.
//   unpaid   if the database is still at the line where visitors are turned away, unpaid card orders
//            are closed, heaviest holder first, exactly as the file pass does it (payment page
//            closed at Stripe first, buyer emailed), and their lines go the same way.
const LAPSED_LINES_KEEP_MS = 60 * MIN;
const LINE_BYTES_SQL = "(SELECT COALESCE(SUM(200 + COALESCE(OCTET_LENGTH(i.config_json), 0) + COALESCE(OCTET_LENGTH(i.geometry_json), 0) + COALESCE(OCTET_LENGTH(i.dfm_json), 0)), 0) FROM order_items i WHERE i.order_id = o.id)";
const NEVER_PAID_SQL = "o.paid_at IS NULL AND (o.amount_paid IS NULL OR o.amount_paid = 0) AND (o.refunded_amount IS NULL OR o.refunded_amount = 0) AND (o.attention IS NULL OR o.attention = '') AND (o.rfq_id IS NULL OR o.rfq_id = '') AND (o.payment_method IS NULL OR o.payment_method = 'card')";

/** Orders that closed unpaid and still hold lines: [{ id, holder, bytes, lapsed }]. */
function lapsedOrderLines(models) {
  if (!models.ordersDB || typeof models.ordersDB._query !== "function") return [];
  return models.ordersDB._query(`
    SELECT o.id, o.user_id, o.client_tag, COALESCE(o.expired_at, o.cancelled_at, o.updated_at, o.created_at) AS lapsed, ${LINE_BYTES_SQL} AS bytes
      FROM orders o
     WHERE o.status IN ('expired', 'cancelled') AND o.lines_cleared_at IS NULL AND ${NEVER_PAID_SQL}
       AND NOT EXISTS (SELECT 1 FROM payment_events e WHERE e.order_id = o.id AND e.kind NOT IN ('order-expired', 'order-cancelled', 'event'))`)
    .filter((r) => Number(r.bytes) > 0)
    .map((r) => ({ id: r.id, holder: rowRetention.holderOf(r.user_id, r.client_tag), bytes: Number(r.bytes), lapsed: time(r.lapsed) || 0 }));
}

/** Remove the lines of one order that closed unpaid; its row stays. Returns the number of lines removed. */
function clearOrderLines(models, orderId) {
  const order = models.ordersDB.getById(orderId);
  if (!order || !["expired", "cancelled"].includes(order.status) || order.paidAt || order.attention || order.rfqId || order.linesClearedAt) return 0;
  return require("../models/database").transaction(() => {
    const removed = models.orderItemsDB._run("DELETE FROM order_items WHERE order_id = ?", [orderId]);
    models.ordersDB.update(orderId, { linesClearedAt: new Date().toISOString(), lineCount: 0 });
    return removed;
  }, { save: "soon" }); // the pass writes the file once, at its end
}

/**
 * The database is still at the line where visitors are turned away: close unpaid card orders,
 * from whoever holds the most bytes of order lines first, until `need` bytes of lines have gone.
 * @returns {Promise<{ closed: number, settled: number, left: number, clearedOrders: number }>}
 */
async function relieveUnpaidOrderLines(models, { need, sync = false } = {}) {
  const out = { closed: 0, settled: 0, left: 0, clearedOrders: 0 };
  if (!(need > 0) || typeof models.ordersDB._query !== "function") return out;
  const waiting = models.ordersDB._query(`SELECT o.id, o.user_id, o.client_tag, o.created_at, ${LINE_BYTES_SQL} AS bytes FROM orders o WHERE o.status = 'pending_payment' AND ${NEVER_PAID_SQL}`).filter((r) => Number(r.bytes) > 0);
  const holders = new Map();
  for (const o of waiting) {
    const holder = rowRetention.holderOf(o.user_id, o.client_tag);
    if (!holders.has(holder)) holders.set(holder, { bytes: 0, orders: [] });
    const h = holders.get(holder);
    h.bytes += Number(o.bytes);
    h.orders.push(o);
  }
  const lifecycle = require("./orderLifecycle");
  let freed = 0;
  for (const h of [...holders.values()].sort((x, y) => y.bytes - x.bytes)) {
    for (const o of h.orders.sort((x, y) => String(x.created_at || "").localeCompare(String(y.created_at || "")))) {
      let r;
      try { r = await lifecycle.closeUnderPressure(o.id, { reason: "database" }); } catch (err) { r = { outcome: "busy" }; console.error(`Database: could not close unpaid order ${String(o.id).slice(0, 8)}: ${err.code || err.name || "Error"}`); }
      if (r.outcome === "closed") { out.closed++; if (clearOrderLines(models, o.id)) { out.clearedOrders++; freed += Number(o.bytes); } }
      else if (r.outcome === "paid") out.settled++; else out.left++;
      if (!sync) await turn();
    }
    if (freed >= need) break;
  }
  return out;
}

/**
 * What a database pressure pass would remove. Pure.
 *   - the lines of orders that closed unpaid more than an hour ago (see above), heaviest holder first
 *   - lapsed drafts (their hold is over): all of them
 *   - from each sender, heaviest first: uploaded parts nothing refers to (except its newest
 *     LOOSE_PARTS_KEEP_PER_HOLDER, and never a signed-in customer's part in its first hour), then
 *     draft quotes no order or request came from, oldest first, except its newest
 *     DRAFT_KEEP_KB_PER_HOLDER of them. A row made in the last DRAFT_SWEEP_MIN_AGE_MINUTES is left.
 */
function planDatabaseRelief(models, { need, now = Date.now(), refs = rowRetention.references(models, { now }), floor = 0, graceMs = limits.draftSweepMinAgeMinutes * MIN } = {}) {
  const byHolder = new Map();
  const add = (holder, item) => { if (!byHolder.has(holder)) byHolder.set(holder, []); byHolder.get(holder).push(item); };
  // Rows spared only for being new: when the first of them stops being new, a pass has work again.
  let nextMatureAt = Infinity;
  const sparedUntil = (at) => { if (at > now && at < nextMatureAt) nextMatureAt = at; };

  // The lines of orders that closed unpaid: first to go from each holder (nothing a buyer can still use).
  for (const o of lapsedOrderLines(models)) {
    if (now - o.lapsed < LAPSED_LINES_KEEP_MS) { sparedUntil(o.lapsed + LAPSED_LINES_KEEP_MS); continue; }
    add(o.holder, { kind: "order-lines", id: o.id, bytes: o.bytes, created: o.lapsed });
  }

  // Parts nothing refers to.
  const customerKeepMs = limits.customerPartKeepMinutes * MIN;
  const keepNewest = limits.loosePartsKeepPerHolder;
  const loose = new Map();
  if (typeof models.partsDB.rowSizes === "function") {
    for (const p of models.partsDB.rowSizes()) {
      if (refs.partsProtected.has(p.id) || refs.partsOnAnonymousDrafts.has(p.id)) continue;
      const created = time(p.createdAt) || 0;
      const holder = rowRetention.holderOf(p.ownerId, p.clientTag);
      if (!loose.has(holder)) loose.set(holder, []);
      const spareMs = Math.max(graceMs, p.ownerId ? customerKeepMs : 0);
      loose.get(holder).push({ kind: "part", id: p.id, bytes: p.bytes, created, exempt: now - created < spareMs, matureAt: created + spareMs });
    }
  }
  for (const [holder, parts] of loose) {
    parts.sort((x, y) => x.created - y.created);
    const beyondKept = parts.slice(0, Math.max(0, parts.length - keepNewest));
    for (const p of beyondKept) { if (p.exempt) sparedUntil(p.matureAt); else add(holder, p); }
  }

  // Drafts no order or request came from: each sender keeps its newest, up to the keep allowance.
  const keepBytes = limits.draftKeepBytesPerHolder;
  const drafts = new Map();
  for (const d of refs.drafts) { if (!drafts.has(d.holder)) drafts.set(d.holder, []); drafts.get(d.holder).push(d); }
  for (const [holder, list] of drafts) {
    list.sort((x, y) => (y.lastActivity || y.created || 0) - (x.lastActivity || x.created || 0)); // newest first
    let kept = 0;
    const removable = [];
    for (const d of list) {
      if (kept + d.bytes <= keepBytes) { kept += d.bytes; continue; }
      if (now - d.created < graceMs) { kept += d.bytes; sparedUntil(d.created + graceMs); continue; }
      removable.push({ kind: "draft", id: d.id, bytes: d.bytes, created: d.created });
    }
    removable.reverse(); // oldest first
    for (const d of removable) add(holder, d);
  }

  const chosen = levelDown(byHolder, need, floor);
  return {
    quoteIds: [...refs.expiredQuotes, ...chosen.filter((c) => c.kind === "draft").map((c) => c.id)],
    partIds: chosen.filter((c) => c.kind === "part").map((c) => c.id),
    orderIds: chosen.filter((c) => c.kind === "order-lines").map((c) => c.id),
    lapsed: refs.expiredQuotes.length,
    holders: byHolder.size,
    nextMatureAt: Number.isFinite(nextMatureAt) ? nextMatureAt : null,
    removableBytes: [...byHolder.values()].reduce((sum, items) => sum + items.reduce((n, it) => n + it.bytes, 0), 0),
  };
}

/**
 * Bring the database back under its sweep line, taking from whoever holds the most first.
 * The work is done in pieces (plan, deletes a few at a time, the save, the compaction), with
 * the event loop turning between them: the pass used to hold the thread 2 to 3 s at 54 MB
 * (re-review RR-11). A pass that finds nothing it may remove is not repeated for
 * PRESSURE_BACKOFF_MINUTES.
 * @param {object} models
 * @param {{ force?: boolean, now?: number, database?: object, sync?: boolean }} [opt]
 * @returns {Promise<null | { removedDrafts, removedParts, bytesBefore, bytesAfter, longestPieceMs }>}
 */
async function relieveDatabase(models, opt = {}) {
  const database = opt.database || require("../models/database");
  const now = opt.now || Date.now();
  const size = () => (typeof database.liveSize === "function" ? database.liveSize() : database.fileSize());
  const max = limits.databaseMaxBytes;
  const bytesBefore = size();
  if (!opt.force && bytesBefore < max * limits.dbSweepFraction) return null;
  if (!opt.force && state.databaseQuietUntil > Date.now()) return null;
  const target = max * Math.max(0.1, limits.dbSweepFraction - 0.2);
  let removedDrafts = 0;
  let removedParts = 0;
  let clearedOrders = 0;
  let closedUnpaidOrders = 0;
  let longest = 0;
  let nextMatureAt = null;
  const usedNow = () => (typeof database.usedSize === "function" ? database.usedSize() : size());
  // Up to three rounds: removing drafts leaves their parts with nothing referring to them.
  for (let round = 0; round < 3; round++) {
    const need = usedNow() - target;
    if (need <= 0 && round > 0) break;
    const t0 = Date.now();
    const plan = planDatabaseRelief(models, { need, now });
    longest = Math.max(longest, Date.now() - t0);
    nextMatureAt = plan.nextMatureAt;
    const orderIds = plan.orderIds || [];
    if (plan.quoteIds.length === 0 && plan.partIds.length === 0 && orderIds.length === 0) break;
    if (!opt.sync) await turn();
    longest = Math.max(longest, await inPieces(orderIds, (id) => { if (clearOrderLines(models, id)) clearedOrders++; }, opt));
    longest = Math.max(longest, await inPieces(plan.quoteIds, (id) => models.quotesDB.delete(id), opt));
    longest = Math.max(longest, await inPieces(plan.partIds, (id) => { const row = models.partsDB.getRow(id); if (row) evictPart(models, row); }, opt));
    removedDrafts += plan.quoteIds.length;
    removedParts += plan.partIds.length;
  }
  // Still at the line where visitors without an account are turned away: unpaid orders are closed,
  // heaviest holder first, until the database is a little under the line the clean-up starts at.
  {
    const used = usedNow();
    if (used >= max * (1 - limits.dbReservedFraction)) {
      const unpaid = await relieveUnpaidOrderLines(models, { need: used - max * Math.max(0.1, limits.dbSweepFraction - 0.05), sync: opt.sync });
      closedUnpaidOrders = unpaid.closed;
      clearedOrders += unpaid.clearedOrders;
      if (unpaid.closed || unpaid.settled) console.warn(`Database: ${unpaid.closed} unpaid order(s) closed to make room, from whoever held the most first (each buyer was emailed; nothing was charged)${unpaid.settled ? `; ${unpaid.settled} turned out to be paid and were settled` : ""}${unpaid.left ? `; ${unpaid.left} left as they were` : ""}.`);
    }
  }
  if (removedDrafts === 0 && removedParts === 0 && clearedOrders === 0) {
    state.databaseQuietUntil = quietUntil(nextMatureAt, now);
    const result = { removedDrafts: 0, removedParts: 0, clearedOrders: 0, closedUnpaidOrders, bytesBefore, bytesAfter: bytesBefore, longestPieceMs: longest };
    state.lastDatabaseRelief = { at: new Date(now).toISOString(), ...result };
    return result;
  }
  // The file only gets smaller when it is compacted; that and the save are one piece each.
  if (!opt.sync) await turn();
  const t1 = Date.now();
  // Two pieces where the database allows it: the rebuild in memory, then the write of the file.
  if (database.vacuum && database.flush && !opt.sync) {
    database.vacuum();
    longest = Math.max(longest, Date.now() - t1);
    await turn();
    const t2 = Date.now();
    database.flush();
    longest = Math.max(longest, Date.now() - t2);
  } else {
    if (database.compact) database.compact(); else if (database.flush) database.flush();
    longest = Math.max(longest, Date.now() - t1);
  }
  if (removedParts) guards().storage.invalidate();
  const bytesAfter = size();
  const result = { removedDrafts, removedParts, clearedOrders, closedUnpaidOrders, bytesBefore, bytesAfter, longestPieceMs: longest };
  state.lastDatabaseRelief = { at: new Date(now).toISOString(), ...result };
  console.warn(`Database at ${Math.round((bytesBefore / max) * 100)}% of its ceiling: removed ${removedParts} uploaded part(s) that nothing refers to, ${removedDrafts} draft quote(s) and the lines of ${clearedOrders} order(s) that closed unpaid, from whoever held the most first; ${mb(bytesBefore)} MB → ${mb(bytesAfter)} MB (longest piece of work ${longest} ms).`);
  return result;
}

/**
 * The admin's "clear old drafts" action: every no-account draft that no order or request came
 * from and that nobody has touched for `olderThanHours`; and, when the database is over its
 * sweep line, the same pass the server runs by itself (which also takes an account's drafts,
 * heaviest holder first), forced, so the button always does what can be done.
 */
async function purgeAnonymousDrafts(models, { olderThanHours = 48, now = Date.now(), database = require("../models/database") } = {}) {
  const hours = Math.max(0, Number(olderThanHours) || 0);
  const refs = rowRetention.references(models, { now });
  // Idle drafts, and the ones that have already lapsed and were only waiting for the next scheduled sweep.
  const ids = [...refs.expiredQuotes, ...refs.anonymousDrafts.filter((d) => d.lastActivity == null || now - d.lastActivity >= hours * 60 * MIN).map((d) => d.id)];
  const size = () => (typeof database.liveSize === "function" ? database.liveSize() : database.fileSize ? database.fileSize() : 0);
  const bytesBefore = size();
  if (ids.length) {
    await inPieces(ids, (id) => models.quotesDB.delete(id));
    await turn();
    if (database.compact) database.compact();
  }
  let pressure = null;
  if (size() >= limits.databaseMaxBytes * limits.dbSweepFraction) {
    state.databaseQuietUntil = 0;
    pressure = await relieveDatabase(models, { force: true, now, database });
  }
  const bytesAfter = size();
  const also = pressure ? pressure.removedDrafts : 0;
  return { removedDrafts: ids.length + also, removedUnderPressure: also, removedParts: pressure ? pressure.removedParts : 0, keptDrafts: Math.max(0, refs.drafts.length - ids.length - also), bytesBefore, bytesAfter };
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
 * What a file pressure pass would remove. Pure.
 * From each sender, heaviest first, oldest first within a kind:
 *   1. uploads nothing refers to
 *   2. uploads only a never-reopened no-account draft refers to (the draft goes too)
 *   3. what is held softly — files on a request nobody at the shop has opened, on a saved quote,
 *      on an order never paid for — beyond the sender's protected share
 *      (UPLOAD_PROTECTED_MB_PER_HOLDER); the saved quote goes with its file, and an unanswered
 *      request's own attachment counts here too.
 * Never: a file on an order that was paid for or is being worked on, or on a request the shop
 * has taken up; a file in its first STORAGE_EVICT_MIN_AGE_MINUTES; a signed-in customer's part
 * in its first CUSTOMER_PART_KEEP_MINUTES.
 */
function planStorageRelief(models, { need, now = Date.now(), refs = rowRetention.references(models, { now }), graceMs = limits.storageEvictMinAgeMinutes * MIN } = {}) {
  const customerKeepMs = limits.customerPartKeepMinutes * MIN;
  const protectedShare = limits.uploadProtectedBytesPerHolder;
  const byHolder = new Map();
  const soft = new Map();
  const add = (map, holder, item) => { if (!map.has(holder)) map.set(holder, []); map.get(holder).push(item); };
  let nextMatureAt = Infinity;
  const sparedUntil = (at) => { if (at > now && at < nextMatureAt) nextMatureAt = at; };
  for (const p of models.partsDB.rowSizes()) {
    if (refs.partsHard.has(p.id)) continue;
    const created = time(p.createdAt) || 0;
    const spareMs = Math.max(graceMs, p.ownerId ? customerKeepMs : 0);
    if (now - created < spareMs) { sparedUntil(created + spareMs); continue; }
    const holder = rowRetention.holderOf(p.ownerId, p.clientTag);
    const item = { kind: "part", id: p.id, bytes: p.fileBytes, created };
    if (refs.partsProtected.has(p.id)) add(soft, holder, { ...item, rank: 2 });
    else add(byHolder, holder, { ...item, rank: refs.partsOnAnonymousDrafts.has(p.id) ? 1 : 0 });
  }
  for (const r of refs.softRequests) {
    if (!(r.drawingBytes > 0)) continue;
    if (now - r.created < graceMs) { sparedUntil(r.created + graceMs); continue; }
    add(soft, r.holder, { kind: "attachment", id: r.id, bytes: r.drawingBytes, created: r.created, rank: 2 });
  }
  // Of what a sender holds softly, its newest bytes up to the protected share stay.
  for (const [holder, items] of soft) {
    items.sort((x, y) => y.created - x.created);
    let kept = 0;
    for (const it of items) {
      if (kept + it.bytes <= protectedShare) { kept += it.bytes; continue; }
      add(byHolder, holder, it);
    }
  }
  for (const items of byHolder.values()) items.sort((x, y) => (x.rank - y.rank) || (x.created - y.created));
  return { chosen: levelDown(byHolder, need, 0), holders: byHolder.size, nextMatureAt: Number.isFinite(nextMatureAt) ? nextMatureAt : null };
}

/**
 * When removing what nobody paid for or answered was not enough: the unpaid orders (independent
 * re-review 2026-11-12, F-12).
 *
 * A file on an unpaid order whose payment page is still open is held outright, so that an order
 * cannot be paid for after its file has gone. That made "press pay and never pay" a way to hold the
 * store: thirteen accounts did it. So when the store is still over its line after everything softer
 * has been taken, unpaid card orders are CLOSED, from whoever holds the most bytes under them first:
 * the payment page is closed at Stripe (an order that turns out to be paid is settled and keeps its
 * files; one whose page cannot be confirmed closed is left alone), the order becomes "not paid,
 * closed", its quote is given back, and the buyer is emailed that nothing was charged. Its files are
 * then held softly, like a saved quote's, and the ordinary rules decide what goes.
 *
 * Never closed here: an order that was paid for or is being worked on, a firm-quote order, an order
 * the owner took by phone, an order flagged for the owner. Never removed afterwards: a file in its
 * first STORAGE_EVICT_MIN_AGE_MINUTES, a signed-in customer's part in its first
 * CUSTOMER_PART_KEEP_MINUTES, and each holder's protected share (UPLOAD_PROTECTED_MB_PER_HOLDER).
 *
 * Holders are taken one at a time, heaviest first, and the pass stops as soon as what may now be
 * removed covers the need: a customer with one unpaid order is the last to be touched.
 * @returns {Promise<{ closed: number, settled: number, left: number, plan: object|null, refs: object|null }>}
 */
async function relieveUnpaidOrders(models, { need, now = Date.now(), graceMs = limits.storageEvictMinAgeMinutes * MIN, sync = false } = {}) {
  const out = { closed: 0, settled: 0, left: 0, plan: null, refs: null, nextMatureAt: null };
  if (!(need > 0) || typeof models.ordersDB._query !== "function") return out;
  const waiting = models.ordersDB._query("SELECT id, user_id, client_tag, created_at FROM orders WHERE status = 'pending_payment' AND (rfq_id IS NULL OR rfq_id = '') AND (attention IS NULL OR attention = '') AND (payment_method IS NULL OR payment_method = 'card')");
  if (waiting.length === 0) return out;
  const candidate = new Map(waiting.map((o) => [o.id, o]));
  // What would still be held outright if every one of them were closed: a part that is ALSO on a paid
  // order or a request the shop has taken up frees nothing, and is not counted against its holder.
  const ifClosed = rowRetention.references(models, { now, treatAsSoft: new Set(candidate.keys()) });
  const customerKeepMs = limits.customerPartKeepMinutes * MIN;
  const freeable = new Map(); // part id → bytes, for parts closing could free now
  const matures = new Map();  // part id → when it stops being too new to remove
  for (const p of models.partsDB.rowSizes()) {
    if (ifClosed.partsHard.has(p.id)) continue;
    const created = time(p.createdAt) || 0;
    const keep = Math.max(graceMs, p.ownerId ? customerKeepMs : 0);
    if (now - created < keep) { matures.set(p.id, created + keep); continue; }
    freeable.set(p.id, p.fileBytes);
  }
  const holders = new Map(); // holder → { bytes, parts: Set, orders: [] }
  const ids = [...candidate.keys()];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const it of models.orderItemsDB._query(`SELECT order_id, part_id FROM order_items WHERE part_id IS NOT NULL AND order_id IN (${chunk.map(() => "?").join(", ")})`, chunk)) {
      const o = candidate.get(it.order_id);
      const holder = rowRetention.holderOf(o.user_id, o.client_tag);
      if (!holders.has(holder)) holders.set(holder, { bytes: 0, parts: new Set(), orders: new Map() });
      const h = holders.get(holder);
      h.orders.set(o.id, o);
      if (freeable.has(it.part_id) && !h.parts.has(it.part_id)) { h.parts.add(it.part_id); h.bytes += freeable.get(it.part_id); }
      // Too new to remove yet: the pass must look again when it stops being new, not after the
      // back-off (a flood's files are all a minute old when the first refusal asks for a pass).
      if (matures.has(it.part_id)) out.nextMatureAt = out.nextMatureAt == null ? matures.get(it.part_id) : Math.min(out.nextMatureAt, matures.get(it.part_id));
    }
  }
  const lifecycle = require("./orderLifecycle");
  const heaviest = [...holders.values()].filter((h) => h.bytes > 0).sort((x, y) => y.bytes - x.bytes);
  for (const h of heaviest) {
    for (const o of [...h.orders.values()].sort((x, y) => String(x.created_at || "").localeCompare(String(y.created_at || "")))) {
      let r;
      try { r = await lifecycle.closeUnderPressure(o.id); } catch (err) { r = { outcome: "busy" }; console.error(`Storage: could not close unpaid order ${String(o.id).slice(0, 8)}: ${err.code || err.name || "Error"}`); }
      if (r.outcome === "closed") out.closed++; else if (r.outcome === "paid") out.settled++; else out.left++;
    }
    if (!sync) await turn();
    // Is what may be removed now enough? Then nobody lighter is touched.
    out.refs = rowRetention.references(models, { now });
    out.plan = planStorageRelief(models, { need, now, refs: out.refs, graceMs });
    if (out.plan.chosen.reduce((sum, it) => sum + it.bytes, 0) >= need) break;
  }
  return out;
}

/**
 * Evict uploads until the folders are back under the warning line less a margin, taking from
 * whoever holds the most first. In pieces, like the database pass.
 * @returns {Promise<null | { removedUploads, removedDrafts, removedAttachments, closedUnpaidOrders, bytesBefore, bytesAfter }>}
 */
async function relieveStorage(models, opt = {}) {
  const g = guards();
  const now = opt.now || Date.now();
  const max = limits.storageMaxBytes;
  let bytesBefore = g.storage.scan();
  if (!opt.force && bytesBefore < max * limits.storageWarnFraction) return null;
  if (!opt.force && state.storageQuietUntil > Date.now()) return null;
  // Cheapest first: uploads on disk that no part row names at all.
  if (sweepOrphanUploads(models, { now }).removed > 0) bytesBefore = g.storage.scan();
  const target = max * Math.max(0.1, limits.storageWarnFraction - 0.15);
  const refs = rowRetention.references(models, { now });
  const plan = planStorageRelief(models, { need: bytesBefore - target, now, refs, ...(opt.minAgeMs !== undefined ? { graceMs: opt.minAgeMs } : {}) });
  if (!opt.sync) await turn();

  let removedUploads = 0;
  let removedAttachments = 0;
  const removedDraftIds = new Set();
  const evict = async (chosen, from) => {
    const draftsByPart = new Map();
    for (const d of from.drafts) for (const id of d.partIds) { if (!draftsByPart.has(id)) draftsByPart.set(id, []); draftsByPart.get(id).push(d.id); }
    await inPieces(chosen, (it) => {
      if (it.kind === "attachment") {
        if (deleteRequestAttachment(models, it.id).attachmentRemoved) removedAttachments++;
        return;
      }
      // A draft whose file is gone cannot be priced or ordered: it goes with the file.
      for (const quoteId of draftsByPart.get(it.id) || []) {
        if (!removedDraftIds.has(quoteId)) { removedDraftIds.add(quoteId); models.quotesDB.delete(quoteId); }
      }
      const row = models.partsDB.getRow(it.id);
      if (row) { evictPart(models, row); removedUploads++; }
    }, opt);
  };
  await evict(plan.chosen, refs);
  // Still over the line: what is left is held by unpaid orders. They are closed, heaviest holder
  // first (the payment page closed at Stripe before anything is touched, the buyer told), and what
  // that leaves softly held goes by the same rules as above.
  // Only when the store is still at or over the line where a visitor is turned away
  // (UPLOAD_DIR_RESERVED_PERCENT, 85 %), and only until it is a little under the line at which the
  // clean-up starts (80 %, less 5 points so the next upload does not start it again): unpaid orders
  // are not closed to make room nobody is waiting for.
  let closedUnpaidOrders = 0;
  const freedSoFar = plan.chosen.reduce((sum, it) => sum + it.bytes, 0);
  const leftAfter = bytesBefore - freedSoFar;
  const stillNeeded = leftAfter >= max * (1 - limits.storageReservedFraction) ? leftAfter - max * Math.max(0.1, limits.storageWarnFraction - 0.05) : 0;
  if (stillNeeded > 0) {
    const unpaid = await relieveUnpaidOrders(models, { need: stillNeeded, now, sync: opt.sync, ...(opt.minAgeMs !== undefined ? { graceMs: opt.minAgeMs } : {}) });
    closedUnpaidOrders = unpaid.closed;
    if (unpaid.plan && unpaid.plan.chosen.length) await evict(unpaid.plan.chosen, unpaid.refs);
    for (const at of [unpaid.plan ? unpaid.plan.nextMatureAt : null, unpaid.nextMatureAt]) {
      if (at != null) plan.nextMatureAt = plan.nextMatureAt == null ? at : Math.min(plan.nextMatureAt, at);
    }
    if (unpaid.closed || unpaid.settled) console.warn(`File storage: ${unpaid.closed} unpaid order(s) closed to make room, from whoever held the most first (each buyer was emailed; nothing was charged)${unpaid.settled ? `; ${unpaid.settled} turned out to be paid and were settled` : ""}${unpaid.left ? `; ${unpaid.left} left as they were` : ""}.`);
  }
  if (removedUploads || removedAttachments) { const database = opt.database || require("../models/database"); if (database.flush) database.flush(); }
  g.storage.invalidate();
  const bytesAfter = g.storage.scan();
  const result = { removedUploads, removedDrafts: removedDraftIds.size, removedAttachments, closedUnpaidOrders, bytesBefore, bytesAfter };
  state.lastStorageRelief = { at: new Date(now).toISOString(), ...result };
  if (removedUploads || removedAttachments) console.warn(`File storage at ${Math.round((bytesBefore / max) * 100)}% of its ceiling: removed ${removedUploads} upload(s) and ${removedAttachments} request attachment(s) that nothing paid for or answered refers to, from whoever held the most first; ${mb(bytesBefore)} MB → ${mb(bytesAfter)} MB.`);
  else state.storageQuietUntil = quietUntil(plan.nextMatureAt, now);
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
async function tick(models, opt = {}) {
  if (state.running) return;
  state.running = true;
  try {
    if (models.USE_SQLITE !== false) await relieveDatabase(models, opt);
    await relieveStorage(models, opt);
  } catch (err) {
    console.error("Storage pressure check failed:", err.message);
  } finally {
    state.running = false;
  }
}

/**
 * Ask for a pass soon: after a row was added, or after a request was refused because a line was
 * crossed (a refused upload AND a refused new quote). At most one every 20 seconds, and a pass that
 * found nothing to remove is not repeated for PRESSURE_BACKOFF_MINUTES (the passes check that).
 */
function nudge(models) {
  const now = Date.now();
  if (now - state.nudgedAt < 20 * 1000) return;
  state.nudgedAt = now;
  const t = setTimeout(() => { tick(models).catch(() => {}); }, 50);
  if (t.unref) t.unref();
}

/** Start the periodic passes: pressure every 5 minutes, the slow sweeps at startup and hourly. */
function start(models, opt = {}) {
  const slow = () => {
    try { sweepOrphanUploads(models); sweepClosedRequestAttachments(models); } catch (err) { console.error("Storage sweep failed:", err.message); }
  };
  slow();
  tick(models).catch(() => {});
  const fast = setInterval(() => { tick(models).catch(() => {}); }, opt.intervalMs || 5 * MIN);
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
  relieveDatabase, relieveStorage, relieveUnpaidOrders, relieveUnpaidOrderLines, lapsedOrderLines, clearOrderLines, purgeAnonymousDrafts, planDatabaseRelief, planStorageRelief, levelFor, levelDown,
  sweepOrphanUploads, sweepClosedRequestAttachments,
  deleteRequest, deleteRequestAttachment,
  tick, nudge, start, status, state,
};
