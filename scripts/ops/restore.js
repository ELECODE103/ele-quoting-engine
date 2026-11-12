#!/usr/bin/env node
/**
 * npm run restore -- <archive.tar.gz> [--to <data folder>] [--force]
 *
 * Unpacks a full backup (npm run backup, or Admin → System → "Download full
 * backup") into a data folder: quoting.db, uploads/, quote-drawings/,
 * rfq-drawings/, part-payloads/.
 *
 * STOP THE SERVER FIRST. The server keeps the whole database in memory and
 * writes it back on its next save; a database restored underneath a running
 * server would be overwritten. Restore, then start the server.
 *
 * Safe by default:
 *   - every file is checked against the checksum in the archive's manifest
 *     before anything is put in place
 *   - an archive containing anything unexpected is refused
 *   - a folder that already holds data is refused; with --force what is there
 *     is moved into pre-restore-<time>/ first, never deleted
 *
 * Encrypted files stay encrypted: the server must run with the same
 * NORD_FILE_ENC_KEY it had when the backup was made (or have that key in
 * NORD_FILE_ENC_KEY_PREVIOUS). Sessions and two-step sign-in likewise need
 * the same JWT_SECRET.
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--to");
if (args.includes("--help") || args.includes("-h") || positional.length !== 1) {
  console.log("Usage: npm run restore -- <archive.tar.gz> [--to <data folder>] [--force]\nStop the server first. Default folder: ./data (or QUOTING_DATA_DIR).");
  process.exit(positional.length === 1 ? 0 : 1);
}

const root = path.join(__dirname, "..", "..");
const target = path.resolve(flag("--to") || process.env.QUOTING_DATA_DIR || path.join(root, "data"));
const archivePath = path.resolve(positional[0]);

(async () => {
  if (!fs.existsSync(archivePath)) { console.error(`No such file: ${archivePath}`); process.exit(1); }
  const archive = require("../../server/ops/backupArchive");
  const r = await archive.extract(archivePath, target, { force: args.includes("--force"), log: (l) => console.log(`  ${l}`) });
  console.log(`Restored ${r.files} files (${(r.bytes / 1e6).toFixed(1)} MB) into ${target}`);
  console.log(`  Backup made: ${r.manifest.createdAt}; file encryption at the time: ${r.manifest.fileEncryption || "unknown"}.`);
  if (r.movedAside) console.log(`  What was there before is in ${r.movedAside}. Delete it once the restored site checks out.`);
  console.log("  Now start the server, sign in, and check an order, a quote and a part preview (docs/launch/go-live-runbook.md, the restore section).");
})().catch((err) => { console.error(`Restore failed: ${err.message}\nNothing was changed in ${target}.`); process.exit(1); });
