/**
 * DXF generators for the benchmark corpus (deterministic; built with the
 * repo's own DXF writer, server/geometry/dxf/writer.js).
 *
 * Each returns the DXF text. Sizes are given as an entity or feature count so
 * the same drawing exists small, medium and at the 100,000-entity ceiling.
 */
const path = require("path");
const w = require(path.join(__dirname, "..", "..", "..", "server", "geometry", "dxf", "writer"));
const { rng } = require("./mesh");

const mm = { insunits: 4, measurement: 1 };
const doc = (entities, extra = {}) => w.dxf({ ...mm, ...extra, entities });

/** `n` random crossing lines (the generator the upload tests use, same seed). */
function crossingLines(n) {
  let seed = 1;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1000;
  let s = "0\nSECTION\n2\nENTITIES\n";
  for (let i = 0; i < n; i++) s += `0\nLINE\n8\n0\n10\n${r()}\n20\n${r()}\n11\n${r()}\n21\n${r()}\n`;
  return s + "0\nENDSEC\n0\nEOF\n";
}

/** Rectangular plate with a square grid of round holes (CIRCLE entities). */
function perforated(holes, { d = 4, pitch = 9, margin = 8, hex = false } = {}) {
  const cols = Math.max(1, Math.round(Math.sqrt(holes))), rows = Math.max(1, Math.ceil(holes / cols));
  const e = [w.rect(0, 0, 2 * margin + (cols - 1) * pitch + (hex ? pitch / 2 : 0), 2 * margin + (rows - 1) * pitch * (hex ? 0.866 : 1))];
  let k = 0;
  for (let j = 0; j < rows && k < holes; j++) for (let i = 0; i < cols && k < holes; i++, k++) {
    e.push(w.circle(margin + i * pitch + (hex && j % 2 ? pitch / 2 : 0), margin + j * pitch * (hex ? 0.866 : 1), d / 2));
  }
  return doc(e);
}
/** The same panel with the holes placed by one arrayed INSERT of a block. */
function perforatedInsert(cols, rows, { d = 4, pitch = 9, margin = 8 } = {}) {
  return doc([
    w.rect(0, 0, 2 * margin + (cols - 1) * pitch, 2 * margin + (rows - 1) * pitch),
    w.insert("HOLE", margin, margin, { cols, rows, dc: pitch, dr: pitch }),
  ], { blocks: [{ name: "HOLE", entities: [w.circle(0, 0, d / 2)] }] });
}
/** Plate with a grid of mixed cutouts: slots, rounded windows, polygon holes, splined and elliptical openings. */
function mixedCutouts(n) {
  const cols = Math.max(1, Math.round(Math.sqrt(n))), rows = Math.max(1, Math.ceil(n / cols));
  const pitch = 30, margin = 12;
  const e = [w.roundRect(0, 0, 2 * margin + cols * pitch, 2 * margin + rows * pitch, 6)];
  let k = 0;
  for (let j = 0; j < rows && k < n; j++) for (let i = 0; i < cols && k < n; i++, k++) {
    const cx = margin + (i + 0.5) * pitch, cy = margin + (j + 0.5) * pitch;
    switch (k % 7) {
      case 0: e.push(w.slot(cx, cy, 18, 6)); break;
      case 1: e.push(w.roundRect(cx - 8, cy - 6, 16, 12, 2)); break;
      case 2: e.push(w.circle(cx, cy, 5)); break;
      case 3: e.push(w.circleSpline(cx, cy, 6)); break;
      case 4: e.push(w.ellipse(cx, cy, 9, 0, 0.5)); break;
      case 5: { // hexagon as a closed heavy POLYLINE
        const v = []; for (let a = 0; a < 6; a++) v.push([cx + 7 * Math.cos((a * Math.PI) / 3), cy + 7 * Math.sin((a * Math.PI) / 3)]);
        e.push(w.polyline(v, true)); break;
      }
      default: { // keyhole: two arcs joined by lines
        e.push(w.arc(cx, cy, 5, 30, 330), w.line(cx + 5 * Math.cos(Math.PI / 6), cy + 2.5, cx + 11, cy + 2.5), w.line(cx + 11, cy + 2.5, cx + 11, cy - 2.5), w.line(cx + 11, cy - 2.5, cx + 5 * Math.cos(Math.PI / 6), cy - 2.5));
      }
    }
  }
  return doc(e);
}
/** Outline drawn as separate LINE entities in shuffled order, plus round holes. */
function looseLineOutline(sides, holes = 12, seed = 4) {
  const R = rng(seed);
  const pts = [];
  for (let i = 0; i < sides; i++) { const a = (2 * Math.PI * i) / sides, r = 200 + 30 * Math.sin(7 * a) + 12 * Math.sin(23 * a); pts.push([300 + r * Math.cos(a), 300 + r * Math.sin(a)]); }
  const e = [];
  for (let i = 0; i < sides; i++) { const p = pts[i], q = pts[(i + 1) % sides]; e.push(R() < 0.5 ? w.line(p[0], p[1], q[0], q[1]) : w.line(q[0], q[1], p[0], p[1])); }
  for (let i = e.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [e[i], e[j]] = [e[j], e[i]]; }
  for (let h = 0; h < holes; h++) { const a = (2 * Math.PI * h) / holes; e.push(w.circle(300 + 110 * Math.cos(a), 300 + 110 * Math.sin(a), 6)); }
  return doc(e);
}
/** One closed LWPOLYLINE with `n` vertices (a gear / scalloped outline) and a bore. */
function denseOutline(n, bulged = false) {
  const v = [];
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n, r = 150 + 8 * Math.sin(40 * a) + 3 * Math.sin(131 * a); v.push([200 + r * Math.cos(a), 200 + r * Math.sin(a), bulged && i % 2 ? 0.2 : 0]); }
  return doc([w.lwpolyline(v, true), w.circle(200, 200, 30), w.slot(200, 290, 60, 10), w.slot(200, 110, 60, 10)]);
}
/** Rectangles nested inside each other (depth ≥ 2 is "a part inside a cutout"). */
function nested(depth, count = 1) {
  const e = [];
  for (let c = 0; c < count; c++) for (let d = 0; d < depth; d++) e.push(w.rect(c * 220 + d * 12, d * 12, 200 - d * 24, 160 - d * 24));
  return doc(e);
}
/** A valid part: outer + cutouts, each cutout holding nothing (depth 1 only), many of them. */
function windows(n) {
  const cols = Math.max(1, Math.round(Math.sqrt(n))), rows = Math.max(1, Math.ceil(n / cols));
  const e = [w.rect(0, 0, cols * 20 + 10, rows * 20 + 10)];
  let k = 0;
  for (let j = 0; j < rows && k < n; j++) for (let i = 0; i < cols && k < n; i++, k++) e.push(w.rect(10 + i * 20, 10 + j * 20, 10 + (k % 3), 10 + (k % 5) * 0.5));
  return doc(e);
}
/** Open contours: an outline with gaps, stray lines, and T-junctions. */
function openContours(n, seed = 8, closedOuter = false) {
  const R = rng(seed);
  const e = closedOuter ? [w.rect(0, 0, 300, 200)] : [w.line(0, 0, 300, 0), w.line(300, 0, 300, 200), w.line(300, 200.4, 0, 200), w.line(0, 200, 0, 0.6)]; // two gaps
  for (let i = 0; i < n; i++) {
    const x = 20 + R() * 260, y = 20 + R() * 160;
    if (i % 3 === 0) e.push(w.line(x, y, x + 8, y), w.line(x + 8, y, x + 8, y + 6), w.line(x + 8.3, y + 6, x, y + 6)); // open U with a near miss
    else if (i % 3 === 1) e.push(w.line(x, y, x + 10, y), w.line(x + 5, y, x + 5, y + 7));                          // T-junction
    else e.push(w.arc(x, y, 4, 10, 200));                                                                             // open arc
  }
  return doc(e);
}
/** Square grid of lines (graph paper): every interior point is a junction or a crossing. */
function lineGrid(m, split = true) {
  const e = [];
  for (let i = 0; i <= m; i++) {
    if (split) for (let j = 0; j < m; j++) { e.push(w.line(i * 10, j * 10, i * 10, (j + 1) * 10)); e.push(w.line(j * 10, i * 10, (j + 1) * 10, i * 10)); }
    else { e.push(w.line(i * 10, 0, i * 10, m * 10)); e.push(w.line(0, i * 10, m * 10, i * 10)); }
  }
  return doc(e);
}
/** Drawing with duplicated and overlapping lines (a nest exported twice). */
function duplicates(n, seed = 13) {
  const R = rng(seed);
  const e = [w.rect(0, 0, 400, 300)];
  for (let i = 0; i < n; i++) {
    const x = 10 + R() * 360, y = 10 + R() * 270, len = 5 + R() * 20;
    e.push(w.line(x, y, x + len, y));
    if (i % 2 === 0) e.push(w.line(x, y, x + len, y));                 // exact duplicate
    if (i % 3 === 0) e.push(w.line(x + len * 0.5, y, x + len * 1.4, y)); // collinear overlap
    if (i % 5 === 0) e.push(w.circle(x, y + 5, 2), w.circle(x, y + 5, 2));
  }
  return doc(e);
}
/** Random rotated rectangles inside a sheet: some overlap (crossings), some nest. */
function scatteredRects(n, seed = 17) {
  const R = rng(seed), side = Math.sqrt(n) * 30;
  const e = [w.rect(0, 0, side + 40, side + 40)];
  for (let i = 0; i < n; i++) {
    const cx = 20 + R() * side, cy = 20 + R() * side, a = R() * Math.PI, hw = 3 + R() * 9, hh = 3 + R() * 6;
    const c = Math.cos(a), s = Math.sin(a);
    e.push(w.lwpolyline([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]), true));
  }
  return doc(e);
}
/** Free-form splines: a closed blob outline and wavy open cuts. */
function splines(n, seed = 19) {
  const R = rng(seed);
  const e = [];
  const closedBlob = (cx, cy, r, k) => {
    const ctrl = []; for (let i = 0; i < k; i++) { const a = (2 * Math.PI * i) / k, rr = r * (0.8 + 0.4 * R()); ctrl.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
    const c = ctrl.concat(ctrl.slice(0, 3));
    const knots = []; for (let i = 0; i < c.length + 4; i++) knots.push(i);
    return w.spline({ degree: 3, knots, ctrl: c, closed: true });
  };
  e.push(closedBlob(250, 250, 330, 24));
  const cols = Math.max(1, Math.round(Math.sqrt(n)));
  for (let i = 0; i < n; i++) e.push(closedBlob(90 + (i % cols) * (320 / cols), 90 + Math.floor(i / cols) * (320 / cols), Math.min(12, 120 / cols), 8));
  return doc(e);
}
/** Inch drawing with annotation layers, a title block, text and dimensions (all ignored), and a real part. */
function annotated() {
  return w.dxf({
    insunits: 1, measurement: 0,
    layers: [{ name: "0" }, { name: "DIM", color: 2 }, { name: "CENTER", linetype: "CENTER" }, { name: "FROZEN", flags: 1 }, { name: "BORDER" }],
    entities: [
      w.rect(0, 0, 6, 4), w.circle(1, 1, 0.25), w.circle(5, 1, 0.25), w.circle(1, 3, 0.25), w.circle(5, 3, 0.25), w.slot(3, 2, 2, 0.5),
      w.rect(-1, -1, 8, 6, { layer: "BORDER" }), w.line(0, 2, 6, 2, { layer: "CENTER" }), w.text(1, -0.5, 0.2, "PLATE", { layer: "0" }), w.dimension({ layer: "DIM" }),
      w.circle(3, 3.5, 0.2, { layer: "FROZEN" }), w.line(0, 0, 6, 4, { linetype: "HIDDEN" }),
    ],
  });
}
/** Blocks inserted rotated, mirrored and non-uniformly scaled (arcs become ellipses). */
function inserts() {
  const tab = [w.lwpolyline([[0, 0], [20, 0, 0.4], [20, 10], [0, 10, -0.3]], true), w.circle(10, 5, 2)];
  return doc([
    w.rect(-10, -10, 220, 160),
    w.insert("TAB", 10, 10), w.insert("TAB", 60, 20, { rot: 30 }), w.insert("TAB", 120, 10, { sx: -1, rot: 10 }),
    w.insert("TAB", 20, 80, { sx: 1.5, sy: 0.75 }), w.insert("TAB", 90, 90, { sx: 2, sy: 2, rot: 45 }), w.insert("TAB", 150, 60, { cols: 2, rows: 3, dc: 25, dr: 22 }),
  ], { blocks: [{ name: "TAB", entities: tab }] });
}
/** Holes placed by block inserts that are rotated, mirrored and stretched (a stretched circle is an ellipse). */
function insertedHoles() {
  return doc([
    w.rect(0, 0, 200, 120),
    w.insert("H", 20, 20), w.insert("H", 60, 20, { rot: 45 }), w.insert("H", 100, 20, { sx: -1 }), w.insert("H", 140, 20, { sx: 2, sy: 1 }),
    w.insert("H", 30, 70, { sx: 1.5, sy: 1.5 }), w.insert("H", 90, 60, { cols: 4, rows: 3, dc: 22, dr: 18, rot: 5 }), w.insert("S", 40, 100, { rot: 0 }), w.insert("S", 120, 100, { rot: 12, sx: 0.8, sy: 0.8 }),
  ], { blocks: [{ name: "H", entities: [w.circle(0, 0, 4)] }, { name: "S", entities: [w.slot(0, 0, 30, 6)] }] });
}
/** Two or more separate parts in one file. */
function separateParts(n) {
  const e = [];
  for (let i = 0; i < n; i++) e.push(w.rect(i * 60, 0, 50, 40), w.circle(i * 60 + 25, 20, 5));
  return doc(e);
}
/** A bow-tie outline (crosses itself) and two outlines that cross each other. */
function selfCrossing() {
  return doc([w.lwpolyline([[0, 0], [100, 60], [100, 0], [0, 60]], true), w.rect(150, 0, 80, 60), w.rect(200, 30, 80, 60), w.circle(170, 15, 6)]);
}
/** Narrow webs and notches: holes close to each other and to the edge, a thin slit. */
function tightWebs() {
  return doc([
    w.rect(0, 0, 120, 80), w.circle(10, 10, 4), w.circle(19, 10, 4), w.circle(4.6, 40, 4), w.slot(60, 40, 50, 1.2),
    w.rect(90, 60, 20, 19.5), w.lwpolyline([[40, 0], [40, 12], [41, 12], [41, 0]], false),
  ]);
}

module.exports = {
  crossingLines, perforated, perforatedInsert, mixedCutouts, looseLineOutline, denseOutline, nested, windows,
  openContours, lineGrid, duplicates, scatteredRects, splines, annotated, inserts, insertedHoles, separateParts, selfCrossing, tightWebs,
};
