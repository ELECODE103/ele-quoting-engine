/**
 * The messages the server sends to the shop about itself: alerts, the daily
 * digest, and the email check. They use the same layout as every other email
 * (emails/templates.js) and go only to the shop's own notification address.
 *
 * Subjects are fixed words plus numbers the server worked out. Nothing a
 * visitor typed — a name, a company, a note, a file name — is ever in a
 * subject, and the bodies carry references and counts, not customer details.
 */
const brand = require("../../shared/brand.json");
const templates = require("../emails/templates");

function alertEmail({ title, lines = [], facts = [], adminUrl }) {
  return {
    ...templates.layout({
      subject: `${brand.name} alert: ${title}`,
      preheader: lines[0] || title,
      heading: title,
      paragraphs: lines,
      facts,
      cta: adminUrl ? { label: "Open Admin → System", url: adminUrl } : undefined,
      after: ["This is an automatic message from the website. The same alert is not repeated for several hours; the System page shows the current state."],
    }),
    template: "opsAlert",
  };
}

function digestEmail({ dateLabel, headline, sections = [], adminUrl, footnote }) {
  // The layout prints `facts` as a two-column table and `paragraphs` as text: each section is a
  // heading line followed by its rows, flattened into one table so it reads as a list.
  const facts = [];
  for (const s of sections) {
    facts.push([`— ${s.title} —`, s.summary || ""]);
    for (const row of s.rows || []) facts.push(row);
  }
  return {
    ...templates.layout({
      subject: `${brand.name} daily digest — ${dateLabel}`,
      preheader: headline,
      heading: `Daily digest — ${dateLabel}`,
      paragraphs: [headline],
      facts,
      cta: adminUrl ? { label: "Open the admin pages", url: adminUrl } : undefined,
      after: footnote ? [footnote] : [],
    }),
    template: "opsDigest",
  };
}

function emailCheckEmail({ when }) {
  return {
    ...templates.layout({
      subject: `${brand.name} email check`,
      preheader: "The website can send email.",
      heading: "The website can send email",
      paragraphs: [
        `This is a test message from the ${brand.name} website, sent ${when}.`,
        "If you are reading it in the shop's inbox, the sending key, the from-address and the notification address are all working. It was sent to the shop's notification address only.",
      ],
      after: ["Check where it landed. If it is in spam, the sending domain's DNS records (SPF, DKIM, DMARC) need another look: docs/launch/go-live-runbook.md, the email section."],
    }),
    template: "opsEmailCheck",
  };
}

module.exports = { alertEmail, digestEmail, emailCheckEmail };
