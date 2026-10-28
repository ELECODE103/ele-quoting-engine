#!/usr/bin/env node
/**
 * run_vetting.js — drive the live quoting API with the reference part library
 * and grade the answers.
 *
 * Starts nothing. Expects the server to be running (default http://localhost:3010)
 * and tools/vet-quotes/parts/manifest.json to exist (python3 generate_parts.py).
 *
 * For every part × configuration × quantity it POSTs /api/upload (once per part)
 * and /api/quote, records price, time and gate data, then runs the sanity checks
 * listed in docs/quote-vetting-process.md and writes:
 *   tools/vet-quotes/results.csv   — one row per quote (machine-readable)
 *   tools/vet-quotes/results.md    — per-part tables, sanity-check report, benchmark table
 *   tools/vet-quotes/results.json  — everything, for ad-hoc analysis
 *
 * Usage:
 *   node tools/vet-quotes/run_vetting.js [--base http://localhost:3010] [--parts <dir>] [--out <dir>]
 *                                        [--only plate_hole_pattern,bushing] [--qtys 1,10,25,100,250]
 *
 * Localhost note: when HTTPS_PROXY/HTTP_PROXY are set in the environment, Node's
 * fetch may try to route localhost through the proxy. Run with
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost node tools/vet-quotes/run_vetting.js
 *
 * Rate limit note: the server allows 200 API calls / 15 min per client IP (50
 * uploads). In production mode it trusts one proxy hop, so this harness sends a
 * fresh X-Forwarded-For per request to stay under the limit. That only works
 * against a local test server — never point this at production.
 */
const fs = require("fs");
const path = require("path");

// ─── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const BASE_URL = arg("base", process.env.BASE_URL || "http://localhost:3010").replace(/\/$/, "");
const HERE = __dirname;
const PARTS_DIR = arg("parts", path.join(HERE, "parts"));
const OUT_DIR = arg("out", HERE);
const ONLY = arg("only", "").split(",").map((s) => s.trim()).filter(Boolean);
const QTYS_OVERRIDE = arg("qtys", "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);

// Sanity-check thresholds (documented in docs/quote-vetting-process.md)
const RED_FLAG_MACHINE_HOURS = 4;        // hand-sized part machined > 4 h
const RED_FLAG_PRINT_HOURS = 12;         // hand-sized part printed > 12 h
const EXPECTED_RATIO_LOW = 0.5;          // engine < 50 % of the shop estimate midpoint
const EXPECTED_RATIO_HIGH = 2.0;         // engine > 200 % of the shop estimate midpoint
const PRICE_PER_CM3_OUTLIER_FACTOR = 4;  // ×/÷ the process median at qty 10
const SHEET_PART_MAX_THICKNESS_MM = 25.4;
const MIN_PRICE = { cnc: 5.0, routing: 6.0, fdm: 8.0, sla: 12.0, sls: 15.0 };

// ─── http helpers ────────────────────────────────────────────────────────────
let reqCounter = 0;
function fakeIp() {
  reqCounter += 1;
  const n = 1000 + Math.floor(reqCounter / 150); // new "client" every 150 calls
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}
async function api(method, route, { json, form } = {}) {
  const headers = { "X-Forwarded-For": fakeIp() };
  let body;
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE_URL}${route}`, { method, headers, body });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 500)); continue; }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text.slice(0, 300)}`);
    return data;
  }
  throw new Error(`${method} ${route}: rate-limited after retries`);
}

async function uploadPart(file) {
  const buf = fs.readFileSync(file);
  const form = new FormData();
  form.append("files", new Blob([buf], { type: "application/octet-stream" }), path.basename(file));
  const data = await api("POST", "/api/upload", { form });
  if (!data.parts || !data.parts[0]) throw new Error(`upload ${path.basename(file)} returned no part: ${JSON.stringify(data.errors || data).slice(0, 300)}`);
  return data.parts[0];
}

// ─── helpers ─────────────────────────────────────────────────────────────────
const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : "");
const money = (v) => (Number.isFinite(v) ? `$${v.toFixed(2)}` : "");
function materialKey(slug) {
  return String(slug || "").replace(/^(cnc|rt|fdm|sla|sls)-/, "").split("-")[0];
}
function expectedFor(part, cfg) {
  const ex = part.expected || {};
  const keys = [`${cfg.process}-${materialKey(cfg.materialSlug)}`, cfg.process];
  for (const k of keys) if (ex[k]) return ex[k];
  return null;
}
function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function md(v) {
  return String(v == null ? "" : v).replace(/\|/g, "\\|");
}
function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, "manifest.json"), "utf8"));
  const QTYS = QTYS_OVERRIDE.length ? QTYS_OVERRIDE : manifest.quantities;
  const parts = manifest.parts.filter((p) => !ONLY.length || ONLY.includes(p.id));
  const benchmarks = fs.existsSync(path.join(HERE, "benchmarks.json"))
    ? JSON.parse(fs.readFileSync(path.join(HERE, "benchmarks.json"), "utf8"))
    : { entries: [] };

  const materials = await api("GET", "/api/materials");
  const finishes = await api("GET", "/api/finishes");
  const matBySlug = Object.fromEntries(materials.map((m) => [m.slug, m]));
  const finishBySlug = Object.fromEntries(finishes.map((f) => [f.slug, f]));
  console.log(`Server ${BASE_URL}: ${materials.length} materials, ${finishes.length} finishes. ${parts.length} parts × qty ${QTYS.join("/")}`);

  const rows = [];
  const partResults = [];
  for (const part of parts) {
    const file = path.join(PARTS_DIR, part.file);
    process.stdout.write(`  ${part.id.padEnd(24)} upload … `);
    const up = await uploadPart(file);
    const g = up.geometry;
    const parsed = {
      bbox: [g.boundingBox.width, g.boundingBox.height, g.boundingBox.depth],
      volume: g.volume, surfaceArea: g.surfaceArea, estimatedThickness: g.estimatedThickness,
      flatWidth: g.flatWidth, flatHeight: g.flatHeight, estimatedPerimeter: g.estimatedPerimeter,
      estimatedHoles: g.estimatedHoles, estimatedSlots: g.estimatedSlots, estimatedBends: g.estimatedBends,
      triangleCount: g.triangleCount,
    };
    const pr = { id: part.id, part, parsed, partId: up.partId, configs: [] };
    let n = 0;
    for (const cfg of part.configs) {
      const mat = matBySlug[cfg.materialSlug];
      if (!mat) { console.log(`\n    SKIP ${cfg.label}: material ${cfg.materialSlug} not active on server`); continue; }
      if (cfg.finishSlug && !finishBySlug[cfg.finishSlug]) { console.log(`\n    SKIP ${cfg.label}: finish ${cfg.finishSlug} not active`); continue; }
      const cr = { cfg, quotes: [] };
      for (const qty of QTYS) {
        const body = {
          parts: [{
            partId: up.partId, materialSlug: cfg.materialSlug, grade: mat.grades?.[0]?.name,
            thicknessMm: cfg.thicknessMm || undefined, finishSlug: cfg.finishSlug || undefined,
            quantity: qty, process: cfg.process, subProcess: cfg.subProcess || undefined,
          }],
          leadTimeSlug: "standard",
        };
        const q = await api("POST", "/api/quote", { json: body });
        const li = q.lineItems[0];
        const dfm = q.dfmByPartId[up.partId] || { summary: {}, checks: [] };
        const exp = expectedFor(part, cfg);
        const expQ = exp ? exp[String(qty)] : null;
        const meta = li.meta || {};
        const row = {
          part: part.id, family: part.family, file: part.file, handSized: !!part.hand_sized,
          process: cfg.process, subProcess: meta.subProcess || cfg.subProcess || "", material: cfg.materialSlug,
          thicknessMm: cfg.thicknessMm || meta.thicknessMm || "", finish: cfg.finishSlug || meta.finishSlug || "", label: cfg.label,
          qty, unitPrice: li.perUnit.final, lineTotal: li.lineTotal,
          materialCost: li.perUnit.material, machineCost: li.perUnit.machining ?? li.perUnit.cutting ?? li.perUnit.machineTime,
          toolingCost: li.perUnit.tooling ?? "", setupPerUnit: li.perUnit.setup, finishCost: li.perUnit.finish,
          discount: li.perUnit.discount, subtotal: li.perUnit.subtotal,
          machineTimeHours: meta.machineTimeHours ?? "", cycleMinutes: meta.cycleMinutes ?? "", passes: meta.passes ?? "",
          cutLengthMm: meta.cutLengthMm ?? "", printTimeHours: meta.printTimeHours ?? "",
          stockMm: meta.geometrySummary?.stockMm ? `${meta.geometrySummary.stockMm.w}x${meta.geometrySummary.stockMm.h}x${meta.geometrySummary.stockMm.d}` : "",
          removalCm3: meta.geometrySummary?.removalCm3 ?? "", volumeRatio: meta.geometrySummary?.volumeRatio ?? "",
          partsPerSheet: meta.partsPerSheet ?? "",
          setups: meta.setups ?? "", setupMinutes: meta.setupMinutes ?? "",
          confidence: meta.confidence?.source ?? "", shape: meta.geometrySummary?.shape ?? "",
          costBuildup: Array.isArray(meta.costBuildup) ? meta.costBuildup.map((c) => `${c.step} ${c.minutes}m $${Number(c.dollars).toFixed(2)}`).join(" | ") : "",
          dfmScore: dfm.summary.score, dfmFails: (dfm.checks || []).filter((c) => c.severity === "fail").map((c) => c.label).join("; "),
          dfmWarns: (dfm.checks || []).filter((c) => c.severity === "warn").map((c) => c.label).join("; "),
          requiresRfq: q.gate.requiresRfq, gateCodes: q.gate.reasons.map((r) => r.code).join("; "),
          expectedLow: expQ ? expQ.low : "", expectedMid: expQ ? expQ.mid : "", expectedHigh: expQ ? expQ.high : "",
          engineToExpected: expQ ? li.perUnit.final / expQ.mid : "",
          parsedVolumeCm3: parsed.volume / 1000, trueVolumeCm3: part.volume / 1000,
          parsedHoles: parsed.estimatedHoles, trueHoles: part.truth.holes, parsedSlots: parsed.estimatedSlots, trueSlots: part.truth.slots,
          parsedPerimeterMm: parsed.estimatedPerimeter, truePerimeterMm: part.truth.cut_perimeter_mm,
          quoteId: q.quoteId,
        };
        rows.push(row);
        cr.quotes.push(row);
        n++;
      }
      pr.configs.push(cr);
    }
    partResults.push(pr);
    console.log(`${n} quotes  (parsed vol ${(parsed.volume / 1000).toFixed(1)} cm³ vs true ${(part.volume / 1000).toFixed(1)}; holes ${parsed.estimatedHoles} vs ${part.truth.holes}; perim ${parsed.estimatedPerimeter.toFixed(0)} vs ${part.truth.cut_perimeter_mm.toFixed(0)} mm)`);
  }

  // ─── sanity checks ─────────────────────────────────────────────────────────
  const findings = []; // {check, severity, part, config, qty, detail}
  const add = (check, severity, part, config, qty, detail) => findings.push({ check, severity, part, config, qty, detail });

  for (const pr of partResults) {
    const part = pr.part;
    // parser accuracy (per part)
    const volErr = Math.abs(pr.parsed.volume - part.volume) / part.volume;
    if (volErr > 0.02) add("parser-volume", "warn", pr.id, "", "", `parsed volume ${(pr.parsed.volume / 1000).toFixed(2)} cm³ vs true ${(part.volume / 1000).toFixed(2)} cm³ (${(volErr * 100).toFixed(1)} % off)`);
    const th = part.truth.holes, ph = pr.parsed.estimatedHoles;
    if (Math.abs(ph - th) >= 3 || (th > 0 && Math.abs(ph - th) / th > 0.5) || (th === 0 && ph > 0)) {
      add("parser-holes", "warn", pr.id, "", "", `parser estimated ${ph} holes, part has ${th}${part.truth.slots ? ` (+${part.truth.slots} slots, parser saw ${pr.parsed.estimatedSlots})` : ""}`);
    }
    const tp = part.truth.cut_perimeter_mm, pp = pr.parsed.estimatedPerimeter;
    if (tp > 0 && (pp / tp < 0.67 || pp / tp > 1.5)) add("parser-perimeter", "warn", pr.id, "", "", `parser cut perimeter ${pp.toFixed(0)} mm vs true ${tp.toFixed(0)} mm (×${(pp / tp).toFixed(2)})`);

    for (const cr of pr.configs) {
      const label = cr.cfg.label;
      const qs = cr.quotes;
      // 1. monotone with quantity
      for (let i = 1; i < qs.length; i++) {
        if (qs[i].unitPrice > qs[i - 1].unitPrice * 1.005) add("price-falls-with-qty", "fail", pr.id, label, qs[i].qty, `unit ${money(qs[i - 1].unitPrice)} @${qs[i - 1].qty} → ${money(qs[i].unitPrice)} @${qs[i].qty}`);
      }
      for (const r of qs) {
        // 5. minimum price
        const floorKey = r.process === "3d-printing" ? r.subProcess : r.process;
        const floor = MIN_PRICE[floorKey] ?? 5;
        if (r.unitPrice < floor - 1e-6) add("minimum-price", "fail", pr.id, label, r.qty, `unit ${money(r.unitPrice)} below floor ${money(floor)}`);
        // 6. qty > 100 gated
        if (r.qty > 100 && !(r.requiresRfq && r.gateCodes.includes("quantity"))) add("qty-over-100-gated", "fail", pr.id, label, r.qty, `requiresRfq=${r.requiresRfq} codes=[${r.gateCodes}]`);
        if (r.qty <= 100 && r.gateCodes.includes("quantity")) add("qty-over-100-gated", "fail", pr.id, label, r.qty, `quantity gate fired at qty ${r.qty}`);
        // 7. oversize gated
        if (part.expect_gate && !r.requiresRfq) add("oversize-gated", "fail", pr.id, label, r.qty, `oversize part was NOT gated (codes=[${r.gateCodes}])`);
        if (part.expect_gate && r.requiresRfq && !/dfm-fail|envelope/.test(r.gateCodes)) add("oversize-gated", "warn", pr.id, label, r.qty, `gated only by [${r.gateCodes}] — no size reason`);
        // 8. machine time red flag for hand-sized parts
        if (part.hand_sized) {
          if (r.process === "cnc" && r.machineTimeHours > RED_FLAG_MACHINE_HOURS) add("machine-time-red-flag", "fail", pr.id, label, r.qty, `${r.machineTimeHours.toFixed(2)} h machine time for a hand-sized part`);
          if (r.process === "routing" && r.cycleMinutes / 60 > RED_FLAG_MACHINE_HOURS) add("machine-time-red-flag", "fail", pr.id, label, r.qty, `${(r.cycleMinutes / 60).toFixed(2)} h cycle for a hand-sized part`);
          if (r.process === "3d-printing" && r.printTimeHours > RED_FLAG_PRINT_HOURS) add("machine-time-red-flag", "warn", pr.id, label, r.qty, `${r.printTimeHours.toFixed(1)} h print time for a hand-sized part`);
        }
        // 10. vs shop estimate (only at qty 1, 10, 25 — the engine's volume-discount table makes 100/250 a policy question)
        if (r.expectedMid && [1, 10, 25].includes(r.qty)) {
          const ratio = r.unitPrice / r.expectedMid;
          if (ratio < EXPECTED_RATIO_LOW) add("vs-shop-estimate", "warn", pr.id, label, r.qty, `engine ${money(r.unitPrice)} is ${(ratio * 100).toFixed(0)} % of the shop estimate ${money(r.expectedMid)} (under-priced)`);
          if (ratio > EXPECTED_RATIO_HIGH) add("vs-shop-estimate", "warn", pr.id, label, r.qty, `engine ${money(r.unitPrice)} is ${(ratio * 100).toFixed(0)} % of the shop estimate ${money(r.expectedMid)} (over-priced)`);
        }
      }
    }

    // 2. routing cheaper than cnc for flat sheet parts ≤ 1"
    if (part.family === "flat-sheet" && Math.min(...part.bbox) <= SHEET_PART_MAX_THICKNESS_MM) {
      const rt = pr.configs.filter((c) => c.cfg.process === "routing");
      const cnc = pr.configs.filter((c) => c.cfg.process === "cnc" && !c.cfg.finishSlug);
      for (const a of rt) {
        const match = cnc.find((c) => materialKey(c.cfg.materialSlug) === materialKey(a.cfg.materialSlug)) || cnc[0];
        if (!match) continue;
        for (const qa of a.quotes) {
          const qc = match.quotes.find((x) => x.qty === qa.qty);
          if (qc && qa.unitPrice >= qc.unitPrice) add("routing-cheaper-than-cnc", "fail", pr.id, `${a.cfg.label} vs ${match.cfg.label}`, qa.qty, `routing ${money(qa.unitPrice)} ≥ cnc ${money(qc.unitPrice)}`);
        }
      }
    }
    // 3. turning vs milling
    const turning = pr.configs.filter((c) => c.cfg.subProcess === "turning");
    const millingSame = pr.configs.filter((c) => c.cfg.subProcess === "milling");
    for (const t of turning) {
      const m = millingSame.find((c) => c.cfg.materialSlug === t.cfg.materialSlug);
      if (!m) continue;
      for (const qt of t.quotes) {
        const qm = m.quotes.find((x) => x.qty === qt.qty);
        if (!qm) continue;
        const ratio = qt.unitPrice / qm.unitPrice;
        if (ratio < 0.5 || ratio > 2) add("turning-vs-milling", "fail", pr.id, `${t.cfg.label} vs ${m.cfg.label}`, qt.qty, `turning ${money(qt.unitPrice)} vs milling ${money(qm.unitPrice)} (×${ratio.toFixed(2)})`);
      }
    }
    // 4. PEEK > Delrin
    const peek = pr.configs.find((c) => /peek/.test(c.cfg.materialSlug));
    const delrin = pr.configs.find((c) => /delrin/.test(c.cfg.materialSlug) && !c.cfg.finishSlug && peek && c.cfg.subProcess === peek.cfg.subProcess);
    if (peek && delrin) {
      for (const qp of peek.quotes) {
        const qd = delrin.quotes.find((x) => x.qty === qp.qty);
        if (qd && qp.unitPrice <= qd.unitPrice) add("peek-above-delrin", "fail", pr.id, `${peek.cfg.label} vs ${delrin.cfg.label}`, qp.qty, `PEEK ${money(qp.unitPrice)} ≤ Delrin ${money(qd.unitPrice)}`);
      }
    }
  }

  // 9. price per cm³ outliers (qty 10, per process, vs median)
  for (const proc of ["cnc", "routing", "3d-printing"]) {
    const rs = rows.filter((r) => r.process === proc && r.qty === 10 && !r.requiresRfq);
    const vals = rs.map((r) => r.unitPrice / r.trueVolumeCm3);
    const med = median(vals);
    rs.forEach((r, i) => {
      const v = vals[i];
      if (v > med * PRICE_PER_CM3_OUTLIER_FACTOR || v < med / PRICE_PER_CM3_OUTLIER_FACTOR) {
        add("price-per-cm3-outlier", "warn", r.part, r.label, 10, `${money(v)}/cm³ vs ${proc} median ${money(med)}/cm³ (×${(v / med).toFixed(2)})`);
      }
    });
  }

  // ─── write results.json / results.csv ─────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cols = Object.keys(rows[0] || {});
  fs.writeFileSync(path.join(OUT_DIR, "results.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => csvEscape(typeof r[c] === "number" ? round(r[c], 4) : r[c])).join(","))].join("\n") + "\n");
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify({ baseUrl: BASE_URL, ranAt: new Date().toISOString(), qtys: QTYS, rows, findings, parsedByPart: Object.fromEntries(partResults.map((p) => [p.id, p.parsed])) }, null, 1));

  // ─── write results.md ──────────────────────────────────────────────────────
  const L = [];
  L.push(`# Quote vetting results`);
  L.push(``);
  L.push(`Run: ${new Date().toISOString()} against \`${BASE_URL}\` — ${parts.length} parts, ${rows.length} quotes, quantities ${QTYS.join(" / ")}.`);
  L.push(`Generated by \`tools/vet-quotes/run_vetting.js\`; part library from \`tools/vet-quotes/generate_parts.py\`. Shop estimates assume $${manifest.shopRatePerHour}/h and ${manifest.margin * 100} % margin (the engine's own rate and margin) so differences are about the TIME and MATERIAL models, not the rate.`);
  L.push(``);
  const fails = findings.filter((f) => f.severity === "fail");
  const warns = findings.filter((f) => f.severity === "warn");
  L.push(`## Summary`);
  L.push(``);
  L.push(`| | count |`);
  L.push(`|---|---|`);
  L.push(`| quotes | ${rows.length} |`);
  L.push(`| sanity-check FAILS | ${fails.length} |`);
  L.push(`| sanity-check warnings | ${warns.length} |`);
  L.push(`| quotes routed to RFQ | ${rows.filter((r) => r.requiresRfq).length} |`);
  L.push(``);
  const byCheck = {};
  for (const f of findings) (byCheck[f.check] = byCheck[f.check] || { fail: 0, warn: 0, parts: new Set() }), byCheck[f.check][f.severity]++, byCheck[f.check].parts.add(f.part);
  L.push(`| check | fails | warns | parts affected |`);
  L.push(`|---|---|---|---|`);
  for (const [k, v] of Object.entries(byCheck)) L.push(`| ${k} | ${v.fail} | ${v.warn} | ${[...v.parts].join(", ")} |`);
  L.push(``);

  L.push(`## Per-part results`);
  L.push(``);
  for (const pr of partResults) {
    const p = pr.part;
    L.push(`### ${p.id}`);
    L.push(``);
    L.push(`${p.description}`);
    L.push(``);
    L.push(`*Shop-time reasoning:* ${p.reasoning}`);
    L.push(``);
    L.push(`| geometry | true (generator) | parsed (engine) |`);
    L.push(`|---|---|---|`);
    L.push(`| bounding box (mm) | ${p.bbox.map((v) => round(v, 2)).join(" × ")} | ${pr.parsed.bbox.map((v) => round(v, 2)).join(" × ")} |`);
    L.push(`| volume (cm³) | ${round(p.volume / 1000)} | ${round(pr.parsed.volume / 1000)} |`);
    L.push(`| holes / slots / pockets | ${p.truth.holes} / ${p.truth.slots} / ${p.truth.pockets} | ${pr.parsed.estimatedHoles} / ${pr.parsed.estimatedSlots} / – |`);
    L.push(`| cut perimeter (mm) | ${round(p.truth.cut_perimeter_mm, 0)} | ${round(pr.parsed.estimatedPerimeter, 0)} |`);
    L.push(`| "estimated thickness" (mm) | ${round(Math.min(...p.bbox), 2)} (thinnest bbox dim) | ${round(pr.parsed.estimatedThickness, 2)} |`);
    L.push(``);
    L.push(`| configuration | qty | unit | line | time | DFM | gate | shop est. (mid) | engine ÷ est. |`);
    L.push(`|---|---|---|---|---|---|---|---|---|`);
    for (const cr of pr.configs) {
      for (const r of cr.quotes) {
        const time = r.process === "cnc" ? `${(r.machineTimeHours * 60).toFixed(1)} min` : r.process === "routing" ? `${r.cycleMinutes} min, ${r.passes} pass` : `${Number(r.printTimeHours).toFixed(2)} h`;
        const dfm = `${r.dfmScore}${r.dfmFails ? ` FAIL: ${r.dfmFails}` : ""}`;
        const gate = r.requiresRfq ? `RFQ [${r.gateCodes}]` : "instant";
        const est = r.expectedMid ? money(r.expectedMid) : "";
        const ratio = r.engineToExpected ? `×${Number(r.engineToExpected).toFixed(2)}` : "";
        L.push(`| ${md(cr.cfg.label)} | ${r.qty} | ${money(r.unitPrice)} | ${money(r.lineTotal)} | ${time} | ${md(dfm)} | ${md(gate)} | ${est} | ${ratio} |`);
      }
    }
    L.push(``);
    const pf = findings.filter((f) => f.part === pr.id);
    if (pf.length) {
      L.push(`Flags: ` + pf.map((f) => `**${f.check}**${f.config ? ` (${f.config}${f.qty ? ` @${f.qty}` : ""})` : ""}: ${f.detail}`).join("; "));
      L.push(``);
    }
  }

  L.push(`## Sanity checks`);
  L.push(``);
  L.push(`Severity: **fail** = the engine broke a rule it must always satisfy; **warn** = needs a human look (parser accuracy, price level vs the shop estimate, outliers).`);
  L.push(``);
  L.push(`| severity | check | part | configuration | qty | detail |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const f of [...fails, ...warns]) L.push(`| ${f.severity} | ${f.check} | ${f.part} | ${md(f.config)} | ${f.qty} | ${md(f.detail)} |`);
  L.push(``);

  // BENCHMARK
  L.push(`## BENCHMARK`);
  L.push(``);
  L.push(`Engine unit prices at qty 1 / 10 / 25 next to (a) the owner's own price for the same part — fill in the blank column from memory or a traveler — and (b) real, published public price points for comparable plastic parts. Public numbers come from \`tools/vet-quotes/benchmarks.json\`; each one cites its URL and is left blank where no real figure was found. Nothing in that column is invented.`);
  L.push(``);
  L.push(`| part | configuration | engine @1 | engine @10 | engine @25 | Owner's price | Public benchmark |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const pr of partResults) {
    for (const cr of pr.configs) {
      const at = (q) => { const r = cr.quotes.find((x) => x.qty === q); return r ? money(r.unitPrice) : ""; };
      const bm = (benchmarks.entries || []).filter((b) => b.part === pr.id && (!b.config || b.config === cr.cfg.label));
      const bmText = bm.map((b) => `${b.text} ([source](${b.url}))`).join("<br>");
      L.push(`| ${pr.id} | ${md(cr.cfg.label)} | ${at(1)} | ${at(10)} | ${at(25)} | | ${md(bmText)} |`);
    }
  }
  L.push(``);
  if ((benchmarks.notes || []).length) {
    L.push(`Benchmark notes:`);
    L.push(``);
    for (const n of benchmarks.notes) L.push(`- ${n}`);
    L.push(``);
  }
  fs.writeFileSync(path.join(OUT_DIR, "results.md"), L.join("\n"));

  console.log(`\n${rows.length} quotes → ${path.join(OUT_DIR, "results.csv")}, results.md, results.json`);
  console.log(`Sanity checks: ${fails.length} fails, ${warns.length} warnings`);
  for (const [k, v] of Object.entries(byCheck)) console.log(`  ${k.padEnd(28)} fail=${v.fail} warn=${v.warn}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
