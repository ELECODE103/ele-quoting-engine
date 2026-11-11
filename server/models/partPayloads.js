/**
 * Per-part payload files.
 *
 * A part's database row used to carry everything the parser produced: the
 * scalar measurements pricing reads, and also the preview mesh (megabytes of
 * JSON for a dense STL) and, for a busy DXF or a plate with hundreds of holes,
 * hundreds of kB of loops and features. sql.js rewrites the whole database
 * file on every write, so those blobs made every save slower for everyone and
 * a few dozen dense uploads filled the database ceiling.
 *
 * Now the row keeps the scalars and the small detail, and the large pieces
 * live here, one file per part and kind under data/part-payloads:
 *
 *   <partId>.mesh.json[.enc]       the preview mesh ({ positions, triangleCount }).
 *                                  Read only when a quote is reopened.
 *   <partId>.geometry.json[.enc]   the whole geometry without the mesh, when it
 *                                  is too large for the row. Read whenever the
 *                                  part is priced (through a small cache).
 *
 * Files are written atomically (a temporary name in the same folder, fsync,
 * rename), so a reader never sees half a file and a crash leaves either the
 * old file or the new one. When NORD_FILE_ENC_KEY is set they are encrypted
 * with the same key and format as the customer's own files (services/
 * fileCrypto.js), in memory, before anything touches the disk. They count
 * against the storage ceiling (security/uploadGuards.js), are deleted with
 * the part's row (models/partsStore.js), and anything left without a row is
 * removed by sweep().
 *
 * The content of a file is exactly the JSON the row would have held, so what
 * comes back is exactly what the database gave before: same values, same key
 * order.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fileCrypto = require("../services/fileCrypto");
const { limits } = require("../security/limits");

const KINDS = ["mesh", "geometry"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TMP_PREFIX = ".tmp-";

class PayloadError extends Error {
  /** @param {"missing"|"no-key"|"wrong-key"|"corrupt"|"storage-full"|"write-failed"} code */
  constructor(code, message) {
    super(message);
    this.name = "PayloadError";
    this.code = code;
  }
}

function dir() {
  return require("../security/uploadGuards").PART_PAYLOAD_DIR;
}

function ensureDir() {
  const d = dir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/**
 * The file-name stem for a part id. Ids are our own random UUIDs; anything that
 * is not one (it cannot come from a request: a row was found first) is hashed,
 * so no id is ever used as a path.
 */
function stem(partId) {
  const id = String(partId || "");
  return UUID.test(id) ? id.toLowerCase() : `x${crypto.createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

function paths(partId, kind) {
  if (!KINDS.includes(kind)) throw new Error(`partPayloads: unknown kind ${String(kind).slice(0, 20)}`);
  const plain = path.join(dir(), `${stem(partId)}.${kind}.json`);
  return { plain, enc: plain + fileCrypto.ENC_SUFFIX };
}

// ─── Splitting a geometry into row and files ─────────────────────────────────

const byteLength = (json) => Buffer.byteLength(json, "utf8");

/**
 * Decide what of a parsed geometry stays in the row.
 * @returns {{ row: object, meshJson: string|null, geometryJson: string|null }}
 *   row           what the database stores (always a complete, valid geometry
 *                 for listings: scalars, bounding box, a mesh stub)
 *   meshJson      the mesh for its file, or null when it is small enough to stay
 *   geometryJson  the full geometry (mesh stubbed) for its file, or null when
 *                 the row holds all of it
 */
function split(geometry, opt = {}) {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return { row: geometry, meshJson: null, geometryJson: null };
  const inlineMesh = opt.inlineMeshBytes ?? limits.partInlineMeshBytes;
  const inlineGeometry = opt.inlineGeometryBytes ?? limits.partInlineGeometryBytes;

  let base = geometry;
  let meshJson = null;
  const mesh = geometry.meshData;
  if (mesh && typeof mesh === "object" && Array.isArray(mesh.positions) && mesh.positions.length > 0) {
    const json = JSON.stringify(mesh);
    if (byteLength(json) > inlineMesh) {
      meshJson = json;
      // Same key, same place in the object: only the vertex list is gone.
      base = { ...geometry, meshData: { ...mesh, positions: [] } };
    }
  }

  const baseJson = JSON.stringify(base);
  if (byteLength(baseJson) <= inlineGeometry) return { row: base, meshJson, geometryJson: null };

  // Too large for the row: the file holds all of it; the row keeps what lists and sweeps read.
  const row = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === null || typeof value !== "object" || key === "boundingBox" || key === "meshData" || JSON.stringify(value).length <= 2048) row[key] = value;
  }
  return { row, meshJson, geometryJson: baseJson };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

// Decrypted geometry files, kept as bytes (each read still parses a fresh
// object, as a database read did). Bounded; dropped on write and delete.
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const cache = new Map(); // "<stem>.<kind>" → Buffer
let cacheBytes = 0;
function cacheDrop(key) {
  const hit = cache.get(key);
  if (hit) { cacheBytes -= hit.length; cache.delete(key); }
}
function cachePut(key, buf) {
  cacheDrop(key);
  if (buf.length > CACHE_MAX_BYTES / 4) return;
  cache.set(key, buf);
  cacheBytes += buf.length;
  for (const k of cache.keys()) { if (cacheBytes <= CACHE_MAX_BYTES) break; cacheDrop(k); }
}

/**
 * The JSON text of a part's payload.
 * @throws {PayloadError} missing / no-key / wrong-key / corrupt
 */
function read(partId, kind) {
  const key = `${stem(partId)}.${kind}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit.toString("utf8"); } // refresh its place in the queue
  const p = paths(partId, kind);
  let buf;
  if (fs.existsSync(p.enc)) {
    try { buf = fileCrypto.decryptToBuffer(p.enc); } catch (err) {
      throw new PayloadError(["no-key", "wrong-key", "corrupt"].includes(err.code) ? err.code : "corrupt", `Part payload (${kind}) could not be decrypted: ${err.code || "error"}`);
    }
  } else if (fs.existsSync(p.plain)) {
    buf = fs.readFileSync(p.plain);
  } else {
    throw new PayloadError("missing", `Part payload (${kind}) is not on disk`);
  }
  if (kind === "geometry") cachePut(key, buf);
  return buf.toString("utf8");
}

/** Parsed payload; a file that is not JSON counts as corrupt. */
function readJson(partId, kind) {
  const text = read(partId, kind);
  try { return JSON.parse(text); } catch { cacheDrop(`${stem(partId)}.${kind}`); throw new PayloadError("corrupt", `Part payload (${kind}) is not valid JSON`); }
}

function exists(partId, kind) {
  const p = paths(partId, kind);
  return fs.existsSync(p.enc) || fs.existsSync(p.plain);
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/**
 * Store one payload. Atomic; encrypted when a key is configured.
 * @param {{ ceiling?: boolean }} [opt]  ceiling:false skips the storage-ceiling check
 *        (the startup migration: those bytes are already on the volume, inside the database)
 * @returns {number} bytes now on disk for this payload
 * @throws {PayloadError} storage-full / write-failed
 */
function write(partId, kind, json, opt = {}) {
  const d = ensureDir();
  const p = paths(partId, kind);
  const plain = Buffer.from(json, "utf8");
  const encrypted = fileCrypto.isEnabled();
  const data = encrypted ? fileCrypto.encryptBuffer(plain) : plain;
  const guards = require("../security/uploadGuards");
  if (opt.ceiling !== false && !guards.storage.hasRoom(data.length)) {
    throw new PayloadError("storage-full", "The storage ceiling is reached: the part's data was not stored");
  }
  const final = encrypted ? p.enc : p.plain;
  const tmp = path.join(d, `${TMP_PREFIX}${crypto.randomBytes(8).toString("hex")}-${path.basename(final)}`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600); // never over an existing file; owner-only
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, final); // the whole file appears at once, or not at all
  } catch (err) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw new PayloadError("write-failed", `Part payload (${kind}) could not be written: ${err.code || err.message}`);
  }
  // A copy under the other name (written before the key was set, or after it was removed) is stale now.
  try { fs.unlinkSync(encrypted ? p.plain : p.enc); } catch { /* there was none */ }
  cacheDrop(`${stem(partId)}.${kind}`);
  guards.storage.add(data.length);
  return data.length;
}

/** Remove a part's payload files (one kind, or all of them). Never throws. Returns how many files went. */
function remove(partId, kind) {
  let removed = 0;
  for (const k of kind ? [kind] : KINDS) {
    const p = paths(partId, k);
    for (const file of [p.enc, p.plain]) {
      try { fs.unlinkSync(file); removed++; } catch (err) { if (err.code !== "ENOENT") console.error(`Part payload: could not remove a ${k} file (${err.code || "error"})`); }
    }
    cacheDrop(`${stem(partId)}.${k}`);
  }
  return removed;
}

// ─── Housekeeping ────────────────────────────────────────────────────────────

/** Every file in the folder: { name, stem, kind, tmp, bytes, mtimeMs }. */
function list() {
  let names;
  try { names = fs.readdirSync(dir()); } catch { return []; }
  const out = [];
  for (const name of names) {
    let st;
    try { st = fs.statSync(path.join(dir(), name)); } catch { continue; }
    if (!st.isFile()) continue;
    const m = name.match(/^([0-9a-fx-]+)\.(mesh|geometry)\.json(\.enc)?$/);
    out.push({ name, stem: m ? m[1] : null, kind: m ? m[2] : null, tmp: name.startsWith(TMP_PREFIX), bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/**
 * Remove what no part row accounts for: a payload whose part is gone, a kind
 * its row does not claim, a temporary file left by a crash, anything else that
 * strayed into the folder. A file younger than `graceMs` is left alone (a part
 * being stored right now writes its files a moment before its row).
 * @param {Array<{id:string, meshBytes?:number, detailBytes?:number}>} partRows
 * @returns {{ removed: number, bytes: number }}
 */
function sweep(partRows, { graceMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  const claims = new Map(); // stem → Set(kinds)
  for (const row of partRows) {
    const kinds = new Set();
    if (Number(row.meshBytes) > 0) kinds.add("mesh");
    if (Number(row.detailBytes) > 0) kinds.add("geometry");
    claims.set(stem(row.id), kinds);
  }
  let removed = 0;
  let bytes = 0;
  for (const f of list()) {
    if (now - f.mtimeMs < graceMs) continue;
    const wanted = !f.tmp && f.stem && claims.has(f.stem) && claims.get(f.stem).has(f.kind);
    if (wanted) continue;
    try { fs.unlinkSync(path.join(dir(), f.name)); removed++; bytes += f.bytes; } catch { /* gone already */ }
    if (f.stem && f.kind) cacheDrop(`${f.stem}.${f.kind}`);
  }
  if (removed) require("../security/uploadGuards").storage.invalidate();
  return { removed, bytes };
}

/** Bytes and file count in the folder (for the startup log and the report). */
function usage() {
  const files = list();
  return { files: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}

function clearCacheForTests() {
  cache.clear();
  cacheBytes = 0;
}

module.exports = { split, read, readJson, write, remove, exists, list, sweep, usage, stem, dir, PayloadError, KINDS, clearCacheForTests };
