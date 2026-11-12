#!/usr/bin/env node
/**
 * Item 3 of the review: how cheaply can service be denied to real customers?
 *
 *   node tools/security/review-uploads/availability.js pool        two requests of ten 1 kB DXFs vs. a real customer
 *   node tools/security/review-uploads/availability.js queue       one address fills the waiting line
 *   node tools/security/review-uploads/availability.js storage     five addresses fill the 2 GB storage ceiling
 *   node tools/security/review-uploads/availability.js db          one address grows the database with draft quotes
 *   node tools/security/review-uploads/availability.js mainthread  100-line quotes of a heavy DXF vs. the health check
 *   node tools/security/review-uploads/availability.js memory      two memory-hungry files at once: peak RSS
 *   node tools/security/review-uploads/availability.js keys        how addresses map to limiter keys
 *   node tools/security/review-uploads/availability.js budget      daily byte budget vs. a request with no Content-Length
 *
 * All limits are the server's defaults unless a line says otherwise.
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const g = require("./gen");
const { startServer, monitor, sleep, ls, dirBytes, rssMb, live } = require("./lib");

const MB = 1024 * 1024;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const cube = g.stlCube();

async function pool() {
  const s = await startServer();
  try {
    const bomb = g.dxfInsertBomb(8, 1, 100, 100);
    log(`attack file: ${bomb.length} bytes of DXF; one request carries 10 of them`);
    const files = Array.from({ length: 10 }, (_, i) => ({ name: `b${i}.dxf`, data: bomb }));
    const t0 = Date.now();
    const done = [];
    for (const ip of ["192.0.2.10", "2001:db8:1:1::10"]) {
      s.upload(files, { ip, timeoutMs: 900000 }).then((r) => { done.push({ ip, seconds: Math.round((Date.now() - t0) / 1000), status: r.status, codes: (r.body?.errors || []).map((e) => e.code) }); log(`attacker ${ip}: request finished after ${Math.round((Date.now() - t0) / 1000)} s →`, r.status, JSON.stringify((r.body?.errors || []).map((e) => e.code))); });
    }
    await sleep(1000);
    const mon = monitor(s);
    const results = [];
    // A real customer, one cube every 20 s, for as long as the two requests last.
    const customer = async (n) => {
      const c0 = Date.now();
      const r = await s.upload([{ name: "cube.stl", data: cube }], { ip: `203.0.113.${n + 1}`, timeoutMs: 120000 });
      const row = { at: Math.round((c0 - t0) / 1000), waited: Number(((Date.now() - c0) / 1000).toFixed(1)), status: r.status, code: r.body?.code || r.body?.errors?.[0]?.code || (r.body?.parts?.length ? "parsed" : "") };
      results.push(row);
      log(`customer at t+${row.at}s: HTTP ${row.status} ${row.code} after ${row.waited}s`);
    };
    const pending = [];
    for (let n = 0; done.length < 2 && n < 40; n++) { pending.push(customer(n)); await sleep(20000); }
    await Promise.all(pending);
    const m = await mon.stop();
    const served = results.filter((r) => r.code === "parsed").length;
    console.log(JSON.stringify({ test: "pool", attackerRequests: 2, attackerBytesTotal: bomb.length * 20, heldSeconds: done.map((d) => d.seconds), customersTried: results.length, customersServed: served, customersRefused: results.length - served, typicalWait: results[0]?.waited, healthWorstMs: m.worstMs, results }));
  } finally { await s.stop(); }
}

async function queue() {
  const s = await startServer();
  try {
    const bomb = g.dxfInsertBomb(8, 1, 100, 100);
    // ONE address: 1 running + 8 waiting (the per-client lane lets only one run).
    const ip = "192.0.2.20";
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) s.upload([{ name: "b.dxf", data: bomb }], { ip, timeoutMs: 200000 }).then((r) => log(`attacker request ${i}: HTTP ${r.status} ${r.body?.code || r.body?.errors?.[0]?.code} after ${Math.round((Date.now() - t0) / 1000)}s`)).catch(() => {});
    await sleep(1500);
    // Two real customers at the same moment with a file that takes a few seconds (the 2 MB STEP).
    const step = g.stepPlate400();
    const go = async (n) => { const c0 = Date.now(); const r = await s.upload([{ name: "plate.step", data: step }], { ip: `203.0.113.${n}`, timeoutMs: 200000 }); const row = { customer: n, status: r.status, code: r.body?.code || r.body?.errors?.[0]?.code || (r.body?.parts?.length ? "parsed" : ""), seconds: Number(((Date.now() - c0) / 1000).toFixed(1)) }; log("customer", JSON.stringify(row)); return row; };
    const rows = await Promise.all([go(1), sleep(300).then(() => go(2)), sleep(600).then(() => go(3))]);
    console.log(JSON.stringify({ test: "queue", attackerAddresses: 1, rows }));
  } finally { await s.stop(); }
}

/** POST a multipart body built from parts without holding it twice in memory. */
function uploadParts(s, ip, parts, total, { chunked = false, url = "/api/upload", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const boundary = `----rv${Date.now()}${Math.random().toString(16).slice(2)}`;
    const pieces = [];
    for (const f of parts) {
      if (f.field !== undefined && f.value !== undefined) { pieces.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"\r\n\r\n${f.value}\r\n`)); continue; }
      pieces.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field || "files"}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.data, Buffer.from("\r\n"));
    }
    pieces.push(Buffer.from(`--${boundary}--\r\n`));
    const length = pieces.reduce((n, p) => n + p.length, 0);
    const h = { "Content-Type": `multipart/form-data; boundary=${boundary}`, "X-Forwarded-For": ip, ...headers };
    if (!chunked) h["Content-Length"] = String(length);
    const req = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: url, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, body, text, sent: length }); });
    });
    // A refusal judged on Content-Length is answered before the body is read and the socket is closed:
    // the write then fails (EPIPE). Give the answer a moment to arrive; if none does, report the closed connection.
    let failed = false;
    req.on("error", () => { failed = true; setTimeout(() => { if (!req._answered) resolve({ status: 0, body: { code: "connection-closed-before-an-answer" }, text: "", sent: 0 }); }, 500); });
    req.on("response", () => { req._answered = true; });
    (async () => { for (const p of pieces) { if (failed) return; if (!req.write(p)) await new Promise((r) => { req.once("drain", r); req.once("error", r); }); } if (!failed) req.end(); })().catch(() => {});
  });
}

async function storage() {
  const s = await startServer();
  try {
    const big = g.stlAsciiPadded(49 * MB);
    const t0 = Date.now();
    let sent = 0;
    const rows = [];
    for (let i = 1; i <= 6; i++) {
      const ip = `192.0.2.${30 + i}`;
      const files = Array.from({ length: 10 }, (_, k) => ({ name: `part-${i}-${k}.stl`, data: big }));
      const r = await uploadParts(s, ip, files);
      sent += r.sent;
      const stored = (dirBytes(s, "uploads") + dirBytes(s, "part-payloads")) / MB;
      rows.push({ address: ip, status: r.status, parsed: r.body?.parts?.length || 0, code: r.body?.code || r.body?.errors?.[0]?.code || "", storedMb: Math.round(stored), elapsed: Math.round((Date.now() - t0) / 1000) });
      log(JSON.stringify(rows[rows.length - 1]));
      if (r.status === 503) break;
    }
    // Top up: the last address sends files sized to what is left, down to the last few kB.
    await sleep(31000); // the usage figure is cached for 30 s
    for (let round = 0; round < 6; round++) {
      const left = 2048 * MB - (dirBytes(s, "uploads") + dirBytes(s, "part-payloads") + dirBytes(s, "rfq-drawings") + dirBytes(s, "quote-drawings"));
      if (left < 64 * 1024) break;
      const size = Math.min(49 * MB, left - 8 * 1024);
      const r = await uploadParts(s, "192.0.2.39", [{ name: "topup.stl", data: g.stlAsciiPadded(size) }]);
      sent += r.sent;
      log(`top-up of ${(size / MB).toFixed(2)} MB: HTTP ${r.status} ${r.body?.code || ""}; stored ${Math.round((dirBytes(s, "uploads") + dirBytes(s, "part-payloads")) / MB)} MB`);
      if (r.status !== 200) await sleep(31000);
    }
    await sleep(31000);
    const typical = await s.upload([{ name: "tube.step", data: g.stepFixture("tube.step") }], { ip: "203.0.113.49" });
    log("real customer, 9 kB STEP:", typical.status, typical.text.slice(0, 160));
    const victim = await s.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.50" });
    log("real customer, 684-byte cube:", victim.status, victim.text.slice(0, 160));
    const rfq = await s.rfq({ contactName: "Customer", email: "c@example.test", notes: "with drawing" }, [{ name: "d.pdf", data: Buffer.from("%PDF-1.4\n%%EOF\n") }], { ip: "203.0.113.51" });
    log("real customer, RFQ with a 15-byte PDF:", rfq.status, rfq.text.slice(0, 160));
    // Does a restart (the sweeps run at startup) give the space back?
    const tmp = s.tmp;
    await s.stop({ keep: true });
    const s2 = await startServer({ tmpDir: tmp });
    const again = await s2.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.52" });
    log("after a restart:", again.status, again.text.slice(0, 120));
    console.log(JSON.stringify({ test: "storage", addresses: rows.length, uploadedMb: Math.round(sent / MB), seconds: Math.round((Date.now() - t0) / 1000), rows, typicalStatus: typical.status, typicalCode: typical.body?.code, victimStatus: victim.status, victimCode: victim.body?.code, rfqWithFileStatus: rfq.status, afterRestart: again.status, log: s2.log().split("\n").filter((l) => /STORAGE|retention/i.test(l)).slice(0, 4) }));
    await s2.stop();
  } catch (err) { await s.stop().catch(() => {}); throw err; }
}

async function db() {
  const max = Number(process.argv[3]) || 0; // stop after this many quotes (0 = until uploads are refused)
  const s = await startServer({ env: process.env.REVIEW_DB_MAX_MB ? { DB_MAX_MB: process.env.REVIEW_DB_MAX_MB } : {} });
  try {
    const up = await s.upload([{ name: "cube.stl", data: cube }], { ip: "192.0.2.60" });
    const partId = up.body.parts[0].partId;
    const mat = (await s.get("/api/materials?process=cnc", { ip: "192.0.2.60" })).body[0];
    const line = { partId, materialSlug: mat.slug, quantity: 1, process: "cnc", subProcess: "milling" };
    const body = { parts: Array.from({ length: 100 }, () => line), leadTimeSlug: "standard", notes: "x".repeat(2000) };
    const dbFile = path.join(s.dataDir, "quoting.db");
    const size = () => { try { return fs.statSync(dbFile).size; } catch { return 0; } };
    const t0 = Date.now();
    const mon = monitor(s);
    const rows = [];
    let n = 0, refused = null, ipN = 0, ip = "192.0.2.61", limited = 0, quoteRefused = null;
    const quoteIds = [];
    for (;;) {
      const q0 = Date.now();
      const r = await s.post("/api/quote", body, { ip, timeoutMs: 120000 });
      // 2026-11-12, with the fixes: a quote without an account holds 25 lines, so the flood goes on with 25.
      if (r.status === 400 && r.body?.code === "too-many-lines" && body.parts.length > 25) { log("100 lines without an account refused (too-many-lines); going on with 25 lines a quote"); body.parts = body.parts.slice(0, 25); continue; }
      if (r.status === 429) { limited++; ipN++; ip = `198.18.${ipN >> 8}.${ipN & 255}`; continue; } // next address
      if (r.status !== 200) {
        quoteRefused = { afterQuotes: n, status: r.status, code: r.body?.code, dbMb: Number((size() / MB).toFixed(1)), addressesUsed: ipN + 1 };
        log("quote refused:", r.status, r.text.slice(0, 200));
        // what a real visitor meets at that moment, with and without an account
        const anon = await s.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.201" });
        const reprice = quoteIds.length ? await s.post("/api/quote", { ...body, quoteId: quoteIds[0] }, { ip: "192.0.2.61" }) : null;
        quoteRefused.anonymousUpload = `${anon.status} ${anon.body?.code || "ok"}`;
        quoteRefused.repriceOfAnOpenQuote = reprice ? reprice.status : null;
        log("at that moment:", JSON.stringify(quoteRefused));
        break;
      }
      if (quoteIds.length < 1) quoteIds.push(r.body.quoteId);
      n++;
      if (n % 25 === 0 || n === 1) {
        const row = { quotes: n, dbMb: Number((size() / MB).toFixed(1)), lastQuoteMs: Date.now() - q0, rssMb: rssMb(s.pid), addressesUsed: ipN + 1, elapsed: Math.round((Date.now() - t0) / 1000) };
        rows.push(row); log(JSON.stringify(row));
        const u = await s.upload([{ name: "cube.stl", data: cube }], { ip: `203.0.113.${(n / 25) % 250}` });
        if (u.status !== 200) { refused = { afterQuotes: n, status: u.status, code: u.body?.code, error: u.body?.error }; log("REAL CUSTOMER UPLOAD REFUSED:", JSON.stringify(refused)); break; }
      }
      if (max && n >= max) break;
    }
    const m = await mon.stop();
    let afterRestart = null;
    if (refused) {
      const tmp = s.tmp;
      await s.stop({ keep: true });
      const s2 = await startServer({ tmpDir: tmp, env: process.env.REVIEW_DB_MAX_MB ? { DB_MAX_MB: process.env.REVIEW_DB_MAX_MB } : {} });
      const u = await s2.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.77" });
      afterRestart = { status: u.status, code: u.body?.code, startupRssMb: rssMb(s2.pid) };
      log("after a restart:", JSON.stringify(afterRestart));
      await s2.stop();
    }
    console.log(JSON.stringify({ test: "db", quotes: n, bytesPerQuote: rows.length ? Math.round((rows[rows.length - 1].dbMb * MB) / rows[rows.length - 1].quotes) : 0, rateLimitedResponses: limited, seconds: Math.round((Date.now() - t0) / 1000), healthWorstMs: m.worstMs, healthMedianMs: m.medianMs, peakRssMb: m.peakRssMb, quoteRefused, refused, afterRestart, rows }));
    if (!s.exited()) await s.stop();
  } catch (err) { await s.stop().catch(() => {}); throw err; }
}

async function mainthread() {
  const s = await startServer();
  try {
    const holes = Number(process.argv[3]) || 4900;
    const data = g.dxfManyHoles(holes);
    const ip = "192.0.2.80";
    const t0 = Date.now();
    const up = await s.upload([{ name: "perforated.dxf", data }], { ip, timeoutMs: 200000 });
    const part = up.body?.parts?.[0];
    log(`upload of a ${Math.round(data.length / 1024)} kB DXF with ${holes} holes: HTTP ${up.status} in ${Date.now() - t0} ms, response ${Math.round(up.text.length / 1024)} kB`, part ? "" : up.text.slice(0, 200));
    if (!part) return;
    const payload = ls(s, "part-payloads").map((f) => `${f.replace(/^[0-9a-f-]{36}/, "<id>")} ${Math.round(fs.statSync(path.join(s.dataDir, "part-payloads", f)).size / 1024)} kB`);
    log("payload files:", payload.join(", ") || "none (geometry is in the row)");
    const mat = (await s.get("/api/materials?process=routing", { ip })).body[0];
    const line = { partId: part.partId, materialSlug: mat.slug, quantity: 1, process: "routing", thicknessMm: mat.thicknesses?.[0]?.mm || 6.35 };
    const one = Date.now();
    const q1 = await s.post("/api/quote", { parts: [line], leadTimeSlug: "standard" }, { ip });
    log(`1-line quote: HTTP ${q1.status} in ${Date.now() - one} ms`, q1.status === 200 ? "" : q1.text.slice(0, 200));
    const body = { parts: Array.from({ length: 100 }, () => line), leadTimeSlug: "standard" };
    const mon = monitor(s);
    const times = [];
    const a0 = Date.now();
    // one address, inside its pricing limit (40 per 10 s): eight requests at a time for 30 s
    let stop = false;
    const worker = async () => { while (!stop) { const q0 = Date.now(); const r = await s.post("/api/quote", body, { ip, timeoutMs: 300000 }); times.push({ ms: Date.now() - q0, status: r.status }); if (r.status === 429) await sleep(1000); } };
    const ws = Array.from({ length: 8 }, worker);
    await sleep(30000); stop = true; await Promise.all(ws);
    const m = await mon.stop();
    const ok = times.filter((t) => t.status === 200);
    console.log(JSON.stringify({ test: "mainthread", holes, dxfKb: Math.round(data.length / 1024), payload, quoteRequests: times.length, priced: ok.length, rateLimited: times.filter((t) => t.status === 429).length, medianQuoteMs: ok.map((t) => t.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)], seconds: Math.round((Date.now() - a0) / 1000), healthWorstMs: m.worstMs, healthMedianMs: m.medianMs, healthSamples: m.samples }));
  } finally { await s.stop(); }
}

async function memory() {
  const s = await startServer();
  try {
    const a = g.stlSoup(500000, 1), b = g.stlSoup(500000, 2);
    const mon = monitor(s, { everyMs: 25 });
    const t0 = Date.now();
    const rs = await Promise.all([s.upload([{ name: "a.stl", data: a }], { ip: "192.0.2.90", timeoutMs: 200000 }), s.upload([{ name: "b.stl", data: b }], { ip: "192.0.2.91", timeoutMs: 200000 }), sleep(3000).then(() => s.upload([{ name: "plate.step", data: g.stepPlate400() }], { ip: "203.0.113.90", timeoutMs: 200000 }))]);
    const m = await mon.stop();
    console.log(JSON.stringify({ test: "memory", seconds: Math.round((Date.now() - t0) / 1000), outcomes: rs.map((r) => r.body?.errors?.[0]?.code || (r.body?.parts?.length ? "parsed" : r.status)), baseRssMb: m.baseRssMb, peakRssMb: m.peakRssMb, healthWorstMs: m.worstMs, alive: !s.exited(), log: s.log().split("\n").filter((l) => /Parse pool/.test(l)) }));
  } finally { await s.stop(); }
}

async function keys() {
  const { keyForAddress } = require("../../../server/security/clientKey");
  const forms = ["203.0.113.9", "::ffff:203.0.113.9", "::ffff:cb00:7109", "0:0:0:0:0:ffff:cb00:7109", "::203.0.113.9", "64:ff9b::203.0.113.9", "2002:cb00:7109::1", "2001:db8:aa:1::1", "2001:db8:aa:1:ffff:ffff:ffff:ffff", "2001:db8:aa:2::1", "2001:db8:ab:1::1", "fe80::1%eth0", "203.0.113.9:51234", "[2001:db8::1]:443", "unknown", "", " 203.0.113.9"];
  for (const f of forms) console.log(`${JSON.stringify(f).padEnd(44)} → ${keyForAddress(f)}`);
  // What the server takes as the client address from X-Forwarded-For with one trusted hop.
  const s = await startServer({ env: { RATE_UPLOAD_PER_15MIN: "3" } });
  try {
    const hit = async (xff) => (await s.upload([{ name: "c.stl", data: cube }], { headers: { "X-Forwarded-For": xff } })).status;
    const run = async (label, list) => { const st = []; for (const x of list) st.push(await hit(x)); console.log(`${label}: ${st.join(" ")}`); };
    await run("same right-most entry, different left entries (limit 3)", ["1.1.1.1, 198.51.100.7", "2.2.2.2, 198.51.100.7", "3.3.3.3, 198.51.100.7", "4.4.4.4, 198.51.100.7", "5.5.5.5, 198.51.100.7"]);
    await run("same address as IPv4-mapped IPv6", ["198.51.100.8", "::ffff:198.51.100.8", "::ffff:c633:6408", "0:0:0:0:0:ffff:c633:6408", "198.51.100.8"]);
    await run("one /64, five addresses", ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:aaaa::3", "2001:db8:1:2:ffff:ffff:ffff:fff4", "2001:db8:1:2::5"]);
    await run("one /48, five /64s", ["2001:db8:1:1::1", "2001:db8:1:2::1", "2001:db8:1:3::1", "2001:db8:1:4::1", "2001:db8:1:5::1"]);
    await run("address with a port appended", ["198.51.100.9:1001", "198.51.100.9:1002", "198.51.100.9:1003", "198.51.100.9:1004", "198.51.100.9:1005"]);
    await run("NAT64 / 6to4 / compatible forms of one IPv4", ["64:ff9b::198.51.100.10", "2002:c633:640a::1", "::198.51.100.10", "198.51.100.10", "::ffff:198.51.100.10"]);
    // restart: do the counters survive?
    const before = [await hit("198.51.100.11"), await hit("198.51.100.11"), await hit("198.51.100.11"), await hit("198.51.100.11")];
    const tmp = s.tmp;
    await s.stop({ keep: true });
    const s2 = await startServer({ tmpDir: tmp, env: { RATE_UPLOAD_PER_15MIN: "3" } });
    const after = (await s2.upload([{ name: "c.stl", data: cube }], { headers: { "X-Forwarded-For": "198.51.100.11" } })).status;
    console.log(`upload limiter before restart: ${before.join(" ")}; first request after restart: ${after}`);
    await s2.stop();
  } catch (err) { await s.stop().catch(() => {}); throw err; }
}

async function budget() {
  const s = await startServer({ env: { UPLOAD_DAILY_MB_PER_IP: "20" } });
  try {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(8 * MB, 0x20)]);
    const fields = (i) => [{ field: "contactName", value: "R" }, { field: "email", value: `b${i}@example.test` }, { field: "notes", value: `n${i}` }];
    const run = async (label, chunked, ip) => {
      const out = [];
      for (let i = 0; i < 6; i++) {
        const r = await uploadParts(s, ip, [...fields(`${chunked ? "c" : "l"}${i}`), { field: "drawing", name: "d.pdf", data: pdf }], 0, { chunked, url: "/api/rfq", headers: { "X-Form-Token": s.formToken("rfq") } });
        out.push(`${r.status}${r.body?.code ? `:${r.body.code}` : ""}`);
        if (r.status === 400 && i === 0) console.log("   (first refusal:", r.text.slice(0, 160), ")");
      }
      console.log(`${label} (daily budget 20 MB, each attachment 8 MB): ${out.join("  ")}  → stored ${Math.round(dirBytes(s, "rfq-drawings") / MB)} MB`);
    };
    await run("with Content-Length", false, "192.0.2.101");
    await run("chunked, no Content-Length", true, "192.0.2.102");
    // CAD upload: the request that crosses the line is not refused up front either
    const big = g.stlAsciiPadded(9 * MB);
    const o = [];
    for (let i = 0; i < 4; i++) { const r = await uploadParts(s, "192.0.2.103", [{ name: "p.stl", data: big }], 0, { chunked: true }); o.push(`${r.status}${r.body?.code ? `:${r.body.code}` : ""}`); }
    console.log(`CAD upload chunked (9 MB each, budget 20 MB): ${o.join("  ")}`);
  } finally { await s.stop(); }
}

/**
 * GET /api/quote/:id/session answers with every line's preview mesh, read and assembled on the main
 * thread. One dense part on 100 lines of one quote: how big is the answer, how long is the server deaf,
 * how much memory does the main process take?
 */
async function session() {
  const lines = Number(process.argv[3]) || 100;
  const parallel = Number(process.argv[4]) || 4;
  const s = await startServer();
  try {
    const ip = "192.0.2.120";
    const up = await s.upload([{ name: "plate.step", data: g.stepPlate400() }], { ip, timeoutMs: 120000 });
    const part = up.body?.parts?.[0];
    if (!part) { log("upload failed", up.status, up.text.slice(0, 200)); return; }
    const mesh = ls(s, "part-payloads").filter((f) => /mesh/.test(f)).map((f) => fs.statSync(path.join(s.dataDir, "part-payloads", f)).size)[0] || 0;
    log(`one 2 MB STEP uploaded; its preview mesh file is ${(mesh / MB).toFixed(1)} MB`);
    const mat = (await s.get("/api/materials?process=cnc", { ip })).body[0];
    const line = { partId: part.partId, materialSlug: mat.slug, quantity: 1, process: "cnc", subProcess: "milling" };
    const q = await s.post("/api/quote", { parts: Array.from({ length: lines }, () => line), leadTimeSlug: "standard" }, { ip, timeoutMs: 120000 });
    if (q.status !== 200) { log("quote failed", q.status, q.text.slice(0, 200)); return; }
    log(`quote with ${lines} lines of that part saved (${q.status})`);
    const base = rssMb(s.pid);
    const mon = monitor(s, { everyMs: 25 });
    const t0 = Date.now();
    const one = async () => { const r0 = Date.now(); try { const r = await s.get(`/api/quote/${q.body.quoteId}/session`, { ip, timeoutMs: 300000 }); return { status: r.status, mb: Number((r.buffer.length / MB).toFixed(1)), ms: Date.now() - r0 }; } catch (err) { return { status: 0, error: err.message.slice(0, 80), ms: Date.now() - r0 }; } };
    const first = await one();
    log("one request:", JSON.stringify(first), `RSS ${rssMb(s.pid)} MB`);
    const many = s.exited() ? [] : await Promise.all(Array.from({ length: parallel }, one));
    log(`${parallel} at once:`, JSON.stringify(many), `RSS ${rssMb(s.pid)} MB`);
    await sleep(500);
    const m = await mon.stop();
    const after = s.exited() ? null : await s.upload([{ name: "cube.stl", data: cube }], { ip: "203.0.113.120" });
    console.log(JSON.stringify({ test: "session", lines, meshMb: Number((mesh / MB).toFixed(1)), first, many, seconds: Math.round((Date.now() - t0) / 1000), baseRssMb: base, peakRssMb: m.peakRssMb, healthWorstMs: m.worstMs, healthMedianMs: m.medianMs, healthFailures: m.failures, serverExited: s.exited(), customerAfter: after ? after.status : "server gone", lastLog: s.log().split("\n").filter((l) => /FATAL|heap|memory|Error/i.test(l)).slice(-5) }));
  } finally { await s.stop().catch(() => {}); }
}

/** Kill a worker mid-parse again and again: does the process give the memory back? */
async function creep() {
  const s = await startServer();
  try {
    const step = g.stepRepeat(g.stepPlate400(), 3);
    const m = live.multipart({}, [{ field: "files", name: "plate.step", data: step }]);
    const net = require("net");
    const rows = [];
    const count = Number(process.argv[3]) || 24;
    const killAfterMs = Number(process.argv[4]) || 6000;
    for (let i = 1; i <= count; i++) {
      await new Promise((resolve) => {
        const sock = net.connect(s.port, "127.0.0.1", () => {
          sock.write(`POST /api/upload HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: 192.0.2.${130 + (i % 100)}\r\nContent-Type: ${m.headers["Content-Type"]}\r\nContent-Length: ${m.body.length}\r\n\r\n`);
          sock.write(m.body, () => setTimeout(() => { sock.destroy(); resolve(); }, killAfterMs));
        });
      });
      await sleep(1200);
      rows.push(rssMb(s.pid));
      if (i % 10 === 0) log(`after ${i} parses killed at ${killAfterMs / 1000} s: RSS ${rows[rows.length - 1]} MB, threads ${fs.readdirSync(`/proc/${s.pid}/task`).length}, files in uploads ${ls(s, "uploads").length}`);
    }
    await sleep(65000); // idle workers are let go after a minute
    console.log(JSON.stringify({ test: "creep", rssAfterEachMb: rows, rssIdleMb: rssMb(s.pid), threadsIdle: fs.readdirSync(`/proc/${s.pid}/task`).length, uploadsLeft: ls(s, "uploads").length }));
  } finally { await s.stop(); }
}

/** Are bytes of a refused upload counted against the sender's daily budget? */
async function refused() {
  const s = await startServer({ env: { UPLOAD_DAILY_MB_PER_IP: "20", RATE_UPLOAD_PER_15MIN: "1000" } });
  try {
    const ip = "192.0.2.140";
    const over = g.stlAsciiPadded(51 * MB);
    const st = [];
    let sent = 0;
    for (let i = 0; i < 4; i++) { const r = await uploadParts(s, ip, [{ name: "over.stl", data: over }], 0, { chunked: true }); st.push(r.status); sent += over.length; }
    const junk = Buffer.alloc(9 * MB, 0x41);
    const st2 = [];
    for (let i = 0; i < 4; i++) { const r = await uploadParts(s, ip, [{ name: "junk.stl", data: junk }], 0); st2.push(`${r.status}${r.body?.code ? ":" + r.body.code : ""}`); }
    console.log(`four 51 MB files (over the 50 MB limit), no Content-Length: ${st.join(" ")} — ${Math.round(sent / MB)} MB received and written, daily budget 20 MB`);
    console.log(`then four 9 MB files that fail the content check (with Content-Length): ${st2.join(" ")}`);
  } finally { await s.stop(); }
}

const cmd = process.argv[2];
const table = { pool, queue, storage, db, mainthread, memory, keys, budget, session, creep, refused };
if (!table[cmd]) { console.error(`usage: availability.js ${Object.keys(table).join("|")}`); process.exit(2); }
table[cmd]().catch((e) => { console.error(e); process.exit(1); });
