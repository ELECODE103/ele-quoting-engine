// .env.example is the one list of settings the owner reads. This keeps it honest:
// every limit in limits.js is on it exactly once, with the default the code has, and no setting is on it twice.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const limitsSource = fs.readFileSync(path.join(__dirname, "limits.js"), "utf8");

// A setting line is "NAME=value" or "# NAME=value" at the start of a line.
const listed = [];
for (const line of example.split("\n")) {
  const m = /^#?\s?([A-Z][A-Z0-9_]+)=(\S*)/.exec(line);
  if (m) listed.push({ name: m[1], value: m[2] });
}
const valuesOf = (name) => listed.filter((l) => l.name === name).map((l) => l.value);

// Limits whose default is worked out from another setting: the figure shown is the one at the default memory budget.
const DERIVED_AT_DEFAULTS = {
  UPLOAD_PROTECTED_MB_PER_HOLDER: (limits) => limits.uploadProtectedBytesPerHolder / (1024 * 1024),
  PARSE_MAX_HEAP_MB: (limits) => limits.parseMaxHeapMb,
  PARSE_RSS_LIMIT_MB: (limits) => limits.parseRssLimitMb,
  PARSE_RSS_SOLO_LIMIT_MB: (limits) => limits.parseRssSoloLimitMb,
  PARSE_RSS_CEILING_MB: (limits) => limits.parseRssCeilingMb,
  // 2 on any machine with more than two cores, which is what the example says in words.
  PARSE_CONCURRENCY: () => 2,
};

function limitsAtDefaults() {
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (new RegExp(`envInt\\("${key}"`).test(limitsSource)) { saved[key] = process.env[key]; delete process.env[key]; }
  }
  delete require.cache[require.resolve("./limits")];
  const { limits } = require("./limits");
  return { limits, restore: () => Object.assign(process.env, saved) };
}

test("every limit is in .env.example once, with the default the code has", () => {
  const { limits, restore } = limitsAtDefaults();
  try {
    const found = [...limitsSource.matchAll(/envInt\("([A-Z0-9_]+)",\s*([^,]+),/g)];
    assert.ok(found.length > 100, `only ${found.length} limits found in limits.js: the pattern no longer matches`);
    const problems = [];
    const seen = new Set();
    for (const [, name, def] of found) {
      if (seen.has(name)) continue;
      seen.add(name);
      const values = valuesOf(name);
      if (values.length !== 1) { problems.push(`${name}: listed ${values.length} times`); continue; }
      let expected;
      if (/^\d+$/.test(def.trim())) expected = Number(def);
      else if (DERIVED_AT_DEFAULTS[name]) expected = DERIVED_AT_DEFAULTS[name](limits);
      else { problems.push(`${name}: its default is worked out in code (${def.trim()}) and this test has no figure for it`); continue; }
      if (Number(values[0]) !== expected) problems.push(`${name}: the example shows ${values[0]}, the code's default is ${expected}`);
    }
    assert.deepStrictEqual(problems, []);
  } finally { restore(); }
});

test("no setting is in .env.example twice", () => {
  const counts = new Map();
  for (const l of listed) counts.set(l.name, (counts.get(l.name) || 0) + 1);
  const twice = [...counts].filter(([, n]) => n > 1).map(([name, n]) => `${name} (${n} times)`);
  assert.deepStrictEqual(twice, []);
});

test("every setting the server reads by name is in .env.example", () => {
  // Settings a deploy never sets: the platform's own, test hooks, and the measuring tools'.
  const NOT_FOR_THE_OWNER = new Set([
    "NODE_ENV", "PORT", "SE_TEST_HOOKS", "PARSE_TEST_DELAY_MS", "PARSE_TEST_DELAY_EXT", "HAMMER_OUT", "HAMMER_HOOK",
    "GEOMETRY_SKIP_PERF", "PARSE_MEMORY_RANKING",
    // Where the data folder is: tests and local tools point it elsewhere; the live site uses the volume at data/.
    "QUOTING_DATA_DIR", "QUOTING_DB_PATH",
    "RAILWAY_PUBLIC_DOMAIN", "RAILWAY_GIT_BRANCH", "RAILWAY_DEPLOYMENT_ID", "RAILWAY_GIT_COMMIT_SHA", "SOURCE_COMMIT", "GIT_COMMIT",
  ]);
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "testSupport") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]);
      }
    }
  };
  walk(path.join(root, "server"));
  const missing = [...names].filter((n) => !NOT_FOR_THE_OWNER.has(n) && valuesOf(n).length === 0).sort();
  assert.deepStrictEqual(missing, []);
});
