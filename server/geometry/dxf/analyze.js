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
  for (const c of exploded) {
    const len = c.segs.reduce((s, x) => s + segLength(x), 0);
    if (!(len > WELD_TOL_MM)) { degenerate++; continue; }
    const first = c.segs[0], lastSeg = c.segs[c.segs.length - 1];
    const ends = [pkey(first.a), pkey(lastSeg.b)].sort();
    const mid = segPoint(c.segs[Math.floor(c.segs.length / 2)], 0.5);
    const key = `${ends[0]}|${ends[1]}|${pkey(mid)}|${c.segs.length}|${Math.round(len / WELD_TOL_MM)}`;
    if (seen.has(key)) { duplicates++; if (problems.length < MAX_MARKS) problems.push({ code: "duplicate", at: mid, layer: c.layer }); continue; }
    seen.set(key, true);
    kept.push(c);
  }

  // Overlapping collinear single lines: merge each overlapping run into one line.
  const groups = new Map();
  const others = [];
  for (const c of kept) {
    if (c.segs.length !== 1 || c.segs[0].k !== "L" || c.closed) { others.push(c); continue; }
    const s = c.segs[0];
    let dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    const len = Math.hypot(dx, dy);
    dx /= len; dy /= len;
    if (dx < -1e-12 || (Math.abs(dx) <= 1e-12 && dy < 0)) { dx = -dx; dy = -dy; }
    const off = -dy * s.a[0] + dx * s.a[1];
    const key = `${Math.round(Math.atan2(dy, dx) * 1e4)}:${Math.round(off / WELD_TOL_MM)}`;
    const t0 = dx * s.a[0] + dy * s.a[1], t1 = dx * s.b[0] + dy * s.b[1];
    let g = groups.get(key);
    if (!g) { g = { dx, dy, off, items: [] }; groups.set(key, g); }
    g.items.push({ lo: Math.min(t0, t1), hi: Math.max(t0, t1), c });
  }
  let overlaps = 0;
  const lines = [];
  for (const g of groups.values()) {
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
  // Cluster the open ends (union-find over a grid with 3×3 neighbourhood lookup)
  const ends = [];
  open.forEach((c, i) => { ends.push({ p: c.segs[0].a, curve: i, end: 0 }, { p: c.segs[c.segs.length - 1].b, curve: i, end: 1 }); });
  const parent = ends.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const cell = WELD_TOL_MM;
  const grid = new Map();
  ends.forEach((e, i) => {
    const cx = Math.floor(e.p[0] / cell), cy = Math.floor(e.p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const b = grid.get(`${cx + dx},${cy + dy}`);
      if (!b) continue;
      for (const j of b) if (dist(ends[j].p, e.p) <= WELD_TOL_MM) parent[find(i)] = find(j);
    }
    const k = `${cx},${cy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const nodes = new Map(); // root → [end indices]
  ends.forEach((_, i) => { const r = find(i); if (!nodes.has(r)) nodes.set(r, []); nodes.get(r).push(i); });
  const nodeOf = (i) => nodes.get(find(i));

  const junctions = [];
  for (const members of nodes.values()) if (members.length > 2) junctions.push(ends[members[0]].p);

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
      if (enter === 0) segs.push(...c.segs); else for (let k = c.segs.length - 1; k >= 0; k--) segs.push(reverseSeg(c.segs[k]));
      const exitIdx = ci * 2 + (enter === 0 ? 1 : 0);
      const node = nodeOf(exitIdx);
      if (node.length !== 2) return { segs, closed: false, approx, endNode: node };
      const other = node[0] === exitIdx ? node[1] : node[0];
      const oc = ends[other].curve;
      if (oc === startCurve && ends[other].end === startEnd) return { segs, closed: true, approx };
      if (used[oc]) return { segs, closed: false, approx, endNode: node };
      ci = oc; enter = ends[other].end;
    }
  };
  // Start open chains at loose ends / junctions first so they are walked end to end
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    for (const e of [0, 1]) {
      if (used[i]) break;
      if (nodeOf(i * 2 + e).length !== 2) openChains.push(walkFrom(i, e));
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
function findCrossings(loops, bbox) {
  const segs = [];
  loops.forEach((L, li) => {
    const n = L.pts.length, m = L.closed ? n : n - 1;
    for (let i = 0; i < m; i++) segs.push({ a: L.pts[i], b: L.pts[(i + 1) % n], loop: li, i, n: m, closed: L.closed });
  });
  const out = [];
  if (segs.length < 2) return out;
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
        if (p && out.length < 200) out.push({ at: p, self: t.loop === s.loop, loops: [t.loop, s.loop] });
      }
      b.push(si);
    }
  });
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
function analyseCurves(curves) {
  const cleaned = cleanCurves(curves);
  const problems = cleaned.problems.slice();
  const { loops: closedLoops, openChains, junctions } = chain(cleaned.curves);

  const all = closedLoops.map((L) => measure(L)).concat(openChains.map((L) => measure({ ...L, closed: false })));
  if (!all.length) return null;

  // Overall extents
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const L of all) { bbox[0] = Math.min(bbox[0], L.bbox[0]); bbox[1] = Math.min(bbox[1], L.bbox[1]); bbox[2] = Math.max(bbox[2], L.bbox[2]); bbox[3] = Math.max(bbox[3], L.bbox[3]); }

  // Crossings first: a loop that crosses itself (a bow-tie has zero net area) is not a sliver,
  // and two loops that cross each other belong to one part.
  const crossings = findCrossings(all, bbox);
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
  looseEnds.forEach((e, i) => {
    if (reported.has(i)) return;
    let best = -1, bd = Infinity;
    looseEnds.forEach((o, j) => { if (j !== i) { const d = dist(e.p, o.p); if (d > WELD_TOL_MM && d < bd) { bd = d; best = j; } } });
    const isJunction = junctions.some((j) => dist(j, e.p) <= WELD_TOL_MM);
    if (isJunction) return;
    if (best >= 0 && bd <= Math.max(1, 0.02 * Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]))) {
      reported.add(best);
      problems.push({ code: "open-contour", at: [(e.p[0] + looseEnds[best].p[0]) / 2, (e.p[1] + looseEnds[best].p[1]) / 2], gap: bd });
    } else problems.push({ code: "open-contour", at: e.p, gap: null });
  });
  for (const j of junctions) problems.push({ code: "junction", at: j });

  // Containment depth (largest first)
  shaped.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  shaped.forEach((L, i) => {
    let depth = 0, parent = null;
    for (let j = 0; j < i; j++) {
      const P = shaped[j];
      if (L.bbox[0] < P.bbox[0] - 1e-6 || L.bbox[2] > P.bbox[2] + 1e-6 || L.bbox[1] < P.bbox[1] - 1e-6 || L.bbox[3] > P.bbox[3] + 1e-6) continue;
      const probes = [L.pts[0], L.pts[Math.floor(L.pts.length / 3)], L.pts[Math.floor((2 * L.pts.length) / 3)]];
      const votes = probes.filter((p) => pointInPoly(p, P.pts)).length;
      if (votes >= 2) { depth++; if (!parent || Math.abs(P.area) < Math.abs(parent.area)) parent = P; }
    }
    L.depth = depth; L.parent = parent;
  });
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
    for (const s of samples(L, budget)) {
      const t = nearestHit(s.p, s.d[1], -s.d[0], [L], L, s.seg, s.seg2);
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
  for (const L of closedShaped) {
    for (const s of samples(L, budget)) {
      const t = nearestHit(s.p, -s.d[1], s.d[0], closedShaped, L, s.seg, s.seg2);
      if (t < Infinity && (minWeb === null || t < minWeb)) { minWeb = t; minWebAt = [s.p[0] - s.d[1] * t / 2, s.p[1] + s.d[0] * t / 2]; }
    }
  }

  // Circle-to-circle webs are exact (the ray pass samples a faceted circle and gets coarser on perforated panels)
  const round = shaped.filter((L) => L.role === "hole" && L.hole.exact);
  for (let i = 0; i < round.length; i++) {
    const a = round[i].hole;
    for (let j = i + 1; j < round.length; j++) {
      const b = round[j].hole;
      const dx = b.center[0] - a.center[0], dy = b.center[1] - a.center[1];
      const lim = (minWeb === null ? Infinity : minWeb) + (a.diameter + b.diameter) / 2;
      if (Math.abs(dx) >= lim || Math.abs(dy) >= lim) continue;
      const d = Math.hypot(dx, dy), web = d - (a.diameter + b.diameter) / 2;
      if (web < 0 || d < 1e-9) continue; // overlapping circles are reported as crossings
      if (minWeb === null || web < minWeb) {
        minWeb = web;
        const t = (a.diameter / 2 + web / 2) / d;
        minWebAt = [a.center[0] + dx * t, a.center[1] + dy * t];
      }
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
