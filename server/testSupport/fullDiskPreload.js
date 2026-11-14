/**
 * Test support: a disk that is "full" for the database file, switched on and off by a flag file.
 *
 *   NODE_OPTIONS="--require <this file>"  SE_TEST_DISK_FULL_FLAG=/path/to/flag  node server/index.js
 *
 * While the flag file exists, every write to the database's temporary file (quoting.db.tmp, the
 * only place models/database.js writes the database) fails with ENOSPC, exactly as the kernel
 * reports a full disk. Remove the flag file and writes succeed again: "space was freed" without a
 * restart and without a real small disk (which needs root to mount). Nothing else is touched.
 * Does nothing at all unless SE_TEST_DISK_FULL_FLAG is set. Used by server/models/diskFull.test.js;
 * tools/security/rereview-fixes/r4-full-disk.js shows the same on a real 3 MB disk.
 */
const fs = require("fs");

const flag = process.env.SE_TEST_DISK_FULL_FLAG;
if (flag) {
  const real = { openSync: fs.openSync, closeSync: fs.closeSync, writeSync: fs.writeSync };
  const watched = new Set();
  fs.openSync = function openSync(file, ...rest) {
    const fd = real.openSync.call(fs, file, ...rest);
    if (/quoting\.db\.tmp$/.test(String(file))) watched.add(fd);
    return fd;
  };
  fs.closeSync = function closeSync(fd) {
    watched.delete(fd);
    return real.closeSync.call(fs, fd);
  };
  fs.writeSync = function writeSync(fd, ...rest) {
    if (watched.has(fd) && fs.existsSync(flag)) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
    return real.writeSync.call(fs, fd, ...rest);
  };
}
