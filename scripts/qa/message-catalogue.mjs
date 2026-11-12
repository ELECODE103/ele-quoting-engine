#!/usr/bin/env node
/**
 * Prints the message catalogue (client/src/utils/messageCatalogue.js) as a
 * markdown table for the owner to review: refusal code → what the buyer reads.
 *
 *   node scripts/qa/message-catalogue.mjs            the table
 *   node scripts/qa/message-catalogue.mjs --server   plus, for each code, the sentence the server sends
 *
 * The words come from the same file the site uses, so the table cannot drift
 * from what is on the screen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatalogue } from '../../client/src/utils/messageCatalogue.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const brand = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'brand.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'shop-facts.json'), 'utf8')).facts;
const turnaround = facts['quote-turnaround'] && facts['quote-turnaround'].confirmed ? facts['quote-turnaround'].value : '';
const cat = createCatalogue(brand, { quoteTurnaround: turnaround });

const WHERE = {
  everywhere: 'everywhere', login: 'sign-in', register: 'create account', 'two-factor': 'two-step setup (admin)', 'recovery-code': 'sign-in with a recovery code',
  resend: 'send the confirmation link again', reset: 'password reset', form: 'request forms', rfq: 'request forms', upload: 'quote tool: upload', quote: 'quote tool: pricing',
  drawing: 'quote tool: attach a drawing', documents: 'admin documents', checkout: 'checkout', order: 'order page', 'firm-quote': 'firm-quote link',
};
const OFFERS = { rfq: 'button: Request a firm quote', retry: 'button: try again', reset: 'button: Choose a new password', 'sign-in': 'link: Sign in', reload: '', 'reopen-quote': 'button: Reopen the quote' };
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

console.log('| Code | Where | What the buyer reads | Offered with it |');
console.log('|---|---|---|---|');
for (const r of cat.table()) {
  const text = r.keepsServerSentence ? `*(the server's own sentence when it names a number, size or date; otherwise:)* ${r.text}` : r.text;
  console.log(`| \`${cell(r.code)}\` | ${WHERE[r.where] || r.where} | ${cell(text)} | ${OFFERS[r.offers] || ''} |`);
}

console.log('\n| Order state | What the buyer reads on the order page |');
console.log('|---|---|');
for (const r of cat.orderStateTable()) console.log(`| ${r.state.replace(/-/g, ' ')} | ${cell(r.text)} |`);
