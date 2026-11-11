/**
 * Feature recognition from surface patches (regions.js) + the BVH.
 *
 *   holes    concave full cylinders; through/blind by testing whether the axis
 *            point just beyond each end is inside the solid; coaxial stacks
 *            become counterbores (cylinder on cylinder) and countersinks
 *            (cone on cylinder).
 *   bosses   convex full cylinders attached at one end, free at the other.
 *   pockets  planar floors whose boundary is (mostly) walls rising above them.
 *   slots    through stadium cutouts in the outline, half-round channels.
 *   fillets  partial cylinders.  chamfers: short cones and narrow tilted planes.
 */
const { v } = require("./vec");
const { pointInside } = require("./bvh");
const { DEG } = require("./fit");
const { loopMinConcaveRadius, loopMinGap, polyArea, chainLoops } = require("./outline");
const { axisDistance } = require("./shape");

const FULL_COVERAGE_DEG = 300;

// Tap-drill sizes (mm) that do not collide with a common clearance size.
const TAP_DRILLS = [2.05, 2.5, 3.3, 4.2, 5.0, 6.8, 8.5, 10.2, 2.26, 2.7, 3.45, 3.8, 5.1, 7.94, 10.72];

function coaxial(p, q, tolDeg = 1.5) {
  const a = v.canon(p.axis), b = v.canon(q.axis);
  if (Math.abs(v.dot(a, b)) < Math.cos(tolDeg * DEG)) return false;
  const r = Math.max(p.radius || p.rMax || 1, q.radius || q.rMax || 1);
  return axisDistance(p.center, p.axis, q.center, q.axis) < Math.max(0.05, 0.03 * r);
}

/** Axial interval of a patch on a reference axis (through reference point). */
function interval(p, a, c0) {
  const t0 = v.dot(v.sub(p.center, c0), a);
  const h = p.length / 2;
  return [t0 - h, t0 + h];
}

/** Merge cylinder patches that are coaxial, same radius and concavity, with touching extents (split seams). */
function mergeCylinders(patches) {
  const cyls = patches.filter((p) => p.kind === "cylinder").map((p) => ({ ...p, parts: [p.id], tolerant: false }));
  cyls.sort((a, b) => b.area - a.area);
  const out = [];
  for (const c of cyls) {
    let merged = false;
    for (const o of out) {
      if (o.concave !== c.concave) continue;
      if (Math.abs(o.radius - c.radius) > Math.max(0.03, 0.02 * o.radius)) continue;
      if (!coaxial(o, c)) continue;
      const a = v.canon(o.axis);
      const [a0, a1] = interval(o, a, o.center), [b0, b1] = interval(c, a, o.center);
      const gap = Math.max(a0, b0) - Math.min(a1, b1);
      if (gap > 0.5) continue; // not touching along the axis
      // union of extents
      const lo = Math.min(a0, b0), hi = Math.max(a1, b1);
      o.center = v.add(o.center, v.scale(a, (lo + hi) / 2));
      o.length = hi - lo;
      o.area += c.area;
      o.coverageDeg = Math.min(360, o.coverageDeg + c.coverageDeg);
      o.parts.push(...c.parts);
      o.tris = o.tris.concat(c.tris);
      merged = true;
      break;
    }
    if (!merged) out.push(c);
  }
  return out;
}

function openEnd(bvh, p, dir, offset, radialFrac = 0) {
  // test the point `offset` beyond the end along dir; optionally at a radius
  const base = v.add(p.center, v.scale(dir, p.length / 2 + offset));
  if (!radialFrac) return !pointInside(bvh, base);
  const [u, w] = v.basis(dir);
  const r = p.radius * radialFrac;
  let outsideVotes = 0;
  for (const d of [u, w, v.neg(u), v.neg(w)]) if (!pointInside(bvh, v.add(base, v.scale(d, r)))) outsideVotes++;
  return outsideVotes >= 3;
}

/**
 * @returns {{holes, bosses, holePatchIds:Set, fillets, chamfers, cylinders}}
 */
function detectHolesAndBosses(mesh, patches, bvh, shape) {
  const cyls = mergeCylinders(patches);
  const cones = patches.filter((p) => p.kind === "cone");
  const holePatchIds = new Set();
  const holes = [], bosses = [];
  const used = new Set();

  const full = cyls.filter((c) => c.coverageDeg >= FULL_COVERAGE_DEG);
  const concaveFull = full.filter((c) => c.concave);
  const convexFull = full.filter((c) => !c.concave);

  // Hole candidates with end classification
  const cands = concaveFull.map((c) => {
    const a = v.canon(c.axis);
    const off = Math.max(0.05, Math.min(0.5, 0.1 * c.radius));
    const openPlus = openEnd(bvh, c, a, off);
    const openMinus = openEnd(bvh, c, v.neg(a), off);
    return { c, a, openPlus, openMinus };
  });

  // Group coaxial candidates and concave cones into stacks
  const stacks = [];
  for (const h of cands) {
    let placed = false;
    for (const s of stacks) if (coaxial(s.ref, h.c)) { s.items.push(h); placed = true; break; }
    if (!placed) stacks.push({ ref: h.c, items: [h], cones: [] });
  }
  for (const cone of cones) {
    if (!cone.concave) continue;
    for (const s of stacks) if (coaxial(s.ref, cone)) { s.cones.push(cone); break; }
  }

  for (const s of stacks) {
    const a = v.canon(s.ref.axis);
    const c0 = s.ref.center;
    const items = s.items.map((h) => ({ ...h, iv: interval(h.c, a, c0) })).sort((p, q) => p.iv[0] - q.iv[0]);
    // Walk touching runs of items along the axis
    let run = [items[0]];
    const runs = [];
    for (let i = 1; i < items.length; i++) {
      const prev = run[run.length - 1];
      if (items[i].iv[0] - prev.iv[1] <= 0.5) run.push(items[i]); else { runs.push(run); run = [items[i]]; }
    }
    runs.push(run);
    for (const r of runs) {
      // the hole is the smallest diameter member; larger touching members at an open end are counterbores
      const minItem = r.reduce((m, x) => (x.c.radius < m.c.radius ? x : m), r[0]);
      const lo = r[0].iv[0], hi = r[r.length - 1].iv[1];
      const openLo = r[0].openMinus, openHi = r[r.length - 1].openPlus;
      // which direction is "entry" (open) for blind holes
      const through = openLo && openHi;
      const blind = (openLo || openHi) && !through;
      const hole = {
        diameter: 2 * minItem.c.radius,
        depth: hi - lo,
        through,
        blind,
        axis: a,
        center: v.add(c0, v.scale(a, (lo + hi) / 2)),
        kind: "round",
        depthToDiaRatio: (hi - lo) / (2 * minItem.c.radius),
        confidenceSource: minItem.c.source,
        patchIds: r.flatMap((x) => x.c.parts),
      };
      if (!openLo && !openHi) { hole.blind = true; hole.internalVoid = true; }
      const bigger = r.filter((x) => x !== minItem && x.c.radius > minItem.c.radius * 1.05);
      if (bigger.length) {
        const cb = bigger.reduce((m, x) => (x.c.radius > m.c.radius ? x : m), bigger[0]);
        hole.kind = "counterbored";
        hole.counterbore = { diameter: 2 * cb.c.radius, depth: cb.c.length };
        // cylindrical hole depth excludes the counterbore for machining purposes
        hole.holeDepth = minItem.c.length;
      }
      // countersink: concave cone touching the run whose small radius ≈ hole radius
      for (const cone of s.cones) {
        const civ = interval(cone, a, c0);
        const touches = Math.min(Math.abs(civ[0] - hi), Math.abs(civ[1] - lo), Math.abs(civ[0] - lo), Math.abs(civ[1] - hi)) <= 0.5;
        if (!touches) continue;
        const radialGrowth = cone.rMax - cone.rMin;
        if (cone.rMax > minItem.c.radius * 1.15 && radialGrowth >= 0.75 && cone.halfAngleDeg >= 20 && cone.halfAngleDeg <= 75) {
          if (hole.kind === "round") hole.kind = "countersunk";
          hole.countersink = { diameter: 2 * cone.rMax, angleDeg: 2 * cone.halfAngleDeg, depth: cone.length };
          hole.depth = Math.max(hole.depth, Math.max(civ[1], hi) - Math.min(civ[0], lo));
          holePatchIds.add(cone.id);
        } else if (cone.rMax <= minItem.c.radius * 1.05 && cone.rMin < minItem.c.radius * 0.5) {
          hole.drillPoint = true; // conical bottom of a drilled blind hole
          holePatchIds.add(cone.id);
        } else {
          hole.entryChamfer = { diameter: 2 * cone.rMax };
          holePatchIds.add(cone.id);
        }
      }
      if (hole.kind === "round" && TAP_DRILLS.some((d) => Math.abs(d - hole.diameter) <= 0.05)) hole.kind = "tapped-candidate";
      for (const id of hole.patchIds) holePatchIds.add(id);
      for (const x of r) used.add(x.c);
      holes.push(hole);
    }
  }

  // Bosses: convex full cylinders attached at exactly one end
  const partExtent = (a) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < mesh.nv; i += Math.max(1, Math.ceil(mesh.nv / 5000))) {
      const t = mesh.verts[i * 3] * a[0] + mesh.verts[i * 3 + 1] * a[1] + mesh.verts[i * 3 + 2] * a[2];
      if (t < lo) lo = t; if (t > hi) hi = t;
    }
    return hi - lo;
  };
  for (const c of convexFull) {
    const a = v.canon(c.axis);
    if (shape.revolved && Math.abs(v.dot(a, shape.revolved.axis)) > Math.cos(2 * DEG)) continue;
    if (c.length >= 0.95 * partExtent(a)) continue; // the body itself
    const attachedPlus = !openEnd(bvh, c, a, Math.max(0.05, Math.min(0.5, 0.1 * c.radius)), 0.7);
    const attachedMinus = !openEnd(bvh, c, v.neg(a), Math.max(0.05, Math.min(0.5, 0.1 * c.radius)), 0.7);
    if (attachedPlus === attachedMinus) continue;
    bosses.push({ diameter: 2 * c.radius, height: c.length, axis: attachedPlus ? v.neg(a) : a, center: c.center, confidenceSource: c.source });
  }

  // Fillets: partial cylinders (not holes / channels)
  const partial = cyls.filter((c) => c.coverageDeg < FULL_COVERAGE_DEG && c.coverageDeg >= 15);
  const filletList = partial.filter((c) => c.coverageDeg <= 200);
  const fillets = filletList.length ? { count: filletList.length, minRadius: Math.min(...filletList.map((c) => c.radius)), concave: filletList.filter((c) => c.concave).length } : { count: 0, minRadius: null, concave: 0 };

  // Chamfers: short cones that are not countersinks + narrow tilted planes
  let chamferCount = 0;
  for (const cone of cones) {
    if (holePatchIds.has(cone.id)) continue;
    if (cone.length <= 5 && cone.rMax - cone.rMin <= 5) chamferCount++;
  }
  const axes = [shape.primaryAxis, ...(shape.obbAxes || [])].filter(Boolean);
  for (const p of patches) {
    if (p.kind !== "plane") continue;
    const aligned = axes.some((ax) => { const d = Math.abs(v.dot(p.normal, ax)); return d > Math.cos(3 * DEG) || d < Math.sin(3 * DEG); });
    if (aligned) continue;
    const ext = planeExtents(mesh, p);
    if (ext.min <= 5 && ext.min <= 0.25 * ext.max) chamferCount++;
  }

  return { holes, bosses, holePatchIds, fillets, chamfers: { count: chamferCount }, cylinders: cyls, partialCylinders: partial };
}

function planeExtents(mesh, p) {
  const [u, w] = v.basis(p.normal);
  let ulo = Infinity, uhi = -Infinity, wlo = Infinity, whi = -Infinity;
  for (const t of p.tris) for (let c = 0; c < 3; c++) {
    const x = mesh.pos[t * 9 + c * 3], y = mesh.pos[t * 9 + c * 3 + 1], z = mesh.pos[t * 9 + c * 3 + 2];
    const a = x * u[0] + y * u[1] + z * u[2], b = x * w[0] + y * w[1] + z * w[2];
    if (a < ulo) ulo = a; if (a > uhi) uhi = a; if (b < wlo) wlo = b; if (b > whi) whi = b;
  }
  return { min: Math.min(uhi - ulo, whi - wlo), max: Math.max(uhi - ulo, whi - wlo) };
}

/** Height of a patch's vertices above a plane (max and min). Large patches are
 * bounded by their AABB first and sampled when the bound is inconclusive. */
function heightRange(mesh, p, normal, offset) {
  if (!p.aabb) p.aabb = patchAABB(mesh, p);
  // extent of the AABB along the normal
  let blo = -offset, bhi = -offset;
  for (let k = 0; k < 3; k++) {
    const a = normal[k] * p.aabb[k], b = normal[k] * p.aabb[k + 3];
    blo += Math.min(a, b); bhi += Math.max(a, b);
  }
  if (p.tris.length <= 2000 || bhi - blo < 1e-9) {
    if (p.tris.length > 2000) return { lo: blo, hi: bhi };
  } else {
    // conclusive bounds for an axis-aligned patch; otherwise sample
    if (Math.abs(normal[0]) > 0.999 || Math.abs(normal[1]) > 0.999 || Math.abs(normal[2]) > 0.999) return { lo: blo, hi: bhi };
  }
  let lo = Infinity, hi = -Infinity;
  const step = Math.max(1, Math.ceil(p.tris.length / 2000));
  for (let i = 0; i < p.tris.length; i += step) {
    const t = p.tris[i];
    for (let c = 0; c < 3; c++) {
      const o = t * 9 + c * 3;
      const h = mesh.pos[o] * normal[0] + mesh.pos[o + 1] * normal[1] + mesh.pos[o + 2] * normal[2] - offset;
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
  }
  return { lo: Math.max(lo, blo), hi: Math.min(hi, bhi) };
}

function patchAABB(mesh, p) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const t of p.tris) for (let c = 0; c < 3; c++) {
    const o = t * 9 + c * 3;
    for (let k = 0; k < 3; k++) { const x = mesh.pos[o + k]; if (x < b[k]) b[k] = x; if (x > b[k + 3]) b[k + 3] = x; }
  }
  return b;
}

/**
 * Pockets from planar floors.
 */
function detectPockets(mesh, patches, patchOf, adjacency, holePatchIds, cylinders, bvh) {
  const pockets = [];
  const floorPatchIds = new Set();
  const { neighbors, boundaryLen } = adjacency;
  const minDepth = 0.2;
  const fullConcave = new Set();
  for (const c of cylinders) if (c.concave && c.coverageDeg >= FULL_COVERAGE_DEG) for (const id of c.parts) fullConcave.add(id);

  for (const f of patches) {
    if (f.kind !== "plane" || f.area <= 0) continue;
    const n = f.normal, off = f.offset;
    const nb = neighbors[f.id];
    if (!nb || nb.size === 0) continue;
    let closedLen = 0, holeLen = 0, depth = 0;
    const upWalls = [];
    for (const [pid, rec] of nb) {
      const q = patches[pid];
      const hr = heightRange(mesh, q, n, off);
      if (fullConcave.has(pid) || holePatchIds.has(pid)) holeLen += rec.len;
      if (hr.hi > minDepth && hr.lo > -minDepth) {
        // the neighbour rises above the floor: a wall (planar, curved or anything)
        let wallish = true;
        if (q.kind === "plane") wallish = Math.abs(v.dot(q.normal, n)) < 0.7;
        if (wallish) { closedLen += rec.len; upWalls.push({ q, rec, height: hr.hi }); depth = Math.max(depth, hr.hi); }
      }
    }
    const total = boundaryLen[f.id];
    if (total <= 0 || depth < minDepth) continue;
    if (holeLen / total >= 0.8) continue; // bottom of a blind hole / counterbore floor
    const closedFraction = closedLen / total;
    if (closedFraction < 0.3) continue;
    // A floor must be open above it: rays along its normal from sample points
    // leave the part. (A side wall also has a perpendicular neighbour that
    // "rises" from it, but the ray along its normal hits the opposite wall.)
    if (!openAbove(mesh, f, bvh)) continue;

    // Boundary loops of the floor in its own 2D frame (material = pocket interior on the left)
    const [u, w] = v.basis(n);
    const segs = [];
    for (const t of f.tris) for (let e = 0; e < 3; e++) {
      const o = mesh.adj[t * 3 + e];
      if (o >= 0 && patchOf[o] === f.id) continue;
      const a = mesh.vidx[t * 3 + e], b = mesh.vidx[t * 3 + ((e + 1) % 3)];
      const ax = mesh.verts[a * 3] * u[0] + mesh.verts[a * 3 + 1] * u[1] + mesh.verts[a * 3 + 2] * u[2];
      const ay = mesh.verts[a * 3] * w[0] + mesh.verts[a * 3 + 1] * w[1] + mesh.verts[a * 3 + 2] * w[2];
      const bx = mesh.verts[b * 3] * u[0] + mesh.verts[b * 3 + 1] * u[1] + mesh.verts[b * 3 + 2] * u[2];
      const by = mesh.verts[b * 3] * w[0] + mesh.verts[b * 3 + 1] * w[1] + mesh.verts[b * 3 + 2] * w[2];
      // triangle is CCW about n in (u,w) iff (u,w,n) is right-handed: basis() returns w = n x u, so yes
      segs.push([ax, ay, bx, by, o < 0 ? -1 : patchOf[o]]);
    }
    const size = Math.sqrt(f.area) || 1;
    const loops = chainLoops(segs, size * 10);
    let outer = null;
    for (const L of loops) { const A = polyArea(L.pts); if (L.closed && (outer === null || A > outer.area)) outer = { ...L, area: A }; }
    const area = outer ? outer.area : f.area;
    // The floor loop runs with the pocket on its left; flip it so material is
    // on the left and right turns are the pocket's internal corners.
    const pocketLoop = outer ? outer.pts.slice().reverse() : null;
    let minCornerRadius = null;
    if (pocketLoop) minCornerRadius = loopMinConcaveRadius(pocketLoop);
    // corner radii also from concave partial cylinders among the walls with axis ∥ n
    for (const wl of upWalls) {
      const q = wl.q;
      if (q.kind === "cylinder" && q.concave && Math.abs(v.dot(q.axis, n)) > Math.cos(5 * DEG)) {
        minCornerRadius = minCornerRadius === null ? q.radius : Math.min(minCornerRadius, q.radius);
      }
    }
    const width = pocketLoop ? loopMinGap(pocketLoop, size * 10) : null;
    const minExt = planeExtents(mesh, f).min;
    const effWidth = width !== null ? Math.min(width, minExt) : minExt;

    // Open sides: boundary edges not adjacent to a wall, bucketed by outward direction in the floor's frame
    const sideLen = [0, 0, 0, 0], sideOpen = [0, 0, 0, 0];
    const wallIds = new Set(upWalls.map((x) => x.q.id));
    const frame = floorFrame(segs);
    for (const s of segs) {
      const dx = s[2] - s[0], dy = s[3] - s[1];
      const len = Math.hypot(dx, dy);
      if (len <= 0) continue;
      // outward (right) normal
      const ox = dy / len, oy = -dx / len;
      const d0 = ox * frame[0] + oy * frame[1], d1 = ox * frame[2] + oy * frame[3];
      const side = Math.abs(d0) >= Math.abs(d1) ? (d0 >= 0 ? 0 : 1) : (d1 >= 0 ? 2 : 3);
      sideLen[side] += len;
      if (!wallIds.has(s[4])) sideOpen[side] += len;
    }
    let openSides = 0;
    for (let k = 0; k < 4; k++) if (sideLen[k] > 0 && sideOpen[k] / sideLen[k] > 0.5) openSides++;
    if (openSides >= 4) continue;

    const perimeter = outer ? outer.length : total;
    pockets.push({
      area: Math.abs(area), depth, floorArea: f.area, openSides, minCornerRadius,
      depthToWidthRatio: effWidth > 0 ? depth / effWidth : null,
      accessAxis: n, perimeter, width: effWidth, center: floorCenter(mesh, f), floorPatchId: f.id,
      confidenceSource: f.source,
    });
    floorPatchIds.add(f.id);
  }
  return { pockets, floorPatchIds };
}

/** True when ≥ 80% of sampled rays from the patch along its normal leave the part. */
function openAbove(mesh, f, bvh) {
  const { raycast } = require("./bvh");
  const n = f.normal;
  const eps = 1e-6 * mesh.diag;
  const step = Math.max(1, Math.floor(f.tris.length / 24));
  let free = 0, count = 0;
  for (let i = 0; i < f.tris.length; i += step) {
    const t = f.tris[i];
    const ox = mesh.centroid[t * 3] + n[0] * eps, oy = mesh.centroid[t * 3 + 1] + n[1] * eps, oz = mesh.centroid[t * 3 + 2] + n[2] * eps;
    const h = raycast(bvh, ox, oy, oz, n[0], n[1], n[2], eps, Infinity, t);
    count++;
    if (!h) free++;
  }
  return count > 0 && free / count >= 0.8;
}

/** Principal in-plane directions (unit, 2D) of a set of 2D segments by their length-weighted orientation. */
function floorFrame(segs) {
  // dominant edge direction (mod 90°) via doubled-angle averaging mod 180 then mod 90
  let sx = 0, sy = 0;
  for (const s of segs) {
    const dx = s[2] - s[0], dy = s[3] - s[1];
    const len = Math.hypot(dx, dy);
    if (len <= 0) continue;
    const ang = Math.atan2(dy, dx) * 4; // mod 90°
    sx += len * Math.cos(ang); sy += len * Math.sin(ang);
  }
  const ang = Math.atan2(sy, sx) / 4;
  const c = Math.cos(ang), s = Math.sin(ang);
  return [c, s, -s, c]; // e1=(c,s), e2=(-s,c)
}

function floorCenter(mesh, f) {
  let cx = 0, cy = 0, cz = 0, A = 0;
  for (const t of f.tris) { const a = mesh.area[t]; cx += a * mesh.centroid[t * 3]; cy += a * mesh.centroid[t * 3 + 1]; cz += a * mesh.centroid[t * 3 + 2]; A += a; }
  return A > 0 ? [cx / A, cy / A, cz / A] : [0, 0, 0];
}

/**
 * Slots: through stadium cutouts in the profile + half-round channels.
 */
function detectSlots(profile, partialCylinders, shape, thickness, bvh) {
  const slots = [];
  if (profile && profile.loops) {
    for (const L of profile.loops) {
      if (!L.closed || L.outer) continue;
      const A = Math.abs(L.area), P = L.length;
      if (A <= 0 || P <= 0) continue;
      const circularity = (4 * Math.PI * A) / (P * P);
      if (circularity >= 0.95) continue; // round hole
      const width = loopMinGap(L.pts, Math.sqrt(A) * 10);
      if (width === null || width <= 0) continue;
      // bounding extent of the loop for length
      let maxLen = 0;
      const pts = L.pts;
      const step = Math.max(1, Math.floor(pts.length / 64));
      for (let i = 0; i < pts.length; i += step) for (let j = i + step; j < pts.length; j += step) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        if (d > maxLen) maxLen = d;
      }
      if (maxLen < 1.5 * width) continue; // not elongated: a square/odd cutout
      // stadium check: area ≈ w(L-w) + πw²/4
      const stadiumArea = width * (maxLen - width) + (Math.PI * width * width) / 4;
      const isStadium = Math.abs(A - stadiumArea) / stadiumArea < 0.15;
      slots.push({ width, length: maxLen, depth: thickness, through: true, shape: isStadium ? "stadium" : "elongated", perimeter: P, area: A });
    }
  }
  for (const c of partialCylinders) {
    if (!c.concave || c.coverageDeg < 150 || c.coverageDeg > 220) continue;
    if (c.length < 2 * c.radius) continue; // a notch or a slot end, not a channel
    // the open side of the channel must face free space
    if (bvh) {
      const { raycast } = require("./bvh");
      const [u, w] = v.basis(c.axis);
      // covered arc runs CCW from arcStart to arcEnd; the gap runs CCW from arcEnd to arcStart
      const gap = ((c.arcStart - c.arcEnd) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const mid = c.arcEnd + gap / 2; // bisector of the open side
      const d = v.add(v.scale(u, Math.cos(mid)), v.scale(w, Math.sin(mid)));
      const o = c.center;
      if (raycast(bvh, o[0], o[1], o[2], d[0], d[1], d[2], 1e-6, Infinity)) continue;
    }
    const a = v.canon(c.axis);
    const through = shape.extents ? c.length >= 0.95 * shape.extents(a) : false;
    slots.push({ width: 2 * c.radius, length: c.length, depth: c.radius, through, shape: "half-round", axis: a });
  }
  return slots;
}

module.exports = { detectHolesAndBosses, detectPockets, detectSlots, mergeCylinders, coaxial, FULL_COVERAGE_DEG };
