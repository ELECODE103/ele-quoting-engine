#!/usr/bin/env node
/**
 * The shop's street address must not be in the client build.
 *
 * The address is printed on customer documents (quotes, packing slips, certificates) and lives in
 * exactly one file, server/config/shipFrom.json. It is not part of the public site. This check
 * reads every file under client/dist — text or binary — and fails if the address is in any of them:
 *
 *   raw bytes      the address as UTF-8, UTF-16 (both byte orders) and in any letter case; and, with
 *                  everything that is not a letter or digit taken out, so that different spacing,
 *                  punctuation, a line wrap, markup between the words or an HTML entity does not hide it
 *   text files     the same after tags, entities, percent-escapes and \uXXXX escapes are decoded
 *   PDF files      every compressed stream is inflated; the text drawn on the pages is decoded
 *                  (literal and hex strings, and glyph codes through the file's own ToUnicode maps,
 *                  which is how a browser-printed or embedded-font PDF stores text) and searched the
 *                  same way; the inflated bytes are searched as well. `pdftotext` is used too when it
 *                  is installed.
 *   known carriers a `brand/documents` folder or a `sample-*.pdf` / `sample-*.png` document sample
 *                  anywhere in the build fails by name: those are renderings of the documents that
 *                  carry the address (a picture of text cannot be found by reading bytes).
 *
 * What it cannot see: text inside a picture (PNG, JPEG, WebP). `--ocr` reads pictures with
 * tesseract when it is installed; that is slow and is not part of the normal build.
 *
 * THE ADDRESS IS NEVER PRINTED. A finding names the file and how it was found, nothing else.
 *
 *   node scripts/dist-address-check.js [dir] [--ocr]      exit 1 on a finding, 2 if it could not run
 *   (scripts/claims-check.js runs it on client/dist as part of the build check)
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SHIP_FROM = path.join(ROOT, "server", "config", "shipFrom.json");
const TEXT_EXT = /\.(html?|js|mjs|cjs|css|json|map|svg|xml|txt|md|webmanifest|csv|dxf)$/i;

/** Letters and digits only, lower case: what is left of an address whatever was put between its words. */
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * What to look for. Built from the address and never shown.
 * A needle shorter than 8 letters and digits would match by accident and is refused.
 */
function needlesFor(address) {
  const text = String(address || "").trim();
  const core = squash(text);
  if (core.length < 8) throw new Error("the address in shipFrom.json is too short to search for safely");
  return {
    core,
    utf8: Buffer.from(text.toLowerCase(), "utf8"),
    utf16le: Buffer.from(text.toLowerCase(), "utf16le"),
    utf16be: Buffer.from(text.toLowerCase(), "utf16le").swap16(),
  };
}

function lowerAscii(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) if (out[i] >= 65 && out[i] <= 90) out[i] += 32;
  return out;
}

/** Text with markup and escapes undone, for files a browser would decode before showing. */
function decodeText(s) {
  let t = String(s);
  t = t.replace(/\\u\{?([0-9a-fA-F]{4,6})\}?/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } });
  t = t.replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  t = t.replace(/%([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  t = t.replace(/<[^>]{0,400}>/g, "");
  t = t.replace(/&#x([0-9a-fA-F]{1,6});/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } });
  t = t.replace(/&#(\d{1,7});/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch { return m; } });
  t = t.replace(/&(nbsp|ensp|emsp|thinsp|shy|zwnj|zwj|amp|quot|apos|lt|gt|middot|bull|ndash|mdash|comma|period);/gi, " ");
  return t;
}

// ─── PDF ───────────────────────────────────────────────────────

/** Every stream of a PDF, inflated when it is compressed (a stream that will not inflate is returned as it is). */
function pdfStreams(buf) {
  const out = [];
  const raw = buf.toString("latin1");
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const body = buf.subarray(start, end);
    let data = null;
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try { data = inflate(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); break; } catch { /* not this way */ }
    }
    out.push(data || body);
    re.lastIndex = end + "endstream".length; // past the word itself: "endstream\n" must not be read as the start of another stream
  }
  return out;
}

/** The glyph-code → text maps a PDF carries for its embedded fonts (ToUnicode CMaps). */
function toUnicodeMaps(streams) {
  const maps = [];
  const hexToText = (h) => { let s = ""; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return s; };
  for (const st of streams) {
    const t = st.toString("latin1");
    if (!t.includes("begincmap")) continue;
    const map = new Map();
    let width = 4;
    for (const block of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) { map.set(parseInt(p[1], 16), hexToText(p[2])); width = p[1].length; }
    }
    for (const block of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
        const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16);
        width = p[1].length;
        if (hi - lo > 70000) continue;
        if (p[3] !== undefined) {
          const base = parseInt(p[3].slice(-4), 16), head = hexToText(p[3].slice(0, -4));
          for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(base + (c - lo)));
        } else {
          const list = [...p[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hexToText(x[1]));
          for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
        }
      }
    }
    if (map.size) maps.push({ map, width });
  }
  return maps;
}

/** The text a PDF draws, decoded every way this file's fonts could mean it. One long string. */
function pdfDrawnText(buf) {
  const streams = pdfStreams(buf);
  const maps = toUnicodeMaps(streams);
  let out = "";
  for (const st of streams) {
    const t = st.toString("latin1");
    if (!/\bT[jJ]\b|'|"/.test(t) || !t.includes("BT")) continue;
    let hexRun = "";
    let literal = "";
    // Strings in the order they are drawn: (literal) and <hex>, inside or outside a TJ array.
    for (const m of t.matchAll(/\((?:\\.|[^\\()])*\)|<([0-9a-fA-F\s]*)>/g)) {
      if (m[1] !== undefined) hexRun += m[1].replace(/\s+/g, "");
      else literal += m[0].slice(1, -1).replace(/\\([0-7]{1,3})/g, (x, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, "$1");
    }
    out += ` ${literal} `;
    if (hexRun) {
      // As plain bytes (the standard fonts)…
      out += ` ${Buffer.from(hexRun.length % 2 ? hexRun.slice(0, -1) : hexRun, "hex").toString("latin1")} `;
      // …and as glyph codes through each font's own map.
      for (const { map, width } of maps) {
        let s = "";
        for (let i = 0; i + width <= hexRun.length; i += width) s += map.get(parseInt(hexRun.slice(i, i + width), 16)) || "";
        out += ` ${s} `;
      }
    }
  }
  return { text: out, streams };
}

function tool(name, args, input) {
  try { return execFileSync(name, args, { encoding: "utf8", maxBuffer: 1 << 27, stdio: ["pipe", "pipe", "ignore"], input, timeout: 60000 }); } catch { return null; }
}
let pdftotextKnown = null;
function hasPdftotext() {
  if (pdftotextKnown === null) {
    try { execFileSync("pdftotext", ["-v"], { stdio: "ignore", timeout: 10000 }); pdftotextKnown = true; } catch (e) { pdftotextKnown = Boolean(e) && e.code !== "ENOENT"; }
  }
  return pdftotextKnown;
}

// ─── One file ──────────────────────────────────────────────────

/**
 * @returns {string[]} how the address was found in this file ([] when it was not). Words only, never the address.
 */
function findIn(file, buf, needles, { ocr = false } = {}) {
  const found = new Set();
  const name = path.basename(file);
  const lower = lowerAscii(buf);
  if (lower.includes(needles.utf8)) found.add("as plain text");
  if (lower.includes(needles.utf16le) || lower.includes(needles.utf16be) || buf.includes(needles.utf16le) || buf.includes(needles.utf16be)) found.add("as 16-bit text");
  const latin = buf.toString("latin1");
  if (squash(latin).includes(needles.core)) found.add("with other spacing or punctuation");
  if (TEXT_EXT.test(name) || buf.length < 4 * 1024 * 1024 && !/\.(png|jpe?g|webp|gif|ico|woff2?|ttf|otf|pdf|wasm|zip|gz|br)$/i.test(name)) {
    const utf = buf.toString("utf8");
    if (squash(decodeText(utf)).includes(needles.core) || squash(decodeText(decodeText(utf))).includes(needles.core)) found.add("behind markup or escapes");
  }
  if (/\.pdf$/i.test(name) || buf.subarray(0, 5).toString("latin1") === "%PDF-") {
    const { text, streams } = pdfDrawnText(buf);
    if (squash(text).includes(needles.core)) found.add("in the text of a PDF page");
    for (const st of streams) {
      if (squash(st.toString("latin1")).includes(needles.core) || lowerAscii(st).includes(needles.utf16be) || lowerAscii(st).includes(needles.utf16le)) { found.add("inside a compressed part of a PDF"); break; }
    }
    if (hasPdftotext()) {
      const t = tool("pdftotext", ["-layout", file, "-"]);
      if (t !== null && squash(t).includes(needles.core)) found.add("in the text of a PDF page (pdftotext)");
    }
  } else if (/\.(svgz|gz)$/i.test(name)) {
    try { if (squash(decodeText(zlib.gunzipSync(buf).toString("utf8"))).includes(needles.core)) found.add("inside a gzip file"); } catch { /* not gzip after all */ }
  }
  if (ocr && /\.(png|jpe?g|webp)$/i.test(name) && buf.length > 15000) {
    const t = tool("tesseract", [file, "-", "--psm", "11"]);
    if (t !== null && squash(t).includes(needles.core)) found.add("in a picture (read by OCR)");
  }
  return [...found];
}

/** Files whose NAME says they are a rendering of a document that carries the address. */
function knownCarrier(rel) {
  const p = rel.split(path.sep).join("/");
  if (/(^|\/)brand\/documents(\/|$)/i.test(p)) return "a sample-documents folder (brand/documents) is in the build";
  if (/(^|\/)sample-[a-z0-9-]+\.(pdf|png|jpe?g|webp)$/i.test(p)) return "a document sample (sample-*) is in the build";
  return "";
}

/**
 * @param {string} dir     folder to read (client/dist)
 * @param {object} [opt]
 * @param {string} [opt.address]  what to look for (default: the address in server/config/shipFrom.json)
 * @param {boolean} [opt.ocr]
 * @returns {{scanned: number, bytes: number, findings: Array<{file: string, how: string[]}>, pdfs: number, pdftotext: boolean}}
 */
function scanDir(dir, opt = {}) {
  const address = opt.address !== undefined ? opt.address : JSON.parse(fs.readFileSync(SHIP_FROM, "utf8")).address;
  const needles = needlesFor(address);
  const findings = [];
  let scanned = 0, bytes = 0, pdfs = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(dir, p);
      const buf = fs.readFileSync(p);
      scanned++; bytes += buf.length;
      if (/\.pdf$/i.test(e.name)) pdfs++;
      const how = findIn(p, buf, needles, opt);
      const carrier = knownCarrier(rel);
      if (carrier) how.push(carrier);
      if (how.length) findings.push({ file: rel.split(path.sep).join("/"), how });
    }
  })(dir);
  return { scanned, bytes, findings, pdfs, pdftotext: hasPdftotext() };
}

/** Print the result (file names and how; never the address) and return true when the build is clean. */
function report(result, dirLabel, log = console.log) {
  if (result.findings.length === 0) {
    log(`Street address check: ${result.scanned} files (${(result.bytes / 1e6).toFixed(1)} MB, ${result.pdfs} PDF) under ${dirLabel} read as bytes, as decoded text and, for PDFs, as page text${result.pdftotext ? " (twice: built-in reader and pdftotext)" : ""}: the shop's street address is in none of them, and no document sample is in the build.`);
    return true;
  }
  log(`\nSTREET ADDRESS IN THE CLIENT BUILD: ${result.findings.length} file${result.findings.length === 1 ? "" : "s"} under ${dirLabel}. (The address itself is not printed; it is the one in server/config/shipFrom.json.)`);
  for (const f of result.findings) log(`  ${f.file}: ${f.how.join("; ")}`);
  log("Everything under client/public is copied into the build and published. Move the file out of client/public (document samples belong in docs/brand/samples/), or take the address out of it.");
  return false;
}

module.exports = { scanDir, report, findIn, needlesFor, pdfDrawnText, decodeText, squash, knownCarrier };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(ROOT, "client", "dist"));
  if (!fs.existsSync(dir)) { console.error(`Nothing to check: ${path.relative(ROOT, dir) || dir} does not exist. Run \`npm run build\` first.`); process.exit(2); }
  let result;
  try { result = scanDir(dir, { ocr: args.includes("--ocr") }); } catch (err) { console.error(`Street address check could not run: ${err.code || err.name || "Error"}`); process.exit(2); }
  process.exit(report(result, path.relative(ROOT, dir) || dir) ? 0 : 1);
}
