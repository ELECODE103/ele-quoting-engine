/**
 * Drop-in replacement for JsonDB that uses sql.js SQLite backend.
 * Exposes the exact same interface with JSON column auto-serialization.
 */
const { getDatabase, saveToDisk } = require("./database");
const { v4: uuidv4 } = require("uuid");

// Mapping of JS field names → SQLite JSON column names per table
const JSON_COLUMNS = {
  materials: { grades: "grades_json", thicknesses: "thicknesses_json" },
  finishes: {},
  lead_times: {},
  pricing_rules: { rules: "rules_json" },
  quotes: { lineItems: "line_items_json" },
  parts: { geometry: "geometry_json", dfm: "dfm_json" },
  orders: {},
  order_items: { geometry: "geometry_json", dfm: "dfm_json" },
  users: {},
  processes: { subProcesses: "sub_processes_json" },
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
  leadTimeSlug: "lead_time_slug",
  leadTimeMultiplier: "lead_time_multiplier",
  orderTotal: "order_total",
  daysMin: "days_min",
  daysMax: "days_max",
  costPerKg: "cost_per_kg",
  costPerDm2: "cost_per_dm2",
  minCost: "min_cost",
  leadDays: "lead_days",
};

// Reverse mapping for deserialization
const COLUMN_TO_FIELD = {};
for (const [k, v] of Object.entries(FIELD_TO_COLUMN)) {
  COLUMN_TO_FIELD[v] = k;
}

class SqliteDB {
  constructor(tableName) {
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
    if (validCols.size === 0) return serialized; // fallback: don't filter
    const filtered = {};
    for (const [key, value] of Object.entries(serialized)) {
      if (validCols.has(key)) {
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
      const colName = FIELD_TO_COLUMN[key] || key;
      // Convert booleans to integers for SQLite
      if (typeof value === "boolean") {
        result[colName] = value ? 1 : 0;
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        // Unknown nested objects get JSON-stringified
        result[colName] = JSON.stringify(value);
      } else {
        result[colName] = value;
      }
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
      // Convert 'active' integer back to boolean
      if (col === "active") {
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
    const rows = this._query(`SELECT * FROM ${this.tableName} WHERE id = ?`, [id]);
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

module.exports = { SqliteDB };
