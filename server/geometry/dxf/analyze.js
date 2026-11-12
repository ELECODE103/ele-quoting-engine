/**
 * 2D profile analysis — curves (mm, from parse.js) → closed loops, roles and
 * the measurements the routing models need.
 *
 *   const profile = analyseCurves(curves);
 *
 * Steps:
 *   1. explode polylines to primitives, drop zero-length ones, remove exact
 *      duplicates, merge overlapping collinear lines (each is reported — a
 *      duplicate would be cut twice);
 *   2. chain open curves into loops by endpoint (WELD_TOL_MM); ends that do
 *      not meet, and points where three or more curves meet, are reported
 *      with their location and the gap to the nearest other loose end;
 *   3. measure every loop exactly (arcs are analytic): perimeter, signed area,
 *      bounding box; zero-area slivers are set aside;
 *   4. classify by containment: depth 0 = outer profile, depth 1 = cutout,
 *      depth 2+ = a shape inside a cutout (another part);
 *   5. find crossings (a contour crossing itself or another contour);
 *   6. features: round holes (diameter, centre), elongated cutouts (slots),
 *      smallest inside-corner radius, narrowest cutout / notch, narrowest web
 *      of material between cuts and to the edge — each with a location.
 *
 * Coordinates in the result are mm with the origin at the lower-left corner
 * of the part's bounding box, so locations read naturally in a DFM message.
 */

const WELD_TOL_MM = 0.02;        // endpoints closer than this are the same point
const PREVIEW_TOL_MM = 0.01;     // chord error of the flattened arcs (preview + ray tests)
const SLIVER_WIDTH_MM = 0.02;    // area / perimeter below this = a zero-area loop
const MAX_MARKS = 40;
const TAU = Math.PI * 2;

const { CoverGrid, SegmentIndex, LoopIndex, Buckets, usable } = require("./spatial");

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

// ─── primitives ──────────────────────────────────────────────────────────────
function segLength(s) { return s.k === "L" ? dist(s.a, s.b) : s.r * Math.abs(s.sweep); }
function reverseSeg(s) {
  if (s.k === "L") return { k: "L", a: s.b, b: s.a };
  return { k: "A", c: s.c, r: s.r, a0: s.a0 + s.sweep, sweep: -s.sweep, a: s.b, b: s.a };
}
/** ½∮(x dy − y dx) contribution of one primitive. */
function segArea2(s) {
  if (s.k === "L") return s.a[0] * s.b[1] - s.b[0] * s.a[1];
  return s.r * s.r * s.sweep + s.c[0] * (s.b[1] - s.a[1]) - s.c[1] * (s.b[0] - s.a[0]);
}
function segPoint(s, t) {
  if (s.k === "L") return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
  const a = s.a0 + s.sweep * t;
  return [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)];
}
/** Unit tangent at the start (t = 0) or end (t = 1) of a primitive, in travel direction. */
function segTangent(s, atEnd) {
  if (s.k === "L") { const l = dist(s.a, s.b) || 1; return [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l]; }
  const a = s.a0 + (atEnd ? s.sweep : 0), d = s.sweep >= 0 ? 1 : -1;
  return [-Math.sin(a) * d, Math.cos(a) * d];
}
function segBBox(s, bb) {
  const grow = (p) => { if (p[0] < bb[0]) bb[0] = p[0]; if (p[1] < bb[1]) bb[1] = p[1]; if (p[0] > bb[2]) bb[2] = p[0]; if (p[1] > bb[3]) bb[3] = p[1]; };
  grow(s.a); grow(s.b);
  if (s.k === "A") {
    const lo = Math.min(s.a0, s.a0 + s.sweep), hi = Math.max(s.a0, s.a0 + s.sweep);
    for (let q = Math.ceil(lo / (Math.PI / 2)); q * (Math.PI / 2) <= hi; q++) {
      const a = q * (Math.PI / 2);
      grow([s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]);
    }
  }
}
function flattenSeg(s, out) {
  if (s.k === "L") { out.push(s.b); return; }
  const step = 2 * Math.acos(Math.max(-1, 1 - Math.min(PREVIEW_TOL_MM, s.r) / s.r));
  const n = Math.max(2, Math.min(720, Math.ceil(Math.abs(s.sweep) / Math.max(step, 1e-3))));
  for (let i = 1; i <= n; i++) out.push(i === n ? s.b : segPoint(s, i / n));
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// ─── 1. clean-up: degenerate, duplicate, overlapping ─────────────────────────
function cleanCurves(curves) {
  const problems = [];
  let degenerate = 0;
  const q = (x) => Math.round(x / WELD_TOL_MM);
  const pkey = (p) => `${q(p[0])},${q(p[1])}`;
  const seen = new Map();
  const kept = [];
  let duplicates = 0;
  // Work on single primitives so a LINE drawn over one edge of a polyline is
  // seen as the duplicate it is; loops are rebuilt by chaining afterwards.
  // (A full circle stays whole.)
  const exploded = [];
  let slivers = 0;
  for (const c of curves) {
    if (c.segs.length > 1 && (c.closed || dist(c.segs[0].a, c.segs[c.segs.length - 1].b) <= WELD_TOL_MM)) {
      // a closed polyline with no area (a line traced back over itself) — set aside before it is exploded
      let a2 = 0, per = 0;
      for (const sg of c.segs) { a2 += segArea2(sg); per += segLength(sg); }
      if (per > WELD_TOL_MM && Math.abs(a2 / 2) < per * SLIVER_WIDTH_MM && !chordsCross(c.segs)) {
        slivers++;
        if (problems.length < MAX_MARKS) problems.push({ code: "sliver", at: c.segs[0].a, length: per });
        continue;
      }
    }
    if (c.segs.length === 1) exploded.push(c);
    else for (const s of c.segs) exploded.push({ segs: [s], closed: false, layer: c.layer, src: c.src, approx: c.approx });
  }
  // Two primitives are duplicates when their quantised end points (in either order), mid point,
  // primitive count and length agree. That used to be one string key per primitive; a spline
  // flattened to hundreds of chords made millions of them. The eight numbers are now hashed and
  // compared as numbers (a key with a non-finite number keeps the string form).
  const key = new Float64Array(8), seenKey = new Float64Array(8);
  const keyOf = (c, len, mid, out) => {
    const a = c.segs[0].a, b = c.segs[c.segs.length - 1].b;
    let ax = q(a[0]), ay = q(a[1]), bx = q(b[0]), by = q(b[1]);
    if (bx < ax || (bx === ax && by < ay)) { let t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; } // unordered pair of ends
    out[0] = ax; out[1] = ay; out[2] = bx; out[3] = by;
    out[4] = q(mid[0]); out[5] = q(mid[1]); out[6] = c.segs.length; out[7] = Math.round(len / WELD_TOL_MM);
    let h = 0, finite = true;
    for (let i = 0; i < 8; i++) {
      const v = out[i];
      if (!Number.isFinite(v)) finite = false;
      h = Math.imul(h ^ (v | 0), 0x9e3779b1) ^ Math.imul((v / 4294967296) | 0, 0x85ebca6b);
      h = (h << 13) | (h >>> 19);
    }
    return finite ? h : null;
  };
  const curveLength = (c) => c.segs.reduce((s, x) => s + segLength(x), 0);
  const curveMid = (c) => segPoint(c.segs[Math.floor(c.segs.length / 2)], 0.5);
  let tableSize = 16;
  while (tableSize < exploded.length * 2) tableSize *= 2;
  const table = new Int32Array(tableSize).fill(-1); // slot → index in `kept`
  const keptHash = new Int32Array(exploded.length);
  for (const c of exploded) {
    const len = curveLength(c);
    if (!(len > WELD_TOL_MM)) { degenerate++; continue; }
    const mid = curveMid(c);
    const h = keyOf(c, len, mid, key);
    let duplicate = false, slot = -1;
    if (h === null) {
      const first = c.segs[0], lastSeg = c.segs[c.segs.length - 1];
      const ends = [pkey(first.a), pkey(lastSeg.b)].sort();
      const text = `${ends[0]}|${ends[1]}|${pkey(mid)}|${c.segs.length}|${Math.round(len / WELD_TOL_MM)}`;
      duplicate = seen.has(text);
      if (!duplicate) seen.set(text, true);
    } else {
      slot = h & (tableSize - 1);
      for (; table[slot] >= 0; slot = (slot + 1) & (tableSize - 1)) {
        const k = table[slot];
        if (keptHash[k] !== h) continue;
        const o = kept[k];
        keyOf(o, curveLength(o), curveMid(o), seenKey);
        let same = true;
        for (let i = 0; i < 8 && same; i++) same = key[i] === seenKey[i];
        if (same) { duplicate = true; break; }
      }
    }
    if (duplicate) { duplicates++; if (problems.length < MAX_MARKS) problems.push({ code: "duplicate", at: mid, layer: c.layer }); continue; }
    if (slot >= 0) { table[slot] = kept.length; keptHash[kept.length] = h; }
    kept.push(c);
  }

  // Overlapping collinear single lines: merge each overlapping run into one line.
  // Lines are grouped by (direction, offset) bucket: a map per direction bucket keyed by the
  // offset bucket, and the groups listed in the order they were first seen (the order the merged
  // lines are emitted in).
  const byAngle = new Map();
  const groups = [];
  const others = [];
  for (const c of kept) {
    if (c.segs.length !== 1 || c.segs[0].k !== "L" || c.closed) { others.push(c); continue; }
    const s = c.segs[0];
    let dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    const len = Math.hypot(dx, dy);
    dx /= len; dy /= len;
    if (dx < -1e-12 || (Math.abs(dx) <= 1e-12 && dy < 0)) { dx = -dx; dy = -dy; }
    const off = -dy * s.a[0] + dx * s.a[1];
    const angleKey = Math.round(Math.atan2(dy, dx) * 1e4), offsetKey = Math.round(off / WELD_TOL_MM);
    const t0 = dx * s.a[0] + dy * s.a[1], t1 = dx * s.b[0] + dy * s.b[1];
    let byOffset = byAngle.get(angleKey);
    if (!byOffset) { byOffset = new Map(); byAngle.set(angleKey, byOffset); }
    let g = byOffset.get(offsetKey);
    if (!g) { g = { dx, dy, off, items: [] }; byOffset.set(offsetKey, g); groups.push(g); }
    g.items.push({ lo: Math.min(t0, t1), hi: Math.max(t0, t1), c });
  }
  let overlaps = 0;
  const lines = [];
  for (const g of groups) {
    g.items.sort((a, b) => a.lo - b.lo);
    let run = [g.items[0]], hi = g.items[0].hi;
    const flush = () => {
      if (run.length === 1) { lines.push(run[0].c); return; }
      overlaps += run.length - 1;
      const lo = run[0].lo;
      const at = (t) => [t * g.dx - g.off * g.dy, t * g.dy + g.off * g.dx];
      if (problems.length < MAX_MARKS) problems.push({ code: "overlap", at: at((run[1].lo + Math.min(run[0].hi, run[1].hi)) / 2), layer: run[0].c.layer });
      lines.push({ ...run[0].c, segs: [{ k: "L", a: at(lo), b: at(hi) }] });
    };
    for (let i = 1; i < g.items.length; i++) {
      const it = g.items[i];
      if (it.lo < hi - 10 * WELD_TOL_MM) { run.push(it); hi = Math.max(hi, it.hi); }
      else { flush(); run = [it]; hi = it.hi; }
    }
    flush();
  }
  return { curves: others.concat(lines), problems, degenerate, duplicates, overlaps, slivers };
}

/** Does a closed path cross itself? (chords of its primitives; a figure-eight has no net area but is not a sliver) */
function chordsCross(segs) {
  const n = segs.length;
  if (n < 4 || n > 400) return false;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (properCross(segs[i].a, segs[i].b, segs[j].a, segs[j].b)) return true;
  }
  return false;
}

// ─── 2. chaining ─────────────────────────────────────────────────────────────
function chain(curves) {
  const loops = [];   // { segs, closed }
  const open = [];
  for (const c of curves) {
    const a = c.segs[0].a, b = c.segs[c.segs.length - 1].b;
    if (c.closed || dist(a, b) <= WELD_TOL_MM) loops.push({ segs: c.segs, closed: true, approx: !!c.approx });
    else open.push(c);
  }
  // Cluster the open ends (union-find over a grid with 3×3 neighbourhood lookup).
  // End 2i is the start of open curve i, end 2i + 1 its finish.
  const endCount = open.length * 2;
  const endPoint = (i) => { const c = open[i >> 1]; return i & 1 ? c.segs[c.segs.length - 1].b : c.segs[0].a; };
  const parent = new Int32Array(endCount);
  for (let i = 0; i < endCount; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const cell = WELD_TOL_MM;
  const weld2 = WELD_TOL_MM * WELD_TOL_MM * (1 + 1e-9);
  const weld = (i, p, j) => {
    const o = endPoint(j), ex = o[0] - p[0], ey = o[1] - p[1];
    if (ex * ex + ey * ey > weld2) return; // clearly apart: the exact test below would say so too
    if (dist(o, p) <= WELD_TOL_MM) parent[find(i)] = find(j);
  };
  // cell → ends. When the cell indices fit 32-bit integers (coordinates within ±40 km) the cells
  // live in an open-addressing table with the ends of a cell chained through `nextEnd`; otherwise
  // in a Map keyed by text, as before. Which ends share a cluster does not depend on the order
  // they are met in.
  let intCells = true;
  for (let i = 0; i < endCount && intCells; i++) { const p = endPoint(i); intCells = Math.abs(p[0]) < 4e7 && Math.abs(p[1]) < 4e7; }
  if (intCells) {
    let cap = 16;
    while (cap < endCount * 2) cap *= 2;
    const mask = cap - 1;
    const slotX = new Int32Array(cap), slotY = new Int32Array(cap), head = new Int32Array(cap).fill(-1), nextEnd = new Int32Array(endCount);
    for (let i = 0; i < endCount; i++) {
      const p = endPoint(i);
      const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const x = cx + dx, y = cy + dy;
        let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & mask;
        while (head[h] !== -1 && (slotX[h] !== x || slotY[h] !== y)) h = (h + 1) & mask;
        for (let j = head[h]; j !== -1; j = nextEnd[j]) weld(i, p, j);
      }
      let h = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & mask;
      while (head[h] !== -1 && (slotX[h] !== cx || slotY[h] !== cy)) h = (h + 1) & mask;
      if (head[h] === -1) { slotX[h] = cx; slotY[h] = cy; }
      nextEnd[i] = head[h]; head[h] = i;
    }
  } else {
    const grid = new Map();
    for (let i = 0; i < endCount; i++) {
      const p = endPoint(i);
      const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const b = grid.get(`${cx + dx},${cy + dy}`);
        if (b) for (const j of b) weld(i, p, j);
      }
      const k = `${cx},${cy}`;
      const here = grid.get(k);
      if (here) here.push(i); else grid.set(k, [i]);
    }
  }
  // Nodes (clusters of ends): size, and for a node of exactly two ends, each end's partner.
  const root = new Int32Array(endCount), nodeSize = new Int32Array(endCount), nodeFirst = new Int32Array(endCount).fill(-1), partner = new Int32Array(endCount).fill(-1);
  for (let i = 0; i < endCount; i++) { const r = find(i); root[i] = r; nodeSize[r]++; }
  const junctions = [];
  for (let i = 0; i < endCount; i++) {
    const r = root[i];
    if (nodeFirst[r] < 0) { nodeFirst[r] = i; if (nodeSize[r] > 2) junctions.push(endPoint(i)); } // nodes in order of their first end
    else if (nodeSize[r] === 2) { partner[i] = nodeFirst[r]; partner[nodeFirst[r]] = i; }
  }
  const degree = (i) => nodeSize[root[i]];

  const used = new Uint8Array(open.length);
  const openChains = [];
  const walkFrom = (startCurve, startEnd) => {
    // travel along startCurve entering at startEnd (0 = from its start), keep going through degree-2 nodes
    const segs = [];
    let ci = startCurve, enter = startEnd, approx = false;
    for (;;) {
      used[ci] = 1;
      const c = open[ci];
      approx = approx || !!c.approx;
      if (enter === 0) for (let k = 0; k < c.segs.length; k++) segs.push(c.segs[k]); else for (let k = c.segs.length - 1; k >= 0; k--) segs.push(reverseSeg(c.segs[k]));
      const exitIdx = ci * 2 + (enter === 0 ? 1 : 0);
      if (degree(exitIdx) !== 2) return { segs, closed: false, approx };
      const other = partner[exitIdx];
      const oc = other >> 1, oe = other & 1;
      if (oc === startCurve && oe === startEnd) return { segs, closed: true, approx };
      if (used[oc]) return { segs, closed: false, approx };
      ci = oc; enter = oe;
    }
  };
  // Start open chains at loose ends / junctions first so they are walked end to end
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    for (const e of [0, 1]) {
      if (used[i]) break;
      if (degree(i * 2 + e) !== 2) openChains.push(walkFrom(i, e));
    }
  }
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    const r = walkFrom(i, 0);
    if (r.closed) loops.push(r); else openChains.push(r);
  }
  // snap welded joints so consecutive primitives share exact points (keeps area exact)
  for (const L of loops) {
    for (let i = 0; i < L.segs.length; i++) {
      const s = L.segs[i], nx = L.segs[(i + 1) % L.segs.length];
      if (s.b !== nx.a && dist(s.b, nx.a) <= WELD_TOL_MM * 2) {
        if (nx.k === "L") L.segs[(i + 1) % L.segs.length] = { k: "L", a: s.b, b: nx.b };
        else if (s.k === "L") L.segs[i] = { k: "L", a: s.a, b: nx.a };
      }
    }
  }
  return { loops, openChains, junctions };
}

// ─── segment intersection (grid accelerated) ─────────────────────────────────
function properCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  const eps = 1e-9 * (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) + 1) * (Math.abs(d[0] - c[0]) + Math.abs(d[1] - c[1]) + 1);
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) {
    const t = d1 / (d1 - d2);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  return null;
}
const MAX_CROSSINGS = 200;

/**
 * Crossings between segments of the flattened loops: the first MAX_CROSSINGS
 * found, in the order the scan below finds them.
 *
 * The scan (crossingsScan) buckets every segment into each cell of its
 * bounding box on a coarse grid and tests every pair that shares a cell; a
 * few thousand long lines share thousands of cells per pair, which made it
 * billions of look-ups. crossingsIndexed returns the same list without
 * visiting the pairs cell by cell; it is used whenever the drawing's extent
 * is within the range its margins are proven for.
 */
function findCrossings(loops, bbox, force) {
  const segs = [];
  loops.forEach((L, li) => {
    const n = L.pts.length, m = L.closed ? n : n - 1;
    for (let i = 0; i < m; i++) segs.push({ a: L.pts[i], b: L.pts[(i + 1) % n], loop: li, i, n: m, closed: L.closed });
  });
  const out = [];
  if (segs.length < 2) return out;
  if (force === "scan" || (force !== "indexed" && !usable(bbox))) return crossingsScan(segs, bbox, out);
  return crossingsIndexed(segs, bbox, out);
}

/** The original exhaustive scan. Its visiting order defines the order of the result. */
function crossingsScan(segs, bbox, out) {
  const w = bbox[2] - bbox[0] || 1, h = bbox[3] - bbox[1] || 1;
  const cells = Math.max(4, Math.min(256, Math.ceil(Math.sqrt(segs.length))));
  const cw = w / cells, ch = h / cells;
  const buckets = new Map();
  const cl = (v) => Math.max(0, Math.min(cells - 1, v));
  const seenPair = new Set();
  segs.forEach((s, si) => {
    const x0 = cl(Math.floor((Math.min(s.a[0], s.b[0]) - bbox[0]) / cw)), x1 = cl(Math.floor((Math.max(s.a[0], s.b[0]) - bbox[0]) / cw));
    const y0 = cl(Math.floor((Math.min(s.a[1], s.b[1]) - bbox[1]) / ch)), y1 = cl(Math.floor((Math.max(s.a[1], s.b[1]) - bbox[1]) / ch));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = y * cells + x;
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      for (const sj of b) {
        const t = segs[sj];
        if (t.loop === s.loop) {
          const d = Math.abs(t.i - s.i);
          if (d <= 1 || (s.closed && d === s.n - 1)) continue; // neighbours share a vertex
        }
        const pk = sj * segs.length + si;
        if (seenPair.has(pk)) continue;
        seenPair.add(pk);
        const p = properCross(s.a, s.b, t.a, t.b);
        if (p && out.length < MAX_CROSSINGS) out.push({ at: p, self: t.loop === s.loop, loops: [t.loop, s.loop] });
      }
      b.push(si);
    }
  });
  return out;
}

/**
 * Same result as crossingsScan.
 *
 * What the scan reports. For segment si (ascending) it meets each earlier
 * segment sj at the first cell, in its own row-by-row walk, that both
 * bounding boxes cover — row max(y0, Y0), column max(x0, X0) of the coarse
 * grid — and inside a cell in ascending sj. Every pair whose boxes share a
 * cell is tested once with properCross(); the first MAX_CROSSINGS hits are
 * kept. So the result is: for si ascending, the earlier segments that
 * properCross() says it crosses, ordered by (that row, that column, sj),
 * until MAX_CROSSINGS are found. Nothing after that changes the result, so
 * the search stops there.
 *
 * Finding those segments. properCross() returns a point only when its four
 * orientation values pass its own tolerance, 1e-9 × (length + 1)², with
 * opposite signs; each value carries a rounding error below
 * 4.1 × 2⁻⁵³ × extent × length, which is under that tolerance for any extent
 * up to 2 × 10⁶ mm (`usable()` allows 10⁶). So a reported crossing is a real
 * one: the two segments meet at a point, their bounding boxes overlap (the
 * scan tests the pair) and both pass through the cell that holds the point
 * (the conservative covers below both contain it). Candidates therefore come
 * from a fine grid of covers; properCross() itself decides, exactly as before.
 */
function crossingsIndexed(segs, bbox, out) {
  const n = segs.length;
  // the scan's coarse grid: only the first shared cell of a pair is needed, for the ordering
  const w = bbox[2] - bbox[0] || 1, h = bbox[3] - bbox[1] || 1;
  const cells = Math.max(4, Math.min(256, Math.ceil(Math.sqrt(n))));
  const cw = w / cells, ch = h / cells;
  const cl = (v) => Math.max(0, Math.min(cells - 1, v));
  const X0 = new Int32Array(n), Y0 = new Int32Array(n);
  let reach = 0; // total length in the larger coordinate, to size the fine grid
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    X0[i] = cl(Math.floor((Math.min(s.a[0], s.b[0]) - bbox[0]) / cw));
    Y0[i] = cl(Math.floor((Math.min(s.a[1], s.b[1]) - bbox[1]) / ch));
    reach += Math.max(Math.abs(s.b[0] - s.a[0]), Math.abs(s.b[1] - s.a[1]));
  }
  let across = Math.max(16, Math.min(1024, Math.ceil(Math.sqrt(n))));
  const extent = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1], 1e-9);
  while (across > 16 && (reach / extent) * across * 3 + 4 * n > 8000000) across >>= 1; // keep the covers to a few million cells
  const grid = new CoverGrid(bbox, across);
  const buckets = new Array(grid.size);
  const stamp = new Int32Array(n).fill(-1);
  const hits = [];
  for (let si = 0; si < n; si++) {
    const s = segs[si];
    hits.length = 0;
    grid.coverSegment(s.a[0], s.a[1], s.b[0], s.b[1], (c) => {
      const b = buckets[c];
      if (!b) return;
      for (let k = 0; k < b.length; k++) {
        const sj = b[k];
        if (stamp[sj] === si) continue;
        stamp[sj] = si;
        const t = segs[sj];
        if (t.loop === s.loop) {
          const d = Math.abs(t.i - s.i);
          if (d <= 1 || (s.closed && d === s.n - 1)) continue; // neighbours share a vertex
        }
        const p = properCross(s.a, s.b, t.a, t.b);
        if (p) hits.push({ row: Math.max(Y0[si], Y0[sj]), col: Math.max(X0[si], X0[sj]), sj, p });
      }
    });
    if (hits.length > 1) hits.sort((p, q) => p.row - q.row || p.col - q.col || p.sj - q.sj);
    for (const hit of hits) {
      if (out.length >= MAX_CROSSINGS) break;
      const t = segs[hit.sj];
      out.push({ at: hit.p, self: t.loop === s.loop, loops: [t.loop, s.loop] });
    }
    if (out.length >= MAX_CROSSINGS) break;
    grid.coverSegment(s.a[0], s.a[1], s.b[0], s.b[1], (c) => {
      const b = buckets[c];
      if (b) b.push(si); else buckets[c] = [si];
    });
  }
  return out;
}

// ─── ray casting for gaps and webs ───────────────────────────────────────────
function raySeg(ox, oy, dx, dy, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((a[0] - ox) * ey - (a[1] - oy) * ex) / den;
  const s = ((a[0] - ox) * dy - (a[1] - oy) * dx) / den;
  if (t < 0 || s < -1e-9 || s > 1 + 1e-9) return null;
  return t;
}
/** Sample points along a loop with the unit travel direction at each. */
function samples(L, budget) {
  const out = [];
  const n = L.pts.length;
  const step = Math.max(1, Math.ceil(n / budget));
  for (let i = 0; i < n; i += step) {
    const a = L.pts[i], b = L.pts[(i + 1) % n];
    const len = dist(a, b);
    if (len < 1e-9) continue;
    const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const fr = len > 2 ? [0.25, 0.5, 0.75] : [0.5]; // not the ends: a corner is a corner-radius question, not a width
    for (const f of fr) out.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], d, seg: i });
    if (len <= 2 && step === 1 && L.closed) {
      // faceted curve: also sample the vertex along the averaged direction (exact for circle-to-circle webs)
      const c = L.pts[(i + 2) % n];
      const l2 = dist(b, c);
      if (l2 > 1e-9 && l2 <= 2) {
        let ex = d[0] + (c[0] - b[0]) / l2, ey = d[1] + (c[1] - b[1]) / l2;
        const el = Math.hypot(ex, ey);
        if (el > 1e-9) out.push({ p: b, d: [ex / el, ey / el], seg: i, seg2: (i + 1) % n });
      }
    }
  }
  return out;
}
/** Nearest hit of a ray from p along (nx, ny) with the given loops (skipping segment `skip` of loop `own`). */
function nearestHit(p, nx, ny, loops, own, skip, skip2) {
  let best = Infinity;
  for (const L of loops) {
    // slab test: skip loops whose bounding box the ray cannot reach before `best`
    const bb = L.bbox;
    let t0 = 0, t1 = best;
    if (Math.abs(nx) < 1e-12) { if (p[0] < bb[0] - 1e-9 || p[0] > bb[2] + 1e-9) continue; }
    else { const a = (bb[0] - p[0]) / nx, b = (bb[2] - p[0]) / nx; t0 = Math.max(t0, Math.min(a, b) - 1e-9); t1 = Math.min(t1, Math.max(a, b) + 1e-9); }
    if (Math.abs(ny) < 1e-12) { if (p[1] < bb[1] - 1e-9 || p[1] > bb[3] + 1e-9) continue; }
    else { const a = (bb[1] - p[1]) / ny, b = (bb[3] - p[1]) / ny; t0 = Math.max(t0, Math.min(a, b) - 1e-9); t1 = Math.min(t1, Math.max(a, b) + 1e-9); }
    if (t0 > t1) continue;
    const n = L.pts.length;
    for (let j = 0; j < n; j++) {
      if (L === own && (j === skip || j === skip2)) continue;
      const t = raySeg(p[0], p[1], nx, ny, L.pts[j], L.pts[(j + 1) % n]);
      if (t !== null && t > 1e-6 && t < best) best = t;
    }
  }
  return best;
}

/**
 * nearestHit() with shorter searches: the loops to look at come from a
 * LoopIndex (when given) and the segments of a long loop from that loop's own
 * SegmentIndex.
 *
 * Why the value is the one nearestHit() returns. Loops are visited in the
 * same (ascending) order with the same bounding-box test against the same
 * running `best`; within a loop the result is a minimum, so the order of its
 * segments does not matter. The indexes leave out only loops and segments
 * that lie entirely to one side of the ray's line, for which raySeg() returns
 * null — they could not have lowered `best`, and a loop that cannot lower
 * `best` does not change what happens to the loops after it.
 *
 * @param {LoopIndex|null} loopIndex over `loops` (same order), or null to visit every loop
 * @param {number} own index in `loops` of the loop the ray starts on
 */
function nearestHitIndexed(loopIndex, loops, p, nx, ny, own, skip, skip2, mode) {
  let best = Infinity;
  let count = loops.length, near = null;
  if (loopIndex) { loopIndex.alongLine(p[0], p[1], nx, ny); near = loopIndex.near; count = loopIndex.count; }
  for (let k = 0; k < count; k++) {
    const li = near ? near[k] : k;
    const L = loops[li];
    // slab test: skip loops whose bounding box the ray cannot reach before `best`
    const bb = L.bbox;
    let t0 = 0, t1 = best;
    if (Math.abs(nx) < 1e-12) { if (p[0] < bb[0] - 1e-9 || p[0] > bb[2] + 1e-9) continue; }
    else { const a = (bb[0] - p[0]) / nx, b = (bb[2] - p[0]) / nx; t0 = Math.max(t0, Math.min(a, b) - 1e-9); t1 = Math.min(t1, Math.max(a, b) + 1e-9); }
    if (Math.abs(ny) < 1e-12) { if (p[1] < bb[1] - 1e-9 || p[1] > bb[3] + 1e-9) continue; }
    else { const a = (bb[1] - p[1]) / ny, b = (bb[3] - p[1]) / ny; t0 = Math.max(t0, Math.min(a, b) - 1e-9); t1 = Math.min(t1, Math.max(a, b) + 1e-9); }
    if (t0 > t1) continue;
    const pts = L.pts, n = pts.length;
    const index = segmentIndexOf(L, mode);
    if (index) {
      index.alongLine(p[0], p[1], nx, ny);
      const { segOf, found, next, head } = index;
      if (index.loopCount) for (let m = head[0]; m >= 0; m = next[m]) {
        const j = segOf[found[m]];
        if (li === own && (j === skip || j === skip2)) continue;
        const t = raySeg(p[0], p[1], nx, ny, pts[j], pts[(j + 1) % n]);
        if (t !== null && t > 1e-6 && t < best) best = t;
      }
    } else {
      for (let j = 0; j < n; j++) {
        if (li === own && (j === skip || j === skip2)) continue;
        const t = raySeg(p[0], p[1], nx, ny, pts[j], pts[(j + 1) % n]);
        if (t !== null && t > 1e-6 && t < best) best = t;
      }
    }
  }
  return best;
}

const LONG_LOOP = 400; // points: from here a loop's own segment index is quicker than testing them all

/** The loop's own SegmentIndex (built on first use, after the loop has its final orientation), or null for a short loop. */
function segmentIndexOf(L, mode) {
  if (L.rayIndex !== undefined) return L.rayIndex;
  let index = null;
  if (mode !== "never" && (mode === "always" || L.pts.length >= LONG_LOOP) && usable(L.bbox)) {
    index = new SegmentIndex([L], L.bbox);
    if (!index.ok) index = null;
  }
  L.rayIndex = index;
  return index;
}

/**
 * A LoopIndex over `loops` when there are enough of them for it to shorten the ray searches,
 * else null (every loop is then visited; the answer is the same). `mode` "always" / "never"
 * overrides the choice for tests.
 */
function loopIndexFor(loops, bbox, mode) {
  if (mode === "never" || !loops.length || !usable(bbox)) return null;
  if (mode !== "always" && loops.length < 256) return null;
  return new LoopIndex(loops, bbox);
}

// ─── loop measurement ────────────────────────────────────────────────────────
function measure(L) {
  let area2 = 0, perimeter = 0;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of L.segs) { area2 += segArea2(s); perimeter += segLength(s); segBBox(s, bbox); }
  if (!L.closed) { // virtual closing chord so an open chain still has an area for classification
    const a = L.segs[L.segs.length - 1].b, b = L.segs[0].a;
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const pts = [L.segs[0].a];
  for (const s of L.segs) flattenSeg(s, pts);
  if (L.closed && pts.length > 1) pts.pop(); // last point repeats the first
  L.area = area2 / 2; L.perimeter = perimeter; L.bbox = bbox; L.pts = pts;
  return L;
}
function reverseLoop(L) {
  L.segs = L.segs.map(reverseSeg).reverse();
  L.pts = L.closed ? [L.pts[0]].concat(L.pts.slice(1).reverse()) : L.pts.slice().reverse();
  L.area = -L.area;
}

/** Circle test on exact primitives, then on a many-sided polygon. */
function asCircle(L) {
  if (L.segs.every((s) => s.k === "A")) {
    const c = L.segs[0].c, r = L.segs[0].r;
    const same = L.segs.every((s) => Math.abs(s.r - r) <= 1e-4 * r + 1e-6 && dist(s.c, c) <= 1e-4 * r + 1e-6);
    const sweep = Math.abs(L.segs.reduce((s, x) => s + x.sweep, 0));
    if (same && Math.abs(sweep - TAU) < 1e-3) return { center: c, diameter: 2 * r, exact: true };
  }
  if (L.pts.length >= 12) {
    let cx = 0, cy = 0;
    for (const p of L.pts) { cx += p[0]; cy += p[1]; }
    cx /= L.pts.length; cy /= L.pts.length;
    let lo = Infinity, hi = 0;
    for (const p of L.pts) { const d = Math.hypot(p[0] - cx, p[1] - cy); if (d < lo) lo = d; if (d > hi) hi = d; }
    if (hi > 0 && (hi - lo) / hi < 0.01) return { center: [cx, cy], diameter: 2 * Math.sqrt(Math.abs(L.area) / Math.PI), exact: false };
  }
  return null;
}

/**
 * Smallest inside-corner radius of a loop oriented with material on the left
 * (same convention as geometry/outline.js): right turns cut into the part.
 * A right-turning arc contributes its radius; a right turn sharper than 30°
 * between lines (5° when an arc is involved) is a sharp corner, radius 0;
 * gentle right turns between short lines are a faceted curve.
 */
function insideCorners(L) {
  let minR = null, at = null;
  const sharp = [];
  const n = L.segs.length;
  const consider = (r, p) => { if (minR === null || r < minR) { minR = r; at = p; } };
  for (let i = 0; i < n; i++) {
    const s = L.segs[i];
    if (s.k === "A" && s.sweep < 0 && Math.abs(s.sweep) > 0.02) consider(s.r, segPoint(s, 0.5));
    if (!L.closed && i === n - 1) break;
    const nx = L.segs[(i + 1) % n];
    const t1 = segTangent(s, true), t2 = segTangent(nx, false);
    const turn = Math.atan2(t1[0] * t2[1] - t1[1] * t2[0], t1[0] * t2[0] + t1[1] * t2[1]);
    if (turn >= -1e-4) continue;
    const theta = -turn;
    const bothLines = s.k === "L" && nx.k === "L";
    if (theta > (bothLines ? Math.PI / 6 : (5 * Math.PI) / 180)) { consider(0, s.b); if (sharp.length < MAX_MARKS) sharp.push(s.b); }
    else if (bothLines) consider(((segLength(s) + segLength(nx)) / 2) / (2 * Math.sin(theta / 2)), s.b);
  }
  return { minR, at, sharp };
}

// ─── main ────────────────────────────────────────────────────────────────────
/**
 * @param {object[]} curves from parse.js
 * @param {object} [opts]
 * @param {number} [opts.maxLoops]    stop after counting the contours when there are more than this;
 *                                    returns { tooManyLoops: true, loopCount }
 * @param {boolean} [opts.exhaustive] search without the spatial indexes (the original loops; for tests)
 * @param {"always"|"never"} [opts.rayIndex] force the ray index on or off (for tests)
 */
function analyseCurves(curves, opts = {}) {
  const indexMode = opts.exhaustive ? "never" : opts.rayIndex; // undefined = decide per search
  const cleaned = cleanCurves(curves);
  const problems = cleaned.problems.slice();
  const { loops: closedLoops, openChains, junctions } = chain(cleaned.curves);

  // A drawing with more contours than the caller reads is refused whatever else is found in
  // it, so it is not measured: the count is all the refusal needs.
  if (opts.maxLoops != null && closedLoops.length + openChains.length > opts.maxLoops) {
    return { tooManyLoops: true, loopCount: closedLoops.length + openChains.length };
  }

  const all = closedLoops.map((L) => measure(L)).concat(openChains.map((L) => measure({ ...L, closed: false })));
  if (!all.length) return null;

  // Overall extents
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const L of all) { bbox[0] = Math.min(bbox[0], L.bbox[0]); bbox[1] = Math.min(bbox[1], L.bbox[1]); bbox[2] = Math.max(bbox[2], L.bbox[2]); bbox[3] = Math.max(bbox[3], L.bbox[3]); }

  // Crossings first: a loop that crosses itself (a bow-tie has zero net area) is not a sliver,
  // and two loops that cross each other belong to one part.
  const crossings = findCrossings(all, bbox, opts.exhaustive ? "scan" : undefined);
  const selfCrossed = new Set(crossings.filter((c) => c.self).map((c) => all[c.loops[0]]));

  // Slivers and stray open lines carry no area: set aside
  const shaped = [];
  let slivers = cleaned.slivers;
  for (const L of all) {
    const thin = Math.abs(L.area) < Math.max(1e-6, L.perimeter * SLIVER_WIDTH_MM) && !selfCrossed.has(L);
    if (thin && L.closed) { L.role = "sliver"; slivers++; if (problems.length < MAX_MARKS * 2) problems.push({ code: "sliver", at: L.pts[0], length: L.perimeter }); }
    else if (thin) L.role = "open";
    else shaped.push(L);
  }

  // Open contours: report each loose end once, with the gap to the nearest other loose end
  const looseEnds = [];
  for (const L of all) if (!L.closed) looseEnds.push({ p: L.segs[0].a, L }, { p: L.segs[L.segs.length - 1].b, L });
  const reported = new Set();
  const nearLimit = Math.max(1, 0.02 * Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]));
  // Only another loose end within `nearLimit` changes what is reported, and a junction only
  // within the weld tolerance, so both are looked up on a grid of that size (3 × 3 cells)
  // instead of measuring every end against every other.
  const coordMax = Math.max(Math.abs(bbox[0]), Math.abs(bbox[1]), Math.abs(bbox[2]), Math.abs(bbox[3]));
  const spread = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1], 1e-9);
  const acrossEnds = Math.max(1, Math.ceil(Math.sqrt(looseEnds.length)));
  // about one loose end per cell, and never coarser than the distance that matters
  const cellSize = Math.min(nearLimit * 1.000001, Math.max(spread / acrossEnds, 1e-6));
  const junctionCell = Math.max(cellSize, 1);
  if (opts.exhaustive || !usable(bbox) || !Buckets.fits(coordMax + nearLimit, cellSize)) {
    looseEnds.forEach((e, i) => {
      if (reported.has(i)) return;
      let best = -1, bd = Infinity;
      looseEnds.forEach((o, j) => { if (j !== i) { const d = dist(e.p, o.p); if (d > WELD_TOL_MM && d < bd) { bd = d; best = j; } } });
      const isJunction = junctions.some((j) => dist(j, e.p) <= WELD_TOL_MM);
      if (isJunction) return;
      if (best >= 0 && bd <= nearLimit) {
        reported.add(best);
        problems.push({ code: "open-contour", at: [(e.p[0] + looseEnds[best].p[0]) / 2, (e.p[1] + looseEnds[best].p[1]) / 2], gap: bd });
      } else problems.push({ code: "open-contour", at: e.p, gap: null });
    });
  } else {
    const endGrid = new Buckets(cellSize), junctionGrid = new Buckets(junctionCell);
    looseEnds.forEach((e, j) => endGrid.add(endGrid.cellOf(e.p[0]), endGrid.cellOf(e.p[1]), j));
    junctions.forEach((j) => junctionGrid.add(junctionGrid.cellOf(j[0]), junctionGrid.cellOf(j[1]), j));
    // rings of cells to search before every end within nearLimit has been seen
    const maxRing = Math.min(Math.ceil(nearLimit / cellSize) + 1, Math.ceil(spread / cellSize) + 2);
    const limit2 = nearLimit * nearLimit * (1 + 1e-12);
    looseEnds.forEach((e, i) => {
      if (reported.has(i)) return;
      const jx = junctionGrid.cellOf(e.p[0]), jy = junctionGrid.cellOf(e.p[1]);
      let isJunction = false;
      for (let gx = jx - 1; gx <= jx + 1 && !isJunction; gx++) for (let gy = jy - 1; gy <= jy + 1 && !isJunction; gy++) {
        const js = junctionGrid.get(gx, gy);
        if (js) isJunction = js.some((j) => dist(j, e.p) <= WELD_TOL_MM);
      }
      if (isJunction) return;
      // Nearest other end beyond the weld tolerance and within nearLimit; the earliest one on a
      // tie, as the full scan picks. Cells are searched ring by ring: after ring r every end not
      // yet seen is more than r cells away, so the search ends once the best is closer than that.
      const cx = endGrid.cellOf(e.p[0]), cy = endGrid.cellOf(e.p[1]);
      let best = -1, bd = Infinity, bound2 = limit2;
      const look = (gx, gy) => {
        const near = endGrid.get(gx, gy);
        if (!near) return;
        for (const j of near) {
          if (j === i) continue;
          const q = looseEnds[j].p, dx = e.p[0] - q[0], dy = e.p[1] - q[1];
          if (dx * dx + dy * dy > bound2) continue; // certainly farther than the best so far (or than nearLimit)
          const d = dist(e.p, q);
          if (d > WELD_TOL_MM && d <= nearLimit && (d < bd || (d === bd && j < best))) { bd = d; best = j; bound2 = bd * bd * (1 + 1e-12); }
        }
      };
      for (let r = 0; r <= maxRing; r++) {
        if (r === 0) look(cx, cy);
        else {
          for (let gx = cx - r; gx <= cx + r; gx++) { look(gx, cy - r); look(gx, cy + r); }
          for (let gy = cy - r + 1; gy <= cy + r - 1; gy++) { look(cx - r, gy); look(cx + r, gy); }
        }
        if (best >= 0 && bd <= r * cellSize * (1 - 1e-9)) break;
      }
      if (best >= 0) {
        reported.add(best);
        problems.push({ code: "open-contour", at: [(e.p[0] + looseEnds[best].p[0]) / 2, (e.p[1] + looseEnds[best].p[1]) / 2], gap: bd });
      } else problems.push({ code: "open-contour", at: e.p, gap: null });
    });
  }
  for (const j of junctions) problems.push({ code: "junction", at: j });

  // Containment depth (largest first)
  shaped.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  // Which earlier (larger) loops contain loop i: only a loop whose bounding box holds this
  // one's is examined, so earlier loops are registered on a grid by bounding box and looked
  // up at this loop's centre. Loops that cover many cells go on a short list checked every time.
  const containment = (L, P, state) => {
    if (L.bbox[0] < P.bbox[0] - 1e-6 || L.bbox[2] > P.bbox[2] + 1e-6 || L.bbox[1] < P.bbox[1] - 1e-6 || L.bbox[3] > P.bbox[3] + 1e-6) return;
    const probes = [L.pts[0], L.pts[Math.floor(L.pts.length / 3)], L.pts[Math.floor((2 * L.pts.length) / 3)]];
    const votes = probes.filter((p) => pointInPoly(p, P.pts)).length;
    if (votes >= 2) { state.depth++; if (!state.parent || Math.abs(P.area) < Math.abs(state.parent.area)) state.parent = P; }
  };
  if (opts.exhaustive || shaped.length < 2 || !usable(bbox)) {
    shaped.forEach((L, i) => {
      const state = { depth: 0, parent: null };
      for (let j = 0; j < i; j++) containment(L, shaped[j], state);
      L.depth = state.depth; L.parent = state.parent;
    });
  } else {
    const across = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(shaped.length))));
    const cell = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1], 1e-9) / across;
    const nx = Math.floor((bbox[2] - bbox[0]) / cell) + 3, ny = Math.floor((bbox[3] - bbox[1]) / cell) + 3;
    const ix = (x) => Math.max(0, Math.min(nx - 1, Math.floor((x - bbox[0]) / cell) + 1));
    const iy = (y) => Math.max(0, Math.min(ny - 1, Math.floor((y - bbox[1]) / cell) + 1));
    const cellLists = new Array(nx * ny);
    const wide = []; // indices of loops spanning more than WIDE_CELLS cells, ascending
    const WIDE_CELLS = 64;
    shaped.forEach((L, i) => {
      const state = { depth: 0, parent: null };
      const here = cellLists[iy((L.bbox[1] + L.bbox[3]) / 2) * nx + ix((L.bbox[0] + L.bbox[2]) / 2)] || [];
      // merge the two ascending lists so the loops are examined in the original order
      let a = 0, b = 0;
      while (a < here.length || b < wide.length) {
        const j = b >= wide.length || (a < here.length && here[a] < wide[b]) ? here[a++] : wide[b++];
        containment(L, shaped[j], state);
      }
      L.depth = state.depth; L.parent = state.parent;
      const x0 = ix(L.bbox[0] - 2e-6), x1 = ix(L.bbox[2] + 2e-6), y0 = iy(L.bbox[1] - 2e-6), y1 = iy(L.bbox[3] + 2e-6);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > WIDE_CELLS) wide.push(i);
      else for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = y * nx + x; if (cellLists[k]) cellLists[k].push(i); else cellLists[k] = [i]; }
    });
  }
  // Outlines that cross each other are one (broken) part, not two parts: the smaller becomes a cutout.
  for (const c of crossings) {
    if (c.self) continue;
    const A = all[c.loops[0]], B = all[c.loops[1]];
    if (A.depth !== 0 || B.depth !== 0) continue;
    const small = Math.abs(A.area) < Math.abs(B.area) ? A : B;
    small.depth = 1; small.parent = small === A ? B : A;
  }
  const outers = shaped.filter((L) => L.depth === 0);
  const nested = shaped.filter((L) => L.depth >= 2);
  // Orientation: material on the left → outer CCW, cutouts CW
  for (const L of shaped) {
    const wantCCW = L.depth % 2 === 0;
    if ((L.area > 0) !== wantCCW) reverseLoop(L);
  }

  const marked = [];
  for (const c of crossings) {
    if (marked.some((p) => dist(p, c.at) < 0.5)) continue;
    marked.push(c.at);
    if (marked.length <= MAX_MARKS) problems.push({ code: c.self ? "self-intersection" : "crossing", at: c.at });
  }

  // Roles + features
  const holes = [], slots = [];
  let outerPerimeter = 0, innerPerimeter = 0, netArea = 0;
  let minInternalRadius = null, minInternalRadiusAt = null, minSlotWidth = null, minSlotWidthAt = null;
  const sharpCorners = [];
  for (const L of shaped) {
    netArea += L.area;
    if (L.depth === 0) { L.role = "outer"; outerPerimeter += L.perimeter; }
    else { L.role = "cutout"; innerPerimeter += L.perimeter; }
    const circle = L.depth >= 1 && L.closed ? asCircle(L) : null;
    if (circle) {
      L.role = "hole";
      L.hole = circle;
      holes.push({ diameter: circle.diameter, center: circle.center, exact: circle.exact });
      continue;
    }
    const corners = insideCorners(L);
    if (corners.minR !== null && (minInternalRadius === null || corners.minR < minInternalRadius)) { minInternalRadius = corners.minR; minInternalRadiusAt = corners.at; }
    for (const p of corners.sharp) if (sharpCorners.length < MAX_MARKS) sharpCorners.push(p);
  }

  // Narrowest cutout / notch: rays to the right (away from material) against the same loop
  const totalPts = shaped.reduce((s, L) => s + L.pts.length, 0);
  const budget = Math.max(4, Math.min(800, Math.floor(400000000 / (Math.max(totalPts, 1) * Math.max(shaped.length, 1)))));
  for (const L of shaped) {
    if (L.role === "hole" || !L.closed) continue;
    let best = Infinity, bestAt = null;
    const own = [L];
    for (const s of samples(L, budget)) {
      const t = indexMode === "never" ? nearestHit(s.p, s.d[1], -s.d[0], own, L, s.seg, s.seg2) : nearestHitIndexed(null, own, s.p, s.d[1], -s.d[0], 0, s.seg, s.seg2, indexMode);
      if (t < best) { best = t; bestAt = [s.p[0] + s.d[1] * t / 2, s.p[1] - s.d[0] * t / 2]; }
    }
    if (best < Infinity) {
      L.minGap = best;
      if (minSlotWidth === null || best < minSlotWidth) { minSlotWidth = best; minSlotWidthAt = bestAt; }
    }
    if (L.role === "cutout" && best < Infinity) {
      // same definition as geometry/features.js detectSlots: an elongated cutout
      let maxLen = 0;
      const st = Math.max(1, Math.floor(L.pts.length / 64));
      for (let i = 0; i < L.pts.length; i += st) for (let j = i + st; j < L.pts.length; j += st) { const d = dist(L.pts[i], L.pts[j]); if (d > maxLen) maxLen = d; }
      if (maxLen >= 1.5 * best) {
        const stadium = best * (maxLen - best) + (Math.PI * best * best) / 4;
        L.role = "slot";
        slots.push({ width: best, length: maxLen, shape: Math.abs(Math.abs(L.area) - stadium) / stadium < 0.15 ? "stadium" : "elongated", center: [(L.bbox[0] + L.bbox[2]) / 2, (L.bbox[1] + L.bbox[3]) / 2] });
      }
    }
  }

  // Narrowest web: rays to the left (into material) against every loop
  let minWeb = null, minWebAt = null;
  const closedShaped = shaped.filter((L) => L.closed);
  const webIndex = loopIndexFor(closedShaped, bbox, indexMode);
  for (let li = 0; li < closedShaped.length; li++) {
    const L = closedShaped[li];
    for (const s of samples(L, budget)) {
      const t = indexMode === "never" ? nearestHit(s.p, -s.d[1], s.d[0], closedShaped, L, s.seg, s.seg2) : nearestHitIndexed(webIndex, closedShaped, s.p, -s.d[1], s.d[0], li, s.seg, s.seg2, indexMode);
      if (t < Infinity && (minWeb === null || t < minWeb)) { minWeb = t; minWebAt = [s.p[0] - s.d[1] * t / 2, s.p[1] + s.d[0] * t / 2]; }
    }
  }

  // Circle-to-circle webs are exact (the ray pass samples a faceted circle and gets coarser on perforated panels)
  const round = shaped.filter((L) => L.role === "hole" && L.hole.exact);
  const circlePair = (a, b) => {
    const dx = b.center[0] - a.center[0], dy = b.center[1] - a.center[1];
    const lim = (minWeb === null ? Infinity : minWeb) + (a.diameter + b.diameter) / 2;
    if (Math.abs(dx) >= lim || Math.abs(dy) >= lim) return;
    const d = Math.hypot(dx, dy), web = d - (a.diameter + b.diameter) / 2;
    if (web < 0 || d < 1e-9) return; // overlapping circles are reported as crossings
    if (minWeb === null || web < minWeb) {
      minWeb = web;
      const t = (a.diameter / 2 + web / 2) / d;
      minWebAt = [a.center[0] + dx * t, a.center[1] + dy * t];
    }
  };
  let widest = 0, centreMax = 0;
  for (const L of round) { widest = Math.max(widest, L.hole.diameter); centreMax = Math.max(centreMax, Math.abs(L.hole.center[0]), Math.abs(L.hole.center[1])); }
  const circleCell = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1], 1e-9) / Math.max(1, Math.ceil(Math.sqrt(round.length)));
  if (opts.exhaustive || round.length < 32 || !usable(bbox) || !Number.isFinite(widest) || !Buckets.fits(centreMax + 2 * (bbox[2] - bbox[0] + bbox[3] - bbox[1]) + widest, circleCell)) {
    for (let i = 0; i < round.length; i++) for (let j = i + 1; j < round.length; j++) circlePair(round[i].hole, round[j].hole);
  } else {
    // A pair is skipped unless its centres are closer than (narrowest web so far) + both radii in
    // x and in y. That web only shrinks, so for hole i every later hole outside a box of
    // (web so far + its radius + the largest radius) is skipped whatever happens in between;
    // the holes inside the box are taken in their original order through the same test.
    const grid = new Buckets(circleCell);
    round.forEach((L, j) => grid.add(grid.cellOf(L.hole.center[0]), grid.cellOf(L.hole.center[1]), j));
    const near = [];
    for (let i = 0; i < round.length; i++) {
      const a = round[i].hole;
      const reach = minWeb === null ? Infinity : (minWeb + (a.diameter + widest) / 2) * (1 + 1e-9) + 1e-9;
      const x0 = grid.cellOf(a.center[0] - reach), x1 = grid.cellOf(a.center[0] + reach), y0 = grid.cellOf(a.center[1] - reach), y1 = grid.cellOf(a.center[1] + reach);
      if (!(Number.isFinite(reach) && (x1 - x0 + 1) * (y1 - y0 + 1) <= round.length)) {
        for (let j = i + 1; j < round.length; j++) circlePair(a, round[j].hole);
        continue;
      }
      near.length = 0;
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const list = grid.get(gx, gy);
        if (list) for (const j of list) if (j > i) near.push(j);
      }
      near.sort((p, q) => p - q);
      for (const j of near) circlePair(a, round[j].hole);
    }
  }

  // Shift everything to a lower-left origin
  const ox = bbox[0], oy = bbox[1];
  const sh = (p) => (p ? [round3(p[0] - ox), round3(p[1] - oy)] : null);
  const outLoops = all.map((L) => ({
    role: L.role || "open", closed: !!L.closed, depth: L.depth == null ? null : L.depth,
    perimeter: round3(L.perimeter), area: round3(L.area),
    // a drawn circle is sent as centre + diameter (the preview draws it); everything else as a polyline
    pts: L.hole && L.hole.exact ? [] : L.pts.map(sh),
    ...(L.hole ? { diameter: round3(L.hole.diameter), center: sh(L.hole.center) } : {}),
  }));
  return {
    version: 1,
    bbox: { w: round3(bbox[2] - bbox[0]), h: round3(bbox[3] - bbox[1]), originX: ox, originY: oy },
    outerCount: outers.length,
    nestedCount: nested.length,
    perimeter: outerPerimeter,
    innerPerimeter,
    area: Math.max(0, netArea),
    cutoutCount: shaped.filter((L) => L.depth === 1).length,
    holes: holes.map((h) => ({ diameter: round3(h.diameter), center: sh(h.center), exact: h.exact })),
    slots: slots.map((s) => ({ width: round3(s.width), length: round3(s.length), shape: s.shape, center: sh(s.center) })),
    minInternalRadius: minInternalRadius === null ? null : round3(minInternalRadius),
    minInternalRadiusAt: sh(minInternalRadiusAt),
    sharpCorners: sharpCorners.map(sh),
    minSlotWidth: minSlotWidth === null ? null : round3(minSlotWidth),
    minSlotWidthAt: sh(minSlotWidthAt),
    minWeb: minWeb === null ? null : round3(minWeb),
    minWebAt: sh(minWebAt),
    openCount: all.filter((L) => !L.closed).length,
    closedCount: all.filter((L) => L.closed).length,
    problems: problems.map((p) => ({ ...p, at: sh(p.at), ...(p.gap != null ? { gap: round3(p.gap) } : {}) })),
    cleaned: { degenerate: cleaned.degenerate, duplicates: cleaned.duplicates, overlaps: cleaned.overlaps, slivers },
    loops: outLoops,
  };
}

function round3(x) { return Math.round(x * 1000) / 1000; }

module.exports = { analyseCurves, WELD_TOL_MM, PREVIEW_TOL_MM, segLength, segArea2, polyArea, pointInPoly };
