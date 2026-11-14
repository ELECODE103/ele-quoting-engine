#!/usr/bin/env node
/**
 * Review of the review-conditions fixes (2026-11-13), N-08: the response guard only looks at requests
 * that are not GET. Which GET requests WRITE, and what do they answer while the file cannot be written?
 * Also: is the health check ever stuck "unavailable" after room comes back, or "ok" while writes fail?
 *
 *   node tools/security/review-conditions/r5-full-disk-reads.js
 *
 * The real server (production mode), the disk "full" for the database file while a flag file exists
 * (server/testSupport/fullDiskPreload.js). For each GET the server log is read for a write that was
 * not saved during that request.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const { report, sleep, SHIP } = require(path.join(ROOT, "tools/security/rereview-relaunch/lib"));
const live = require(path.join(ROOT, "server/testSupport/liveServer"));
const cube = fs.readFileSync(path.join(ROOT, "tools/vet-quotes/parts/cube_20mm.stl"));

(async () => {
  const R = report();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r5-reads-"));
  const flag = path.join(tmp, "disk-is-full.flag");
  const stripeFile = path.join(tmp, "stripe.json");
  const env = {
    NODE_OPTIONS: `--require ${path.join(ROOT, "tools/security/rereview-relaunch/stripe-stub-preload.js")} --require ${path.join(ROOT, "server/testSupport/fullDiskPreload.js")}`,
    RR_STRIPE_FILE: stripeFile, SE_TEST_DISK_FULL_FLAG: flag, DB_SAVE_RETRY_MS: "400", DB_DRAFT_FLUSH_MS: "100",
    JWT_SECRET: crypto.randomBytes(32).toString("hex"), STRIPE_SECRET_KEY: "sk_test_local_only", EMAIL_OUTBOX_DIR: path.join(tmp, "outbox"),
  };
  const s = await live.start({ env, tmpDir: tmp });
  try {
    const owner = await s.admin();
    const buyer = await s.register("dana@buyer.test");
    const up = await s.upload([{ name: "cube.stl", data: cube }], { token: buyer });
    const partId = up.body.parts[0].partId;
    const mat = (await s.get("/api/materials")).body.filter((m) => m.process === "cnc")[0];
    const q = await s.post("/api/quote", { parts: [{ partId, materialSlug: mat.slug, grade: (mat.grades && mat.grades[0] && mat.grades[0].name) || "", finishSlug: "", quantity: 2, process: "cnc", subProcess: "milling" }], leadTimeSlug: "standard" }, { token: buyer });
    const c = await s.post("/api/orders/checkout-session", { quoteId: q.body.quoteId, ...SHIP }, { token: buyer });
    const orderId = c.body.orderId;
    await sleep(400);

    fs.writeFileSync(flag, "full");
    const notSaved = () => (s.log().match(/the change was not written to the database file|DATABASE NOT SAVED|could not be written/g) || []).length;
    const gets = [
      ["buyer", "/api/auth/session"], ["buyer", "/api/auth/profile"], ["buyer", "/api/orders"], ["buyer", `/api/orders/${orderId}`],
      ["buyer", `/api/quote/${q.body.quoteId}`], ["buyer", `/api/quote/${q.body.quoteId}/session`], ["buyer", `/api/parts/${partId}/mesh`], ["buyer", `/api/parts/${partId}/geometry`],
      ["none", "/api/materials"], ["none", "/api/finishes"], ["none", "/api/lead-times"], ["none", "/api/processes"], ["none", "/api/public/config"], ["none", "/api/public/form-token?form=rfq"],
      ["owner", "/api/orders/admin/queue"], ["owner", "/api/orders"], ["owner", `/api/orders/${orderId}/traveler`], ["owner", `/api/pdf/traveler/${orderId}`], ["owner", `/api/pdf/packing-list/${orderId}`],
      ["owner", `/api/pdf/quote/${q.body.quoteId}`], ["owner", `/api/pdf/order-confirmation/${orderId}`], ["owner", `/api/pdf/packing-slip/${orderId}`], ["owner", `/api/pdf/coc/${orderId}`],
      ["owner", "/api/rfq/admin/list"], ["owner", "/api/admin/materials"], ["owner", "/api/admin/pricing"], ["owner", "/api/admin/pricing/history"], ["owner", "/api/admin/quotes"], ["owner", "/api/admin/audit"],
      ["owner", "/api/admin/stats"], ["owner", "/api/admin/parts"], ["owner", "/api/admin/storage"], ["owner", "/api/admin/system/status"], ["owner", "/api/admin/calibration"], ["owner", "/api/admin/catalogue-upgrade"],
      ["owner", "/api/admin/backup/db"], ["owner", "/api/admin/backup/json"], ["owner", "/api/admin/backup/full"], ["owner", `/api/parts/${partId}/download`], ["owner", "/api/auth/2fa"],
    ];
    const wrote = [];
    let answered = 0;
    for (const [who, url] of gets) {
      const before = notSaved();
      const r = await s.get(url, who === "none" ? {} : { token: who === "owner" ? owner : buyer });
      await sleep(30);
      answered++;
      if (notSaved() !== before) wrote.push(`${url.replace(orderId, ":order").replace(q.body.quoteId, ":quote").replace(partId, ":part")} → ${r.status}`);
    }
    const quiet = wrote.filter((w) => Number(w.split(" → ")[1]) < 400);
    if (quiet.length) R.finding(`${quiet.length} of ${answered} GET requests tried to WRITE while the disk was full and were answered as if nothing was wrong (the guard skips GET)`, quiet.join(" | "));
    else R.holds(`none of ${answered} GET requests wrote while the disk was full and then answered as if all was well`, wrote.length ? `${wrote.length} tried to write and said so: ${wrote.join(" | ")}` : "none tried to write");
    R.check((await s.get("/api/health")).status === (wrote.length ? 503 : 200), wrote.length ? "the health check says 'unavailable' after those writes failed" : "no write was tried, so the health check still says 'ok' (nothing has failed yet)");

    // Health: a failed write, then room. Does it come back? And does it stay back?
    const login = await s.post("/api/auth/login", { email: "dana@buyer.test", password: s.passwords["dana@buyer.test"] }, {});
    R.check(login.status === 503 && (await s.get("/api/health")).status === 503, "a sign-in that cannot be saved turns the health check to 'unavailable'", `login ${login.status}`);
    fs.rmSync(flag, { force: true });
    let ok = null; const t0 = Date.now();
    for (let i = 0; i < 40; i++) { ok = await s.get("/api/health"); if (ok.status === 200) break; await sleep(100); }
    R.check(ok.status === 200, "with room it answers 'ok' again by itself", `after ${Date.now() - t0} ms (retry every 400 ms in this run)`);
    // Flap: full / room, ten times, a write each time.
    let stuck = 0, wrongOk = 0;
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(flag, "full");
      const l = await s.post("/api/auth/login", { email: "dana@buyer.test", password: s.passwords["dana@buyer.test"] }, {});
      if (l.status !== 503 || (await s.get("/api/health")).status !== 503) wrongOk++;
      fs.rmSync(flag, { force: true });
      let h = null;
      for (let k = 0; k < 30; k++) { h = await s.get("/api/health"); if (h.status === 200) break; await sleep(100); }
      if (h.status !== 200) stuck++;
    }
    R.check(stuck === 0 && wrongOk === 0, "ten rounds of full / room: never stuck 'unavailable' after room, never 'ok' while a write had just failed", `stuck ${stuck} of 10, wrongly ok ${wrongOk} of 10`);
    R.check(s.exited() === null, "the server is still running");
  } finally { try { await s.stop(); } catch { /* gone */ } }
  process.exit(R.done() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
