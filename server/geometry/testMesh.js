/**
 * Tiny watertight mesh builder for tests (a port of the cell-based generator in
 * tools/vet-quotes/generate_parts.py). Produces flat Float64Array positions,
 * 9 per triangle, consistently wound (CCW seen from outside).
 */

class MeshBuilder {
  constructor() { this.tris = []; }
  tri(a, b, c) { this.tris.push(a, b, c); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  /** Horizontal triangle at height z, winding fixed so the normal is ±z. */
  tri2d(a, b, c, z, up = true) {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-12) return;
    let A = [a[0], a[1], z], B = [b[0], b[1], z], C = [c[0], c[1], z];
    if ((area > 0) !== up) [B, C] = [C, B];
    this.tri(A, B, C);
  }
  capFan(loop, z, up = true, center = null) {
    const c = center || centroid(loop);
    for (let i = 0; i < loop.length; i++) this.tri2d(c, loop[i], loop[(i + 1) % loop.length], z, up);
  }
  /** Cap the ring between two loops that are both star-shaped about center (zipper by polar angle). */
  capAnnulus(outer, inner, z, up = true, center = null) {
    const c = center || centroid(inner);
    const ang = (p) => { const a = Math.atan2(p[1] - c[1], p[0] - c[0]); return a < 0 ? a + 2 * Math.PI : a; };
    const o = outer.slice().sort((p, q) => ang(p) - ang(q));
    const inn = inner.slice().sort((p, q) => ang(p) - ang(q));
    const ao = o.map(ang), ai = inn.map(ang);
    const No = o.length, Ni = inn.length;
    const picks = [];
    for (let k = 0; k < No; k++) {
      const gap = ((ao[(k + 1) % No] - ao[k]) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const beta = (ao[k] + gap / 2) % (2 * Math.PI);
      let best = 0, bd = Infinity;
      for (let j = 0; j < Ni; j++) { const d = Math.abs(((ai[j] - beta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI); if (d < bd) { bd = d; best = j; } }
      picks.push(best);
    }
    for (let k = 0; k < No; k++) {
      const k1 = (k + 1) % No;
      this.tri2d(o[k], o[k1], inn[picks[k]], z, up);
      let j = picks[k];
      const steps = ((picks[k1] - picks[k]) % Ni + Ni) % Ni;
      for (let s = 0; s < steps; s++) { this.tri2d(o[k1], inn[j], inn[(j + 1) % Ni], z, up); j = (j + 1) % Ni; }
    }
  }
  capPolygon(poly, z, up = true) { for (const [a, b, c] of earclip(poly)) this.tri2d(a, b, c, z, up); }
  /** Wall between two loops with the same vertex count (lower at smaller z). inward → normals point into the loop. */
  band(lower, upper, inward = false) {
    const n = lower.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (inward) this.quad(lower[i], upper[i], upper[j], lower[j]);
      else this.quad(lower[i], lower[j], upper[j], upper[i]);
    }
  }
  wallSegment(p0, p1, z0, z1, outward) {
    const a = [p0[0], p0[1], z0], b = [p1[0], p1[1], z0], c = [p1[0], p1[1], z1], d = [p0[0], p0[1], z1];
    const nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]);
    const ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
    if (nx * outward[0] + ny * outward[1] >= 0) this.quad(a, b, c, d); else this.quad(a, d, c, b);
  }
  positions() {
    const out = new Float64Array(this.tris.length * 3);
    this.tris.forEach((p, i) => { out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2]; });
    return out;
  }
  /** Rigid transform helper: apply fn to every vertex. */
  map(fn) { this.tris = this.tris.map(fn); return this; }
}

function centroid(loop) { const c = [0, 0]; for (const p of loop) { c[0] += p[0]; c[1] += p[1]; } return [c[0] / loop.length, c[1] / loop.length]; }
function z3(loop, z) { return loop.map((p) => [p[0], p[1], z]); }

// ── 2D loops (CCW) ──
function circle(r, n = 48, cx = 0, cy = 0) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;
}
function rect(w, h, cx = 0, cy = 0) { return [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]; }
function roundedRect(w, h, r, nCorner = 8, cx = 0, cy = 0) {
  r = Math.min(r, w / 2, h / 2);
  const corners = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI], [w / 2 - r, -h / 2 + r, 1.5 * Math.PI]];
  const pts = [];
  for (const [x, y, a0] of corners) for (let k = 0; k <= nCorner; k++) { const t = a0 + (Math.PI / 2) * (k / nCorner); pts.push([x + r * Math.cos(t), y + r * Math.sin(t)]); }
  const out = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) out.push(p); }
  if (Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  return out.map((p) => [p[0] + cx, p[1] + cy]);
}
function stadium(length, width, n = 12, cx = 0, cy = 0) { return roundedRect(length, width, width / 2, n, cx, cy); }
function perimeter(loop) { let s = 0; for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; s += Math.hypot(q[0] - p[0], q[1] - p[1]); } return s; }
function loopArea(loop) { let a = 0; for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

function earclip(poly) {
  let pts = poly.map((p) => [p[0], p[1]]);
  if (loopArea(pts) < 0) pts.reverse();
  const idx = pts.map((_, i) => i);
  const tris = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const n = idx.length;
      const i0 = idx[(k - 1 + n) % n], i1 = idx[k], i2 = idx[(k + 1) % n];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      if (cross(a, b, c) <= 1e-9) continue;
      if (idx.some((j) => j !== i0 && j !== i1 && j !== i2 && inside(pts[j], a, b, c))) continue;
      tris.push([a, b, c]); idx.splice(k, 1); clipped = true; break;
    }
    if (!clipped) throw new Error("earclip: no ear");
  }
  if (idx.length === 3) tris.push([pts[idx[0]], pts[idx[1]], pts[idx[2]]]);
  return tris;
}

/**
 * Plate W×H×T (origin at the min corner) partitioned by xcuts/ycuts; each cell
 * may own one feature: {kind:"hole"|"slot"|"pocket"|"csk"|"cbore", loop, depth, loopTop}.
 */
function buildPlate(W, H, T, xcuts, ycuts, features) {
  const m = new MeshBuilder();
  const truth = { holes: 0, slots: 0, pockets: 0, cutPerimeter: 2 * (W + H), removed: 0, pocketArea: 0, pocketDepth: 0 };
  const nx = xcuts.length - 1, ny = ycuts.length - 1;
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
    const x0 = xcuts[ix], x1 = xcuts[ix + 1], y0 = ycuts[iy], y1 = ycuts[iy + 1];
    const cell = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    if (iy === 0) m.wallSegment(cell[0], cell[1], 0, T, [0, -1]);
    if (ix === nx - 1) m.wallSegment(cell[1], cell[2], 0, T, [1, 0]);
    if (iy === ny - 1) m.wallSegment(cell[2], cell[3], 0, T, [0, 1]);
    if (ix === 0) m.wallSegment(cell[3], cell[0], 0, T, [-1, 0]);
    const f = features[ix + "," + iy];
    if (!f) { m.capFan(cell, T, true); m.capFan(cell, 0, false); continue; }
    const loop = f.loop, ctr = centroid(loop), A = Math.abs(loopArea(loop)), P = perimeter(loop);
    if (f.kind === "hole" || f.kind === "slot") {
      m.capAnnulus(cell, loop, T, true, ctr); m.capAnnulus(cell, loop, 0, false, ctr);
      m.band(z3(loop, 0), z3(loop, T), true);
      truth[f.kind === "hole" ? "holes" : "slots"]++; truth.cutPerimeter += P; truth.removed += A * T;
    } else if (f.kind === "csk") {
      const top = f.loopTop, d = f.depth;
      m.capAnnulus(cell, top, T, true, ctr);
      m.band(z3(loop, T - d), z3(top, T), true);
      m.band(z3(loop, 0), z3(loop, T - d), true);
      m.capAnnulus(cell, loop, 0, false, ctr);
      truth.holes++; truth.cutPerimeter += P;
    } else if (f.kind === "cbore") {
      // counterbore loopTop (bigger) depth d from the top, then through hole `loop`
      const top = f.loopTop, d = f.depth;
      m.capAnnulus(cell, top, T, true, ctr);
      m.band(z3(top, T - d), z3(top, T), true);
      m.capAnnulus(top, loop, T - d, true, ctr);
      m.band(z3(loop, 0), z3(loop, T - d), true);
      m.capAnnulus(cell, loop, 0, false, ctr);
      truth.holes++; truth.cutPerimeter += P;
    } else if (f.kind === "pocket") {
      const d = f.depth;
      m.capAnnulus(cell, loop, T, true, ctr);
      m.band(z3(loop, T - d), z3(loop, T), true);
      m.capFan(loop, T - d, true, ctr);
      m.capFan(cell, 0, false);
      truth.pockets++; truth.cutPerimeter += P; truth.removed += A * d; truth.pocketArea = A; truth.pocketDepth = d;
    } else if (f.kind === "blind") {
      // blind round hole: like a pocket with a circular loop
      const d = f.depth;
      m.capAnnulus(cell, loop, T, true, ctr);
      m.band(z3(loop, T - d), z3(loop, T), true);
      m.capFan(loop, T - d, true, ctr);
      m.capFan(cell, 0, false);
      truth.holes++;
    }
  }
  return { positions: m.positions(), truth, builder: m };
}

/** Disc / tube: outer loop, optional inner bore loop, length T along Z (z from 0 to T). */
function buildRing(outer, inner, T) {
  const m = new MeshBuilder();
  m.band(z3(outer, 0), z3(outer, T));
  if (inner && inner.length) {
    m.capAnnulus(outer, inner, T, true, [0, 0]); m.capAnnulus(outer, inner, 0, false, [0, 0]);
    m.band(z3(inner, 0), z3(inner, T), true);
  } else { m.capFan(outer, T, true, [0, 0]); m.capFan(outer, 0, false, [0, 0]); }
  return m.positions();
}

/** Extrude a simple (possibly concave) CCW XZ profile along +Y from y=0 to y=L. */
function extrudeProfileY(profile, L) {
  const m = new MeshBuilder();
  // caps: front (y=0, normal -y), back (y=L, normal +y)
  for (const [a, b, c] of earclip(profile)) {
    const A = [a[0], 0, a[1]], B = [b[0], 0, b[1]], C = [c[0], 0, c[1]];
    // profile CCW in XZ (x right, z up) seen from -y: normal of (A,B,C) = (B-A)x(C-A) has ny < 0 for CCW in xz? compute and fix
    const ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
    if (ny < 0) m.tri(A, B, C); else m.tri(A, C, B);
    const A2 = [a[0], L, a[1]], B2 = [b[0], L, b[1]], C2 = [c[0], L, c[1]];
    if (ny < 0) m.tri(A2, C2, B2); else m.tri(A2, B2, C2);
  }
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const p = profile[i], q = profile[(i + 1) % n];
    const a = [p[0], 0, p[1]], b = [q[0], 0, q[1]], c = [q[0], L, q[1]], d = [p[0], L, p[1]];
    // outward normal for a CCW profile: right of the edge direction in XZ = (dz, -dx)
    const ox = q[1] - p[1], oz = -(q[0] - p[0]);
    const nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]);
    const nz = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    if (nx * ox + nz * oz >= 0) m.quad(a, b, c, d); else m.quad(a, d, c, b);
  }
  return m.positions();
}

/** Block W×D×H (origin at min corner) with a closed T-slot cavity under the top: neck nw×nl×nd, cavity cw×cl×cd (nl < cl). */
function buildTSlotBlock(W, D, H, nw, nl, nd, cw, cl, cd) {
  const m = new MeshBuilder();
  const cx = W / 2, cy = D / 2;
  const outer = rect(W, D, cx, cy), neck = rect(nw, nl, cx, cy), cav = rect(cw, cl, cx, cy);
  m.band(z3(outer, 0), z3(outer, H));
  m.capFan(outer, 0, false, [cx, cy]);
  m.capAnnulus(outer, neck, H, true, [cx, cy]);
  m.band(z3(neck, H - nd), z3(neck, H), true);
  m.capAnnulus(cav, neck, H - nd, false, [cx, cy]); // ceiling faces down
  m.band(z3(cav, H - nd - cd), z3(cav, H - nd), true);
  m.capFan(cav, H - nd - cd, true, [cx, cy]);
  return m.positions();
}

/** Axis-aligned box, origin at min corner. */
function buildBox(W, D, H) { return buildPlate(W, D, H, [0, W], [0, D], {}).positions; }

module.exports = { MeshBuilder, circle, rect, roundedRect, stadium, perimeter, loopArea, buildPlate, buildRing, extrudeProfileY, buildTSlotBlock, buildBox };
