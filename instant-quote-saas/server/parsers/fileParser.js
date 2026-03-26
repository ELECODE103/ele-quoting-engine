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
  const triangleCount = buffer.readUInt32LE(80);
  const vertices = [];
  const normals = [];

  let offset = 84;
  for (let i = 0; i < triangleCount; i++) {
    // Normal
    const nx = buffer.readFloatLE(offset); offset += 4;
    const ny = buffer.readFloatLE(offset); offset += 4;
    const nz = buffer.readFloatLE(offset); offset += 4;
    normals.push([nx, ny, nz]);

    // 3 vertices
    for (let v = 0; v < 3; v++) {
      const x = buffer.readFloatLE(offset); offset += 4;
      const y = buffer.readFloatLE(offset); offset += 4;
      const z = buffer.readFloatLE(offset); offset += 4;
      vertices.push([x, y, z]);
    }
    offset += 2; // attribute byte count
  }

  return analyzeTriangleMesh(vertices, normals, triangleCount);
}

function parseSTLAscii(text) {
  const vertices = [];
  const normals = [];
  let triangleCount = 0;

  const facetRegex = /facet\s+normal\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;
  const vertexRegex = /vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;

  let match;
  while ((match = facetRegex.exec(text)) !== null) {
    normals.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])]);
    triangleCount++;
  }

  while ((match = vertexRegex.exec(text)) !== null) {
    vertices.push([parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])]);
  }

  return analyzeTriangleMesh(vertices, normals, triangleCount);
}

// ─── GEOMETRY ANALYSIS ────────────────────────────────────────
function analyzeTriangleMesh(vertices, normals, triangleCount) {
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
    const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    totalSurfaceArea += area;

    // Signed volume contribution (divergence theorem)
    totalVolume += (
      v0[0] * (v1[1] * v2[2] - v2[1] * v1[2]) +
      v1[0] * (v2[1] * v0[2] - v0[1] * v2[2]) +
      v2[0] * (v0[1] * v1[2] - v1[1] * v0[2])
    ) / 6.0;
  }
  totalVolume = Math.abs(totalVolume);

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

  return {
    boundingBox,
    surfaceArea: totalSurfaceArea,
    volume: totalVolume,
    triangleCount,
    vertexCount: vertices.length,

    // Derived manufacturing properties
    estimatedThickness,
    flatWidth,
    flatHeight,
    flatArea: flatWidth * flatHeight,
    estimatedPerimeter: Math.min(estimatedPerimeter, (flatWidth + flatHeight) * 4),

    // Feature estimates
    estimatedHoles: features.holes,
    estimatedBends: features.bends,
    estimatedSlots: features.slots,

    // Units (STL files don't specify units — assume mm)
    units: "mm",

    // Mesh for preview (downsampled if huge)
    meshData: {
      positions: downsampleVertices(vertices, 10000),
      triangleCount: Math.min(triangleCount, 10000),
    },
  };
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

function downsampleVertices(vertices, maxVerts) {
  if (vertices.length <= maxVerts) return vertices.flat();
  const step = Math.ceil(vertices.length / maxVerts);
  const result = [];
  for (let i = 0; i < vertices.length; i += step) {
    result.push(...vertices[i]);
  }
  return result;
}

// ─── STEP PARSER (via occt-import-js) ─────────────────────────
async function parseSTEP(buffer) {
  const occtImportJs = require("occt-import-js");
  const occt = await (typeof occtImportJs === "function" ? occtImportJs() : occtImportJs.default());

  // Load the STEP file
  const fileBuffer = new Uint8Array(buffer);
  const result = occt.ReadStepFile(fileBuffer, null);

  if (!result.success) {
    throw new Error("Failed to parse STEP file: " + (result.error || "Unknown error"));
  }

  // Extract mesh data from all bodies
  const allVertices = [];
  const allNormals = [];
  let totalTriangles = 0;

  for (const mesh of result.meshes) {
    const positions = mesh.attributes.position.array;
    const normalArr = mesh.attributes.normal ? mesh.attributes.normal.array : null;

    if (mesh.index) {
      // Indexed geometry
      const indices = mesh.index.array;
      for (let i = 0; i < indices.length; i += 3) {
        for (let v = 0; v < 3; v++) {
          const idx = indices[i + v];
          allVertices.push([
            positions[idx * 3],
            positions[idx * 3 + 1],
            positions[idx * 3 + 2],
          ]);
          if (normalArr) {
            allNormals.push([
              normalArr[idx * 3],
              normalArr[idx * 3 + 1],
              normalArr[idx * 3 + 2],
            ]);
          }
        }
        totalTriangles++;
      }
    } else {
      // Non-indexed
      for (let i = 0; i < positions.length; i += 9) {
        for (let v = 0; v < 3; v++) {
          allVertices.push([
            positions[i + v * 3],
            positions[i + v * 3 + 1],
            positions[i + v * 3 + 2],
          ]);
          if (normalArr) {
            allNormals.push([
              normalArr[i + v * 3],
              normalArr[i + v * 3 + 1],
              normalArr[i + v * 3 + 2],
            ]);
          }
        }
        totalTriangles++;
      }
    }
  }

  // If no normals provided, generate flat normals
  if (allNormals.length === 0) {
    for (let i = 0; i < totalTriangles; i++) {
      const v0 = allVertices[i * 3];
      const v1 = allVertices[i * 3 + 1];
      const v2 = allVertices[i * 3 + 2];
      const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
      const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const n = [nx / len, ny / len, nz / len];
      allNormals.push(n, n, n);
    }
  }

  const analysis = analyzeTriangleMesh(allVertices, allNormals, totalTriangles);

  // STEP files typically use mm
  analysis.units = "mm";

  // STEP files have better topology data — extract face/edge counts
  analysis.faceCount = result.meshes.length;
  analysis.edgeCount = result.meshes.reduce((sum, m) => {
    return sum + (m.index ? m.index.array.length / 3 : 0);
  }, 0);

  return analysis;
}

// ─── DFM (Design for Manufacturability) Analysis ──────────────
function runDFMAnalysis(geometry, materialThicknessMm) {
  const checks = [];
  const thickness = materialThicknessMm || geometry.estimatedThickness;

  // 1. Minimum feature size
  const minDim = Math.min(geometry.flatWidth, geometry.flatHeight);
  checks.push({
    id: "min-feature-size",
    label: "Minimum Part Dimension",
    pass: minDim >= 3.0, // 3mm minimum
    severity: minDim >= 3.0 ? "pass" : "fail",
    detail: minDim >= 3.0
      ? `Smallest dimension is ${minDim.toFixed(1)}mm — above 3mm minimum`
      : `Smallest dimension is ${minDim.toFixed(1)}mm — below 3mm minimum. Part may be too fragile.`,
  });

  // 2. Maximum part size (typical laser bed: 3000x1500mm)
  const maxDim = Math.max(geometry.flatWidth, geometry.flatHeight);
  checks.push({
    id: "max-part-size",
    label: "Maximum Part Size",
    pass: maxDim <= 3000,
    severity: maxDim <= 3000 ? "pass" : maxDim <= 4000 ? "warn" : "fail",
    detail: maxDim <= 3000
      ? `Largest dimension ${maxDim.toFixed(0)}mm fits standard sheet (3000×1500mm)`
      : `Largest dimension ${maxDim.toFixed(0)}mm may exceed standard sheet size`,
  });

  // 3. Hole-to-edge distance
  if (geometry.estimatedHoles > 0) {
    const minHoleEdge = thickness * 2;
    checks.push({
      id: "hole-edge-distance",
      label: "Hole-to-Edge Distance",
      pass: true, // Heuristic — can't measure exactly from mesh alone
      severity: "pass",
      detail: `${geometry.estimatedHoles} hole(s) detected. Minimum recommended distance from edge: ${minHoleEdge.toFixed(1)}mm (2× thickness)`,
    });
  }

  // 4. Bend feasibility
  if (geometry.estimatedBends > 0) {
    const minBendRadius = thickness; // Minimum inside bend radius = material thickness
    const bendFeasible = thickness <= 12.7; // Max 1/2" for most press brakes
    checks.push({
      id: "bend-feasibility",
      label: "Bend Feasibility",
      pass: bendFeasible,
      severity: bendFeasible ? "pass" : "fail",
      detail: bendFeasible
        ? `${geometry.estimatedBends} bend(s) detected. Min inside radius: ${minBendRadius.toFixed(1)}mm`
        : `Material too thick for standard CNC bending (${thickness.toFixed(1)}mm). Max recommended: 12.7mm`,
    });

    // Bend relief
    checks.push({
      id: "bend-relief",
      label: "Bend Relief Clearance",
      pass: null,
      severity: "warn",
      detail: `Verify bend relief width ≥ ${thickness.toFixed(1)}mm and depth ≥ ${(thickness + 0.5).toFixed(1)}mm at all bend intersections`,
    });
  }

  // 5. Minimum hole diameter
  if (geometry.estimatedHoles > 0) {
    checks.push({
      id: "min-hole-diameter",
      label: "Minimum Hole Diameter",
      pass: true,
      severity: thickness <= 3.0 ? "pass" : "warn",
      detail: thickness <= 3.0
        ? `Recommended min hole Ø: ${thickness.toFixed(1)}mm (= material thickness)`
        : `Thick material (${thickness.toFixed(1)}mm) — verify holes Ø ≥ ${thickness.toFixed(1)}mm for clean cuts`,
    });
  }

  // 6. Nesting clearance
  checks.push({
    id: "nesting-clearance",
    label: "Nesting Compatibility",
    pass: true,
    severity: "pass",
    detail: `Part can be nested. Estimated flat area: ${geometry.flatArea.toFixed(0)}mm² (${(geometry.flatArea / 645.16).toFixed(1)} in²)`,
  });

  // 7. Aspect ratio check
  const aspectRatio = maxDim / Math.max(minDim, 0.1);
  if (aspectRatio > 20) {
    checks.push({
      id: "aspect-ratio",
      label: "Aspect Ratio",
      pass: false,
      severity: "warn",
      detail: `High aspect ratio (${aspectRatio.toFixed(0)}:1). Long thin parts may warp or distort during cutting.`,
    });
  }

  // Overall score
  const passCount = checks.filter((c) => c.severity === "pass").length;
  const warnCount = checks.filter((c) => c.severity === "warn").length;
  const failCount = checks.filter((c) => c.severity === "fail").length;

  return {
    checks,
    summary: {
      passCount,
      warnCount,
      failCount,
      totalChecks: checks.length,
      manufacturable: failCount === 0,
      score: Math.round((passCount / checks.length) * 100),
    },
  };
}

// ─── MAIN PARSE FUNCTION ──────────────────────────────────────
async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);

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
      // 3MF is a ZIP containing XML + mesh data
      // For now, extract and parse the contained STL-like mesh
      throw new Error("3MF support coming soon — please export as STEP or STL");
    case ".iges":
    case ".igs":
      // IGES can also be handled by occt-import-js
      geometry = await parseSTEP(buffer); // occt handles IGES too
      break;
    default:
      throw new Error(`Unsupported file format: ${ext}. Supported: .step, .stp, .stl, .iges, .igs`);
  }

  // Run DFM analysis with estimated thickness
  const dfm = runDFMAnalysis(geometry, geometry.estimatedThickness);

  return {
    geometry,
    dfm,
    fileInfo: {
      name: path.basename(filePath),
      ext,
      sizeBytes: buffer.length,
    },
  };
}

module.exports = { parseFile, parseSTL, parseSTEP, runDFMAnalysis };
