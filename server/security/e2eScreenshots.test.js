/**
 * The browser suites never write over the committed screenshots unless told to.
 *
 * scripts/e2e/hardening-accounts.mjs used to default its screenshots to
 * docs/screenshots/hardening-2026-11-11: a plain verification run rewrote 30 committed files
 * (journey-qa report, section 11; it happened, and they were restored from git). Now every
 * browser script writes screenshots under its --scratch folder unless --shots names one, and the
 * script that has no scratch default refuses to start without --shots.
 *
 * This holds the rule in the source, where the default is decided, and evaluates each script's
 * own default expression. The scripts themselves need a browser; a run of each without --shots
 * leaving `git status` clean is recorded in docs/security/relaunch-integration-2026-11-12.md.
 * Run: node server/security/e2eScreenshots.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { runner } = require("../testSupport/harness");

const { test, run } = runner("Browser suites: screenshots default to scratch");
const ROOT = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** The source with comments removed, so a path named in a comment does not count as one that is used. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

const SCRATCH_DEFAULT = ["scripts/e2e/hardening-accounts.mjs", "scripts/e2e/order-lifecycle.mjs"];
const ALL = [...SCRATCH_DEFAULT, "scripts/e2e/journey-qa.mjs", "tools/security/csp-browser-check.js"];

for (const file of SCRATCH_DEFAULT) {
  test(`${file}: without --shots the screenshots go under --scratch; with it, where it says`, () => {
    const line = (code(read(file)).match(/^const SHOTS = (.+);$/m) || [])[1];
    assert.ok(line, "the script decides SHOTS in one line");
    // Evaluate the script's own expression with and without the flag.
    const evaluate = (argv) => {
      const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
      return new Function("arg", "path", "ROOT", "SCRATCH", `return ${line};`)(arg, path, ROOT, "/scratch/run-1");
    };
    assert.strictEqual(evaluate([]), path.join("/scratch/run-1", "shots"));
    assert.ok(!evaluate([]).startsWith(ROOT), "the default is outside the repository");
    assert.strictEqual(evaluate(["--shots", "docs/screenshots/x"]), path.join(ROOT, "docs", "screenshots", "x"));
    assert.ok(/if \(!arg\('scratch', ''\)\) \{[^}]*process\.exit\(2\)/.test(read(file)), "and it does not start without --scratch");
  });
}

test("journey-qa.mjs has no default at all: it refuses to start without --scratch and --shots", () => {
  const text = code(read("scripts/e2e/journey-qa.mjs"));
  assert.ok(/if \(!arg\('scratch', ''\) \|\| !arg\('shots', ''\)\) \{[^}]*process\.exit\(2\)/.test(text));
  assert.ok(/^const SHOTS = path\.resolve\(arg\('shots'\)\);$/m.test(text));
});

test("no browser script names a folder under docs/ in its code: only in comments and usage lines", () => {
  for (const file of ALL) {
    const used = code(read(file)).split("\n").filter((l) => /docs[\\/]+screenshots|['"`]docs['"`]\s*,\s*['"`]screenshots['"`]/.test(l) && !/console\.(log|error)\(/.test(l));
    assert.deepStrictEqual(used, [], `${file} uses a docs/screenshots path in code: ${used.join(" | ")}`);
  }
});

run();
