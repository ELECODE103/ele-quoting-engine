#!/usr/bin/env node
/**
 * RR-01 / RR-02: the database ceiling is still a lever (independent review H3, not closed).
 * A passing fix: `account` and `grow` end with victimUpload/victimNewQuote = 200 (or the flood refused
 * before the ceiling), and a re-price that would take the file past its share is refused like a new row.
 *
 *   node tools/security/rereview-availability/db-ceiling.js size              bytes one draft really costs
 *   node tools/security/rereview-availability/db-ceiling.js account [dbMb=8]  ONE address + ONE confirmed account fills it to 100 %
 *   node tools/security/rereview-availability/db-ceiling.js grow [dbMb=8]     small drafts made under the line, then grown by re-pricing (never checked)
 *   node tools/security/rereview-availability/db-ceiling.js anon [dbMb=8]     no account: addresses needed to pause every visitor without one
 *
 * Every limit is the server's default except DB_MAX_MB (8 instead of 64 so the run takes a minute;
 * the script prints the same sum for the default 64 MB). Add `turnstile` as a last argument to run
 * with the bot check on (the repository's stand-in): the attacker passes it once per address.
 */
const c = require("./common");

const mode = process.argv[2] || "size";
const turnstile = process.argv.includes("turnstile");
const dbMb = Number(process.argv.find((a, i) => i >= 3 && /^\d+$/.test(a))) || 8;
const DEFAULT_DB_MB = 64;

async function start() {
  return c.startServer({ env: { DB_MAX_MB: String(dbMb) }, turnstile, stubs: true });
}
/** Headers an address needs for the quote tool: nothing with the bot check off, a verified-human token with it on. */
async function gate(s, ip) { return turnstile ? { "X-Human-Token": await c.humanToken(s, ip) } : {}; }
/** Registering with the bot check on needs one passed check (the stand-in passes a token that starts "pass"). */
const T = turnstile ? { "X-Turnstile-Token": "pass-x" } : {};

async function size() {
  const s = await start();
  try {
    const ip = "192.0.2.1";
    const h = await gate(s, ip);
    const part = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip, headers: h });
    const { line } = await c.lineFor(s, part.partId, "cnc", ip);
    const token = await s.register("sizer@example.test", { ip, headers: T });
    const measure = async (body, o) => { const b0 = c.dbBytes(s); const r = await s.post("/api/quote", body, o); await c.sleep(300); return { status: r.status, bytes: c.dbBytes(s) - b0, id: r.body && r.body.quoteId }; };
    const same25 = await measure({ parts: Array.from({ length: 25 }, () => line), leadTimeSlug: "standard" }, { ip, headers: h });
    const distinct25 = await measure({ parts: c.distinctLines(line, 25), leadTimeSlug: "standard" }, { ip, headers: h });
    const distinct100 = await measure({ parts: c.distinctLines(line, 100), leadTimeSlug: "standard" }, { ip, token });
    const one = await measure({ parts: [line], leadTimeSlug: "standard" }, { ip, headers: h });
    const b0 = c.dbBytes(s);
    const grown = await s.post("/api/quote", { parts: c.distinctLines(line, 25), leadTimeSlug: "standard", quoteId: one.id }, { ip, headers: h });
    await c.sleep(2500); // a re-price is written within 1.5 s
    c.result({
      test: "db-ceiling size", turnstile,
      bytesPerDraft: { "25 identical lines (what the fix write-up measured)": same25.bytes, "25 different lines, no account": distinct25.bytes, "100 different lines, signed in": distinct100.bytes, "1 line": one.bytes },
      rePriceOfTheOneLineDraftTo25Lines: { status: grown.status, sameRow: grown.body.quoteId === one.id, bytesAdded: c.dbBytes(s) - b0 },
      draftsToReach85PercentOf64Mb: { identical25: Math.ceil(0.85 * 64 * c.MB / Math.max(1, same25.bytes)), different25: Math.ceil(0.85 * 64 * c.MB / Math.max(1, distinct25.bytes)) },
      draftsToReach100PercentOf64Mb: { different100SignedIn: Math.ceil(64 * c.MB / Math.max(1, distinct100.bytes)) },
    });
  } finally { await s.stop(); }
}

/** What a real customer with a confirmed email meets afterwards, from another address. */
async function victim(s, label) {
  const ip = "203.0.113.77";
  const token = await s.register(`victim-${label}-${Date.now()}@example.test`, { ip, headers: T });
  const up = await s.upload([{ name: "bracket.stl", data: c.g.stlCube(30) }], { ip, token });
  let quote = null;
  if (up.body && up.body.parts && up.body.parts[0]) {
    const { line } = await c.lineFor(s, up.body.parts[0].partId, "cnc", ip);
    quote = await s.post("/api/quote", { parts: [line], leadTimeSlug: "standard" }, { ip, token });
  } else {
    // Could not upload: can they at least price a part that is already there? (No part of theirs exists; ask with the attacker's.)
    quote = { status: null, body: { code: "no-part-to-price" } };
  }
  const anonIp = "203.0.113.78";
  const anonHeaders = await gate(s, anonIp);
  const anonUp = await s.upload([{ name: "bracket.stl", data: c.g.stlCube(30) }], { ip: anonIp, headers: anonHeaders });
  return {
    confirmedCustomerUpload: { status: up.status, code: (up.body && up.body.code) || "" },
    confirmedCustomerNewQuote: { status: quote.status, code: (quote.body && quote.body.code) || "" },
    visitorWithoutAccountUpload: { status: anonUp.status, code: (anonUp.body && anonUp.body.code) || "" },
  };
}

async function account() {
  let s = await start();
  try {
    const ip = "192.0.2.10";
    const token = await s.register("attacker@example.test", { ip, headers: T }); // a real mailbox of the attacker's: the confirmation link is opened
    const part = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip, token });
    const { line } = await c.lineFor(s, part.partId, "cnc", ip);
    const body = { parts: c.distinctLines(line, 100), leadTimeSlug: "standard" };
    let made = 0; let last = null;
    const t0 = Date.now();
    for (let i = 0; i < 400; i++) {
      last = await s.post("/api/quote", body, { ip, token, timeoutMs: 60000 });
      if (last.status === 200) { made++; continue; }
      if (last.status === 429 && last.body && /pricing|rate/.test(last.body.code || "")) { await c.sleep(1000); continue; }
      break;
    }
    const full = c.dbBytes(s);
    c.log(`one address, one confirmed account: ${made} drafts of 100 lines in ${Math.round((Date.now() - t0) / 1000)} s, database ${(full / c.MB).toFixed(1)} MB of ${dbMb} MB; then: HTTP ${last.status} ${last.body && last.body.code}`);
    const after = await victim(s, "a");
    // Does the server recover by itself? The pressure pass runs when a request is refused (at most every 20 s).
    await c.sleep(22000);
    await s.upload([{ name: "x.stl", data: c.g.stlCube(10) }], { ip: "203.0.113.90" });
    await c.sleep(3000);
    const afterPass = await victim(s, "b");
    const relief = (s.log().match(/Database at \d+% of its ceiling: removed[^\n]*/g) || []).slice(-1)[0] || "no relief line logged (nothing it may remove)";
    // The owner's button.
    const admin = await s.admin({ ip: "198.51.100.1", headers: T });
    const purge = await s.post("/api/admin/drafts/purge", { olderThanHours: 0 }, { ip: "198.51.100.1", headers: await s.browser(admin) });
    // A restart.
    await s.stop({ keep: true });
    s = await c.startServer({ env: { DB_MAX_MB: String(dbMb) }, turnstile, stubs: true, tmpDir: s.tmp });
    const afterRestart = await victim(s, "c");
    const perDraft = full / Math.max(1, made);
    c.result({
      test: "db-ceiling account", turnstile, dbMaxMb: dbMb, attackerAddresses: 1, attackerAccounts: 1, draftsMade: made, bytesPerDraft: Math.round(perDraft),
      databaseMb: Number((full / c.MB).toFixed(1)), stoppedWith: last.body && last.body.code,
      afterTheFlood: after, afterThePressurePass: afterPass, pressurePassLog: relief,
      adminClearOldDrafts: { status: purge.status, body: purge.body },
      afterARestart: afterRestart,
      atTheDefault64Mb: { draftsNeeded: Math.ceil(DEFAULT_DB_MB * c.MB / perDraft), hoursForOneAddressAt30NewDraftsAnHour: Number((Math.ceil(DEFAULT_DB_MB * c.MB / perDraft) / 30).toFixed(1)), note: "the per-day limit is 120 per address, so one address needs two days or two addresses one day; the drafts are a signed-in customer's, so nothing removes them for 30 days" },
    });
  } finally { await s.stop(); }
}

async function grow() {
  const s = await start();
  try {
    const ip = "192.0.2.20";
    // An account whose email was never confirmed (any address will do): at 85 % it may not START a quote...
    const token = await s.register("unconfirmed@example.test", { ip, verify: false, headers: T });
    const h = await gate(s, ip);
    const part = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip, token, headers: h });
    const { line } = await c.lineFor(s, part.partId, "cnc", ip);
    const ids = [];
    for (let i = 0; i < 30; i++) { // the hourly limit on new drafts for one address
      const r = await s.post("/api/quote", { parts: [line], leadTimeSlug: "standard" }, { ip, token, headers: h });
      if (r.status === 200) ids.push(r.body.quoteId); else { c.log("new draft refused:", r.status, r.body && r.body.code); break; }
    }
    const small = c.dbBytes(s);
    // ...but re-pricing a draft it already has is never checked against the ceiling.
    let grown = 0; const statuses = {};
    for (const id of ids) {
      let r;
      for (let tries = 0; tries < 30; tries++) { // the burst limiter (40 pricing calls per 10 s per address) only slows this down
        r = await s.post("/api/quote", { parts: c.distinctLines(line, 100), leadTimeSlug: "standard", quoteId: id }, { ip, token, headers: h, timeoutMs: 60000 });
        if (r.status !== 429) break;
        await c.sleep(1500);
      }
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      if (r.status === 200 && r.body.quoteId === id) grown++;
    }
    await c.sleep(2500);
    const big = c.dbBytes(s);
    const after = await victim(s, "g");
    await c.sleep(22000);
    await s.upload([{ name: "x.stl", data: c.g.stlCube(10) }], { ip: "203.0.113.90" });
    await c.sleep(3000);
    const afterPass = await victim(s, "h");
    c.result({
      test: "db-ceiling grow", turnstile, dbMaxMb: dbMb, attackerAddresses: 1, account: "one, email never confirmed",
      draftsMade: ids.length, databaseMbWithSmallDrafts: Number((small / c.MB).toFixed(2)), rePriced: grown, rePriceStatuses: statuses,
      databaseMbAfterRePricing: Number((big / c.MB).toFixed(2)), percentOfCeiling: Math.round(100 * big / (dbMb * c.MB)),
      afterTheGrowth: after, afterThePressurePass: afterPass,
    });
  } finally { await s.stop(); }
}

async function anon() {
  const s = await start();
  try {
    const seedIp = "192.0.2.30";
    const part = await c.uploadOne(s, "cube.stl", c.g.stlCube(20), { ip: seedIp, headers: await gate(s, seedIp) });
    const { line } = await c.lineFor(s, part.partId, "cnc", seedIp);
    const body = { parts: c.distinctLines(line, 25), leadTimeSlug: "standard", notes: "n".repeat(2000) };
    let addresses = 0; let made = 0; let paused = null;
    for (let a = 0; a < 200 && !paused; a++) {
      const ip = `192.0.2.${31 + a}`;
      const h = await gate(s, ip);
      addresses++;
      for (let i = 0; i < 30; i++) {
        const r = await s.post("/api/quote", body, { ip, headers: h });
        if (r.status === 200) { made++; continue; }
        if (r.body && (r.body.code === "quotes-paused" || r.body.code === "storage-full")) { paused = r.body.code; }
        break;
      }
    }
    const bytes = c.dbBytes(s);
    const after = await victim(s, "n");
    const perDraft = bytes / Math.max(1, made);
    const need64 = Math.ceil(0.85 * DEFAULT_DB_MB * c.MB / perDraft);
    c.result({
      test: "db-ceiling anon", turnstile, dbMaxMb: dbMb, attackerAddresses: addresses, draftsMade: made, bytesPerDraft: Math.round(perDraft),
      databaseMb: Number((bytes / c.MB).toFixed(1)), stoppedWith: paused, afterTheFlood: after,
      atTheDefault64Mb: { draftsNeededFor85Percent: need64, addressesInOneHour: Math.ceil(need64 / 30), addressesOverOneDay: Math.ceil(need64 / 120), fixWriteUpSaid: "1,574 quotes from 53 addresses" },
    });
  } finally { await s.stop(); }
}

({ size, account, grow, anon }[mode] || size)().catch((e) => { console.error(e); process.exit(1); });
