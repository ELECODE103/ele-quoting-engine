#!/usr/bin/env node
/** Turn parser-abuse.js --out files into the Markdown table used in the review report. */
const fs = require("fs");
const rows = [];
for (const f of process.argv.slice(2)) for (const l of fs.readFileSync(f, "utf8").split("\n")) if (l.startsWith("{")) rows.push(JSON.parse(l));
const seen = new Set();
const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} kB` : `${b} B`);
const money = (p) => (p && typeof p === "object" && p.unit !== undefined ? `$${Number(p.unit).toPrecision(6).replace(/\.?0+$/, "")}${p.rfq ? " (to a person)" : " (checkout open)"}` : p && p.status ? `refused ${p.status}` : "");
const outcome = (r) => ({ parsed: "accepted", "parse-timeout": "stopped at the time limit", "parse-memory": "stopped: memory", "content-mismatch": "refused: content check", "model-too-large": "refused: too large", "file-damaged": "refused: damaged", refused: "refused" }[r.outcome] || r.outcome);
console.log("| Input | Size | Outcome | Seconds | Peak memory, MB (added) | Worst health check, ms | Price if accepted |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) {
  if (seen.has(r.label)) continue; seen.add(r.label);
  const price = r.price ? Object.entries(r.price).map(([k, v]) => `${k} ${money(v)}`).join("; ") : "";
  console.log(`| ${r.label} | ${size(r.bytes)} | ${outcome(r)} | ${r.seconds} | ${r.peakRssMb} (+${r.addedMb}) | ${r.healthWorstMs} | ${price} |`);
}
const bad = rows.filter((r) => r.leftInUploads > 0 || r.threadsAfter > 0 && r.outcome !== "parsed" || !/^ok/.test(r.cubeAfter || "") || r.crashed);
console.error(`${rows.length} rows; left files / stuck threads / failed follow-up / crash: ${bad.length}`);
