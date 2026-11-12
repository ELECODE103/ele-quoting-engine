/**
 * The quotes table, with each quote's priced lines stored compactly.
 *
 * Wraps the plain table (SqliteDB or JsonDB) and keeps its interface, so the
 * routes go on calling quotesDB.insert / getById / update / getAll / query.
 * What changes is how the priced lines are kept in the row:
 *
 *   A priced line is about 3 kB (its price breakdown, cost build-up and
 *   quantity-break table). A quote stored one copy per line, so 100 lines of
 *   one part in one configuration was a 296 kB row for 3 kB of information,
 *   and 925 such quotes filled the database (independent review 2026-11-11,
 *   H3). Now every DISTINCT line is stored once, and the row lists which line
 *   goes where:
 *
 *       { "$lines": 1, "pool": [ line, line, … ], "use": [0, 0, 1, 0, …] }
 *
 *   Reading gives back exactly the array that was stored — same lines, same
 *   order, same values — so nothing that reads a quote changes. A line refers
 *   to its part by id; no geometry or DFM is copied into a quote.
 *
 * Rows written before this (a plain array) read as they always did.
 *
 * Also here: summaries() — the admin list's columns without loading every
 * quote's lines — and touchOpened() for the "was this draft ever reopened"
 * mark that retention reads.
 */
const FORMAT = 1;

/** Lines → the compact form (or the array itself when there is nothing to gain). */
function packLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return lines;
  const index = new Map(); // JSON text → pool position
  const pool = [];
  const use = [];
  for (const line of lines) {
    let key;
    try { key = JSON.stringify(line); } catch { return lines; }
    if (key === undefined) return lines;
    let at = index.get(key);
    if (at === undefined) { at = pool.length; index.set(key, at); pool.push(line); }
    use.push(at);
  }
  if (pool.length === lines.length) return lines; // every line is different: the array is already minimal
  return { $lines: FORMAT, pool, use };
}

/** The compact form → lines. Each line is its own object, as it was when stored. */
function unpackLines(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return stored;
  if (stored.$lines !== FORMAT || !Array.isArray(stored.pool) || !Array.isArray(stored.use)) return stored;
  const seen = new Set();
  return stored.use.map((at) => {
    const line = stored.pool[at];
    if (line === undefined) return null;
    if (!seen.has(at)) { seen.add(at); return line; }
    return typeof structuredClone === "function" ? structuredClone(line) : JSON.parse(JSON.stringify(line));
  });
}

class QuotesStore {
  constructor(table) {
    this.table = table;
    this.tableName = table.tableName;
  }

  _pack(record) {
    if (!record || !Object.prototype.hasOwnProperty.call(record, "lineItems")) return record;
    return { ...record, lineItems: packLines(record.lineItems) };
  }

  _unpack(row) {
    if (!row || row.lineItems === undefined || row.lineItems === null || Array.isArray(row.lineItems)) return row;
    return { ...row, lineItems: unpackLines(row.lineItems) };
  }

  insert(record) {
    const lines = record && record.lineItems;
    const row = this.table.insert(this._pack(record));
    // The caller gets its quote back with the lines it handed in.
    return row && lines !== undefined ? { ...row, lineItems: lines } : row;
  }

  update(id, updates) {
    return this._unpack(this.table.update(id, this._pack(updates)));
  }

  getById(id) {
    return this._unpack(this.table.getById(id));
  }

  getAll() {
    return this.table.getAll().map((r) => this._unpack(r));
  }

  query(filterFn) {
    return this.getAll().filter(filterFn);
  }

  delete(id) {
    return this.table.delete(id);
  }

  upsert(matchFn, record) {
    const existing = this.getAll().find(matchFn);
    return existing ? this.update(existing.id, record) : this.insert(record);
  }

  clear() {
    return this.table.clear();
  }

  /**
   * The newest quotes as the admin list shows them: the row's own columns, the
   * line and piece counts, and not the lines themselves.
   * @param {{ limit?: number }} [opt]
   */
  summaries({ limit = 200 } = {}) {
    const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
    const pick = (q, counts) => ({
      id: q.id, userId: q.userId || null, status: q.status, createdAt: q.createdAt, updatedAt: q.updatedAt || null,
      expiresAt: q.expiresAt || null, lastOpenedAt: q.lastOpenedAt || null,
      leadTimeSlug: q.leadTimeSlug, subtotal: q.subtotal, orderTotal: q.orderTotal,
      paperwork: Boolean(q.paperwork), paperworkFee: Number(q.paperworkFee) || 0,
      partCount: counts.partCount, totalUnits: counts.totalUnits,
    });
    const countsOf = (q) => {
      if (Number.isFinite(Number(q.partCount)) && q.partCount !== null && Number.isFinite(Number(q.totalUnits)) && q.totalUnits !== null) {
        return { partCount: Number(q.partCount), totalUnits: Number(q.totalUnits) };
      }
      const lines = unpackLinesLight(q.lineItems);
      return { partCount: lines.length, totalUnits: lines.reduce((sum, li) => sum + (Number(li && li.quantity) || 0), 0) };
    };
    if (typeof this.table._query === "function") {
      // SQLite: the newest n rows, without their config and gate blobs. The lines are read only for
      // rows written before the counts were stored.
      const rows = this.table._query(
        `SELECT id, user_id, status, created_at, updated_at, expires_at, last_opened_at, lead_time_slug, subtotal, order_total, paperwork, paperwork_fee, part_count, total_units,
                CASE WHEN part_count IS NULL THEN line_items_json ELSE NULL END AS line_items_json
           FROM ${this.tableName} ORDER BY created_at DESC LIMIT ?`, [n]);
      return rows.map((r) => this.table._deserialize(r)).map((q) => pick(q, countsOf(q)));
    }
    return this.table.getAll()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, n)
      .map((q) => pick(q, countsOf(q)));
  }

  /** How many quotes there are (for the admin list's "showing n of m"). */
  count() {
    if (typeof this.table._query === "function") {
      const rows = this.table._query(`SELECT COUNT(*) AS n FROM ${this.tableName}`);
      return rows.length ? Number(rows[0].n) || 0 : 0;
    }
    return this.table.getAll().length;
  }
}

/** Line count and quantities without cloning anything (for summaries of old rows). */
function unpackLinesLight(stored) {
  if (Array.isArray(stored)) return stored;
  if (stored && typeof stored === "object" && Array.isArray(stored.pool) && Array.isArray(stored.use)) return stored.use.map((at) => stored.pool[at]);
  return [];
}

module.exports = { QuotesStore, packLines, unpackLines };
