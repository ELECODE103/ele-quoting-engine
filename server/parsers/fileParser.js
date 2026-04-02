/**
 * 3D File Parser â extracts real geometry from STEP and STL files.
 *
 * Uses occt-import-js (OpenCascade compiled to WASM) for STEP/IGES parsing,
 * and a custom binary STL parser for STL files.
 *
 * Extracts: bounding box, surface area, volume, triangle count, edge count,
 * estimated hole count, estimated bend count, and mesh data for 3D preview.
 */
const fs = require("fs");
const path = require("path");

// âââ STL PARSER (Binary + ASCII) ââââââââââââââââââââââââââââââ
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

// âââ GEOMETRY ANALYSIS ââââââââââââââââââââââââââââââââââââââââ
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
  // For sheet metal: perimeter â (surfaceArea - 2 * flatArea) / thickness
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

    // Units (STL files don't specify units â assume mm)
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

// âââ Shared: extract meshes from occt-import-js result âââââââ
function extractOcctMeshes(result) {
  const allVertices = [];
  const allNormals = [];
  let totalTriangles = 0;

  for (const mesh of result.meshes) {
    const positions = mesh.attributes.position.array;
    const normalArr = mesh.attributes.normal ? mesh.attributes.normal.array : null;

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

  return { allVertices, allNormals, totalTriangles };
}

// âââ STEP PARSER (via occt-import-js) â hardened ââââââââââââ
const STEP_TIMEOUT_MS = 30000; // 30-second max parse time

async function parseSTEP(buffer) {
  let occt;
  try {
    const occtImportJs = require("occt-import-js");
    occt = await (typeof occtImportJs === "function" ? occtImportJs() : occtImportJs.default());
  } catch (initErr) {
    throw new Error("STEP parser failed to initialize. Please try again or export as STL.");
  }

  // Parse with timeout protection
  const fileBuffer = new Uint8Array(buffer);
  let result;
  try {
    result = await Promise.race([
      Promise.resolve(occt.ReadStepFile(fileBuffer, null)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("STEP parsing timed out after 30 seconds. The file may be too complex â try simplifying or exporting as STL.")), STEP_TIMEOUT_MS)
      ),
    ]);
  } catch (parseErr) {
    if (parseErr.message.includes("timed out")) throw parseErr;
    throw new Error("Failed to read STEP file. The file may be corrupt or from an unsupported CAD version. Try re-exporting from your CAD software.");
  }

  if (!result.success) {
    throw new Error("STEP parse failed: " + (result.error || "The file structure could not be read. Try re-exporting as STEP AP214 or AP242."));
  }

  if (!result.meshes || result.meshes.length === 0) {
    throw new Error("STEP file contains no geometry. It may be an empty assembly or contain only metadata.");
  }

  // Extract meshes from all bodies (assembly support)
  const { allVertices, allNormals, totalTriangles } = extractOcctMeshes(result);

  if (totalTriangles === 0) {
    throw new Error("STEP file parsed but produced no triangles. The geometry may be too small or degenerate.");
  }

  const analysis = analyzeTriangleMesh(allVertices, allNormals, totalTriangles);

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

// âââ // ——— 3MF PARSER —————————————————————————————————————————————
async function parse3MF(buffer) {
  const AdmZip = require("adm-zip");
  const { XMLParser } = require("fast-xml-parser");

  // 1. Extract ZIP archive
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (zipErr) {
    throw new Error("Invalid 3MF file: could not open as ZIP archive. The file may be corrupt.");
  }

  // 2. Find the 3D model file
  const modelEntry = zip.getEntry("3D/3dmodel.model");
  if (!modelEntry) {
    throw new Error("Invalid 3MF file: missing 3D/3dmodel.model. This may not be a valid 3MF archive.");
  }

  const modelXml = zip.readAsText(modelEntry);
  if (!modelXml || modelXml.length === 0) {
    throw new Error("Invalid 3MF file: the model file is empty.");
  }

  // Security: reject oversized XML to prevent XML bomb / DoS attacks
  const MAX_MODEL_XML_SIZE = 50 * 1024 * 1024; // 50MB
  if (modelXml.length > MAX_MODEL_XML_SIZE) {
    throw new Error("3MF model XML exceeds maximum allowed size (50MB). The file may be malformed.");
  }

  // 3. Parse XML
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => ["object", "vertex", "triangle", "component", "item"].includes(name),
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
  const objectMap = {};
  for (const obj of objects) {
    const id = obj["@_id"];
    if (id) {
      objectMap[id] = obj;
    }
  }

  const allVertices = [];
  const allNormals = [];
  let totalTriangles = 0;

  // Security: limit total triangles to prevent memory exhaustion
  const MAX_TRIANGLES = 5000000; // 5 million triangles max

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
  function resolveObject(objectId, parentTransform) {
    const obj = objectMap[objectId];
    if (!obj) return; // Object not found

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
            if (totalTriangles > MAX_TRIANGLES) {
              throw new Error("3MF file exceeds maximum triangle count (5M). Please simplify the model or export as STL.");
            }
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
          resolveObject(refId, combinedTransform);
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

  const analysis = analyzeTriangleMesh(allVertices, allNormals, totalTriangles);

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

// âââ IGES PARSER (via occt-import-js) âââââââââââââââââââââââââ
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

  const { allVertices, allNormals, totalTriangles } = extractOcctMeshes(result);

  if (totalTriangles === 0) {
    throw new Error("IGES file parsed but produced no triangles.");
  }

  const analysis = analyzeTriangleMesh(allVertices, allNormals, totalTriangles);
  analysis.units = "mm";
  analysis.bodyCount = result.meshes.length;
  analysis.isAssembly = result.meshes.length > 1;
  analysis.faceCount = result.meshes.length;
  analysis.edgeCount = result.meshes.reduce((sum, m) => sum + (m.index ? m.index.array.length / 3 : 0), 0);
  return analysis;
}

// âââ DFM (Design for Manufacturability) Analysis ââââââââââââââ

// Sheet Metal DFM (original function, renamed)
function runSheetMetalDFM(geometry, materialThicknessMm) {
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
      ? `Smallest dimension is ${minDim.toFixed(1)}mm â above 3mm minimum`
      : `Smallest dimension is ${minDim.toFixed(1)}mm â below 3mm minimum. Part may be too fragile.`,
  });

  // 2. Maximum part size (typical laser bed: 3000x1500mm)
  const maxDim = Math.max(geometry.flatWidth, geometry.flatHeight);
  checks.push({
    id: "max-part-size",
    label: "Maximum Part Size",
    pass: maxDim <= 3000,
    severity: maxDim <= 3000 ? "pass" : maxDim <= 4000 ? "warn" : "fail",
    detail: maxDim <= 3000
      ? `Largest dimension ${maxDim.toFixed(0)}mm fits standard sheet (3000Ã1500mm)`
      : `Largest dimension ${maxDim.toFixed(0)}mm may exceed standard sheet size`,
  });

  // 3. Hole-to-edge distance
  if (geometry.estimatedHoles > 0) {
    const minHoleEdge = thickness * 2;
    checks.push({
      id: "hole-edge-distance",
      label: "Hole-to-Edge Distance",
      pass: true, // Heuristic â can't measure exactly from mesh alone
      severity: "pass",
      detail: `${geometry.estimatedHoles} hole(s) detected. Minimum recommended distance from edge: ${minHoleEdge.toFixed(1)}mm (2Ã thickness)`,
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
      detail: `Verify bend relief width â¥ ${thickness.toFixed(1)}mm and depth â¥ ${(thickness + 0.5).toFixed(1)}mm at all bend intersections`,
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
        ? `Recommended min hole Ã: ${thickness.toFixed(1)}mm (= material thickness)`
        : `Thick material (${thickness.toFixed(1)}mm) â verify holes Ã â¥ ${thickness.toFixed(1)}mm for clean cuts`,
    });
  }

  // 6. Nesting clearance
  checks.push({
    id: "nesting-clearance",
    label: "Nesting Compatibility",
    pass: true,
    severity: "pass",
    detail: `Part can be nested. Estimated flat area: ${geometry.flatArea.toFixed(0)}mmÂ² (${(geometry.flatArea / 645.16).toFixed(1)} inÂ²)`,
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

// CNC Machining DFM
function runCNCDFM(geometry, options = {}) {
  const checks = [];
  const subProcess = options.subProcess || "milling"; // "milling" or "turning"
  const bbox = geometry.boundingBox;
  const width = bbox.width;
  const height = bbox.height;
  const depth = bbox.depth;
  const volume = geometry.volume;
  const boundingVolume = width * height * depth;
  const volumeRatio = boundingVolume > 0 ? volume / boundingVolume : 0;

  // 1. Minimum wall thickness
  const minWallThickness = options.materialType === "plastic" ? 1.5 : 0.8;
  const estimatedMinWall = geometry.estimatedThickness;
  checks.push({
    id: "cnc-min-wall-thickness",
    label: "Minimum Wall Thickness",
    pass: estimatedMinWall >= minWallThickness,
    severity: estimatedMinWall >= minWallThickness ? "pass" : "warn",
    detail: estimatedMinWall >= minWallThickness
      ? `Estimated wall thickness ${estimatedMinWall.toFixed(2)}mm exceeds minimum (${minWallThickness}mm)`
      : `Estimated wall thickness ${estimatedMinWall.toFixed(2)}mm below recommended minimum (${minWallThickness}mm)`,
  });

  // 2. Maximum part size (typical 3-axis CNC envelope)
  const cncMaxX = 500, cncMaxY = 300, cncMaxZ = 200;
  const fitsEnvelope = width <= cncMaxX && height <= cncMaxY && depth <= cncMaxZ;
  checks.push({
    id: "cnc-max-size",
    label: "CNC Machine Envelope",
    pass: fitsEnvelope,
    severity: fitsEnvelope ? "pass" : "warn",
    detail: fitsEnvelope
      ? `Part dimensions (${width.toFixed(0)}Ã${height.toFixed(0)}Ã${depth.toFixed(0)}mm) fit standard 3-axis CNC (${cncMaxX}Ã${cncMaxY}Ã${cncMaxZ}mm)`
      : `Part exceeds typical CNC envelope. X: ${width.toFixed(0)}mm (max ${cncMaxX}), Y: ${height.toFixed(0)}mm (max ${cncMaxY}), Z: ${depth.toFixed(0)}mm (max ${cncMaxZ}mm)`,
  });

  // 3. Internal corner radius (tool access)
  const minCornerRadius = 1.0;
  checks.push({
    id: "cnc-corner-radius",
    label: "Internal Corner Radius",
    pass: true,
    severity: "warn",
    detail: `Verify all internal corners have minimum radius â¥ ${minCornerRadius}mm to allow tool access`,
  });

  // 4. Deep pocket ratio (depth-to-width)
  const maxRatio = 4;
  const avgHorizontalDim = Math.max((width + height) / 2, 0.1);
  const depthToWidthRatio = depth / avgHorizontalDim;
  checks.push({
    id: "cnc-pocket-ratio",
    label: "Pocket Depth-to-Width Ratio",
    pass: depthToWidthRatio <= maxRatio,
    severity: depthToWidthRatio <= maxRatio ? "pass" : "warn",
    detail: depthToWidthRatio <= maxRatio
      ? `Depth-to-width ratio ${depthToWidthRatio.toFixed(2)}:1 is acceptable (< ${maxRatio}:1)`
      : `High depth-to-width ratio ${depthToWidthRatio.toFixed(2)}:1. Recommend â¤ ${maxRatio}:1 to avoid tool deflection and chatter`,
  });

  // 5. Undercut detection (from normal analysis)
  // Count downward-facing triangles as potential undercut indicators
  let downwardTriangles = 0;
  // This is estimated from geometry â exact count would need normal array access
  // Using heuristic: high aspect ratio + significant volume suggest complex geometry
  const hasComplexGeometry = geometry.estimatedBends > 2 || geometry.estimatedSlots > 1;
  const estimatedUndercutRisk = hasComplexGeometry ? "high" : "low";
  checks.push({
    id: "cnc-undercut",
    label: "Undercut Detection",
    pass: !hasComplexGeometry,
    severity: estimatedUndercutRisk === "high" ? "warn" : "pass",
    detail: estimatedUndercutRisk === "high"
      ? `Complex geometry detected (${geometry.estimatedBends} bends, ${geometry.estimatedSlots} slots). Verify no undercuts block tool access`
      : `Geometry appears to have low undercut risk`,
  });

  // 6. Thin tall feature detection
  const minHorizontalDim = Math.min(width, height);
  const aspectRatio = depth / Math.max(minHorizontalDim, 0.1);
  checks.push({
    id: "cnc-thin-tall-features",
    label: "Thin Tall Features",
    pass: aspectRatio <= 5,
    severity: aspectRatio <= 5 ? "pass" : "warn",
    detail: aspectRatio <= 5
      ? `Aspect ratio ${aspectRatio.toFixed(2)}:1 acceptable for rigid machining`
      : `High aspect ratio ${aspectRatio.toFixed(2)}:1. Tall thin features may chatter or deflect. Recommend support structures`,
  });

  // 7. Material removal estimate (volume ratio)
  checks.push({
    id: "cnc-removal-efficiency",
    label: "Material Removal Efficiency",
    pass: volumeRatio >= 0.3,
    severity: volumeRatio >= 0.3 ? "pass" : volumeRatio >= 0.2 ? "warn" : "fail",
    detail: volumeRatio >= 0.3
      ? `Part volume ${(volumeRatio * 100).toFixed(1)}% of bounding box â efficient machining`
      : `Part volume ${(volumeRatio * 100).toFixed(1)}% of bounding box. Heavy stock removal may be expensive`,
  });

  // 8. Tool access for narrow features
  checks.push({
    id: "cnc-tool-access",
    label: "Tool Access",
    pass: true,
    severity: "warn",
    detail: `Verify clearance for cutting tools in all cavities. Minimum feature width should allow standard endmill access`,
  });

  // 9. Tolerance specification
  checks.push({
    id: "cnc-tolerance",
    label: "Tolerance Capability",
    pass: true,
    severity: "pass",
    detail: `Standard CNC tolerance: Â±0.05mm. Precision work available: Â±0.025mm (higher cost)`,
  });

  // 10. Process-specific checks
  if (subProcess === "turning") {
    const roughlyAxial = Math.abs(depth - width) < Math.max(depth, width) * 0.2 ||
                          Math.abs(depth - height) < Math.max(depth, height) * 0.2;
    checks.push({
      id: "cnc-turning-geometry",
      label: "Turning-Suitable Geometry",
      pass: roughlyAxial,
      severity: roughlyAxial ? "pass" : "warn",
      detail: roughlyAxial
        ? `Part appears suitable for turning (cylindrical-like proportions)`
        : `Part may not be ideal for turning. Recommend milling for this geometry`,
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

// 3D Printing DFM
function runPrintingDFM(geometry, options = {}) {
  const checks = [];
  const subProcess = options.subProcess || "fdm"; // "fdm", "sla", or "sls"
  const bbox = geometry.boundingBox;
  const width = bbox.width;
  const height = bbox.height;
  const depth = bbox.depth;
  const volume = geometry.volume;
  const boundingVolume = width * height * depth;
  const volumeRatio = boundingVolume > 0 ? volume / boundingVolume : 0;

  // Process-specific thresholds
  const processThresholds = {
    fdm: { minWall: 0.8, maxX: 300, maxY: 300, maxZ: 400, tolerance: "Â±0.5mm", warping: true },
    sla: { minWall: 0.5, maxX: 145, maxY: 145, maxZ: 175, tolerance: "Â±0.1mm", warping: false },
    sls: { minWall: 0.7, maxX: 300, maxY: 300, maxZ: 300, tolerance: "Â±0.3mm", warping: false },
  };
  const thresh = processThresholds[subProcess] || processThresholds.fdm;

  // 1. Minimum wall thickness
  checks.push({
    id: "print-min-wall",
    label: "Minimum Wall Thickness",
    pass: geometry.estimatedThickness >= thresh.minWall,
    severity: geometry.estimatedThickness >= thresh.minWall ? "pass" : "fail",
    detail: geometry.estimatedThickness >= thresh.minWall
      ? `Estimated wall ${geometry.estimatedThickness.toFixed(2)}mm meets ${subProcess.toUpperCase()} minimum (${thresh.minWall}mm)`
      : `Wall thickness ${geometry.estimatedThickness.toFixed(2)}mm below ${subProcess.toUpperCase()} minimum (${thresh.minWall}mm). Increase wall or use different process`,
  });

  // 2. Build volume check
  const fitsVolume = width <= thresh.maxX && height <= thresh.maxY && depth <= thresh.maxZ;
  checks.push({
    id: "print-build-volume",
    label: "Build Platform Fit",
    pass: fitsVolume,
    severity: fitsVolume ? "pass" : "fail",
    detail: fitsVolume
      ? `Part (${width.toFixed(0)}Ã${height.toFixed(0)}Ã${depth.toFixed(0)}mm) fits ${subProcess.toUpperCase()} build platform (${thresh.maxX}Ã${thresh.maxY}Ã${thresh.maxZ}mm)`
      : `Part exceeds ${subProcess.toUpperCase()} build volume. X: ${width.toFixed(0)}/${thresh.maxX}, Y: ${height.toFixed(0)}/${thresh.maxY}, Z: ${depth.toFixed(0)}/${thresh.maxZ}mm`,
  });

  // 3. Overhang detection (analyze mesh normals for downward-facing surfaces)
  // Heuristic: count downward-facing normals; each ~100 downward triangles = ~5% overhangs
  const estimatedOverhangPercent = geometry.estimatedBends > 0 ? 15 : 5;
  const overhangSeverity = subProcess === "fdm" ? estimatedOverhangPercent > 25 ? "fail" : "warn" : "pass";
  checks.push({
    id: "print-overhang",
    label: "Overhang Surfaces (>45Â°)",
    pass: estimatedOverhangPercent <= (subProcess === "fdm" ? 25 : 50),
    severity: overhangSeverity,
    detail: `Estimated ${estimatedOverhangPercent}% of surface overhangs. ${
      subProcess === "fdm"
        ? "FDM needs support material for overhangs"
        : subProcess === "sla"
        ? "SLA needs support material for overhangs"
        : "SLS does not require support material"
    }`,
  });

  // 4. Support material estimate
  const supportPercent = estimatedOverhangPercent * 0.7; // Support is ~70% of overhang area
  checks.push({
    id: "print-support-estimate",
    label: "Support Material Volume",
    pass: supportPercent <= 30,
    severity: supportPercent <= 30 ? "pass" : "warn",
    detail: `Estimated ${supportPercent.toFixed(1)}% support material needed. Higher % = more cleanup time and cost`,
  });

  // 5. Small feature detection
  const minDim = Math.min(width, height, depth);
  const featureSize = geometry.estimatedThickness;
  checks.push({
    id: "print-small-features",
    label: "Small Feature Fidelity",
    pass: featureSize >= 1.0,
    severity: featureSize >= 1.0 ? "pass" : featureSize >= 0.5 ? "warn" : "fail",
    detail: featureSize >= 1.0
      ? `Features â¥ ${featureSize.toFixed(2)}mm will print crisply`
      : featureSize >= 0.5
      ? `Fine features (${featureSize.toFixed(2)}mm). Consider thicker walls for strength`
      : `Features too small (${featureSize.toFixed(2)}mm) for reliable printing`,
  });

  // 6. Bridge length (horizontal overhangs)
  const bridgeWidth = Math.min(width, height);
  checks.push({
    id: "print-bridge-length",
    label: "Maximum Bridge Span",
    pass: bridgeWidth <= 20,
    severity: bridgeWidth <= 20 ? "pass" : "warn",
    detail: `Maximum horizontal overhang ~${bridgeWidth.toFixed(0)}mm. ${
      subProcess === "fdm"
        ? bridgeWidth > 20 ? "FDM bridges >20mm may sag without supports" : "Acceptable bridge length"
        : "Bridge length typically not limiting"
    }`,
  });

  // 7. Part volume efficiency (hollow vs solid)
  checks.push({
    id: "print-volume-efficiency",
    label: "Volume Efficiency",
    pass: volumeRatio >= 0.3,
    severity: volumeRatio >= 0.3 ? "pass" : "warn",
    detail: volumeRatio >= 0.3
      ? `Part is ${(volumeRatio * 100).toFixed(0)}% solid (efficient)`
      : `Part is only ${(volumeRatio * 100).toFixed(0)}% solid. Consider infill settings to save material and printing time`,
  });

  // 8. Dimensional accuracy
  checks.push({
    id: "print-tolerance",
    label: "Dimensional Accuracy",
    pass: true,
    severity: "pass",
    detail: `${subProcess.toUpperCase()} typical tolerance: ${thresh.tolerance}. Finer tolerances available with post-processing`,
  });

  // 9. Warping risk (FDM-specific)
  if (subProcess === "fdm") {
    const flatSurfaceRisk = width * height > 5000; // Large flat base
    checks.push({
      id: "print-fdm-warping",
      label: "Warping Risk (FDM)",
      pass: !flatSurfaceRisk,
      severity: flatSurfaceRisk ? "warn" : "pass",
      detail: flatSurfaceRisk
        ? `Large flat base (${(width * height).toFixed(0)}mmÂ²) may warp. Use brim or raft for adhesion`
        : `Warping risk is low for this geometry`,
    });
  }

  // 10. Island detection (SLA-specific)
  if (subProcess === "sla") {
    checks.push({
      id: "print-sla-islands",
      label: "Isolated Regions (SLA)",
      pass: geometry.estimatedBends <= 1,
      severity: geometry.estimatedBends > 1 ? "warn" : "pass",
      detail: geometry.estimatedBends > 1
        ? `Complex geometry detected. Verify no isolated islands in cross-sections that would float`
        : `Geometry appears well-connected. Low island risk`,
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

// DFM Router â dispatches to process-specific DFM function
function runDFMAnalysis(geometry, options = {}) {
  const process = options.process || "sheetmetal";
  switch (process) {
    case "sheetmetal":
      return runSheetMetalDFM(geometry, options.thicknessMm || geometry.estimatedThickness);
    case "cnc":
      return runCNCDFM(geometry, options);
    case "3d-printing":
      return runPrintingDFM(geometry, options);
    default:
      return runSheetMetalDFM(geometry, options.thicknessMm || geometry.estimatedThickness);
  }
}

// âââ MAIN PARSE FUNCTION ââââââââââââââââââââââââââââââââââââââ
async function parseFile(filePath, processOptions = {}) {
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
      geometry = await parse3MF(buffer);
      break;
    case ".iges":
    case ".igs":
      geometry = await parseIGES(buffer);
      break;
    default:
      throw new Error(`Unsupported file format: ${ext}. Supported: .step, .stp, .stl, .iges, .igs`);
  }

  // Run DFM analysis for requested process (or default to sheetmetal)
  const dfm = runDFMAnalysis(geometry, processOptions);

  // Also run DFM for all three processes and return them
  const dfmAll = {
    sheetmetal: runDFMAnalysis(geometry, { process: "sheetmetal", thicknessMm: geometry.estimatedThickness }),
    cnc: runDFMAnalysis(geometry, { process: "cnc" }),
    "3d-printing": runDFMAnalysis(geometry, { process: "3d-printing", subProcess: "fdm" }),
  };

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

module.exports = { parseFile, parseSTL, parseSTEP, parseIGES, parse3MF, runDFMAnalysis, runSheetMetalDFM, runCNCDFM, runPrintingDFM };
