/**
 * Simple JSON file-based database for the quoting platform.
 * In production, swap this for PostgreSQL/MySQL with the same interface.
 */
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const DATA_DIR = path.join(__dirname, "..", "..", "data");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadTable(name) {
  ensureDir();
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function saveTable(name, data) {
  ensureDir();
  const file = path.join(DATA_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

class JsonDB {
  constructor(tableName) {
    this.tableName = tableName;
  }

  getAll() {
    return loadTable(this.tableName);
  }

  getById(id) {
    return this.getAll().find((r) => r.id === id) || null;
  }

  query(filterFn) {
    return this.getAll().filter(filterFn);
  }

  insert(record) {
    const rows = this.getAll();
    const newRecord = { id: uuidv4(), createdAt: new Date().toISOString(), ...record };
    rows.push(newRecord);
    saveTable(this.tableName, rows);
    return newRecord;
  }

  update(id, updates) {
    const rows = this.getAll();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...updates, updatedAt: new Date().toISOString() };
    saveTable(this.tableName, rows);
    return rows[idx];
  }

  delete(id) {
    const rows = this.getAll();
    const filtered = rows.filter((r) => r.id !== id);
    if (filtered.length === rows.length) return false;
    saveTable(this.tableName, filtered);
    return true;
  }

  upsert(matchFn, record) {
    const rows = this.getAll();
    const idx = rows.findIndex(matchFn);
    if (idx >= 0) {
      rows[idx] = { ...rows[idx], ...record, updatedAt: new Date().toISOString() };
    } else {
      rows.push({ id: uuidv4(), createdAt: new Date().toISOString(), ...record });
    }
    saveTable(this.tableName, rows);
    return rows[idx >= 0 ? idx : rows.length - 1];
  }

  clear() {
    saveTable(this.tableName, []);
  }
}

module.exports = { JsonDB };
