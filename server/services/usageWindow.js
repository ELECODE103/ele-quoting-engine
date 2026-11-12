/**
 * A rolling-window tally per sender: how much of something (milliseconds of
 * work, bytes, a count of actions) each key has used in the last `windowMs`.
 *
 * Used wherever a limit has to be per sender and in the unit that costs the
 * shop something: pricing seconds per address and per account
 * (services/pricingMemo.js), re-prices per quote, requests and confirmation
 * emails per address. Kept in memory, bounded, and reset by a restart, like
 * the other per-client counters of a one-instance site.
 */
const HOUR_MS = 60 * 60 * 1000;

class UsageWindow {
  /** @param {{ windowMs?: number, maxKeys?: number }} [opt] */
  constructor({ windowMs = HOUR_MS, maxKeys = 50000 } = {}) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.used = new Map(); // key → [{ at, n }]
  }

  _live(key, now) {
    const list = this.used.get(key);
    if (!list) return [];
    while (list.length && now - list[0].at >= this.windowMs) list.shift();
    if (!list.length) this.used.delete(key);
    return list;
  }

  /** What `key` has used inside the window. */
  total(key, now = Date.now()) {
    if (!key) return 0;
    let sum = 0;
    for (const e of this._live(key, now)) sum += e.n;
    return sum;
  }

  /** Record `n` against `key`. */
  add(key, n = 1, now = Date.now()) {
    if (!key || !(n > 0)) return;
    let list = this.used.get(key);
    if (!list) {
      if (this.used.size >= this.maxKeys) { let drop = Math.ceil(this.maxKeys / 10); for (const k of this.used.keys()) { this.used.delete(k); if (--drop <= 0) break; } }
      list = [];
      this.used.set(key, list);
    }
    const last = list[list.length - 1];
    // Many small entries in the same second are one entry (a pricing request records one per pass).
    if (last && now - last.at < 1000) last.n += n; else list.push({ at: now, n });
  }

  /** Seconds until `key` is back at or under `limit`. At least 60. */
  retryAfterSeconds(key, limit, now = Date.now()) {
    const list = this._live(key, now);
    let over = this.total(key, now) - limit;
    for (const e of list) {
      if (over < 0) break;
      over -= e.n;
      if (over < 0) return Math.max(60, Math.ceil((e.at + this.windowMs - now) / 1000));
    }
    return 60;
  }

  reset() { this.used.clear(); }
}

module.exports = { UsageWindow, HOUR_MS };
