/**
 * The parser front door: cheap checks on the raw bytes of an upload, run in the
 * parse worker BEFORE the expensive work (meshing, feature recognition), so a
 * file that cannot be a real part costs milliseconds, not a worker for a minute.
 *
 *   non-finite / absurd coordinates   every STL vertex is checked here; the
 *       other formats hand their vertex rows to assertFiniteVertices() before
 *       analysis. NaN, ±Infinity, and anything further than
 *       GEOMETRY_MAX_COORD_MM from the origin is refused (review H1).
 *   size that the content does not explain   a binary STL is exactly
 *       84 + 50 × triangles bytes; an ASCII STL needs a few hundred bytes per
 *       facet; a text CAD file is not mostly blank. A file padded far past what
 *       its geometry needs was the cheap way to fill the storage ceiling: a
 *       cube followed by 49 MB of blanks was accepted in 2 seconds (review H4).
 *   DXF size   a part outline is not tens of megabytes (DXF_MAX_FILE_MB).
 *
 * Refusals are written for the customer and carry a stable `code`.
 */
const { limits } = require("../security/limits");
const { coordOk, refusal } = require("./saneGeometry");
const brand = require("../../shared/brand.json");

const DAMAGED = "This file is damaged or incomplete. Re-export it from your CAD program and upload again.";
const damaged = () => Object.assign(new Error(DAMAGED), { code: "file-damaged", expose: true });
const padded = () => Object.assign(
  new Error(`This file is much larger than the model inside it needs, which usually means the export went wrong. Re-export it from your CAD program and upload again, or email it to ${brand.email} and we'll quote it by hand.`),
  { code: "file-padded", expose: true, offerRfq: true },
);

const nestedShells = () => Object.assign(
  new Error(`This model has one closed shape inside another (a sealed hollow, or a part inside a part). The instant quote can't price that reliably, so we quote these by hand: email the file to ${brand.email} and we'll come back with a price.`),
  { code: "nested-shells", expose: true, offerRfq: true },
);

/** Refuse a mesh in which one closed shell sits inside another (parsers/meshShells.js). */
function assertNoNestedShells(xyz, triangles) {
  if (!(triangles >= 8)) return;
  if (require("./meshShells").findNestedShells(xyz, triangles).nested) throw nestedShells();
}

/** The same test parseSTL() uses to tell an ASCII STL from a binary one. */
function isAsciiStl(buffer) {
  const header = buffer.slice(0, 80).toString("ascii");
  return header.trimStart().startsWith("solid") && buffer.toString("ascii", 0, 300).includes("facet");
}

/**
 * Binary STL: the size must be exactly what the triangle count says, and every
 * vertex coordinate a finite number in range. (Stored normals are not checked:
 * exporters write zero or junk normals for degenerate facets, and nothing is
 * measured from them.)
 */
function checkBinaryStl(buffer) {
  if (buffer.length < 84) throw damaged();
  const count = buffer.readUInt32LE(80);
  if (count > limits.meshMaxTriangles) return; // parseSTL answers "model too large" with the count
  const expected = 84 + count * 50;
  if (expected > buffer.length) throw damaged();
  if (buffer.length !== expected) throw padded();
  const max = limits.geometryMaxCoordMm;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let finiteAll = true;
  let inRange = true;
  for (let i = 0, off = 84; i < count; i++, off += 50) {
    for (let k = 12; k < 48; k += 4) {
      const v = view.getFloat32(off + k, true);
      if (!(v >= -max && v <= max)) { // false for NaN too
        if (Number.isFinite(v)) inRange = false; else finiteAll = false;
      }
    }
    if (!finiteAll) break;
  }
  if (!finiteAll) throw refusal("geometry-not-measurable");
  if (!inRange) throw refusal("geometry-out-of-range");
  // One closed shape inside another (parsers/meshShells.js): to a person, not to a price.
  const xyz = new Float32Array(count * 9);
  for (let i = 0, off = 84, o = 0; i < count; i++, off += 50) for (let k = 12; k < 48; k += 4) xyz[o++] = view.getFloat32(off + k, true);
  assertNoNestedShells(xyz, count);
}

// A number as an STL writer prints it: 12, -3.5, .25, 1e-3, 6.02E+23. Nothing else ("e", "+-", "nan").
const STL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * ASCII STL: every vertex is three real numbers in range, there are exactly
 * three vertices per facet, and the file is not far larger than its facets need.
 */
function checkAsciiStl(buffer) {
  const text = buffer.toString("ascii");
  const max = limits.geometryMaxCoordMm;
  let facets = 0;
  const facetRe = /facet\s+normal\b/g;
  while (facetRe.exec(text) !== null) {
    if (++facets > limits.meshMaxTriangles) return; // parseSTL answers "model too large"
  }
  let vertices = 0;
  let bad = null;
  const xyz = new Float64Array(facets * 9);
  const vertexRe = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m;
  while ((m = vertexRe.exec(text)) !== null) {
    vertices++;
    if (vertices > facets * 3) break;
    for (let k = 1; k <= 3; k++) {
      const token = m[k];
      const v = STL_NUMBER.test(token) ? Number(token) : NaN;
      if (!(v >= -max && v <= max)) { bad = Number.isFinite(v) ? "geometry-out-of-range" : "geometry-not-measurable"; break; }
      xyz[(vertices - 1) * 3 + k - 1] = v;
    }
    if (bad) break;
  }
  if (bad) throw refusal(bad);
  if (facets > 0 && vertices !== facets * 3) throw damaged();
  if (facets > 0 && buffer.length > 4096 + facets * limits.stlAsciiMaxBytesPerFacet) throw padded();
  assertNoNestedShells(xyz, facets);
}

function checkStl(buffer) {
  if (isAsciiStl(buffer)) checkAsciiStl(buffer); else checkBinaryStl(buffer);
}

/**
 * A text CAD file (STEP, IGES, DXF) that is almost all blank space is padding,
 * not a model. Only looked at past 256 kB; IGES is fixed-width and runs to
 * about two-thirds blanks, so the line is drawn well above that.
 */
function checkTextPadding(buffer) {
  if (buffer.length < 256 * 1024) return;
  const maxBlank = limits.cadMaxBlankPercent / 100;
  let blank = 0;
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x00) blank++;
  }
  if (blank > buffer.length * maxBlank) throw padded();
}

function checkDxf(buffer) {
  const max = limits.dxfMaxFileBytes;
  if (buffer.length > max) {
    throw Object.assign(
      new Error(`This DXF is over ${Math.round(max / (1024 * 1024))} MB, more than a part outline needs. Export just the part's outline and holes and upload again, or send it to us for a firm quote.`),
      { code: "model-too-large", expose: true, offerRfq: true },
    );
  }
  checkTextPadding(buffer);
}

/**
 * Run the check for a file's kind. Called by parseFile() before the parser.
 * @param {string} ext lower-case extension with its dot
 * @param {Buffer} buffer
 */
function checkInput(ext, buffer) {
  switch (ext) {
    case ".stl": return checkStl(buffer);
    case ".dxf": return checkDxf(buffer);
    case ".step":
    case ".stp":
    case ".iges":
    case ".igs":
      return checkTextPadding(buffer);
    default: return undefined; // .3mf: a ZIP archive, bounded by zipGuard
  }
}

/**
 * Vertex rows ([x, y, z] per corner) as the STEP, IGES and 3MF readers build
 * them: refuse a non-finite or out-of-range coordinate before analysis.
 * @param {number[][]} rows
 */
function assertFiniteVertices(rows, opt = {}) {
  const max = limits.geometryMaxCoordMm;
  let outOfRange = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const x = r[0], y = r[1], z = r[2];
    if (coordOk(x, max) && coordOk(y, max) && coordOk(z, max)) continue;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) outOfRange = true;
    else throw refusal("geometry-not-measurable");
  }
  if (outOfRange) throw refusal("geometry-out-of-range");
  // opt.shells: the rows are a triangle list (three corners each); refuse one closed shell inside another.
  if (opt.shells && rows.length >= 24 && rows.length % 3 === 0 && rows.length / 3 <= limits.meshMaxTriangles) {
    const xyz = new Float64Array(rows.length * 3);
    for (let i = 0; i < rows.length; i++) { xyz[i * 3] = rows[i][0]; xyz[i * 3 + 1] = rows[i][1]; xyz[i * 3 + 2] = rows[i][2]; }
    assertNoNestedShells(xyz, rows.length / 3);
  }
  return rows;
}

module.exports = { checkInput, checkStl, checkBinaryStl, checkAsciiStl, checkTextPadding, checkDxf, assertFiniteVertices, assertNoNestedShells, isAsciiStl };
