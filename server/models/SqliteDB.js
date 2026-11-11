/**
 * Drop-in replacement for JsonDB that uses sql.js SQLite backend.
 * Exposes the exact same interface with JSON column auto-serialization.
 */
const { getDatabase, saveToDisk } = require("./database");
const { randomUUID: uuidv4 } = require("crypto"); // RFC 4122 v4, same format the uuid package produced

// Mapping of JS field names → SQLite JSON column names per table
const JSON_COLUMNS = {
  materials: { grades: "grades_json", thicknesses: "thicknesses_json", layerHeights: "layer_heights_json" },
  finishes: {},
  lead_times: {},
  pricing_rules: { rules: "rules_json" },
  quotes: { lineItems: "line_items_json", gate: "gate_json", config: "config_json" },
  parts: { geometry: "geometry_json", dfm: "dfm_json" },
  orders: {},
  order_items: { geometry: "geometry_json", dfm: "dfm_json", config: "config_json" },
  users: {},
  processes: { subProcesses: "sub_processes_json" },
  rfqs: { reasons: "reasons_json", parts: "parts_json" },
  pricing_audit: { diff: "diff_json", rules: "rules_json" },
};

// Map camelCase JS names → snake_case SQL column names
const FIELD_TO_COLUMN = {
  createdAt: "created_at",
  updatedAt: "updated_at",
  passwordHash: "password_hash",
  userId: "user_id",
  quoteId: "quote_id",
  orderId: "order_id",
  partId: "part_id",
  fileName: "file_name",
  storedName: "stored_name",
  filePath: "file_path",
  fileSize: "file_size",
  materialSlug: "material_slug",
  materialName: "material_name",
  finishSlug: "finish_slug",
  finishName: "finish_name",
  unitPrice: "unit_price",
  lineTotal: "line_total",
  thicknessMm: "thickness_mm",
  subProcess: "sub_process",
  layerHeight: "layer_height",
  shippingName: "shipping_name",
  shippingAddress: "shipping_address",
  shippingCity: "shipping_city",
  shippingState: "shipping_state",
  shippingZip: "shipping_zip",
  shippingCountry: "shipping_country",
  shippingMethod: "shipping_method",
  shippingCost: "shipping_cost",
  stripePaymentId: "stripe_payment_id",
  stripeSessionId: "stripe_session_id",
  trackingNumber: "tracking_number",
  shippedAt: "shipped_at",
  leadTimeSlug: "lead_time_slug",
  leadTimeMultiplier: "lead_time_multiplier",
  orderTotal: "order_total",
  daysMin: "days_min",
  daysMax: "days_max",
  costPerKg: "cost_per_kg",
  costPerDm2: "cost_per_dm2",
  minCost: "min_cost",
  leadDays: "lead_days",
  pricePerKg: "price_per_kg",
  pricePerCm3: "price_per_cm3",
  defaultLayerHeight: "default_layer_height",
  pricePerPart: "price_per_part",
  pricePerSqIn: "price_per_sq_in",
  feedClass: "feed_class",
  contactName: "contact_name",
  finishNotes: "finish_notes",
  dueDate: "due_date",
  drawingFileName: "drawing_file_name",
  drawingPath: "drawing_path",
  budgetTotal: "budget_total",
  quotedAt: "quoted_at",
  quotedTotal: "quoted_total",
  userEmail: "user_email",
  actualMinutes: "actual_minutes",
  actualNotes: "actual_notes",
  actualRecordedAt: "actual_recorded_at",
  expiresAt: "expires_at",
  leadTimeSurcharge: "lead_time_surcharge",
  shippingEstimate: "shipping_estimate",
  customerEmail: "customer_email",
  customerName: "customer_name",
  leadTimeName: "lead_time_name",
  shipBy: "ship_by",
  paidAt: "paid_at",
  paymentMethod: "payment_method",
  poNumber: "po_number",
  rfqId: "rfq_id",
  customerNotes: "customer_notes",
  quotedLeadDays: "quoted_lead_days",
  quoteNote: "quote_note",
  validUntil: "valid_until",
  quoteSentAt: "quote_sent_at",
  acceptedAt: "accepted_at",
  acceptedVia: "accepted_via",
  paperworkFee: "paperwork_fee",
  requestType: "request_type",
  returnPart: "return_part",
};

// 0/1 columns that read back as booleans (SQLite has no boolean type).
const BOOLEAN_COLUMNS = new Set(["active", "paperwork", "return_part"]);

// Reverse mapping for deserialization
const COLUMN_TO_FIELD = {};
for (const [k, v] of Object.entries(FIELD_TO_COLUMN)) {
  COLUMN_TO_FIELD[v] = k;
}

// Table and column names are the only parts of a statement that are not bound
// parameters, so they are held to a plain identifier shape and to names this
// module knows. Values always go through `?` placeholders.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;

/** A value sql.js can bind: string, number, null or bytes. Anything else is stored as JSON text, never passed raw. */
function toSqlValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // SQLite text ends at the first NUL byte: "owner@shop.test\0.example" would be stored as
  // "owner@shop.test". A string must be stored whole or not at all, so NULs are removed, never truncated at.
  if (typeof value === "string") return value.indexOf("\u0000") === -1 ? value : value.replace(/\u0000/g, "");
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return value;
  if (typeof value === "object") { try { return JSON.stringify(value); } catch { return null; } }
  return null; // functions, symbols
}

/** An id as a bindable value, or null for anything that cannot be one (an object or array from a request body). */
function idValue(id) {
  if (typeof id === "string") return id.length <= 128 && id.indexOf("\u0000") === -1 ? id : null;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  return null;
}

class SqliteDB {
  constructor(tableName) {
    if (!IDENTIFIER.test(String(tableName)) || !Object.prototype.hasOwnProperty.call(JSON_COLUMNS, tableName)) {
      throw new Error(`SqliteDB: unknown table "${String(tableName).slice(0, 40)}"`);
    }
    this.tableName = tableName;
    this.jsonMappings = JSON_COLUMNS[tableName] || {};
    this._columnCache = null;
  }

  _db() {
    return getDatabase();
  }

  /**
   * Get the set of valid column names for this table.
   */
  _getColumns() {
    if (this._columnCache) return this._columnCache;
    const db = this._db();
    if (!db) return new Set();
    try {
      const stmt = db.prepare(`PRAGMA table_info(${this.tableName})`);
      const cols = new Set();
      while (stmt.step()) {
        const row = stmt.getAsObject();
        cols.add(row.name);
      }
      stmt.free();
      this._columnCache = cols;
      return cols;
    } catch {
      return new Set();
    }
  }

  /**
   * Filter a serialized record to only include valid table columns.
   * Unknown fields are stored as JSON in a catch-all approach.
   */
  _filterColumns(serialized) {
    const validCols = this._getColumns();
    // Column names are interpolated into the statement, so only names the
    // table really has may pass. If the table's columns cannot be read, nothing
    // passes (fail closed) rather than everything.
    const filtered = {};
    for (const [key, value] of Object.entries(serialized)) {
      if (validCols.has(key) && IDENTIFIER.test(key)) {
        filtered[key] = value;
      }
      // silently skip unknown columns
    }
    return filtered;
  }

  /**
   * Convert a JS record object to SQL-compatible column names and values.
   * Serializes JSON fields and maps camelCase to snake_case.
   */
  _serialize(record) {
    const result = {};
    for (const [key, value] of Object.entries(record)) {
      // Check if this is a JSON field
      if (this.jsonMappings[key]) {
        result[this.jsonMappings[key]] = JSON.stringify(value);
        continue;
      }
      // Map camelCase to snake_case
      const colName = Object.prototype.hasOwnProperty.call(FIELD_TO_COLUMN, key) ? FIELD_TO_COLUMN[key] : key;
      // Booleans become 0/1; objects and arrays in a plain column become JSON text;
      // nothing that sql.js cannot bind is ever handed to it.
      result[colName] = toSqlValue(value);
    }
    return result;
  }

  /**
   * Convert a SQL row back to a JS object with camelCase keys and parsed JSON.
   */
  _deserialize(row) {
    if (!row) return null;
    const result = {};

    for (const [col, value] of Object.entries(row)) {
      // Check if this is a JSON column that should be deserialized
      let handled = false;
      for (const [fieldName, jsonCol] of Object.entries(this.jsonMappings)) {
        if (col === jsonCol) {
          try {
            result[fieldName] = value ? JSON.parse(value) : null;
          } catch {
            result[fieldName] = value;
          }
          handled = true;
          break;
        }
      }
      if (handled) continue;

      // Map snake_case back to camelCase
      const fieldName = COLUMN_TO_FIELD[col] || col;
      // Convert 0/1 flag columns back to booleans (NULL on a row written before the column existed reads as false)
      if (BOOLEAN_COLUMNS.has(col)) {
        result[fieldName] = value === 1 || value === true;
      } else {
        result[fieldName] = value;
      }
    }
    return result;
  }

  /**
   * Execute a SELECT and return rows as JS objects.
   */
  _query(sql, params = []) {
    const db = this._db();
    if (!db) return [];
    try {
      const stmt = db.prepare(sql);
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    } catch (err) {
      console.error(`SqliteDB query error [${this.tableName}]:`, err.message);
      return [];
    }
  }

  /**
   * Execute a write statement (INSERT, UPDATE, DELETE).
   */
  _run(sql, params = []) {
    const db = this._db();
    if (!db) return 0;
    try {
      db.run(sql, params);
      saveToDisk();
      return db.getRowsModified();
    } catch (err) {
      console.error(`SqliteDB run error [${this.tableName}]:`, err.message);
      return 0;
    }
  }

  getAll() {
    const rows = this._query(`SELECT * FROM ${this.tableName}`);
    return rows.map((r) => this._deserialize(r));
  }

  getById(id) {
    const key = idValue(id);
    if (key === null) return null;
    const rows = this._query(`SELECT * FROM ${this.tableName} WHERE id = ?`, [key]);
    return rows.length > 0 ? this._deserialize(rows[0]) : null;
  }

  query(filterFn) {
    return this.getAll().filter(filterFn);
  }

  insert(record) {
    const now = new Date().toISOString();
    const full = {
      id: uuidv4(),
      createdAt: now,
      ...record,
    };
    if (idValue(full.id) === null) full.id = uuidv4();
    const serialized = this._filterColumns(this._serialize(full));
    const columns = Object.keys(serialized);
    if (columns.length === 0) return full;
    const placeholders = columns.map(() => "?").join(", ");
    const values = columns.map((c) => serialized[c]);

    this._run(
      `INSERT INTO ${this.tableName} (${columns.join(", ")}) VALUES (${placeholders})`,
      values
    );

    return this._deserialize({ ...serialized, id: full.id });
  }

  update(id, updates) {
    if (idValue(id) === null) return null;
    const now = new Date().toISOString();
    const updateData = { ...updates, updatedAt: now };
    const serialized = this._filterColumns(this._serialize(updateData));
    const columns = Object.keys(serialized);
    if (columns.length === 0) return this.getById(id);
    const setClauses = columns.map((col) => `${col} = ?`).join(", ");
    const values = [...Object.values(serialized), id];

    this._run(`UPDATE ${this.tableName} SET ${setClauses} WHERE id = ?`, values);
    return this.getById(id);
  }

  delete(id) {
    if (idValue(id) === null) return false;
    const changed = this._run(`DELETE FROM ${this.tableName} WHERE id = ?`, [id]);
    return changed > 0;
  }

  upsert(matchFn, record) {
    const existing = this.getAll().find(matchFn);
    if (existing) {
      return this.update(existing.id, record);
    }
    return this.insert(record);
  }

  clear() {
    this._run(`DELETE FROM ${this.tableName}`);
  }
}

module.exports = { SqliteDB, IDENTIFIER, toSqlValue };
