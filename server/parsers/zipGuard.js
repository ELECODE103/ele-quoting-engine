/**
 * ZIP pre-flight for 3MF uploads.
 *
 * A 3MF is a ZIP archive, and a ZIP's directory says how big each entry will
 * be once it is unpacked. This reads that directory — and only the directory —
 * and refuses the archive before a single byte is decompressed when it:
 *
 *   - has more entries than a 3MF needs (ZIP_MAX_ENTRIES)
 *   - declares more unpacked data than we are willing to hold (ZIP_MAX_TOTAL_MB,
 *     and ZIP_MAX_MODEL_MB for the one entry we read)
 *   - compresses better than real mesh XML does (ZIP_MAX_RATIO) — the mark of a
 *     decompression bomb
 *   - is encrypted, or names an entry twice
 *
 * The declared sizes are the attacker's, so they are only ever used to say no.
 * The one entry that is read (3D/3dmodel.model) is inflated by adm-zip >= 0.6.1,
 * which stops zlib at the declared size — a size this module has already held
 * to ZIP_MAX_MODEL_MB — so the output is bounded whatever the archive claims.
 * Nothing is ever extracted to disk.
 *
 * Every error message is written for the customer.
 */
const AdmZip = require("adm-zip");
const { limits } = require("../security/limits");

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const EOCD_MIN = 22;
const MB = 1024 * 1024;

const BAD = "Invalid 3MF file: the archive is malformed. Re-export it from your CAD program or slicer and upload again.";

/** An error whose message is safe to show the customer; `code` says which guard fired. */
function refuse(message, code) {
  return Object.assign(new Error(message), { code, expose: true });
}

const tooBig = (what) => refuse(
  `This 3MF ${what}, which is more than the instant quote reads. Export the part on its own (one body, no textures or print settings), or send it to us for a firm quote.`,
  "ZIP_TOO_LARGE",
);

/**
 * How many entries the archive says it has, read straight from the end record
 * (ZIP64 aware) so an absurd count is refused before any per-entry work.
 */
function declaredEntryCount(buf) {
  if (buf.length < EOCD_MIN) throw refuse(BAD, "ZIP_MALFORMED");
  const stop = Math.max(0, buf.length - EOCD_MIN - 0xffff);
  let end = -1;
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf[i] === 0x50 && buf.readUInt32LE(i) === EOCD_SIG) { end = i; break; }
  }
  if (end < 0) throw refuse(BAD, "ZIP_MALFORMED");
  let count = buf.readUInt16LE(end + 10);
  if (end >= 20 && buf.readUInt32LE(end - 20) === ZIP64_LOCATOR_SIG) {
    const recOffset = Number(buf.readBigUInt64LE(end - 20 + 8));
    if (recOffset + 56 > buf.length || buf.readUInt32LE(recOffset) !== ZIP64_EOCD_SIG) throw refuse(BAD, "ZIP_MALFORMED");
    const big = buf.readBigUInt64LE(recOffset + 32);
    count = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
  }
  return count;
}

/**
 * Read the central directory and apply the limits. Nothing is decompressed.
 * @param {Buffer} buf the whole archive
 * @param {object} [opt] overrides for tests: maxEntries, maxTotalBytes, maxRatio
 * @returns {{ zip: AdmZip, entries: Array, totalSize: number }}
 */
function inspectZip(buf, opt = {}) {
  const maxEntries = opt.maxEntries || limits.zipMaxEntries;
  const maxTotalBytes = opt.maxTotalBytes || limits.zipMaxTotalBytes;
  const maxRatio = opt.maxRatio || limits.zipMaxRatio;

  const count = declaredEntryCount(buf);
  if (count > maxEntries) throw tooBig(`holds ${count.toLocaleString("en-US")} files`);

  let zip, entries;
  try {
    zip = new AdmZip(buf);
    entries = zip.getEntries(); // parses the directory; throws on a repeated name or a broken record
  } catch (err) {
    throw refuse(BAD, /duplicate/i.test((err && err.message) || "") ? "ZIP_DUPLICATE" : "ZIP_MALFORMED");
  }
  if (entries.length > maxEntries) throw tooBig(`holds ${entries.length.toLocaleString("en-US")} files`);

  const seen = new Set();
  let totalSize = 0;
  for (const e of entries) {
    const h = e.header;
    const size = Number(h.size) || 0;
    const packed = Number(h.compressedSize) || 0;
    if (h.encrypted) throw refuse("This 3MF is password-protected, so it can't be read here. Export it without encryption and upload again.", "ZIP_ENCRYPTED");
    // OPC part names are case-insensitive: two names that differ only in case are one part.
    const key = String(e.entryName).replace(/^\//, "").toLowerCase();
    if (seen.has(key)) throw refuse(BAD, "ZIP_DUPLICATE");
    seen.add(key);
    if (!Number.isFinite(size) || size < 0 || packed < 0 || packed > buf.length) throw refuse(BAD, "ZIP_MALFORMED");
    // Stored (uncompressed) data cannot grow; anything else is judged by its declared ratio.
    if (h.method === 0 && size !== packed) throw refuse(BAD, "ZIP_MALFORMED");
    if (size > MB && size > packed * maxRatio) {
      throw refuse("This 3MF unpacks to far more data than a model file should (it looks like a decompression bomb), so it was not opened. Re-export the part from your CAD program or slicer and upload again.", "ZIP_BOMB");
    }
    totalSize += size;
    if (totalSize > maxTotalBytes) throw tooBig(`unpacks to more than ${Math.round(maxTotalBytes / MB)} MB`);
  }
  return { zip, entries, totalSize };
}

/**
 * The model XML of a 3MF, as text, with every guard applied.
 * @param {Buffer} buf
 * @returns {string}
 */
function read3mfModel(buf, opt = {}) {
  const maxModelBytes = opt.maxModelBytes || limits.zipMaxModelBytes;
  const { entries } = inspectZip(buf, opt);
  const entry = entries.find((e) => String(e.entryName).replace(/^\//, "").toLowerCase() === "3d/3dmodel.model");
  if (!entry) throw refuse("Invalid 3MF file: missing 3D/3dmodel.model. This may not be a valid 3MF archive.", "ZIP_NO_MODEL");
  if (Number(entry.header.size) > maxModelBytes) throw tooBig(`has a model of ${Math.round(Number(entry.header.size) / MB)} MB`);
  let data;
  try {
    data = entry.getData(); // inflates at most header.size bytes, checks the CRC
  } catch (err) {
    throw refuse("Invalid 3MF file: the model inside the archive could not be read. The file may be corrupt.", "ZIP_CORRUPT");
  }
  if (!data || data.length === 0) throw refuse("Invalid 3MF file: the model file is empty.", "ZIP_EMPTY");
  if (data.length > maxModelBytes) throw tooBig(`has a model of more than ${Math.round(maxModelBytes / MB)} MB`);
  return data.toString("utf8");
}

module.exports = { inspectZip, read3mfModel, declaredEntryCount };
