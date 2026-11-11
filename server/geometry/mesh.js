/**
 * Indexed triangle mesh with welded vertices, per-triangle normals/areas and
 * edge adjacency. Everything is typed arrays so a 500k-triangle mesh builds in
 * well under a second.
 *
 * Input: flat Float32/Float64Array of positions, 9 numbers per triangle
 * (3 corners x xyz), in the order the file gave them.
 */
const { v, EPS } = require("./vec");

/**
 * @param {Float32Array|Float64Array|number[]} positions flat xyz, 9 per triangle
 * @returns {Mesh}
 */
function buildMesh(positions) {
  const n = Math.floor(positions.length / 9);
  if (n === 0) throw new Error("buildMesh: no triangles");
  const pos = positions instanceof Float64Array ? positions : Float64Array.from(positions);

  // Bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;

  // Weld vertices on a grid of 1e-6 x diagonal (sub-micron on a 1 m part),
  // using an open-addressing hash table on the quantised integer coordinates.
  const q = 1e6 / diag;
  const vidx = new Int32Array(n * 3);
  const corners = n * 3;
  const tableSize = 1 << Math.ceil(Math.log2(corners * 2 + 16));
  const mask = tableSize - 1;
  const table = new Int32Array(tableSize).fill(-1); // -> vertex id
  const kxs = new Int32Array(corners), kys = new Int32Array(corners), kzs = new Int32Array(corners);
  const vertXYZ = new Float64Array(corners * 3);
  let nv = 0;
  for (let c = 0; c < corners; c++) {
    const x = pos[c * 3], y = pos[c * 3 + 1], z = pos[c * 3 + 2];
    const kx = Math.round((x - minX) * q), ky = Math.round((y - minY) * q), kz = Math.round((z - minZ) * q);
    let h = (Math.imul(kx, 73856093) ^ Math.imul(ky, 19349663) ^ Math.imul(kz, 83492791)) & mask;
    let id = -1;
    for (;;) {
      const e = table[h];
      if (e < 0) break;
      if (kxs[e] === kx && kys[e] === ky && kzs[e] === kz) { id = e; break; }
      h = (h + 1) & mask;
    }
    if (id < 0) {
      id = nv++;
      table[h] = id;
      kxs[id] = kx; kys[id] = ky; kzs[id] = kz;
      vertXYZ[id * 3] = x; vertXYZ[id * 3 + 1] = y; vertXYZ[id * 3 + 2] = z;
    }
    vidx[c] = id;
  }
  const verts = vertXYZ.slice(0, nv * 3);

  // Per-triangle normal, area, centroid; volume (divergence theorem)
  const normal = new Float64Array(n * 3);
  const area = new Float64Array(n);
  const centroid = new Float64Array(n * 3);
  let totalArea = 0, volume6 = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
    const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const m = Math.sqrt(cx * cx + cy * cy + cz * cz);
    area[t] = 0.5 * m;
    totalArea += area[t];
    if (m > 0) { normal[t * 3] = cx / m; normal[t * 3 + 1] = cy / m; normal[t * 3 + 2] = cz / m; }
    centroid[t * 3] = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
    centroid[t * 3 + 1] = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
    centroid[t * 3 + 2] = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
    volume6 += pos[o] * (pos[o + 4] * pos[o + 8] - pos[o + 7] * pos[o + 5])
      + pos[o + 3] * (pos[o + 7] * pos[o + 2] - pos[o + 1] * pos[o + 8])
      + pos[o + 6] * (pos[o + 1] * pos[o + 5] - pos[o + 4] * pos[o + 2]);
  }
  const signedVolume = volume6 / 6;

  // Edge adjacency: adj[t*3+e] = triangle across edge e (v[e] -> v[(e+1)%3]), or -1.
  // Directed edge map: key(a,b) -> triangle. A closed, consistently oriented
  // mesh has every directed edge exactly once and its reverse exactly once.
  const adj = new Int32Array(n * 3).fill(-1);
  let duplicateDirected = 0;
  // Directed-edge hash table: slot -> corner index (t*3+e) whose edge is vidx[corner] -> vidx[next]
  const eTable = new Int32Array(tableSize).fill(-1);
  const edgeHash = (a, b) => (Math.imul(a, 2654435761) ^ Math.imul(b, 40503)) & mask;
  const nextCorner = (c) => (c % 3 === 2 ? c - 2 : c + 1);
  for (let c = 0; c < corners; c++) {
    const a = vidx[c], b = vidx[nextCorner(c)];
    if (a === b) continue; // degenerate
    let h = edgeHash(a, b);
    let dup = false;
    for (;;) {
      const e = eTable[h];
      if (e < 0) break;
      if (vidx[e] === a && vidx[nextCorner(e)] === b) { dup = true; break; }
      h = (h + 1) & mask;
    }
    if (dup) duplicateDirected++; else eTable[h] = c;
  }
  let openEdges = 0;
  for (let c = 0; c < corners; c++) {
    const a = vidx[c], b = vidx[nextCorner(c)];
    if (a === b) continue;
    let h = edgeHash(b, a);
    let rev = -1;
    for (;;) {
      const e = eTable[h];
      if (e < 0) break;
      if (vidx[e] === b && vidx[nextCorner(e)] === a) { rev = e; break; }
      h = (h + 1) & mask;
    }
    if (rev < 0) { openEdges++; continue; }
    adj[c] = (rev / 3) | 0;
  }

  return {
    n, pos, verts, nv, vidx, adj, normal, area, centroid,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], size: [maxX - minX, maxY - minY, maxZ - minZ] },
    diag,
    surfaceArea: totalArea,
    volume: Math.abs(signedVolume),
    inverted: signedVolume < 0,
    openEdges,
    nonManifoldEdges: duplicateDirected,
    watertight: openEdges === 0,
    manifold: duplicateDirected === 0 && openEdges === 0,
  };
}

/** Vertex position accessor (welded index). */
function vert(mesh, i) {
  return [mesh.verts[i * 3], mesh.verts[i * 3 + 1], mesh.verts[i * 3 + 2]];
}

/** Dihedral cosine between two triangles' normals. */
function normalDot(mesh, a, b) {
  const na = a * 3, nb = b * 3;
  return mesh.normal[na] * mesh.normal[nb] + mesh.normal[na + 1] * mesh.normal[nb + 1] + mesh.normal[na + 2] * mesh.normal[nb + 2];
}

module.exports = { buildMesh, vert, normalDot, v, EPS };
