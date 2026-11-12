/**
 * A few facts the operations code must remember across a restart, kept in one
 * small JSON file on the volume (data/ops/state.json):
 *
 *   - when each kind of alert was last emailed (so a crash loop or a string of
 *     redeploys cannot send the same alert again and again)
 *   - the day the daily digest was last sent (so a restart at five past the
 *     hour does not send a second one, and a restart across the hour does not
 *     skip one)
 *   - how the previous run ended (clean stop, crash, or neither — killed)
 *
 * Nothing here is a secret and nothing here is customer data. If the file
 * cannot be read or written the code carries on with what it has in memory:
 * losing this file costs at most one repeated alert.
 */
const fs = require("fs");
const path = require("path");

function dataDir() {
  // The same rule as security/uploadGuards.js (QUOTING_DATA_DIR moves it for tests), without loading that module here.
  return process.env.QUOTING_DATA_DIR ? path.resolve(process.env.QUOTING_DATA_DIR) : path.join(__dirname, "..", "..", "data");
}

function statePath() {
  return path.join(dataDir(), "ops", "state.json");
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  const file = statePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache || {}, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    // Read-only or missing volume: keep going on memory alone.
    if (!save.warned) { save.warned = true; console.warn(`[ops] could not write ${path.relative(process.cwd(), file)} (${err.code || err.name}); alert and digest timing will not survive a restart`); }
    return false;
  }
}

function get(key, fallback = undefined) {
  const s = load();
  return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : fallback;
}

function set(key, value) {
  load()[key] = value;
  return save();
}

/** Forget what is cached (tests, which move the data folder between cases). */
function reset() {
  cache = null;
  save.warned = false;
}

module.exports = { get, set, reset, statePath, dataDir };
