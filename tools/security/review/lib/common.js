/**
 * Independent security review, 2026-11-11 — shared helpers for the proofs of concept.
 * Starts the real server (server/index.js, production mode) through the project's own
 * testSupport/liveServer.js, with lib/preload.js keeping Stripe, Resend and Turnstile local.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const live = require(path.join(ROOT, "server", "testSupport", "liveServer"));

async function start({ env = {}, mailer = false, turnstile = false, webhookSecret = null } = {}) {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "se-review-")), "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: {}, mail: 0, turnstile: 0 }));
  const extra = { NODE_OPTIONS: `--require ${path.join(__dirname, "preload.js")}`, SE_REVIEW_STATE: stateFile };
  if (mailer) { extra.EMAIL_API_KEY = `re_review_${crypto.randomBytes(8).toString("hex")}`; extra.EMAIL_FROM = "Straightedge <quotes@shop.test>"; }
  if (turnstile) { extra.TURNSTILE_SITE_KEY = `site-${crypto.randomBytes(6).toString("hex")}`; extra.TURNSTILE_SECRET_KEY = `secret-${crypto.randomBytes(12).toString("hex")}`; }
  if (webhookSecret) extra.STRIPE_WEBHOOK_SECRET = webhookSecret;
  const s = await live.start({ env: { ...extra, ...env } });
  s.state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  s.setState = (fn) => { const st = s.state(); fn(st); fs.writeFileSync(stateFile, JSON.stringify(st, null, 2)); };
  s.payAll = () => s.setState((st) => { for (const id of Object.keys(st.sessions)) st.sessions[id].payment_status = "paid"; });
  return s;
}

/** A closed box as a binary STL (12 triangles), `size` mm on a side unless given as [x, y, z]. */
function boxStl(size = 20) {
  const [X, Y, Z] = Array.isArray(size) ? size : [size, size, size];
  const v = [[0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, Z], [X, 0, Z], [X, Y, Z], [0, Y, Z]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + f.length * 50);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => {
    const o = 84 + i * 50;
    t.forEach((vi, k) => v[vi].forEach((c, a) => buf.writeFloatLE(c, o + 12 + k * 12 + a * 4)));
  });
  return buf;
}

/** A rectangle outline as an ASCII DXF, `w` × `h` drawing units, with or without a $INSUNITS header (4 = mm, 1 = in). */
function rectDxf(w, h, insunits = 4) {
  const header = insunits == null ? "" : `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${insunits}\n0\nENDSEC\n`;
  const line = (x1, y1, x2, y2) => `0\nLINE\n8\n0\n10\n${x1}\n20\n${y1}\n11\n${x2}\n21\n${y2}\n`;
  return Buffer.from(`${header}0\nSECTION\n2\nENTITIES\n${line(0, 0, w, 0)}${line(w, 0, w, h)}${line(w, h, 0, h)}${line(0, h, 0, 0)}0\nENDSEC\n0\nEOF\n`);
}

const out = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomIp = () => `198.51.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

module.exports = { start, boxStl, rectDxf, out, sleep, randomIp, ROOT, live };
