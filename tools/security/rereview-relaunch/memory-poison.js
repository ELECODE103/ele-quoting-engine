#!/usr/bin/env node
/**
 * At the 1 GB default: can ONE upload leave the site refusing other people's files? (area 5; author's open item 3)
 *
 *   node tools/security/rereview-relaunch/memory-poison.js
 *
 * The author found that after one large model the heaviest meshes are told "busy" on every try until a
 * restart. This asks the question from the other side: after an attacker has sent ONE such file (and then
 * one more), what happens to ordinary customers' files, each from its own address: a cube, a finely
 * meshed block (3.8 MB), a 100,000-triangle block (5 MB), a 250,000-triangle block (12.4 MB)?
 * MEMORY_BUDGET_MB is left unset (1024). The machine itself has more memory than that; the budget is the
 * server's own bookkeeping, which is what refuses.
 */
const c = require("../rereview-availability/common");
const { solidStl } = require("../../../server/testSupport/zip");

(async () => {
  const s = await c.startServer({ stubs: true });
  try {
    const files = [["cube (12 triangles)", c.g.stlCube(25)], ["block, 76,800 triangles, 3.8 MB", solidStl(80)], ["block, 101,568 triangles, 5 MB", solidStl(92)], ["block, 248,832 triangles, 12.4 MB", solidStl(144)]];
    let n = 0;
    const customers = async (label) => {
      const out = [];
      for (const [name, data] of files) {
        const ip = `203.0.113.${++n}`;
        const t0 = Date.now();
        const r = await s.upload([{ name: "part.stl", data }], { ip, timeoutMs: 240000 });
        const ok = r.body && r.body.parts && r.body.parts.length;
        const code = ok ? "read" : (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && (r.body.errors[0].code || r.body.errors[0].error)))) || String(r.status);
        out.push({ file: name, result: code, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) });
      }
      const row = { when: label, serverRssMb: c.rssMb(s.child.pid), customers: out };
      c.log(JSON.stringify(row));
      return row;
    };
    const rows = [];
    rows.push(await customers("before anything large"));
    const attack = async (label, data) => {
      const t0 = Date.now();
      const r = await s.upload([{ name: "big.stl", data }], { ip: "192.0.2.66", timeoutMs: 300000 });
      const ok = r.body && r.body.parts && r.body.parts.length;
      const row = { attackerSent: label, result: ok ? "read" : (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && (r.body.errors[0].code || String(r.body.errors[0].error).slice(0, 60))))) || String(r.status), seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), serverRssMbAfter: c.rssMb(s.child.pid) };
      c.log(JSON.stringify(row));
      return row;
    };
    rows.push(await attack("500,000 random triangles (25 MB)", c.g.stlSoup(500000)));
    rows.push(await customers("right after one large file"));
    rows.push(await attack("500,000-triangle grid (25 MB)", c.g.stlGrid(500000)));
    rows.push(await attack("500,000 random triangles again", c.g.stlSoup(500000, 2)));
    rows.push(await customers("after three large files from one address"));
    await c.sleep(30000);
    rows.push(await customers("30 seconds later"));
    const refused = rows.filter((r) => r.customers).slice(1).flatMap((r) => r.customers).filter((x) => x.result !== "read");
    c.result({ test: "memory-poison", memoryBudgetMb: "default (1024)", rows, customersRefusedAfterTheAttack: refused.length, log: (s.log().match(/SHORT OF MEMORY[^\n]*/g) || []).slice(0, 3) });
    process.exitCode = refused.length ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
