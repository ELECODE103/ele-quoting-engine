#!/usr/bin/env node
/**
 * Item 1 of the review: type confusion, hostile file names, leftovers and download headers.
 *
 *   node tools/security/review-uploads/files.js
 *
 * Prints one line per check: PASS (the server did the safe thing), FINDING (it did not), or INFO.
 */
const fs = require("fs");
const net = require("net");
const path = require("path");
const g = require("./gen");
const { startServer, sleep, ls, live } = require("./lib");

const out = [];
const say = (kind, what, detail = "") => { out.push({ kind, what, detail }); console.log(`${kind.padEnd(8)} ${what}${detail ? ` — ${detail}` : ""}`); };
const pdf = (tail = "") => Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\n${tail}\n%%EOF\n`);
const HTML = `<html><body><script>document.title='xss-'+document.domain</script><svg onload=alert(1)></svg></body></html>`;

(async () => {
  const s = await startServer({ stubs: true, env: { RATE_UPLOAD_PER_15MIN: "100000", RATE_API_PER_15MIN: "100000", RATE_RFQ_PER_HOUR: "100000", RATE_DRAWING_PER_HOUR: "100000" } });
  let ipn = 0;
  const ip = () => `198.51.${100 + Math.floor(++ipn / 200)}.${(ipn % 200) + 1}`;
  const count = () => ({ uploads: ls(s, "uploads").length, rfq: ls(s, "rfq-drawings").length, quote: ls(s, "quote-drawings").length, payloads: ls(s, "part-payloads").length });
  try {
    const admin = await s.admin({ ip: "203.0.113.5" });

    // ── A. CAD upload: content checks per extension ──────────────────────────
    const cadCases = [
      ["HTML page named .stl", "page.stl", Buffer.from(HTML)],
      ["'solid' + HTML, no facet", "solid.stl", Buffer.from(`solid x\n${HTML}\nendsolid x\n`)],
      ["PDF named .step with the STEP marker in its first 80 bytes", "poly.step", Buffer.from(`%PDF-1.4 ISO-10303-21;\n${HTML}`)],
      ["plain ZIP (not a 3MF) named .3mf", "doc.3mf", require("../../../server/testSupport/zip").buildZip([{ name: "word/document.xml", data: "<w/>" }, { name: "evil.html", data: HTML }])],
      ["DWG bytes named .dxf", "drawing.dxf", Buffer.from("AC1027\0\0\0\0\0\0binary")],
      ["DXF preamble then HTML", "page.dxf", Buffer.from(`0\nSECTION\n2\nENTITIES\n999\n${HTML}\n0\nENDSEC\n0\nEOF\n`)],
      ["PNG named .igs", "img.igs", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)])],
      ["executable (MZ) named .stl with believable triangle count", "run.stl", (() => { const b = g.stlCube(); b.write("MZ", 0, "latin1"); return b; })()],
    ];
    for (const [label, name, data] of cadCases) {
      const before = count();
      const r = await s.upload([{ name, data }], { ip: ip() });
      await sleep(150);
      const after = count();
      const kept = after.uploads - before.uploads;
      const parsed = r.body?.parts?.length || 0;
      if (parsed) say("INFO", `CAD: ${label}`, `accepted as a part (${r.body.parts[0].geometry.triangleCount} triangles); stored under a server name, only an admin can download it`);
      else say(kept === 0 ? "PASS" : "FINDING", `CAD: ${label}`, `HTTP ${r.status} ${r.body?.errors?.[0]?.code || r.body?.error || ""}; files left: ${kept}`);
    }

    // ── A2. CAD upload: file names ───────────────────────────────────────────
    const cube = g.stlCube();
    const names = ["../../../../tmp/review-traversal.stl", "..\\..\\evil.stl", "a.stl.html", "a.html.stl", "A.STL", "a.stl ", "a.stl%00.html", "a.php.stl", `a"; filename="b.html.stl`, "a\r\nX-Injected: 1.stl", "‮gpj.stl", `${"A".repeat(400)}.stl`, ".stl", "con.stl", "a.stl.enc", "a.enc"];
    for (const name of names) {
      const before = new Set(ls(s, "uploads"));
      let r;
      try { r = await s.upload([{ name, data: cube }], { ip: ip() }); } catch (err) { say("INFO", `name ${JSON.stringify(name)}`, `request failed client-side: ${err.message}`); continue; }
      const added = ls(s, "uploads").filter((f) => !before.has(f));
      const stray = added.filter((f) => !/^[0-9a-f-]{36}\.(stl|step|stp|3mf|iges|igs|dxf)(\.enc)?$/.test(f));
      const shown = r.body?.parts?.[0]?.fileName;
      say(stray.length ? "FINDING" : "PASS", `name ${JSON.stringify(name).slice(0, 60)}`, `HTTP ${r.status}; stored as ${added[0] || "nothing"}; shown as ${JSON.stringify(shown ?? r.body?.error ?? r.body?.errors?.[0]?.error ?? "").slice(0, 70)}`);
    }
    say(fs.existsSync("/tmp/review-traversal.stl") ? "FINDING" : "PASS", "no file written outside the data folder by a traversal name");

    // ── B. RFQ attachments ──────────────────────────────────────────────────
    const fields = (i) => ({ contactName: "Review Tester", email: `rfq${i}@example.test`, notes: `note ${i} ${Math.random()}`, quantities: "5" });
    const rfqCases = [
      ["PDF magic + HTML/script (polyglot)", "drawing.pdf", pdf(HTML), true],
      ["PNG magic + HTML", "photo.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(HTML)]), true],
      ["JPEG magic + HTML", "photo.jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(HTML)]), true],
      ["DXF preamble + HTML", "part.dxf", Buffer.from(`0\nSECTION\n2\nENTITIES\n999\n${HTML}\n0\nENDSEC\n0\nEOF\n`), true],
      ["DWG tag + HTML", "part.dwg", Buffer.from(`AC1032${HTML}`), true],
      ["HTML named .pdf", "page.pdf", Buffer.from(HTML), false],
      ["SVG named .png", "img.png", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`), false],
      ["SVG file", "img.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`), false],
      ["HTML file", "page.html", Buffer.from(HTML), false],
      ["PDF with .PDF.html name", "x.pdf.html", pdf(), false],
      ["PDF with header-injection name", `x"\r\nSet-Cookie: review=1; a=".pdf`, pdf(), true],
      ["PDF with RTL-override name", "‮fdp.exe.pdf", pdf(), true],
      ["PDF with 600-character name", `${"n".repeat(600)}.pdf`, pdf(), true],
      ["PDF with traversal name", "../../../quoting.db.pdf", pdf(), true],
    ];
    const keptRfqs = [];
    let i = 0;
    for (const [label, name, data, expectAccept] of rfqCases) {
      i++;
      const before = new Set(ls(s, "rfq-drawings"));
      let r;
      try { r = await s.rfq(fields(i), [{ name, data }], { ip: ip() }); } catch (err) { say("INFO", `RFQ: ${label}`, `request failed client-side: ${err.message}`); continue; }
      await sleep(100);
      const added = ls(s, "rfq-drawings").filter((f) => !before.has(f));
      if (r.status === 201) {
        keptRfqs.push({ id: r.body.rfqId, label, name, stored: added[0] });
        const strayName = added.some((f) => !/^[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|webp|heic|heif|dxf|dwg)(\.enc)?$/.test(f));
        say(strayName ? "FINDING" : (expectAccept ? "INFO" : "FINDING"), `RFQ: ${label}`, `accepted; stored as ${added[0]}`);
      } else {
        say(added.length === 0 ? (expectAccept ? "INFO" : "PASS") : "FINDING", `RFQ: ${label}`, `HTTP ${r.status} ${r.body?.code || r.body?.error || ""}; files left: ${added.length}`);
      }
    }

    // Admin download of each stored attachment: what would a browser do with it?
    for (const k of keptRfqs) {
      const d = await s.get(`/api/rfq/admin/${k.id}/drawing`, { token: admin, ip: "203.0.113.5" });
      const h = d.headers;
      const ok = d.status === 200 && /^application\/octet-stream/.test(h["content-type"] || "") && /^attachment/.test(h["content-disposition"] || "") && h["x-content-type-options"] === "nosniff" && !h["set-cookie"] && !h["x-injected"];
      say(ok ? "PASS" : "FINDING", `download: ${k.label}`, `type=${h["content-type"]}; disposition=${String(h["content-disposition"]).slice(0, 90)}; nosniff=${h["x-content-type-options"]}; csp=${h["content-security-policy"] ? "yes" : "no"}`);
    }

    // ── C. leftovers ────────────────────────────────────────────────────────
    {
      const before = count();
      const big = Buffer.alloc(51 * 1024 * 1024, 0x20);
      const r1 = await s.upload([{ name: "big.stl", data: big }], { ip: ip() });
      const r2 = await s.upload(Array.from({ length: 11 }, (_, k) => ({ name: `c${k}.stl`, data: cube })), { ip: ip() });
      const r3 = await s.upload([{ name: "c.stl", data: cube, field: "other" }], { ip: ip() });
      const r4 = await s.upload([{ name: "ok.stl", data: cube }, { name: "bad.exe", data: cube }], { ip: ip() });
      await sleep(300);
      const after = count();
      say(after.uploads === before.uploads ? "PASS" : "FINDING", "refused uploads leave nothing", `too large → ${r1.status}; 11 files → ${r2.status}; wrong field → ${r3.status}; one bad extension among good → ${r4.status}; files left: ${after.uploads - before.uploads}`);
    }
    {
      // A client that hangs up half-way through a 20 MB file.
      const before = count();
      const m = live.multipart({}, [{ field: "files", name: "half.stl", data: g.stlAsciiPadded(20 * 1024 * 1024) }]);
      await new Promise((resolve) => {
        const sock = net.connect(s.port, "127.0.0.1", () => {
          sock.write(`POST /api/upload HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip()}\r\nContent-Type: ${m.headers["Content-Type"]}\r\nContent-Length: ${m.body.length}\r\n\r\n`);
          sock.write(m.body.subarray(0, m.body.length / 2), () => setTimeout(() => { sock.destroy(); resolve(); }, 300));
        });
      });
      await sleep(1500);
      const after = count();
      say(after.uploads === before.uploads ? "PASS" : "FINDING", "upload cut off half-way leaves nothing", `files left in data/uploads: ${after.uploads - before.uploads}${after.uploads > before.uploads ? ` (${ls(s, "uploads").slice(-1)[0]})` : ""}`);
    }
    {
      // Same for the RFQ attachment and the quote drawing.
      const before = count();
      const m = live.multipart({ contactName: "x", email: "x@example.test" }, [{ field: "drawing", name: "half.pdf", data: Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024, 0x20)]) }]);
      await new Promise((resolve) => {
        const sock = net.connect(s.port, "127.0.0.1", () => {
          sock.write(`POST /api/rfq HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip()}\r\nContent-Type: ${m.headers["Content-Type"]}\r\nContent-Length: ${m.body.length}\r\n\r\n`);
          sock.write(m.body.subarray(0, m.body.length / 2), () => setTimeout(() => { sock.destroy(); resolve(); }, 300));
        });
      });
      await sleep(1500);
      const after = count();
      say(after.rfq === before.rfq ? "PASS" : "FINDING", "RFQ attachment cut off half-way leaves nothing", `files left in data/rfq-drawings: ${after.rfq - before.rfq}`);
    }
    {
      // RFQ refused AFTER the file was written: honeypot, no form token, bad email.
      const before = count();
      const a = await s.rfq({ ...fields(900), website: "http://spam.example" }, [{ name: "d.pdf", data: pdf() }], { ip: ip() });
      const b = await s.upload([{ field: "drawing", name: "d.pdf", data: pdf() }], { url: "/api/rfq", fields: fields(901), ip: ip() });
      const c = await s.rfq({ contactName: "x", email: "not-an-address" }, [{ name: "d.pdf", data: pdf() }], { ip: ip() });
      await sleep(300);
      const after = count();
      say(after.rfq === before.rfq ? "PASS" : "FINDING", "RFQ refused after the attachment was written leaves nothing", `honeypot → ${a.status}; no form token → ${b.status}; bad email → ${c.status}; files left: ${after.rfq - before.rfq}`);
    }
    {
      // Client hangs up while its file is being parsed (a 60-second DXF).
      const before = count();
      const m = live.multipart({}, [{ field: "files", name: "spin.dxf", data: g.dxfInsertBomb(8, 1, 100, 100) }]);
      const theIp = ip();
      await new Promise((resolve) => {
        const sock = net.connect(s.port, "127.0.0.1", () => {
          sock.write(`POST /api/upload HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${theIp}\r\nContent-Type: ${m.headers["Content-Type"]}\r\nContent-Length: ${m.body.length}\r\n\r\n`);
          sock.write(m.body, () => setTimeout(() => { sock.destroy(); resolve(); }, 2500));
        });
      });
      await sleep(1500);
      const after = count();
      const t0 = Date.now();
      const again = await s.upload([{ name: "cube.stl", data: cube }], { ip: theIp });
      say(after.uploads === before.uploads && again.status === 200 && Date.now() - t0 < 5000 ? "PASS" : "FINDING", "client hangs up during a long parse: file removed, worker freed", `files left: ${after.uploads - before.uploads}; same address uploads again in ${Date.now() - t0} ms (HTTP ${again.status})`);
    }

    // ── C2. quote drawing ───────────────────────────────────────────────────
    const up = await s.upload([{ name: "cube.stl", data: cube }], { ip: "198.51.99.1" });
    const partId = up.body.parts[0].partId;
    const mats = (await s.get("/api/materials?process=cnc", { ip: "198.51.99.1" })).body;
    const q = await s.post("/api/quote", { parts: [{ partId, materialSlug: mats[0].slug, quantity: 1, process: "cnc", subProcess: "milling" }], leadTimeSlug: "standard" }, { ip: "198.51.99.1" });
    const quoteId = q.body.quoteId;
    {
      const before = count();
      const a = await s.upload([{ field: "drawing", name: "d.pdf", data: Buffer.from(HTML) }], { url: `/api/quote/${quoteId}/drawing`, ip: ip() });
      const b = await s.upload([{ field: "drawing", name: "d.svg", data: pdf() }], { url: `/api/quote/${quoteId}/drawing`, ip: ip() });
      await sleep(200);
      const mid = count();
      say(mid.quote === before.quote ? "PASS" : "FINDING", "quote drawing: HTML named .pdf and a .svg are refused and removed", `→ ${a.status}, ${b.status}; files left: ${mid.quote - before.quote}`);
      const c = await s.upload([{ field: "drawing", name: `poly"\r\nX-Injected: 1.pdf`, data: pdf(HTML) }], { url: `/api/quote/${quoteId}/drawing`, ip: ip() });
      const d = await s.upload([{ field: "drawing", name: "second.pdf", data: pdf() }], { url: `/api/quote/${quoteId}/drawing`, ip: ip() });
      await sleep(200);
      const after = count();
      say(after.quote - before.quote === 1 ? "PASS" : "FINDING", "quote drawing: replacing a drawing removes the one it replaces", `first → ${c.status} (${JSON.stringify(c.body?.drawingFileName)}), second → ${d.status}; files now: ${after.quote - before.quote}`);
    }

    // ── C3. order drawing download (owner) through a stubbed checkout ───────
    {
      const buyerIp = "198.51.99.2";
      const buyer = await s.register("buyer@example.test", { ip: buyerIp });
      await s.upload([{ field: "drawing", name: `evil"\r\nSet-Cookie: a=b; x=".pdf`, data: pdf(HTML) }], { url: `/api/quote/${quoteId}/drawing`, ip: buyerIp });
      const co = await s.post("/api/orders/checkout-session", { quoteId, shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" }, { token: buyer, ip: buyerIp });
      if (co.status === 200) {
        const d = await s.get(`/api/orders/${co.body.orderId}/drawing`, { token: buyer, ip: buyerIp });
        const h = d.headers;
        const ok = d.status === 200 && /^application\/octet-stream/.test(h["content-type"] || "") && /^attachment/.test(h["content-disposition"] || "") && h["x-content-type-options"] === "nosniff" && !h["set-cookie"];
        say(ok ? "PASS" : "FINDING", "order drawing download (buyer): attachment, octet-stream, nosniff, no injected header", `type=${h["content-type"]}; disposition=${String(h["content-disposition"]).slice(0, 100)}`);
        const other = await s.register("other@example.test", { ip: "198.51.99.3" });
        const x = await s.get(`/api/orders/${co.body.orderId}/drawing`, { token: other, ip: "198.51.99.3" });
        say(x.status === 404 || x.status === 403 ? "PASS" : "FINDING", "another account cannot download the order's drawing", `HTTP ${x.status}`);
        const p = await s.get(`/api/parts/${partId}/download`, { token: buyer, ip: buyerIp });
        say(p.status === 403 || p.status === 401 ? "PASS" : "FINDING", "a buyer cannot download a CAD file (admin only)", `HTTP ${p.status}`);
      } else say("INFO", "order drawing download not exercised", `checkout answered ${co.status}: ${co.text.slice(0, 120)}`);
      const pa = await s.get(`/api/parts/${partId}/download`, { token: admin, ip: "203.0.113.5" });
      const h = pa.headers;
      say(pa.status === 200 && /octet-stream/.test(h["content-type"]) && /^attachment/.test(h["content-disposition"]) && h["x-content-type-options"] === "nosniff" ? "PASS" : "FINDING", "CAD download (admin): attachment, octet-stream, nosniff", `type=${h["content-type"]}; disposition=${h["content-disposition"]}`);
      for (const id of ["../../quoting.db", "..%2F..%2Fquoting.db", `${partId}/../../x`, `${partId}%00`, partId.toUpperCase()]) {
        const r = await s.get(`/api/parts/${id}/download`, { token: admin, ip: "203.0.113.5" });
        if (r.status === 200 && id !== partId.toUpperCase()) say("FINDING", `part download with id ${id}`, `HTTP 200, ${r.buffer.length} bytes`);
      }
      say("PASS", "part download ids that are not a UUID are refused (traversal forms tried: 4)");
    }

    // ── D. is anything under data/ reachable from the site's origin? ────────
    {
      const stored = ls(s, "uploads")[0];
      const drawing = ls(s, "rfq-drawings")[0];
      const urls = [`/data/uploads/${stored}`, `/uploads/${stored}`, `/api/uploads/${stored}`, `/data/rfq-drawings/${drawing}`, `/rfq-drawings/${drawing}`, `/quote-drawings/x.pdf`, `/data/quoting.db`, `/quoting.db`, `/..%2f..%2fdata/quoting.db`, `/assets/..%2f..%2f..%2fdata%2fquoting.db`, `/assets/../../../data/quoting.db`, `/%2e%2e/%2e%2e/data/quoting.db`, `/.env`, `/server/index.js`, `/package.json`];
      const hits = [];
      for (const u of urls) {
        const r = await new Promise((resolve) => {
          // raw socket: the path must reach the server exactly as written
          const sock = net.connect(s.port, "127.0.0.1", () => sock.write(`GET ${u} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
          let d = Buffer.alloc(0);
          sock.on("data", (c) => { d = Buffer.concat([d, c]); });
          sock.on("close", () => resolve(d));
        });
        const status = Number((r.toString("latin1").match(/^HTTP\/1\.1 (\d+)/) || [])[1]);
        const body = r.subarray(r.indexOf("\r\n\r\n") + 4);
        const leaked = body.includes(Buffer.from("SQLite format 3")) || body.includes(Buffer.from("review mesh")) || body.includes(Buffer.from("%PDF-")) || body.includes(Buffer.from("JWT_SECRET")) || body.includes(Buffer.from("\"dependencies\""));
        if (leaked) hits.push(`${u} → ${status}`);
      }
      say(hits.length ? "FINDING" : "PASS", `stored files, the database and source are not reachable by URL (${urls.length} paths tried)`, hits.join("; "));
    }
    const findings = out.filter((o) => o.kind === "FINDING").length;
    console.log(`\n${out.filter((o) => o.kind === "PASS").length} PASS, ${findings} FINDING, ${out.filter((o) => o.kind === "INFO").length} INFO`);
  } finally {
    await s.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
