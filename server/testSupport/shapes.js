/**
 * Tiny CAD files made in memory for the suites: a closed box as a binary STL and a
 * rectangle outline as an ASCII DXF. Sizes are in the file's own units.
 */

/** A closed box as a binary STL (12 triangles), `size` mm on a side unless given as [x, y, z]. */
function boxStl(size = 20) {
  const [X, Y, Z] = Array.isArray(size) ? size : [size, size, size];
  const v = [[0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, Z], [X, 0, Z], [X, Y, Z], [0, Y, Z]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + f.length * 50);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => {
    const o = 84 + i * 50;
    t.forEach((vi, k) => v[vi].forEach((c, a) => buf.writeFloatLE(c, o + 12 + k * 12 + a * 4)));
  });
  return buf;
}

/** A rectangle outline as an ASCII DXF, `w` × `h` drawing units; $INSUNITS 4 = mm, 1 = inches, null = no header (unitless). */
function rectDxf(w, h, insunits = 4) {
  const header = insunits == null ? "" : `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${insunits}\n0\nENDSEC\n`;
  const line = (x1, y1, x2, y2) => `0\nLINE\n8\n0\n10\n${x1}\n20\n${y1}\n11\n${x2}\n21\n${y2}\n`;
  return Buffer.from(`${header}0\nSECTION\n2\nENTITIES\n${line(0, 0, w, 0)}${line(w, 0, w, h)}${line(w, h, 0, h)}${line(0, h, 0, 0)}0\nENDSEC\n0\nEOF\n`);
}

module.exports = { boxStl, rectDxf };
