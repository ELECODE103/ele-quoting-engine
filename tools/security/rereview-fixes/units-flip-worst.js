#!/usr/bin/env node
/**
 * F-13, worst case: what a units change costs everybody else, counted until the work it starts is over.
 *
 *   node tools/security/rereview-fixes/units-flip-worst.js [padMb=0] [holes=40] [flips=6]
 *   node tools/security/rereview-fixes/with-load.js 4 tools/security/rereview-fixes/units-flip-worst.js 12 1600
 *
 * The reviewer's units-flip-hold.js watches the health page until 200 ms after the units answer. The
 * saved quotes are now priced AFTER the answer, so a watch that stops there would miss whatever that
 * work holds. This one keeps watching until the last saved quote has its new price:
 *
 *   - one confirmed account holds as many 100-line drafts of one drawing as the default allowance
 *     takes (512 kB), the drawing with `holes` holes (40 is the reviewer's plate; 1600 is a dense sheet);
 *   - the database is padded to `padMb` first (0: as it comes);
 *   - the units are flipped mm / in / mm …; for each flip, from just before the request until the
 *     server has finished with every draft (it says so in its log on a test server; or 60 s):
 *       the health page is asked for every 20 ms             → the longest wait = the longest hold of the thread
 *       another visitor re-prices a one-line quote every 300 ms → median and worst of what a real customer waits
 *
 * A draft ends either priced again, or marked to be priced when it is next opened (a 1,600-hole sheet
 * read in inches is larger than the router's bed and cannot be priced at all): both are counted.
 *
 * Exit code 1 if a flip fails, the drafts are not all dealt with within 60 s, the other visitor is
 * refused a price, or (quiet machine only) the health page waits 250 ms or more or its median is
 * 250 ms or more.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const c = require("../rereview-availability/common");
const initSqlJs = require("../../../node_modules/sql.js");

const PAD_MB = Number(process.argv[2]) || 0;
const HOLES = Number(process.argv[3]) || 40;
const FLIPS = Number(process.argv[4]) || 6;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

(async () => {
  const SQL = await initSqlJs();
  const env = { QUOTE_NEW_PER_ACCOUNT_HOUR: "1000", QUOTE_NEW_PER_CLIENT_HOUR: "1000", QUOTE_NEW_PER_ACCOUNT_DAY: "1000", QUOTE_NEW_PER_CLIENT_DAY: "1000" };
  let s = await c.startServer({ stubs: true, env });
  const tmp = s.tmp;
  const loaded = os.loadavg()[0] > 2.5;
  let failed = false;
  try {
    const ip = "192.0.2.90";
    const email = "flipper@example.test";
    let token = await s.register(email, { ip });
    const part = await c.uploadOne(s, "plate.dxf", HOLES > 200 ? c.g.dxfManyHoles(HOLES) : c.g.dxfPlate(HOLES), { ip, token, fields: { process: "routing" }, attempts: 6 });
    const { line, mat } = await c.lineFor(s, part.partId, "routing", ip);
    const th = (mat.thicknesses || []).map((t) => t.mm);
    const ids = []; let stoppedBy = "";
    for (let i = 0; i < 60; i++) {
      const q = await s.post("/api/quote", { parts: Array.from({ length: 100 }, (_, k) => ({ ...line, quantity: 1 + ((i + k) % 5), thicknessMm: th[k % th.length] })), leadTimeSlug: "standard" }, { ip, token, timeoutMs: 180000 });
      if (q.status === 200) { ids.push(q.body.quoteId); continue; }
      if ((q.status === 429 || q.status === 503) && q.body && /pricing|busy|turn/.test(String(q.body.code))) { await c.sleep(1500); i--; continue; }
      stoppedBy = `${q.status} ${(q.body && q.body.code) || ""}`; break;
    }
    if (!ids.length) throw new Error(`no draft could be saved: ${stoppedBy}`);
    // The other visitor: a cube of their own, one line.
    const V = "203.0.113.9";
    const vCube = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip: V });
    const vLine = { ...(await c.lineFor(s, vCube.partId, "cnc", V)).line, subProcess: "milling" };

    if (PAD_MB > 0) {
      const keys = s.editKeys, pw = s.passwords;
      await s.stop({ keep: true });
      const file = path.join(tmp, "data", "quoting.db");
      const db = new SQL.Database(fs.readFileSync(file));
      db.run("CREATE TABLE IF NOT EXISTS rr_filler (id INTEGER PRIMARY KEY, body BLOB)");
      const have = db.exec("PRAGMA page_count")[0].values[0][0] * db.exec("PRAGMA page_size")[0].values[0][0];
      const chunk = require("crypto").randomBytes(64 * 1024);
      for (let n = have; n < PAD_MB * c.MB; n += chunk.length) db.run("INSERT INTO rr_filler (body) VALUES (?)", [chunk]);
      fs.writeFileSync(file, Buffer.from(db.export())); db.close();
      s = await c.startServer({ stubs: true, env, tmpDir: tmp });
      s.editKeys = keys; s.passwords = pw;
      token = (await s.post("/api/auth/login", { email, password: pw[email] }, { ip })).body.token;
    }
    c.log(`${ids.length} drafts of 100 lines of a ${HOLES}-hole drawing (stopped by: ${stoppedBy || "the loop"}); database ${(c.dbBytes(s) / c.MB).toFixed(1)} MB; machine ${loaded ? "loaded" : "quiet"}`);
    await c.sleep(2500);

    const doneLines = () => (s.log().match(/\[test\] draft refresh done: [^\n]*/g) || []);
    const rows = [];
    let units = "in";
    for (let f = 0; f < FLIPS; f++) {
      const health = []; const visitor = []; let stop = false;
      const pinger = (async () => { while (!stop) { const t = Date.now(); try { await s.get("/api/health", { ip: "203.0.113.5", timeoutMs: 120000 }); } catch { /* its time counts */ } health.push(Date.now() - t); await c.sleep(20); } })();
      // (Each flip's visitor comes from its own address and re-prices a quote of its own: one saved quote may be re-priced only so many times an hour.)
      const vIp = `203.0.113.${10 + f}`;
      const vq = await s.post("/api/quote", { parts: [vLine], leadTimeSlug: "standard" }, { ip: vIp });
      const other = (async () => { let n = 0; while (!stop) { const t = Date.now(); const r = await s.post("/api/quote", { parts: [{ ...vLine, quantity: 1 + (n++ % 9) }], leadTimeSlug: "standard", quoteId: vq.body.quoteId }, { ip: vIp, timeoutMs: 120000 }).catch(() => ({ status: 0 })); visitor.push({ ms: Date.now() - t, status: r.status, code: r.body && r.body.code }); await c.sleep(300); } })(); // (a visitor may re-price 40 times in 10 s: this one stays under that)
      await c.sleep(600);
      const calm = { health: Math.max(...health), visitor: median(visitor.map((x) => x.ms)) };
      health.length = 0; visitor.length = 0;
      const seen = doneLines().length;
      const t0 = Date.now();
      const r = await s.post(`/api/parts/${part.partId}/units`, { units, editKey: s.editKeys[part.partId] }, { ip, token, timeoutMs: 120000 });
      const ms = Date.now() - t0;
      const healthDuringRequest = health.length ? Math.max(...health) : 0;
      // Watch until the server says it has finished with the drafts (read from its log: no request is made for it).
      let doneMs = null, done = "";
      if (r.status === 200) {
        for (let w = 0; w < 600 && doneMs === null; w++) {
          await c.sleep(100);
          const lines = doneLines();
          if (lines.length > seen) { doneMs = Date.now() - t0; done = lines[lines.length - 1]; }
        }
      }
      await c.sleep(400);
      stop = true; await Promise.all([pinger, other]);
      const m = /priced (\d+) marked (\d+) superseded (\w+)/.exec(done) || [];
      const vms = visitor.map((x) => x.ms);
      const refused = visitor.filter((x) => x.status !== 200);
      const row = {
        flipTo: units, status: r.status, code: (r.body && r.body.code) || undefined, unitsRequestMs: ms, draftsPricedAgain: m[1] === undefined ? null : Number(m[1]), draftsMarkedForLater: m[2] === undefined ? null : Number(m[2]), allDoneAfterMs: doneMs,
        healthWorstCalmMs: calm.health, healthWorstDuringRequestMs: healthDuringRequest, healthWorstUntilDoneMs: Math.max(...health), healthMedianMs: median(health), healthSamples: health.length,
        otherVisitor: { tries: visitor.length, priced: visitor.length - refused.length, refused: refused.length ? [...new Set(refused.map((x) => `${x.status} ${x.code || ""}`.trim()))].join(", ") : undefined, medianMs: median(vms), worstMs: Math.max(...vms), medianCalmMs: calm.visitor },
      };
      rows.push(row); c.log(JSON.stringify(row));
      if (r.status !== 200 || doneMs === null || row.draftsPricedAgain + row.draftsMarkedForLater !== ids.length) failed = true;
      if (refused.length) failed = true;
      if (!loaded && (row.healthWorstUntilDoneMs >= 250 || row.healthMedianMs >= 250)) failed = true;
      if (loaded && row.healthMedianMs >= 250) failed = true;
      units = units === "in" ? "mm" : "in";
    }
    c.result({ test: "units-flip-worst", machine: loaded ? "loaded" : "quiet", databaseMb: Number((c.dbBytes(s) / c.MB).toFixed(1)), holes: HOLES, drafts: ids.length, linesPerDraft: 100, stoppedBy,
      limits: { healthWorstQuietMs: 250, healthMedianMs: 250 }, worstHealthMs: Math.max(...rows.map((x) => x.healthWorstUntilDoneMs)), worstHealthMedianMs: Math.max(...rows.map((x) => x.healthMedianMs)), rows });
    if (failed) console.log("FINDING: a units change failed or left a draft undealt with, the other visitor was refused a price, or the thread was held 250 ms or more (quiet) or the health median was 250 ms or more");
    process.exitCode = failed ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
