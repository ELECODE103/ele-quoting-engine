#!/usr/bin/env node
/**
 * Item 11 of the re-review: is the schema migration additive on a database written by master's own
 * code, and does a second start change nothing?
 * A passing result: `additive` true, `secondStartChangedNothing` true, `oldQuoteReadsTheSame` true.
 *
 *   node tools/security/rereview-availability/migration.js
 *
 * Does not trust the committed fixture: master's server is taken from git (`git archive master`,
 * read-only) into a throwaway folder, started there, and used through its own API to make a
 * database (two uploads, three quotes, an account). That file is then opened twice by this branch.
 * master needs the `uuid` package, which this branch dropped; a three-line stand-in is written into
 * the throwaway folder (it calls crypto.randomUUID). Nothing in the repository is touched.
 */
const { execFileSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const initSqlJs = require("sql.js");
const c = require("./common");
const live = c.live;

const ROOT = live.ROOT;

async function dump(file) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(file));
  const q = (sql) => { const st = db.prepare(sql); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
  const tables = q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = { columns: q(`PRAGMA table_info(${t})`).map((r) => r.name), rows: q(`SELECT * FROM ${t} ORDER BY id`) };
  db.close();
  return out;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-rereview-master-"));
  const masterDir = path.join(tmp, "master");
  fs.mkdirSync(masterDir, { recursive: true });
  const head = execFileSync("git", ["rev-parse", "--short", "master"], { cwd: ROOT }).toString().trim();
  const tar = execFileSync("git", ["archive", "master", "server", "shared", "package.json"], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", masterDir], { input: tar });
  fs.mkdirSync(path.join(masterDir, "node_modules", "uuid"), { recursive: true });
  fs.writeFileSync(path.join(masterDir, "node_modules", "uuid", "index.js"), "const { randomUUID } = require('crypto');\nmodule.exports = { v4: () => randomUUID() };\n");
  const dataDir = path.join(masterDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const port = await live.freePort();
  const env = { ...process.env, PORT: String(port), NODE_ENV: "development", USE_SQLITE: "true", QUOTING_DB_PATH: path.join(dataDir, "quoting.db"), JWT_SECRET: crypto.randomBytes(32).toString("hex"), NODE_PATH: path.join(ROOT, "node_modules") };
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "EMAIL_API_KEY", "STRIPE_SECRET_KEY", "NORD_FILE_ENC_KEY"]) delete env[k];
  let out = "";
  const child = spawn(process.execPath, [path.join(masterDir, "server", "index.js")], { cwd: masterDir, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const req = (o) => live.request(port, o);
  let result;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req({ url: "/api/health", timeoutMs: 1000 })).status === 200) break; } catch { /* not yet */ } if (i === 99) throw new Error(`master did not start:\n${out.slice(-1500)}`); await c.sleep(200); }
    const post = (url, json) => { const body = Buffer.from(JSON.stringify(json)); return req({ method: "POST", url, body, headers: { "Content-Type": "application/json", "Content-Length": String(body.length) } }); };
    const upload = (name, data) => { const m = live.multipart({}, [{ name, data }]); return req({ method: "POST", url: "/api/upload", body: m.body, headers: m.headers }); };
    const cube = await upload("cube.stl", fs.readFileSync(path.join(ROOT, "tools", "vet-quotes", "parts", "cube_20mm.stl")));
    const dxf = await upload("plate.dxf", c.g.dxfPlate(40));
    const dense = await upload("dense.stl", require("../../../server/testSupport/zip").solidStl(24));
    const id = (r) => r.body && r.body.parts && r.body.parts[0] && r.body.parts[0].partId;
    const mats = (await req({ url: "/api/materials?process=cnc" })).body || [];
    const line = { partId: id(cube), materialSlug: mats[0] && mats[0].slug, quantity: 3, process: "cnc", subProcess: "milling" };
    const CHOSEN = "11111111-2222-4333-8444-555555555555";
    const q1 = await post("/api/quote", { parts: [line, line, { ...line, quantity: 10 }], quoteId: CHOSEN });
    const q2 = await post("/api/quote", { parts: [{ ...line, partId: id(dense) }] });
    const reg = await post("/api/auth/register", { email: "fixture-buyer@example.test", password: `Aa1-${crypto.randomBytes(9).toString("base64url")}`, name: "Fixture Buyer" });
    await c.sleep(500);
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    const made = { masterCommit: head, uploads: [cube.status, dxf.status, dense.status], quotes: [q1.status, q2.status], quoteUnderAClientChosenId: q1.body && q1.body.quoteId === CHOSEN, register: reg.status };

    // ── This branch, twice, on a copy of that file ──
    const work = path.join(tmp, "branch");
    fs.mkdirSync(path.join(work, "data"), { recursive: true });
    fs.copyFileSync(path.join(dataDir, "quoting.db"), path.join(work, "data", "quoting.db"));
    const d0 = await dump(path.join(work, "data", "quoting.db"));
    let s = await live.start({ tmpDir: work });
    const log1 = s.log();
    const ip = "203.0.113.150";
    const old = await s.get(`/api/quote/${CHOSEN}`, { ip });
    const reprice = await s.post("/api/quote", { parts: [line, line, { ...line, quantity: 10 }] }, { ip });
    const densePrice = await s.post("/api/quote", { parts: [{ ...line, partId: id(dense) }] }, { ip });
    const session = await s.get(`/api/quote/${q2.body.quoteId}/session`, { ip });
    const dp = session.body && session.body.partsById && session.body.partsById[id(dense)];
    const mesh = dp && dp.mesh ? await s.get(dp.mesh.url, { ip, headers: { "X-Part-Key": dp.editKey } }) : { status: 0, body: {} };
    await s.stop({ keep: true });
    const d1 = await dump(path.join(work, "data", "quoting.db"));
    const h1 = crypto.createHash("sha256").update(fs.readFileSync(path.join(work, "data", "quoting.db"))).digest("hex");
    s = await live.start({ tmpDir: work });
    const log2 = s.log();
    await s.stop({ keep: true });
    const d2 = await dump(path.join(work, "data", "quoting.db"));
    const h2 = crypto.createHash("sha256").update(fs.readFileSync(path.join(work, "data", "quoting.db"))).digest("hex");

    // Additive: every table and column master had is still there; rows of the tables a visitor fills are unchanged on master's columns.
    const lostTables = Object.keys(d0).filter((t) => !d1[t]);
    const lostColumns = Object.keys(d0).flatMap((t) => (d1[t] ? d0[t].columns.filter((col) => !d1[t].columns.includes(col)).map((col) => `${t}.${col}`) : []));
    const addedColumns = Object.keys(d1).flatMap((t) => (d0[t] ? d1[t].columns.filter((col) => !d0[t].columns.includes(col)).map((col) => `${t}.${col}`) : []));
    const addedTables = Object.keys(d1).filter((t) => !d0[t]);
    const changed = {};
    for (const t of ["users", "quotes", "parts", "rfqs", "orders", "order_items"]) {
      if (!d0[t] || !d1[t]) continue;
      const byId = new Map(d1[t].rows.map((r) => [r.id, r]));
      const diffs = new Set(); let missing = 0;
      for (const r of d0[t].rows) { const n = byId.get(r.id); if (!n) { missing++; continue; } for (const col of d0[t].columns) if (JSON.stringify(r[col]) !== JSON.stringify(n[col])) diffs.add(col); }
      changed[t] = { rowsBefore: d0[t].rows.length, rowsMissingAfter: missing, columnsWhoseValuesChanged: [...diffs] };
    }
    // The first start: the quotes made in this script under the branch are extra rows (expected), nothing of master's is gone.
    const second = {};
    for (const t of Object.keys(d1)) {
      const a = JSON.stringify(d1[t]); const b = JSON.stringify(d2[t]);
      if (a !== b) second[t] = { rows: [d1[t].rows.length, d2[t].rows.length], columnsDiffer: JSON.stringify(d1[t].columns) !== JSON.stringify(d2[t].columns) };
    }
    result = {
      test: "migration", madeWithMaster: made,
      additive: lostTables.length === 0 && lostColumns.length === 0 && Object.values(changed).every((x) => x.rowsMissingAfter === 0),
      lostTables, lostColumns, addedTables, addedColumns: addedColumns.length, addedColumnsOfThisFixBranch: addedColumns.filter((x) => /last_opened_at|part_count|total_units|client_tag|drawing_bytes|attachment_removed_at/.test(x)),
      masterRowsAfterTheFirstStart: changed,
      firstStartLog: (log1.match(/[^\n]*(no such column|SQLITE_ERROR|Failed to initialize|moving part payloads|Database file:)[^\n]*/gi) || []).slice(0, 6),
      oldQuoteReadsTheSame: old.status === 200 && Math.abs(old.body.orderTotal - q1.body.orderTotal) < 0.01 && old.body.lineItems.length === 3,
      samePartsPriceUnderThisBranch: { status: reprice.status, masterTotal: q1.body.orderTotal, branchTotal: reprice.body && reprice.body.orderTotal, denseStatus: densePrice.status, denseMaster: q2.body.orderTotal, denseBranch: densePrice.body && densePrice.body.orderTotal },
      densePartPreviewAfterTheMove: { status: mesh.status, triangles: mesh.body && mesh.body.triangleCount },
      secondStartChangedNothing: Object.keys(second).length === 0, tablesTheSecondStartChanged: second, databaseFileIdenticalAfterSecondStart: h1 === h2,
      secondStartLogErrors: (log2.match(/[^\n]*(no such column|SQLITE_ERROR|Failed to initialize)[^\n]*/gi) || []),
    };
  } finally {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  c.result(result);
})().catch((e) => { console.error(e); process.exit(1); });
