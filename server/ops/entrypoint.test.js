/**
 * The container's start-up wrapper (docker-entrypoint.sh): a root-owned
 * volume is made writable for the unprivileged user, the server then runs as
 * that user with no privileges left, and SIGTERM reaches the server itself.
 *
 * Needs root and util-linux's setpriv (both true inside the image, and in CI
 * containers); anywhere else the cases are skipped and say so.
 * Run: node server/ops/entrypoint.test.js
 */
const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runner } = require("../testSupport/harness");

const { test, run } = runner("Container entrypoint");
const SCRIPT = path.join(__dirname, "..", "..", "docker-entrypoint.sh");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const hasSetpriv = spawnSync("setpriv", ["--version"], { encoding: "utf8" }).status === 0;
const nobody = spawnSync("id", ["-u", "nobody"], { encoding: "utf8" });
const can = isRoot && hasSetpriv && nobody.status === 0;
const NOBODY_UID = Number(nobody.stdout);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-entry-"));
fs.chmodSync(tmp, 0o755);

function volume(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(dir, "quoting.db"), "db");
  fs.writeFileSync(path.join(dir, "uploads", "a.stl.enc"), "file");
  return dir; // owned by root, like a freshly mounted Railway volume with restored data on it
}
const start = (dir, args, extraEnv = {}) => spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, SE_DATA_DIR: dir, SE_RUN_USER: "nobody", ...extraEnv } });

test("the script is plain POSIX sh and executable", () => {
  assert.ok(fs.statSync(SCRIPT).mode & 0o111, "executable bit set in the repository");
  const text = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(text.startsWith("#!/bin/sh\n"));
  assert.ok(!/\r/.test(text), "no Windows line endings (the script would not start)");
  assert.strictEqual(spawnSync("sh", ["-n", SCRIPT]).status, 0, "syntax check");
});

if (!can) {
  test(`skipped: needs root, setpriv and a "nobody" user (root: ${isRoot}, setpriv: ${hasSetpriv})`, () => {});
} else {
  test("a root-owned volume: ownership is fixed, the command runs unprivileged and can write to it", () => {
    const dir = volume("vol1");
    const r = start(dir, ["sh", "-c", "id -u; id -G; grep -E '^Cap(Prm|Eff):' /proc/self/status; echo written > \"$SE_DATA_DIR/quoting.db\" && mkdir \"$SE_DATA_DIR/part-payloads\" && echo ok"]);
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.ok(/making .* writable by nobody/.test(lines[0]), r.stdout);
    assert.strictEqual(Number(lines[1]), NOBODY_UID, "runs as the unprivileged user");
    assert.ok(!lines[2].split(" ").includes("0"), "root's group is not kept");
    assert.ok(/CapPrm:\s+0+$/.test(lines[3]) && /CapEff:\s+0+$/.test(lines[4]), `no capability survives the hand-over:\n${r.stdout}`);
    assert.strictEqual(lines[lines.length - 1], "ok", "the data folder is writable");
    for (const f of ["", "quoting.db", "uploads", "uploads/a.stl.enc", "part-payloads"]) assert.strictEqual(fs.statSync(path.join(dir, f)).uid, NOBODY_UID, f || "the folder itself");
  });

  test("a second start changes nothing and says nothing; one stray root-owned file is put right", () => {
    const dir = volume("vol2");
    start(dir, ["true"]);
    const again = start(dir, ["sh", "-c", "echo up"]);
    assert.strictEqual(again.stdout, "up\n", "no ownership pass when everything is already right");
    fs.writeFileSync(path.join(dir, "uploads", "restored-by-root.stl"), "x"); // e.g. a file copied in over railway ssh
    const fix = start(dir, ["true"]);
    assert.ok(/making .* writable/.test(fix.stdout));
    assert.strictEqual(fs.statSync(path.join(dir, "uploads", "restored-by-root.stl")).uid, NOBODY_UID);
  });

  test("a data folder that does not exist yet is created (no volume attached)", () => {
    const dir = path.join(tmp, "fresh", "data");
    fs.mkdirSync(path.join(tmp, "fresh"), { mode: 0o755 });
    const r = start(dir, ["sh", "-c", "touch \"$SE_DATA_DIR/x\" && echo ok"]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim().endsWith("ok"));
  });

  test("started as a non-root user on a root-owned volume: it stops with the reason instead of failing later on the first save", () => {
    const dir = volume("vol3");
    const r = spawnSync("setpriv", [`--reuid=${NOBODY_UID}`, `--regid=${NOBODY_UID}`, "--clear-groups", "sh", SCRIPT, "sh", "-c", "echo should-not-run"], { encoding: "utf8", env: { ...process.env, SE_DATA_DIR: dir } });
    assert.strictEqual(r.status, 1);
    assert.ok(/FATAL: .* is not writable by uid/.test(r.stderr) && /RAILWAY_RUN_UID/.test(r.stderr), r.stderr);
    assert.ok(!r.stdout.includes("should-not-run"));
    // …and when the folder is writable for that user, it simply runs.
    fs.chownSync(dir, NOBODY_UID, NOBODY_UID);
    const ok = spawnSync("setpriv", [`--reuid=${NOBODY_UID}`, `--regid=${NOBODY_UID}`, "--clear-groups", "sh", SCRIPT, "sh", "-c", "echo runs"], { encoding: "utf8", env: { ...process.env, SE_DATA_DIR: dir } });
    assert.strictEqual(ok.stdout, "runs\n");
  });

  test("the server replaces the script (same process id) and receives SIGTERM itself", async () => {
    const dir = volume("vol4");
    const child = spawn("sh", [SCRIPT, process.execPath, "-e", "process.on('SIGTERM',()=>{console.log('SIGTERM uid '+process.getuid()+' pid '+process.pid);process.exit(0)});console.log('up '+process.pid);setTimeout(()=>{},10000)"], { env: { ...process.env, SE_DATA_DIR: dir, SE_RUN_USER: "nobody" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    await new Promise((resolve) => { const t = setInterval(() => { if (/up \d+/.test(out)) { clearInterval(t); resolve(); } }, 20); });
    assert.ok(out.includes(`up ${child.pid}`), `exec, not a child process: ${out} vs ${child.pid}`);
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    assert.deepStrictEqual(await exited, { code: 0, signal: null });
    assert.ok(out.includes(`SIGTERM uid ${NOBODY_UID} pid ${child.pid}`), out);
  });
}

run(() => fs.rmSync(tmp, { recursive: true, force: true }));
