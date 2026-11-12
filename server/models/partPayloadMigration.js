/**
 * Moves part payloads out of the database (2026-11-11).
 *
 * Additive: two columns on `parts` (how many bytes of mesh and of geometry
 * detail are in files), and for every row that still carries its preview mesh
 * or oversized geometry inline, the payload is written to data/part-payloads
 * (models/partPayloads.js) and the row is rewritten without it.
 *
 * Runs inside database start-up, before anything is saved: the whole move is
 * one batch in memory, followed by VACUUM and a single write of the (much
 * smaller) file. Safe to interrupt and safe to repeat:
 *   - a payload file is on disk before its row is changed, and the changed
 *     rows are only written to the database file at the end, so a crash part
 *     way leaves the old database intact and the next start simply does it
 *     again (rewriting the same files);
 *   - a row whose file could not be written is left exactly as it was (its
 *     mesh still inline, still readable) and is tried again next start;
 *   - a row already done has `mesh_bytes` set and is skipped.
 */
const payloads = require("./partPayloads");

const COLUMNS = [
  ["mesh_bytes", "INTEGER"],    // bytes of preview mesh in data/part-payloads (0: none; NULL: row not migrated yet)
  ["detail_bytes", "INTEGER"],  // bytes of geometry detail in data/part-payloads (0: the row holds all of it)
];

// The only interpolated parts of the statements below are these constants; they
// are still checked against an identifier shape before use.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,63}$/;
const COLUMN_TYPES = new Set(["INTEGER", "TEXT", "REAL"]);
function vetted(table, name, type) {
  if (!IDENTIFIER.test(table) || (name !== undefined && !IDENTIFIER.test(name)) || (type !== undefined && !COLUMN_TYPES.has(type))) {
    throw new Error("partPayloadMigration: not a plain identifier");
  }
}

function columnsOf(db, table) {
  vetted(table);
  const cols = new Set();
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  while (stmt.step()) cols.add(stmt.getAsObject().name);
  stmt.free();
  return cols;
}

function addColumns(db) {
  const table = "parts";
  const have = columnsOf(db, table);
  const added = [];
  for (const [name, type] of COLUMNS) {
    if (have.has(name)) continue;
    vetted(table, name, type);
    db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    added.push(name);
  }
  return added;
}

/**
 * @param {object} db  the sql.js database
 * @returns {{columns: string[], examined: number, moved: number, meshFiles: number, geometryFiles: number, bytesMoved: number, failed: number, vacuumed: boolean}}
 */
function apply(db, { log = console.log, warn = console.warn } = {}) {
  const result = { columns: addColumns(db), examined: 0, moved: 0, meshFiles: 0, geometryFiles: 0, bytesMoved: 0, failed: 0, vacuumed: false, encryptedInline: 0 };
  // With a file-encryption key set, what an earlier start left inline (small meshes, small DXF
  // outlines) moves to encrypted files too. Runs before the first-time move below so the VACUUM
  // there, or the one here, gives the space back.
  const inline = moveInlineWhenEncrypted(db, { warn });
  result.encryptedInline = inline.moved;
  if (inline.moved > 0) {
    db.run("VACUUM");
    result.vacuumed = true;
    log(`  Part payloads: file encryption is on — moved the shape data of ${inline.moved} part(s) out of the database rows into encrypted files.`);
  }

  // Rows not yet looked at. Ids first: rows are rewritten while we go.
  const ids = [];
  const pending = db.prepare("SELECT id FROM parts WHERE mesh_bytes IS NULL");
  while (pending.step()) ids.push(pending.getAsObject().id);
  pending.free();
  if (ids.length === 0) return result;

  const select = db.prepare("SELECT geometry_json FROM parts WHERE id = ?");
  let firstFailure = null;
  for (const id of ids) {
    result.examined++;
    select.bind([id]);
    const json = select.step() ? select.getAsObject().geometry_json : null;
    select.reset();
    let geometry = null;
    if (typeof json === "string" && json) { try { geometry = JSON.parse(json); } catch { geometry = null; } }
    if (!geometry || typeof geometry !== "object") {
      // Nothing to move (no geometry, or text that is not JSON and is left untouched).
      db.run("UPDATE parts SET mesh_bytes = 0, detail_bytes = 0 WHERE id = ?", [id]);
      continue;
    }
    const { row, meshJson, geometryJson } = payloads.split(geometry);
    if (meshJson === null && geometryJson === null) {
      db.run("UPDATE parts SET mesh_bytes = 0, detail_bytes = 0 WHERE id = ?", [id]);
      continue;
    }
    const written = [];
    try {
      let meshBytes = 0;
      let detailBytes = 0;
      // The ceiling is not applied: these bytes are already on the volume, inside the database file.
      if (meshJson !== null) { meshBytes = payloads.write(id, "mesh", meshJson, { ceiling: false }); written.push("mesh"); }
      if (geometryJson !== null) { detailBytes = payloads.write(id, "geometry", geometryJson, { ceiling: false }); written.push("geometry"); }
      db.run("UPDATE parts SET geometry_json = ?, mesh_bytes = ?, detail_bytes = ? WHERE id = ?", [JSON.stringify(row), meshBytes, detailBytes, id]);
      result.moved++;
      if (meshJson !== null) result.meshFiles++;
      if (geometryJson !== null) result.geometryFiles++;
      result.bytesMoved += Buffer.byteLength(json, "utf8") - Buffer.byteLength(JSON.stringify(row), "utf8");
    } catch (err) {
      // Leave the row as it was: its payload is still inline and still works. Tried again next start.
      for (const kind of written) payloads.remove(id, kind);
      result.failed++;
      if (!firstFailure) firstFailure = err.code || err.message;
    }
  }
  select.free();

  if (result.moved > 0) {
    // Give the space back: without this the file keeps its size and only reuses the pages.
    db.run("VACUUM");
    result.vacuumed = true;
    log(`  Part payloads: moved ${result.meshFiles} preview mesh(es) and ${result.geometryFiles} geometry detail file(s) out of the database into data/part-payloads (${(result.bytesMoved / 1e6).toFixed(1)} MB of rows).`);
  }
  if (result.failed > 0) warn(`WARNING: ${result.failed} part(s) could not have their payloads moved out of the database (${firstFailure}). They still work from the row; the move is tried again at the next start.`);
  return result;
}

/**
 * File encryption is on: no outline, hole position or preview vertex stays in a database row (the
 * database file is not encrypted). Rows already migrated whose detail is still inline are split
 * again under the encrypted rule (models/partPayloads.js split()). Safe to repeat: a row that is
 * done has detail_bytes > 0 and is skipped; a row whose files could not be written is left as it was.
 */
function moveInlineWhenEncrypted(db, { warn = console.warn } = {}) {
  const out = { moved: 0, failed: 0 };
  if (!require("../services/fileCrypto").isEnabled()) return out;
  const ids = [];
  const pending = db.prepare("SELECT id FROM parts WHERE mesh_bytes IS NOT NULL AND COALESCE(detail_bytes, 0) = 0 AND geometry_json IS NOT NULL");
  while (pending.step()) ids.push(pending.getAsObject().id);
  pending.free();
  if (ids.length === 0) return out;
  const select = db.prepare("SELECT geometry_json, mesh_bytes FROM parts WHERE id = ?");
  for (const id of ids) {
    select.bind([id]);
    const found = select.step() ? select.getAsObject() : null;
    select.reset();
    let geometry = null;
    if (found && typeof found.geometry_json === "string" && found.geometry_json) { try { geometry = JSON.parse(found.geometry_json); } catch { geometry = null; } }
    if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) continue;
    const { row, meshJson, geometryJson } = payloads.split(geometry, { encrypted: true });
    if (meshJson === null && geometryJson === null) continue;
    const written = [];
    try {
      let meshBytes = Number(found.mesh_bytes) || 0;
      let detailBytes = 0;
      if (meshJson !== null) { meshBytes = payloads.write(id, "mesh", meshJson, { ceiling: false }); written.push("mesh"); }
      if (geometryJson !== null) { detailBytes = payloads.write(id, "geometry", geometryJson, { ceiling: false }); written.push("geometry"); }
      db.run("UPDATE parts SET geometry_json = ?, mesh_bytes = ?, detail_bytes = ? WHERE id = ?", [JSON.stringify(row), meshBytes, detailBytes, id]);
      out.moved++;
    } catch (err) {
      for (const kind of written) payloads.remove(id, kind);
      out.failed++;
    }
  }
  select.free();
  if (out.failed > 0) warn(`WARNING: ${out.failed} part(s) still have shape data in their database row (their files could not be written). Tried again at the next start.`);
  return out;
}

module.exports = { apply, moveInlineWhenEncrypted, COLUMNS };
