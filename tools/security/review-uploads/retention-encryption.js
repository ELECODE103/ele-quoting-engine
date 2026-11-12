#!/usr/bin/env node
/**
 * Item 5 of the review: retention sweeps and encryption at rest.
 *
 *   node tools/security/review-uploads/retention-encryption.js retention
 *   node tools/security/review-uploads/retention-encryption.js encryption
 *
 * Ageing is simulated by setting file modification times back while the server is stopped, then
 * starting it again on the same folder (the sweeps run at every start). Stripe is a local stub.
 * The encryption key is random, made here at run time, and never printed.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const g = require("./gen");
const { startServer, sleep, ls, live } = require("./lib");

const DAY = 86400e3;
const say = (kind, what, detail = "") => console.log(`${kind.padEnd(8)} ${what}${detail ? ` — ${detail}` : ""}`);
const age = (dir, days) => { for (const f of fs.readdirSync(dir)) { const t = new Date(Date.now() - days * DAY); fs.utimesSync(path.join(dir, f), t, t); } };
const pdf = Buffer.from("%PDF-1.4\n% review drawing\n%%EOF\n");
const ship = { shippingName: "B", shippingAddress: "1 Test St", shippingCity: "T", shippingState: "IL", shippingZip: "60000" };

async function restart(s, opts = {}) {
  const tmp = s.tmp;
  await s.stop({ keep: true });
  return startServer({ stubs: true, tmpDir: tmp, ...opts });
}

async function retention() {
  let s = await startServer({ stubs: true });
  try {
    const ip = "198.51.100.40";
    const admin = await s.admin({ ip: "203.0.113.5" });
    const buyer = await s.register("buyer@example.test", { ip });
    const mat = (await s.get("/api/materials?process=cnc", { ip })).body[0];
    const mk = async (name) => { const u = await s.upload([{ name, data: g.stlCube() }], { ip }); const partId = u.body.parts[0].partId; const q = await s.post("/api/quote", { parts: [{ partId, materialSlug: mat.slug, quantity: 2, process: "cnc", subProcess: "milling" }], leadTimeSlug: "standard" }, { ip }); return { partId, quoteId: q.body.quoteId, total: q.body.orderTotal, expiresAt: q.body.expiresAt }; };
    const a = await mk("bracket-for-order.stl");
    const b = await mk("bracket-for-rfq.stl");
    say("INFO", "two draft quotes made", `price held until ${a.expiresAt.slice(0, 10)}; CAD files on disk: ${ls(s, "uploads").length}`);

    // Eight days pass: the quotes are still inside their 30-day hold.
    age(path.join(s.dataDir, "uploads"), 8);
    s = await restart(s);
    say("INFO", "8 days later (sweeps ran at start)", `CAD files on disk: ${ls(s, "uploads").length}; ${s.log().split("\n").filter((l) => /File retention/.test(l)).join(" | ")}`);

    const re = await s.get(`/api/quote/${a.quoteId}`, { ip });
    say("INFO", "the quote on day 8", `HTTP ${re.status}, status ${re.body?.status}, expired=${re.body?.expired}, total ${re.body?.orderTotal}`);
    const co = await s.post("/api/orders/checkout-session", { quoteId: a.quoteId, ...ship }, { token: buyer, ip });
    const dl = await s.get(`/api/parts/${a.partId}/download`, { token: admin, ip: "203.0.113.5" });
    say(co.status === 200 && dl.status !== 200 ? "FINDING" : "PASS", "an order placed on day 8 of a 30-day quote still has its CAD file", `checkout → HTTP ${co.status}${co.body?.orderId ? " (order created, sent to Stripe)" : ""}; admin download of the ordered part → HTTP ${dl.status} ${dl.body?.error || ""}`);

    const rq = await s.rfq({ contactName: "Buyer", email: "buyer2@example.test", quoteId: b.quoteId, notes: "please quote 500" }, [], { ip: "198.51.100.41" });
    const dl2 = await s.get(`/api/parts/${b.partId}/download`, { token: admin, ip: "203.0.113.5" });
    say(rq.status === 201 && dl2.status !== 200 ? "FINDING" : "PASS", "a firm-quote request sent on day 8 from that quote still has its CAD file", `request → HTTP ${rq.status}; admin download → HTTP ${dl2.status} ${dl2.body?.error || ""}`);

    // What is never deleted: the attachment of a request the shop has closed.
    const r2 = await s.rfq({ contactName: "Old Lead", email: "old@example.test", notes: "old request" }, [{ name: "old-drawing.pdf", data: pdf }], { ip: "198.51.100.42" });
    const put = await s.req({ method: "PUT", url: `/api/rfq/admin/${r2.body.rfqId}`, json: { status: "declined" }, token: admin, ip: "203.0.113.5" });
    age(path.join(s.dataDir, "rfq-drawings"), 400);
    s = await restart(s);
    say(ls(s, "rfq-drawings").length > 0 ? "FINDING" : "PASS", "the drawing of a request declined 400 days ago is removed", `declined → HTTP ${put.status}; files in data/rfq-drawings after the sweep: ${ls(s, "rfq-drawings").length}`);

    // A drawing nothing points at IS removed after a day.
    fs.writeFileSync(path.join(s.dataDir, "rfq-drawings", `${crypto.randomUUID()}.pdf`), pdf);
    const before = ls(s, "rfq-drawings").length;
    for (const f of ls(s, "rfq-drawings")) { const st = fs.statSync(path.join(s.dataDir, "rfq-drawings", f)); if (Date.now() - st.mtimeMs < DAY) { const t = new Date(Date.now() - 2 * DAY); fs.utimesSync(path.join(s.dataDir, "rfq-drawings", f), t, t); } }
    s = await restart(s);
    say(ls(s, "rfq-drawings").length === before - 1 ? "PASS" : "FINDING", "an orphan drawing is removed after 24 hours", `${before} → ${ls(s, "rfq-drawings").length}`);

    // A process killed in the middle of a parse leaves the upload behind.
    const bomb = g.dxfInsertBomb(8, 1, 100, 100);
    s.upload([{ name: "customer-part.dxf", data: bomb }], { ip: "198.51.100.43", timeoutMs: 5000 }).catch(() => {});
    await sleep(1500);
    const during = ls(s, "uploads");
    process.kill(s.pid, "SIGKILL");
    await sleep(500);
    age(path.join(s.dataDir, "uploads"), 6);
    s = await startServer({ stubs: true, tmpDir: s.tmp });
    say(ls(s, "uploads").length ? "FINDING" : "PASS", "an upload orphaned by a crash mid-parse is cleaned up at the next start", `on disk during the parse: ${during.join(", ")}; six days and one restart later: ${ls(s, "uploads").join(", ") || "nothing"} (no part row points at it; it goes at 7 days)`);
  } finally { await s.stop().catch(() => {}); }
}

function grepDir(dir, needles) {
  const hits = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else { const buf = fs.readFileSync(p); for (const [label, n] of needles) if (buf.includes(n)) hits.push(`${path.relative(dir, p).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>")}: ${label}`); } } };
  walk(dir);
  return hits;
}

async function encryption() {
  const key = crypto.randomBytes(48).toString("base64");
  const key2 = crypto.randomBytes(48).toString("base64");
  let s = await startServer({ stubs: true, env: { NORD_FILE_ENC_KEY: key } });
  try {
    const ip = "198.51.100.60";
    const admin = await s.admin({ ip: "203.0.113.5" });
    say("INFO", "started with a throwaway key", s.log().split("\n").find((l) => /File encryption/.test(l)) || "");
    // A small DXF with unmistakable coordinates, a STEP (large preview mesh), a busy DXF (geometry detail in a file), drawings.
    const secretDxf = Buffer.from(g.dxfDoc({ entities: g.dxfRect(0, 0, 123.4567, 76.5432) + g.dxfCircle(61.7283, 38.2716, 7.7777) }));
    const u1 = await s.upload([{ name: "SECRET-CUSTOMER-PART.dxf", data: secretDxf }], { ip });
    const u2 = await s.upload([{ name: "housing.step", data: g.stepPlate400() }], { ip, timeoutMs: 120000 });
    const u3 = await s.upload([{ name: "perforated.dxf", data: g.dxfManyHoles(1500) }], { ip, timeoutMs: 120000 });
    const u4 = await s.upload([{ name: "cube.stl", data: g.stlCube() }], { ip });
    const mat = (await s.get("/api/materials?process=cnc", { ip })).body[0];
    const q = await s.post("/api/quote", { parts: [{ partId: u4.body.parts[0].partId, materialSlug: mat.slug, quantity: 1, process: "cnc", subProcess: "milling" }], leadTimeSlug: "standard" }, { ip });
    await s.upload([{ field: "drawing", name: "quote-drawing.pdf", data: pdf }], { url: `/api/quote/${q.body.quoteId}/drawing`, ip });
    await s.rfq({ contactName: "Buyer", email: "b@example.test", notes: "see drawing" }, [{ name: "rfq-drawing.pdf", data: pdf }], { ip });
    await sleep(300);
    say("INFO", "uploads accepted", [u1, u2, u3, u4].map((u) => `${u.status}/${u.body?.parts?.length || 0}`).join(" "));

    const plainNamed = [];
    for (const d of ["uploads", "quote-drawings", "rfq-drawings", "part-payloads"]) for (const f of ls(s, d)) if (!f.endsWith(".enc")) plainNamed.push(`${d}/${f.replace(/^[0-9a-f-]{36}/, "<id>")}`);
    say(plainNamed.length ? "FINDING" : "PASS", "every stored customer file carries the .enc suffix", plainNamed.join(", "));
    const needles = [["DXF text (SECTION/ENTITIES)", Buffer.from("ENTITIES")], ["STEP text", Buffer.from("ISO-10303-21")], ["PDF", Buffer.from("% review drawing")], ["STL header", Buffer.from("review mesh")], ["mesh JSON", Buffer.from("\"positions\":[")], ["DXF outline coordinate 123.457", Buffer.from("123.457")], ["DXF hole centre 61.728", Buffer.from("61.728")], ["customer file name", Buffer.from("SECRET-CUSTOMER-PART")]];
    const hits = grepDir(s.dataDir, needles);
    const inFiles = hits.filter((h) => !h.startsWith("quoting.db"));
    const inDb = hits.filter((h) => h.startsWith("quoting.db"));
    say(inFiles.length ? "FINDING" : "PASS", "no readable customer content in any file under data/ except the database", inFiles.join("; "));
    say(inDb.some((h) => /coordinate|centre/.test(h)) ? "FINDING" : "PASS", "the database holds no part geometry in the clear", inDb.join("; "));

    // The window before encryption: what is on disk while a file is being read.
    const bomb = g.dxfInsertBomb(8, 1, 100, 100);
    s.upload([{ name: "slow.dxf", data: bomb }], { ip: "198.51.100.61", timeoutMs: 5000 }).catch(() => {});
    await sleep(1500);
    const during = ls(s, "uploads").filter((f) => !f.endsWith(".enc"));
    say("INFO", "while a file is being read it sits on the volume unencrypted", `${during.length} plain file(s) in data/uploads for up to the parse time (60 s) plus the wait for a worker (30 s)`);
    process.kill(s.pid, "SIGKILL");
    await sleep(500);
    s = await startServer({ stubs: true, tmpDir: s.tmp, env: { NORD_FILE_ENC_KEY: key } });
    const left = ls(s, "uploads").filter((f) => !f.endsWith(".enc"));
    say(left.length ? "FINDING" : "PASS", "a crash during that window leaves no plain file behind", `${left.length} unencrypted CAD file(s) still in data/uploads after the restart (kept up to 7 days)`);

    // Key change with no previous key configured.
    const partId = u2.body.parts[0].partId, bigDxf = u3.body.parts[0].partId, smallDxf = u1.body.parts[0];
    s = await restart(s, { env: { NORD_FILE_ENC_KEY: key2 } });
    const dl = await s.get(`/api/parts/${partId}/download`, { token: await relog(s, admin), ip: "203.0.113.5" });
    const sess = await s.get(`/api/quote/${q.body.quoteId}/session`, { ip });
    const rmat = (await s.get("/api/materials?process=routing", { ip })).body[0];
    const price = await s.post("/api/quote", { parts: [{ partId: bigDxf, materialSlug: rmat.slug, quantity: 1, process: "routing", thicknessMm: rmat.thicknesses?.[0]?.mm || 6.35 }], leadTimeSlug: "standard" }, { ip });
    const units = await s.post(`/api/parts/${smallDxf.partId}/units`, { units: "in" }, { ip, headers: { "X-Part-Key": smallDxf.editKey } });
    const fresh = await s.upload([{ name: "new.stl", data: g.stlCube() }], { ip });
    const filesBefore = ["uploads", "quote-drawings", "rfq-drawings", "part-payloads"].map((d) => ls(s, d).length).join("/");
    say("INFO", "key replaced without NORD_FILE_ENC_KEY_PREVIOUS", `admin download → ${dl.status} ${dl.body?.code || ""}; reopen quote → ${sess.status}; price a part whose detail is in a file → ${price.status} ${price.body?.code || ""}; change DXF units → ${units.status}; new upload → ${fresh.status}; server alive: ${!s.exited()}`);
    s = await restart(s, { env: { NORD_FILE_ENC_KEY: key2 } });
    const filesAfter = ["uploads", "quote-drawings", "rfq-drawings", "part-payloads"].map((d) => ls(s, d).length).join("/");
    say(filesBefore === filesAfter ? "PASS" : "FINDING", "files the server cannot decrypt are not deleted by the sweeps", `${filesBefore} → ${filesAfter}`);
    s = await restart(s, { env: { NORD_FILE_ENC_KEY: key2, NORD_FILE_ENC_KEY_PREVIOUS: key } });
    const dl2 = await s.get(`/api/parts/${partId}/download`, { token: await relog(s, admin), ip: "203.0.113.5" });
    const price2 = await s.post("/api/quote", { parts: [{ partId: bigDxf, materialSlug: rmat.slug, quantity: 1, process: "routing", thicknessMm: rmat.thicknesses?.[0]?.mm || 6.35 }], leadTimeSlug: "standard" }, { ip });
    say(dl2.status === 200 && dl2.buffer.includes(Buffer.from("ISO-10303-21")) && price2.status === 200 ? "PASS" : "FINDING", "with the old key in NORD_FILE_ENC_KEY_PREVIOUS everything opens again", `download → ${dl2.status}; price → ${price2.status}`);
    // Key removed altogether.
    s = await restart(s, { env: {} });
    const dl3 = await s.get(`/api/parts/${partId}/download`, { token: await relog(s, admin), ip: "203.0.113.5" });
    const fresh2 = await s.upload([{ name: "after-key-removed.stl", data: g.stlCube() }], { ip });
    await sleep(200);
    const plainNow = ls(s, "uploads").filter((f) => !f.endsWith(".enc")).length;
    say("INFO", "key removed", `old file download → ${dl3.status} ${dl3.body?.code || ""}; new upload → ${fresh2.status}, stored plain (${plainNow} plain file(s)); the startup log warns: ${/stored UNENCRYPTED/.test(s.log())}`);
  } finally { await s.stop().catch(() => {}); }
}

/** The run keeps one signing secret across restarts (lib.js), so the admin session from before a restart is still good. */
async function relog(s, token) { return token; }

const cmd = process.argv[2];
({ retention, encryption }[cmd] || (() => { console.error("usage: retention-encryption.js retention|encryption"); process.exit(2); }))().catch((e) => { console.error(e); process.exit(1); });
