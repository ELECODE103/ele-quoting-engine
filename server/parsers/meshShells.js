/**
 * The closed shells of a triangle mesh, and whether one sits inside another.
 *
 * Why (independent re-review 2026-11-12, RR-09): a mesh file is a list of triangles, and the
 * measurements pricing uses are sums over them. Shells hidden inside the visible part change those
 * sums without changing what the part looks like: sixty small closed boxes inside one bar of a
 * frame raised its counted volume twenty-fold and moved it from "a person looks at this" to open
 * checkout; an inside-out copy a micrometre smaller cancelled a solid cube down to a skin priced
 * as if it could be printed. One solid inside another is also something the instant quote has no
 * honest price for when it is real (a sealed hollow, a part packed inside a part), so either way
 * it goes to a person.
 *
 * How: vertices that coincide are welded (an exact match: exporters write a shared corner with the
 * same digits every time), triangles that share a vertex are one shell, and a shell is "inside"
 * another when its bounding box is inside the other's AND one of its corners is inside the other
 * shell's surface (a ray from that corner crosses the surface an odd number of times). Two parts
 * side by side in one file are not flagged; nor is a small part sitting in the open hollow of an
 * L-shaped one.
 */

/**
 * @param {Float32Array|Float64Array|number[]} xyz  9 numbers per triangle (three corners)
 * @param {number} triangles
 * @returns {{ shells: number, nested: boolean }}
 */
function findNestedShells(xyz, triangles) {
  const n = Math.floor(triangles);
  if (!(n >= 8)) return { shells: n > 0 ? 1 : 0, nested: false }; // two closed shells need at least 4 triangles each
  const V = n * 3;
  // ── Weld coincident vertices (open addressing; the table holds the index of each distinct corner).
  let size = 1;
  while (size < V * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const id = new Int32Array(V);
  const mask = size - 1;
  for (let v = 0; v < V; v++) {
    const x = xyz[v * 3], y = xyz[v * 3 + 1], z = xyz[v * 3 + 2];
    let h = (Math.imul((x * 1024) | 0, 73856093) ^ Math.imul((y * 1024) | 0, 19349663) ^ Math.imul((z * 1024) | 0, 83492791)) & mask;
    for (;;) {
      const at = table[h];
      if (at === -1) { table[h] = v; id[v] = v; break; }
      if (xyz[at * 3] === x && xyz[at * 3 + 1] === y && xyz[at * 3 + 2] === z) { id[v] = at; break; }
      h = (h + 1) & mask;
    }
  }
  // ── Triangles that share a corner are one shell.
  const parent = new Int32Array(V);
  for (let v = 0; v < V; v++) parent[v] = v;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let t = 0; t < n; t++) { union(id[t * 3], id[t * 3 + 1]); union(id[t * 3], id[t * 3 + 2]); }
  // ── Each shell: its triangles, its box.
  const byRoot = new Map();
  for (let t = 0; t < n; t++) {
    const root = find(id[t * 3]);
    let s = byRoot.get(root);
    if (!s) { s = { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; byRoot.set(root, s); }
    s.tris.push(t);
    for (let k = 0; k < 9; k++) { const c = xyz[t * 9 + k]; const a = k % 3; if (c < s.min[a]) s.min[a] = c; if (c > s.max[a]) s.max[a] = c; }
  }
  const shells = [...byRoot.values()].filter((s) => s.tris.length >= 4);
  if (shells.length < 2) return { shells: shells.length, nested: false };
  const boxVolume = (s) => (s.max[0] - s.min[0]) * (s.max[1] - s.min[1]) * (s.max[2] - s.min[2]);
  shells.sort((a, b) => boxVolume(b) - boxVolume(a));
  const boxInside = (inner, outer) => [0, 1, 2].every((a) => inner.min[a] >= outer.min[a] && inner.max[a] <= outer.max[a]);
  // A ray from p in a direction no model edge is aligned with: how many of the shell's triangles does it cross?
  const D = [0.8017837257372732, 0.5345224838248488, 0.2672612419124244];
  const crossings = (p, shell) => {
    let count = 0;
    for (const t of shell.tris) {
      const o = t * 9;
      const ax = xyz[o], ay = xyz[o + 1], az = xyz[o + 2];
      const e1x = xyz[o + 3] - ax, e1y = xyz[o + 4] - ay, e1z = xyz[o + 5] - az;
      const e2x = xyz[o + 6] - ax, e2y = xyz[o + 7] - ay, e2z = xyz[o + 8] - az;
      const px = D[1] * e2z - D[2] * e2y, py = D[2] * e2x - D[0] * e2z, pz = D[0] * e2y - D[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const tx = p[0] - ax, ty = p[1] - ay, tz = p[2] - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const w = (D[0] * qx + D[1] * qy + D[2] * qz) * inv;
      if (w < 0 || u + w > 1) continue;
      if ((e2x * qx + e2y * qy + e2z * qz) * inv > 1e-9) count++;
    }
    return count;
  };
  // Each shell against the largest ones that could hold it. The work is bounded: past a budget of
  // triangle tests the file is one we cannot vouch for, and it is treated as nested (to a person).
  let budget = 40 * 1000 * 1000;
  for (let j = 1; j < shells.length; j++) {
    const inner = shells[j];
    const corner = [xyz[inner.tris[0] * 9], xyz[inner.tris[0] * 9 + 1], xyz[inner.tris[0] * 9 + 2]];
    for (let i = 0; i < j && i < 64; i++) {
      const outer = shells[i];
      if (!boxInside(inner, outer)) continue;
      budget -= outer.tris.length;
      if (budget < 0) return { shells: shells.length, nested: true };
      if (crossings(corner, outer) % 2 === 1) return { shells: shells.length, nested: true };
    }
  }
  return { shells: shells.length, nested: false };
}

module.exports = { findNestedShells };
