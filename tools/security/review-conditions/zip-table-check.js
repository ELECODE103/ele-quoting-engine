// Check the site's ZIP code -> state table (server/services/usAddress.js) against a public ZIP code list.
//
// The list is not kept in this repository. To get it (a data file only; nothing from the package is run):
//   pip download "zipcodes==1.2.0" --no-deps      (PyPI, MIT licence; 42,724 ZIP codes, one state each)
//   unzip the .whl, then: bunzip2 -kc zipcodes/zips.json.bz2 > zips.json
// Run:  node tools/security/review-conditions/zip-table-check.js "$PWD/server/services/usAddress.js" /path/to/zips.json
//
// Result on 2026-11-13 after the 099 row was added: 42,712 agree, 1 unknown (88888, a Postal Service
// "North Pole" code), 11 disagree: two Homeland Security codes in the DC range (20588, 20598), 72643 Lead Hill
// (the list says MO; the town is in Arkansas), and nine Palau / Micronesia / Marshall Islands codes that the
// table reads as Guam (all off the mainland either way, so they go to a firm quote).
// The list gives one state per ZIP code, so it cannot check ZIP codes that cross a state line.
const fs = require("fs");
const ua = require(process.argv[2]);
const rows = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
let n = 0, ok = 0; const unknown = [], wrong = [];
const active = rows.filter(r => r.active !== false);
for (const r of rows) {
  n++;
  const got = ua.statesOfZip(r.zip_code);
  if (!got) { unknown.push(r); continue; }
  if (got.includes(r.state)) ok++; else wrong.push({ zip: r.zip_code, data: r.state, table: got.join("/"), city: r.city, type: r.zip_code_type, active: r.active });
}
console.log("rows", n, "active", active.length, "agree", ok, "table says unknown", unknown.length, "disagree", wrong.length);
const byPrefix = {};
for (const w of wrong) { const k = w.zip.slice(0,3)+" data="+w.data+" table="+w.table; (byPrefix[k] = byPrefix[k] || []).push(w); }
for (const [k, v] of Object.entries(byPrefix)) console.log(k, v.length, v.slice(0,4).map(w => w.zip+" "+w.city+(w.active===false?" (inactive)":"")).join("; "));
const up = {}; for (const u of unknown) { const k = u.zip_code.slice(0,3)+" "+u.state; up[k] = (up[k]||0)+1; }
console.log("UNKNOWN prefixes:", JSON.stringify(up));
// per-prefix: does every prefix in the data map to a single state, and does the table agree with the majority?
const pm = {}; for (const r of rows) { const p = r.zip_code.slice(0,3); pm[p] = pm[p] || {}; pm[p][r.state] = (pm[p][r.state]||0)+1; }
let multi = 0; for (const [p, m] of Object.entries(pm)) if (Object.keys(m).length > 1) { multi++; console.log("prefix", p, JSON.stringify(m)); }
console.log("prefixes in data", Object.keys(pm).length, "with more than one state", multi);
