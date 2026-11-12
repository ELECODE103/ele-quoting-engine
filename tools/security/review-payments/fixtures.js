/** Small generated CAD inputs for the proofs of concept (no customer data). */

/** A rectangular plate with four corner holes as an R2000 DXF. units: 1 = inches, 4 = mm, 0 = not stated. */
function dxfPlate(w, h, { insunits = 1, hole = 0.25 } = {}) {
  const L = [];
  const p = (...a) => L.push(...a.map(String));
  p(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1015");
  if (insunits !== null) p(9, "$INSUNITS", 70, insunits);
  p(0, "ENDSEC", 0, "SECTION", 2, "ENTITIES");
  p(0, "LWPOLYLINE", 8, "0", 90, 4, 70, 1, 10, 0, 20, 0, 10, w, 20, 0, 10, w, 20, h, 10, 0, 20, h);
  const m = Math.min(w, h) * 0.1;
  for (const [x, y] of [[m, m], [w - m, m], [m, h - m], [w - m, h - m]]) p(0, "CIRCLE", 8, "0", 10, x, 20, y, 40, hole);
  p(0, "ENDSEC", 0, "EOF");
  return Buffer.from(L.join("\n") + "\n");
}

/** A solid box as a binary STL (millimetres). */
function stlBox(x, y, z) {
  const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.writeUInt32LE(faces.length, 80);
  faces.forEach((f, i) => {
    const o = 84 + i * 50;
    const [a, b, c] = f.map((k) => v[k]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    n.forEach((c2, k) => buf.writeFloatLE(c2 / len, o + k * 4));
    [a, b, c].forEach((pt, j) => pt.forEach((c2, k) => buf.writeFloatLE(c2, o + 12 + j * 12 + k * 4)));
  });
  return buf;
}

module.exports = { dxfPlate, stlBox };
