/**
 * Sign-in throttling.
 *
 * Two counters, both of failures only (a correct sign-in is never counted and
 * clears the account's count):
 *
 *   per IP       after CHALLENGE_AFTER failures in 15 minutes the bot check is
 *                asked for (when it is configured); after IP_MAX_FAILURES the
 *                address is refused for the rest of the window. This is the
 *                brake on one machine trying many accounts.
 *   per account  LOCK_AFTER wrong passwords in 15 minutes pause sign-in to that
 *                address for LOCK_MINUTES, whoever is asking and from wherever,
 *                and the account's owner is emailed. This is the brake on many
 *                machines trying one account.
 *
 * The per-account counter is keyed on the address as typed, whether or not an
 * account exists for it, and the answers are the same either way, so the
 * pause cannot be used to find out which addresses have accounts. Counters
 * live in memory; a pause on a real account is also written to its row so it
 * survives a restart.
 */
const { createThrottle, createTtlStore } = require("./throttle");

const WINDOW_MS = 15 * 60 * 1000;
const CHALLENGE_AFTER = 3;
const IP_MAX_FAILURES = 20;
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

const ipFailures = createThrottle({ windowMs: WINDOW_MS, max: IP_MAX_FAILURES });
const accountFailures = createThrottle({ windowMs: WINDOW_MS, max: LOCK_AFTER });
const locks = createTtlStore({ ttlMs: LOCK_MINUTES * 60 * 1000 }); // address → locked-until (ms)

/** Until when (ms) sign-in to this address is paused, or 0. `user` is the account row when there is one. */
function lockedUntil(emailKey, user, now = Date.now()) {
  const mem = locks.get(emailKey, now) || 0;
  const stored = user && user.lockedUntil ? new Date(user.lockedUntil).getTime() : 0;
  const until = Math.max(mem, Number.isFinite(stored) ? stored : 0);
  return until > now ? until : 0;
}

function ipBlocked(ip, now = Date.now()) {
  return ipFailures.peek(ip, now).limited;
}

/** Should this attempt carry a passed bot check? */
function challengeDue(ip, emailKey, now = Date.now()) {
  return ipFailures.peek(ip, now).count >= CHALLENGE_AFTER || accountFailures.peek(emailKey, now).count >= CHALLENGE_AFTER;
}

/**
 * Count one failed attempt.
 * @returns {{locked: boolean, until: number}} `locked` is true on the attempt that starts a pause
 */
function recordFailure(ip, emailKey, now = Date.now()) {
  ipFailures.hit(ip, now);
  const a = accountFailures.hit(emailKey, now);
  if (a.count >= LOCK_AFTER) {
    const until = now + LOCK_MINUTES * 60 * 1000;
    locks.set(emailKey, until, now);
    accountFailures.reset(emailKey);
    return { locked: true, until };
  }
  return { locked: false, until: 0 };
}

/** A correct sign-in, or a password reset: the account's count and pause are gone. */
function clear(emailKey) {
  accountFailures.reset(emailKey);
  locks.delete(emailKey);
}

function resetForTests() {
  ipFailures.reset();
  accountFailures.reset();
  locks.clear();
}

module.exports = { lockedUntil, ipBlocked, challengeDue, recordFailure, clear, resetForTests, CHALLENGE_AFTER, IP_MAX_FAILURES, LOCK_AFTER, LOCK_MINUTES, WINDOW_MS };
