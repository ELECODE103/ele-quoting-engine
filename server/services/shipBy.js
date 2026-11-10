/**
 * Ship-by dates.
 *
 * The customer is shown a date ("ships by Tue, Nov 24"), not a multiplier or a
 * range. The date is the order day plus the lead time's business days, on the
 * shop's calendar (America/Chicago), skipping weekends and US federal holidays.
 *
 * Rules:
 *   - Day 1 is the first business day after the order day, so a Friday-evening
 *     or Saturday order never counts the weekend.
 *   - A lead time of 0 days ("same day") ships the order day when the order
 *     lands on a business day before the cutoff hour, else the next business day.
 *   - A lead time's day count is its `daysMax` when set, else the largest number
 *     in its admin-editable `days` text ("7-10 business days" → 10).
 *
 * Dates are plain "YYYY-MM-DD" strings so they survive JSON, SQLite and time
 * zones unchanged.
 */
const SHOP_TZ = "America/Chicago";
const SAME_DAY_CUTOFF_HOUR = 10;

const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const toUtc = (s) => new Date(`${s}T12:00:00Z`);
const fromUtc = (d) => ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
const addDays = (s, n) => { const d = toUtc(s); d.setUTCDate(d.getUTCDate() + n); return fromUtc(d); };
const weekday = (s) => toUtc(s).getUTCDay(); // 0 Sun … 6 Sat

/** nth (1-based) given weekday of a month; n = -1 means the last one. */
function nthWeekday(year, month, dow, n) {
  if (n > 0) {
    const first = weekday(ymd(year, month, 1));
    return ymd(year, month, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekday(ymd(year, month, lastDay));
  return ymd(year, month, lastDay - ((last - dow + 7) % 7));
}

/** A fixed-date holiday is observed Friday when it falls on Saturday, Monday when on Sunday. */
function observed(s) {
  const dow = weekday(s);
  if (dow === 6) return addDays(s, -1);
  if (dow === 0) return addDays(s, 1);
  return s;
}

const holidayCache = new Map();
/** US federal holidays (observed dates) for a year, as a Set of YYYY-MM-DD. */
function federalHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const set = new Set([
    observed(ymd(year, 1, 1)),        // New Year's Day
    nthWeekday(year, 1, 1, 3),        // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3),        // Washington's Birthday
    nthWeekday(year, 5, 1, -1),       // Memorial Day
    observed(ymd(year, 6, 19)),       // Juneteenth
    observed(ymd(year, 7, 4)),        // Independence Day
    nthWeekday(year, 9, 1, 1),        // Labor Day
    nthWeekday(year, 10, 1, 2),       // Columbus Day
    observed(ymd(year, 11, 11)),      // Veterans Day
    nthWeekday(year, 11, 4, 4),       // Thanksgiving
    observed(ymd(year, 12, 25)),      // Christmas
    observed(ymd(year + 1, 1, 1)),    // next New Year's, when observed on Dec 31
  ].filter((d) => d.startsWith(String(year))));
  holidayCache.set(year, set);
  return set;
}

function isBusinessDay(s) {
  const dow = weekday(s);
  if (dow === 0 || dow === 6) return false;
  return !federalHolidays(Number(s.slice(0, 4))).has(s);
}

function nextBusinessDay(s) {
  let d = addDays(s, 1);
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

/** The date n business days after `s` (n = 0 → `s` itself, or the next business day if `s` isn't one). */
function addBusinessDays(s, n) {
  let d = s;
  if (n <= 0) return isBusinessDay(d) ? d : nextBusinessDay(d);
  for (let i = 0; i < n; i++) d = nextBusinessDay(d);
  return d;
}

/** Today's date and hour on the shop's clock. */
function shopNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Business days for a lead-time record (or a bare number). */
function leadDays(leadTime) {
  if (typeof leadTime === "number") return Math.max(0, Math.round(leadTime));
  if (!leadTime) return 0;
  if (Number.isFinite(Number(leadTime.daysMax)) && leadTime.daysMax !== null && leadTime.daysMax !== "") return Math.max(0, Number(leadTime.daysMax));
  const nums = String(leadTime.days || "").match(/\d+/g);
  // "Ships today (order by 10am)" carries a clock time, not a day count.
  if (!nums || /today|same.day/i.test(leadTime.days || "")) return 0;
  return Math.max(...nums.map(Number));
}

/** Ship-by date (YYYY-MM-DD) for an order placed at `now`. */
function shipByDate(leadTime, now = new Date()) {
  const days = leadDays(leadTime);
  const { date, hour } = shopNow(now);
  if (days === 0) {
    return isBusinessDay(date) && hour < SAME_DAY_CUTOFF_HOUR ? date : nextBusinessDay(date);
  }
  return addBusinessDays(date, days);
}

/** "Tue, Nov 24, 2026" */
function formatShipBy(s) {
  if (!s) return "";
  return toUtc(s).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

module.exports = {
  SHOP_TZ, SAME_DAY_CUTOFF_HOUR,
  federalHolidays, isBusinessDay, addBusinessDays, leadDays, shipByDate, formatShipBy, shopNow, addDays,
};
