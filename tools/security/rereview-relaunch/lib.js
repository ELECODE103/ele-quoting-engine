/**
 * Shared helpers for the relaunch re-review proofs (2026-11-12). Everything runs against the repo's own
 * in-process harness (server/testSupport/harness.js: real routes, throwaway database, Stripe stand-in) or
 * a child server (server/testSupport/liveServer.js). Nothing leaves the machine.
 */
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");
const SHIP = { shippingName: "Dana Buyer", shippingAddress: "100 Main St", shippingCity: "Columbus", shippingState: "OH", shippingZip: "43215", shippingCountry: "US" };

/** Lift the per-account pacing limits (they have their own checks); a script that tests a limit does not call this. */
function liftPacing() {
  process.env.CHECKOUT_PER_ACCOUNT_15MIN = "1000"; // the highest value the setting accepts
  for (const k of ["QUOTE_NEW_PER_CLIENT_HOUR", "QUOTE_NEW_PER_CLIENT_DAY", "QUOTE_NEW_PER_ACCOUNT_HOUR", "QUOTE_NEW_PER_ACCOUNT_DAY"]) process.env[k] = "100000";
  for (const k of ["QUOTE_DRAFT_KB_PER_CLIENT", "QUOTE_DRAFT_KB_PER_ACCOUNT"]) process.env[k] = "100000";
  for (const k of ["QUOTE_PRICE_SECONDS_PER_CLIENT_HOUR", "QUOTE_PRICE_SECONDS_PER_ACCOUNT_HOUR"]) process.env[k] = "3600";
}

/** A closed rectangle (inches) as a DXF the site reads as a routed profile. */
function rectDxf(wIn, hIn, holes = []) {
  const out = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1015", "9", "$INSUNITS", "70", "1", "9", "$MEASUREMENT", "70", "0", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
    "0", "LWPOLYLINE", "8", "0", "90", "4", "70", "1", "10", "0", "20", "0", "10", String(wIn), "20", "0", "10", String(wIn), "20", String(hIn), "10", "0", "20", String(hIn)];
  for (const [x, y, r] of holes) out.push("0", "CIRCLE", "8", "0", "10", String(x), "20", String(y), "40", String(r));
  out.push("0", "ENDSEC", "0", "EOF");
  return Buffer.from(out.join("\n") + "\n");
}

/** Results table printed at the end of every script: [verdict, what, detail]. verdict: HOLDS | FINDING | INFO. */
function report() {
  const rows = [];
  return {
    rows,
    holds: (what, detail = "") => { rows.push(["HOLDS", what, detail]); console.log(`  HOLDS    ${what}${detail ? ` :: ${detail}` : ""}`); },
    finding: (what, detail = "") => { rows.push(["FINDING", what, detail]); console.log(`  FINDING  ${what}${detail ? ` :: ${detail}` : ""}`); },
    info: (what, detail = "") => { rows.push(["INFO", what, detail]); console.log(`  INFO     ${what}${detail ? ` :: ${detail}` : ""}`); },
    check(cond, what, detail = "") { if (cond) this.holds(what, detail); else this.finding(what, detail); return cond; },
    done() { const f = rows.filter((r) => r[0] === "FINDING").length; console.log(`\n${rows.filter((r) => r[0] === "HOLDS").length} held, ${f} finding(s), ${rows.filter((r) => r[0] === "INFO").length} info`); return f; },
  };
}

const sumLines = (args) => args.line_items.reduce((s, li) => s + li.price_data.unit_amount * (li.quantity || 1), 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ROOT, SHIP, liftPacing, rectDxf, report, sumLines, sleep };
