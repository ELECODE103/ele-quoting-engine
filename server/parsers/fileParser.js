/**
 * 3D File Parser — extracts real geometry from STEP and STL files.
 *
 * Uses occt-import-js (OpenCascade compiled to WASM) for STEP/IGES parsing,
 * and a custom binary STL parser for STL files.
 *
 * Extracts: bounding box, surface area, volume, triangle count, edge count,
 * estimated hole count, estimated bend count, and mesh data for 3D preview.
 */
const fs = require("fs");
const path = require("path");
const { resolveProcess, activeProcesses } = require("../processes/registry");
const { analyzeGeometry, legacyFromFeatures } = require("../geometry");
const dxf = require("../geometry/dxf");
const { summarizeChecks } = require("../processes/shared");
const { limits } = require("../security/limits");
const { read3mfModel } = require("./zipGuard");
// The front door: cheap checks on the raw bytes before the expensive work, and the "did we measure a
// real part" rule on what comes out (independent review 2026-11-11, H1, H4, L3).
const inputGuards = require("./inputGuards");
const { assertSaneGeometry } = require("./saneGeometry");

/**
 * A model too big for the instant quote. The message is for the customer and
 * sends them to a firm quote; `code` lets the route and the client tell it
 * from a damaged file.
 */
function modelTooLarge(count, { what = "triangles", atLeast = false } = {}) {
  const max = what === "triangles" ? limits.meshMaxTriangles : limits.dxfMaxEntities;
  const n = Number(count).toLocaleString("en-US");
  return Object.assign(
    new Error(`This model has ${atLeast ? "more than " : ""}${n} ${what}, more than the instant quote reads (${max.toLocaleString("en-US")}). Export it at a coarser resolution and upload again, or send it to us for a firm quote.`),
    { code: "model-too-large", expose: true, offerRfq: true },
  );
}
const DAMAGED = "This file is damaged or incomplete. Re-export it from your CAD program and upload again.";

// ─── STL PARSER (Binary + ASCII) ──────────────────────────────
function parseSTL(buffer) {
  // Detect ASCII vs binary
  const header = buffer.slice(0, 80).toString("ascii");
  if (header.trimStart().startsWith("solid") && buffer.toString("ascii", 0, 300).includes("facet")) {
    return parseSTLAscii(buffer.toString("ascii"));
  }
  return parseSTLBinary(buffer);
}

function parseSTLBinary(buffer) {
  // The header's triangle count is the uploader's claim: check it against the
  // ceiling and against the bytes actually present before allocating anything.
  if (buffer.length < 84) throw Object.assign(new Error(DAMAGED), { code: "file-damaged", expose: true });
  const triangleCount = buffer.readUInt32LE(80);
  if (triangleCount > limits.meshMaxTriangles) throw modelTooLarge(triangleCount);
  if (84 + triangleCount * 50 > buffer.length) throw Object.assign(new Error(DAMAGED), { code: "file-damaged", expose: true });
  // Straight into flat typed arrays: 9 numbers per triangle and 3 per normal.
  // (One small array per corner cost ~150 MB of heap on a 500,000-triangle
  // file and most of the garbage-collection time.)
  const positions = new Float64Array(triangleCount * 9);
  const normals = new Float64Array(triangleCount * 3);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 84;
  for (let i = 0; i < triangleCount; i++) {
    normals[i * 3] = view.getFloat32(offset, true);
    normals[i * 3 + 1] = view.getFloat32(offset + 4, true);
    normals[i * 3 + 2] = view.getFloat32(offset + 8, true);
    const o = i * 9;
    for (let k = 0; k < 9; k++) positions[o + k] = view.getFloat32(offset + 12 + k * 4, true);
    offset += 50; // 12 floats + the 2-byte attribute count
  }

  return analyzePackedMesh({ positions, vertexRows: triangleCount * 3, normals, normalRows: triangleCount }, triangleCount, { source: "stl" });
}

function parseSTLAscii(text) {
  const vertices = [];
  const normals = [];
  let triangleCount = 0;

  const facetRegex = /facet\s+normal\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;
  const vertexRegex = /vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;

  const maxTriangles = limits.meshMaxTriangles;
  let match;
  while ((match = facetRegex.exec(text)) !== null) {
    normals.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])]);
    triangleCount++;
    if (triangleCount > maxTriangles) throw modelTooLarge(maxTriangles, { atLeast: true });
  }

  while ((match = vertexRegex.exec(text)) !== null) {
    vertices.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])]);
  }

  return analyzeTriangleMesh(vertices, normals, triangleCount, { source: "stl" });
}

// ─── GEOMETRY ANALYSIS ────────────────────────────────────────
/**
 * Mesh analysis for parsers that collect one [x, y, z] row per corner (ASCII
 * STL, 3MF, STEP, IGES). A well-formed result (exactly three corners per
 * triangle, a normal row for every triangle) is packed into flat typed arrays
 * and analysed by analyzePackedMesh(), the one implementation every format
 * shares. Anything else — an ASCII STL whose facet and vertex counts
 * disagree, a STEP whose bodies only partly carry normals — keeps the
 * row-by-row code below, so what such a file returns (or the error it raises)
 * is exactly what it was.
 *
 * @param {number[][]} vertices 3 per triangle
 * @param {number[][]} normals  per triangle (STL) or per corner (STEP/IGES/3MF, 3 per triangle)
 * @param {number} triangleCount
 * @param {object} meta { source, brepFaces, cornerNormals }
 */
function analyzeTriangleMesh(vertices, normals, triangleCount, meta = {}) {
  if (triangleCount === 0) {
    throw new Error("No triangles found in mesh");
  }
  const packed = packRows(vertices, normals, triangleCount);
  if (packed) return analyzePackedMesh(packed, triangleCount, meta);
  return analyzeTriangleRows(vertices, normals, triangleCount, meta);
}

/** Rows → flat Float64Arrays, or null when the rows are not three numbers per corner / one normal row per triangle. */
function packRows(vertices, normals, triangleCount) {
  if (!Array.isArray(vertices) || !Array.isArray(normals)) return null;
  if (vertices.length !== triangleCount * 3 || normals.length < triangleCount) return null;
  const positions = new Float64Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    const r = vertices[i];
    if (!Array.isArray(r) || r.length !== 3 || typeof r[0] !== "number" || typeof r[1] !== "number" || typeof r[2] !== "number") return null;
    positions[i * 3] = r[0]; positions[i * 3 + 1] = r[1]; positions[i * 3 + 2] = r[2];
  }
  const flat = new Float64Array(normals.length * 3);
  for (let i = 0; i < normals.length; i++) {
    const r = normals[i];
    if (!Array.isArray(r) || r.length !== 3 || typeof r[0] !== "number" || typeof r[1] !== "number" || typeof r[2] !== "number") return null;
    flat[i * 3] = r[0]; flat[i * 3 + 1] = r[1]; flat[i * 3 + 2] = r[2];
  }
  return { positions, vertexRows: vertices.length, normals: flat, normalRows: normals.length };
}

/**
 * The analysis on flat arrays. Same arithmetic, in the same order, as the
 * row-by-row version it replaces (sums over triangles in file order).
 *
 * @param {{positions: Float64Array, vertexRows: number, normals: Float64Array, normalRows: number}} m
 *        positions: xyz per corner, 3 corners per triangle; normals: xyz per row
 */
function analyzePackedMesh(m, triangleCount, meta = {}) {
  if (triangleCount === 0) {
    throw new Error("No triangles found in mesh");
  }
  const pos = m.positions;

  // Bounding box (Math.min / Math.max, as before: a NaN coordinate makes the box NaN)
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0, end = m.vertexRows * 3; i < end; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }

  const boundingBox = {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    width: maxX - minX,
    height: maxY - minY,
    depth: maxZ - minZ,
  };

  // Surface area and volume (signed volume method); down-facing area steeper
  // than 45° from the geometric normal (see analyzeTriangleRows for the notes).
  let totalSurfaceArea = 0;
  let totalVolume = 0;
  let overhangArea = 0;
  const OVERHANG_NZ = -Math.SQRT1_2;

  for (let i = 0; i < triangleCount; i++) {
    const o = i * 9;
    const x0 = pos[o], y0 = pos[o + 1], z0 = pos[o + 2];
    const x1 = pos[o + 3], y1 = pos[o + 4], z1 = pos[o + 5];
    const x2 = pos[o + 6], y2 = pos[o + 7], z2 = pos[o + 8];

    const ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
    const bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const crossMag = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const area = 0.5 * crossMag;
    totalSurfaceArea += area;

    if (crossMag > 0 && cz / crossMag < OVERHANG_NZ) overhangArea += area;

    totalVolume += (
      x0 * (y1 * z2 - y2 * z1) +
      x1 * (y2 * z0 - y0 * z2) +
      x2 * (y0 * z1 - y1 * z0)
    ) / 6.0;
  }
  totalVolume = Math.abs(totalVolume);
  const overhangFraction = totalSurfaceArea > 0 ? overhangArea / totalSurfaceArea : 0;

  const features = estimateFeaturesPacked(m.normals, triangleCount);

  const dims = [boundingBox.width, boundingBox.height, boundingBox.depth].sort((a, b) => a - b);
  const estimatedThickness = dims[0];
  const flatWidth = dims[2];
  const flatHeight = dims[1];

  const flatArea = flatWidth * flatHeight;
  const edgeSurfaceArea = Math.max(totalSurfaceArea - 2 * flatArea * 0.7, flatArea * 0.1);
  const estimatedPerimeter = estimatedThickness > 0.01 ? edgeSurfaceArea / estimatedThickness : flatWidth * 2 + flatHeight * 2;

  const legacy = {
    estimatedThickness,
    estimatedPerimeter: Math.min(estimatedPerimeter, (flatWidth + flatHeight) * 4),
    estimatedHoles: features.holes,
    estimatedSlots: features.slots,
    estimatedBends: features.bends,
  };

  // Geometry recognition (server/geometry, SCHEMA.md) on the same arrays, no copy.
  const recognized = recognizePacked(m, triangleCount, meta);
  const better = legacyFromFeatures(recognized) || {};
  const pick = (key, fallback) => (Number.isFinite(better[key]) ? better[key] : fallback);

  return {
    boundingBox,
    surfaceArea: totalSurfaceArea,
    volume: totalVolume,
    overhangFraction,
    triangleCount,
    vertexCount: m.vertexRows,

    estimatedThickness: pick("estimatedThickness", estimatedThickness),
    flatWidth,
    flatHeight,
    flatArea: flatWidth * flatHeight,
    estimatedPerimeter: pick("estimatedPerimeter", legacy.estimatedPerimeter),

    estimatedHoles: pick("estimatedHoles", features.holes),
    estimatedBends: features.bends,
    estimatedSlots: pick("estimatedSlots", features.slots),
    legacy,

    features: recognized,

    units: "mm",

    meshData: {
      positions: downsamplePacked(pos, m.vertexRows, 50000),
      triangleCount: Math.min(triangleCount, 50000),
    },
  };
}

/** recognizeFeatures() for packed input: the recogniser reads the position array as it is. */
function recognizePacked(m, triangleCount, meta) {
  const source = meta.source || "stl";
  try {
    const positions = m.positions.length === triangleCount * 9 ? m.positions : m.positions.subarray(0, triangleCount * 9);
    const vertexNormals = meta.cornerNormals && m.normalRows === triangleCount * 3 ? m.normals : null;
    return analyzeGeometry({ positions, source, brepFaces: meta.brepFaces || null, vertexNormals });
  } catch (err) {
    return {
      schemaVersion: 1, source, error: err.message,
      holes: [], holeCount: null, pockets: [], slots: [], bosses: [],
      confidence: { holes: 0, pockets: 0, walls: 0, shape: 0, overall: 0 },
      notes: [`Geometry recognition failed: ${err.message}`],
    };
  }
}

/**
 * estimateFeatures() for packed normals. Only the number of normal-direction
 * buckets of each size is used, so the buckets are counted in a small table
 * (a unit normal × 4 rounds to −4 … 4 per axis) instead of one string key per
 * triangle; anything outside that range keeps its string key.
 */
function estimateFeaturesPacked(normals, triangleCount) {
  const table = new Int32Array(729);
  const other = new Map();
  for (let i = 0; i < triangleCount; i++) {
    const rx = Math.round(normals[i * 3] * 4), ry = Math.round(normals[i * 3 + 1] * 4), rz = Math.round(normals[i * 3 + 2] * 4);
    if (rx >= -4 && rx <= 4 && ry >= -4 && ry <= 4 && rz >= -4 && rz <= 4) table[(rx + 4) * 81 + (ry + 4) * 9 + (rz + 4)]++;
    else { const key = `${rx},${ry},${rz}`; other.set(key, (other.get(key) || 0) + 1); }
  }
  let smallClusters = 0, mediumClusters = 0;
  const tally = (c) => {
    if (c < triangleCount * 0.02) smallClusters++;
    if (c >= triangleCount * 0.02 && c < triangleCount * 0.15) mediumClusters++;
  };
  for (let k = 0; k < table.length; k++) if (table[k] > 0) tally(table[k]);
  for (const c of other.values()) tally(c);

  const holeIndicators = Math.floor(smallClusters / 4);
  const bendIndicators = Math.floor(mediumClusters / 2);
  const slotIndicators = Math.floor(smallClusters / 8);
  return {
    holes: Math.max(0, Math.min(holeIndicators, 50)),
    bends: Math.max(0, Math.min(bendIndicators, 20)),
    slots: Math.max(0, Math.min(slotIndicators, 15)),
  };
}

/** downsampleVertices() for packed positions: a plain array, every Nth triangle when there are more than maxTriangles. */
function downsamplePacked(pos, vertexRows, maxTriangles) {
  const totalTriangles = Math.floor(vertexRows / 3);
  if (totalTriangles <= maxTriangles) return Array.from(pos.length === vertexRows * 3 ? pos : pos.subarray(0, vertexRows * 3));
  const step = totalTriangles / maxTriangles;
  const result = new Array(maxTriangles * 9);
  let w = 0;
  for (let t = 0; t < maxTriangles; t++) {
    const triIdx = Math.floor(t * step) * 3;
    if (triIdx + 2 < vertexRows) {
      const o = triIdx * 3;
      for (let k = 0; k < 9; k++) result[w++] = pos[o + k];
    }
  }
  result.length = w;
  return result;
}

/**
 * The row-by-row analysis, kept for input packRows() declines (see analyzeTriangleMesh).
 */
function analyzeTriangleRows(vertices, normals, triangleCount, meta = {}) {
  if (triangleCount === 0) {
    throw new Error("No triangles found in mesh");
  }

  // Bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const [x, y, z] of vertices) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }

  const boundingBox = {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    width: maxX - minX,
    height: maxY - minY,
    depth: maxZ - minZ,
  };

  // Surface area and volume (using signed volume method)
  let totalSurfaceArea = 0;
  let totalVolume = 0;
  // Area of down-facing surfaces steeper than 45° (real overhang metric, used by
  // the 3D-printing DFM instead of a guess). Uses the geometric normal from the
  // cross product so it's robust even when the file's stored normals are bad.
  let overhangArea = 0;
  const OVERHANG_NZ = -Math.SQRT1_2; // cos(135°) — normal tilts >45° downward

  for (let i = 0; i < triangleCount; i++) {
    const v0 = vertices[i * 3];
    const v1 = vertices[i * 3 + 1];
    const v2 = vertices[i * 3 + 2];

    // Triangle area via cross product
    const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
    const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const crossMag = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const area = 0.5 * crossMag;
    totalSurfaceArea += area;

    // Down-facing fraction: unit normal's z component (cz / |cross|).
    if (crossMag > 0 && cz / crossMag < OVERHANG_NZ) overhangArea += area;

    // Signed volume contribution (divergence theorem)
    totalVolume += (
      v0[0] * (v1[1] * v2[2] - v2[1] * v1[2]) +
      v1[0] * (v2[1] * v0[2] - v0[1] * v2[2]) +
      v2[0] * (v0[1] * v1[2] - v1[1] * v0[2])
    ) / 6.0;
  }
  totalVolume = Math.abs(totalVolume);
  const overhangFraction = totalSurfaceArea > 0 ? overhangArea / totalSurfaceArea : 0;

  // Estimate features from normal analysis
  const features = estimateFeatures(vertices, normals, triangleCount, boundingBox);

  // Detect thinnest dimension as probable sheet thickness
  const dims = [boundingBox.width, boundingBox.height, boundingBox.depth].sort((a, b) => a - b);
  const estimatedThickness = dims[0];
  const flatWidth = dims[2];
  const flatHeight = dims[1];

  // Cut perimeter estimate: approximate from surface area and thickness
  // For sheet metal: perimeter ≈ (surfaceArea - 2 * flatArea) / thickness
  const flatArea = flatWidth * flatHeight;
  const edgeSurfaceArea = Math.max(totalSurfaceArea - 2 * flatArea * 0.7, flatArea * 0.1);
  const estimatedPerimeter = estimatedThickness > 0.01 ? edgeSurfaceArea / estimatedThickness : flatWidth * 2 + flatHeight * 2;

  // Legacy estimates (kept under `legacy` so the admin view can compare).
  const legacy = {
    estimatedThickness,
    estimatedPerimeter: Math.min(estimatedPerimeter, (flatWidth + flatHeight) * 4),
    estimatedHoles: features.holes,
    estimatedSlots: features.slots,
    estimatedBends: features.bends,
  };

  // ── Geometry recognition (server/geometry, SCHEMA.md) ──
  // Replaces the normal-bucket guesses above where it is confident:
  //   estimatedHoles     ← holeCount (cylinder recognition)
  //   estimatedSlots     ← slots.length (through stadium cutouts + channels)
  //   estimatedPerimeter ← outline perimeter + cutouts + pocket perimeters (total cut path)
  //   estimatedThickness ← walls.minThickness (ray-cast), not the smallest bbox side
  const recognized = recognizeFeatures(vertices, normals, triangleCount, meta);
  const better = legacyFromFeatures(recognized) || {};
  const pick = (key, fallback) => (Number.isFinite(better[key]) ? better[key] : fallback);

  return {
    boundingBox,
    surfaceArea: totalSurfaceArea,
    volume: totalVolume,
    overhangFraction, // 0–1, area-weighted down-facing surface >45° (for print DFM)
    triangleCount,
    vertexCount: vertices.length,

    // Derived manufacturing properties
    estimatedThickness: pick("estimatedThickness", estimatedThickness),
    flatWidth,
    flatHeight,
    flatArea: flatWidth * flatHeight,
    estimatedPerimeter: pick("estimatedPerimeter", legacy.estimatedPerimeter),

    // Feature estimates
    estimatedHoles: pick("estimatedHoles", features.holes),
    estimatedBends: features.bends,
    estimatedSlots: pick("estimatedSlots", features.slots),
    legacy,

    // Recognised features (see server/geometry/SCHEMA.md). meshData stays outside.
    features: recognized,

    // Units (STL files don't specify units — assume mm)
    units: "mm",

    // Mesh for preview (downsampled if huge)
    meshData: {
      positions: downsampleVertices(vertices, 50000),
      triangleCount: Math.min(triangleCount, 50000),
    },
  };
}

/**
 * Run the geometry recogniser. Never throws: a failure yields a features
 * object with nulls and a note so parsing (and quoting) still succeeds.
 */
function recognizeFeatures(vertices, normals, triangleCount, meta) {
  const source = meta.source || "stl";
  try {
    const positions = new Float64Array(triangleCount * 9);
    for (let i = 0; i < triangleCount * 3; i++) {
      const vtx = vertices[i];
      positions[i * 3] = vtx[0]; positions[i * 3 + 1] = vtx[1]; positions[i * 3 + 2] = vtx[2];
    }
    let vertexNormals = null;
    if (meta.cornerNormals && normals.length === triangleCount * 3) {
      vertexNormals = new Float64Array(triangleCount * 9);
      for (let i = 0; i < triangleCount * 3; i++) {
        const nn = normals[i];
        vertexNormals[i * 3] = nn[0]; vertexNormals[i * 3 + 1] = nn[1]; vertexNormals[i * 3 + 2] = nn[2];
      }
    }
    return analyzeGeometry({ positions, source, brepFaces: meta.brepFaces || null, vertexNormals });
  } catch (err) {
    return {
      schemaVersion: 1, source, error: err.message,
      holes: [], holeCount: null, pockets: [], slots: [], bosses: [],
      confidence: { holes: 0, pockets: 0, walls: 0, shape: 0, overall: 0 },
      notes: [`Geometry recognition failed: ${err.message}`],
    };
  }
}

function estimateFeatures(vertices, normals, triangleCount, bbox) {
  // Heuristic: count clusters of inward-facing normals as holes
  // Count sharp normal changes as bends
  let holeIndicators = 0;
  let bendIndicators = 0;
  let slotIndicators = 0;

  // Group normals by direction buckets
  const normalBuckets = {};
  for (let i = 0; i < triangleCount; i++) {
    const [nx, ny, nz] = normals[i];
    // Quantize normals to 15-degree buckets
    const key = `${Math.round(nx * 4)},${Math.round(ny * 4)},${Math.round(nz * 4)}`;
    normalBuckets[key] = (normalBuckets[key] || 0) + 1;
  }

  const bucketCounts = Object.values(normalBuckets);
  const totalBuckets = Object.keys(normalBuckets).length;

  // Many small normal clusters = complex geometry with holes/features
  const smallClusters = bucketCounts.filter((c) => c < triangleCount * 0.02).length;
  holeIndicators = Math.floor(smallClusters / 4); // ~4 normal clusters per hole

  // Medium clusters with opposing normals = bends
  const mediumClusters = bucketCounts.filter((c) => c >= triangleCount * 0.02 && c < triangleCount * 0.15).length;
  bendIndicators = Math.floor(mediumClusters / 2);

  // Elongated small clusters = slots
  slotIndicators = Math.floor(smallClusters / 8);

  return {
    holes: Math.max(0, Math.min(holeIndicators, 50)),
    bends: Math.max(0, Math.min(bendIndicators, 20)),
    slots: Math.max(0, Math.min(slotIndicators, 15)),
  };
}

/**
 * Downsample a triangle mesh by selecting every Nth TRIANGLE (not vertex).
 * Preserves triangle structure so the mesh renders as a solid surface.
 * @param {number[][]} vertices - Array of [x,y,z] vertex positions, 3 per triangle
 * @param {number} maxTriangles - Max triangles in the output
 * @returns {number[]} Flat array of vertex positions
 */
function downsampleVertices(vertices, maxTriangles) {
  const totalTriangles = Math.floor(vertices.length / 3);
  if (totalTriangles <= maxTriangles) return vertices.flat();

  // Take every Nth triangle to evenly sample the mesh
  const step = totalTriangles / maxTriangles;
  const result = [];
  for (let t = 0; t < maxTriangles; t++) {
    const triIdx = Math.floor(t * step) * 3; // index into vertices array (3 verts per tri)
    if (triIdx + 2 < vertices.length) {
      result.push(...vertices[triIdx], ...vertices[triIdx + 1], ...vertices[triIdx + 2]);
    }
  }
  return result;
}

// ─── Shared: extract meshes from occt-import-js result ───────
function extractOcctMeshes(result) {
  // Count before copying: a model the kernel tessellated past the ceiling goes to a firm quote.
  let declared = 0;
  for (const mesh of result.meshes) {
    declared += mesh.index ? Math.floor(mesh.index.array.length / 3) : Math.floor(mesh.attributes.position.array.length / 9);
  }
  if (declared > limits.meshMaxTriangles) throw modelTooLarge(declared);

  const allVertices = [];
  const allNormals = [];
  const brepFaces = []; // global triangle ranges of the B-rep faces, for geometry recognition
  let totalTriangles = 0;

  for (const mesh of result.meshes) {
    const positions = mesh.attributes.position.array;
    const normalArr = mesh.attributes.normal ? mesh.attributes.normal.array : null;
    const base = totalTriangles;
    for (const f of mesh.brep_faces || []) {
      if (Number.isInteger(f.first) && Number.isInteger(f.last)) brepFaces.push({ first: base + f.first, last: base + f.last });
    }

    if (mesh.index) {
      const indices = mesh.index.array;
      for (let i = 0; i < indices.length; i += 3) {
        for (let v = 0; v < 3; v++) {
          const idx = indices[i + v];
          allVertices.push([positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]]);
          if (normalArr) allNormals.push([normalArr[idx * 3], normalArr[idx * 3 + 1], normalArr[idx * 3 + 2]]);
        }
        totalTriangles++;
      }
    } else {
      for (let i = 0; i < positions.length; i += 9) {
        for (let v = 0; v < 3; v++) {
          allVertices.push([positions[i + v * 3], positions[i + v * 3 + 1], positions[i + v * 3 + 2]]);
          if (normalArr) allNormals.push([normalArr[i + v * 3], normalArr[i + v * 3 + 1], normalArr[i + v * 3 + 2]]);
        }
        totalTriangles++;
      }
    }
  }

  // Per-corner (smooth) normals from the kernel are exact surface normals.
  const cornerNormals = allNormals.length === allVertices.length;

  // Generate flat normals if none provided
  if (allNormals.length === 0) {
    for (let i = 0; i < totalTriangles; i++) {
      const v0 = allVertices[i * 3], v1 = allVertices[i * 3 + 1], v2 = allVertices[i * 3 + 2];
      const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
      const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const n = [nx / len, ny / len, nz / len];
      allNormals.push(n, n, n);
    }
  }

  return { allVertices, allNormals, totalTriangles, brepFaces, cornerNormals };
}

// ─── STEP PARSER (via occt-import-js) — hardened ────────────
// Time limit: ReadStepFile is one synchronous call into the CAD kernel, so nothing in this thread
// can interrupt it (a timer raced against it here never fired: it could only run after the call had
// returned). The limit that works is outside: the parse pool stops this worker thread when the
// file's budget is up (parsers/parsePool.js, PARSE_TIMEOUT_CAD_BASE_MS + per-MB, at most PARSE_TIMEOUT_MS).
async function parseSTEP(buffer) {
  let occt;
  try {
    const occtImportJs = require("occt-import-js");
    occt = await (typeof occtImportJs === "function" ? occtImportJs() : occtImportJs.default());
  } catch (initErr) {
    throw new Error("STEP parser failed to initialize. Please try again or export as STL.");
  }

  const fileBuffer = new Uint8Array(buffer);
  let result;
  try {
    result = occt.ReadStepFile(fileBuffer, null);
  } catch (parseErr) {
    throw new Error("Failed to read STEP file. The file may be corrupt or from an unsupported CAD version. Try re-exporting from your CAD software.");
  }

  if (!result.success) {
    throw new Error("STEP parse failed: " + (result.error || "The file structure could not be read. Try re-exporting as STEP AP214 or AP242."));
  }

  if (!result.meshes || result.meshes.length === 0) {
    throw new Error("STEP file contains no geometry. It may be an empty assembly or contain only metadata.");
  }

  // Extract meshes from all bodies (assembly support)
  const { allVertices, allNormals, totalTriangles, brepFaces, cornerNormals } = extractOcctMeshes(result);

  if (totalTriangles === 0) {
    throw new Error("STEP file parsed but produced no triangles. The geometry may be too small or degenerate.");
  }
  inputGuards.assertFiniteVertices(allVertices);

  const analysis = analyzeTriangleMesh(allVertices, allNormals, totalTriangles, { source: "step", brepFaces, cornerNormals });

  analysis.units = "mm";
  analysis.bodyCount = result.meshes.length; // Assembly: number of bodies
  analysis.isAssembly = result.meshes.length > 1;
  analysis.faceCount = result.meshes.length;
  analysis.edgeCount = result.meshes.reduce((sum, m) => sum + (m.index ? m.index.array.length / 3 : 0), 0);

  // Mesh density check: warn if very few triangles for the bounding box size
  const bboxVolume = analysis.boundingBox.width * analysis.boundingBox.height * analysis.boundingBox.depth;
  if (bboxVolume > 1000 && totalTriangles < 50) {
    analysis.warnings = analysis.warnings || [];
    analysis.warnings.push("Low mesh density detected. Geometry measurements may be approximate. Consider re-exporting with finer tessellation.");
  }

  return analysis;
}

// ─── 3MF PARSER ───────────────────────────────────────────────
async function parse3MF(buffer) {
  const { XMLParser } = require("fast-xml-parser");

  // 1–2. Open the archive and read 3D/3dmodel.model. zipGuard checks the entry
  //      count, the declared sizes and the compression ratio before anything is
  //      unpacked, and caps what the one entry may inflate to (ZIP bombs).
  const modelXml = read3mfModel(buffer);

  // Count the triangles in the text before building an object tree from it: a
  // mesh past the ceiling would cost gigabytes as parsed XML.
  const triangleTag = /<(?:[A-Za-z0-9_.-]+:)?triangle[\s/>]/g;
  let triangleTags = 0;
  while (triangleTag.exec(modelXml) !== null) {
    if (++triangleTags > limits.meshMaxTriangles) throw modelTooLarge(limits.meshMaxTriangles, { atLeast: true });
  }

  // 3. Parse XML
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["object", "vertex", "triangle", "component", "item"].includes(name),
    // A 3MF model nests six levels deep (model/resources/object/mesh/vertices/vertex).
    // Anything much deeper is not a model; refuse it rather than recurse.
    maxNestedTags: limits.xmlMaxDepth,
    // No entity expansion: mesh data is numbers, and expanding entities is how an
    // XML bomb ("billion laughs") turns a small file into gigabytes.
    processEntities: false,
  });

  let parsed;
  try {
    parsed = parser.parse(modelXml);
  } catch (xmlErr) {
    throw new Error("Invalid 3MF file: XML parsing failed. The model file may be malformed.");
  }

  // Navigate to model root — handle namespace prefix variations
  const model = parsed.model || parsed["model:model"] || (parsed["?xml"] ? Object.values(parsed).find(v => typeof v === "object" && v !== null && !Array.isArray(v)) : null);
  if (!model) {
    throw new Error("Invalid 3MF file: no <model> element found.");
  }

  // 4. Unit normalization — 3MF spec supports: micron, millimeter, centimeter, inch, foot, meter
  const unitAttr = model["@_unit"] || "millimeter";
  const UNIT_TO_MM = {
    micron: 0.001,
    millimeter: 1,
    centimeter: 10,
    inch: 25.4,
    foot: 304.8,
    meter: 1000,
  };
  const scale = UNIT_TO_MM[unitAttr.toLowerCase()] || 1;

  // 5. Extract mesh objects and resolve component references
  const resources = model.resources || model["model:resources"];
  if (!resources) {
    throw new Error("Invalid 3MF file: no <resources> element found.");
  }

  let objects = resources.object || resources["model:object"] || [];
  if (!Array.isArray(objects)) objects = [objects];

  // Build a map of objectId -> object for component resolution
  const objectMap = Object.create(null); // ids come from the file: no prototype to collide with
  for (const obj of objects) {
    const id = obj["@_id"];
    if (id) {
      objectMap[id] = obj;
    }
  }

  const allVertices = [];
  const allNormals = [];
  let totalTriangles = 0;

  // Security: limit total triangles to prevent memory exhaustion (components can
  // instance one mesh many times, so this is counted as triangles are produced).
  const MAX_TRIANGLES = limits.meshMaxTriangles;
  // Components may reference each other in a loop; a real assembly is a few levels deep.
  const MAX_COMPONENT_DEPTH = 16;

  // Helper function to apply 3MF affine transform to a vertex
  // transform is a space-separated string: "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32"
  // Matrix form:
  // | m00 m01 m02 0 |
  // | m10 m11 m12 0 |
  // | m20 m21 m22 0 |
  // | m30 m31 m32 1 |
  // Point [x y z 1] * M = [x' y' z' 1]
  function applyTransform(vertex, transformStr) {
    if (!transformStr) return vertex;
    const vals = transformStr.split(/\s+/).map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (vals.length !== 12) return vertex; // Invalid transform, return unchanged
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22, m30, m31, m32] = vals;
    const [x, y, z] = vertex;
    return [
      x * m00 + y * m10 + z * m20 + m30,
      x * m01 + y * m11 + z * m21 + m31,
      x * m02 + y * m12 + z * m22 + m32,
    ];
  }

  // Recursive function to resolve an object and extract its triangles
  // objectId: the ID of the object to resolve
  // parentTransform: optional transform from parent component reference
  function resolveObject(objectId, parentTransform, depth = 0) {
    const obj = objectMap[objectId];
    if (!obj) return; // Object not found
    if (depth > MAX_COMPONENT_DEPTH) {
      throw Object.assign(new Error("Invalid 3MF file: its components refer to each other in a loop. Re-export the part from your CAD program or slicer and upload again."), { code: "file-damaged", expose: true });
    }

    // If object has inline mesh, extract triangles from it
    const mesh = obj.mesh || obj["model:mesh"];
    if (mesh) {
      // Extract vertices
      const verticesContainer = mesh.vertices || mesh["model:vertices"];
      if (!verticesContainer) {
        // No vertices but has mesh tag; try components below
      } else {
        let vertexList = verticesContainer.vertex || verticesContainer["model:vertex"] || [];
        if (!Array.isArray(vertexList)) vertexList = [vertexList];

        const verts = vertexList.map((v) => {
          const x = parseFloat(v["@_x"] || 0) * scale;
          const y = parseFloat(v["@_y"] || 0) * scale;
          const z = parseFloat(v["@_z"] || 0) * scale;
          // Apply object's own transform if it has one (less common for mesh objects)
          const objTransform = obj["@_transform"];
          const transformed = applyTransform([x, y, z], objTransform);
          // Apply parent transform (from component reference)
          return applyTransform(transformed, parentTransform);
        });

        // Extract triangles
        const trianglesContainer = mesh.triangles || mesh["model:triangles"];
        if (trianglesContainer) {
          let triangleList = trianglesContainer.triangle || trianglesContainer["model:triangle"] || [];
          if (!Array.isArray(triangleList)) triangleList = [triangleList];

          for (const tri of triangleList) {
            const i0 = parseInt(tri["@_v1"], 10);
            const i1 = parseInt(tri["@_v2"], 10);
            const i2 = parseInt(tri["@_v3"], 10);

            if (isNaN(i0) || isNaN(i1) || isNaN(i2)) continue;
            if (i0 >= verts.length || i1 >= verts.length || i2 >= verts.length) continue;

            const v0 = verts[i0], v1 = verts[i1], v2 = verts[i2];
            allVertices.push(v0, v1, v2);

            // Compute face normal from winding order
            const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
            const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
            const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            const n = [nx / len, ny / len, nz / len];
            allNormals.push(n, n, n);

            totalTriangles++;
            if (totalTriangles > MAX_TRIANGLES) throw modelTooLarge(MAX_TRIANGLES, { atLeast: true });
          }
        }
      }
    }

    // If object has components, recursively resolve each one
    const components = obj.components || obj["model:components"];
    if (components) {
      let componentList = components.component || components["model:component"] || [];
      if (!Array.isArray(componentList)) componentList = [componentList];

      for (const comp of componentList) {
        const refId = comp["@_objectid"];
        const compTransform = comp["@_transform"];
        if (refId) {
          // Compose transforms: first apply component transform, then parent transform
          let combinedTransform = compTransform;
          if (parentTransform && compTransform) {
            // Would need full 4x4 matrix multiply here; for now just use component transform
            // (most files use one or the other, not both)
            combinedTransform = compTransform;
          } else if (parentTransform) {
            combinedTransform = parentTransform;
          }
          resolveObject(refId, combinedTransform, depth + 1);
        }
      }
    }
  }

  // Check for <build> section to determine which objects are top-level
  const build = model.build || model["model:build"];
  if (build) {
    let items = build.item || build["model:item"] || [];
    if (!Array.isArray(items)) items = [items];

    // Process items from build section (these are the top-level objects to render)
    for (const item of items) {
      const refId = item["@_objectid"];
      const itemTransform = item["@_transform"];
      if (refId) {
        resolveObject(refId, itemTransform);
      }
    }
  } else {
    // No <build> section; fall back to processing all objects directly
    for (const obj of objects) {
      const id = obj["@_id"];
      if (id) {
        resolveObject(id, null);
      }
    }
  }

  if (totalTriangles === 0) {
    throw new Error("3MF file contains no mesh geometry. The file may contain only metadata or component references without embedded meshes.");
  }
  inputGuards.assertFiniteVertices(allVertices, { shells: true }); // a vertex or a transform that is not a number; one closed shell inside another

  const analysis = analyzeTriangleMesh(allVertices, allNormals, totalTriangles, { source: "3mf" });

  analysis.units = "mm";
  analysis.sourceUnit = unitAttr;
  analysis.bodyCount = objects.filter((o) => o.mesh || o["model:mesh"]).length;
  analysis.isAssembly = analysis.bodyCount > 1;

  // Extract material metadata if present (for future use)
  const baseMaterials = resources.basematerials || resources["model:basematerials"];
  if (baseMaterials) {
    analysis.materialMetadata = { hasEmbeddedMaterials: true };
  }

  return analysis;
}

// ─── IGES PARSER (via occt-import-js) ─────────────────────────
async function parseIGES(buffer) {
  let occt;
  try {
    const occtImportJs = require("occt-import-js");
    occt = await (typeof occtImportJs === "function" ? occtImportJs() : occtImportJs.default());
  } catch (initErr) {
    throw new Error("IGES parser failed to initialize. Please try again or export as STL.");
  }

  const fileBuffer = new Uint8Array(buffer);
  let result;
  try {
    result = occt.ReadIgesFile(fileBuffer, null);
  } catch (parseErr) {
    throw new Error("Failed to read IGES file. The file may be corrupt or from an unsupported version.");
  }

  if (!result.success) {
    throw new Error("IGES parse failed: " + (result.error || "Unknown error. Try re-exporting from your CAD software."));
  }

  if (!result.meshes || result.meshes.length === 0) {
    throw new Error("IGES file contains no geometry.");
  }

  const { allVertices, allNormals, totalTriangles, brepFaces, cornerNormals } = extractOcctMeshes(result);

  if (totalTriangles === 0) {
    throw new Error("IGES file parsed but produced no triangles.");
  }
  inputGuards.assertFiniteVertices(allVertices);

  const analysis = analyzeTriangleMesh(allVertices, allNormals, totalTriangles, { source: "iges", brepFaces, cornerNormals });
  analysis.units = "mm";
  analysis.bodyCount = result.meshes.length;
  analysis.isAssembly = result.meshes.length > 1;
  analysis.faceCount = result.meshes.length;
  analysis.edgeCount = result.meshes.reduce((sum, m) => sum + (m.index ? m.index.array.length / 3 : 0), 0);
  return analysis;
}

// ─── DFM (Design for Manufacturability) Analysis ──────────────
// Process-specific DFM logic now lives in self-contained process folders
// (server/processes/<slug>/dfm.js). This module dispatches via the registry.

// Back-compat handles to the moved DFM functions (re-exported below).
const runSheetMetalDFM = require("../processes/sheetmetal/dfm").run;
const runCNCDFM = require("../processes/cnc/dfm").run;
const runPrintingDFM = require("../processes/3d-printing/dfm").run;

// Back-compat map from legacy DFM function names to the standalone run()
// functions, for process definitions registered with a `dfmFn` name string.
const DFM_FN_BY_NAME = {
  runSheetMetalDFM,
  runCNCDFM,
  runPrintingDFM,
};

// Default process for DFM when the caller doesn't name one: the first ACTIVE
// process (sheet metal is registered but inactive for Straightedge).
function defaultProcessSlug() {
  const first = activeProcesses()[0];
  return first ? first.slug : "sheetmetal";
}

// DFM Router — dispatches to the process-specific DFM function via the registry.
function runDFMAnalysis(geometry, options = {}) {
  const def = resolveProcess(options.process || defaultProcessSlug());
  // A DXF is a flat drawing: routing only, extruded to the selected stock thickness.
  if (dxf.is2D(geometry)) {
    if (def.slug !== "routing") {
      const checks = require("../processes/routing/dfm2d").notRoutable(def.name);
      return { checks, summary: summarizeChecks(checks) };
    }
    geometry = dxf.materialize(geometry, options.thicknessMm);
  }
  // resolveProcess has already refused an unknown slug; a registered process without a DFM
  // function is a wiring error, not a reason to check the part as sheet metal.
  const fn = (def.dfm && def.dfm.run) || DFM_FN_BY_NAME[def.dfmFn];
  if (typeof fn !== "function") throw new Error(`Process ${def.slug} has no DFM function`);
  // Sheet metal DFM takes a thickness argument; the others take an options object.
  if (def.slug === "sheetmetal" || fn === runSheetMetalDFM) {
    return fn(geometry, options.thicknessMm || geometry.estimatedThickness);
  }
  return fn(geometry, options);
}

// ─── MAIN PARSE FUNCTION ──────────────────────────────────────
async function parseFile(filePath, processOptions = {}) {
  // processOptions.ext / .buffer let a caller parse bytes it already holds (an
  // upload that is encrypted at rest is decrypted in memory, never to disk).
  const ext = (processOptions.ext || path.extname(filePath)).toLowerCase();
  const buffer = processOptions.buffer || fs.readFileSync(filePath);

  // Before any parser runs: coordinates that are not numbers, a file padded far past what its model needs.
  inputGuards.checkInput(ext, buffer);

  let geometry;

  switch (ext) {
    case ".stl":
      geometry = parseSTL(buffer);
      break;
    case ".step":
    case ".stp":
      geometry = await parseSTEP(buffer);
      break;
    case ".3mf":
      geometry = await parse3MF(buffer);
      break;
    case ".iges":
    case ".igs":
      geometry = await parseIGES(buffer);
      break;
    case ".dxf":
      // 2D profile for routing; processOptions.units is the customer's inch/mm choice when given
      geometry = dxf.parseDXF(buffer, { units: processOptions.units });
      break;
    default:
      throw new Error(`Unsupported file format: ${ext}. Supported: .step, .stp, .stl, .iges, .igs, .3mf, .dxf`);
  }

  // What came out must be a part: finite, positive, sane measurements — or it goes to a person, not to a price.
  assertSaneGeometry(geometry);

  // Run DFM analysis for the requested process (default: first active process; a DXF is always routing)
  const dfm = runDFMAnalysis(geometry, { process: dxf.is2D(geometry) ? "routing" : defaultProcessSlug(), ...processOptions });

  // Also run DFM for every active process so the client can show all tabs.
  // Driven by the registry — a new process appears here automatically.
  const dfmAll = {};
  for (const p of activeProcesses()) {
    dfmAll[p.slug] = runDFMAnalysis(geometry, { process: p.slug, subProcess: p.previewSubProcess });
  }

  return {
    geometry,
    dfm,
    dfmAll,
    fileInfo: {
      name: path.basename(filePath),
      ext,
      sizeBytes: buffer.length,
    },
  };
}

module.exports = { parseFile, parseSTL, parseSTEP, parseIGES, parse3MF, runDFMAnalysis, defaultProcessSlug, runSheetMetalDFM, runCNCDFM, runPrintingDFM };
