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
 *
 * Regions live in flat arrays (triangles, normals, areas, boundary vertices,
 * adjacent pairs) rather than one object, one triangle list and one Set per
 * region: on an organic mesh every facet is its own region, and half a
 * million small objects of each kind were most of the memory and of the
 * garbage-collection time. The sums are taken over the same items in the
 * same order as before.
 * @returns {{patches: object[], patchOf: Int32Array}}
 */
function segmentMesh(mesh) {
  const { n, adj, normal, area, centroid, vidx, verts } = mesh;

  // ── 1. coplanar regions: triangles of region r are rTris[rStart[r] .. rStart[r+1]), in visiting order
  const regionOf = new Int32Array(n).fill(-1);
  const rTris = new Int32Array(n), rStart = new Int32Array(n + 1);
  const stack = new Int32Array(n);
  let R = 0, filled = 0;
  for (let seed = 0; seed < n; seed++) {
    if (regionOf[seed] >= 0 || area[seed] <= 0) continue;
    const id = R++;
    rStart[id] = filled;
    let sp = 0;
    stack[sp++] = seed;
    regionOf[seed] = id;
    while (sp > 0) {
      const t = stack[--sp];
      rTris[filled++] = t;
      for (let e = 0; e < 3; e++) {
        const o = adj[t * 3 + e];
        if (o < 0 || regionOf[o] >= 0) continue;
        const d = normal[t * 3] * normal[o * 3] + normal[t * 3 + 1] * normal[o * 3 + 1] + normal[t * 3 + 2] * normal[o * 3 + 2];
        if (d >= COPLANAR_COS) { regionOf[o] = id; stack[sp++] = o; }
      }
    }
  }
  rStart[R] = filled;

  // ── 2. area-weighted unit normal and area of each region
  const rN = new Float64Array(R * 3), rA = new Float64Array(R);
  for (let r = 0; r < R; r++) {
    let nx = 0, ny = 0, nz = 0, A = 0;
    for (let i = rStart[r], end = rStart[r + 1]; i < end; i++) {
      const t = rTris[i], a = area[t];
      nx += normal[t * 3] * a; ny += normal[t * 3 + 1] * a; nz += normal[t * 3 + 2] * a;
      A += a;
    }
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    rN[r * 3] = nx / l; rN[r * 3 + 1] = ny / l; rN[r * 3 + 2] = nz / l;
    rA[r] = A;
  }
  const regionTris = (r) => { const out = []; for (let i = rStart[r], end = rStart[r + 1]; i < end; i++) out.push(rTris[i]); return out; };
  const regionNormalOf = (r) => [rN[r * 3], rN[r * 3 + 1], rN[r * 3 + 2]];

  // ── 3. boundary vertices of each region (welded ids; the extremes of a planar region lie on
  //       them) and the edges shared by two regions, both as flat event lists in (triangle, edge) order
  const bStart = new Int32Array(R + 1), eStart = new Int32Array(R + 1);
  for (let t = 0; t < n; t++) {
    const ra = regionOf[t];
    if (ra < 0) continue;
    for (let e = 0; e < 3; e++) {
      const o = adj[t * 3 + e];
      const rb = o < 0 ? -1 : regionOf[o];
      if (rb !== ra) bStart[ra + 1] += 2;
      if (rb > ra) eStart[ra + 1]++;
    }
  }
  for (let i = 0; i < R; i++) { bStart[i + 1] += bStart[i]; eStart[i + 1] += eStart[i]; }
  const bFill = bStart.slice(0, R), eFill = eStart.slice(0, R);
  const bVerts = new Int32Array(bStart[R]);
  const E = eStart[R];
  const evB = new Int32Array(E), evLen = new Float64Array(E), evD = new Float64Array(E * 3);
  for (let t = 0; t < n; t++) {
    const ra = regionOf[t];
    if (ra < 0) continue;
    for (let e = 0; e < 3; e++) {
      const o = adj[t * 3 + e];
      const rb = o < 0 ? -1 : regionOf[o];
      if (rb !== ra) { bVerts[bFill[ra]++] = vidx[t * 3 + e]; bVerts[bFill[ra]++] = vidx[t * 3 + ((e + 1) % 3)]; }
      if (rb <= ra) continue;
      const a = vidx[t * 3 + e], b = vidx[t * 3 + ((e + 1) % 3)];
      const dx = verts[b * 3] - verts[a * 3], dy = verts[b * 3 + 1] - verts[a * 3 + 1], dz = verts[b * 3 + 2] - verts[a * 3 + 2];
      const k = eFill[ra]++;
      evB[k] = rb; evLen[k] = Math.sqrt(dx * dx + dy * dy + dz * dz);
      evD[k * 3] = dx; evD[k * 3 + 1] = dy; evD[k * 3 + 2] = dz;
    }
  }

  // ── 4. adjacent pairs (a < b): the direction of their longest shared edge — the first of
  //       that length in (triangle, edge) order, as when the pairs were found in one sweep
  const pA = new Int32Array(E), pB = new Int32Array(E), pLen = new Float64Array(E), pDir = new Float64Array(E * 3);
  const pairAt = new Int32Array(R), pairMark = new Int32Array(R).fill(-1);
  let P = 0;
  for (let a = 0; a < R; a++) {
    for (let k = eStart[a], end = eStart[a + 1]; k < end; k++) {
      const b = evB[k], len = evLen[k];
      let p;
      if (pairMark[b] !== a) { pairMark[b] = a; p = pairAt[b] = P++; pA[p] = a; pB[p] = b; pLen[p] = len; }
      else { p = pairAt[b]; if (!(len > pLen[p])) continue; pLen[p] = len; }
      pDir[p * 3] = evD[k * 3] / len; pDir[p * 3 + 1] = evD[k * 3 + 1] / len; pDir[p * 3 + 2] = evD[k * 3 + 2] / len;
    }
  }

  // ── 5. distinct boundary vertices per region (only their set matters: the extent below is a
  //       min/max). A region with more than MAX_BOUNDARY_VERTS of them gets none, as before.
  const bEnd = new Int32Array(R);
  const stamp = new Int32Array(mesh.nv).fill(-1);
  for (let r = 0; r < R; r++) {
    const lo = bStart[r], hi = bStart[r + 1];
    let w = lo;
    for (let i = lo; i < hi; i++) { const id = bVerts[i]; if (stamp[id] !== r) { stamp[id] = r; bVerts[w++] = id; } }
    bEnd[r] = w - lo <= MAX_BOUNDARY_VERTS ? w : -1;
  }
  const extent = (r, qx, qy, qz) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = bStart[r], end = bEnd[r]; i < end; i++) {
      const id = bVerts[i];
      const t = verts[id * 3] * qx + verts[id * 3 + 1] * qy + verts[id * 3 + 2] * qz;
      if (t < lo) lo = t; if (t > hi) hi = t;
    }
    return hi - lo;
  };

  // ── 6. union-find over regions for curved groups
  const parent = new Int32Array(R);
  for (let i = 0; i < R; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const smoothCosMax = COPLANAR_COS, smoothCosMin = Math.cos(SMOOTH_MAX_DEG * DEG);
  for (let p = 0; p < P; p++) {
    const a = pA[p], b = pB[p];
    if (bEnd[a] < 0 || bEnd[b] < 0) continue; // a face with a huge outline is a real planar face
    const ax = rN[a * 3], ay = rN[a * 3 + 1], az = rN[a * 3 + 2], bx = rN[b * 3], by = rN[b * 3 + 1], bz = rN[b * 3 + 2];
    const d = ax * bx + ay * by + az * bz;
    if (d >= smoothCosMax || d < smoothCosMin) continue;
    const dx = pDir[p * 3], dy = pDir[p * 3 + 1], dz = pDir[p * 3 + 2];
    // q = unit(normal × shared-edge direction): across the facet, in its plane
    let qx = ay * dz - az * dy, qy = az * dx - ax * dz, qz = ax * dy - ay * dx;
    let l = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1;
    const wa = extent(a, qx / l, qy / l, qz / l);
    qx = by * dz - bz * dy; qy = bz * dx - bx * dz; qz = bx * dy - by * dx;
    l = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1;
    const wb = extent(b, qx / l, qy / l, qz / l);
    if (wa <= 0 || wb <= 0) continue;
    const ratio = Math.max(wa, wb) / Math.min(wa, wb);
    if (ratio > RADIUS_RATIO_TOL) continue;
    // Both facets must be narrow compared with their shared edge: a facet that
    // is much wider than it is long is a planar face, not a band of a cylinder.
    const fa = find(a), fb = find(b);
    if (fa !== fb) parent[fa] = fb;
  }

  // ── 7. groups, in the order of their first (lowest) region, members ascending
  const groupOf = new Int32Array(R), groupOfRoot = new Int32Array(R).fill(-1);
  let G = 0;
  const gStart = new Int32Array(R + 1);
  for (let i = 0; i < R; i++) {
    const root = find(i);
    if (groupOfRoot[root] < 0) groupOfRoot[root] = G++;
    groupOf[i] = groupOfRoot[root];
    gStart[groupOf[i] + 1]++;
  }
  for (let g = 0; g < G; g++) gStart[g + 1] += gStart[g];
  const gFill = gStart.slice(0, G), gMembers = new Int32Array(R);
  for (let i = 0; i < R; i++) gMembers[gFill[groupOf[i]]++] = i;

  // ── 8. patches
  const patches = [];
  const patchOf = new Int32Array(n).fill(-1);
  const pushPatch = (p) => { p.id = patches.length; for (const t of p.tris) patchOf[t] = p.id; patches.push(p); };
  let upper = null;      // adjacent regions with a larger id, per region (built when the first curved group needs it)
  let memberIndex = null; // region → its position among the members of the group being fitted
  let vertexMark = null;

  for (let g = 0; g < G; g++) {
    const lo = gStart[g], hi = gStart[g + 1];
    if (hi - lo === 1) {
      const r = gMembers[lo];
      pushPatch(makePlane(mesh, regionTris(r), regionNormalOf(r), rA[r]));
      continue;
    }
    const members = gMembers.subarray(lo, hi);
    const tris = [];
    for (let m = lo; m < hi; m++) { const r = gMembers[m]; for (let i = rStart[r], end = rStart[r + 1]; i < end; i++) tris.push(rTris[i]); }
    if (!upper) {
      upper = upperNeighbours(pA, pB, P, R);
      memberIndex = new Int32Array(R).fill(-1);
      vertexMark = new Int32Array(mesh.nv).fill(-1);
    }
    for (let m = lo; m < hi; m++) memberIndex[gMembers[m]] = m - lo;
    const fit = fitGroup(mesh, tris, members, { rStart, rTris, rN, rA, upper, memberIndex, vertexMark, mark: g });
    for (let m = lo; m < hi; m++) memberIndex[gMembers[m]] = -1;
    if (fit.kind === "cylinder" || fit.kind === "cone") {
      pushPatch(Object.assign(fit, { tris, area: sumArea(mesh, tris), source: "mesh" }));
    } else if (members.length <= 3) {
      for (let m = lo; m < hi; m++) { const r = gMembers[m]; pushPatch(makePlane(mesh, regionTris(r), regionNormalOf(r), rA[r])); }
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

/**
 * For every region, the adjacent regions with a larger id, ascending:
 * { start: Int32Array(R + 1), list: Int32Array } (list[start[a] .. start[a+1]]).
 */
function upperNeighbours(pA, pB, P, R) {
  const start = new Int32Array(R + 1);
  for (let p = 0; p < P; p++) start[pA[p] + 1]++;
  for (let i = 0; i < R; i++) start[i + 1] += start[i];
  const fill = start.slice(0, R);
  const list = new Int32Array(start[R]);
  for (let p = 0; p < P; p++) list[fill[pA[p]]++] = pB[p];
  for (let a = 0; a < R; a++) if (start[a + 1] - start[a] > 1) list.subarray(start[a], start[a + 1]).sort();
  return { start, list };
}

/** Unique welded vertex ids of a triangle list, in order of first appearance (`marks[id] === mark` = seen). */
function uniqueVertexIds(mesh, tris, marks, mark) {
  const out = [];
  const vidx = mesh.vidx;
  for (const t of tris) {
    for (let c = 0; c < 3; c++) { const id = vidx[t * 3 + c]; if (marks[id] !== mark) { marks[id] = mark; out.push(id); } }
  }
  return out;
}

/**
 * Fit a curved group using per-region normals (one sample per planar facet) and region adjacency pairs.
 *
 * `pairs` lists every adjacent pair of members as [index of the lower region
 * id, index of the higher], ordered by the lower id and then the higher —
 * the order the fit sums them in. It used to be found by testing every pair
 * of members against the adjacency map (members² lookups: a minute for the
 * 50,000 facets of a sphere); walking each member's sorted neighbour list
 * gives the same pairs in the same order. Pairs and vertices are only built
 * if the fit reaches the step that reads them.
 *
 * @param {Int32Array} members region ids, ascending
 * @param {object} R the flat region tables of segmentMesh()
 */
function fitGroup(mesh, tris, members, R) {
  const { rStart, rTris, rN, rA, upper, memberIndex } = R;
  const normals = [], points = [], weights = [];
  for (let i = 0; i < members.length; i++) {
    const r = members[i];
    let cx = 0, cy = 0, cz = 0;
    for (let k = rStart[r], end = rStart[r + 1]; k < end; k++) { const t = rTris[k]; cx += mesh.centroid[t * 3] * mesh.area[t]; cy += mesh.centroid[t * 3 + 1] * mesh.area[t]; cz += mesh.centroid[t * 3 + 2] * mesh.area[t]; }
    normals.push([rN[r * 3], rN[r * 3 + 1], rN[r * 3 + 2]]); points.push([cx / rA[r], cy / rA[r], cz / rA[r]]); weights.push(rA[r]);
  }
  let pairs = null, vertices = null;
  return fitCurved({
    normals, points, weights,
    get pairs() {
      if (pairs) return pairs;
      pairs = [];
      const { start, list } = upper;
      for (let i = 0; i < members.length; i++) {
        const a = members[i];
        for (let k = start[a]; k < start[a + 1]; k++) {
          const j = memberIndex[list[k]];
          if (j >= 0) pairs.push([i, j]);
        }
      }
      return pairs;
    },
    get vertices() {
      if (vertices) return vertices;
      const vertIds = uniqueVertexIds(mesh, tris, R.vertexMark, R.mark);
      vertices = vertIds.map((id) => [mesh.verts[id * 3], mesh.verts[id * 3 + 1], mesh.verts[id * 3 + 2]]);
      return vertices;
    },
  });
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
  const nb = new Array(P).fill(null); // a Map per patch that has a neighbour (most facets of a triangle soup have none)
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
      const m = nb[pa] || (nb[pa] = new Map());
      const rec = m.get(pb);
      if (rec) { rec.len += len; rec.edges.push(t * 3 + e); }
      else m.set(pb, { len, edges: [t * 3 + e] });
    }
  }
  return { neighbors: nb, boundaryLen };
}

module.exports = { segmentMesh, segmentBrep, patchAdjacency, regionVertexIds, growPlanarRegions };
