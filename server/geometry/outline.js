/**
 * Outline of the part's projection along an axis.
 *
 * Method (exact for CAD meshes, no rasterising):
 *   1. project every triangle onto the plane perpendicular to the axis;
 *   2. candidate outline segments are the edges of edge-on (vertical)
 *      triangles, edges shared by an up-facing and a down-facing triangle, and
 *      open mesh edges; duplicates and collinear overlaps are merged;
 *   3. a candidate is an outline segment iff exactly one side of it is covered
 *      by the projection (point-in-projection test on a uniform grid of the
 *      projected triangles); the covered side fixes the orientation so that
 *      material is on the left;
 *   4. segments are chained into loops: counter-clockwise loops are outer
 *      outlines, clockwise loops are cutouts.
 *
 * From the loops: outer/inner perimeter, area, bbox, smallest concave
 * (material-side) corner radius, narrowest gap (slot width).
 */
const { v } = require("./vec");

function projectionFrame(axis) {
  const a = v.norm(axis);
  const [u, w] = v.basis(a);
  return { a, u, w };
}

/**
 * @param {object} mesh
 * @param {number[]} axis
 * @returns {object} outline result
 */
function computeOutline(mesh, axis) {
  const { a, u, w } = projectionFrame(axis);
  const n = mesh.n;
  const nv = mesh.nv;
  // 2D vertex coordinates
  const px = new Float64Array(nv), py = new Float64Array(nv);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = mesh.verts[i * 3], y = mesh.verts[i * 3 + 1], z = mesh.verts[i * 3 + 2];
    px[i] = x * u[0] + y * u[1] + z * u[2];
    py[i] = x * w[0] + y * w[1] + z * w[2];
    if (px[i] < minx) minx = px[i]; if (px[i] > maxx) maxx = px[i];
    if (py[i] < miny) miny = py[i]; if (py[i] > maxy) maxy = py[i];
  }
  const size = Math.max(maxx - minx, maxy - miny) || 1;
  const eps2 = 1e-9 * size * size; // 2D area threshold for "vertical"

  // Classify triangles: +1 up (CCW in 2D), -1 down, 0 vertical
  const facing = new Int8Array(n);
  const area2 = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const i0 = mesh.vidx[t * 3], i1 = mesh.vidx[t * 3 + 1], i2 = mesh.vidx[t * 3 + 2];
    const ar = 0.5 * ((px[i1] - px[i0]) * (py[i2] - py[i0]) - (py[i1] - py[i0]) * (px[i2] - px[i0]));
    area2[t] = ar;
    const nd = mesh.normal[t * 3] * a[0] + mesh.normal[t * 3 + 1] * a[1] + mesh.normal[t * 3 + 2] * a[2];
    facing[t] = Math.abs(ar) <= eps2 || Math.abs(nd) < 1e-6 ? 0 : (nd > 0 ? 1 : -1);
  }

  // Candidate segments keyed by quantised 2D endpoints
  const q = 1e6 / size;
  const segMap = new Map();
  const addSeg = (ia, ib) => {
    const ax = px[ia], ay = py[ia], bx = px[ib], by = py[ib];
    const ka = Math.round((ax - minx) * q) * 4194304 + Math.round((ay - miny) * q);
    const kb = Math.round((bx - minx) * q) * 4194304 + Math.round((by - miny) * q);
    if (ka === kb) return;
    const key = ka < kb ? ka + ":" + kb : kb + ":" + ka;
    if (!segMap.has(key)) segMap.set(key, ka < kb ? [ax, ay, bx, by] : [bx, by, ax, ay]);
  };
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const o = mesh.adj[t * 3 + e];
      const ia = mesh.vidx[t * 3 + e], ib = mesh.vidx[t * 3 + ((e + 1) % 3)];
      if (facing[t] === 0) { addSeg(ia, ib); continue; }
      if (o < 0) { addSeg(ia, ib); continue; }
      if (o < t) continue; // handled from the other side
      if (facing[o] === 0 || facing[o] !== facing[t]) addSeg(ia, ib);
    }
  }
  let segs = mergeCollinear(Array.from(segMap.values()), size);

  // Coverage grid of non-vertical triangles
  const grid = buildGrid(mesh, px, py, facing, minx, miny, maxx, maxy);
  // Probe distance from the segment: far smaller than the sagitta of any
  // tessellation chord (which is what separates a real outline edge from a
  // chord that merely skips a vertex of a staggered band), yet far above
  // double-precision noise on coordinates of this magnitude.
  const delta = Math.max(1e-8 * size, 1e-6);
  const oriented = [];
  for (const s of segs) {
    const dx = s[2] - s[0], dy = s[3] - s[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = -dy / len, ny = dx / len; // left normal
    const mx = (s[0] + s[2]) / 2, my = (s[1] + s[3]) / 2;
    const leftIn = grid.covered(mx + nx * delta, my + ny * delta);
    const rightIn = grid.covered(mx - nx * delta, my - ny * delta);
    if (leftIn === rightIn) continue;
    // material on the left
    if (leftIn) oriented.push([s[0], s[1], s[2], s[3]]);
    else oriented.push([s[2], s[3], s[0], s[1]]);
  }

  let loops = chainLoops(oriented, size);
  // Open fragments much shorter than the main outline are tessellation noise
  // (chords of staggered bands), not geometry.
  const longestClosed = loops.reduce((m, L) => (L.closed && L.length > m ? L.length : m), 0);
  const dropped = loops.filter((L) => !L.closed && L.length < 0.01 * longestClosed);
  loops = loops.filter((L) => !dropped.includes(L));
  let outerPerimeter = 0, innerPerimeter = 0, areaSum = 0;
  const outer = [], inner = [];
  for (const L of loops) {
    const A = polyArea(L.pts);
    areaSum += A;
    if (L.closed && A < 0) { inner.push(L); innerPerimeter += L.length; }
    else { outer.push(L); outerPerimeter += L.length; }
  }
  // If chaining failed badly, fall back to raw segment sums (area from grid estimate)
  const closedAll = loops.every((L) => L.closed);
  let minInternalRadius = null, minSlotWidth = null;
  for (const L of loops) {
    if (!L.closed) continue;
    // Round holes are reported in `holes` with their diameters; they are not
    // outline corner radii or slot widths.
    const A = Math.abs(polyArea(L.pts));
    if (polyArea(L.pts) < 0 && L.length > 0 && (4 * Math.PI * A) / (L.length * L.length) >= 0.95) continue;
    const r = loopMinConcaveRadius(L.pts);
    if (r !== null) minInternalRadius = minInternalRadius === null ? r : Math.min(minInternalRadius, r);
    const g = loopMinGap(L.pts, size);
    if (g !== null) minSlotWidth = minSlotWidth === null ? g : Math.min(minSlotWidth, g);
  }

  return {
    axis: a, u, w,
    area: Math.max(0, areaSum),
    perimeter: outerPerimeter,
    innerPerimeter,
    bboxW: maxx - minx, bboxH: maxy - miny,
    minInternalRadius, minSlotWidth,
    loops: loops.map((L) => ({ pts: L.pts, closed: L.closed, length: L.length, area: polyArea(L.pts), outer: polyArea(L.pts) >= 0 })),
    outerCount: outer.length, innerCount: inner.length,
    closed: closedAll,
    segmentCount: oriented.length,
    droppedFragments: dropped.length,
  };
}

/** Merge collinear overlapping segments (same line, overlapping parameter ranges). */
function mergeCollinear(segs, size) {
  const groups = new Map();
  const angQ = 1e4, offQ = 1e5 / size;
  for (const s of segs) {
    let dx = s[2] - s[0], dy = s[3] - s[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) continue;
    dx /= len; dy /= len;
    if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
    const ang = Math.atan2(dy, dx);
    const off = -dy * s[0] + dx * s[1]; // perpendicular offset of the line
    const key = Math.round(ang * angQ) + ":" + Math.round(off * offQ);
    const t0 = dx * s[0] + dy * s[1], t1 = dx * s[2] + dy * s[3];
    let g = groups.get(key);
    if (!g) { g = { dx, dy, off, items: [] }; groups.set(key, g); }
    g.items.push([Math.min(t0, t1), Math.max(t0, t1)]);
  }
  const out = [];
  for (const g of groups.values()) {
    g.items.sort((p, q) => p[0] - q[0]);
    let cur = g.items[0].slice();
    const emit = (iv) => {
      // reconstruct endpoints: p = t * d + off * n  (n = (-dy, dx))
      const nx = -g.dy, ny = g.dx;
      out.push([iv[0] * g.dx + g.off * nx, iv[0] * g.dy + g.off * ny, iv[1] * g.dx + g.off * nx, iv[1] * g.dy + g.off * ny]);
    };
    for (let i = 1; i < g.items.length; i++) {
      const it = g.items[i];
      if (it[0] <= cur[1] + 1e-7 * size) cur[1] = Math.max(cur[1], it[1]);
      else { emit(cur); cur = it.slice(); }
    }
    emit(cur);
  }
  return out;
}

/** Uniform grid over projected non-vertical triangles for point coverage tests. */
function buildGrid(mesh, px, py, facing, minx, miny, maxx, maxy) {
  let count = 0;
  for (let t = 0; t < mesh.n; t++) if (facing[t] !== 0) count++;
  const cells = Math.max(8, Math.min(1024, Math.ceil(Math.sqrt(count / 2))));
  const W = (maxx - minx) || 1, H = (maxy - miny) || 1;
  const cellW = W / cells, cellH = H / cells;
  const buckets = new Array(cells * cells);
  for (let t = 0; t < mesh.n; t++) {
    if (facing[t] === 0) continue;
    const i0 = mesh.vidx[t * 3], i1 = mesh.vidx[t * 3 + 1], i2 = mesh.vidx[t * 3 + 2];
    const x0 = Math.min(px[i0], px[i1], px[i2]), x1 = Math.max(px[i0], px[i1], px[i2]);
    const y0 = Math.min(py[i0], py[i1], py[i2]), y1 = Math.max(py[i0], py[i1], py[i2]);
    const cx0 = clampCell((x0 - minx) / cellW, cells), cx1 = clampCell((x1 - minx) / cellW, cells);
    const cy0 = clampCell((y0 - miny) / cellH, cells), cy1 = clampCell((y1 - miny) / cellH, cells);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const k = cy * cells + cx;
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(t);
    }
  }
  const covered = (x, y) => {
    if (x < minx || x > maxx || y < miny || y > maxy) return false;
    const k = clampCell((y - miny) / cellH, cells) * cells + clampCell((x - minx) / cellW, cells);
    const b = buckets[k];
    if (!b) return false;
    for (const t of b) {
      const i0 = mesh.vidx[t * 3], i1 = mesh.vidx[t * 3 + 1], i2 = mesh.vidx[t * 3 + 2];
      if (pointInTri(x, y, px[i0], py[i0], px[i1], py[i1], px[i2], py[i2])) return true;
    }
    return false;
  };
  return { covered };
}

function clampCell(f, cells) { return Math.max(0, Math.min(cells - 1, Math.floor(f))); }

function pointInTri(x, y, x0, y0, x1, y1, x2, y2) {
  const d0 = (x1 - x0) * (y - y0) - (y1 - y0) * (x - x0);
  const d1 = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
  const d2 = (x0 - x2) * (y - y2) - (y0 - y2) * (x - x2);
  const neg = d0 < 0 || d1 < 0 || d2 < 0;
  const pos = d0 > 0 || d1 > 0 || d2 > 0;
  return !(neg && pos);
}

/** Chain oriented segments into loops by endpoint matching. */
function chainLoops(segs, size) {
  const q = 1e6 / size;
  const key = (x, y) => Math.round(x * q) + ":" + Math.round(y * q);
  const outgoing = new Map();
  segs.forEach((s, i) => {
    const k = key(s[0], s[1]);
    if (!outgoing.has(k)) outgoing.set(k, []);
    outgoing.get(k).push(i);
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const pts = [[segs[i][0], segs[i][1]]];
    let cur = i, length = 0, closed = false;
    const startKey = key(segs[i][0], segs[i][1]);
    for (let guard = 0; guard < segs.length + 1; guard++) {
      used[cur] = 1;
      const s = segs[cur];
      length += Math.hypot(s[2] - s[0], s[3] - s[1]);
      const k = key(s[2], s[3]);
      if (k === startKey) { closed = true; break; }
      pts.push([s[2], s[3]]);
      const cands = (outgoing.get(k) || []).filter((j) => !used[j]);
      if (cands.length === 0) break;
      let next = cands[0];
      if (cands.length > 1) {
        // prefer the sharpest right turn (keeps material on the left at junctions)
        const dx = s[2] - s[0], dy = s[3] - s[1];
        let best = -Infinity;
        for (const j of cands) {
          const ex = segs[j][2] - segs[j][0], ey = segs[j][3] - segs[j][1];
          const turn = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
          if (-turn > best) { best = -turn; next = j; }
        }
      }
      cur = next;
    }
    loops.push({ pts, closed, length });
  }
  return loops;
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Smallest concave (material-side) corner radius of a loop oriented with
 * material on the left: right turns are concave corners. A single right turn
 * sharper than 30 deg is a sharp corner (radius 0); runs of gentle right turns
 * are arcs whose radius is chord / (2 sin(theta/2)).
 */
function loopMinConcaveRadius(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let minR = null;
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    const ax = c[0] - p[0], ay = c[1] - p[1], bx = q[0] - c[0], by = q[1] - c[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-12 || lb < 1e-12) continue;
    const cross = ax * by - ay * bx, dot = ax * bx + ay * by;
    const turn = Math.atan2(cross, dot); // >0 left, <0 right
    if (turn >= -1e-6) continue;
    const theta = -turn;
    let r;
    if (theta > 30 * Math.PI / 180) r = 0;
    else r = ((la + lb) / 2) / (2 * Math.sin(theta / 2));
    if (minR === null || r < minR) minR = r;
  }
  return minR;
}

/**
 * Narrowest gap across the non-material side of a loop: from each vertex cast
 * a ray to the right (away from material) and find the nearest crossing with
 * the same loop (ignoring the two edges at the vertex).
 */
function loopMinGap(pts, size) {
  const n = pts.length;
  if (n < 4) return null;
  let best = null;
  const step = Math.max(1, Math.floor(n / 400));
  for (let i = 0; i < n; i += step) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    // outward (right) normal of the average direction at the vertex
    let dx = (c[0] - p[0]) + (q[0] - c[0]), dy = (c[1] - p[1]) + (q[1] - c[1]);
    const l = Math.hypot(dx, dy);
    if (l < 1e-12) continue;
    dx /= l; dy /= l;
    const rx = dy, ry = -dx; // right normal
    let tBest = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i || j === (i - 1 + n) % n) continue;
      const a = pts[j], b = pts[(j + 1) % n];
      const t = raySegment(c[0], c[1], rx, ry, a[0], a[1], b[0], b[1]);
      if (t !== null && t > 1e-6 * size && t < tBest) tBest = t;
    }
    if (tBest < Infinity && (best === null || tBest < best)) best = tBest;
  }
  return best;
}

function raySegment(ox, oy, dx, dy, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((ax - ox) * ey - (ay - oy) * ex) / den;
  const s = ((ax - ox) * dy - (ay - oy) * dx) / den;
  if (t < 0 || s < 0 || s > 1) return null;
  return t;
}

module.exports = { computeOutline, projectionFrame, loopMinConcaveRadius, loopMinGap, polyArea, chainLoops };
