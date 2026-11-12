/**
 * Test-only ZIP writer. Builds archives byte by byte so a test can declare
 * sizes that are not true (a decompression bomb), repeat an entry name, or
 * pack thousands of entries — things a normal ZIP library refuses to write.
 *
 *   buildZip([{ name, data, method: "deflate"|"store", declaredSize, declaredCompressedSize }], { zip64, zip64Entries })
 */
const zlib = require("zlib");

function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries, opt = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || "");
    const method = e.method === "store" ? 0 : 8;
    const body = e.compressed || (method === 8 ? zlib.deflateRawSync(raw, { level: 9 }) : raw);
    const size = e.declaredSize !== undefined ? e.declaredSize : raw.length;
    const csize = e.declaredCompressedSize !== undefined ? e.declaredCompressedSize : body.length;
    const crc = e.crc !== undefined ? e.crc : crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);        // time
    local.writeUInt16LE(0x21, 12);     // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize >>> 0, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);      // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(csize >>> 0, 20);
    central.writeUInt32LE(size >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);      // extra
    central.writeUInt16LE(0, 32);      // comment
    central.writeUInt16LE(0, 34);      // disk
    central.writeUInt16LE(0, 36);      // internal attrs
    central.writeUInt32LE(0, 38);      // external attrs
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length & 0xffff, 8);
  end.writeUInt16LE(entries.length & 0xffff, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  if (!opt.zip64) return Buffer.concat([...locals, cd, end]);

  // ZIP64 end-of-directory record + locator; the classic end record then holds
  // only "see the ZIP64 record" markers. opt.zip64Entries lets a test lie about the count.
  const count = BigInt(opt.zip64Entries !== undefined ? opt.zip64Entries : entries.length);
  const rec = Buffer.alloc(56);
  rec.writeUInt32LE(0x06064b50, 0);
  rec.writeBigUInt64LE(44n, 4);
  rec.writeUInt16LE(45, 12);
  rec.writeUInt16LE(45, 14);
  rec.writeUInt32LE(0, 16);
  rec.writeUInt32LE(0, 20);
  rec.writeBigUInt64LE(count, 24);
  rec.writeBigUInt64LE(count, 32);
  rec.writeBigUInt64LE(BigInt(cd.length), 40);
  rec.writeBigUInt64LE(BigInt(offset), 48);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeUInt32LE(0, 4);
  loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
  loc.writeUInt32LE(1, 16);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([...locals, cd, rec, loc, end]);
}

/** The model XML of a 3MF holding one axis-aligned box (12 triangles), in millimetres. */
function boxModelXml(w = 20, h = 20, d = 20, { extra = "" } = {}) {
  const v = [[0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0], [0, 0, d], [w, 0, d], [w, h, d], [0, h, d]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>${v.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join("")}</vertices>
    <triangles>${t.map((p) => `<triangle v1="${p[0]}" v2="${p[1]}" v3="${p[2]}"/>`).join("")}</triangles>
   </mesh>
  </object>${extra}
 </resources>
 <build><item objectid="1"/></build>
</model>`;
}

/** A complete, valid 3MF of one box. */
function box3mf(w, h, d, opts) {
  return buildZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>` },
    { name: "3D/3dmodel.model", data: boxModelXml(w, h, d, opts) },
  ]);
}

/** A binary STL of `n` triangles (a strip of small triangles; not a closed solid). */
function binaryStl(n) {
  const buf = Buffer.alloc(84 + n * 50);
  buf.write("test mesh", 0, "ascii");
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12;
    const x = i % 1000, y = Math.floor(i / 1000);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) { buf.writeFloatLE(x + dx, o); buf.writeFloatLE(y + dy, o + 4); buf.writeFloatLE(0, o + 8); o += 12; }
    o += 2;
  }
  return buf;
}

/**
 * A binary STL of a real, closed solid: a w × d × h box whose faces are each a
 * k × k grid (12·k² triangles, outward-facing). Unlike binaryStl() — a flat
 * sheet, which has no volume and is refused as "not a measurable part" — this
 * is a part the instant quote reads and prices. solidStl(32) is about 600 kB.
 */
function solidStl(k = 1, [w, d, h] = [60, 40, 20]) {
  const tris = [];
  // One face: origin o, edge vectors u and v, wound so that u × v points out of the box.
  const face = (o, u, v) => {
    const at = (i, j) => [o[0] + (u[0] * i + v[0] * j) / k, o[1] + (u[1] * i + v[1] * j) / k, o[2] + (u[2] * i + v[2] * j) / k];
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
      tris.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)], [at(i, j), at(i + 1, j + 1), at(i, j + 1)]);
    }
  };
  face([0, 0, 0], [0, d, 0], [w, 0, 0]); // bottom (−z)
  face([0, 0, h], [w, 0, 0], [0, d, 0]); // top (+z)
  face([0, 0, 0], [w, 0, 0], [0, 0, h]); // front (−y)
  face([0, d, 0], [0, 0, h], [w, 0, 0]); // back (+y)
  face([0, 0, 0], [0, 0, h], [0, d, 0]); // left (−x)
  face([w, 0, 0], [0, d, 0], [0, 0, h]); // right (+x)
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write("test solid", 0, "ascii");
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const p of t) { buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8); o += 12; }
    o += 2;
  }
  return buf;
}

module.exports = { buildZip, boxModelXml, box3mf, binaryStl, solidStl, crc32 };
