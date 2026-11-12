/**
 * Hostile-input generators for the upload/parser review. Everything is built in
 * memory at run time; nothing large is committed.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { buildZip, boxModelXml, crc32 } = require("../../../server/testSupport/zip");

const ROOT = path.join(__dirname, "..", "..", "..");
const MB = 1024 * 1024;

// ─── STL ─────────────────────────────────────────────────────────────────────
const CUBE_TRIS = (s) => {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return t.map((f) => f.map((i) => v[i]));
};

/** Binary STL from triangles [[p0,p1,p2], …]; opts.count overrides the header count, opts.header the 80-byte header text. */
function stl(tris, opts = {}) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(opts.header || "review mesh", 0, "latin1");
  buf.writeUInt32LE(opts.count !== undefined ? opts.count >>> 0 : tris.length, 80);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const p of t) { buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8); o += 12; }
    o += 2;
  }
  return buf;
}
const stlCube = (s = 20) => stl(CUBE_TRIS(s));
/** A cube whose every coordinate is multiplied/replaced: e.g. NaN, Infinity, 1e38. */
function stlCubeWith(value, { all = false } = {}) {
  const tris = CUBE_TRIS(20);
  if (all) for (const t of tris) for (const p of t) { p[0] = value; p[1] = value; p[2] = value; }
  else tris[0][0] = [value, value, value];
  return stl(tris);
}
/** A real 200 mm cube plus one stray vertex at NaN: bounding box and volume become NaN (stored as null). */
const stlBigCubeOneNaN = () => { const t = CUBE_TRIS(200); t.push([[NaN, 0, 0], [0, 0, 0], [1, 0, 0]]); return stl(t); };
/** A 200 mm cube and the same cube inside-out: signed volumes cancel to zero. */
function stlCancellingCube(s = 200) {
  const a = CUBE_TRIS(s);
  const b = CUBE_TRIS(s).map((t) => [t[0], t[2], t[1]]);
  return stl([...a, ...b]);
}
/** A cube scaled by `k` (1e-6 → microscopic, 1e30 → astronomically large). */
const stlCubeScaled = (k) => stl(CUBE_TRIS(20).map((t) => t.map((p) => p.map((c) => c * k))));
/** Header says `count`, file holds `actual` triangles. */
const stlLyingCount = (count, actual = 12) => stl(CUBE_TRIS(20).slice(0, actual), { count });
/** Binary STL whose 80-byte header begins "solid" (some exporters do this). */
const stlSolidHeaderBinary = () => stl(CUBE_TRIS(20), { header: "solid binary-with-ascii-looking-header" });
/** n pseudo-random triangles in a 100 mm box (worst case for neighbour finding / ray casts). */
function stlSoup(n, seed = 1) {
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  let x = seed >>> 0;
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return (x / 4294967296) * 100; };
  let o = 84;
  for (let i = 0; i < n; i++) { o += 12; for (let k = 0; k < 9; k++) { buf.writeFloatLE(rnd(), o); o += 4; } o += 2; }
  return buf;
}
/** n triangles of a fine, closed-looking grid slab (many coplanar faces, many holes-like loops). */
function stlGrid(n) {
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  const side = Math.ceil(Math.sqrt(n / 2));
  let o = 84, i = 0;
  for (let y = 0; y < side && i < n; y++) for (let x = 0; x < side && i < n; x++) {
    for (const tri of [[[x, y, 0], [x + 1, y, 0], [x + 1, y + 1, 0]], [[x, y, 0], [x + 1, y + 1, 0], [x, y + 1, 0]]]) {
      if (i >= n) break;
      o += 12; for (const p of tri) { buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8); o += 12; } o += 2; i++;
    }
  }
  return buf;
}
/** n degenerate triangles, all at the origin. */
function stlDegenerate(n) { const b = Buffer.alloc(84 + n * 50); b.writeUInt32LE(n, 80); return b; }

const asciiTri = (t) => `facet normal 0 0 0\nouter loop\n${t.map((p) => `vertex ${p[0]} ${p[1]} ${p[2]}`).join("\n")}\nendloop\nendfacet\n`;
/** ASCII STL of a cube. */
const stlAsciiCube = (s = 20) => Buffer.from(`solid review\n${CUBE_TRIS(s).map(asciiTri).join("")}endsolid review\n`);
/** A valid ASCII cube followed by `bytes` of padding the parser skips: a file of any size that reads in milliseconds. */
function stlAsciiPadded(bytes, s = 20) {
  const head = Buffer.from(`solid review\n${CUBE_TRIS(s).map(asciiTri).join("")}`);
  const tail = Buffer.from("endsolid review\n");
  const pad = Buffer.alloc(Math.max(0, bytes - head.length - tail.length), 0x20);
  for (let i = 4095; i < pad.length; i += 4096) pad[i] = 0x0a;
  return Buffer.concat([head, pad, tail]);
}
/** One facet, then `bytes` of "vertex 0 0 0" lines: millions of vertices for a triangle count of 1. */
function stlAsciiVertexFlood(bytes) {
  const head = `solid review\n${asciiTri(CUBE_TRIS(20)[0])}`;
  const line = "vertex 0 0 0\n";
  return Buffer.concat([Buffer.from(head), Buffer.alloc(bytes - head.length, line)]);
}
/** ASCII STL whose numbers are things the number pattern accepts but are not numbers. */
const stlAsciiWeird = (token) => Buffer.from(`solid review\n${CUBE_TRIS(20).map(asciiTri).join("").replace(/vertex 20 20 20/g, `vertex ${token} ${token} ${token}`)}endsolid review\n`);

// ─── 3MF ─────────────────────────────────────────────────────────────────────
const CT = { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>` };
const threeMf = (xml, extraEntries = [], opt) => buildZip([CT, { name: "3D/3dmodel.model", data: xml }, ...extraEntries], opt);
const modelWrap = (resources, build = `<item objectid="1"/>`) => `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${resources}</resources><build>${build}</build></model>`;

/** The model entry really inflates to `realBytes` of zeros but the directory declares `declared`. */
function threeMfLyingSize(realBytes, declared) {
  // deflate a run of spaces in pieces so the generator itself stays small
  const chunk = Buffer.alloc(8 * MB, 0x20);
  const d = zlib.createDeflateRaw({ level: 9 });
  const out = [];
  d.on("data", (c) => out.push(c));
  return new Promise((resolve) => {
    d.on("end", () => {
      const compressed = Buffer.concat(out);
      resolve(buildZip([CT, { name: "3D/3dmodel.model", data: Buffer.alloc(0), compressed, declaredSize: declared, declaredCompressedSize: compressed.length, crc: 0 }]));
    });
    let left = realBytes;
    const pump = () => { while (left > 0) { const n = Math.min(left, chunk.length); left -= n; if (!d.write(chunk.subarray(0, n))) return d.once("drain", pump); } d.end(); };
    pump();
  });
}
/** Honest high-ratio entry: `bytes` of spaces inside a valid XML comment, declared truthfully. */
function threeMfHonestBomb(bytes) {
  const xml = Buffer.concat([Buffer.from(`<?xml version="1.0"?><model><!--`), Buffer.alloc(bytes, 0x20), Buffer.from(`--></model>`)]);
  return threeMf(xml);
}
/** Many directory entries that all point at the same local data (overlapping entries). */
function threeMfOverlapping(n) {
  const base = threeMf(boxModelXml(20, 20, 20));
  // locate the central directory and duplicate the model's record under new names
  const eocd = base.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cdOffset = base.readUInt32LE(eocd + 16);
  const cdSize = base.readUInt32LE(eocd + 12);
  const cd = base.subarray(cdOffset, cdOffset + cdSize);
  // second record = the model
  const firstLen = 46 + cd.readUInt16LE(28);
  const model = cd.subarray(firstLen);
  const extra = [];
  for (let i = 0; i < n; i++) {
    const name = Buffer.from(`3D/copy${String(i).padStart(6, "0")}.model`);
    const rec = Buffer.from(model.subarray(0, 46));
    rec.writeUInt16LE(name.length, 28);
    extra.push(rec, name);
  }
  const newCd = Buffer.concat([cd, ...extra]);
  const end = Buffer.from(base.subarray(eocd));
  end.writeUInt16LE(Math.min(0xffff, 2 + n), 8);
  end.writeUInt16LE(Math.min(0xffff, 2 + n), 10);
  end.writeUInt32LE(newCd.length, 12);
  return Buffer.concat([base.subarray(0, cdOffset), newCd, end]);
}
/** Local header says "sizes follow in a data descriptor" (flag bit 3, zero sizes); the directory carries the real ones. */
function threeMfDataDescriptor() {
  const z = Buffer.from(threeMf(boxModelXml(20, 20, 20)));
  let at = z.indexOf(Buffer.from("3D/3dmodel.model")) - 30;
  z.writeUInt16LE(z.readUInt16LE(at + 6) | 0x08, at + 6);
  z.writeUInt32LE(0, at + 14); z.writeUInt32LE(0, at + 18); z.writeUInt32LE(0, at + 22);
  return z;
}
/** XML: nesting `depth` levels deep. */
const threeMfDeep = (depth) => threeMf(`<?xml version="1.0"?><model>${"<a>".repeat(depth)}${"</a>".repeat(depth)}</model>`);
/** XML: entity expansion ("billion laughs"). */
const threeMfLaughs = () => threeMf(`<?xml version="1.0"?><!DOCTYPE m [<!ENTITY a "aaaaaaaaaa">${[..."bcdefghij"].map((c, i) => `<!ENTITY ${c} "${`&${"abcdefghi"[i]};`.repeat(10)}">`).join("")}]><model unit="&j;"><resources><object id="1"><mesh><vertices><vertex x="&j;" y="0" z="0"/></vertices></mesh></object></resources></model>`);
/** XML: one element with `n` attributes. */
const threeMfAttrs = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(`a${i}="1"`); return threeMf(modelWrap(`<object id="1" ${a.join(" ")}><mesh><vertices><vertex x="0" y="0" z="0"/></vertices><triangles><triangle v1="0" v2="0" v3="0"/></triangles></mesh></object>`)); };
/** XML: `bytes` of <vertex/> elements and one triangle (the triangle ceiling never trips). */
function threeMfVertexFlood(bytes) {
  const v = `<vertex x="0" y="0" z="0"/>`;
  const body = Buffer.alloc(bytes, v);
  const cut = bytes - (bytes % v.length);
  const xml = Buffer.concat([Buffer.from(`<?xml version="1.0"?><model unit="millimeter"><resources><object id="1"><mesh><vertices>`), body.subarray(0, cut), Buffer.from(`</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`)]);
  return threeMf(xml);
}
/** `bytes` of <vertex/> with pseudo-random coordinates: real-looking mesh XML that compresses about 3:1, so no ratio guard trips. */
function threeMfRandomVertices(bytes) {
  let x = 12345;
  const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return (x / 4294967.296).toFixed(3); };
  const parts = [];
  let n = 0;
  while (n < bytes) { const row = []; for (let i = 0; i < 2000; i++) row.push(`<vertex x="${rnd()}" y="${rnd()}" z="${rnd()}"/>`); const s = row.join(""); parts.push(s); n += s.length; }
  return threeMf(`<?xml version="1.0"?><model unit="millimeter"><resources><object id="1"><mesh><vertices>${parts.join("")}</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`);
}
/** Components fan out `fan` ways per level for `levels` levels onto a mesh of `verts` vertices and no usable triangles: work with no output. */
function threeMfComponentFan(levels, fan, verts) {
  let res = `<object id="1"><mesh><vertices>${`<vertex x="1" y="2" z="3"/>`.repeat(verts)}</vertices><triangles><triangle v1="0" v2="1" v3="${verts + 5}"/></triangles></mesh></object>`;
  for (let l = 2; l <= levels + 1; l++) res += `<object id="${l}"><components>${`<component objectid="${l - 1}"/>`.repeat(fan)}</components></object>`;
  return threeMf(modelWrap(res, `<item objectid="${levels + 1}"/>`));
}
/** A self-referencing component. */
const threeMfSelfRef = () => threeMf(modelWrap(`<object id="1"><components><component objectid="1"/></components></object>`));
/** ZIP64 end record that claims 2^40 entries. */
const threeMfZip64Lie = () => buildZip([CT, { name: "3D/3dmodel.model", data: boxModelXml(20, 20, 20) }], { zip64: true, zip64Entries: 2 ** 40 });

// ─── DXF ─────────────────────────────────────────────────────────────────────
const dxfDoc = ({ header = "", blocks = "", entities = "" }) => `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n${header}0\nENDSEC\n${blocks ? `0\nSECTION\n2\nBLOCKS\n${blocks}0\nENDSEC\n` : ""}0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
const dxfRect = (x, y, w, h) => `0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n${x}\n20\n${y}\n10\n${x + w}\n20\n${y}\n10\n${x + w}\n20\n${y + h}\n10\n${x}\n20\n${y + h}\n`;
const dxfCircle = (x, y, r) => `0\nCIRCLE\n8\n0\n10\n${x}\n20\n${y}\n40\n${r}\n`;
const dxfInsert = (name, extra = "") => `0\nINSERT\n8\n0\n2\n${name}\n10\n0\n20\n0\n${extra}`;
const dxfBlock = (name, body) => `0\nBLOCK\n8\n0\n2\n${name}\n70\n0\n10\n0\n20\n0\n${body}0\nENDBLK\n`;
const buf = (s) => Buffer.from(s);

/** Plain plate with holes (a sane control). */
const dxfPlate = (holes = 4) => { let e = dxfRect(0, 0, 200, 100); for (let i = 0; i < holes; i++) e += dxfCircle(10 + (i % 18) * 10, 10 + Math.floor(i / 18) * 10, 2); return buf(dxfDoc({ entities: e })); };
/** A block that inserts itself. */
const dxfSelfInsert = () => buf(dxfDoc({ blocks: dxfBlock("A", dxfInsert("A") + dxfRect(0, 0, 10, 10)), entities: dxfInsert("A") }));
/** `levels` blocks, each inserting the next `fan` times as a rows×cols array; the innermost holds nothing that is cut. */
function dxfInsertBomb(levels = 8, fan = 1, rows = 100, cols = 100, leaf = "0\nPOINT\n8\n0\n10\n0\n20\n0\n") {
  let blocks = dxfBlock("B0", leaf);
  for (let l = 1; l < levels; l++) blocks += dxfBlock(`B${l}`, dxfInsert(`B${l - 1}`, `70\n${cols}\n71\n${rows}\n44\n1\n45\n1\n`).repeat(fan));
  return buf(dxfDoc({ blocks, entities: dxfRect(0, 0, 100, 100) + dxfInsert(`B${levels - 1}`, `70\n${cols}\n71\n${rows}\n44\n1\n45\n1\n`) }));
}
/** An ELLIPSE whose parameter range is astronomically negative. */
const dxfEllipseSpin = () => buf(dxfDoc({ entities: dxfRect(0, 0, 100, 100) + `0\nELLIPSE\n8\n0\n10\n50\n20\n50\n11\n10\n21\n0\n40\n0.5\n41\n1e308\n42\n0\n` }));
/** n entities (LINEs forming nothing). */
function dxfManyEntities(n) { const parts = [dxfRect(0, 0, 1000, 1000)]; for (let i = 0; i < n; i++) parts.push(`0\nLINE\n8\n0\n10\n${i % 997}\n20\n${i % 991}\n11\n${(i * 7) % 997}\n21\n${(i * 13) % 991}\n`); return buf(dxfDoc({ entities: parts.join("") })); }
/** One closed outline with n small circles in a grid (each a hole): the largest honest profile. */
function dxfManyHoles(n, pitch = 3) { const side = Math.ceil(Math.sqrt(n)); const parts = [dxfRect(-5, -5, side * pitch + 10, side * pitch + 10)]; for (let i = 0; i < n; i++) parts.push(dxfCircle((i % side) * pitch, Math.floor(i / side) * pitch, 1)); return buf(dxfDoc({ entities: parts.join("") })); }
/** One LWPOLYLINE with n vertices on a circle (a legitimate outline, but enormous). */
function dxfHugePolyline(n, r = 500) { const p = [`0\nLWPOLYLINE\n8\n0\n90\n${n}\n70\n1\n`]; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; p.push(`10\n${(r * Math.cos(a)).toFixed(4)}\n20\n${(r * Math.sin(a)).toFixed(4)}\n`); } return buf(dxfDoc({ entities: p.join("") })); }
/** A zig-zag polyline that crosses itself ~n²/4 times. */
function dxfSelfCrossing(n) { const p = [`0\nLWPOLYLINE\n8\n0\n90\n${n}\n70\n1\n`]; for (let i = 0; i < n; i++) p.push(i % 2 ? `10\n${i}\n20\n${1000}\n` : `10\n${n - i}\n20\n0\n`); return buf(dxfDoc({ entities: p.join("") })); }
/** A SPLINE with n control points and degree d. */
function dxfSpline(n, degree = 3) { const p = [`0\nSPLINE\n8\n0\n70\n8\n71\n${degree}\n72\n${n + degree + 1}\n73\n${n}\n`]; for (let i = 0; i < n + degree + 1; i++) p.push(`40\n${Math.max(0, Math.min(i - degree, n - degree))}\n`); for (let i = 0; i < n; i++) p.push(`10\n${i}\n20\n${(i % 2) * 1000}\n30\n0\n`); return buf(dxfDoc({ entities: dxfRect(-10, -10, n + 20, 1020) + p.join("") })); }
/** `bytes` of nothing but group-code pairs ("0\n\n"): the tokeniser's worst case. */
function dxfTokenFlood(bytes) { const head = "0\nSECTION\n2\nENTITIES\n"; return Buffer.concat([buf(head), Buffer.alloc(bytes - head.length, "0\nX\n")]); }
/** Coordinates at the edge of what a double holds. */
const dxfExtremeCoords = (v) => buf(dxfDoc({ entities: dxfRect(0, 0, v, v) + dxfCircle(v / 2, v / 2, v / 10) }));
/** Polyline with NaN/Infinity-looking coordinates and bulges. */
const dxfBadNumbers = () => buf(dxfDoc({ entities: `0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\nNaN\n20\nInfinity\n42\n1e308\n10\n100\n20\n0\n42\n-1e308\n10\n100\n20\n100\n10\n0\n20\n100\n` + dxfCircle(50, 50, -5) + dxfCircle(20, 20, 0) }));

// ─── STEP / IGES ─────────────────────────────────────────────────────────────
/** The repository's 2 MB "plate with 400 holes" STEP (gunzipped). */
const stepPlate400 = () => zlib.gunzipSync(fs.readFileSync(path.join(ROOT, "server", "security", "fixtures", "plate_400_holes.step.gz")));
/** The DATA section of a STEP repeated k times with renumbered ids: k bodies in one file. */
function stepRepeat(step, k) {
  const text = step.toString("latin1");
  const a = text.indexOf("DATA;") + 5;
  const b = text.lastIndexOf("ENDSEC;");
  const data = text.slice(a, b);
  let maxId = 0;
  data.replace(/#(\d+)/g, (_, d) => { if (+d > maxId) maxId = +d; return ""; });
  const parts = [text.slice(0, a)];
  for (let i = 0; i < k; i++) parts.push(i === 0 ? data : data.replace(/#(\d+)/g, (_, d) => `#${+d + i * (maxId + 1)}`));
  parts.push(text.slice(b));
  return Buffer.from(parts.join(""), "latin1");
}
const stepFixture = (name) => fs.readFileSync(path.join(ROOT, "server", "geometry", "fixtures", name));
/** A STEP whose entities refer to themselves / each other in a loop. */
const stepCyclic = () => Buffer.from(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=SHAPE_DEFINITION_REPRESENTATION(#2,#5);\n#2=PRODUCT_DEFINITION_SHAPE('','',#3);\n#3=PRODUCT_DEFINITION('','',#4,#9);\n#4=PRODUCT_DEFINITION_FORMATION('','',#6);\n#6=PRODUCT('','','',(#7));\n#7=PRODUCT_CONTEXT('',#8,'');\n#8=APPLICATION_CONTEXT('');\n#9=PRODUCT_DEFINITION_CONTEXT('',#8,'');\n#5=SHAPE_REPRESENTATION('',(#10,#11),#12);\n#10=AXIS2_PLACEMENT_3D('',#10,#10,#10);\n#11=MAPPED_ITEM('',#13,#10);\n#13=REPRESENTATION_MAP(#10,#5);\n#12=GEOMETRIC_REPRESENTATION_CONTEXT(3);\nENDSEC;\nEND-ISO-10303-21;\n`);
/** MAPPED_ITEM tree: each level maps the level below `fan` times (fan^levels instances of one solid). */
function stepInstanceBomb(levels = 12, fan = 4) {
  const base = stepFixture("tube.step").toString("latin1");
  const a = base.indexOf("DATA;") + 5;
  const b = base.lastIndexOf("ENDSEC;");
  let id = 100000;
  const lines = [];
  // #10 is the tube's ADVANCED_BREP_SHAPE_REPRESENTATION, #11 its AXIS2_PLACEMENT_3D, #197 its context (see the fixture)
  let prevRep = 10;
  for (let l = 0; l < levels; l++) {
    const map = id++;
    lines.push(`#${map}=REPRESENTATION_MAP(#11,#${prevRep});`);
    const items = [];
    for (let f = 0; f < fan; f++) { const mi = id++; lines.push(`#${mi}=MAPPED_ITEM('',#${map},#11);`); items.push(`#${mi}`); }
    const rep = id++;
    lines.push(`#${rep}=SHAPE_REPRESENTATION('',(#11,${items.join(",")}),#197);`);
    prevRep = rep;
  }
  // point the product's shape at the top of the tree
  const data = base.slice(a, b).replace(/#3 = SHAPE_DEFINITION_REPRESENTATION\(#4,#10\);/, `#3 = SHAPE_DEFINITION_REPRESENTATION(#4,#${prevRep});`);
  return Buffer.from(base.slice(0, a) + data + lines.join("\n") + "\n" + base.slice(b), "latin1");
}
/** A STEP header followed by `bytes` of one unterminated entity. */
const stepUnterminated = (bytes) => Buffer.concat([Buffer.from("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',("), Buffer.alloc(bytes, "1.,")]);
/** A STEP with n nested parentheses. */
const stepDeepParens = (n) => Buffer.from(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',${"(".repeat(n)}1.${")".repeat(n)});\nENDSEC;\nEND-ISO-10303-21;\n`);

const igesFixture = () => fs.readFileSync(path.join(ROOT, "server", "security", "fixtures", "box_hole.igs"));
/** The fixture's first record, then `bytes` of well-formed but meaningless records. */
function igesFlood(bytes) {
  const first = igesFixture().toString("latin1").split(/\r?\n/)[0];
  const rows = [first];
  let n = 1;
  const row = (s, letter) => `${s.padEnd(72).slice(0, 72)}${letter}${String(n++).padStart(7)}`;
  rows.push(row(",,4Hbomb,4Hbomb,4Hbomb,4Hbomb,32,308,15,308,15,,1.,2,2HMM,1,0.01,13H000000.000000,1E-07,20.,,,11,0,;", "G"));
  n = 1;
  const count = Math.floor(bytes / 81 / 3);
  for (let i = 0; i < count; i++) { rows.push(row(`     144${String(i + 1).padStart(8)}       0       0       0       0       0       000000000`, "D")); rows.push(row(`     144       0       0       1       0`, "D")); }
  n = 1;
  for (let i = 0; i < count; i++) rows.push(`${`144,${i * 2 + 1},1,0,${i * 2 + 1};`.padEnd(64)}${String(i * 2 + 1).padStart(8)}P${String(n++).padStart(7)}`);
  rows.push(`S      1G      1D${String(count * 2).padStart(7)}P${String(count).padStart(7)}`.padEnd(72) + "T      1");
  return Buffer.from(rows.join("\n") + "\n", "latin1");
}
/** The real fixture with every directory pointer rewritten to point at entity 1 (reference loops). */
const igesLoops = () => Buffer.from(igesFixture().toString("latin1").replace(/^(.{64})(.{8})P/gm, (m, a, b) => `${a.replace(/\d+(?=[,;])/g, "1").padEnd(64).slice(0, 64)}${b}P`), "latin1");

module.exports = {
  MB, crc32,
  stl, stlCube, stlCubeWith, stlBigCubeOneNaN, stlCancellingCube, stlCubeScaled, stlLyingCount, stlSolidHeaderBinary, stlSoup, stlGrid, stlDegenerate,
  stlAsciiCube, stlAsciiPadded, stlAsciiVertexFlood, stlAsciiWeird,
  threeMf, modelWrap, boxModelXml, threeMfLyingSize, threeMfHonestBomb, threeMfOverlapping, threeMfDataDescriptor, threeMfDeep, threeMfLaughs, threeMfAttrs, threeMfVertexFlood, threeMfRandomVertices, threeMfComponentFan, threeMfSelfRef, threeMfZip64Lie,
  dxfDoc, dxfRect, dxfCircle, dxfPlate, dxfSelfInsert, dxfInsertBomb, dxfEllipseSpin, dxfManyEntities, dxfManyHoles, dxfHugePolyline, dxfSelfCrossing, dxfSpline, dxfTokenFlood, dxfExtremeCoords, dxfBadNumbers,
  stepPlate400, stepRepeat, stepFixture, stepCyclic, stepInstanceBomb, stepUnterminated, stepDeepParens, igesFixture, igesFlood, igesLoops,
};
