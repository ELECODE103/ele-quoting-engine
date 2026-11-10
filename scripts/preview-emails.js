#!/usr/bin/env node
/**
 * Writes every email template, filled with sample data, to a folder so the
 * emails can be looked at in a browser without sending anything.
 *
 *   node scripts/preview-emails.js [outDir]      (default: data/email-previews)
 *
 * For each template: <name>.html and <name>.txt, plus index.html linking them.
 */
const fs = require("fs");
const path = require("path");
const samples = require("../server/emails/samples");

const outDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "data", "email-previews"));
fs.mkdirSync(outDir, { recursive: true });

const rows = [];
for (const [name, build] of Object.entries(samples)) {
  const { subject, text, html } = build();
  fs.writeFileSync(path.join(outDir, `${name}.html`), html);
  fs.writeFileSync(path.join(outDir, `${name}.txt`), `Subject: ${subject}\n\n${text}\n`);
  rows.push(`<li><a href="${name}.html">${name}</a> (<a href="${name}.txt">text</a>) — ${subject.replace(/</g, "&lt;")}</li>`);
}
fs.writeFileSync(path.join(outDir, "index.html"), `<!doctype html><meta charset="utf-8"><title>Email previews</title><body style="font:15px/1.7 sans-serif;padding:24px"><h1>Email previews</h1><ul>${rows.join("")}</ul>`);
console.log(`Wrote ${rows.length} templates to ${outDir}`);
