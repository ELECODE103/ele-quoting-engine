#!/usr/bin/env node
/**
 * Item 8 of the re-review: file encryption with no key, a wrong key and a rotated key.
 * RR-12: the start-up check looks only at the newest 25 encrypted files per folder.
 * A passing fix: `afterNewUploadsUnderTheNewKey.startupErrorPrinted` is true while old parts are still locked.
 *
 *   node tools/security/rereview-availability/encryption.js
 *
 * The keys are random strings made here at run time and never printed. One data folder, restarted
 * five times with different settings, the way a redeploy with changed variables does.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const c = require("./common");
const { solidStl } = require("../../../server/testSupport/zip");

const K1 = crypto.randomBytes(24).toString("hex");
const K2 = crypto.randomBytes(24).toString("hex");
const ERR = /EXISTING FILES CANNOT BE OPENED[^\n]*/;

(async () => {
  const ip = "192.0.2.170";
  let s = await c.startServer({ env: { NORD_FILE_ENC_KEY: K1 } });
  const out = {};
  // Adapted 2026-11-12 (second integration pass): the edit keys of the parts this script uploaded are
  // carried over each restart, as a visitor's browser carries them over a redeploy. Each restart makes
  // a new test helper, which had forgotten them; since parts have owners (security/partAccess.js) the
  // script was then refused its own parts ("part-not-found") whatever the encryption key was.
  const restart = async (env) => { const tmp = s.tmp; const keys = s.editKeys || {}; await s.stop({ keep: true }); s = await c.startServer({ env, tmpDir: tmp }); s.editKeys = { ...keys, ...(s.editKeys || {}) }; return s; };
  const plainFiles = () => ["uploads", "part-payloads", "quote-drawings", "rfq-drawings"].flatMap((d) => c.ls(s, d).filter((n) => !n.endsWith(".enc")).map((n) => `${d}/${n}`));
  const price = async (line) => { let q; for (let i = 0; i < 6; i++) { q = await s.post("/api/quote", { parts: [line], leadTimeSlug: "standard" }, { ip }); if (q.status !== 429) break; await c.sleep(1500); } return q.status === 200 ? { status: 200, each: q.body.lineItems[0].perUnit.final } : { status: q.status, code: q.body && q.body.code }; };
  try {
    // ── Key 1: three kinds of part ──
    const stl = await c.uploadOne(s, "block.stl", solidStl(24), { ip });
    const dxf = await c.uploadOne(s, "plate.dxf", c.g.dxfPlate(40), { ip, fields: { process: "routing" } });
    const cube = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip });
    const lCnc = (await c.lineFor(s, stl.partId, "cnc", ip)).line;
    const lRt = (await c.lineFor(s, dxf.partId, "routing", ip)).line;
    const lines = { stl: { ...lCnc, subProcess: "milling" }, dxf: lRt, cube: { ...lCnc, partId: cube.partId, subProcess: "milling" } };
    const first = { stl: await price(lines.stl), dxf: await price(lines.dxf), cube: await price(lines.cube) };
    // Is anything of a shape in clear, on disk or in the database file?
    const db = fs.readFileSync(path.join(s.dataDir, "quoting.db")).toString("latin1");
    out.withAKeySet = {
      pricesEach: first, filesNotEncrypted: plainFiles(),
      databaseHoldsVertexLists: /"positions":\[-?\d/.test(db), databaseHoldsDxfLoops: /"loops":\[\{/.test(db) || /"points":\[\[/.test(db),
      databaseStillHoldsInClear: ["file names", ...(db.includes("plate.dxf") ? [] : ["(file name not found?)"]), "overall measurements", "DFM notes", "quote lines"].filter((x) => !x.startsWith("(")),
    };
    const count = () => ["uploads", "part-payloads"].reduce((n, d) => n + c.ls(s, d).length, 0);
    const filesBefore = count();

    // ── No key at all ──
    await restart({});
    out.noKey = { startupErrorPrinted: (s.log().match(ERR) || [null])[0], startupSaysUnencrypted: /stored UNENCRYPTED/.test(s.log()), pricesEach: { stl: await price(lines.stl), dxf: await price(lines.dxf), cube: await price(lines.cube) }, filesStillThere: count() === filesBefore };
    const plainUp = await c.uploadOne(s, "after.stl", c.g.stlCube(15), { ip });
    out.noKey.newUploadStoredAs = c.ls(s, "uploads").filter((n) => !n.endsWith(".enc")).length ? "plain file (as the start-up warning says)" : "encrypted";
    out.noKey.previewOfAnOldPart = (await s.get(`/api/parts/${stl.partId}/mesh`, { ip, headers: { "X-Part-Key": stl.editKey } })).status;

    // ── A different key, the old one not listed ──
    await restart({ NORD_FILE_ENC_KEY: K2 });
    out.wrongKey = { startupErrorPrinted: (s.log().match(ERR) || [null])[0], pricesEach: { stl: await price(lines.stl), dxf: await price(lines.dxf), cube: await price(lines.cube) }, filesStillThere: count() >= filesBefore };

    // ── The same wrong key after ordinary use: thirty new uploads under the new key, then a restart ──
    for (let i = 0; i < 3; i++) await s.upload(Array.from({ length: 10 }, (_, k) => ({ name: `new-${i}-${k}.stl`, data: c.g.stlCube(10 + k) })), { ip: `192.0.2.${171 + i}` });
    await restart({ NORD_FILE_ENC_KEY: K2 });
    out.afterNewUploadsUnderTheNewKey = { startupErrorPrinted: Boolean(s.log().match(ERR)), oldPartsStillLocked: (await price(lines.stl)).status !== 200 && (await price(lines.dxf)).status !== 200, pricesEach: { stl: await price(lines.stl), dxf: await price(lines.dxf) } };

    // ── Rotated properly: new key, old key listed as previous ──
    await restart({ NORD_FILE_ENC_KEY: K2, NORD_FILE_ENC_KEY_PREVIOUS: K1 });
    const rotated = { stl: await price(lines.stl), dxf: await price(lines.dxf), cube: await price(lines.cube) };
    out.rotatedWithPreviousListed = { startupErrorPrinted: Boolean(s.log().match(ERR)), pricesEach: rotated, sameAsBefore: JSON.stringify(rotated) === JSON.stringify(first), previewOfAnOldPart: (await s.get(`/api/parts/${stl.partId}/mesh`, { ip, headers: { "X-Part-Key": stl.editKey } })).status };

    // ── A key that is too short or a placeholder stops the start ──
    let refused = null;
    const tmp = s.tmp; await s.stop({ keep: true });
    try { s = await c.startServer({ env: { NORD_FILE_ENC_KEY: "short-key" }, tmpDir: tmp }); refused = false; } catch (e) { refused = /FATAL/.test(String(e.output || e.message)); s = await c.startServer({ env: {}, tmpDir: tmp }); }
    out.unusableKey = { serverRefusesToStart: refused };
    c.result({ test: "encryption", ...out });
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
