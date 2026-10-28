/**
 * Surface segmentation into patches: planes, cylinders, cones and "other".
 *
 * Mesh path (STL/3MF):
 *   1. grow coplanar regions over edge adjacency (dihedral < 0.25 deg);
 *   2. merge small neighbouring regions whose dihedral angle is smooth
 *      (0.25..40 deg) AND whose implied radii agree (width / angle), which
 *      strings the facets of a tessellated cylinder, cone or fillet together
 *      without swallowing a real planar face that happens to meet an arc at a
 *      shallow angle (its implied radius is huge);
 *   3. fit each curved group (fit.js); groups that fit nothing become "other"
 *      patches (or revert to planes when tiny).
 *
 * B-rep path (STEP/IGES): patches are the B-rep faces; each is classified by
 * fitting its triangles (with the exact per-vertex normals when provided).
 */
const { v } = require("./vec");
const { fitCurved, fitPlane, DEG } = require("./fit");

const COPLANAR_COS = Math.cos(0.25 * DEG);
const SMOOTH_MAX_DEG = 40;
const MAX_BOUNDARY_VERTS = 20000;
const RADIUS_RATIO_TOL = 2.5;

function growPlanarRegions(mesh) {
  const { n, adj, normal } = mesh;
  const regionOf = new Int32Array(n).fill(-1);
  const regions = [];
  const stack = new Int32Array(n);
  for (let seed = 0; seed < n; seed++) {
    if (regionOf[seed] >= 0 || mesh.area[seed] <= 0) continue;
    const id = regions.length;
    const tris = [];
    let sp = 0;
    stack[sp++] = seed;
    regionOf[seed] = id;
    while (sp > 0) {
      const t = stack[--sp];
      tris.push(t);
      for (let e = 0; e < 3; e++) {
        const o = adj[t * 3 + e];
        if (o < 0 || regionOf[o] >= 0) continue;
        const d = normal[t * 3] * normal[o * 3] + normal[t * 3 + 1] * normal[o * 3 + 1] + normal[t * 3 + 2] * normal[o * 3 + 2];
        if (d >= COPLANAR_COS) { regionOf[o] = id; stack[sp++] = o; }
      }
    }
    regions.push({ id, tris });
  }
  return { regionOf, regions };
}

/** Area-weighted normal and total area of a triangle list. */
function regionNormal(mesh, tris) {
  let nx = 0, ny = 0, nz = 0, A = 0;
  for (const t of tris) {
    const a = mesh.area[t];
    nx += mesh.normal[t * 3] * a; ny += mesh.normal[t * 3 + 1] * a; nz += mesh.normal[t * 3 + 2] * a;
    A += a;
  }
  return { normal: v.norm([nx, ny, nz]), area: A };
}

/** Unique welded vertex ids of a triangle list. */
function regionVertexIds(mesh, tris) {
  const set = new Set();
  for (const t of tris) { set.add(mesh.vidx[t * 3]); set.add(mesh.vidx[t * 3 + 1]); set.add(mesh.vidx[t * 3 + 2]); }
  return Array.from(set);
}

/** Extent of a region's vertices along a unit direction. */
function extentAlong(mesh, vertIds, dir) {
  let lo = Infinity, hi = -Infinity;
  for (const id of vertIds) {
    const t = mesh.verts[id * 3] * dir[0] + mesh.verts[id * 3 + 1] * dir[1] + mesh.verts[id * 3 + 2] * dir[2];
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  return hi - lo;
}

/**
 * Segment a mesh into patches.
 * @returns {{patches: object[], patchOf: Int32Array}}
 */
function segmentMesh(mesh) {
  const { regionOf, regions } = growPlanarRegions(mesh);
  const R = regions.length;
  for (const r of regions) {
    const rn = regionNormal(mesh, r.tris);
    r.normal = rn.normal; r.area = rn.area;
    r.boundary = new Set(); // welded ids of the region's boundary vertices (the extremes of a planar region lie on them)
  }

  // Region adjacency: for each pair, the longest shared edge direction.
  const pairInfo = new Map(); // key a*R+b (a<b) -> {len, dir}
  const { adj, vidx, verts } = mesh;
  for (let t = 0; t < mesh.n; t++) {
    const ra = regionOf[t];
    if (ra < 0) continue;
    for (let e = 0; e < 3; e++) {
      const o = adj[t * 3 + e];
      const rbAny = o < 0 ? -1 : regionOf[o];
      if (rbAny !== ra) { regions[ra].boundary.add(vidx[t * 3 + e]); regions[ra].boundary.add(vidx[t * 3 + ((e + 1) % 3)]); }
      if (o < 0) continue;
      const rb = rbAny;
      if (rb < 0 || rb === ra || rb < ra) continue;
      const a = vidx[t * 3 + e], b = vidx[t * 3 + ((e + 1) % 3)];
      const dx = verts[b * 3] - verts[a * 3], dy = verts[b * 3 + 1] - verts[a * 3 + 1], dz = verts[b * 3 + 2] - verts[a * 3 + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const key = ra * R + rb;
      const info = pairInfo.get(key);
      if (!info) pairInfo.set(key, { a: ra, b: rb, len, dir: [dx / len, dy / len, dz / len], total: len });
      else { info.total += len; if (len > info.len) { info.len = len; info.dir = [dx / len, dy / len, dz / len]; } }
    }
  }

  // Union-find over regions for curved groups
  const parent = new Int32Array(R);
  for (let i = 0; i < R; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

  const smoothCosMax = COPLANAR_COS, smoothCosMin = Math.cos(SMOOTH_MAX_DEG * DEG);
  for (const r of regions) { r.vertIds = r.boundary.size <= MAX_BOUNDARY_VERTS ? Array.from(r.boundary) : null; r.boundary = null; }
  for (const info of pairInfo.values()) {
    const A = regions[info.a], B = regions[info.b];
    if (!A.vertIds || !B.vertIds) continue; // a face with a huge outline is a real planar face
    const d = v.dot(A.normal, B.normal);
    if (d >= smoothCosMax || d < smoothCosMin) continue;
    const qa = v.norm(v.cross(A.normal, info.dir)), qb = v.norm(v.cross(B.normal, info.dir));
    const wa = extentAlong(mesh, A.vertIds, qa), wb = extentAlong(mesh, B.vertIds, qb);
    if (wa <= 0 || wb <= 0) continue;
    const ratio = Math.max(wa, wb) / Math.min(wa, wb);
    if (ratio > RADIUS_RATIO_TOL) continue;
    // Both facets must be narrow compared with their shared edge: a facet that
    // is much wider than it is long is a planar face, not a band of a cylinder.
    unite(info.a, info.b);
  }

  // Collect groups
  const groups = new Map();
  for (let i = 0; i < R; i++) {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  }

  const patches = [];
  const patchOf = new Int32Array(mesh.n).fill(-1);
  const pushPatch = (p) => { p.id = patches.length; for (const t of p.tris) patchOf[t] = p.id; patches.push(p); };

  for (const members of groups.values()) {
    if (members.length === 1) {
      const r = regions[members[0]];
      pushPatch(makePlane(mesh, r.tris, r.normal, r.area));
      continue;
    }
    const tris = [];
    for (const m of members) for (const t of regions[m].tris) tris.push(t);
    const fit = fitGroup(mesh, tris, members.map((m) => regions[m]), pairInfo, R);
    if (fit.kind === "cylinder" || fit.kind === "cone") {
      pushPatch(Object.assign(fit, { tris, area: sumArea(mesh, tris), source: "mesh" }));
    } else if (members.length <= 3) {
      for (const m of members) pushPatch(makePlane(mesh, regions[m].tris, regions[m].normal, regions[m].area));
    } else {
      pushPatch({ kind: "other", tris, area: sumArea(mesh, tris), source: "mesh", why: fit.why || "no fit" });
    }
  }
  return { patches, patchOf };
}

function sumArea(mesh, tris) { let a = 0; for (const t of tris) a += mesh.area[t]; return a; }

function makePlane(mesh, tris, normal, area) {
  let off = 0, A = 0;
  for (const t of tris) {
    const a = mesh.area[t];
    off += a * (mesh.centroid[t * 3] * normal[0] + mesh.centroid[t * 3 + 1] * normal[1] + mesh.centroid[t * 3 + 2] * normal[2]);
    A += a;
  }
  return { kind: "plane", tris, normal, offset: A > 0 ? off / A : 0, area, source: "mesh" };
}

/** Fit a curved group using per-region normals (one sample per planar facet) and region adjacency pairs. */
function fitGroup(mesh, tris, members, pairInfo, R) {
  const normals = [], points = [], weights = [];
  const index = new Map();
  members.forEach((r, i) => {
    index.set(r.id, i);
    let cx = 0, cy = 0, cz = 0;
    for (const t of r.tris) { cx += mesh.centroid[t * 3] * mesh.area[t]; cy += mesh.centroid[t * 3 + 1] * mesh.area[t]; cz += mesh.centroid[t * 3 + 2] * mesh.area[t]; }
    normals.push(r.normal); points.push([cx / r.area, cy / r.area, cz / r.area]); weights.push(r.area);
  });
  const pairs = [];
  for (const r of members) {
    for (const s of members) {
      if (s.id <= r.id) continue;
      if (pairInfo.has(r.id * R + s.id)) pairs.push([index.get(r.id), index.get(s.id)]);
    }
  }
  const vertIds = regionVertexIds(mesh, tris);
  const vertices = vertIds.map((id) => [mesh.verts[id * 3], mesh.verts[id * 3 + 1], mesh.verts[id * 3 + 2]]);
  return fitCurved({ normals, points, weights, vertices, pairs });
}

/**
 * B-rep path: one patch per face range. vertexNormals (flat, 9 per triangle,
 * per corner) are the exact surface normals from the kernel when available.
 */
function segmentBrep(mesh, faceRanges, vertexNormals) {
  const patches = [];
  const patchOf = new Int32Array(mesh.n).fill(-1);
  for (const f of faceRanges) {
    const tris = [];
    for (let t = f.first; t <= f.last && t < mesh.n; t++) if (mesh.area[t] > 0) tris.push(t);
    if (tris.length === 0) continue;
    const normals = [], points = [], weights = [];
    if (vertexNormals) {
      for (const t of tris) {
        const w = mesh.area[t] / 3;
        for (let c = 0; c < 3; c++) {
          const o = t * 9 + c * 3;
          const nn = v.norm([vertexNormals[o], vertexNormals[o + 1], vertexNormals[o + 2]]);
          if (!Number.isFinite(nn[0])) continue;
          normals.push(nn); points.push([mesh.pos[o], mesh.pos[o + 1], mesh.pos[o + 2]]); weights.push(w);
        }
      }
    }
    if (normals.length < 3) {
      normals.length = 0; points.length = 0; weights.length = 0;
      for (const t of tris) {
        normals.push([mesh.normal[t * 3], mesh.normal[t * 3 + 1], mesh.normal[t * 3 + 2]]);
        points.push([mesh.centroid[t * 3], mesh.centroid[t * 3 + 1], mesh.centroid[t * 3 + 2]]);
        weights.push(mesh.area[t]);
      }
    }
    // Planar if all normals agree
    const pl = fitPlane(normals, points, weights);
    let maxDev = 0;
    for (const nn of normals) maxDev = Math.max(maxDev, 1 - v.dot(nn, pl.normal));
    const area = sumArea(mesh, tris);
    let patch;
    if (maxDev < 1 - Math.cos(0.5 * DEG)) {
      patch = { kind: "plane", tris, normal: pl.normal, offset: pl.offset, area, source: "brep" };
    } else {
      const vertIds = regionVertexIds(mesh, tris);
      const vertices = vertIds.map((id) => [mesh.verts[id * 3], mesh.verts[id * 3 + 1], mesh.verts[id * 3 + 2]]);
      const pairs = [];
      const local = new Map(tris.map((t, i) => [t, i]));
      if (!vertexNormals) {
        for (const t of tris) for (let e = 0; e < 3; e++) { const o = mesh.adj[t * 3 + e]; if (o > t && local.has(o)) pairs.push([local.get(t), local.get(o)]); }
      }
      const fit = fitCurved({ normals, points, weights, vertices, pairs });
      if (fit.kind === "cylinder" || fit.kind === "cone") patch = Object.assign(fit, { tris, area, source: "brep" });
      else patch = { kind: "other", tris, area, source: "brep", why: fit.why || "no fit" };
    }
    patch.id = patches.length;
    patch.faceIndex = f.index;
    for (const t of tris) patchOf[t] = patch.id;
    patches.push(patch);
  }
  // Triangles outside any face range (should not happen) become planar singletons
  for (let t = 0; t < mesh.n; t++) {
    if (patchOf[t] >= 0 || mesh.area[t] <= 0) continue;
    const p = makePlane(mesh, [t], [mesh.normal[t * 3], mesh.normal[t * 3 + 1], mesh.normal[t * 3 + 2]], mesh.area[t]);
    p.id = patches.length; p.source = "brep"; patchOf[t] = p.id; patches.push(p);
  }
  return { patches, patchOf };
}

/**
 * Patch adjacency: for each patch, neighbours with shared boundary length,
 * plus each patch's total boundary length.
 */
function patchAdjacency(mesh, patches, patchOf) {
  const P = patches.length;
  const nb = patches.map(() => new Map());
  const boundaryLen = new Float64Array(P);
  const { adj, vidx, verts } = mesh;
  for (let t = 0; t < mesh.n; t++) {
    const pa = patchOf[t];
    if (pa < 0) continue;
    for (let e = 0; e < 3; e++) {
      const o = adj[t * 3 + e];
      const pb = o < 0 ? -1 : patchOf[o];
      if (pb === pa) continue;
      const a = vidx[t * 3 + e], b = vidx[t * 3 + ((e + 1) % 3)];
      const len = Math.hypot(verts[b * 3] - verts[a * 3], verts[b * 3 + 1] - verts[a * 3 + 1], verts[b * 3 + 2] - verts[a * 3 + 2]);
      boundaryLen[pa] += len;
      if (pb < 0) continue;
      const m = nb[pa];
      const rec = m.get(pb);
      if (rec) { rec.len += len; rec.edges.push(t * 3 + e); }
      else m.set(pb, { len, edges: [t * 3 + e] });
    }
  }
  return { neighbors: nb, boundaryLen };
}

module.exports = { segmentMesh, segmentBrep, patchAdjacency, regionVertexIds, growPlanarRegions };
