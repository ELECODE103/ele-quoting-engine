#!/usr/bin/env node
/**
 * npm run backup -- [--out <file>]
 *
 * Writes one archive of the database and every customer-file folder
 * (server/ops/backupArchive.js). The same archive the admin page offers under
 * Admin → System → "Download full backup"; this is the command-line way, for
 * a shell on the server (railway ssh) or a copy of the data folder on a PC.
 *
 * Reads the data folder the server uses (./data, or QUOTING_DATA_DIR /
 * QUOTING_DB_PATH). Does not need the server to be running, and does not read
 * any key: encrypted files are copied as they are.
 *
 * If the server IS running, its last completed save is what is on disk — every
 * write is saved before the request is answered — so the copy is consistent.
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: npm run backup -- [--out <file.tar.gz>]\nWrites a full backup of ./data (database, uploads, drawings, part previews). No secrets are included.");
  process.exit(0);
}

const root = path.join(__dirname, "..", "..");
const dataDir = process.env.QUOTING_DATA_DIR ? path.resolve(process.env.QUOTING_DATA_DIR) : path.join(root, "data");
const dbPath = process.env.QUOTING_DB_PATH ? path.resolve(process.env.QUOTING_DB_PATH) : path.join(dataDir, "quoting.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.resolve(flag("--out") || `straightedge-full-backup-${stamp}.tar.gz`);

(async () => {
  const archive = require("../../server/ops/backupArchive");
  const planned = archive.plan({ dataDir, dbPath });
  if (!planned.files.length) { console.error(`Nothing to back up: no database at ${dbPath} and no files under ${dataDir}.`); process.exit(1); }
  const limit = archive.maxBytes();
  if (planned.totalBytes > limit) { console.error(`The data is ${Math.round(planned.totalBytes / 1048576)} MB, over BACKUP_MAX_MB (${Math.round(limit / 1048576)} MB). Raise BACKUP_MAX_MB for this run, or use a Railway volume backup.`); process.exit(1); }
  if (fs.existsSync(out)) { console.error(`${out} already exists. Choose another name with --out.`); process.exit(1); }
  const report = await archive.write(fs.createWriteStream(out, { mode: 0o600 }), { planned, meta: { build: "command line" } });
  console.log(`Full backup written: ${out}`);
  console.log(`  ${report.files} files, ${(report.bytes / 1e6).toFixed(1)} MB before compression, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB on disk.`);
  if (report.missing.length) console.log(`  ${report.missing.length} file(s) disappeared while the backup ran (swept as expired) and are not in it.`);
  if (planned.skipped.length) console.log(`  ${planned.skipped.length} file(s) skipped (unusual names); they are listed in the archive's MANIFEST.json.`);
  console.log("  Keep it like a credential: the database inside holds accounts and order history. Encrypted files inside stay encrypted.");
})().catch((err) => { console.error(`Backup failed: ${err.message}`); process.exit(1); });
