#!/usr/bin/env node
/**
 * Upload corpus inputs to a running server and report what a customer would
 * get: how long the upload took, whether it came back with a part (and an
 * instant price) or a refusal, and how the server answered /api/health while
 * the worker was parsing.
 *
 *   node tools/geometry-bench/live-upload.js --base http://localhost:3473 sphere-100k sphere-500k dxf-crossing-5k
 *   (--first-client N starts the made-up client addresses at N, for a second run against the same server)
 *
 * Starts nothing. Against a local test server only (it sends its own
 * X-Forwarded-For so each file is a different client for the rate limits).
 * With HTTPS_PROXY set, run under
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost
 */
const fs = require("fs");
const path = require("path");
const { byId } = require("./corpus");
const lib = require("./lib");

const STANDARD = {
  ".dxf": { process: "routing", subProcess: "sheet", materialSlug: "rt-hdpe", thicknessMm: 6.35 },
  mesh: { process: "3d-printing", subProcess: "fdm", materialSlug: "fdm-abs" },
};

(async () => {
  const args = lib.parseArgs(process.argv.slice(2));
  const base = String(args.base || "http://localhost:3010").replace(/\/$/, "");
  const materials = await (await fetch(`${base}/api/materials`)).json();
  const rows = [];
  let client = Number(args["first-client"]) || 0; // --first-client N: start the made-up addresses at N (several runs against one server)
  for (const id of args._) {
    const c = byId(id);
    if (!c) { console.error(`unknown case ${id}`); continue; }
    const file = lib.inputFile(c);
    const buf = fs.readFileSync(file);
    const ip = `10.77.${(++client >> 8) & 255}.${client & 255}`;
    const form = new FormData();
    form.append("files", new Blob([buf], { type: "application/octet-stream" }), path.basename(file));
    // health checks every 50 ms while the upload is in flight
    let done = false, worst = 0, pings = 0;
    const pinger = (async () => {
      while (!done) {
        const t = Date.now();
        try { await fetch(`${base}/api/health`, { headers: { "X-Forwarded-For": "10.78.0.1" } }); } catch { /* ignore */ }
        worst = Math.max(worst, Date.now() - t); pings++;
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const t0 = Date.now();
    const res = await fetch(`${base}/api/upload`, { method: "POST", headers: { "X-Forwarded-For": ip }, body: form });
    const text = await res.text();
    const wall = Date.now() - t0;
    done = true; await pinger;
    let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
    const row = { id, bytes: buf.length, status: res.status, wallMs: wall, worstHealthMs: worst, healthChecks: pings };
    const part = body.parts && body.parts[0];
    if (part) {
      row.outcome = "part";
      row.triangles = part.geometry && part.geometry.triangleCount;
      const cfg = c.ext === ".dxf" ? STANDARD[".dxf"] : STANDARD.mesh;
      const mat = (Array.isArray(materials) ? materials : materials.materials || []).find((m) => m.slug === cfg.materialSlug);
      try {
        const q = await fetch(`${base}/api/quote`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
          body: JSON.stringify({ parts: [{ partId: part.partId, editKey: part.editKey, materialSlug: cfg.materialSlug, grade: mat && mat.grades && mat.grades[0] && mat.grades[0].name, thicknessMm: cfg.thicknessMm, quantity: 1, process: cfg.process, subProcess: cfg.subProcess }], leadTimeSlug: "standard" }),
        });
        const qb = await q.json();
        if (q.ok && qb.lineItems) { row.price = qb.lineItems[0].lineTotal; row.checkout = qb.gate ? (qb.gate.requiresRfq ? "RFQ" : "instant") : undefined; }
        else row.quoteError = (qb.error || JSON.stringify(qb)).slice(0, 160);
      } catch (err) { row.quoteError = err.message; }
    } else {
      const e = (body.errors && body.errors[0]) || body;
      row.outcome = "refused"; row.code = e.code || null; row.message = String(e.error || e.raw || "").slice(0, 200);
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(rows, null, 1) + "\n");
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
