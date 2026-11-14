/**
 * The admin System routes and the full backup, on the real server in
 * production mode:
 *
 *   - who may call them (nobody but an enrolled admin)
 *   - what the status report shows after real traffic
 *   - the restore drill: make orders, quotes and encrypted files; download the
 *     full backup; wipe the data folder; restore; start; and check that the
 *     admin can sign in and that the order, the quote, the 3D preview, the CAD
 *     file and the request's attachment are all there and all open.
 *
 * Run: node server/ops/system.test.js
 */
const assert = require("assert");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { runner } = require("../testSupport/harness");
const live = require("../testSupport/liveServer");
const totp = require("../security/totp");
const archive = require("./backupArchive");

const { test, run } = runner("System routes and full backup");
const ROOT = path.join(__dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROUTES = [
  ["GET", "/api/admin/system/status"],
  ["GET", "/api/admin/system/digest/preview"],
  ["POST", "/api/admin/system/digest"],
  ["POST", "/api/admin/system/email-test"],
  ["GET", "/api/admin/backup/full"],
];

/** Names and sizes of the entries in a .tar.gz buffer. */
function tarList(gz) {
  const tar = zlib.gunzipSync(gz);
  const out = [];
  for (let o = 0; o + 512 <= tar.length;) {
    const h = tar.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(h.subarray(124, 136).toString("ascii").replace(/[\0 ]/g, "") || "0", 8);
    out.push({ name, size, type: String.fromCharCode(h[156]), data: tar.subarray(o + 512, o + 512 + size) });
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return { entries: out, tar };
}

test("the System routes and the full backup answer only an enrolled admin", async () => {
  const s = await live.start();
  try {
    // The owner's account before two-step sign-in is switched on, then a customer, then nobody.
    const unenrolled = await s.admin({ enrol: false });
    const buyer = await s.register("buyer@oem.test");
    for (const [method, url] of ROUTES) {
      const guest = await s.req({ method, url, json: method === "POST" ? {} : undefined });
      assert.strictEqual(guest.status, 401, `${method} ${url} as a guest`);
      const cust = await s.req({ method, url, token: buyer, json: method === "POST" ? {} : undefined });
      assert.strictEqual(cust.status, 403, `${method} ${url} as a customer`);
      assert.ok(!/build|protections|startedAt/.test(cust.text), "no system detail in a refusal");
      const half = await s.req({ method, url, token: unenrolled, json: method === "POST" ? {} : undefined });
      assert.strictEqual(half.status, 403, `${method} ${url} as an admin who has not enrolled`);
      assert.strictEqual(half.body.code, "two-factor-enrolment-required");
      // The customer's cookie, with and without the CSRF token: still refused.
      const withCsrf = await s.req({ method, url, headers: await s.browser(buyer), json: method === "POST" ? {} : undefined });
      assert.strictEqual(withCsrf.status, 403);
    }
    const admin = await s.enrol(unenrolled);
    // The admin's own cookie without the CSRF token cannot send anything.
    for (const [method, url] of ROUTES.filter((r) => r[0] === "POST")) {
      const noCsrf = await s.req({ method, url, headers: await s.browser(admin, { csrf: false }), json: {} });
      assert.strictEqual(noCsrf.status, 403, `${method} ${url} by cookie without the CSRF token`);
      assert.strictEqual(noCsrf.body.code, "csrf");
    }
    const ok = await s.get("/api/admin/system/status", { headers: await s.browser(admin) });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers["cache-control"], "no-store");
    assert.strictEqual((await s.get("/api/admin/system/status", { token: admin })).status, 200);
  } finally { await s.stop(); }
});

test("status over HTTP: what is off, what happened since the start, and no secret; the digest and the email test say why nothing was sent", async () => {
  const marker = `whsec_${crypto.randomBytes(18).toString("hex")}`;
  const s = await live.start({ env: { STRIPE_WEBHOOK_SECRET: marker, RAILWAY_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567", CANONICAL_HOST: "straightedgemfg.com", REDIRECT_HOSTS: "nordmfg.com" } });
  try {
    const admin = await s.admin();
    // Three webhook deliveries with a wrong signature, and one wrong-password sign-in.
    for (let i = 0; i < 3; i++) {
      const r = await s.req({ method: "POST", url: "/api/stripe/webhook", headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=00" }, body: Buffer.from("{}") });
      assert.strictEqual(r.status, 400);
    }
    await sleep(100);
    const r = await s.get("/api/admin/system/status", { token: admin });
    assert.strictEqual(r.status, 200);
    const b = r.body;
    assert.strictEqual(b.build.commit, "0123456789ab");
    assert.strictEqual(b.build.environment, "production");
    assert.ok(b.uptimeSeconds >= 0 && b.uptimeSeconds < 120);
    assert.strictEqual(b.hosts.canonical, "straightedgemfg.com");
    assert.deepStrictEqual(b.hosts.redirects, ["nordmfg.com"]);
    const prot = Object.fromEntries(b.protections.map((p) => [p.key, p.on]));
    // This server was started as a test: the report must say so, as it would on a misconfigured live site.
    assert.deepStrictEqual({ bot: prot["bot-check"], enc: prot["file-encryption"], hooks: prot["test-hooks-off"], mail: prot.mailer, jwt: prot["jwt-secret"], hook: prot["stripe-webhook-secret"] }, { bot: false, enc: false, hooks: false, mail: false, jwt: true, hook: true });
    assert.strictEqual(b.events.totals.webhookRejected, 3);
    assert.ok(b.events.totals.mailNotConfigured >= 1, "the confirmation emails that could not be sent are counted");
    assert.ok(b.events.recent.some((e) => e.kind === "webhookRejected"));
    assert.ok(b.storage.files.maxBytes > 0 && b.storage.database.usedBytes > 0);
    assert.ok(b.previousRun === null && b.digest.mailerConfigured === false);
    // The startup alert is in the log (and would have been emailed with a mailer).
    assert.ok(/ALERT \[startup-protections:[0-9a-f]{10}\] The site started with \d protections switched off/.test(s.log()), s.log().split("\n").filter((l) => /ALERT/.test(l)).join("\n"));
    // No secret, no address.
    assert.ok(!r.text.includes(marker) && !r.text.includes("owner@shop.test") && !/sk_test_/.test(r.text));

    // The five-minute check would raise the webhook alert now.
    const preview = await s.get("/api/admin/system/digest/preview", { token: admin });
    assert.strictEqual(preview.status, 200);
    assert.ok(/daily digest/.test(preview.body.subject) && /bad signature/.test(preview.body.text) && /: 0 \/ 3 \/ 0/.test(preview.body.text), preview.body.text);
    const send = await s.post("/api/admin/system/digest", {}, { token: admin });
    assert.deepStrictEqual(send.body, { sent: false, reason: "mailer-not-configured" });
    const mail = await s.post("/api/admin/system/email-test", {}, { token: admin });
    assert.strictEqual(mail.status, 200);
    assert.strictEqual(mail.body.configured, false);
    assert.strictEqual(mail.body.sent, false);
    assert.ok(mail.body.lines.some((l) => l.level === "fail" && /EMAIL_API_KEY is not set/.test(l.text)));
    assert.ok(mail.body.lines.some((l) => l.level === "fail" && /EMAIL_FROM is not set/.test(l.text)));
    assert.ok(!JSON.stringify(mail.body).includes("owner@shop.test"), "addresses are masked");
    assert.strictEqual(s.mail(null, /email check|daily digest|alert/i).length, 0, "nothing went to the outbox");
  } finally { await s.stop(); }
});

test("restore drill: full backup → wipe → restore → start → the order, the quote, the preview and the files are all back", async () => {
  // The two secrets that must be the same before and after: made here, for this run only.
  const env = { JWT_SECRET: crypto.randomBytes(32).toString("hex"), NORD_FILE_ENC_KEY: crypto.randomBytes(36).toString("base64") };
  const SHIP = { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Elgin", shippingState: "IL", shippingZip: "60120" };
  const stl = fs.readFileSync(path.join(ROOT, "tools", "vet-quotes", "parts", "gear_disc.stl"));
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n% drawing for the restore drill\n"), crypto.randomBytes(2048), Buffer.from("\n%%EOF\n")]);

  let s = await live.start({ env });
  let s2 = null;
  const tmp = s.tmp;
  try {
    // ── make something worth restoring ──
    const admin = await s.admin();
    const buyer = await s.register("buyer@oem.test");
    const up = await s.upload([{ name: "gear_disc.stl", data: stl }], { token: buyer });
    assert.strictEqual(up.status, 200, up.text);
    const part = up.body.parts[0];
    // (relaunch merge 2) A preview that lives in a file is no longer inside the upload answer: the answer says where it
    // is and the browser fetches it (routes/partPayloadRoutes.js). The drill follows the browser.
    assert.ok(part.mesh && part.mesh.url, "the upload answer says where the 3D preview is");
    const previewBefore = await s.get(part.mesh.url, { token: buyer });
    assert.ok(previewBefore.status === 200 && previewBefore.body.positions.length > 1000, "and the preview is there");
    const mats = await s.get("/api/materials?process=cnc");
    const mat = mats.body[0];
    const quote = await s.post("/api/quote", { parts: [{ partId: part.partId, materialSlug: mat.slug, quantity: 250, process: "cnc", subProcess: "milling" }] }, { token: buyer });
    assert.strictEqual(quote.status, 200, quote.text);
    const quoteId = quote.body.quoteId;
    const rfq = await s.rfq({ quoteId, contactName: "Dana Buyer", email: "buyer@oem.test", company: "OEM Co", quantities: "250 / 1000", ...SHIP }, [{ name: "drawing.pdf", data: pdf, type: "application/pdf" }], { token: buyer });
    assert.strictEqual(rfq.status, 201, rfq.text);
    const quoted = await s.req({ method: "PUT", url: `/api/rfq/admin/${rfq.body.rfqId}`, token: admin, json: { status: "quoted", quotedTotal: 4250, quotedLeadDays: 15, quoteNote: "Covers 1,000 pcs." } });
    assert.strictEqual(quoted.status, 200, quoted.text);
    const linkMail = s.mail("buyer@oem.test", /firm quote/i).pop();
    const linkToken = (linkMail.text.match(/\/firm-quote\/(\S+)/) || [])[1];
    const accepted = await s.post(`/api/rfq/quote/${linkToken}/accept`, { method: "po", poNumber: "PO-77812", ...SHIP });
    assert.strictEqual(accepted.status, 201, accepted.text);
    const ordersBefore = (await s.get("/api/orders", { token: admin })).body;
    assert.strictEqual(ordersBefore.length, 1);
    const orderId = ordersBefore[0].id;
    const sessionBefore = (await s.get(`/api/quote/${quoteId}/session`, { token: buyer })).body;
    const cadBefore = await s.get(`/api/parts/${part.partId}/download`, { token: admin });
    assert.ok(cadBefore.buffer.equals(stl), "the CAD file opens before the backup");
    const drawingBefore = await s.get(`/api/rfq/admin/${rfq.body.rfqId}/drawing`, { token: admin });
    assert.ok(drawingBefore.buffer.equals(pdf));
    // On disk everything a customer sent is encrypted.
    for (const folder of ["uploads", "rfq-drawings", "part-payloads"]) {
      assert.ok(s.files(folder).length >= 1 && s.files(folder).every((f) => f.endsWith(".enc")), `${folder}: ${s.files(folder)}`);
    }

    // ── the backup ──
    const dl = await s.get("/api/admin/backup/full", { token: admin });
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(dl.headers["content-type"], "application/gzip");
    assert.ok(/^attachment; filename="straightedge-full-backup-[\dT-]+\.tar\.gz"$/.test(dl.headers["content-disposition"]), dl.headers["content-disposition"]);
    assert.strictEqual(dl.headers["cache-control"], "no-store");
    const backupFile = path.join(tmp, "full-backup.tar.gz");
    fs.writeFileSync(backupFile, dl.buffer);
    const { entries, tar } = tarList(dl.buffer);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("quoting.db") && names[names.length - 1] === "MANIFEST.json", names.join(", "));
    for (const folder of ["uploads", "rfq-drawings", "part-payloads"]) assert.ok(names.some((n) => n.startsWith(`${folder}/`) && n.endsWith(".enc")), `${folder} is in the archive, encrypted`);
    assert.ok(entries.every((e) => e.type === "0"), "plain files only");
    assert.ok(names.every((n) => /^(quoting\.db|MANIFEST\.json|(uploads|quote-drawings|rfq-drawings|part-payloads)\/[\w.-]+)$/.test(n)), "nothing outside the data folders");
    const manifest = JSON.parse(entries[entries.length - 1].data.toString("utf8"));
    assert.strictEqual(manifest.format, archive.FORMAT);
    assert.ok(/^on:/.test(manifest.fileEncryption));
    assert.strictEqual(manifest.files.length, entries.length - 1);
    for (const f of manifest.files) {
      const e = entries.find((x) => x.name === f.path);
      assert.strictEqual(crypto.createHash("sha256").update(e.data).digest("hex"), f.sha256, f.path);
    }
    // No secret is in the archive, and what was encrypted on the volume is still encrypted in it.
    for (const secret of [env.JWT_SECRET, env.NORD_FILE_ENC_KEY]) assert.ok(!tar.includes(Buffer.from(secret)), "no key in the archive");
    assert.ok(!tar.includes(Buffer.from("sk_test_")) && !tar.includes(Buffer.from("JWT_SECRET")) && !tar.includes(Buffer.from("STRIPE_SECRET_KEY")));
    assert.ok(!tar.includes(stl.subarray(84, 84 + 200)), "the CAD file's bytes are not readable in the archive");
    assert.ok(!tar.includes(pdf.subarray(40, 40 + 200)), "the drawing's bytes are not readable in the archive");
    for (let i = 0; i < 40 && !/Full backup downloaded by an admin/.test(s.log()); i++) await sleep(50); // the line is written as the stream closes
    assert.ok(/Full backup downloaded by an admin: \d+ files/.test(s.log()));
    // A second one straight away is fine (one at a time, twelve an hour).
    assert.strictEqual((await s.get("/api/admin/backup/full", { token: admin })).status, 200);

    // ── wipe ──
    const passwords = s.passwords; const adminSecret = s.adminSecret; const adminEmail = s.adminEmail;
    await s.stop({ keep: true });
    s = null;
    const dataDir = path.join(tmp, "data");
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir);
    assert.deepStrictEqual(fs.readdirSync(dataDir), [], "the volume is empty");

    // ── restore, with the documented command ──
    const restore = spawnSync(process.execPath, [path.join(ROOT, "scripts", "ops", "restore.js"), backupFile, "--to", dataDir], { encoding: "utf8" });
    assert.strictEqual(restore.status, 0, restore.stdout + restore.stderr);
    assert.ok(/Restored \d+ files/.test(restore.stdout), restore.stdout);
    assert.ok(fs.existsSync(path.join(dataDir, "quoting.db")) && fs.readdirSync(path.join(dataDir, "uploads")).length >= 1);
    assert.ok(!fs.readdirSync(dataDir).some((n) => n.startsWith(".restore-")), "the staging folder is gone");
    // Running it again on the restored folder is refused: it would overwrite live data.
    const again = spawnSync(process.execPath, [path.join(ROOT, "scripts", "ops", "restore.js"), backupFile, "--to", dataDir], { encoding: "utf8" });
    assert.strictEqual(again.status, 1);
    assert.ok(/already holds/.test(again.stderr) && /Nothing was changed/.test(again.stderr), again.stderr);

    // ── start on the restored data, same secrets ──
    s2 = await live.start({ env, tmpDir: tmp });
    assert.ok(!/error|FATAL/i.test(s2.log().replace(/WARNING[^\n]*/g, "").replace(/errors? /g, "")), s2.log());
    const login = await s2.post("/api/auth/login", { email: adminEmail, password: passwords[adminEmail], totp: totp.codeAt(adminSecret, Date.now() + 30000) });
    assert.strictEqual(login.status, 200, `the owner signs in with the same password and authenticator: ${login.text}`);
    const admin2 = login.body.token;
    const buyerLogin = await s2.post("/api/auth/login", { email: "buyer@oem.test", password: passwords["buyer@oem.test"] });
    assert.strictEqual(buyerLogin.status, 200, buyerLogin.text);
    const buyer2 = buyerLogin.body.token;

    // Orders.
    const ordersAfter = (await s2.get("/api/orders", { token: admin2 })).body;
    assert.strictEqual(ordersAfter.length, 1);
    assert.strictEqual(ordersAfter[0].id, orderId);
    assert.strictEqual(ordersAfter[0].total, 4250);
    assert.strictEqual(ordersAfter[0].poNumber, "PO-77812");
    assert.strictEqual(ordersAfter[0].status, ordersBefore[0].status);
    const one = await s2.get(`/api/orders/${orderId}`, { token: admin2 });
    assert.strictEqual(one.status, 200);
    // Quotes, with the 3D preview read back from its (encrypted) file.
    const sessionAfter = await s2.get(`/api/quote/${quoteId}/session`, { token: buyer2 });
    assert.strictEqual(sessionAfter.status, 200, sessionAfter.text);
    assert.deepStrictEqual(sessionAfter.body.partsById[part.partId].mesh, sessionBefore.partsById[part.partId].mesh, "the reopened quote names the same preview");
    const previewAfter = await s2.get(sessionAfter.body.partsById[part.partId].mesh.url, { token: buyer2 });
    assert.strictEqual(previewAfter.status, 200, previewAfter.text && previewAfter.text.slice(0, 200));
    assert.deepStrictEqual(previewAfter.body.positions, previewBefore.body.positions, "the preview is the same vertices");
    const requote = await s2.post("/api/quote", { parts: [{ partId: part.partId, materialSlug: mat.slug, quantity: 250, process: "cnc", subProcess: "milling" }] }, { token: buyer2 });
    assert.strictEqual(requote.status, 200, requote.text);
    assert.strictEqual(requote.body.orderTotal, quote.body.orderTotal, "the part prices exactly as before");
    // The request, the firm-quote link the buyer was emailed, and the files.
    const rfqs = (await s2.get("/api/rfq/admin/list", { token: admin2 })).body;
    assert.ok(rfqs.some((r) => r.id === rfq.body.rfqId && r.status === "accepted"));
    assert.strictEqual((await s2.get(`/api/rfq/quote/${linkToken}`)).status, 200, "the link in the buyer's inbox still opens");
    const cadAfter = await s2.get(`/api/parts/${part.partId}/download`, { token: admin2 });
    assert.ok(cadAfter.status === 200 && cadAfter.buffer.equals(stl), "the CAD file decrypts to the same bytes");
    const drawingAfter = await s2.get(`/api/rfq/admin/${rfq.body.rfqId}/drawing`, { token: admin2 });
    assert.ok(drawingAfter.status === 200 && drawingAfter.buffer.equals(pdf), "the drawing decrypts to the same bytes");
    const stats = await s2.get("/api/admin/system/status", { token: admin2 });
    assert.strictEqual(stats.body.business.orders.total, 1);
  } finally {
    if (s) await s.stop();
    if (s2) await s2.stop(); else fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("restore refuses what it did not write: traversal, links, unknown folders, a damaged file, a cut-off download; --force moves the old data aside", async () => {
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "se-restore-"));
  try {
    // A small, real backup to start from.
    const data = path.join(dir, "data");
    fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
    fs.mkdirSync(path.join(data, "part-payloads"), { recursive: true });
    fs.writeFileSync(path.join(data, "quoting.db"), Buffer.concat([Buffer.from("SQLite format 3\0"), crypto.randomBytes(5000)]));
    fs.writeFileSync(path.join(data, "uploads", "11111111-2222-3333-4444-555555555555.stl.enc"), crypto.randomBytes(70000));
    fs.writeFileSync(path.join(data, "part-payloads", "aaaa.mesh.json"), "{\"v\":[1,2,3]}");
    fs.writeFileSync(path.join(data, "uploads", "half-written.tmp"), "x");          // never backed up
    fs.symlinkSync("/etc/passwd", path.join(data, "uploads", "link.stl"));           // never followed
    fs.writeFileSync(path.join(data, ".env"), "JWT_SECRET=should-never-be-read");   // not a data folder
    fs.mkdirSync(path.join(data, "outbox")); fs.writeFileSync(path.join(data, "outbox", "mail.json"), "{}");
    const good = path.join(dir, "good.tar.gz");
    const report = await archive.write(fs.createWriteStream(good), { dataDir: data, dbPath: path.join(data, "quoting.db") });
    assert.strictEqual(report.files, 3);
    const { entries } = tarList(fs.readFileSync(good));
    assert.deepStrictEqual(entries.map((e) => e.name), ["quoting.db", "uploads/11111111-2222-3333-4444-555555555555.stl.enc", "part-payloads/aaaa.mesh.json", "MANIFEST.json"]);

    // Round trip.
    const out = path.join(dir, "out");
    const r = await archive.extract(good, out);
    assert.strictEqual(r.files, 3);
    for (const f of ["quoting.db", "uploads/11111111-2222-3333-4444-555555555555.stl.enc", "part-payloads/aaaa.mesh.json"]) {
      assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(data, f))), f);
    }
    // Into a folder that already has data: refused; with force, the old data is kept beside it.
    await assert.rejects(archive.extract(good, out), /already holds/);
    fs.writeFileSync(path.join(out, "quoting.db"), "the previous database");
    const forced = await archive.extract(good, out, { force: true });
    assert.ok(forced.movedAside && fs.readFileSync(path.join(forced.movedAside, "quoting.db"), "utf8") === "the previous database");
    assert.ok(fs.readFileSync(path.join(out, "quoting.db")).subarray(0, 15).toString() === "SQLite format 3");

    // Hand-made hostile archives.
    const tarHeader = (name, size, type = "0") => {
      const b = Buffer.alloc(512);
      b.write(name, 0, 100, "utf8"); b.write("0000600\0", 100); b.write("0000000\0", 108); b.write("0000000\0", 116);
      b.write(size.toString(8).padStart(11, "0") + "\0", 124); b.write("00000000000\0", 136); b.write("        ", 148); b.write(type, 156); b.write("ustar\0", 257); b.write("00", 263);
      let sum = 0; for (const x of b) sum += x;
      b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      return b;
    };
    const tgz = (pieces) => zlib.gzipSync(Buffer.concat([...pieces, Buffer.alloc(1024)]));
    const file = (name, body, type) => { const d = Buffer.from(body); return [tarHeader(name, d.length, type), d, Buffer.alloc((512 - (d.length % 512)) % 512)]; };
    const manifestFor = (files) => file("MANIFEST.json", JSON.stringify({ format: archive.FORMAT, createdAt: new Date().toISOString(), files: files.map(([p, body]) => ({ path: p, size: Buffer.byteLength(body), sha256: crypto.createHash("sha256").update(body).digest("hex") })) }));
    const hostile = {
      "a path that climbs out": [...file("../../etc/cron.d/evil", "x"), ...manifestFor([])],
      "an absolute path": [...file("/etc/passwd", "x"), ...manifestFor([])],
      "a folder this tool does not write": [...file("server/index.js", "x"), ...manifestFor([])],
      "a nested path": [...file("uploads/../../x", "x"), ...manifestFor([])],
      "a hidden file": [...file("uploads/.htaccess", "x"), ...manifestFor([])],
      "a symbolic link": [tarHeader("uploads/link", 0, "2"), ...manifestFor([])],
      "a directory entry": [tarHeader("uploads/", 0, "5"), ...manifestFor([])],
      "a file the manifest does not list": [...file("uploads/extra.stl", "x"), ...manifestFor([])],
      "a file that does not match its checksum": [...file("uploads/a.stl", "tampered"), ...manifestFor([["uploads/a.stl", "original"]])],
      "a file the manifest lists but the archive lacks": [...manifestFor([["uploads/a.stl", "original"]])],
      "the same path twice": [...file("uploads/a.stl", "one"), ...file("uploads/a.stl", "two"), ...manifestFor([["uploads/a.stl", "one"]])],
      "no manifest": [...file("uploads/a.stl", "x")],
    };
    for (const [label, pieces] of Object.entries(hostile)) {
      const bad = path.join(dir, "bad.tar.gz");
      fs.writeFileSync(bad, tgz(pieces));
      const target = path.join(dir, `t-${crypto.randomBytes(4).toString("hex")}`);
      await assert.rejects(archive.extract(bad, target), (err) => /refused|missing|checksum|manifest|twice/.test(err.message), label);
      assert.deepStrictEqual(fs.readdirSync(target), [], `${label}: nothing is left in the target`);
    }
    assert.ok(!fs.existsSync(path.join(dir, "etc")) && !fs.existsSync("/etc/cron.d/evil"));
    // A download that was cut off part-way.
    const cut = path.join(dir, "cut.tar.gz");
    const whole = zlib.gunzipSync(fs.readFileSync(good));
    fs.writeFileSync(cut, zlib.gzipSync(whole.subarray(0, 512 + 3000)));
    const t = path.join(dir, "t-cut");
    await assert.rejects(archive.extract(cut, t), /cut short|manifest/);
    assert.deepStrictEqual(fs.readdirSync(t), []);
    // Not an archive at all.
    fs.writeFileSync(cut, "this is not a backup");
    await assert.rejects(archive.extract(cut, path.join(dir, "t-junk")));

    // The size bound.
    const keep = process.env.BACKUP_MAX_MB;
    process.env.BACKUP_MAX_MB = "1";
    assert.strictEqual(archive.maxBytes(), 1024 * 1024);
    process.env.BACKUP_MAX_MB = "nonsense";
    assert.strictEqual(archive.maxBytes(), 4096 * 1024 * 1024);
    if (keep === undefined) delete process.env.BACKUP_MAX_MB; else process.env.BACKUP_MAX_MB = keep;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a data folder larger than the bound is refused before anything is sent, with where to go instead", async () => {
  const s = await live.start({ env: { BACKUP_MAX_MB: "1" }, prepare: (dataDir) => { fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true }); fs.writeFileSync(path.join(dataDir, "uploads", "big.stl"), Buffer.alloc(2 * 1024 * 1024)); } });
  try {
    const admin = await s.admin();
    const r = await s.get("/api/admin/backup/full", { token: admin });
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.body.code, "backup-too-large");
    assert.ok(/Railway volume backup/.test(r.body.error));
  } finally { await s.stop(); }
});

run();
