#!/usr/bin/env node
/**
 * Review of the review-conditions fixes (2026-11-13), N-08: a START on a volume that answers "quota
 * exceeded" (EDQUOT) where a plain full disk answers "no space" (ENOSPC), and a start where the
 * temporary file cannot even be opened. The author ran ENOSPC on the write only.
 *
 *   node tools/security/review-conditions/r5-edquot-start.js
 *
 * For each of the three: the start must be refused (exit 1) with the message that says THE DISK IS
 * FULL and to free space, must not say "restore", and must leave the database file byte for byte.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const { report } = require(path.join(ROOT, "tools/security/rereview-relaunch/lib"));
const live = require(path.join(ROOT, "server/testSupport/liveServer"));

(async () => {
  const R = report();
  const cases = [
    ["ENOSPC on the write (the author's own stand-in)", path.join(ROOT, "server/testSupport/fullDiskPreload.js"), {}],
    ["EDQUOT on the write", path.join(__dirname, "r5-edquot-preload.js"), {}],
    ["EDQUOT on opening the temporary file", path.join(__dirname, "r5-edquot-preload.js"), { R5_FAIL_AT: "open" }],
  ];
  for (const [label, preload, extra] of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r5-start-"));
    const flag = path.join(tmp, "full.flag");
    const env = { NODE_OPTIONS: `--require ${preload}`, SE_TEST_DISK_FULL_FLAG: flag, EMAIL_OUTBOX_DIR: path.join(tmp, "outbox"), ...extra };
    let s = await live.start({ env, tmpDir: tmp });
    await s.register("first@customer.test");
    await s.stop({ keep: true });
    const dbFile = path.join(tmp, "data", "quoting.db");
    const before = fs.readFileSync(dbFile);
    fs.writeFileSync(flag, "full");
    let refused = null;
    try { s = await live.start({ env, tmpDir: tmp }); await s.stop({ keep: true }); } catch (err) { refused = err; }
    const fatal = refused ? String(refused.output || "").split("\n").filter((l) => /^FATAL/.test(l)) : [];
    R.check(Boolean(refused) && refused.exitCode === 1 && fatal.length === 1 && /THE DISK IS FULL/.test(fatal[0]) && /Free space on the volume/.test(fatal[0]) && !/Restore the volume from its backup/.test(fatal[0]),
      `${label}: the start is refused and says the disk is full, not "restore"`, refused ? `exit ${refused.exitCode}: ${(fatal[0] || String(refused.output).slice(-200)).slice(0, 160)}…` : "IT STARTED");
    R.check(fs.readFileSync(dbFile).equals(before) && !fs.existsSync(`${dbFile}.tmp`), `${label}: the database file is byte for byte what it was, no temporary file left`);
    fs.rmSync(flag, { force: true });
    s = await live.start({ env, tmpDir: tmp });
    R.check((await s.get("/api/health")).status === 200, `${label}: with room it starts`);
    await s.stop();
  }
  process.exit(R.done() ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
