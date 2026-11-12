/**
 * The parts table, with each part's large payloads kept in files.
 *
 * Wraps the plain table (SqliteDB or JsonDB) and keeps its interface, so the
 * routes and services go on calling partsDB.insert / getById / update /
 * delete. What changes is where the bytes live (see models/partPayloads.js):
 *
 *   insert / update   the geometry is split: scalars and small detail go in the
 *                     row, a large preview mesh and large geometry detail go to
 *                     files (written first, so a row never points at a file
 *                     that is not there). `meshBytes` / `detailBytes` on the row
 *                     say what was written.
 *   getById           gives back the geometry pricing and DFM have always had:
 *                     complete, in the same key order, minus the preview mesh's
 *                     vertex list (which only reopening a quote needs —
 *                     ask for it with `{ mesh: true }`). If a file the row
 *                     needs cannot be read, the part comes back with
 *                     `payloadError` set and the caller must not price it.
 *   getAll / query    the rows as stored: enough for lists, counts and sweeps;
 *                     no mesh, and no large detail for the few parts that have
 *                     it in a file.
 *   delete            the row, then its files.
 *
 * Rows written before this (the mesh inline in the row) read exactly as they
 * always did; the startup migration (partPayloadMigration.js) moves them.
 */
const { randomUUID } = require("crypto");
const payloads = require("./partPayloads");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PartsStore {
  constructor(table) {
    this.table = table;
    this.tableName = table.tableName;
    this._logged = new Set();
  }

  /** Write the files for a geometry and return the row's version of it with the sizes written. */
  _store(id, geometry, opt) {
    const { row, meshJson, geometryJson } = payloads.split(geometry);
    const written = [];
    let meshBytes = 0;
    let detailBytes = 0;
    try {
      if (meshJson !== null) { meshBytes = payloads.write(id, "mesh", meshJson, opt); written.push("mesh"); }
      if (geometryJson !== null) { detailBytes = payloads.write(id, "geometry", geometryJson, opt); written.push("geometry"); }
    } catch (err) {
      for (const kind of written) payloads.remove(id, kind); // all or nothing
      throw err;
    }
    // A kind this geometry no longer has (a DXF re-read at another scale can shrink) leaves no stale file.
    if (meshJson === null) payloads.remove(id, "mesh");
    if (geometryJson === null) payloads.remove(id, "geometry");
    return { geometry: row, meshBytes, detailBytes };
  }

  /**
   * @throws {payloads.PayloadError} storage-full / write-failed: nothing was stored
   */
  insert(record) {
    const id = typeof record.id === "string" && UUID.test(record.id) ? record.id : randomUUID();
    const hasGeometry = record.geometry && typeof record.geometry === "object";
    const stored = hasGeometry ? this._store(id, record.geometry) : { geometry: record.geometry, meshBytes: 0, detailBytes: 0 };
    const row = this.table.insert({ ...record, id, geometry: stored.geometry, meshBytes: stored.meshBytes, detailBytes: stored.detailBytes });
    // The caller gets its part back with the geometry it handed in (as an insert always answered).
    return { ...row, geometry: record.geometry };
  }

  update(id, updates) {
    if (!updates || !Object.prototype.hasOwnProperty.call(updates, "geometry")) {
      const row = this.table.update(id, updates);
      return row ? this._hydrate(row) : row;
    }
    if (!this.table.getById(id)) return null;
    const stored = updates.geometry && typeof updates.geometry === "object" ? this._store(id, updates.geometry) : { geometry: updates.geometry, meshBytes: 0, detailBytes: 0 };
    const row = this.table.update(id, { ...updates, geometry: stored.geometry, meshBytes: stored.meshBytes, detailBytes: stored.detailBytes });
    return row ? this._hydrate(row) : row;
  }

  /**
   * @param {{ mesh?: boolean }} [opt]  mesh: also load the preview mesh from its file
   */
  getById(id, opt = {}) {
    const row = this.table.getById(id);
    return row ? this._hydrate(row, opt) : null;
  }

  /**
   * The row as stored and nothing else: the summary geometry, `meshBytes` / `detailBytes`, no file
   * read. For callers that only need to know what a part is and where its large pieces are.
   */
  getRow(id) {
    return this.table.getById(id);
  }

  /** The stored file name of every part (for the sweep of uploads no part refers to). */
  storedNames() {
    if (typeof this.table._query === "function") {
      return this.table._query(`SELECT stored_name FROM ${this.tableName} WHERE stored_name IS NOT NULL`).map((r) => String(r.stored_name).split(/[\\/]/).pop());
    }
    return this.table.getAll().map((r) => String(r.storedName || "").split(/[\\/]/).pop()).filter(Boolean);
  }

  /**
   * One light row per part for retention and the pressure passes: who holds it, how big its row
   * is in the database and how many bytes of files it has. No row's contents are read.
   * @returns {Array<{ id, createdAt, clientTag, ownerId, storedName, bytes, fileBytes }>}
   */
  rowSizes() {
    if (typeof this.table._query === "function") {
      return this.table._query(`SELECT id, created_at, client_tag, owner_id, stored_name, 300 + COALESCE(OCTET_LENGTH(geometry_json), 0) + COALESCE(OCTET_LENGTH(dfm_json), 0) + COALESCE(LENGTH(file_name), 0) AS n, COALESCE(file_size, 0) + COALESCE(mesh_bytes, 0) + COALESCE(detail_bytes, 0) AS f FROM ${this.tableName}`)
        .map((r) => ({ id: r.id, createdAt: r.created_at, clientTag: r.client_tag || "", ownerId: r.owner_id || "", storedName: r.stored_name || "", bytes: Number(r.n) || 300, fileBytes: Number(r.f) || 0 }));
    }
    return this.table.getAll().map((r) => {
      let bytes = 300;
      try { bytes += JSON.stringify(r.geometry || "").length + JSON.stringify(r.dfm || "").length; } catch { /* not counted */ }
      return { id: r.id, createdAt: r.createdAt, clientTag: r.clientTag || "", ownerId: r.ownerId || "", storedName: r.storedName || "", bytes, fileBytes: (Number(r.fileSize) || 0) + (Number(r.meshBytes) || 0) + (Number(r.detailBytes) || 0) };
    });
  }

  /** Bytes stored for one client tag: uploads plus what was derived from them. */
  storedBytesFor(clientTag) {
    if (!clientTag) return 0;
    if (typeof this.table._query === "function") {
      const rows = this.table._query(`SELECT COALESCE(SUM(COALESCE(file_size, 0) + COALESCE(mesh_bytes, 0) + COALESCE(detail_bytes, 0)), 0) AS n FROM ${this.tableName} WHERE client_tag = ?`, [clientTag]);
      return rows.length ? Number(rows[0].n) || 0 : 0;
    }
    return this.table.getAll().filter((r) => r.clientTag === clientTag).reduce((sum, r) => sum + (Number(r.fileSize) || 0) + (Number(r.meshBytes) || 0) + (Number(r.detailBytes) || 0), 0);
  }

  /** The same for one account (parts uploaded while signed in to it). */
  storedBytesForOwner(ownerId) {
    if (!ownerId) return 0;
    if (typeof this.table._query === "function") {
      const rows = this.table._query(`SELECT COALESCE(SUM(COALESCE(file_size, 0) + COALESCE(mesh_bytes, 0) + COALESCE(detail_bytes, 0)), 0) AS n FROM ${this.tableName} WHERE owner_id = ?`, [ownerId]);
      return rows.length ? Number(rows[0].n) || 0 : 0;
    }
    return this.table.getAll().filter((r) => r.ownerId === ownerId).reduce((sum, r) => sum + (Number(r.fileSize) || 0) + (Number(r.meshBytes) || 0) + (Number(r.detailBytes) || 0), 0);
  }

  _hydrate(row, { mesh = false } = {}) {
    const out = { ...row };
    let geometry = row.geometry;
    if (Number(row.detailBytes) > 0) {
      try {
        geometry = payloads.readJson(row.id, "geometry");
      } catch (err) {
        out.payloadError = err.code || "unreadable";
        this._logOnce(row.id, "geometry", out.payloadError);
      }
    }
    if (mesh && Number(row.meshBytes) > 0 && geometry && typeof geometry === "object") {
      try {
        geometry = { ...geometry, meshData: payloads.readJson(row.id, "mesh") };
      } catch (err) {
        out.meshError = err.code || "unreadable";
        this._logOnce(row.id, "mesh", out.meshError);
      }
    }
    out.geometry = geometry;
    return out;
  }

  _logOnce(id, kind, code) {
    const key = `${id}:${kind}:${code}`;
    if (this._logged.has(key)) return;
    if (this._logged.size > 500) this._logged.clear();
    this._logged.add(key);
    console.error(`Part payload unreadable (${code}): the ${kind} file of part ${String(id).slice(0, 8)} could not be read${code === "no-key" || code === "wrong-key" ? " — see docs/security/file-encryption.md (NORD_FILE_ENC_KEY / NORD_FILE_ENC_KEY_PREVIOUS)" : ""}`);
  }

  getAll() {
    return this.table.getAll();
  }

  query(filterFn) {
    return this.table.query(filterFn);
  }

  delete(id) {
    const deleted = this.table.delete(id);
    // The files go with the row (and are cleared even if the row was already gone).
    if (typeof id === "string" && id) payloads.remove(id);
    return deleted;
  }

  upsert(matchFn, record) {
    const existing = this.table.getAll().find(matchFn);
    return existing ? this.update(existing.id, record) : this.insert(record);
  }

  clear() {
    const ids = this.table.getAll().map((r) => r.id);
    this.table.clear();
    for (const id of ids) payloads.remove(id);
  }

  /** Remove payload files no row accounts for. @returns {{removed:number, bytes:number}} */
  sweepPayloads(opt) {
    return payloads.sweep(this.table.getAll(), opt);
  }
}

module.exports = { PartsStore };
