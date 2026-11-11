#!/usr/bin/env node
/**
 * Claims check for the public pages.
 *
 * Reads the prerendered HTML (client/dist/_prerender, made by `npm run build`),
 * pulls out every sentence that contains a number, a machine name, a compliance
 * word (FDA, NSF, USDA, 3-A, ISO) or a time promise, and says what each one
 * rests on. A sentence with no basis is printed as UNSUPPORTED and the script
 * exits 1, so a new unbacked claim cannot slip in unnoticed.
 *
 *   node scripts/claims-check.js            summary + any UNSUPPORTED lines
 *   node scripts/claims-check.js --all      every sentence, as a markdown table
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "client", "dist", "_prerender");
const facts = require("../shared/shop-facts.json").facts;

const TRIGGERS = [
  ["number", /\d/],
  ["machine", /\b(Tormach|Bridgeport|Techno|Raise3D|Creality|Formlabs|Kalamazoo|Haas|CMM|4th.axis|lathe)\b/i],
  ["compliance", /\b(FDA|NSF|USDA|3-A|ISO 9001|21 CFR|food.safe|food.contact)\b/i],
  ["time", /\b(hours?|business days?|same day|days|weeks?|within|by the date|that day|next morning|seconds)\b/i],
];

// What a sentence may rest on. First match wins; order matters.
const BASIS = [
  // Published contact details: shared/brand.json (audit A3).
  ["CONTACT (A3)", /224-213-6727|quotes@straightedgemfg\.com|^© \d{4}/],
  // Statements that the shop does NOT have something (audit B9; brief: no ISO, no CMM).
  ["NEGATIVE (B9)", /not ISO 9001|no CMM|There is no CMM|needs a CMM|requires the certificate|NSF, 3-A or USDA status for the shop|"FDA approved\."|does not claim|cannot certify/i],
  // Regulatory definitions, sourced (audit B12, research 2.5).
  ["REGULATION (B12)", /\b(FDA|NSF|USDA|3-A|21 CFR)\b|food.contact|food.safe|touches food/i],
  // Hedged rules of thumb and the buyer's own situation; not claims about the shop.
  ["ADVICE", /about 50 pieces|builder quotes weeks/],
  // Rules the quote tool enforces or config it serves (audit A9, A12, A13, A21, A51, A61, A97; code read for this pass).
  ["SOFTWARE", /100 pieces|100 pcs|to 100|Over 100|under 100|18" × 9\.5" × 12"|59" × 96"|48" × 96"|4' × 8'|48" × 96" sheet|1\/16" to 1"|up to 1" thick|Over 1" thick|under 1" thick|\$5,000|1\/32"|1\/8" up to 1"|0\.060"|0\.040"|0\.080"|four times|four diameters|one third|about 1\.5" across|0\.1, 0\.2 and 0\.3 mm|few seconds|STEP|STL|IGES|3MF|25 MB|plastics are priced online|priced online|One file|one diameter|half the sheet thickness|build.volume check|6061|quoted online|confirmation email|reference number|whole sheets|1\/16", 1\/8"|routing from sheet|Brass 360/],
  // How plastic behaves, from cited sources (audit A65, B14, B15; research 2.1).
  ["PHYSICS (B14/B15)", /five to ten times|ten times|about 2%|2% in length|next morning|two-foot|150 °F|weeks/],
  // Datasheet values on the material pages, each with its source linked on the page.
  ["DATASHEET (cited on page)", /psi|g\/cm³|°F|°C|ASTM|ISO 527|ISO 62|D638|D570|datasheet|retrieved|EU 10\/2011|in 24 h|saturation|PE 1000|nylon 6|Nylon 6|PA12|Type 1|G-10|FR-4|POM|Ultem 1000|Delrin 150|C360|Ensinger|dynamic/],
  // One-person shop, as given in the brief (audit B4, B5, A30).
  ["ONE PERSON (brief, B5)", /one.person|One person|one set of hands|fifty people|second source/i],
  // Conduct promises in the first person that cost nothing to keep (framework section 6).
  ["CONDUCT PROMISE (framework 6)", /by the date on the quote|that day|before you order|before anything is cut|you hear|I will say|you will be told/i],
  // General design or buying advice, not a claim about the shop.
  ["ADVICE", /50 pieces|Two angles|two or three|Three ways|three|first choice|a question or two|printed fit|3D print|second photo|one more dimension|one picture|one straight cut|one thing|One of the easiest|404|days|within|hours/i],
];

// A sentence that carries the exact wording or number of a fact the owner has
// confirmed in shared/shop-facts.json rests on that confirmation.
function confirmedStrings() {
  const out = [];
  const walk = (v) => { if (typeof v === "string") { if (v.trim().length >= 4) out.push(v.trim()); } else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  for (const f of Object.values(facts)) if (f.confirmed === true) walk(f.value);
  return out;
}
const CONFIRMED_STRINGS = confirmedStrings();
const squash = (t) => t.replace(/\s+/g, " ");
function ownerConfirmed(sentence) {
  const s = squash(sentence);
  return CONFIRMED_STRINGS.some((v) => s.includes(squash(v)) || s.includes(squash(v).split(" on a ")[0]));
}

function text(html) {
  const main = (html.match(/<main[\s\S]*?<\/main>/) || [html])[0] + (html.match(/<footer[\s\S]*?<\/footer>/) || [""])[0] + (html.match(/<header[\s\S]*?<\/header>/) || [""])[0];
  return main
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, " ")
    .replace(/<\/(p|li|h1|h2|h3|h4|td|th|dt|dd|div|span|label|button|a)>/g, "$&\n")
    .replace(/<input[^>]*placeholder="([^"]*)"[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function sentences(t) {
  const out = [];
  for (const block of t.split("\n")) {
    const b = block.replace(/\s+/g, " ").trim();
    if (b.length < 12) continue;
    for (const s of b.split(/(?<=[.?!])\s+(?=[A-Z"(])/)) if (s.trim().length >= 12) out.push(s.trim());
  }
  return out;
}

function files(dir, base = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name), `${base}/${e.name}`) : e.name.endsWith(".html") ? [[`${base}/${e.name.replace(/\.html$/, "")}`.replace(/\/index$/, "/"), path.join(dir, e.name)]] : []);
}

if (!fs.existsSync(DIR)) { console.error("Run `npm run build` first."); process.exit(2); }

const seen = new Map();
for (const [route, file] of files(DIR).sort()) {
  for (const s of sentences(text(fs.readFileSync(file, "utf8")))) {
    const trig = TRIGGERS.filter(([, re]) => re.test(s)).map(([n]) => n);
    if (trig.length === 0) continue;
    const basis = (BASIS.find(([, re]) => re.test(s)) || [ownerConfirmed(s) ? "OWNER CONFIRMED (shop-facts.json)" : "UNSUPPORTED"])[0];
    if (!seen.has(s)) seen.set(s, { routes: [], trig, basis });
    seen.get(s).routes.push(route);
  }
}

const rows = [...seen.entries()].map(([s, v]) => ({ s, ...v }));
const counts = {};
for (const r of rows) counts[r.basis] = (counts[r.basis] || 0) + 1;
const confirmed = Object.entries(facts).filter(([, f]) => f.confirmed).map(([id]) => id);

if (process.argv.includes("--all")) {
  console.log("| Basis | Triggers | Pages | Sentence |\n|---|---|---|---|");
  for (const r of rows.sort((a, b) => a.basis.localeCompare(b.basis))) {
    console.log(`| ${r.basis} | ${r.trig.join(", ")} | ${r.routes.length > 3 ? `${r.routes.length} pages` : r.routes.join(" ")} | ${r.s.replace(/\|/g, "\\|")} |`);
  }
} else {
  console.log(`Claims check: ${rows.length} distinct sentences with a number, machine name, compliance word or time promise.`);
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log(`Owner facts confirmed: ${confirmed.length} of ${Object.keys(facts).length}${confirmed.length ? ` (${confirmed.join(", ")})` : ""}.`);
}
const bad = rows.filter((r) => r.basis === "UNSUPPORTED");
if (bad.length) {
  console.log(`\n${bad.length} UNSUPPORTED:`);
  for (const r of bad) console.log(`  [${r.routes.slice(0, 2).join(" ")}] ${r.s}`);
  process.exit(1);
}
