#!/usr/bin/env node
/**
 * Small checks of claims in docs/security/hardening-2026-11-11-{server,integration}.md that the
 * other scripts do not already cover.
 *
 *   node tools/security/review-uploads/claims.js
 */
const fs = require("fs");
const net = require("net");
const path = require("path");
const g = require("./gen");
const { startServer, sleep, ls, dirBytes } = require("./lib");

const MB = 1024 * 1024;

(async () => {
  const s = await startServer({ stubs: true, env: { RATE_UPLOAD_PER_15MIN: "100000", RATE_API_PER_15MIN: "100000" } });
  try {
    // 1. An upload that declares more than the route can take is refused before its body is read.
    const raw = await new Promise((resolve) => {
      const sock = net.connect(s.port, "127.0.0.1", () => sock.write(`POST /api/upload HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 198.51.100.90\r\nContent-Type: multipart/form-data; boundary=x\r\nContent-Length: ${900 * MB}\r\n\r\n`));
      let d = "";
      const t0 = Date.now();
      sock.on("data", (c) => { d += c; });
      sock.on("close", () => resolve({ head: d.split("\r\n")[0], ms: Date.now() - t0 }));
      setTimeout(() => sock.destroy(), 5000);
    });
    console.log(`declared 900 MB, no body sent: ${raw.head} in ${raw.ms} ms`);

    // 2. How much does one part add to the database file? (the file is rewritten whole on every write)
    const dbFile = path.join(s.dataDir, "quoting.db");
    const size = () => fs.statSync(dbFile).size;
    const measure = async (label, name, make, n = 100) => {
      const before = size(), filesBefore = ls(s, "part-payloads").length, payloadBefore = dirBytes(s, "part-payloads");
      const t0 = Date.now();
      for (let i = 0; i < n / 10; i++) {
        const r = await s.upload(Array.from({ length: 10 }, (_, k) => ({ name: `${k}-${name}`, data: make() })), { ip: `198.51.100.${91 + (i % 5)}`, timeoutMs: 180000 });
        if (r.status !== 200 || r.body.parts.length !== 10) { console.log(`${label}: upload ${i} → ${r.status} ${JSON.stringify(r.body?.errors?.[0] || r.body).slice(0, 160)}`); break; }
      }
      console.log(`${label}: ${n} parts add ${((size() - before) / 1024).toFixed(0)} kB to the database (${((size() - before) / 1024 / n).toFixed(1)} kB each), ${ls(s, "part-payloads").length - filesBefore} payload files (${((dirBytes(s, "part-payloads") - payloadBefore) / 1024).toFixed(0)} kB), ${Date.now() - t0} ms`);
    };
    await measure("20 mm cube (684 bytes)", "cube.stl", () => g.stlCube());
    const dxf = g.dxfManyHoles(150);
    await measure(`DXF plate with 150 holes (${(dxf.length / 1024).toFixed(1)} kB)`, "plate.dxf", () => dxf);
    await measure("STEP tube (9.6 kB)", "tube.step", () => g.stepFixture("tube.step"), 30);

    // 3. Document (PDF) routes for someone who is not the admin.
    const buyer = await s.register("pdf-buyer@example.test", { ip: "198.51.100.97" });
    const up = await s.upload([{ name: "c.stl", data: g.stlCube() }], { ip: "198.51.100.97" });
    const mat = (await s.get("/api/materials?process=cnc", { ip: "198.51.100.97" })).body[0];
    const q = await s.post("/api/quote", { parts: [{ partId: up.body.parts[0].partId, materialSlug: mat.slug, quantity: 1, process: "cnc", subProcess: "milling" }], leadTimeSlug: "standard" }, { ip: "198.51.100.97" });
    const a = await s.get(`/api/pdf/quote/${q.body.quoteId}`, { ip: "198.51.100.98" });
    const b = await s.get(`/api/pdf/quote/${q.body.quoteId}`, { token: buyer, ip: "198.51.100.97" });
    console.log(`PDF of a quote: anonymous → ${a.status}; signed-in customer → ${b.status} (every /api/pdf route is admin-only)`);
    await sleep(100);
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
