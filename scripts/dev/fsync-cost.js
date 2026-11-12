#!/usr/bin/env node
/**
 * What flushing every database save to disk costs (server/models/database.js writeDurably).
 *
 *   node scripts/dev/fsync-cost.js [folder]     default: data/fsync-cost-<pid> (removed afterwards)
 *
 * Writes a 5 MB and a 50 MB file the old way (write a temporary file, rename) and the way the
 * database is saved now (write, fsync the file, rename, fsync the folder), in turn, and prints the
 * median, 90th percentile and worst time of each and the difference. Run it on the machine and the
 * disk the database lives on: a memory-backed folder (tmpfs) flushes for free and proves nothing.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeDurably } = require("../../server/models/database");

const dir = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "data", `fsync-cost-${process.pid}`));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "quoting.db");
const plain = (buf) => { fs.writeFileSync(`${file}.tmp`, buf); fs.renameSync(`${file}.tmp`, file); };
const stats = (a) => { a.sort((x, y) => x - y); return { median: a[Math.floor(a.length / 2)], p90: a[Math.floor(a.length * 0.9)], max: a[a.length - 1] }; };
const ms = (n) => `${n.toFixed(1)} ms`;

try {
  for (const [mb, rounds] of [[5, 30], [50, 10]]) {
    const buf = crypto.randomBytes(mb * 1024 * 1024);
    const t = { plain: [], durable: [] };
    for (let i = 0; i < rounds; i++) {
      for (const [name, fn] of [["plain", plain], ["durable", (b) => writeDurably(file, b)]]) {
        const t0 = process.hrtime.bigint();
        fn(buf);
        t[name].push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    }
    const p = stats(t.plain), d = stats(t.durable);
    console.log(`${String(mb).padStart(2)} MB x ${rounds}: write + rename ${ms(p.median)} (p90 ${ms(p.p90)}, worst ${ms(p.max)})  |  with both flushes ${ms(d.median)} (p90 ${ms(d.p90)}, worst ${ms(d.max)})  |  added per save: ${ms(d.median - p.median)} median`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
