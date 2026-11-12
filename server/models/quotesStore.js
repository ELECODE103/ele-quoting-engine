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
 *   H3). The lines are now stored as their JSON, deflated:
 *
 *       { "$lines": 2, "n": 100, "z": "<base64>" }
 *
 *   (100 lines that all differ: 282 kB of JSON, 14 kB stored.) Reading gives
 *   back exactly the array that was stored — same lines, same order, same
 *   values — so nothing that reads a quote changes. A line refers to its part
 *   by id; no geometry or DFM is copied into a quote. The quote's
 *   configuration (the buyer's inputs, 180 bytes a line) is stored the same way.
 *
 * Rows written before this (a plain array, or the 2026-11-11 pooled form
 * `{ "$lines": 1, pool, use }`) read as they always did.
 *
 * Beside each row: which client made it (client_tag) and which parts it names
 * (part_ids), so a sender's stored bytes and "what refers to this part" are
 * SQL, not a pass over every quote's lines (meta(), draftBytesHeld()).
 *
 * Also here: summaries() — the admin list's columns without loading every
 * quote's lines — and touchOpened() for the "was this draft ever reopened"
 * mark that retention reads.
 */
const zlib = require("zlib");

const FORMAT = 1;        // { $lines: 1, pool, use }: rows written 2026-11-11 (read, no longer written)
const COMPRESSED = 2;    // { $lines: 2, n, z }: the lines as JSON, deflated, base64
const COMPRESS_FROM = 600; // bytes of JSON below which compressing gains nothing worth having

/**
 * Lines → what is stored. Since the re-review of 2026-11-12 (RR-01): the lines' JSON, deflated.
 * Pooling identical lines (format 1) only helped when lines were byte-for-byte equal; a quote of
 * 100 lines that differ in quantity was still 282 kB. Deflated it is about 14 kB, whatever differs,
 * because what repeats between lines (every key, the cost build-up's wording, the break table)
 * is most of a line. Nothing is dropped: reading gives back exactly the array that was stored.
 */
function packLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return lines;
  let json;
  try { json = JSON.stringify(lines); } catch { return lines; }
  if (json === undefined || json.length < COMPRESS_FROM) return lines;
  return { $lines: COMPRESSED, n: lines.length, z: zlib.deflateRawSync(json, { level: 6 }).toString("base64") };
}

/** What is stored → lines. Each line is its own object, as it was when stored. */
function unpackLines(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return stored;
  if (stored.$lines === COMPRESSED && typeof stored.z === "string") {
    try { return JSON.parse(zlib.inflateRawSync(Buffer.from(stored.z, "base64"), { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8")); } catch { return []; }
  }
  if (stored.$lines !== FORMAT || !Array.isArray(stored.pool) || !Array.isArray(stored.use)) return stored;
  const seen = new Set();
  return stored.use.map((at) => {
    const line = stored.pool[at];
    if (line === undefined) return null;
    if (!seen.has(at)) { seen.add(at); return line; }
    return typeof structuredClone === "function" ? structuredClone(line) : JSON.parse(JSON.stringify(line));
  });
}

/** Any JSON value → itself, or `{ $z: 1, z }` when it is large (the quote's configuration: 180 bytes a line). */
function packValue(value) {
  if (value === null || typeof value !== "object" || value.$z) return value;
  let json;
  try { json = JSON.stringify(value); } catch { return value; }
  if (json === undefined || json.length < COMPRESS_FROM) return value;
  return { $z: 1, z: zlib.deflateRawSync(json, { level: 6 }).toString("base64") };
}

function unpackValue(stored) {
  if (!stored || typeof stored !== "object" || stored.$z !== 1 || typeof stored.z !== "string") return stored;
  try { return JSON.parse(zlib.inflateRawSync(Buffer.from(stored.z, "base64"), { maxOutputLength: 16 * 1024 * 1024 }).toString("utf8")); } catch { return null; }
}

/** The distinct part ids a quote names, from its configuration and its lines (as handed in, not as stored). */
function partIdsOf(record) {
  const ids = new Set();
  for (const c of (record && record.config && Array.isArray(record.config.parts) ? record.config.parts : [])) if (c && typeof c.partId === "string") ids.add(c.partId);
  for (const li of (record && Array.isArray(record.lineItems) ? record.lineItems : [])) if (li && typeof li.partId === "string") ids.add(li.partId);
  return [...ids];
}

/** SQL for the bytes a quote row takes (its JSON columns and notes; the fixed columns are a few hundred bytes). */
const ROW_BYTES_SQL = "(300 + COALESCE(LENGTH(CAST(line_items_json AS BLOB)), 0) + COALESCE(LENGTH(CAST(config_json AS BLOB)), 0) + COALESCE(LENGTH(CAST(gate_json AS BLOB)), 0) + COALESCE(LENGTH(CAST(notes AS BLOB)), 0))";

class QuotesStore {
  constructor(table) {
    this.table = table;
    this.tableName = table.tableName;
  }

  _pack(record) {
    if (!record) return record;
    const has = (k) => Object.prototype.hasOwnProperty.call(record, k);
    if (!has("lineItems") && !has("config")) return record;
    const out = { ...record };
    // Which parts the quote names, beside the row: what retention and the pressure pass ask, without opening the lines.
    if (has("lineItems") && has("config")) out.partIds = partIdsOf(record).join(",");
    if (has("lineItems")) out.lineItems = packLines(record.lineItems);
    if (has("config")) out.config = packValue(record.config);
    return out;
  }

  _unpack(row) {
    if (!row) return row;
    const lines = row.lineItems;
    const packedLines = lines !== undefined && lines !== null && !Array.isArray(lines);
    const packedConfig = row.config && typeof row.config === "object" && row.config.$z === 1;
    if (!packedLines && !packedConfig) return row;
    const out = { ...row };
    if (packedLines) out.lineItems = unpackLines(lines);
    if (packedConfig) out.config = unpackValue(row.config);
    return out;
  }

  /** Bytes this record would take as stored (its packed JSON columns and notes): what a sender's draft allowance counts. */
  sizeOf(record) {
    const packed = this._pack(record) || {};
    let n = 300;
    for (const key of ["lineItems", "config", "gate"]) {
      if (packed[key] === undefined || packed[key] === null) continue;
      try { n += Buffer.byteLength(JSON.stringify(packed[key]), "utf8"); } catch { /* not counted */ }
    }
    return n + Buffer.byteLength(String(packed.notes || ""), "utf8");
  }

  /** Bytes the stored row `id` takes now (0 when there is none). */
  rowBytes(id) {
    if (typeof this.table._query === "function") {
      const rows = this.table._query(`SELECT ${ROW_BYTES_SQL} AS n FROM ${this.tableName} WHERE id = ?`, [id]);
      return rows.length ? Number(rows[0].n) || 0 : 0;
    }
    const row = this.table.getById(id);
    return row ? this.sizeOf(this._unpack(row)) : 0;
  }

  /**
   * Bytes of DRAFT quotes a sender holds: by client tag, by account, or both (two numbers).
   * `exceptId` leaves one row out (the one about to be replaced by a re-price).
   * @returns {{ client: number, account: number }}
   */
  draftBytesHeld({ clientTag = "", userId = "", exceptId = "" } = {}) {
    const out = { client: 0, account: 0 };
    if (typeof this.table._query === "function") {
      if (clientTag) out.client = Number(this.table._query(`SELECT COALESCE(SUM(${ROW_BYTES_SQL}), 0) AS n FROM ${this.tableName} WHERE status = 'draft' AND client_tag = ? AND id != ?`, [clientTag, exceptId])[0].n) || 0;
      if (userId) out.account = Number(this.table._query(`SELECT COALESCE(SUM(${ROW_BYTES_SQL}), 0) AS n FROM ${this.tableName} WHERE status = 'draft' AND user_id = ? AND id != ?`, [userId, exceptId])[0].n) || 0;
      return out;
    }
    for (const q of this.table.getAll()) {
      if ((q.status && q.status !== "draft") || q.id === exceptId) continue;
      const bytes = this.sizeOf(this._unpack(q));
      if (clientTag && q.clientTag === clientTag) out.client += bytes;
      if (userId && q.userId === userId) out.account += bytes;
    }
    return out;
  }

  /**
   * A client's own no-account drafts that no order or request came from, longest-untouched first:
   * what may make room when that client is at its allowance.
   * @returns {Array<{ id, bytes, touched: string }>}
   */
  ownAnonymousDrafts(clientTag) {
    if (!clientTag || typeof this.table._query !== "function") return [];
    return this.table._query(
      `SELECT id, ${ROW_BYTES_SQL} AS bytes, COALESCE(updated_at, created_at) AS touched FROM ${this.tableName}
        WHERE status = 'draft' AND client_tag = ? AND (user_id IS NULL OR user_id = '')
          AND id NOT IN (SELECT quote_id FROM orders WHERE quote_id IS NOT NULL)
          AND id NOT IN (SELECT quote_id FROM rfqs WHERE quote_id IS NOT NULL)
        ORDER BY touched ASC`, [clientTag]).map((r) => ({ id: r.id, bytes: Number(r.bytes) || 0, touched: r.touched }));
  }

  /**
   * One light row per quote for retention and the pressure pass: ids, dates, who holds it, how big
   * it is and which parts it names. No lines are read or parsed (rows written before part ids were
   * kept beside the row are the exception: theirs are worked out here, and written back).
   * @returns {Array<{ id, userId, clientTag, status, createdAt, updatedAt, expiresAt, lastOpenedAt, bytes, partIds: string[] }>}
   */
  meta() {
    if (typeof this.table._query !== "function") {
      return this.table.getAll().map((q) => {
        const full = this._unpack(q);
        return { id: q.id, userId: q.userId || "", clientTag: q.clientTag || "", status: q.status || "draft", createdAt: q.createdAt, updatedAt: q.updatedAt, expiresAt: q.expiresAt, lastOpenedAt: q.lastOpenedAt, bytes: this.sizeOf(full), partIds: partIdsOf(full) };
      });
    }
    const rows = this.table._query(`SELECT id, user_id, client_tag, status, created_at, updated_at, expires_at, last_opened_at, part_ids, ${ROW_BYTES_SQL} AS bytes FROM ${this.tableName}`);
    const older = []; // rows from before part ids were kept beside the row
    const out = rows.map((r) => {
      let partIds;
      if (r.part_ids === null || r.part_ids === undefined) {
        // Read it once, and note its part ids so it is never read for this again.
        partIds = partIdsOf(this.getById(r.id));
        older.push([partIds.join(","), r.id]);
      } else {
        partIds = r.part_ids ? String(r.part_ids).split(",") : [];
      }
      return { id: r.id, userId: r.user_id || "", clientTag: r.client_tag || "", status: r.status || "draft", createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at, lastOpenedAt: r.last_opened_at, bytes: Number(r.bytes) || 300, partIds };
    });
    if (older.length && typeof this.table._run === "function") {
      // One save for all of them, and it may wait for the next one.
      require("./database").deferred(() => { for (const args of older) this.table._run(`UPDATE ${this.tableName} SET part_ids = ? WHERE id = ?`, args); });
    }
    return out;
  }

  insert(record) {
    const row = this.table.insert(this._pack(record));
    // The caller gets its quote back with the lines and configuration it handed in.
    if (!row) return row;
    const out = { ...row };
    if (record && record.lineItems !== undefined) out.lineItems = record.lineItems;
    if (record && record.config !== undefined) out.config = record.config;
    return out;
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
  if (stored && typeof stored === "object" && stored.$lines === COMPRESSED) return unpackLines(stored) || [];
  if (stored && typeof stored === "object" && Array.isArray(stored.pool) && Array.isArray(stored.use)) return stored.use.map((at) => stored.pool[at]);
  return [];
}

module.exports = { QuotesStore, packLines, unpackLines, packValue, unpackValue, partIdsOf };
