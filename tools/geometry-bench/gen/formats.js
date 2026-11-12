/**
 * File writers for the benchmark corpus: binary STL, ASCII STL, 3MF.
 * Input is a flat array of numbers, 9 per triangle (see ./mesh.js Soup).
 */
const path = require("path");
const { buildZip } = require(path.join(__dirname, "..", "..", "..", "server", "testSupport", "zip"));

function binaryStl(a) {
  const n = a.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write("geometry-bench", 0, "ascii");
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2];
    const vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    buf.writeFloatLE(nx / l, o); buf.writeFloatLE(ny / l, o + 4); buf.writeFloatLE(nz / l, o + 8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(a[i + k], o + 12 + k * 4);
    o += 50;
  }
  return buf;
}

/** ASCII STL with full double precision (shortest round-trip), so the values differ from the float32 binary. */
function asciiStl(a) {
  const n = a.length / 9;
  const parts = ["solid bench\n"];
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2];
    const vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    parts.push(`facet normal ${nx / l} ${ny / l} ${nz / l}\nouter loop\nvertex ${a[i]} ${a[i + 1]} ${a[i + 2]}\nvertex ${a[i + 3]} ${a[i + 4]} ${a[i + 5]}\nvertex ${a[i + 6]} ${a[i + 7]} ${a[i + 8]}\nendloop\nendfacet\n`);
  }
  parts.push("endsolid bench\n");
  return Buffer.from(parts.join(""), "ascii");
}

/** 3MF with one indexed mesh object (vertices shared exactly), optional unit and item transform. */
function threeMf(a, { unit = "millimeter", transform = null } = {}) {
  const n = a.length / 9;
  const index = new Map(), verts = [], tris = [];
  for (let c = 0; c < n * 3; c++) {
    const key = `${a[c * 3]} ${a[c * 3 + 1]} ${a[c * 3 + 2]}`;
    let id = index.get(key);
    if (id === undefined) { id = verts.length; index.set(key, id); verts.push(`<vertex x="${a[c * 3]}" y="${a[c * 3 + 1]}" z="${a[c * 3 + 2]}"/>`); }
    tris.push(id);
  }
  const t = [];
  for (let i = 0; i < n; i++) t.push(`<triangle v1="${tris[i * 3]}" v2="${tris[i * 3 + 1]}" v3="${tris[i * 3 + 2]}"/>`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources><object id="1" type="model"><mesh><vertices>${verts.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object></resources>\n<build><item objectid="1"${transform ? ` transform="${transform}"` : ""}/></build>\n</model>\n`;
  return buildZip([
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: "3D/3dmodel.model", data: xml },
  ]);
}

module.exports = { binaryStl, asciiStl, threeMf };
