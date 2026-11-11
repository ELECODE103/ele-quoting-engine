/**
 * DXF reader for flat routed parts — ASCII DXF → normalised 2D curves in mm.
 *
 *   const doc = readDxf(text);                    // sections, header, layers, blocks, raw entities
 *   const units = resolveUnits(doc.header, "in"); // $INSUNITS / $MEASUREMENT / customer override
 *   const { curves, ignored } = normalise(doc, units.scale);
 *
 * Supported entities: LINE, ARC, CIRCLE, LWPOLYLINE and POLYLINE (2D, with
 * bulges), ELLIPSE and SPLINE (flattened to FLATTEN_TOL_MM), INSERT (blocks,
 * nested, scaled, rotated, mirrored, arrayed). Everything else is counted in
 * `ignored` and never cut: dimensions, text, hatches, points, leaders,
 * viewports, images, 3D solids, plus anything on an annotation / construction
 * layer, a frozen or switched-off layer, a non-continuous linetype (centre,
 * hidden, phantom …) or in paper space.
 *
 * A curve is a path of exact primitives so perimeters and areas are analytic:
 *   { segs: [ { k: "L", a: [x,y], b: [x,y] }
 *           | { k: "A", a, b, c: [x,y], r, a0, sweep } ],   // sweep > 0 = CCW, radians
 *     closed: bool, layer, src: "LINE"|…, approx: bool }    // approx = flattened spline/ellipse
 *
 * No dependencies. Never evaluates anything from the file; a malformed file
 * throws an Error whose message is safe to show the customer.
 */

const FLATTEN_TOL_MM = 0.005;   // chord error when a spline / ellipse becomes line segments
// Entity ceiling: admin-tunable (DXF_MAX_ENTITIES, default 100,000). Read when used so a test can change it.
const maxEntities = () => require("../../security/limits").limits.dxfMaxEntities;
const MAX_CURVES = 120000;
const MAX_INSERT_DEPTH = 8;

// $INSUNITS → [name, mm per unit]
const INSUNITS = {
  1: ["in", 25.4], 2: ["ft", 304.8], 4: ["mm", 1], 5: ["cm", 10], 6: ["m", 1000],
  8: ["microinch", 0.0000254], 9: ["mil", 0.0254], 10: ["yd", 914.4], 13: ["micron", 0.001], 14: ["dm", 100],
};
const UNIT_SCALE = { mm: 1, in: 25.4, ft: 304.8, cm: 10, m: 1000, microinch: 0.0000254, mil: 0.0254, yd: 914.4, micron: 0.001, dm: 100 };

// Layers that carry drawing furniture, not cut geometry (matched as whole words in the layer name).
const ANNOTATION_LAYER = /(^|[^a-z])(dim|dims|dimension|dimensions|text|txt|anno|annotation|annotations|note|notes|title|titleblock|title[-_ ]?block|border|construction|constr|defpoints|hidden|center|centre|centerline|centerlines|centreline|hatch|bom|legend|viewport|leader|leaders)([^a-z]|$)/i;
const CONSTRUCTION_LINETYPE = /center|centre|hidden|dash|phantom|dot|divide|border/i;
const ANNOTATION_ENTITIES = new Set(["TEXT", "MTEXT", "DIMENSION", "LEADER", "MLEADER", "MULTILEADER", "HATCH", "POINT", "ATTDEF", "ATTRIB", "VIEWPORT", "IMAGE", "WIPEOUT", "TOLERANCE", "XLINE", "RAY", "SOLID", "TRACE", "MLINE", "OLE2FRAME", "ACAD_TABLE", "TABLE", "SHAPE", "ARC_DIMENSION", "LARGE_RADIAL_DIMENSION", "ACAD_PROXY_ENTITY"]);
const SOLID_ENTITIES = new Set(["3DSOLID", "BODY", "REGION", "SURFACE", "MESH", "3DFACE", "EXTRUDEDSURFACE", "REVOLVEDSURFACE", "LOFTEDSURFACE", "SWEPTSURFACE", "PLANESURFACE", "NURBSSURFACE"]);

// ─── tokeniser ───────────────────────────────────────────────────────────────
function tokenise(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (!Number.isFinite(code)) {
      if (lines[i].trim() === "") { i -= 1; continue; } // stray blank line: resync one line on
      throw new Error("This DXF could not be read (a group code is not a number). Re-export it as an ASCII DXF (R12 or 2000+) and upload again.");
    }
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}

/** Split a flat pair list into records that each start at a group-0 pair. */
function records(pairs, from, to) {
  const out = [];
  let cur = null;
  for (let i = from; i < to; i++) {
    const [code, value] = pairs[i];
    if (code === 0) { cur = { type: value.trim().toUpperCase(), pairs: [] }; out.push(cur); }
    else if (cur) cur.pairs.push([code, value]);
  }
  return out;
}

function readDxf(input) {
  let text;
  if (Buffer.isBuffer(input)) {
    if (input.slice(0, 18).toString("latin1") === "AutoCAD Binary DXF") {
      throw new Error("This is a binary DXF. Save it as an ASCII (text) DXF — in AutoCAD: Save As → DXF, in Fusion/SolidWorks/Inkscape the default DXF export — and upload again.");
    }
    text = input.toString("utf8");
  } else text = String(input || "");
  const pairs = tokenise(text);
  if (pairs.length < 4) throw new Error("This DXF is empty.");

  // Section boundaries
  const sections = Object.create(null);
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === "SECTION" && pairs[i + 1] && pairs[i + 1][0] === 2) {
      const name = pairs[i + 1][1].trim().toUpperCase();
      let j = i + 2;
      while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1].trim() === "ENDSEC")) j++;
      sections[name] = [i + 2, j];
      i = j;
    }
  }
  if (!sections.ENTITIES) throw new Error("This DXF has no ENTITIES section, so there is nothing to cut. Export the part outline (not a drawing sheet) as DXF and upload again.");

  // Header variables
  const header = Object.create(null);
  if (sections.HEADER) {
    const [a, b] = sections.HEADER;
    for (let i = a; i < b; i++) {
      if (pairs[i][0] === 9 && pairs[i + 1]) header[pairs[i][1].trim().toUpperCase()] = pairs[i + 1][1].trim();
    }
  }

  // Layer table
  const layers = Object.create(null);
  if (sections.TABLES) {
    for (const rec of records(pairs, sections.TABLES[0], sections.TABLES[1])) {
      if (rec.type !== "LAYER") continue;
      let name = null, flags = 0, color = 7, linetype = "CONTINUOUS";
      for (const [c, v] of rec.pairs) {
        if (c === 2) name = v.trim();
        else if (c === 70) flags = parseInt(v, 10) || 0;
        else if (c === 62) color = parseInt(v, 10) || 0;
        else if (c === 6) linetype = v.trim();
      }
      if (name != null) layers[name.toUpperCase()] = { name, frozen: (flags & 1) === 1, off: color < 0, linetype };
    }
  }

  // Blocks
  const blocks = Object.create(null);
  if (sections.BLOCKS) {
    let cur = null;
    for (const rec of records(pairs, sections.BLOCKS[0], sections.BLOCKS[1])) {
      if (rec.type === "BLOCK") {
        cur = { name: "", base: [0, 0], entities: [] };
        for (const [c, v] of rec.pairs) {
          if (c === 2) cur.name = v.trim();
          else if (c === 10) cur.base[0] = parseFloat(v) || 0;
          else if (c === 20) cur.base[1] = parseFloat(v) || 0;
        }
      } else if (rec.type === "ENDBLK") {
        if (cur) blocks[cur.name.toUpperCase()] = cur;
        cur = null;
      } else if (cur) cur.entities.push(rec);
    }
  }

  const entities = records(pairs, sections.ENTITIES[0], sections.ENTITIES[1]);
  if (entities.length > maxEntities()) throw Object.assign(new Error(`This DXF has ${entities.length.toLocaleString("en-US")} entities — more than the instant quote reads (${maxEntities().toLocaleString("en-US")}). Send it to us as an RFQ, or simplify the drawing to the part outline.`), { code: "model-too-large", expose: true, offerRfq: true });
  return { header, layers, blocks, entities };
}

// ─── units ───────────────────────────────────────────────────────────────────
/**
 * Decide the drawing units.
 *   override "mm" | "in"   the customer's explicit choice (always wins)
 * Returns { unit, scale (mm per drawing unit), source, needsConfirmation, declared, measurement, reason }.
 * needsConfirmation is true when the file is unitless ($INSUNITS 0 or missing)
 * or contradicts itself (inches by $INSUNITS but metric by $MEASUREMENT).
 */
function resolveUnits(header = {}, override) {
  const ins = parseInt(header.$INSUNITS, 10);
  const meas = header.$MEASUREMENT != null ? parseInt(header.$MEASUREMENT, 10) : null;
  const declared = INSUNITS[ins] ? INSUNITS[ins][0] : null;
  const base = { declared, insunits: Number.isFinite(ins) ? ins : null, measurement: Number.isFinite(meas) ? meas : null };
  if (override === "mm" || override === "in") {
    return { ...base, unit: override, scale: UNIT_SCALE[override], source: "customer", needsConfirmation: false, reason: "chosen by the customer" };
  }
  if (declared) {
    const conflict = declared === "in" && meas === 1;
    return {
      ...base, unit: declared, scale: UNIT_SCALE[declared], source: "file", needsConfirmation: conflict,
      reason: conflict
        ? "the file says inches ($INSUNITS) but metric ($MEASUREMENT) — confirm which"
        : `read from the file ($INSUNITS = ${ins})`,
    };
  }
  const guess = meas === 0 ? "in" : "mm";
  return {
    ...base, unit: guess, scale: UNIT_SCALE[guess], source: "assumed", needsConfirmation: true,
    reason: meas === 0 ? "the file has no units; its imperial flag ($MEASUREMENT = 0) suggests inches"
      : meas === 1 ? "the file has no units; its metric flag ($MEASUREMENT = 1) suggests millimetres"
        : "the file has no units; millimetres assumed",
  };
}

// ─── geometry helpers ────────────────────────────────────────────────────────
const TAU = Math.PI * 2;
const line = (a, b) => ({ k: "L", a, b });
function arcFrom(c, r, a0, sweep) {
  return {
    k: "A", c, r, a0, sweep,
    a: [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)],
    b: [c[0] + r * Math.cos(a0 + sweep), c[1] + r * Math.sin(a0 + sweep)],
  };
}
/** Arc through a→b with DXF bulge (tan of a quarter of the included angle, + = CCW). */
function bulgeArc(a, b, bulge) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-12 || Math.abs(bulge) < 1e-9) return line(a, b);
  const sweep = 4 * Math.atan(bulge);
  const k = (1 - bulge * bulge) / (4 * bulge);
  const c = [(a[0] + b[0]) / 2 - dy * k, (a[1] + b[1]) / 2 + dx * k];
  const r = Math.abs(d * (1 + bulge * bulge) / (4 * bulge));
  return { k: "A", c, r, a0: Math.atan2(a[1] - c[1], a[0] - c[0]), sweep, a, b };
}

/** Adaptive flattening of a parametric curve to a polyline within `tol`. */
function flatten(fn, t0, t1, tol, seed) {
  const pts = [];
  const rec = (ta, pa, tb, pb, depth) => {
    const tm = (ta + tb) / 2, pm = fn(tm);
    const q1 = fn((ta + tm) / 2), q3 = fn((tm + tb) / 2);
    const dev = Math.max(distToChord(pm, pa, pb), distToChord(q1, pa, pb), distToChord(q3, pa, pb));
    if (depth < 12 && dev > tol) { rec(ta, pa, tm, pm, depth + 1); rec(tm, pm, tb, pb, depth + 1); }
    else pts.push(pb);
  };
  let prevT = t0, prev = fn(t0);
  pts.push(prev);
  for (let i = 1; i <= seed; i++) {
    const t = t0 + ((t1 - t0) * i) / seed, p = fn(t);
    rec(prevT, prev, t, p, 0);
    prevT = t; prev = p;
  }
  return pts;
}
function distToChord(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-24) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function polySegs(pts) {
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) > 1e-12) segs.push(line(pts[i - 1], pts[i]));
  }
  return segs;
}

/** NURBS point by de Boor (rational when weights are given). */
function nurbsEvaluator(degree, knots, ctrl, weights) {
  const n = ctrl.length;
  const w = weights && weights.length === n ? weights : null;
  return (t) => {
    let k = degree;
    const hi = n - 1;
    while (k < hi && knots[k + 1] <= t) k++;
    const d = [];
    for (let j = 0; j <= degree; j++) {
      const idx = Math.min(Math.max(k - degree + j, 0), n - 1);
      const wt = w ? w[idx] : 1;
      d.push([ctrl[idx][0] * wt, ctrl[idx][1] * wt, wt]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den > 1e-14 ? (t - knots[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    const p = d[degree];
    return [p[0] / p[2], p[1] / p[2]];
  };
}

/** Centripetal Catmull-Rom through fit points (used only when a SPLINE has no control points). */
function catmullRom(points, closed, tol) {
  const P = points.slice();
  if (P.length < 3) return P;
  const get = (i) => (closed ? P[((i % P.length) + P.length) % P.length] : P[Math.max(0, Math.min(P.length - 1, i))]);
  const out = [P[0]];
  const last = closed ? P.length : P.length - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const fn = (t) => {
      const t2 = t * t, t3 = t2 * t;
      return [0, 1].map((k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
    };
    const seg = flatten(fn, 0, 1, tol, 4);
    for (let j = 1; j < seg.length; j++) out.push(seg[j]);
  }
  return out;
}

// ─── transforms (INSERT, OCS mirror, unit scale) ─────────────────────────────
// Affine 2D: [a, b, c, d, e, f] → x' = a x + c y + e, y' = b x + d y + f
const IDENT = [1, 0, 0, 1, 0, 0];
function mul(m, n) { // m ∘ n (apply n first)
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
function similarity(m) {
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  const det = m[0] * m[3] - m[1] * m[2];
  const ortho = Math.abs(m[0] * m[2] + m[1] * m[3]) <= 1e-9 * Math.max(sx * sy, 1e-12);
  return { uniform: ortho && Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy, 1e-12), scale: sx, mirrored: det < 0 };
}
function transformSegs(segs, m, tol) {
  const sim = similarity(m);
  const out = [];
  for (const s of segs) {
    if (s.k === "L") { out.push(line(apply(m, s.a), apply(m, s.b))); continue; }
    if (sim.uniform) {
      const c = apply(m, s.c), a = apply(m, s.a), b = apply(m, s.b);
      out.push({ k: "A", c, r: s.r * sim.scale, a0: Math.atan2(a[1] - c[1], a[0] - c[0]), sweep: sim.mirrored ? -s.sweep : s.sweep, a, b });
    } else {
      // Non-uniform scale turns an arc into an elliptical arc: flatten it.
      const fn = (t) => apply(m, [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]);
      out.push(...polySegs(flatten(fn, s.a0, s.a0 + s.sweep, tol, Math.max(4, Math.ceil(Math.abs(s.sweep) / (Math.PI / 8))))));
    }
  }
  return out;
}

// ─── entity → curves ─────────────────────────────────────────────────────────
function num(v, d = 0) { const x = parseFloat(v); return Number.isFinite(x) ? x : d; }

function common(rec) {
  const o = { layer: "0", linetype: null, paper: false, nz: 1, nx: 0, ny: 0 };
  for (const [c, v] of rec.pairs) {
    if (c === 8) o.layer = v.trim();
    else if (c === 6) o.linetype = v.trim();
    else if (c === 67) o.paper = parseInt(v, 10) === 1;
    else if (c === 210) o.nx = num(v);
    else if (c === 220) o.ny = num(v);
    else if (c === 230) o.nz = num(v, 1);
  }
  return o;
}

/**
 * Convert the document to curves in mm.
 * @param {object} doc    readDxf() result
 * @param {number} scale  mm per drawing unit
 */
function normalise(doc, scale) {
  const tol = FLATTEN_TOL_MM / scale; // flatten in drawing units so the mm error is constant
  const curves = [];
  // Layer and entity names come from the file: keep them in prototype-less maps.
  const ignored = { entityTypes: Object.create(null), layers: Object.create(null), solids: 0, nonPlanar: 0, paperSpace: 0, unknownBlocks: 0, total: 0 };
  const usedLayers = Object.create(null);
  const skip = (bucket, key) => { ignored[bucket][key] = (ignored[bucket][key] || 0) + 1; ignored.total++; };
  let approxCount = 0;

  const layerReason = (name, linetype) => {
    const L = doc.layers[String(name).toUpperCase()];
    if (L && L.frozen) return "frozen layer";
    if (L && L.off) return "layer switched off";
    if (ANNOTATION_LAYER.test(name)) return "annotation / construction layer";
    const lt = linetype && !/^by(layer|block)$/i.test(linetype) ? linetype : L ? L.linetype : null;
    if (lt && CONSTRUCTION_LINETYPE.test(lt)) return `${lt.toLowerCase()} linetype`;
    return null;
  };

  const emit = (segs, closed, layer, src, m, approx) => {
    const t = transformSegs(segs, m, tol);
    if (!t.length) return;
    if (curves.length >= MAX_CURVES) throw new Error("This DXF has too many curves for the instant quote. Send it to us as an RFQ, or simplify the drawing to the part outline.");
    if (approx) approxCount++;
    usedLayers[layer] = (usedLayers[layer] || 0) + 1;
    curves.push({ segs: t, closed: !!closed, layer, src, approx: !!approx });
  };

  const walk = (recs, m, depth, insertLayer) => {
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const type = rec.type;
      if (type === "SEQEND" || type === "VERTEX" || type === "ENDSEC" || type === "EOF") continue;
      const cm = common(rec);
      const layer = insertLayer != null && cm.layer === "0" ? insertLayer : cm.layer;
      if (cm.paper) { ignored.paperSpace++; ignored.total++; continue; }
      if (ANNOTATION_ENTITIES.has(type)) { skip("entityTypes", type); continue; }
      if (SOLID_ENTITIES.has(type)) { ignored.solids++; skip("entityTypes", type); continue; }
      const why = layerReason(layer, cm.linetype);
      if (why) {
        if (!ignored.layers[layer]) ignored.layers[layer] = { name: layer, reason: why, count: 0 };
        ignored.layers[layer].count++; ignored.total++;
        // a POLYLINE's vertices follow as separate records: skip them too
        if (type === "POLYLINE") while (i + 1 < recs.length && recs[i + 1].type !== "SEQEND") i++;
        continue;
      }
      // Object coordinate system: only the two planar cases are supported.
      const planarEntity = type === "CIRCLE" || type === "ARC" || type === "LWPOLYLINE" || type === "POLYLINE" || type === "INSERT" || type === "ELLIPSE";
      if (planarEntity && (Math.abs(cm.nx) > 1e-6 || Math.abs(cm.ny) > 1e-6)) { ignored.nonPlanar++; ignored.total++; continue; }
      const flip = cm.nz < 0;
      const mo = flip && type !== "ELLIPSE" ? mul(m, [-1, 0, 0, 1, 0, 0]) : m; // OCS for N = −Z mirrors X

      if (type === "LINE") {
        let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        for (const [c, v] of rec.pairs) { if (c === 10) x1 = num(v); else if (c === 20) y1 = num(v); else if (c === 11) x2 = num(v); else if (c === 21) y2 = num(v); }
        emit([line([x1, y1], [x2, y2])], false, layer, type, m);
      } else if (type === "CIRCLE" || type === "ARC") {
        let cx = 0, cy = 0, r = 0, a0 = 0, a1 = 360;
        for (const [c, v] of rec.pairs) { if (c === 10) cx = num(v); else if (c === 20) cy = num(v); else if (c === 40) r = num(v); else if (c === 50) a0 = num(v); else if (c === 51) a1 = num(v, 360); }
        if (!(r > 0)) continue;
        if (type === "CIRCLE") emit([arcFrom([cx, cy], r, 0, TAU)], true, layer, type, mo);
        else {
          let sweep = ((a1 - a0) % 360 + 360) % 360;
          if (sweep < 1e-9) sweep = 360;
          emit([arcFrom([cx, cy], r, (a0 * Math.PI) / 180, (sweep * Math.PI) / 180)], false, layer, type, mo);
        }
      } else if (type === "LWPOLYLINE") {
        const verts = [];
        let closed = false;
        for (const [c, v] of rec.pairs) {
          if (c === 70) closed = (parseInt(v, 10) & 1) === 1;
          else if (c === 10) verts.push([num(v), 0, 0]);
          else if (c === 20 && verts.length) verts[verts.length - 1][1] = num(v);
          else if (c === 42 && verts.length) verts[verts.length - 1][2] = num(v);
        }
        const segs = polylineSegs(verts, closed);
        if (segs.length) emit(segs, closed, layer, type, mo);
      } else if (type === "POLYLINE") {
        let flags = 0;
        for (const [c, v] of rec.pairs) if (c === 70) flags = parseInt(v, 10) || 0;
        const verts = [];
        while (i + 1 < recs.length && recs[i + 1].type === "VERTEX") {
          i++;
          let x = 0, y = 0, b = 0, vf = 0;
          for (const [c, v] of recs[i].pairs) { if (c === 10) x = num(v); else if (c === 20) y = num(v); else if (c === 42) b = num(v); else if (c === 70) vf = parseInt(v, 10) || 0; }
          if (vf & 16) continue; // spline frame control point
          verts.push([x, y, b]);
        }
        if (flags & (16 | 64)) { ignored.solids++; skip("entityTypes", "POLYLINE (mesh)"); continue; }
        const closed = (flags & 1) === 1;
        const segs = polylineSegs(verts, closed);
        if (segs.length) emit(segs, closed, layer, type, mo);
      } else if (type === "ELLIPSE") {
        let cx = 0, cy = 0, mx = 0, my = 0, ratio = 1, t0 = 0, t1 = TAU;
        for (const [c, v] of rec.pairs) { if (c === 10) cx = num(v); else if (c === 20) cy = num(v); else if (c === 11) mx = num(v); else if (c === 21) my = num(v); else if (c === 40) ratio = num(v, 1); else if (c === 41) t0 = num(v); else if (c === 42) t1 = num(v, TAU); }
        const a = Math.hypot(mx, my);
        if (!(a > 0) || !(ratio > 0)) continue;
        const sgn = flip ? -1 : 1; // minor axis = N × major
        const nxm = -my * ratio * sgn, nym = mx * ratio * sgn;
        let sweep = t1 - t0;
        while (sweep <= 1e-9) sweep += TAU;
        if (sweep > TAU) sweep = TAU;
        const full = Math.abs(sweep - TAU) < 1e-6;
        const fn = (t) => [cx + mx * Math.cos(t) + nxm * Math.sin(t), cy + my * Math.cos(t) + nym * Math.sin(t)];
        const pts = flatten(fn, t0, t0 + sweep, tol, Math.max(8, Math.ceil(sweep / (Math.PI / 16))));
        if (full) pts[pts.length - 1] = pts[0];
        emit(polySegs(pts), full, layer, type, m, true);
      } else if (type === "SPLINE") {
        let flags = 0, degree = 3;
        const knots = [], ctrl = [], fit = [], weights = [];
        for (const [c, v] of rec.pairs) {
          if (c === 70) flags = parseInt(v, 10) || 0;
          else if (c === 71) degree = parseInt(v, 10) || 3;
          else if (c === 40) knots.push(num(v));
          else if (c === 41) weights.push(num(v, 1));
          else if (c === 10) ctrl.push([num(v), 0]);
          else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = num(v);
          else if (c === 11) fit.push([num(v), 0]);
          else if (c === 21 && fit.length) fit[fit.length - 1][1] = num(v);
        }
        let pts = null;
        if (ctrl.length > degree && knots.length >= ctrl.length + degree + 1) {
          const ev = nurbsEvaluator(degree, knots, ctrl, weights);
          const lo = knots[degree], hi = knots[ctrl.length];
          pts = [];
          // flatten span by span so a knot (possible kink) is always a vertex
          const breaks = [lo];
          for (let k = degree + 1; k <= ctrl.length; k++) if (knots[k] > breaks[breaks.length - 1] + 1e-12) breaks.push(Math.min(knots[k], hi));
          for (let b = 1; b < breaks.length; b++) {
            const span = flatten(ev, breaks[b - 1], breaks[b] - (b === breaks.length - 1 ? 1e-12 * Math.max(1, Math.abs(hi)) : 0), tol, 4);
            for (let j = pts.length ? 1 : 0; j < span.length; j++) pts.push(span[j]);
          }
        } else if (fit.length >= 2) {
          pts = catmullRom(fit, (flags & 1) === 1, tol);
        } else if (ctrl.length >= 2) {
          pts = ctrl; // degenerate: treat the control polygon as the curve
        }
        if (!pts || pts.length < 2) continue;
        const closed = (flags & 1) === 1 || Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= tol;
        if (closed) pts[pts.length - 1] = pts[0];
        emit(polySegs(pts), closed, layer, type, m, true);
      } else if (type === "INSERT") {
        let name = "", ix = 0, iy = 0, sx = 1, sy = 1, rot = 0, cols = 1, rows = 1, dc = 0, dr = 0;
        for (const [c, v] of rec.pairs) {
          if (c === 2) name = v.trim(); else if (c === 10) ix = num(v); else if (c === 20) iy = num(v);
          else if (c === 41) sx = num(v, 1); else if (c === 42) sy = num(v, 1); else if (c === 50) rot = num(v);
          else if (c === 70) cols = Math.max(1, parseInt(v, 10) || 1); else if (c === 71) rows = Math.max(1, parseInt(v, 10) || 1);
          else if (c === 44) dc = num(v); else if (c === 45) dr = num(v);
        }
        const block = doc.blocks[name.toUpperCase()];
        if (!block || depth >= MAX_INSERT_DEPTH) { ignored.unknownBlocks++; ignored.total++; continue; }
        if (cols * rows > 10000) throw new Error("This DXF has a block array with more than 10,000 copies. Send it to us as an RFQ.");
        const cs = Math.cos((rot * Math.PI) / 180), sn = Math.sin((rot * Math.PI) / 180);
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          // p' = ins + R · (S · (p − base) + array offset)
          const ox = c * dc, oy = r * dr;
          const t = [
            cs * sx, sn * sx, -sn * sy, cs * sy,
            ix + cs * (ox - sx * block.base[0]) - sn * (oy - sy * block.base[1]),
            iy + sn * (ox - sx * block.base[0]) + cs * (oy - sy * block.base[1]),
          ];
          walk(block.entities, mul(mo, t), depth + 1, layer);
        }
      } else {
        skip("entityTypes", type);
      }
    }
  };

  walk(doc.entities, [scale, 0, 0, scale, 0, 0], 0, null);
  ignored.layers = Object.values(ignored.layers);
  ignored.entityTypes = { ...ignored.entityTypes };
  return { curves, ignored, usedLayers: Object.keys(usedLayers), approxCount };
}

function polylineSegs(verts, closed) {
  const segs = [];
  const n = verts.length;
  if (n < 2) return segs;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p = verts[i], q = verts[(i + 1) % n];
    const a = [p[0], p[1]], b = [q[0], q[1]];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-12) continue;
    segs.push(bulgeArc(a, b, p[2] || 0));
  }
  return segs;
}

module.exports = {
  readDxf, resolveUnits, normalise, flatten, bulgeArc, arcFrom, line,
  FLATTEN_TOL_MM, UNIT_SCALE, INSUNITS, ANNOTATION_LAYER,
};
