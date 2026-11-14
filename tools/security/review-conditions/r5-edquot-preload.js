/**
 * Review of the review-conditions fixes (2026-11-13): the author's server/testSupport/fullDiskPreload.js
 * with one difference. While the flag file exists every write of the database's temporary file fails
 * with EDQUOT ("disk quota exceeded"), which is what a volume with a quota reports where a plain full
 * disk reports ENOSPC. The author treated the two alike in code and ran only ENOSPC.
 *
 *   NODE_OPTIONS="--require <this file>" SE_TEST_DISK_FULL_FLAG=/path/to/flag node server/index.js
 *
 * R5_FAIL_AT=open makes the OPEN of the temporary file fail instead of the write (no inode left, or a
 * quota that refuses a new file).
 */
const fs = require("fs");

const flag = process.env.SE_TEST_DISK_FULL_FLAG;
if (flag) {
  const real = { openSync: fs.openSync, closeSync: fs.closeSync, writeSync: fs.writeSync };
  const watched = new Set();
  const refuse = (syscall) => Object.assign(new Error(`EDQUOT: disk quota exceeded, ${syscall}`), { code: "EDQUOT", errno: -122, syscall });
  fs.openSync = function openSync(file, ...rest) {
    const isTmp = /quoting\.db\.tmp$/.test(String(file));
    if (isTmp && process.env.R5_FAIL_AT === "open" && fs.existsSync(flag)) throw refuse("open");
    const fd = real.openSync.call(fs, file, ...rest);
    if (isTmp) watched.add(fd);
    return fd;
  };
  fs.closeSync = function closeSync(fd) {
    watched.delete(fd);
    return real.closeSync.call(fs, fd);
  };
  fs.writeSync = function writeSync(fd, ...rest) {
    if (watched.has(fd) && fs.existsSync(flag)) throw refuse("write");
    return real.writeSync.call(fs, fd, ...rest);
  };
}
