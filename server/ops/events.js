/**
 * Counters for what the owner would otherwise only find by reading the deploy
 * log: failed emails, refused Stripe webhooks, server errors, sign-in pauses,
 * storage refusals.
 *
 * Everything here is IN MEMORY. It resets when the service restarts (every
 * deploy, every crash). That is deliberate: one instance, no extra moving
 * parts. The status page and the digest say when the counting started.
 *
 * Nothing recorded here is customer data: an event is a kind (a fixed word
 * from this file's callers), a time, and at most a short label such as an
 * email template's name. No address, subject, URL or body is ever kept.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMES_PER_KIND = 5000; // newest kept; a flood cannot grow memory
const MAX_RECENT = 60;

const startedAt = Date.now();
let totals = Object.create(null);     // kind → count since the process started
let sinceDigest = Object.create(null); // kind → count since the last digest was sent (or since start)
let sinceDigestAt = startedAt;
let times = Object.create(null);      // kind → [timestamps], newest last, last 24 h only
let recent = [];                      // newest last: { at, kind, label }

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,60}$/;

/**
 * @param {string} kind   a fixed word chosen by the caller ("mailFailed", "webhookRejected", …)
 * @param {object} [o]
 * @param {string} [o.label] a short safe label (a template name, a status code); anything else is dropped
 * @param {boolean} [o.notable] keep it in the short "recent events" list shown on the status page
 */
function record(kind, o = {}) {
  const now = typeof o.now === "number" ? o.now : Date.now();
  totals[kind] = (totals[kind] || 0) + 1;
  sinceDigest[kind] = (sinceDigest[kind] || 0) + 1;
  const list = times[kind] || (times[kind] = []);
  list.push(now);
  if (list.length > MAX_TIMES_PER_KIND) list.splice(0, list.length - MAX_TIMES_PER_KIND);
  if (o.notable) {
    const label = typeof o.label === "string" && LABEL_RE.test(o.label) ? o.label : "";
    recent.push({ at: new Date(now).toISOString(), kind, label });
    if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
  }
}

/** How many `kind` events in the last `windowMs` (at most 24 hours back). */
function countSince(kind, windowMs, now = Date.now()) {
  const list = times[kind];
  if (!list || !list.length) return 0;
  const cutoff = now - Math.min(windowMs, DAY_MS);
  // Drop what is older than a day while we are here.
  const dayCutoff = now - DAY_MS;
  let drop = 0;
  while (drop < list.length && list[drop] < dayCutoff) drop++;
  if (drop) list.splice(0, drop);
  let n = 0;
  for (let i = list.length - 1; i >= 0 && list[i] >= cutoff; i--) n++;
  return n;
}

function total(kind) {
  return totals[kind] || 0;
}

/** Counts since the last digest (or since the process started), and since when. */
function digestCounts() {
  return { since: new Date(sinceDigestAt).toISOString(), counts: { ...sinceDigest } };
}

/** Called when a digest has gone out: the next one counts from here. */
function markDigestSent(now = Date.now()) {
  sinceDigest = Object.create(null);
  sinceDigestAt = now;
}

function snapshot() {
  return {
    countingSince: new Date(startedAt).toISOString(),
    totals: { ...totals },
    recent: recent.slice().reverse(), // newest first
  };
}

/** Tests only. */
function reset() {
  totals = Object.create(null);
  sinceDigest = Object.create(null);
  sinceDigestAt = Date.now();
  times = Object.create(null);
  recent = [];
}

module.exports = { record, countSince, total, digestCounts, markDigestSent, snapshot, reset, startedAt };
