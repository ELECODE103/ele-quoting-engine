/**
 * A full backup as one file: the database plus every folder of customer
 * files, in a gzip-compressed tar archive that any system can open
 * (Windows 10 and later: `tar -xzf`, or double-click in File Explorer).
 *
 *   quoting.db                      the database, as last saved
 *   uploads/…                       CAD files
 *   quote-drawings/…                drawings attached to instant quotes
 *   rfq-drawings/…                  attachments on firm-quote and part requests
 *   part-payloads/…                 3D preview meshes and large geometry detail
 *   MANIFEST.json                   written last: every file with its size and SHA-256
 *
 * What is NOT in it, ever: environment variables, keys, the .env file, logs,
 * the application code. A file that is encrypted on the volume (name ending
 * .enc) is copied byte for byte and stays encrypted: the archive is only
 * readable with the same NORD_FILE_ENC_KEY the site runs with. The database
 * is not encrypted (it holds accounts, password hashes and order history), so
 * the archive is confidential whatever the key setting.
 *
 * Streaming: files are read and written in pieces, never held whole in
 * memory, and the total is checked against BACKUP_MAX_MB (default 4096)
 * before the first byte is sent.
 *
 * Restore (`extract`) is strict about what it accepts: regular files only, at
 * exactly the paths above, each checked against the manifest's SHA-256. An
 * archive containing anything else — a path with "..", an absolute path, a
 * link, an unknown folder — is refused and nothing is put in place.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const FORMAT = "straightedge-full-backup/1";
const FOLDERS = ["uploads", "quote-drawings", "rfq-drawings", "part-payloads"];
const BLOCK = 512;
const CHUNK = 256 * 1024;
const MAX_TAR_FILE = 8 * 1024 * 1024 * 1024 - 1; // what an 11-digit octal size field holds
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const ENTRY_RE = new RegExp(`^(?:quoting\\.db|MANIFEST\\.json|(?:${FOLDERS.join("|")})/[A-Za-z0-9][A-Za-z0-9._-]{0,180})$`);

function maxBytes() {
  const n = Number(process.env.BACKUP_MAX_MB);
  return (Number.isFinite(n) && n >= 1 && n <= 1024 * 1024 ? Math.floor(n) : 4096) * 1024 * 1024;
}

/**
 * What a backup would contain right now.
 * @param {object} o
 * @param {string} o.dataDir  the data folder (uploads/, quote-drawings/, …)
 * @param {string} o.dbPath   the database file
 */
function plan({ dataDir, dbPath }) {
  const files = [];
  const skipped = [];
  try {
    const st = fs.statSync(dbPath);
    if (st.isFile()) files.push({ path: "quoting.db", abs: dbPath, size: st.size });
  } catch { /* a brand-new site with no database file yet */ }
  for (const folder of FOLDERS) {
    let names;
    try { names = fs.readdirSync(path.join(dataDir, folder)).sort(); } catch { continue; }
    for (const name of names) {
      const abs = path.join(dataDir, folder, name);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (!st.isFile()) continue;                       // no folders, no links
      if (name.endsWith(".tmp")) continue;              // a write in progress
      if (!NAME_RE.test(name) || `${folder}/${name}`.length > 100 || st.size > MAX_TAR_FILE) { skipped.push({ path: `${folder}/${name.replace(/[^\w.-]/g, "?").slice(0, 80)}`, reason: "name or size not representable" }); continue; }
      files.push({ path: `${folder}/${name}`, abs, size: st.size });
    }
  }
  return { files, skipped, totalBytes: files.reduce((s, f) => s + f.size, 0) };
}

// ─── tar writing ─────────────────────────────────────────────

function octal(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name, size, mtimeSeconds) {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, "utf8");
  b.write(octal(0o600, 8), 100, 8, "ascii");       // mode: owner read/write only
  b.write(octal(0, 8), 108, 8, "ascii");           // uid
  b.write(octal(0, 8), 116, 8, "ascii");           // gid
  b.write(octal(size, 12), 124, 12, "ascii");
  b.write(octal(mtimeSeconds, 12), 136, 12, "ascii");
  b.write("        ", 148, 8, "ascii");            // checksum field counts as spaces while summing
  b.write("0", 156, 1, "ascii");                   // a regular file
  b.write("ustar\0", 257, 6, "ascii");
  b.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return b;
}

const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/**
 * The archive as a stream of tar bytes (not yet compressed).
 * Each file is opened first and read from that handle, so a file removed or
 * replaced while the backup runs is still copied whole, as it was.
 */
async function* tarEntries(planned, meta, report) {
  const now = Math.floor(Date.now() / 1000);
  const listed = [];
  for (const f of planned.files) {
    let fd;
    try { fd = fs.openSync(f.abs, "r"); } catch { report.missing.push(f.path); continue; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size > MAX_TAR_FILE) { report.missing.push(f.path); continue; }
      yield header(f.path, size, now);
      const hash = crypto.createHash("sha256");
      let left = size;
      let position = 0;
      while (left > 0) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, left));
        const n = fs.readSync(fd, buf, 0, buf.length, position);
        if (n <= 0) { buf.fill(0); hash.update(buf); yield buf; left -= buf.length; position += buf.length; report.short.push(f.path); continue; } // cannot happen for a file held open; never emit a short entry
        const piece = n === buf.length ? buf : buf.subarray(0, n);
        hash.update(piece);
        yield piece;
        left -= n;
        position += n;
      }
      yield padding(size);
      listed.push({ path: f.path, size, sha256: hash.digest("hex") });
      report.bytes += size;
    } finally {
      fs.closeSync(fd);
    }
  }
  const manifest = Buffer.from(JSON.stringify({
    format: FORMAT,
    createdAt: new Date().toISOString(),
    ...meta,
    files: listed,
    totalBytes: listed.reduce((s, f) => s + f.size, 0),
    skipped: planned.skipped,
    missing: report.missing,
    notIncluded: ["environment variables, keys and secrets", "application code", "logs"],
  }, null, 2));
  yield header("MANIFEST.json", manifest.length, now);
  yield manifest;
  yield padding(manifest.length);
  yield Buffer.alloc(BLOCK * 2); // end of archive
  report.files = listed.length;
}

/**
 * Write a full backup to `out` (a response, a file stream).
 * @returns {Promise<{files: number, bytes: number, missing: string[]}>}
 */
async function write(out, { dataDir, dbPath, meta = {}, planned } = {}) {
  const p = planned || plan({ dataDir, dbPath });
  const report = { files: 0, bytes: 0, missing: [], short: [] };
  await pipeline(Readable.from(tarEntries(p, meta, report), { objectMode: false }), zlib.createGzip({ level: 6 }), out);
  return report;
}

// ─── tar reading (restore) ───────────────────────────────────

function parseOctal(buf) {
  const s = buf.toString("ascii").replace(/[\0 ]+$/g, "").trim();
  if (!/^[0-7]*$/.test(s)) throw new Error("not a tar archive this tool wrote (size field)");
  return s ? parseInt(s, 8) : 0;
}

/**
 * Unpack `archivePath` into `targetDir`.
 *
 * Everything is first unpacked into a staging folder inside the target and
 * checked against the manifest; only then is it moved into place. If the
 * target already holds a database or files, they are refused — or, with
 * `force`, moved aside into `pre-restore-<time>/` (never deleted).
 *
 * @returns {Promise<{files: number, bytes: number, manifest: object, movedAside: string|null}>}
 */
async function extract(archivePath, targetDir, { force = false, log = () => {} } = {}) {
  const target = path.resolve(targetDir);
  fs.mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staging = path.join(target, `.restore-${stamp}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });

  const seen = new Map(); // path → { size, sha256 }
  let manifest = null;
  try {
    let pending = Buffer.alloc(0);
    let current = null; // { name, left, pad, fd, hash, chunks }
    let ended = false;
    const take = (n) => { const out = pending.subarray(0, n); pending = pending.subarray(n); return out; };

    const source = fs.createReadStream(archivePath).pipe(zlib.createGunzip());
    for await (const chunk of source) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (ended) { pending = Buffer.alloc(0); break; }
        if (!current) {
          if (pending.length < BLOCK) break;
          const h = take(BLOCK);
          if (h.every((b) => b === 0)) { ended = true; continue; }
          const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
          const prefix = h.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
          const type = String.fromCharCode(h[156] || 48);
          const full = prefix ? `${prefix}/${name}` : name;
          if (type !== "0") throw new Error(`refused: the archive contains something that is not a plain file (${JSON.stringify(full.slice(0, 80))})`);
          if (!ENTRY_RE.test(full)) throw new Error(`refused: the archive contains a path this tool does not write (${JSON.stringify(full.slice(0, 80))})`);
          if (seen.has(full)) throw new Error(`refused: the archive lists ${full} twice`);
          const size = parseOctal(h.subarray(124, 136));
          const dest = path.join(staging, full);
          if (!dest.startsWith(staging + path.sep)) throw new Error("refused: a path leaves the restore folder");
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
          current = { name: full, left: size, size, pad: (BLOCK - (size % BLOCK)) % BLOCK, fd: fs.openSync(dest, "wx", 0o600), hash: crypto.createHash("sha256"), chunks: full === "MANIFEST.json" ? [] : null };
        }
        if (current.left > 0) {
          if (!pending.length) break;
          const piece = take(Math.min(current.left, pending.length));
          fs.writeSync(current.fd, piece);
          current.hash.update(piece);
          if (current.chunks) current.chunks.push(Buffer.from(piece));
          current.left -= piece.length;
          if (current.left > 0) break;
        }
        if (pending.length < current.pad) break;
        take(current.pad);
        fs.fsyncSync(current.fd);
        fs.closeSync(current.fd);
        seen.set(current.name, { size: current.size, sha256: current.hash.digest("hex") });
        if (current.chunks) manifest = JSON.parse(Buffer.concat(current.chunks).toString("utf8"));
        current = null;
      }
    }
    if (current) { try { fs.closeSync(current.fd); } catch { /* already closed */ } throw new Error("the archive ends in the middle of a file: the download was cut short"); }
    if (!manifest || manifest.format !== FORMAT) throw new Error("the archive has no manifest this tool recognises: it is not a full backup, or it is incomplete");

    // Every file the manifest names must be present and identical; nothing extra may be present.
    for (const f of manifest.files || []) {
      const got = seen.get(f.path);
      if (!got) throw new Error(`the archive is missing ${f.path}`);
      if (got.size !== f.size || got.sha256 !== f.sha256) throw new Error(`${f.path} does not match its checksum: the archive is damaged`);
    }
    for (const name of seen.keys()) {
      if (name !== "MANIFEST.json" && !(manifest.files || []).some((f) => f.path === name)) throw new Error(`refused: ${name} is in the archive but not in its manifest`);
    }

    // Is the target clear?
    const occupied = [];
    if (fs.existsSync(path.join(target, "quoting.db"))) occupied.push("quoting.db");
    for (const folder of FOLDERS) {
      let names = [];
      try { names = fs.readdirSync(path.join(target, folder)); } catch { /* not there */ }
      if (names.length) occupied.push(folder);
    }
    let movedAside = null;
    if (occupied.length) {
      if (!force) throw new Error(`the target already holds ${occupied.join(", ")}. Restore into an empty folder, or pass --force to move what is there into pre-restore-<time>/ first.`);
      movedAside = path.join(target, `pre-restore-${stamp}`);
      fs.mkdirSync(movedAside, { recursive: true, mode: 0o700 });
      for (const name of occupied) fs.renameSync(path.join(target, name), path.join(movedAside, name));
      log(`Moved the existing ${occupied.join(", ")} into ${path.basename(movedAside)}/`);
    }

    // Move into place: the database last, so a half-finished restore has no database to start on.
    let bytes = 0;
    for (const folder of FOLDERS) {
      const from = path.join(staging, folder);
      if (!fs.existsSync(from)) continue;
      const to = path.join(target, folder);
      try { fs.rmdirSync(to); } catch { /* absent, or moved aside already */ }
      fs.renameSync(from, to);
    }
    for (const f of manifest.files) bytes += f.size;
    if (fs.existsSync(path.join(staging, "quoting.db"))) fs.renameSync(path.join(staging, "quoting.db"), path.join(target, "quoting.db"));
    fs.renameSync(path.join(staging, "MANIFEST.json"), path.join(target, "restored-from-MANIFEST.json"));
    return { files: (manifest.files || []).length, bytes, manifest, movedAside };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { plan, write, extract, maxBytes, FORMAT, FOLDERS };
