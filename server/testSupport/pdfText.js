/**
 * Text drawn on the pages of a PDFKit document: inflate each content stream and
 * decode the hex strings PDFKit writes for Helvetica. One line per text run.
 */
const zlib = require("zlib");

function pdfText(buf) {
  const raw = buf.toString("latin1");
  let out = "";
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const end = raw.indexOf("endstream", m.index);
    const body = buf.subarray(m.index + m[0].length, end);
    let text;
    try { text = zlib.inflateSync(body).toString("latin1"); } catch (e) { continue; }
    for (const tj of text.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      out += [...tj[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join("") + "\n";
    }
  }
  return out;
}

module.exports = { pdfText };
