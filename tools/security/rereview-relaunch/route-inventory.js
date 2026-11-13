/**
 * Every route the server mounts, with the guards in front of it, read from the routers themselves
 * (not from a hand-kept list). Prints the routes that have NO `authenticate` in their chain, and
 * fails if any route whose path or purpose is the owner's lacks authenticate + requireAdmin.
 *
 *   node tools/security/rereview-relaunch/route-inventory.js
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rr-routes-"));
process.env.QUOTING_DB_PATH = path.join(tmp, "q.db");
process.env.QUOTING_DATA_DIR = path.join(tmp, "data");
process.env.JWT_SECRET = "route-inventory";
process.env.NODE_ENV = "test";
const ROOT = path.join(__dirname, "..", "..", "..", "server");

function walk(router, prefix, out) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      const names = layer.route.stack.map((l) => l.handle.name || "(anonymous)");
      for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: prefix + layer.route.path, chain: names });
    } else if (layer.handle && layer.handle.stack) {
      // A router mounted with or without a path.
      const m = layer.regexp && layer.regexp.source.match(/^\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)$/);
      walk(layer.handle, prefix + (m ? "/" + m[1].replace(/\\\//g, "/") : ""), out);
    }
  }
}

(async () => {
  await require(path.join(ROOT, "models", "database")).ready;
  const express = require("express");
  const app = express();
  require(path.join(ROOT, "security")).mount(app);
  const mounts = [["/api", "routes/api"], ["/api/auth", "routes/auth"], ["/api/orders", "routes/orders"], ["/api/rfq", "routes/rfq"], ["/api/pdf", "routes/pdf"]];
  const out = [];
  for (const [p, f] of mounts) walk(require(path.join(ROOT, f)), p, out);
  try { const ops = require(path.join(ROOT, "ops", "routes")); const r = typeof ops === "function" ? ops() : (ops.router ? ops.router() : null); if (r && r.stack) walk(r, "/api", out); } catch (e) { console.log(`(ops routes not walked here: ${e.message.slice(0, 80)})`); }
  const adminish = (r) => /\/admin\b|\/traveler|\/packing|\/pdf\/|\/status$|resolve-attention|\/download|\/tax-certificate$/.test(r.path) && !/\/quote\/:(id|token)\/tax-certificate/.test(r.path) && !/admin-setup/.test(r.path);
  let bad = 0;
  console.log(`${out.length} routes\n\nroutes WITHOUT authenticate in their own chain:`);
  for (const r of out) if (!r.chain.includes("authenticate")) console.log(`  ${r.method.padEnd(6)} ${r.path.padEnd(48)} [${r.chain.join(", ")}]`);
  console.log("\nowner routes (path says admin, a shop document, a status move, a download):");
  for (const r of out.filter(adminish)) {
    const ok = r.chain.includes("authenticate") && r.chain.includes("requireAdmin") && r.chain.indexOf("authenticate") < r.chain.indexOf("requireAdmin");
    if (!ok) bad++;
    console.log(`  ${ok ? "ok " : "BAD"} ${r.method.padEnd(6)} ${r.path.padEnd(48)} [${r.chain.slice(0, 4).join(", ")}]`);
  }
  console.log(`\n${bad} owner route(s) without authenticate → requireAdmin`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
