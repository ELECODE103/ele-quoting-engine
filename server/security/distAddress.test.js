/**
 * The shop's street address is not in the client build (scripts/dist-address-check.js).
 *
 * The address is on customer documents and in server/config/shipFrom.json, nowhere else. This
 * suite plants it in a throwaway folder every way a file could carry it — plain, in another
 * letter case, re-spaced, across markup, as entities and escapes, as 16-bit text, inside a
 * compressed PDF page (standard font and embedded-font glyph codes), inside a gzip file — and
 * checks that each is found, that clean files are not, that nothing the check prints contains
 * the address, and that the real build and client/public are clean.
 *
 * The address is read from shipFrom.json when the suite runs and is never written to the output.
 * Run: node server/security/distAddress.test.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync, spawnSync } = require("child_process");
const PDFDocument = require("pdfkit");
const check = require("../../scripts/dist-address-check");

const ROOT = path.join(__dirname, "..", "..");
const ADDRESS = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "config", "shipFrom.json"), "utf8")).address;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "se-address-"));

let failed = 0, passed = 0;
const tests = [];
// One after another: the later cases read folders the earlier ones wrote.
function test(name, fn) { tests.push([name, fn]); }
const write = (rel, data) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const pdfOf = (draw) => new Promise((resolve) => { const doc = new PDFDocument({ size: "LETTER" }); const chunks = []; doc.on("data", (c) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); draw(doc); doc.end(); });

/** A PDF as a browser prints one: text stored as glyph codes, readable only through the font's ToUnicode map. */
function glyphCodedPdf(text) {
  const chars = [...new Set(text)];
  const code = (ch) => (chars.indexOf(ch) + 0x21).toString(16).padStart(4, "0").toUpperCase();
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${chars.map((ch) => `<${code(ch)}> <${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}>`).join("\n")}\nendbfchar\nendcmap\nend\nend`;
  // Drawn the way a kerned line is: an array of short runs with spacing numbers between them.
  const runs = text.match(/.{1,3}/g).map((r) => `<${[...r].map(code).join("")}>`).join(" -12 ");
  const content = `BT\n/F1 11 Tf\n72 700 Td\n[${runs}] TJ\nET`;
  const stream = (s) => { const z = zlib.deflateSync(Buffer.from(s, "latin1")); return Buffer.concat([Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), z, Buffer.from("\nendstream\nendobj\n", "latin1")]); };
  return Buffer.concat([Buffer.from("%PDF-1.7\n1 0 obj\n", "latin1"), stream(content), Buffer.from("2 0 obj\n", "latin1"), stream(cmap), Buffer.from("%%EOF\n", "latin1")]);
}

console.log("Street address stays out of the client build");

test("the address is found however a file carries it, and the finding names the file, not the address", async () => {
  const words = ADDRESS.split(/\s+/);
  const planted = {
    "plain.html": `<p>Ship to ${ADDRESS}</p>`,
    "upper.txt": ADDRESS.toUpperCase(),
    "respaced.js": `const a = "${words.join("   ")}";`,
    "punctuated.json": JSON.stringify({ line: words.join(", ") + "." }),
    "wrapped.txt": words.join("\n"),
    "markup.html": `<address>${words.map((w) => `<span class="w">${w}</span>`).join(" ")}</address>`,
    "entities.html": `<p>${[...ADDRESS].map((c) => `&#${c.charCodeAt(0)};`).join("")}</p>`,
    "nbsp.html": `<p>${words.join("&nbsp;")}</p>`,
    "escaped.js": `x="${[...ADDRESS].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`,
    "percent.txt": encodeURIComponent(ADDRESS),
    "minified.map": JSON.stringify({ sourcesContent: [`render(){return "${ADDRESS}"}`] }),
    "utf16.bin": Buffer.from(ADDRESS, "utf16le"),
    "utf16be.bin": Buffer.from(ADDRESS, "utf16le").swap16(),
    "inside.bin": Buffer.concat([crypto.randomBytes(4096), Buffer.from(ADDRESS), crypto.randomBytes(4096)]),
    "art.svgz": zlib.gzipSync(Buffer.from(`<svg><text>${ADDRESS}</text></svg>`)),
    "standard-font.pdf": await pdfOf((d) => d.fontSize(11).text(`Ship from: ${ADDRESS}`, 72, 72)),
    "kerned.pdf": await pdfOf((d) => { d.fontSize(11); let x = 72; for (const w of words) { d.text(w, x, 90, { lineBreak: false }); x += d.widthOfString(w) + 4; } }),
    "embedded-font.pdf": glyphCodedPdf(`Ship from: ${ADDRESS}`),
    "noext": glyphCodedPdf(ADDRESS), // a PDF without the extension is still read as one
  };
  for (const [name, data] of Object.entries(planted)) write(path.join("planted", name), data);
  // A compressed PDF does not hold the address as bytes: only reading its pages finds it.
  assert.ok(!planted["standard-font.pdf"].includes(Buffer.from(ADDRESS)) && !planted["embedded-font.pdf"].includes(Buffer.from(ADDRESS)), "the PDFs are compressed");
  const r = check.scanDir(path.join(tmp, "planted"));
  const found = new Set(r.findings.map((f) => f.file));
  for (const name of Object.keys(planted)) assert.ok(found.has(name), `${name} was not found`);
  assert.strictEqual(r.scanned, Object.keys(planted).length);
  for (const f of r.findings.filter((x) => x.file.endsWith(".pdf"))) assert.ok(f.how.some((h) => /PDF/.test(h)), `${f.file}: ${f.how.join("; ")}`);
  // Nothing the check returns or prints holds the address, in any letter case.
  const lines = [];
  assert.strictEqual(check.report(r, "the planted folder", (l) => lines.push(l)), false);
  const said = `${JSON.stringify(r)}\n${lines.join("\n")}`;
  assert.ok(!said.toLowerCase().includes(ADDRESS.toLowerCase()) && !check.squash(said).includes(check.squash(ADDRESS)), "the output does not contain the address");
  assert.ok(/STREET ADDRESS IN THE CLIENT BUILD: \d+ files/.test(lines.join("\n")) && lines.some((l) => /plain\.html: /.test(l)));
});

test("files that do not carry it are not reported; a folder or file that is a known carrier is, by name", async () => {
  const clean = {
    "index.html": "<html><body><h1>Machined plastic parts</h1><p>Wauconda, Illinois. Call 224-213-6727.</p></body></html>",
    "assets/app.js": `const street="1 Example Way";const zip=60000;${"x".repeat(5000)}`,
    "brand/logo.svg": "<svg viewBox='0 0 10 10'><path d='M0 0h10v10z'/></svg>",
    "photos/part.png": crypto.randomBytes(30000),
    "brand/guide.pdf": await pdfOf((d) => d.fontSize(11).text("Brand guide. Ink and Brass. 100 Example Parkway, Anytown.", 72, 72)),
    "glyphs.pdf": glyphCodedPdf("Nothing to see: 100 Example Parkway"),
  };
  for (const [name, data] of Object.entries(clean)) write(path.join("clean", name), data);
  const r = check.scanDir(path.join(tmp, "clean"));
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.pdfs, 2);
  const lines = [];
  assert.strictEqual(check.report(r, "the clean folder", (l) => lines.push(l)), true);
  assert.ok(/in none of them/.test(lines.join(" ")));
  // The document samples are pictures and PDFs of documents that print the address: their names alone fail the check.
  write("carriers/brand/documents/readme.txt", "nothing here");
  write("carriers/assets/sample-packing-slip.png", crypto.randomBytes(2000));
  write("carriers/brand/social/post-template.svg", "<svg/>");
  const c = check.scanDir(path.join(tmp, "carriers"));
  assert.deepStrictEqual(c.findings.map((f) => f.file).sort(), ["assets/sample-packing-slip.png", "brand/documents/readme.txt"]);
  assert.ok(check.knownCarrier("brand/documents/x.pdf") && check.knownCarrier("sample-quote.pdf") && !check.knownCarrier("brand/og/quality.png") && !check.knownCarrier("assets/samples.js"));
});

test("an address too short to search for safely is refused; the text helpers do what the check relies on", () => {
  assert.throws(() => check.needlesFor("1 A St"), /too short/);
  assert.throws(() => check.needlesFor(""), /too short/);
  assert.strictEqual(check.squash("100 N.  Example-Parkway\nRd"), "100nexampleparkwayrd");
  assert.strictEqual(check.squash(check.decodeText("a&nbsp;<b>b</b>&#99;%64\\u0065")), "abcde");
});

test("the command line: exit 1 with file names for a folder that carries it, exit 0 for one that does not, exit 2 for no folder — and never the address", () => {
  const script = path.join(ROOT, "scripts", "dist-address-check.js");
  const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  const bad = run(path.join(tmp, "planted"));
  assert.strictEqual(bad.status, 1);
  assert.ok(/standard-font\.pdf/.test(bad.stdout) && /embedded-font\.pdf/.test(bad.stdout));
  const good = run(path.join(tmp, "clean"));
  assert.strictEqual(good.status, 0, good.stdout + good.stderr);
  assert.strictEqual(run(path.join(tmp, "no-such-folder")).status, 2);
  for (const out of [bad, good]) assert.ok(!check.squash(out.stdout + out.stderr).includes(check.squash(ADDRESS)), "nothing printed contains the address");
});

test("the repository: nothing under client/public carries the address, the samples live in docs/brand/samples, and the generator will not write them back", () => {
  const pub = path.join(ROOT, "client", "public");
  const r = check.scanDir(pub);
  assert.deepStrictEqual(r.findings, [], r.findings.map((f) => `${f.file}: ${f.how.join("; ")}`).join("\n"));
  assert.ok(r.scanned > 150, `${r.scanned} files read`);
  assert.ok(!fs.existsSync(path.join(pub, "brand", "documents")));
  const samples = path.join(ROOT, "docs", "brand", "samples");
  const names = fs.readdirSync(samples);
  for (const doc of ["sample-quote.pdf", "sample-order-confirmation.pdf", "sample-packing-slip.pdf", "sample-certificate-of-conformance.pdf", "sample-fai-report-blank.pdf", "sample-rfq-response.pdf", "sample-job-traveler.pdf"]) assert.ok(names.includes(doc), doc);
  // The check really does read these documents: run on the samples folder it finds the address in the ones that print it.
  const inSamples = check.scanDir(samples).findings.filter((f) => f.how.some((h) => /PDF page/.test(h))).map((f) => f.file);
  assert.ok(inSamples.length >= 5, `the address was read from ${inSamples.length} of the sample PDFs`);
  // scripts/preview-documents.js writes to docs/brand/samples by default and refuses a folder that is published.
  const src = fs.readFileSync(path.join(ROOT, "scripts", "preview-documents.js"), "utf8");
  assert.ok(/"docs", "brand", "samples"/.test(src) && !/"public", "brand", "documents"/.test(src));
  const out = path.join(ROOT, "client", "public", "brand", "address-check-probe");
  const refused = spawnSync(process.execPath, [path.join(ROOT, "scripts", "preview-documents.js"), out], { encoding: "utf8" });
  assert.strictEqual(refused.status, 2, "preview-documents refuses to write under client/public");
  assert.ok(!fs.existsSync(out));
  // The Docker image and the build never see docs/.
  const ignore = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8");
  assert.ok(/^docs\/?$/m.test(ignore) || /^docs\b/m.test(ignore), ".dockerignore leaves docs/ out of the image");
});

test("the build: client/dist is clean, and scripts/claims-check.js runs this check", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "claims-check.js"), "utf8");
  assert.ok(/require\("\.\/dist-address-check"\)/.test(src) && /!addressClean\) process\.exit\(1\)/.test(src) && /scanDir\(DIST\)/.test(src), "claims-check fails on a finding anywhere in the build");
  const dist = path.join(ROOT, "client", "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) { console.log("       (client/dist is not built: the built folder itself is checked by `node scripts/claims-check.js` after a build)"); return; }
  const r = check.scanDir(dist);
  assert.deepStrictEqual(r.findings, [], r.findings.map((f) => `${f.file}: ${f.how.join("; ")}`).join("\n"));
  assert.ok(r.scanned > 100);
  // And the gate itself: a copy of the build with one sample put back fails claims-check with exit 1.
  const copy = path.join(tmp, "dist-with-sample");
  fs.cpSync(dist, copy, { recursive: true });
  fs.mkdirSync(path.join(copy, "brand", "documents"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "docs", "brand", "samples", "sample-packing-slip.pdf"), path.join(copy, "brand", "documents", "packing.pdf"));
  let status = 0, output = "";
  try { output = execFileSync(process.execPath, [path.join(ROOT, "scripts", "claims-check.js"), "--dist", copy], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { status = e.status; output = `${e.stdout || ""}${e.stderr || ""}`; }
  assert.strictEqual(status, 1, "claims-check exits 1 when a document sample is in the build");
  assert.ok(/brand\/documents\/packing\.pdf: .*PDF page/.test(output), output.split(ADDRESS).join("[the address]").slice(-600));
  assert.ok(!check.squash(output).includes(check.squash(ADDRESS)), "and does not print the address");
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) {
      failed++;
      // An assertion message could quote what was compared: keep the address out of the log whatever happens.
      console.error(`  FAIL ${name}\n       ${String(e && (e.stack || e.message)).split(ADDRESS).join("[the address]")}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${passed} passed (with ${failed} failed)` : `\n${passed} passed`);
  if (failed) process.exit(1);
})();
