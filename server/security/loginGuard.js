/**
 * Sign-in throttling (redesigned after the independent review of 2026-11-11, F4).
 *
 * The old brake was a hard pause on the ADDRESS: five wrong passwords from
 * anywhere and nobody — the account's real owner included — could sign in for
 * fifteen minutes. Anyone who knew an address could hold it shut for good.
 *
 * Guessing is still slow; the real user is no longer what pays for it:
 *
 *   known device     A browser that has signed in to the account before holds
 *                    a signed device proof (security/deviceProof.js). Its
 *                    attempts are counted per DEVICE only: nothing an outsider
 *                    does to the address touches it. (A device that itself
 *                    keeps failing — DEVICE_MAX in 15 minutes — is treated as
 *                    unknown for the rest of that window.)
 *   everyone else    per client (IP, IPv6 by /64):
 *                      - CHALLENGE_AFTER failures → the bot check is asked for
 *                      - from the FREE_ATTEMPTS-th wrong password for one
 *                        address, an escalating wait before that client's next
 *                        try at that address (1, 2, 4, 8, then 15 minutes)
 *                      - IP_MAX_FAILURES in 15 minutes over all addresses →
 *                        that client is refused for the rest of the window
 *                    per address, summed over every unknown device:
 *                      - ACCOUNT_CHALLENGE_AFTER failures in an hour → the bot
 *                        check for EVERY unknown device (not a refusal);
 *                        ACCOUNT_NOTICE_AFTER → the owner is emailed, once a day
 *                      - ACCOUNT_CEILING failures in an hour → unknown devices
 *                        are refused until the hour moves on. Known devices
 *                        are not, and a password reset makes the browser that
 *                        completes it a known device, so the owner always has
 *                        a way in.
 *   second step      Wrong authenticator codes (the password was right) are
 *                    counted on their own: SECOND_FACTOR_MAX in 15 minutes
 *                    pauses the second step for unknown devices; a known
 *                    device has its own count.
 *
 * Guess rates this allows against ONE account (docs/security/review-fixes-2026-11-11.md):
 *   one source address    11 in the first hour, then 4 an hour (5 if it goes quiet for an hour and starts again)
 *   1,000 addresses       ACCOUNT_CEILING (100) an hour, however many addresses
 *
 * Every counter is keyed on the address as typed, whether or not an account
 * exists for it, and the answers are the same either way. Counters live in
 * memory (one process serves the site); a restart clears them.
 */
const { createThrottle } = require("./throttle");

const WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CHALLENGE_AFTER = 3;
const IP_MAX_FAILURES = 20;
const FREE_ATTEMPTS = 5;                        // wrong passwords one client may send for one address before it has to wait
const WAIT_STEPS_S = [60, 120, 240, 480, 900];  // the wait after the 5th, 6th, 7th, 8th and every later failure
const ACCOUNT_CHALLENGE_AFTER = 3;              // per address per hour, all unknown devices together: the bot check for every one of them
const ACCOUNT_NOTICE_AFTER = 20;                // per address per hour: the account's owner is told (once a day at most)
const ACCOUNT_CEILING = 100;                    // per address per hour, all unknown devices together
const DEVICE_MAX = 10;                          // failures a known device may make in 15 minutes
const SECOND_FACTOR_MAX = 5;                    // wrong codes per address (or per known device) in 15 minutes
const MAX_KEYS = 50000;

const BIG = Number.MAX_SAFE_INTEGER;
const ipFailures = createThrottle({ windowMs: WINDOW_MS, max: IP_MAX_FAILURES });
const accountFailures = createThrottle({ windowMs: HOUR_MS, max: ACCOUNT_CEILING });
const deviceFailures = createThrottle({ windowMs: WINDOW_MS, max: DEVICE_MAX });
const secondFactorFailures = createThrottle({ windowMs: WINDOW_MS, max: SECOND_FACTOR_MAX });
const pairFailures = new Map(); // "client|address" → { count, last }

function pairKey(ip, emailKey) { return `${ip}|${emailKey}`; }

function pairState(ip, emailKey, now) {
  const e = pairFailures.get(pairKey(ip, emailKey));
  if (!e) return { count: 0, last: 0 };
  if (now - e.last >= HOUR_MS) { pairFailures.delete(pairKey(ip, emailKey)); return { count: 0, last: 0 }; }
  return e;
}

function ipBlocked(ip, now = Date.now()) {
  return ipFailures.peek(ip, now).limited;
}

/** Milliseconds this client must still wait before its next try at this address (0: go ahead). */
function clientWaitMs(ip, emailKey, now = Date.now()) {
  const e = pairState(ip, emailKey, now);
  if (e.count < FREE_ATTEMPTS) return 0;
  const step = WAIT_STEPS_S[Math.min(WAIT_STEPS_S.length - 1, e.count - FREE_ATTEMPTS)] * 1000;
  return Math.max(0, e.last + step - now);
}

/** Where the address stands, counting every unknown device together. */
function accountState(emailKey, now = Date.now()) {
  const a = accountFailures.peek(emailKey, now);
  return { count: a.count, challenge: a.count >= ACCOUNT_CHALLENGE_AFTER, busy: a.limited, retryAfterMs: a.retryAfterMs };
}

/** Should this attempt (from an unknown device) carry a passed bot check? */
function challengeDue(ip, emailKey, now = Date.now()) {
  return ipFailures.peek(ip, now).count >= CHALLENGE_AFTER
    || pairState(ip, emailKey, now).count >= CHALLENGE_AFTER
    || accountFailures.peek(emailKey, now).count >= ACCOUNT_CHALLENGE_AFTER;
}

/** Has this known device used up its own allowance? (Then it is handled like any unknown device.) */
function deviceBlocked(deviceId, now = Date.now()) {
  return !deviceId || deviceFailures.peek(deviceId, now).limited;
}

/**
 * Count one wrong password (or wrong second-step code).
 * @param {{ip: string, emailKey: string, deviceId?: string|null}} who  deviceId: the known device the attempt came from, if any
 * @returns {{accountCount: number, noticeDue: boolean}} noticeDue: this failure is the one that crossed the
 *   address-wide challenge line (the moment to tell the account's owner, once)
 */
function recordFailure({ ip, emailKey, deviceId = null }, now = Date.now()) {
  if (deviceId) {
    deviceFailures.hit(deviceId, now);
    return { accountCount: accountFailures.peek(emailKey, now).count, noticeDue: false };
  }
  ipFailures.hit(ip, now);
  const key = pairKey(ip, emailKey);
  const e = pairState(ip, emailKey, now);
  if (pairFailures.size >= MAX_KEYS && !pairFailures.has(key)) sweep(now, true);
  pairFailures.set(key, { count: e.count + 1, last: now });
  const a = accountFailures.hit(emailKey, now);
  return { accountCount: a.count, noticeDue: a.count === ACCOUNT_NOTICE_AFTER };
}

/** Is the second step paused for this caller? (Only ever asked after a correct password.) */
function secondFactorPaused(emailKey, deviceId = null, now = Date.now()) {
  const s = secondFactorFailures.peek(deviceId ? `device:${deviceId}` : `address:${emailKey}`, now);
  return s.limited ? Math.max(1000, s.retryAfterMs) : 0;
}

function recordSecondFactorFailure(emailKey, deviceId = null, now = Date.now()) {
  secondFactorFailures.hit(deviceId ? `device:${deviceId}` : `address:${emailKey}`, now);
}

/** A correct sign-in (only the account's owner can make one): the address's counts start again. */
function recordSuccess({ ip, emailKey, deviceId = null }) {
  pairFailures.delete(pairKey(ip, emailKey));
  accountFailures.reset(emailKey);
  secondFactorFailures.reset(`address:${emailKey}`);
  if (deviceId) { deviceFailures.reset(deviceId); secondFactorFailures.reset(`device:${deviceId}`); }
}

/** A password reset: the address starts clean (the mailbox owner has just proved who they are). */
function clear(emailKey) {
  accountFailures.reset(emailKey);
  secondFactorFailures.reset(`address:${emailKey}`);
  for (const key of [...pairFailures.keys()]) if (key.endsWith(`|${emailKey}`)) pairFailures.delete(key);
}

function sweep(now = Date.now(), force = false) {
  for (const [k, e] of pairFailures) if (now - e.last >= HOUR_MS) pairFailures.delete(k);
  if (force && pairFailures.size >= MAX_KEYS) {
    let n = Math.ceil(MAX_KEYS / 10);
    for (const k of pairFailures.keys()) { pairFailures.delete(k); if (--n <= 0) break; }
  }
}
const timer = setInterval(() => sweep(), 10 * 60 * 1000);
if (timer.unref) timer.unref();

function resetForTests() {
  ipFailures.reset();
  accountFailures.reset();
  deviceFailures.reset();
  secondFactorFailures.reset();
  pairFailures.clear();
}

module.exports = {
  ipBlocked, clientWaitMs, accountState, challengeDue, deviceBlocked,
  recordFailure, recordSuccess, secondFactorPaused, recordSecondFactorFailure, clear, resetForTests,
  CHALLENGE_AFTER, IP_MAX_FAILURES, FREE_ATTEMPTS, WAIT_STEPS_S, ACCOUNT_CHALLENGE_AFTER, ACCOUNT_NOTICE_AFTER, ACCOUNT_CEILING, DEVICE_MAX, SECOND_FACTOR_MAX, WINDOW_MS, HOUR_MS, BIG,
};
