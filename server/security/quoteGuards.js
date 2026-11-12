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
const counters = { created: 0, refusedRate: 0, refusedDatabase: 0, refusedBytes: 0, refusedReprice: 0, replacedOwn: 0 };

const GROWTH_SLACK_BYTES = 2048;
const { UsageWindow } = require("../services/usageWindow");
const repricesByQuote = new UsageWindow({ windowMs: HOUR });

const MESSAGES = {
  draftsFullClient: `There are a lot of quotes open from this network. Keep working on one you already have open, or sign in to save more. For a big job, email the files to ${brand.email} or call ${brand.phone} and we'll quote it by hand.`,
  draftsFullAccount: `Your account has as many saved quotes as we keep for one account. Open one you already have and change it, or email ${brand.email} and we'll clear out the old ones or quote the job by hand.`,
  repriceLimit: `This quote has been changed a great many times in the last hour. Give it a few minutes and it will price again, or email the files to ${brand.email} and we'll quote it by hand.`,
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
    // A refused quote asks for a clean-up pass now, as a refused upload does.
    try { require("../services/storagePressure").nudge(require("../models")); } catch { /* best effort */ }
    throw refusal(503, room.reserved ? "quotes-paused" : "storage-full", room.reserved ? MESSAGES.databaseAnonymous : MESSAGES.databaseFull, 900);
  }
}

/**
 * May this draft be stored at this size? Asked for a NEW row and for a re-price that makes a row
 * bigger (independent re-review 2026-11-12, RR-01 and RR-02: the limits used to count rows, and a
 * re-price was never asked anything, so one sender could fill the database with a few large
 * drafts or by growing small ones).
 *
 *   per address   QUOTE_DRAFT_KB_PER_CLIENT of drafts as stored. A visitor at the allowance makes
 *                 room with that address's own no-account drafts nobody has touched for ten
 *                 minutes, oldest first; only if that is not enough is the request refused.
 *   per account   QUOTE_DRAFT_KB_PER_ACCOUNT. An account's saved quotes are never removed to make
 *                 room for its next one: the request is refused and says so.
 *   the database  a re-price that grows a row is held to the ceiling like a new row.
 *
 * @param {{ user?: object|null, clientKey?: string, bytes: number, existing?: { id: string, bytes: number }|null }} what
 *        bytes: the row as it would be stored (quotesDB.sizeOf). existing: the row a re-price replaces.
 */
function assertRoomForDraft({ user = null, clientKey = "", bytes = 0, existing = null } = {}) {
  if (existing && bytes <= existing.bytes) return; // not growing: nothing to ask
  const { quotesDB } = require("../models");
  if (typeof quotesDB.draftBytesHeld !== "function") return;
  const guards = require("./uploadGuards");
  const clientTag = clientKey ? guards.clientTag(clientKey) : "";
  const userId = user && user.userId ? user.userId : "";
  const exceptId = existing ? existing.id : "";
  let held = quotesDB.draftBytesHeld({ clientTag, userId, exceptId });
  if (userId && held.account + bytes > limits.quoteDraftBytesPerAccount) {
    counters.refusedBytes++;
    throw refusal(429, "drafts-full", MESSAGES.draftsFullAccount);
  }
  if (clientTag && held.client + bytes > limits.quoteDraftBytesPerClient) {
    // Make room with this address's own idle no-account drafts.
    const idleBefore = Date.now() - 10 * 60 * 1000;
    let need = held.client + bytes - limits.quoteDraftBytesPerClient;
    const mine = quotesDB.ownAnonymousDrafts(clientTag).filter((d) => d.id !== exceptId && Date.parse(d.touched) < idleBefore);
    const go = [];
    for (const d of mine) { if (need <= 0) break; go.push(d.id); need -= d.bytes; }
    if (need > 0) {
      counters.refusedBytes++;
      throw refusal(429, "drafts-full", userId ? MESSAGES.draftsFullAccount : MESSAGES.draftsFullClient, 600);
    }
    require("../models/database").deferred(() => { for (const id of go) quotesDB.delete(id); });
    counters.replacedOwn += go.length;
    held = quotesDB.draftBytesHeld({ clientTag, userId, exceptId });
  }
  if (existing && bytes > existing.bytes + GROWTH_SLACK_BYTES) {
    // A re-price that really grows the row (lines added, not a quantity changed): the ceiling
    // applies as it does to a new row. Whatever the size of the step, the sender's allowance above
    // has already bounded what all its drafts together may hold.
    const room = guards.database.roomFor(user);
    if (!room.ok) {
      counters.refusedDatabase++;
      throw refusal(503, room.reserved ? "quotes-paused" : "storage-full", room.reserved ? MESSAGES.databaseAnonymous : MESSAGES.databaseFull, 900);
    }
  }
}

/** May this quote be re-priced once more this hour? (A person changes a quote a few hundred times at most.) */
function assertMayReprice(quoteId) {
  if (!quoteId) return;
  const max = limits.quoteRepricePerQuoteHour;
  if (repricesByQuote.total(quoteId) >= max) {
    counters.refusedReprice++;
    const retry = Math.min(3600, repricesByQuote.retryAfterSeconds(quoteId, max - 1));
    throw refusal(429, "reprice-limit", MESSAGES.repriceLimit, retry);
  }
}

function recordReprice(quoteId) {
  if (quoteId) repricesByQuote.add(quoteId, 1);
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
  repricesByQuote.reset();
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = { assertMayCreate, recordCreated, assertRoomForDraft, assertMayReprice, recordReprice, stats, resetForTests, MESSAGES };
