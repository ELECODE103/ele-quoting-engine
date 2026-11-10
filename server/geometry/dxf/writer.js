/**
 * Minimal ASCII DXF writer — used to generate test fixtures and the DXF parts
 * in tools/vet-quotes. Not part of the quoting path.
 *
 *   const w = require("./writer");
 *   const text = w.dxf({ insunits: 4, measurement: 1, entities: [
 *     w.rect(0, 0, 150, 100), w.circle(25, 25, 3.3),
 *   ] });
 */
const g = (code, value) => `${code}\n${value}\n`;
const head = (type, o = {}) => g(0, type) + g(8, o.layer || "0") + (o.linetype ? g(6, o.linetype) : "") + (o.paper ? g(67, 1) : "") + (o.flipZ ? g(210, 0) + g(220, 0) + g(230, -1) : "");

const line = (x1, y1, x2, y2, o) => head("LINE", o) + g(10, x1) + g(20, y1) + g(11, x2) + g(21, y2);
const circle = (cx, cy, r, o) => head("CIRCLE", o) + g(10, cx) + g(20, cy) + g(40, r);
const arc = (cx, cy, r, a0, a1, o) => head("ARC", o) + g(10, cx) + g(20, cy) + g(40, r) + g(50, a0) + g(51, a1);
/** verts: [[x, y, bulge?], …] */
const lwpolyline = (verts, closed = true, o) => head("LWPOLYLINE", o) + g(90, verts.length) + g(70, closed ? 1 : 0) + verts.map((v) => g(10, v[0]) + g(20, v[1]) + (v[2] ? g(42, v[2]) : "")).join("");
const polyline = (verts, closed = true, o) => head("POLYLINE", o) + g(66, 1) + g(70, closed ? 1 : 0)
  + verts.map((v) => g(0, "VERTEX") + g(8, (o && o.layer) || "0") + g(10, v[0]) + g(20, v[1]) + (v[2] ? g(42, v[2]) : "")).join("") + g(0, "SEQEND");
const ellipse = (cx, cy, mx, my, ratio, t0 = 0, t1 = Math.PI * 2, o) => head("ELLIPSE", o) + g(10, cx) + g(20, cy) + g(11, mx) + g(21, my) + g(40, ratio) + g(41, t0) + g(42, t1);
const spline = ({ degree = 3, knots, ctrl, weights, closed = false }, o) => head("SPLINE", o) + g(70, (closed ? 1 : 0) | (weights ? 4 : 0) | 8) + g(71, degree) + g(72, knots.length) + g(73, ctrl.length)
  + knots.map((k) => g(40, k)).join("") + (weights ? weights.map((w) => g(41, w)).join("") : "") + ctrl.map((p) => g(10, p[0]) + g(20, p[1]) + g(30, 0)).join("");
const insert = (name, x, y, { sx = 1, sy = 1, rot = 0, cols, rows, dc, dr, ...o } = {}) => head("INSERT", o) + g(2, name) + g(10, x) + g(20, y) + g(41, sx) + g(42, sy) + g(50, rot)
  + (cols ? g(70, cols) + g(71, rows || 1) + g(44, dc || 0) + g(45, dr || 0) : "");
const text = (x, y, height, value, o) => head("TEXT", o) + g(10, x) + g(20, y) + g(40, height) + g(1, value);
const dimension = (o) => head("DIMENSION", o) + g(10, 0) + g(20, 0) + g(70, 0);

/** Closed rectangle as an LWPOLYLINE. */
const rect = (x, y, w, h, o) => lwpolyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, o);
/** Rectangle with rounded corners (radius r) as a bulged LWPOLYLINE. */
function roundRect(x, y, w, h, r, o) {
  const b = Math.tan(Math.PI / 8);
  return lwpolyline([
    [x + r, y], [x + w - r, y, b], [x + w, y + r], [x + w, y + h - r, b],
    [x + w - r, y + h], [x + r, y + h, b], [x, y + h - r], [x, y + r, b],
  ], true, o);
}
/** Horizontal stadium slot centred on (cx, cy): overall length × width. */
function slot(cx, cy, length, width, o) {
  const r = width / 2, half = length / 2 - r;
  return lwpolyline([[cx - half, cy - r], [cx + half, cy - r, 1], [cx + half, cy + r], [cx - half, cy + r, 1]], true, o);
}
/** Exact circle as a rational quadratic NURBS (9 control points). */
function circleSpline(cx, cy, r, o) {
  const s = Math.SQRT1_2;
  const ctrl = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0]].map(([x, y]) => [cx + r * x, cy + r * y]);
  return spline({ degree: 2, knots: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1], ctrl, weights: [1, s, 1, s, 1, s, 1, s, 1], closed: true }, o);
}

/**
 * Assemble a DXF document.
 * @param {object} d
 * @param {number|null} [d.insunits]     $INSUNITS (omit for a unitless file)
 * @param {number|null} [d.measurement]  $MEASUREMENT
 * @param {Array<{name:string, color?:number, flags?:number, linetype?:string}>} [d.layers]
 * @param {Array<{name:string, base?:[number,number], entities:string[]}>} [d.blocks]
 * @param {string[]} d.entities
 */
function dxf({ insunits = null, measurement = null, layers = [], blocks = [], entities = [] }) {
  let out = "";
  if (insunits != null || measurement != null) {
    out += g(0, "SECTION") + g(2, "HEADER") + g(9, "$ACADVER") + g(1, "AC1015");
    if (insunits != null) out += g(9, "$INSUNITS") + g(70, insunits);
    if (measurement != null) out += g(9, "$MEASUREMENT") + g(70, measurement);
    out += g(0, "ENDSEC");
  }
  if (layers.length) {
    out += g(0, "SECTION") + g(2, "TABLES") + g(0, "TABLE") + g(2, "LAYER") + g(70, layers.length);
    for (const l of layers) out += g(0, "LAYER") + g(2, l.name) + g(70, l.flags || 0) + g(62, l.color == null ? 7 : l.color) + g(6, l.linetype || "CONTINUOUS");
    out += g(0, "ENDTAB") + g(0, "ENDSEC");
  }
  if (blocks.length) {
    out += g(0, "SECTION") + g(2, "BLOCKS");
    for (const b of blocks) out += g(0, "BLOCK") + g(8, "0") + g(2, b.name) + g(70, 0) + g(10, (b.base || [0, 0])[0]) + g(20, (b.base || [0, 0])[1]) + b.entities.join("") + g(0, "ENDBLK");
    out += g(0, "ENDSEC");
  }
  out += g(0, "SECTION") + g(2, "ENTITIES") + entities.join("") + g(0, "ENDSEC") + g(0, "EOF");
  return out;
}

module.exports = { dxf, line, circle, arc, lwpolyline, polyline, ellipse, spline, insert, text, dimension, rect, roundRect, slot, circleSpline };
