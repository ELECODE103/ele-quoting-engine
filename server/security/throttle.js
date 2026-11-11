/**
 * Small in-memory counters for abuse limits (per IP, per email address, per
 * token). One process serves the site, so memory is the right place; counters
 * reset on a restart, which only ever loosens a limit for a moment.
 *
 *   const t = createThrottle({ windowMs: 3600e3, max: 5 });
 *   t.peek(key)   → { count, remaining, limited, retryAfterMs }
 *   t.hit(key)    → same, after counting one more
 *   t.reset(key)
 */
const MAX_KEYS = 50000; // hard ceiling so a flood of distinct keys cannot grow memory without bound

function createThrottle({ windowMs, max }) {
  const hits = new Map(); // key → timestamps (ms), oldest first

  function prune(key, now) {
    const list = hits.get(key);
    if (!list) return [];
    while (list.length && now - list[0] >= windowMs) list.shift();
    if (list.length === 0) hits.delete(key);
    return list;
  }

  function view(list, now) {
    const count = list.length;
    return {
      count,
      remaining: Math.max(0, max - count),
      limited: count >= max,
      retryAfterMs: count >= max ? Math.max(0, windowMs - (now - list[count - max])) : 0,
    };
  }

  function peek(key, now = Date.now()) {
    return view(prune(key, now), now);
  }

  function hit(key, now = Date.now()) {
    const list = prune(key, now);
    if (!hits.has(key)) {
      if (hits.size >= MAX_KEYS) sweep(now, true);
      hits.set(key, list);
    }
    list.push(now);
    return view(list, now);
  }

  function reset(key) {
    if (key === undefined) hits.clear(); else hits.delete(key);
  }

  function sweep(now = Date.now(), force = false) {
    for (const key of [...hits.keys()]) prune(key, now);
    // Still full of live keys: drop the oldest tenth rather than refuse to count.
    if (force && hits.size >= MAX_KEYS) {
      let n = Math.ceil(MAX_KEYS / 10);
      for (const key of hits.keys()) { hits.delete(key); if (--n <= 0) break; }
    }
  }

  const timer = setInterval(() => sweep(), Math.min(windowMs, 10 * 60 * 1000));
  if (timer.unref) timer.unref();

  return { peek, hit, reset, sweep, size: () => hits.size, windowMs, max };
}

/**
 * A remembered-values store with a time limit per entry (used-once nonces,
 * recent submissions).
 */
function createTtlStore({ ttlMs, maxEntries = MAX_KEYS }) {
  const items = new Map(); // key → { value, expires }
  function get(key, now = Date.now()) {
    const e = items.get(key);
    if (!e) return undefined;
    if (e.expires <= now) { items.delete(key); return undefined; }
    return e.value;
  }
  function set(key, value, now = Date.now(), ttl = ttlMs) {
    if (items.size >= maxEntries) sweep(now, true);
    items.set(key, { value, expires: now + ttl });
  }
  function sweep(now = Date.now(), force = false) {
    for (const [k, e] of items) if (e.expires <= now) items.delete(k);
    if (force && items.size >= maxEntries) {
      let n = Math.ceil(maxEntries / 10);
      for (const k of items.keys()) { items.delete(k); if (--n <= 0) break; }
    }
  }
  const timer = setInterval(() => sweep(), Math.min(ttlMs, 10 * 60 * 1000));
  if (timer.unref) timer.unref();
  return { get, set, has: (k, now) => get(k, now) !== undefined, delete: (k) => items.delete(k), clear: () => items.clear(), size: () => items.size };
}

/** The caller's address as Express resolved it (trust proxy is set in production). */
function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

module.exports = { createThrottle, createTtlStore, clientIp };
