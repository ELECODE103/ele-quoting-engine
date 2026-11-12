/**
 * Limits on NEW draft-quote rows (independent review 2026-11-11, H3).
 *
 * The quote tool re-prices one row for as long as a visitor works on a quote;
 * only starting a new quote inserts a row. A script that posted without a
 * quote id inserted one row per request: 925 of them, with no upload at all,
 * took the database to its ceiling and closed uploads for every customer.
 *
 *   per client key   QUOTE_NEW_PER_CLIENT_HOUR (30) and QUOTE_NEW_PER_CLIENT_DAY (120)
 *   per account      QUOTE_NEW_PER_ACCOUNT_HOUR (60) and QUOTE_NEW_PER_ACCOUNT_DAY (240)
 *   the database     new drafts from visitors without a confirmed account stop
 *                    at the anonymous share of the database ceiling
 *                    (security/uploadGuards.js `database.roomFor`); a customer
 *                    with a confirmed email keeps going into the reserved share.
 *                    Re-pricing an existing quote, checkout, sign-in, orders
 *                    and payment notices never ask this question.
 *
 * A buyer starts a handful of quotes a day; these numbers are far above that
 * and far below what fills a database. Counters are in memory.
 */
const { limits } = require("./limits");
const brand = require("../../shared/brand.json");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_KEYS = 50000;

/** A sliding-window counter whose ceiling is read when it is asked (so the limit can be tuned without a restart). */
function counter(windowMs) {
  const hits = new Map(); // key → timestamps
  const live = (key, now) => {
    const list = hits.get(key);
    if (!list) return [];
    while (list.length && now - list[0] >= windowMs) list.shift();
    if (!list.length) hits.delete(key);
    return list;
  };
  return {
    count: (key, now = Date.now()) => live(key, now).length,
    hit(key, now = Date.now()) {
      let list = hits.get(key);
      if (!list) {
        if (hits.size >= MAX_KEYS) { let n = Math.ceil(MAX_KEYS / 10); for (const k of hits.keys()) { hits.delete(k); if (--n <= 0) break; } }
        list = [];
        hits.set(key, list);
      }
      list.push(now);
    },
    /** ms until the oldest hit that counts against `max` leaves the window */
    retryAfterMs(key, max, now = Date.now()) {
      const list = live(key, now);
      return list.length >= max ? Math.max(0, windowMs - (now - list[list.length - max])) : 0;
    },
    reset: () => hits.clear(),
    size: () => hits.size,
  };
}

const perClientHour = counter(HOUR);
const perClientDay = counter(DAY);
const perAccountHour = counter(HOUR);
const perAccountDay = counter(DAY);
const counters = { created: 0, refusedRate: 0, refusedDatabase: 0 };

const MESSAGES = {
  rate: `You've started a lot of new quotes in a short time. Keep working on a quote you already have open, or try again later. For a big job, email the files to ${brand.email} or call ${brand.phone} and we'll quote it by hand.`,
  databaseAnonymous: `We can't save new quotes for visitors without an account right now. Sign in (or create an account and confirm your email) and it will work, or email your files to ${brand.email} and we'll quote them by hand.`,
  databaseFull: `We can't save new quotes right now. Email your files to ${brand.email} or call ${brand.phone} and we'll quote them by hand.`,
};

function refusal(status, code, message, retryAfterSeconds) {
  return Object.assign(new Error(message), { status, expose: true, extra: { code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) }, retryAfterSeconds });
}

/**
 * May a new quote row be created? Throws a refusal the pricing route knows how
 * to answer (status, message, code); returns nothing when the answer is yes.
 * @param {{ user?: object|null, clientKey?: string }} who
 */
function assertMayCreate({ user = null, clientKey = "" } = {}) {
  const now = Date.now();
  const checks = [];
  if (clientKey) checks.push([perClientHour, clientKey, limits.quoteNewPerClientHour], [perClientDay, clientKey, limits.quoteNewPerClientDay]);
  if (user && user.userId) checks.push([perAccountHour, user.userId, limits.quoteNewPerAccountHour], [perAccountDay, user.userId, limits.quoteNewPerAccountDay]);
  for (const [c, key, max] of checks) {
    if (c.count(key, now) >= max) {
      counters.refusedRate++;
      throw refusal(429, "quote-limit", MESSAGES.rate, Math.max(60, Math.ceil(c.retryAfterMs(key, max, now) / 1000)));
    }
  }
  const room = require("./uploadGuards").database.roomFor(user);
  if (!room.ok) {
    counters.refusedDatabase++;
    throw refusal(503, room.reserved ? "quotes-paused" : "storage-full", room.reserved ? MESSAGES.databaseAnonymous : MESSAGES.databaseFull, 900);
  }
}

/** Count a row that was created. */
function recordCreated({ user = null, clientKey = "" } = {}) {
  const now = Date.now();
  counters.created++;
  if (clientKey) { perClientHour.hit(clientKey, now); perClientDay.hit(clientKey, now); }
  if (user && user.userId) { perAccountHour.hit(user.userId, now); perAccountDay.hit(user.userId, now); }
}

function stats() {
  return { ...counters, clientsCounted: perClientDay.size(), accountsCounted: perAccountDay.size() };
}

/** Tests only. */
function resetForTests() {
  for (const c of [perClientHour, perClientDay, perAccountHour, perAccountDay]) c.reset();
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = { assertMayCreate, recordCreated, stats, resetForTests, MESSAGES };
