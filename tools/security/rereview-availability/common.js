/**
 * Shared helpers for the 2026-11-12 re-review of the availability fixes.
 * Every script here starts the REAL server (server/index.js, production mode) on a throwaway
 * data folder with throwaway secrets, through tools/security/review-uploads/lib.js, and stops it.
 * Nothing leaves the machine: Stripe, Turnstile and the mail provider are answered by the
 * repository's own stand-ins (tools/security/review-uploads/preload-stubs.js) when a script asks.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const g = require("../review-uploads/gen");
const lib = require("../review-uploads/lib");

const MB = 1024 * 1024;
const sleep = lib.sleep;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const load = () => os.loadavg().map((n) => Number(n.toFixed(2)));

/** Print the one-line JSON result every script ends with (load average included, timings are noisy here). */
function result(obj) {
  console.log(JSON.stringify({ ...obj, loadAverage: load(), node: process.version }));
}

/** The first listed material for a process and a usable line configuration for `partId`. */
async function lineFor(s, partId, process = "cnc", ip) {
  const mats = (await s.get(`/api/materials?process=${process}`, { ip })).body || [];
  const mat = mats[0];
  if (!mat) throw new Error(`no material listed for ${process}`);
  const line = { partId, materialSlug: mat.slug, quantity: 1, process };
  if (mat.thicknesses && mat.thicknesses.length) line.thicknessMm = mat.thicknesses[0].mm;
  return { line, mat, mats };
}

/** Upload one file and return the first part of the answer (or throw with the server's words). */
async function uploadOne(s, name, data, o = {}) {
  let r;
  // On a loaded machine a dense file can run out of its parse time (10 s for a DXF): try again, and say so.
  for (let attempt = 1; attempt <= (o.attempts || 4); attempt++) {
    r = await s.upload([{ name, data }], { timeoutMs: 200000, ...o });
    const part = r.body && r.body.parts && r.body.parts[0];
    if (part) return part;
    const code = (r.body && (r.body.code || (r.body.errors && r.body.errors[0] && r.body.errors[0].code))) || "";
    if (code !== "parse-timeout" && code !== "busy") break;
    log(`upload of ${name}: ${code} on attempt ${attempt} (load ${load()[0]}), trying again`);
    await sleep(2000);
  }
  throw new Error(`upload of ${name} failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
}

/** `n` lines of one part that all differ (quantity 1..n), so the quote row cannot be stored compactly. */
const distinctLines = (line, n) => Array.from({ length: n }, (_, i) => ({ ...line, quantity: i + 1 }));

const dbBytes = (s) => { try { return fs.statSync(path.join(s.dataDir, "quoting.db")).size; } catch { return 0; } };

/** A verified-human token for `ip` from the repository's Turnstile stand-in (a token starting "pass" passes). */
async function humanToken(s, ip) {
  const r = await s.post("/api/human/verify", { turnstileToken: `pass-${Math.random().toString(16).slice(2)}`, action: "quote" }, { ip });
  if (r.status !== 200 || !r.body.humanToken) throw new Error(`human verify failed for ${ip}: ${r.status} ${r.text}`);
  return r.body.humanToken;
}

module.exports = { ...lib, g, MB, sleep, log, load, result, lineFor, uploadOne, distinctLines, dbBytes, humanToken };
