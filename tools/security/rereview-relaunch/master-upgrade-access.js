/**
 * The upgrade from origin/master's database: who can use the parts that have no owner? (area 2)
 *
 *   node tools/security/rereview-relaunch/master-upgrade-access.js
 *
 * Starts the real server on the repo's own fixture of a database written by origin/master
 * (server/security/fixtures/master-db-2026-11-11.db.gz: two parts with no owner, two no-account quotes,
 * one account, one request). Then:
 *   - a stranger who knows the part ids (but not a quote id) tries to price, preview and change them
 *   - the visitor who made the old quote comes back to it: are they locked out of their own parts?
 *   - a part that is on no quote: who can use it?
 * and prints what the catalogue upgrade said at start-up.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { report } = require("./lib");
const live = require("../../../server/testSupport/liveServer");
const initSqlJs = require("../../../node_modules/sql.js");

(async () => {
  const R = report();
  const SQL = await initSqlJs();
  const fixture = zlib.gunzipSync(fs.readFileSync(path.join(live.ROOT, "server", "security", "fixtures", "master-db-2026-11-11.db.gz")));
  const db = new SQL.Database(fixture);
  const all = (sql) => { const st = db.prepare(sql); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
  const parts = all("SELECT id, file_name FROM parts");
  const quotes = all("SELECT id, user_id, status, line_items_json, order_total FROM quotes");
  const marker = JSON.parse(all("SELECT rules_json FROM pricing_rules")[0].rules_json).seedVersion;
  db.close();
  console.log(`fixture: ${parts.length} parts (${parts.map((p) => p.file_name).join(", ")}), ${quotes.length} quotes (${quotes.map((q) => `${q.status}${q.user_id ? " owned" : " no-account"}`).join(", ")}), catalogue marker ${marker}`);
  const s = await live.start({ prepare: (dataDir) => fs.writeFileSync(path.join(dataDir, "quoting.db"), fixture) });
  try {
    console.log(s.log().split("\n").filter((l) => /Catalogue|Upgrading catalogs|seed v/.test(l)).map((l) => `  start-up: ${l.trim().slice(0, 200)}`).join("\n") || "  start-up: no catalogue line");
    const stranger = { ip: "198.51.100.200" };
    const acct = await s.register("stranger@example.test", { ip: "198.51.100.201" });
    const mats = (await s.get("/api/materials")).body;
    const q0 = quotes.find((q) => JSON.parse(q.line_items_json).length);
    const li = JSON.parse(q0.line_items_json)[0];
    const lineOf = (partId) => ({ partId, materialSlug: li.meta.materialSlug, grade: li.meta.grade || undefined, process: li.meta.process, subProcess: li.meta.subProcess || undefined, quantity: 1, ...(Number(li.meta.thicknessMm) > 0 ? { thicknessMm: li.meta.thicknessMm } : {}) });
    const denied = (r) => [401, 403, 404].includes(r.status) || (r.status === 400 && r.body && r.body.code === "part-not-found");
    for (const [who, o] of [["a stranger with no account", stranger], ["a stranger with a new account", { ip: "198.51.100.201", token: acct }]]) {
      const tries = [];
      for (const p of parts) {
        for (const key of [undefined, "", "undefined", "null", p.id, "0".repeat(40)]) {
          tries.push(await s.req({ method: "POST", url: "/api/quote", json: { parts: [{ ...lineOf(p.id), ...(key === undefined ? {} : { editKey: key }) }], leadTimeSlug: "standard" }, partKeys: false, ...o }));
          tries.push(await s.req({ url: `/api/parts/${p.id}/mesh`, headers: key ? { "X-Part-Key": key } : {}, ...o }));
          tries.push(await s.req({ url: `/api/parts/${p.id}/geometry${key ? `?key=${encodeURIComponent(key)}` : ""}`, ...o }));
          tries.push(await s.req({ method: "POST", url: `/api/parts/${p.id}/units`, json: { units: "mm", ...(key ? { editKey: key } : {}) }, ...o }));
        }
      }
      R.check(tries.every(denied), `${who}, knowing the part ids: ${tries.length} tries to price, preview, measure or change the old parts`, [...new Set(tries.map((r) => r.status))].join(" "));
    }
    // The visitor who made the old quote comes back by its link.
    const back = { ip: "203.0.113.77" };
    const sess = await s.req({ url: `/api/quote/${q0.id}/session`, ...back });
    const keys = Object.fromEntries(Object.entries((sess.body && sess.body.partsById) || {}).map(([id, p]) => [id, p.editKey]));
    const lines = ((sess.body && sess.body.parts) || []).map((l) => ({ ...l, editKey: keys[l.partId] }));
    const re = await s.req({ method: "POST", url: "/api/quote", json: { quoteId: q0.id, parts: lines.map(({ fileName, ...l }) => l), leadTimeSlug: sess.body.leadTimeSlug || "standard" }, partKeys: false, ...back });
    R.check(sess.status === 200 && Object.keys(keys).length > 0 && re.status === 200, "the visitor who made the old quote opens it by its link, is handed the keys of its parts and can price it again (not locked out)", `session ${sess.status}, keys ${Object.keys(keys).length}, re-price ${re.status} ${re.body && (re.body.code || `$${re.body.orderTotal} (master had $${q0.order_total})`)}`);
    // A part on no quote: take the quotes away (as if the visitor had only uploaded) by using a part id that no quote names.
    const onQuote = new Set(quotes.flatMap((q) => JSON.parse(q.line_items_json).map((l) => l.partId)));
    const loose = parts.filter((p) => !onQuote.has(p.id));
    R.info("parts in the fixture that are on no quote", loose.length ? loose.map((p) => p.file_name).join(", ") : "none: every old part is on a quote, so in this fixture nobody is locked out; a part uploaded on master and never priced would be usable by the admin only (by reading: partAccess.canUse needs the key, and master's browser was never given one)");
    const f = R.done();
    process.exitCode = f ? 1 : 0;
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(2); });
