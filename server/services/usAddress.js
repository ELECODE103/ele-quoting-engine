/**
 * Which state a United States ZIP code belongs to, and how a state is spelled (review of
 * 2026-11-13, N-03).
 *
 * Until this file the site decided "is this address inside the contiguous United States" from the
 * country and a free-text state box. Honolulu 96813 typed under "CA" was sold at the mainland parcel
 * price, and "D.C.", "Ill." and "N.Y." were sent to a firm quote. A carrier goes by the ZIP code, so
 * the site now does too.
 *
 * The first three digits of a ZIP code name a postal sorting area, and each area is in one state
 * (the ranges are fixed and public: the Postal Service's three-digit prefix assignments). PREFIXES
 * below is that table as ranges. Two things to know about it:
 *
 *   - A prefix nobody uses that sits inside a state's range reads as that state. No mail goes there,
 *     so nothing is sold wrongly by it. A prefix outside every range is "not a ZIP code we know".
 *   - A few dozen rural ZIP codes cross a state line, and a handful belong to a state other than
 *     their prefix's. The ones known are in EXCEPTIONS. A buyer at one that is not listed is asked
 *     to check the address and, if it is right, to phone: the order is not lost, it is not automatic.
 *
 * Nothing here reads the database or the network.
 */
const STATES = require("../../shared/us-states.json");

const BY_CODE = new Map(STATES.map((s) => [s.code, s]));

// [first prefix, last prefix, state]. In prefix order; checked by the unit test for gaps that overlap.
const PREFIXES = [
  [5, 5, "NY"], [6, 7, "PR"], [8, 8, "VI"], [9, 9, "PR"],
  [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 54, "VT"], [55, 55, "MA"], [56, 59, "VT"],
  [60, 69, "CT"], [70, 89, "NJ"], [90, 98, "AE"],
  [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"],
  [200, 200, "DC"], [201, 201, "VA"], [202, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"],
  [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"], [320, 339, "FL"], [340, 340, "AA"], [341, 349, "FL"],
  [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"],
  [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"], [480, 499, "MI"],
  [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [569, 569, "DC"], [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"],
  [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"],
  [700, 714, "LA"], [716, 729, "AR"], [730, 732, "OK"], [733, 733, "TX"], [734, 749, "OK"], [750, 799, "TX"],
  [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"], [885, 885, "TX"], [889, 898, "NV"],
  [900, 961, "CA"], [962, 966, "AP"], [967, 968, "HI"], [969, 969, "GU"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];

// ZIP codes that are not in their prefix's state, or are shared with a neighbour: [states that are right].
const EXCEPTIONS = {
  "06390": ["NY"],        // Fishers Island, New York (a Connecticut prefix)
  "63673": ["MO", "IL"],  // St. Mary, Missouri, and Kaskaskia, Illinois
  "73960": ["TX"],        // Texhoma, Texas (an Oklahoma prefix)
  "83414": ["WY"],        // Alta, Wyoming (an Idaho prefix)
  "96799": ["AS"],        // Pago Pago, American Samoa (a Hawaii prefix)
  "96950": ["MP"], "96951": ["MP"], "96952": ["MP"], // Saipan, Rota, Tinian (the Guam prefix)
};

// Ways a state is written that are not its code or its full name. Keys are lower case with the
// full stops and commas taken out ("N.Y." is looked up as "ny", "Wash., D.C." as "wash dc").
const ALIASES = {
  ala: "AL", ariz: "AZ", ark: "AR", calif: "CA", cal: "CA", colo: "CO", conn: "CT", del: "DE", fla: "FL",
  ill: "IL", ind: "IN", kans: "KS", kan: "KS", mass: "MA", mich: "MI", minn: "MN", miss: "MS", mont: "MT",
  nebr: "NE", neb: "NE", nev: "NV", okla: "OK", ore: "OR", oreg: "OR", penn: "PA", penna: "PA", tenn: "TN",
  tex: "TX", wash: "WA", wis: "WI", wisc: "WI", wyo: "WY", "n mex": "NM", "n dak": "ND", "s dak": "SD", "w va": "WV", wva: "WV",
  "washington dc": "DC", "wash dc": "DC", "washington d c": "DC", "d c": "DC",
  "virgin islands": "VI", "us virgin islands": "VI", "u s virgin islands": "VI", "northern marianas": "MP",
  "armed forces americas": "AA", "armed forces europe": "AE", "armed forces pacific": "AP",
};
const BY_NAME = new Map();
for (const s of STATES) BY_NAME.set(plain(s.name.replace(/\s*\(.*\)$/, "")), s.code);
for (const [k, v] of Object.entries(ALIASES)) BY_NAME.set(k, v);

/** Lower case, no full stops or commas, single spaces: how a typed state is looked up. */
function plain(value) {
  return String(value === undefined || value === null ? "" : value).toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The two-letter code for a state as a person types it: "IL", " il ", "Illinois", "Ill.", "N.Y.",
 * "D.C.", "Washington DC". null when it is not a state, district, territory or military "state".
 */
function stateCode(value) {
  const t = plain(value);
  if (!t) return null;
  const squeezed = t.replace(/ /g, "");
  if (squeezed.length === 2 && BY_CODE.has(squeezed.toUpperCase())) return squeezed.toUpperCase();
  return BY_NAME.get(t) || null;
}

/** Is this code one of the 48 contiguous states or DC? */
function isContiguous(code) {
  const s = BY_CODE.get(code);
  return Boolean(s && s.zone === "contiguous");
}

/** "Illinois" for "IL"; the code itself when it is not one we know. */
function stateName(code) {
  const s = BY_CODE.get(code);
  return s ? s.name.replace(/\s*\(.*\)$/, "") : String(code || "");
}

/** The five digits of a US ZIP code ("60120", "60120-1234", " 60120 "), or null when it is not one. */
function zip5(value) {
  const m = /^\s*(\d{5})(?:[-\s]?\d{4})?\s*$/.exec(String(value === undefined || value === null ? "" : value));
  return m ? m[1] : null;
}

/**
 * The state(s) a ZIP code is in: an array of codes (one, except for a ZIP code that crosses a state
 * line), or null when the ZIP code is not five digits or its prefix is not in use.
 */
function statesOfZip(value) {
  const z = zip5(value);
  if (!z) return null;
  if (EXCEPTIONS[z]) return EXCEPTIONS[z].slice();
  const prefix = Number(z.slice(0, 3));
  const row = PREFIXES.find(([lo, hi]) => prefix >= lo && prefix <= hi);
  return row ? [row[2]] : null;
}

/**
 * Check a United States ship-to address: the state as typed against the ZIP code.
 *
 * @param {{ state?: string, zip?: string }} a
 * @returns {{ ok: true, state: string, zip: string, contiguous: boolean }
 *          | { ok: false, code: "ship-state" | "ship-zip" | "address-mismatch", field: string, error: string }}
 *   ok: `state` is the two-letter code, `zip` the ZIP code trimmed, and `contiguous` is true only
 *   when BOTH the state and the ZIP code are in the 48 contiguous states or DC. A ZIP code in
 *   Alaska, Hawaii, a territory or a military post office makes the address "not contiguous"
 *   whatever the state box says: that is decided before the two are compared, so such an address
 *   is never given a mainland price and is never turned away as a typing mistake either.
 */
function checkUsAddress({ state, zip } = {}) {
  const code = stateCode(state);
  if (!code) return { ok: false, code: "ship-state", field: "shippingState", error: "Choose the state from the list, then try again." };
  const z = zip5(zip);
  const zipStates = statesOfZip(zip);
  if (!z || !zipStates) return { ok: false, code: "ship-zip", field: "shippingZip", error: "That ZIP code is not one we recognise. A ZIP code is five digits (or five and four). Check it and try again." };
  const zipOffshore = zipStates.some((s) => !isContiguous(s));
  if (zipOffshore || !isContiguous(code)) {
    // Outside the contiguous states by the ZIP code or by the state: where it goes next is the
    // caller's business (a firm quote). The state on record is the ZIP code's when the two differ.
    return { ok: true, state: zipStates.includes(code) || !zipOffshore ? code : zipStates[0], zip: String(zip).trim(), contiguous: false };
  }
  if (!zipStates.includes(code)) {
    return {
      ok: false, code: "address-mismatch", field: "shippingZip",
      error: `The state and the ZIP code don't match: ZIP code ${z} is in ${zipStates.map(stateName).join(" or ")}, and the state chosen is ${stateName(code)}. Check the address and try again.`,
      zipState: zipStates[0], state: code,
    };
  }
  return { ok: true, state: code, zip: String(zip).trim(), contiguous: true };
}

module.exports = { STATES, PREFIXES, EXCEPTIONS, stateCode, stateName, isContiguous, zip5, statesOfZip, checkUsAddress };
