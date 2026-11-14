# Independent review of the re-review fixes (2026-11-13)

Reviewer: independent (wrote none of the code under review). Code reviewed: `git diff dce1e38..28cb39d`
on `relaunch-2026-11-12`. Nothing was pushed by me, no product code was changed, nothing left the machine
for Stripe, Resend, Turnstile, Railway or a carrier. Machine: 2 cores, 7.8 GB, Node v20.20.0
(`/opt/node20/bin/node`) for every result below, from a fresh clone of `28cb39d`.

"Ran" means a script printed it on this machine, with the counts given. "Read" means I read the code and
did not run it. Scripts named `r3-*.js` are mine and are in `tools/security/rereview-fixes/`; each runs
with one command from the repository root:

```
env -u HTTPS_PROXY -u HTTP_PROXY NO_PROXY=localhost,127.0.0.1 /opt/node20/bin/node tools/security/rereview-fixes/<script>.js
```

## 1. State of this review (true as of the last commit)

**FINISHED.** Every area of the brief has a result below or is named in section 7 as not covered. The
container restarted once during the review; nothing below rests on a run that was cut short (anything in
flight was run again from the start).

| Area | State |
|---|---|
| Reproducing the author's figures on `28cb39d` | Done (section 3). Not re-run: his own heavier worst-case scripts except `units-race-stress.js`; the browser runs except the admin panel; `upgrade-proof.js` |
| Each of the 13 findings attacked | Done (section 4) |
| What the fixes added, as new code | Done (sections 4 and 5: nine new findings) |
| Firm-quote, purchase-order and reorder money paths | Firm quote and purchase order attacked (N-05 and the list under it). Reorder: three checks only (section 7) |
| The four earlier scripts that had only been read | Done (section 5b) |
| Changed-tests audit, price baseline, vetting comparison | Done (section 6) |
| Browser check of the admin panel | Done, with the author's script; screenshots looked at |

## 2. Verdict

**Yes, `28cb39d` can be put online and take payment, once four conditions are met. None of the four needs
a change to the code; two small code changes are recommended soon after.**

All thirteen findings of the earlier review are closed, or closed in the part that mattered. In over 200
hard kills, several hundred raced requests and every access test I ran, I found no way for a stranger or a customer to
read another customer's data, to get an order marked paid for less than was charged, or to stop the site
for seconds at a time. What I did find is nine smaller things. Two cost money if nobody is watching
(N-03, N-05), one can take the site down until the owner acts (N-08), and one turns away an honest buyer
(N-01).

**The conditions.**
1. **Firm quotes (N-05).** Until the request form asks for it, the owner asks every firm-quote buyer for
   the ship-to address BEFORE sending a price. The site will take any address in the world at the quoted
   total.
2. **Labels (N-03).** Before a label is made, the owner checks the state against the ZIP code on every
   order. An address in Hawaii, Alaska, a territory or on a military ZIP gets the mainland parcel price
   when the state box says a mainland state.
3. **The volume (N-08).** The Railway volume is at least 5 GB with no backups kept on it, and the owner
   knows the sign of a full disk: the site answers but new accounts and quotes do not stick, and after a
   restart it does not start (the message says "restore"; the cure is to free space).
4. **The hand tests in section 8**, in particular the three the code relies on and no sandbox can show:
   Stripe refuses payment on a page the site has expired; Resend drops a repeated message with the same
   key; and how long a visitor on a fresh connection waits on Railway while someone checks out (N-09).

**Recommended soon after launch (small code changes):** decide the destination by ZIP code as well as by
state; keep the owner's phone orders off the list the storage clean-up may close (section 4, F-12); let a
buyer's replaced unpaid order go when they check out a changed quote (N-01).

### The thirteen findings at a glance

| Finding | Status | My worst figure | Author's figure for the same thing |
|---|---|---|---|
| F-01 units switched under an order | Closed | 0 mismatches in 200 (his script) + 0 in 40 on a path he did not test; quiet only | 0 in 200, quiet and loaded |
| F-09 order list / admin panel | Closed | lists 200 in 4 to 12 ms loaded; browser 58 of 58; 37 of 37 access tries refused | 4 to 10 ms loaded; 58 of 58 |
| F-08 checkout holds the site | Closed in substance; the 250 ms line is missed under load | thread: 96 ms quiet, 252 ms loaded. A visitor on a NEW connection: 196 ms quiet, **475 ms loaded (30 of 30 over 250 ms)**; three checkouts at once: 504 ms quiet, **1,785 ms loaded** | 104 ms quiet, 184 to 247 ms loaded |
| F-02 partial order after a kill | Closed | 0 partial in 50 kills (ceilings lifted); 0 in 50 as written, where 47 kills hit a refused request | 0 in 50, twice |
| F-06 delivery changed in a second tab | Closed | 0 flagged in 200 raced rounds | tests only |
| F-12 unpaid orders pin the store | Closed for unpaid orders | 74 % after the clean-up; 0 of 3 honest orders closed in one collateral run | 74 % |
| F-13 units change re-prices every draft | Closed | 54 ms quiet, 110 ms loaded (reviewer's script); 0 of 100 stale-price orders or requests | 42 ms, 147 ms; no measurement of the second |
| F-10 / F-11 catalogue upgrade | Closed (one corner Admin cannot reach) | 25 of 26 odd catalogues and markers held | 22 held; 21 tests |
| F-04 unreadable database | Closed; a full disk now stops the start (N-08) | 3 of 3 damaged files refused and untouched | the same |
| F-05 paid and nobody told | Closed | **0 untold in 102 kills, 98 inside the window**; 59 told twice, all with the same key | 0 untold in 80 on the final commit; 9 told twice (measured with no mail provider) |
| F-07 refund before "completed" | Closed | 29 orderings held, 0 differ | tests only |
| F-03 shipping limits | Partly closed (N-03, N-04, N-05) | 12 of 12 refused by state or country; **6 of 6 sold by ZIP under a mainland state; 3 of 3 firm quotes accepted off-mainland**; no price column moved in 300 quotes | table in his write-up; 300 quotes |

## 3. Reproduction of the author's figures on `28cb39d`

From a fresh clone, Node 20.20.0. `git diff b184dc1..28cb39d --stat` touches six files: the write-up, one
test (`unitsRefresh.test.js`), one browser script and three proof scripts. No server or client code. The
author's claim that the proofs made on `b184dc1` stand for the head commit is right.

| Check | Author | Mine |
|---|---|---|
| `npm ci` | exit 0, 0 vulnerabilities | exit 0, 0 vulnerabilities |
| `npm test` | 99 of 99 suites | **99 of 99 suites**, 1,209 cases printed "ok", 0 "FAIL" |
| `NODE_ENV=production npm run build` | exit 0, 22 of 22 routes | exit 0, 22 of 22 routes prerendered |
| `node scripts/claims-check.js` | exit 0, 257 files | exit 0, 257 files (21.3 MB, 1 PDF), street address in none |
| `npm audit --omit=dev` | server 0, client 0 | server 0, client 0 |
| `units-race.js` | 2 held, 0 findings | 2 held, 0 findings |
| `order-list-hold.js` | quiet 3 to 4 ms; loaded 4 to 10 ms | quiet 5 to 7 ms, health worst 7 ms; loaded 4 to 12 ms, health worst 13 ms. All 200 |
| `checkout-hold.js 100 0,6,12` | quiet worst 104 ms; loaded worst 184 ms | quiet 80, 49, 100 ms (worst 100); loaded 161, 140, 176 ms (worst 176). **See F-08 below: this script under-reads** |
| `units-flip-hold.js` | quiet 42 ms; loaded 147 ms | quiet worst 54 ms; loaded worst 110 ms |
| `catalogue-upgrade.js` | 22 held, 0 findings, 2 info | 22 held, 0 findings, 2 info |
| `money-attacks.js` | 66 held, 0 findings | 66 held, 0 findings, 12 info |
| `access-matrix.js` | 25 held, 0 findings | 25 held, 0 findings, 2 info |
| `route-inventory.js` | 0 owner routes without a sign-in check | exit 0, the same |
| `master-upgrade-access.js` | 3 held | 3 held, 0 findings, 1 info |
| `public-surface.js` | 6 held | 6 held, 0 findings |
| `shipping-exposure.js` | exit 0, table in the write-up | exit 0; the table matches (58 x 94 and 6 x 94 sheets: firm quote; 48 x 48 at 1/16 in still sold at $17.76 to $20.23; every one-piece row to Honolulu and Germany: 409) |
| `storage-pin-orders.js pin` | holds, 74 % after the clean-up | holds, 74 %; customer and visitor upload again |
| `durability-kill.js 50` | 11 held, 0 findings, 3 info; section C 0 partial | Sections A, B, E as written: 10 held, 0 findings, 1 info. Section C: 0 partial of 50 both as written and with the ceilings lifted (see F-02). Section D (20 kills): 1 held, 1 info |
| `memory-poison.js` | exit 0; 0 customers refused; "463 MB at the highest reading" | exit 0; 0 customers refused after the attack, 12 of 12 customer files read in 0.1 to 1.5 s. **Server memory read 1,000 MB** straight after the attacker's second 25 MB file, 552 MB after the third, 539 MB thirty seconds later. The author's 463 MB is not the highest reading I got; the earlier review also read 963 MB. On a 1 GB host that is the edge of a hard kill, which F-02 and F-05 now survive |
| `tools/security/review-payments/run-all.sh` (12 proofs) | 0 of 79 checks show the weakness | 0 of 79 (1+4+4+6+8+15+15+5+5+5+2+9) |

## 4. Per original finding

All thirteen are here, in the order they were worked. The table in section 2 has them in one view.

### F-01 (units switched while an order is made): closed

Ran, quiet only (loaded not run by me):
- The author's `units-race-stress.js 200`: **0 mismatches in 200 attempts** (140 orders paid and compared
  with the stored part, 45 requests, 10 checkouts refused with the new price, 200 units changes refused,
  50 applied; the draft priced again 200 of 200). The author's figure: 0 of 200. Reproduced.
- The earlier reviewer's `units-race.js`: 2 held, 0 findings (was 3 of 3 exploited).
- Mine, `r3-units-paths.js`, the paths that script does not take: **9 held, 0 findings.** A visitor's
  part (uploaded with no account) ordered by an account while the visitor's edit key changes the units,
  40 rounds with a sweeping gap: 29 orders made, every one for the part as stored; 11 refused; 0
  mismatches. After the order exists the visitor's key, the buyer, another account and the owner are all
  refused. A paid order carries no "part changed" flag, and a reorder prices the stored part at the same
  figure with the part still locked.

Read: the only place that replaces a part's measurements is the units route (`partsDB.update` with
measurements is called nowhere else; there is no replace or re-upload route). Claiming a part for an
account writes the owner only and does not move the revision number, so an ordinary order is not flagged.
The lock is asked again in the same step as the write, after the wait; a checkout's final pass is one
step; the runner starts the pricing again when a part's revision moved during the warm-up.

### F-13 (a units change re-prices every draft in one step): closed

Hold, reproduced with the earlier reviewer's `units-flip-hold.js` (25 drafts of 100 lines): quiet worst
54 ms, loaded worst 110 ms (author: 42 and 147 ms; it was 592 to 753 ms). I did not re-run the author's
heavier `units-flip-worst.js` (his worst: 229 ms loaded) and did not watch this one with the denser
watcher used for F-08; the same caveat about a visitor on a new connection applies.

The sentence that had no measurement, "a saved quote can show the old price … it cannot be ordered or
sent as a request at that price": ran `r3-units-paths.js` section 1. Straight after the units answer,
with the stored quote still showing the small price (checked: 100 of 100 times), 20 rounds through each
door:

| Door | Result |
|---|---|
| pay, with the old total confirmed (what the page sends) | refused 20 of 20, `quote-changed` with the new price |
| pay, with no total sent (a hand-built request) | 20 orders, each at the NEW price and matching the stored part; Stripe shows that amount |
| send as a firm-quote request | refused 20 of 20, `quote-part-changed` |
| the owner's phone order | refused 20 of 20 |
| the owner's phone order with the old total confirmed | refused 20 of 20 |

Nothing was made at the old price: 0 of 100. The sentence holds. (The quote PDF in Admin prints the
stored figure, so for those seconds the owner could print a quote at the old price. It is the owner's own
page.)

### F-07 (refund before "completed"): closed

Ran `r3-event-orderings.js`: **29 held, 0 findings, 3 notes.** Every ordering and every repeat of:
completed + full refund; async-payment-succeeded + full refund; completed + part refund; part refund then
full refund with "completed" first, second and last; completed + dispute opened; dispute opened then lost
with "completed" in each position; dispute + full refund + completed in four orders. In each set every
ordering ends in the same state, a fully refunded order ends "refunded" and out of the production queue,
and the buyer never gets more than one confirmation. The author gave tests only; this is the measurement.

Also run: an order closed unpaid by the new storage clean-up (F-12), then paid anyway, then refunded. It
is flagged "late payment", never released, and the repeat changes nothing.

Three notes, none a finding:
- An order closed by the clean-up, then **refund reported before the payment**: it ends "expired" with
  the "late payment" flag still up although the money has gone back. With payment-then-refund the flag
  is cleared. The owner sees a flag on an order that needs nothing. Harmless; it needs a refund to be
  reported before its own payment, on an order that was already closed.
- An order closed by the clean-up, then marked paid by hand (a cheque), then the old closed card page
  reported paid: the card payment is treated as a repeat and **not** flagged as a second payment. Stripe
  does not take money on a page the site has expired, so this should not occur; if Stripe ever reported
  it, the owner would hold two payments with no flag. Was there before the fixes.
- "Expired" and "completed" for one session in either order: the payment is never dropped (paid, or
  flagged). Stripe cannot send both for one session.

### F-06 (delivery choice changed in a second tab): closed

The author gave no measurement. Ran `r3-shipping-firm-f06.js` section E: **200 rounds**. In each, tab 1
has a pickup payment page; then, at random offsets of 0 to 14 ms and with the Stripe stand-in answering in
0, 1, 3 or 8 ms, three things happen at once: the buyer pays whatever page of the order is open at that
instant and Stripe reports it by webhook; tab 2 presses pay with "ship" selected; the return page asks
for confirmation. Result: **0 of 200 flagged; 0 of 200 with an amount that differs from what was
charged; 0 charges left without a paid order.** 187 ended paid as pickup at the pickup amount, 13 ended
unpaid because no page was open at the instant the buyer tried (nothing charged). Tab 2 was answered
"already ordered" 154 times and sent to the paid order 46 times.

Read, not run: with a payment method that settles later (a bank debit), a page can be "complete" and not
yet "paid". Such a page is treated as closed, the order is changed, and the late success would then be
flagged. Card-only checkout, as configured, does not produce this.

### F-03 (shipping limits): partly closed

What holds (ran `r3-shipping-firm-f06.js` sections A to C, and the earlier reviewer's
`shipping-exposure.js`):
- Hawaii, Alaska, Puerto Rico, Guam, military mail and other countries, **by state code, by state name,
  mixed case and padded**: refused, 12 of 12 (409 with the way to a firm quote; a country that is not a
  two-letter code: 400).
- An unpaid order to Ohio cannot be re-addressed to Hawaii or Germany; a pickup order cannot be switched
  to "ship it" for a Hawaii address (3 of 3; the order is unchanged each time).
- Six lines that are each inside the limits (38 lb a sheet) and 237 lb together: firm quote, and
  checkout refuses.
- A stored quote whose quantity is changed behind the page: checkout refuses.
- The $12.00 + $2.50 a kg rule is unchanged for orders inside the limits ($12.06 on the test order).

What does not hold: findings **N-03** (the ZIP code is not looked at), **N-04** (a long part drawn on
the diagonal), **N-05** (the firm quote, which is where every refused order is sent, takes any address).
**No part price moved (ran, independently).** `vetting-compare.js dce1e38`: 300 quotes on the commit
before the fixes and 300 on this one, each "0 fails, 63 warnings". 64 rows differ and the only columns
that differ are `gateCodes` and `requiresRfq`: 55 rows that were already firm-quote rows gain the reason
`shipping-freight`, and 9 rows change from "sold online" to "firm quote" with that reason alone. No
price, cost, time or DFM column differs in any row. The author's figures are the same: 64, 55 and 9.

### F-09 (order list, admin panel): closed

Ran `order-list-hold.js` (above) and `r3-caps-and-lists.js` section 5 and 6:
- Another customer and a visitor, knowing the order id: 20 of 20 tries to read, reorder, confirm or print
  another customer's order refused (single-order route, traveler, drawing, certificate, reorder,
  confirm-payment, four PDF routes).
- 17 odd page values as another customer (negative, zero, 1e99, text, fractions, a 21-digit number,
  lists, objects, `userId=` of the victim, `attention=1`, SQL text): always 200, never anybody else's
  order, never more than 100 rows.
- A customer's list rows carry no lines, no address tag and no shop notes; the single-order answer
  carries the lines and none of the shop's fields or part measurements.
- A 100-line order through the single-order route: 256 kB, 11 ms.

In a browser (ran the author's `scripts/e2e/admin-panel-load.mjs` with the preinstalled Playwright, on a
12 MB database of 442 orders, at 1360 px and 390 px): **58 of 58 checks**, the author's figure. I looked
at the screenshots of the failed-order-list case at both widths myself: the Orders tab shows "The order
list did not load. … The other tabs are not affected." with a "Try again" button, the figures above it
and the tab bar are there, and nothing scrolls sideways. One small thing: the notice the OWNER sees ends
"call 224-213-6727 or email quotes@straightedgemfg.com and we'll sort it out", which is the shop's own
number; the wording was written for customers.

Other admin lists (read): the quotes list and the parts list are capped (200 by default, 1,000 at most),
the requests list stops before half the answer ceiling, the figures are counts. The production queue is
not capped but only holds paid or purchase-order work. One order's traveler still reads every distinct
part of that order with its measurements; a single order of many different dense drawings could pass the
16 MB answer ceiling for that one traveler. I did not build that case.

The ceilings on unpaid orders that the author added under this finding are findings **N-01** and **N-02**.
The author's statement that the test harness lifts the ceilings by default is true; one suite
(`server/routes/orderList.test.js`) runs with the real ceilings, and the comment in the harness names a
file, `routes/orderCaps.test.js`, that does not exist.

### F-02 (part of an order after a hard kill): closed

Ran the earlier reviewer's `durability-kill.js 50`, section C (a 20-line quote, the server killed 4 to
124 ms after "pay" is pressed):

| How it was run | No order on disk | Whole order | Partial order |
|---|---|---|---|
| As written | 47 | 3 | **0** |
| As the author ran it (the four ceilings on unpaid orders lifted by environment variable) | 28 | 22 | **0** |

What each shows. As written, the script's one account is refused its fourth unpaid checkout by the new
ceiling, so 47 of the 50 kills fall on a request that was never going to make an order: that run proves
almost nothing about F-02 and the author was right to lift the ceilings for it. With them lifted, 22 of
50 kills landed after the order was written and every one of those orders was whole; none of the 50 left
a partial order (it was 5 or 6 of 8). The author's figures for the same run: 0 partial, twice. Sections
A, B and E as written: 10 held, 0 findings, 1 note (a re-priced draft may lose its last re-price, as
designed). Section D (20 kills): every order paid after the retry; none of the 20 kills landed in the
email window, which is why F-05 has its own script above.

The start-up close-out (`services/orderRepair.js`), read, not run beyond the author's tests: it looks
only at orders with no line count on record, or whose lines no longer match the count. An order made by
this code carries its count, so a complete order is never a candidate. For an older order it closes only
an **unpaid card** order with fewer lines than its quote, or whose quote is still a draft; a paid order
is only ever flagged. On the live database (written by `master`) every order is looked at once at the
first start. An old unpaid order whose quote is still a draft will be closed as "not paid, closed" then;
with the site having been offline, any such order's payment page lapsed long ago, so nothing a buyer can
still use is lost. I did not find a way for it to close or alter a complete order.

### F-04 (a database file that cannot be read): closed; and yes, there is now a state in which the site will not start (N-08)

Ran `durability-kill.js` section E: a zero-length file, the first third of the file, and a file that is
not a database are each refused at start (exit 1) and left byte for byte; a half-written temporary file
beside a good database is ignored. The health check answering 503 without a database is covered by the
author's `databaseOpen.test.js`, which passes in the full suite.

Is the save atomic? Yes: a temporary file is written and flushed, then renamed over the database
(`writeDurably`); a kill before the rename leaves the old file whole, after it the new one. In over 200
hard kills in my runs (durability-kill and the email-window script) the server always started again on
the file it found.

Can a stranger, over HTTP, produce a file the next start refuses? I found no way to damage the file. But
a **full disk** makes the start refuse a perfectly good file: finding N-08.

### F-10 and F-11 (the catalogue upgrade): closed, with one corner that Admin cannot reach

The earlier reviewer's `catalogue-upgrade.js`: 22 held, 0 findings (was 8 findings). Reproduced.

Ran `r3-catalogue-odd.js`: **25 held, 1 finding, 2 notes.**
- **Markers, 17 of 17.** On a current catalogue carrying an edited price, an edited machinability, a
  material switched off, a material added by hand and a material deleted, with the marker missing, null,
  0, -1, "4", "3", "abc", 4.5, 3, 99, 1000, true, a list, an object, 1, 2, and with the pricing-rules row
  deleted outright: the start never fails, every edit is exactly as it was, a second start changes
  nothing, and no active material is left without a price. For all but the two real older versions (2
  and 3) the start prints "CATALOGUE NOT UPDATED" and records it. A marker newer than the code (99, 1000)
  is left as it is. A bad marker never means "replace everything".
- **Odd catalogues through a real upgrade from version 3, 8 of 9.** Two rows with one slug; a row with no
  slug; a renamed slug; rows named `__proto__`, `constructor`, `toString`, `hasOwnProperty`, `valueOf`;
  an edited row with fields of the wrong type and a 5,000-character name; a price of a trillion, a
  negative price and a text price; every material deleted; one material left and switched off. The start
  never fails, nothing the owner had deleted from the old catalogue comes back (the eight resins that are
  new in this version arrive, which is right), no unusable price is left in force, and each case prints
  lines that name what was kept or could not be.
- **The one that does not hold (Low, was there):** with every finish deleted, the upgrade itself keeps
  them deleted and says so, and the NEXT start seeds all 32 default finishes again, printing only "Seeding
  finishes...". The same goes for an empty materials table. An empty table is read as "a new database".
  Admin has no button that deletes a finish (there is no such route), and nobody deletes every material,
  so I do not expect the owner to meet this.
- Note (was there, narrowed by the author): a catalogue in which no material has a price in any of three
  fields is still replaced by the defaults at start, finishes included, with nothing in the change log.
  It now needs every row to be like that, not just the first.

Read: the upgrade is one database change, so a failure part way leaves the catalogue as it was. That the
kept and not-kept lines appear on Admin → Pricing: the author's browser script, which I re-ran (58 of 58),
checks that notice in both its forms at both widths.

### F-12 (unpaid orders hold the file store): closed for unpaid orders; the store can still be held for an hour at a time by new files (N-07, was there)

Ran the earlier reviewer's `storage-pin-orders.js pin` (1:10 scale): 13 accounts, store at 100 % right
after the flood with a visitor and a customer both refused; after the clean-up **74 %**, a customer
accepted at the first knock and a visitor at the second. The author's figure for the same run: 74 %.
Reproduced.

The other direction, "can the new closing of unpaid orders hurt an honest customer". Ran
`r3-pressure-collateral.js` once (1:10 scale; the customer's protected "first hour" set to 4 minutes):
two honest customers on the payment page with files older than the protected time, the owner's phone
order waiting for a cheque, then 12 accounts filling the store to 97 % with new files in 27 seconds.
Watched for 96 seconds with four refused uploads to trigger the clean-up. **Neither honest order was
closed, the phone order was not touched, nobody was emailed (0 of 3 hurt, 1 run).** From reading
`relieveStorage`: unpaid orders are closed only when the store is still at or over 85 % after everything
that nothing refers to has been removed, and a flood's own unreferenced files go first once they are no
longer new. So an honest order is closed only when the flood itself is made of unpaid orders, and then
the heaviest holder (the flood) is closed first. I could not construct a case that closes an honest
order ahead of the attacker's, in one attempt; I did not try a second construction.

Two things from reading that I could not show either way, because nothing was closed in my run:
- The author writes that a phone order is never touched. The list the clean-up builds
  (`storagePressure.js` line 522) takes every unpaid order whose payment method is "card" **or empty**,
  and a phone order made in Admin is stored with the method empty (`routes/orders.js`, the admin
  `POST /api/orders` sets none). `closeUnderPressure` keeps an order only when its method is set and is
  not "card". So a phone order is on the list and would be closed like a card order if the pass got to
  it. If that happens its lines can later be cleared under database pressure, after which it "cannot be
  marked paid" by hand. Unproven; worth one line of code and a test before it matters.
- A payment that arrives after an order was closed to make room is flagged "late payment" and not
  released (ran, in `r3-event-orderings.js`). By then the file may have gone. The site relies on Stripe
  refusing payment on a page it has expired; see the hand tests.

### F-05 (paid, and nobody is told): closed; a repeat email after a kill is likelier than the author's figures suggest and rests on the mail provider

The author's proof (`paid-mail-kill.js`) runs the server with **no mail provider**, which is a different
path in the code: without a provider the "email owed" record is closed at once. In production the
provider is on, a message counts as sent only when the provider answers, and that call is the window.

Ran `r3-paid-mail-window.js` (three runs): the server as in production with a placeholder mail key; the
provider's API answered by a local stand-in that takes 40 ms to accept a message and 40 ms more to
answer, and writes each step to a file; the script kills the server at an exact step. Counted from what
the provider accepted.

| Kill lands | Afterwards | Kills | In the window | Never told | Told once | Told twice |
|---|---|---|---|---|---|---|
| the first email has just reached the provider | event sent again | 15 | 15 | 0 | 15 | 0 |
| the provider has accepted, not yet answered | event sent again | 15 | 15 | 0 | 0 | 15 |
| the provider has just answered | event sent again | 12 | 12 | 0 | 0 | 12 |
| random, 1 to 120 ms | event sent again | 12 | 10 | 0 | 7 | 5 |
| the first email has just reached the provider | restart only | 12 | 12 | 0 | 12 | 0 |
| the provider has accepted, not yet answered | restart only | 12 | 12 | 0 | 0 | 12 |
| the provider has just answered | restart only | 12 | 12 | 0 | 0 | 12 |
| random, 1 to 120 ms | restart only | 12 | 10 | 0 | 9 | 3 |
| **Total** | | **102** | **98** | **0** | 43 | 59 |

**0 of 102 paid orders with nobody told** (it was 5 of 8 and 7 of 8 before the fix). Every order was
paid; none was lost. Every one of the 59 repeats carried the **same Idempotency-Key** as the first
request (0 with a different key, 0 messages without a key), so a provider that honours the key drops
the repeat.

Author's figure against mine: he reports 2 of 40 and 4 to 8 of 40 told twice. With the provider on, a
kill anywhere between "the provider has it" and "the server has written that down" repeats the message,
and I got 59 of 98. That is the design he chose ("at least once") working as designed; the number of
repeats a customer would see is zero only if Resend drops a repeated key. A hard kill during a payment
is itself rare.

Looked at, read only: the "email owed" record holds the order id, the kind of message, the site address
and, for a payment notice, the flag's note and amounts; the message itself is built from the order when
it is sent, so no extra copy of a name or address is stored. Records are closed, not deleted (two or
three small rows per paid order; nothing a stranger can add to without a signed Stripe event). A record
that cannot be sent is tried again with a growing wait and given up after a day with a line in the log;
one bad record does not stop the others. A repeated event sends only what is still owed.

### F-08 (checkout holds the site): closed in substance; the 250 ms line is met on a quiet machine and is not met under load for a visitor on a new connection

The line was "longest hold under 250 ms with a 100-line quote on a 12 MB database". The author reports
worst 104 ms quiet and 184 ms loaded with the earlier reviewer's script, and 247 ms loaded with his own.

Ran `r3-checkout-dist.js single 11.7 <batches> 3`: checkouts of 100 lines of a printed cube ($1,654.36),
the database between 11.8 and 12.6 MB for every sample (a new server per three checkouts, because each
100-line unpaid order adds 0.3 MB). The health page is asked for every 5 ms for the whole of each
checkout, two ways at once:

- on connections that are **already open** (a browser that is on the site; a proxy in front of it). A
  request on an open connection is answered at the server's next look at the network, so its longest
  wait is the longest single piece of work: this is "how long the thread was held".
- on **new connections** (a visitor arriving). A new connection is accepted at one look and read at the
  next. Checkout now does its work in pieces with one look between them: the final pricing pass, then the
  write of the database file, then a second write when the payment page is recorded. So a new connection
  waits for two of those back to back. The earlier reviewer's script and the author's both use new
  connections but ask one at a time every 20 ms, which mostly misses this.

| Machine | Reading | Samples | Median | 90th pct | Worst | At or over 250 ms |
|---|---|---|---|---|---|---|
| Quiet | open connection (thread hold), both watchers running | 12 | 72 ms | 88 ms | **96 ms** | 0 of 12 |
| Quiet | new connection, one watcher | 30 | 142 ms | 171 ms | **196 ms** | 0 of 30 |
| Quiet | new connection, both watchers running | 12 | 235 ms | 250 ms | 287 ms | 2 of 12 |
| Loaded | open connection (thread hold), both watchers running | 15 | 181 ms | 204 ms | **252 ms** | 1 of 15 |
| Loaded | new connection, one watcher | 30 | 357 ms | 457 ms | **475 ms** | **30 of 30** |
| Loaded | new connection, both watchers running | 15 | 626 ms | 858 ms | 908 ms | 15 of 15 |

The checkout itself answered in 151 ms (median, quiet) and 376 ms (median, loaded). The watchers are
themselves work for the server (200 to 400 small requests a second), so the "both watchers" rows are
pessimistic; the "one watcher" rows are the ones to hold against the author's figures.

**Author's figure against mine, and why they differ.** Author: 184 ms loaded (earlier reviewer's script),
247 ms loaded (his own). The same reviewer's script run by me in the same session: 176 ms loaded. My
watcher: 252 ms worst for the thread itself (in agreement with his 247: both are at the line, not inside
it), and 475 ms worst for a new connection. The difference is not that his runs were lucky; it is what
is being measured. His figure is honest for "longest single piece". A visitor who arrives during a
checkout waits for two pieces.

**Judgment.** The fault that was found is fixed: the time no longer grows with lines times database size
(4.2 s became under half a second in every one of 87 samples), and nothing here stops the site. The
acceptance line as written is met on a quiet machine and missed under load: a new visitor waited 285 to
475 ms in 30 of 30 loaded checkouts. Each account is still limited to 12 checkouts in 15 minutes, so the
most one account can do is slow new arrivals by under half a second, twelve times in a quarter of an
hour. I would launch with this.

Not shown here, and it matters for this number: each of those pieces ends in a flush of a 12 MB file to
disk. On this machine that is a local disk. On Railway the volume is network storage and the flush may
take longer; the figure to check after the first deploy is how long a save takes there (Admin → System
shows the database size; the log line for a slow save, if any, is the thing to look for).

**Several checkouts at once.** Ran `r3-checkout-dist.js together 11.5 3 2` (three accounts press pay on
their own 100-line quotes at the same instant, database 11.7 to 12.9 MB, 6 samples each way, all 18
checkouts accepted):

| Machine | Thread hold (open connection) worst | New connection: median, worst |
|---|---|---|
| Quiet | 117 ms | 474 ms, **504 ms** (6 of 6 at or over 250 ms) |
| Loaded | 285 ms (2 of 6 at or over 250 ms) | 1,586 ms, **1,785 ms** (6 of 6) |

So the pieces stay short, and a visitor on a new connection waits for all of them. That is finding N-09,
which is about how the pieces are chained and not about checkout alone. The kill tests are under F-02 and
the swap attack is N-06.

## 5. New findings

Severity is mine. "New" means opened by the fixes; "was there" means it existed at `dce1e38`.

### N-01 (Low to Medium, new): an honest buyer who goes back and changes the order three times is locked out of checkout for about two hours

**What happens.** The new ceiling allows one account three orders "waiting for a card payment" at once.
A buyer reaches the card page, goes back, changes a quantity and presses pay again. A quote that has been
sent to checkout is no longer a draft, so the change makes a new quote, and paying for it makes a new
order; the old one stays "waiting" until its payment page lapses (120 minutes by default, plus up to 10
minutes for the sweep). On the fourth try the buyer is refused:

> You have 3 orders waiting for payment, which is the most we keep open at once. Pay for one of them from
> Your orders, or wait for it to close (a payment page stays open for 2 hours), then check out again. To
> place this order by phone, call 224-213-6727.

The buyer has no way to close an unpaid order themselves (ran: `PUT /api/orders/:id/status` as the
customer answers 403; there is no delete route). They can pay for one of the three older versions (not
what they want), wait about two hours, or phone. The same account is also limited to eight unpaid
checkouts in any 24 hours.

**How often.** Ran `r3-caps-and-lists.js` with the real ceilings (harness started with
`{ orderCaps: true }`): 1 of 1; it is deterministic. Refused on change number 4, after 3 visits to the
card page; `429 unpaid-orders-limit`, `Retry-After: 3600`. After the pages lapse and the sweep runs,
checkout answers 200 again. The eighth-a-day ceiling refuses the 9th unpaid checkout (1 of 1).

**Cost.** A lost or delayed order from exactly the kind of buyer who is trying to get the order right.
No money is charged wrongly.

**What would close it.** Any one of: closing the buyer's previous unpaid order for the same parts when a
new one is made from the changed quote; letting the buyer cancel an unpaid order; or not counting an
order whose quote the buyer has since replaced.

### N-02 (Low, new): two buyers behind one office address share five places

**What happens.** The ceiling per network address is five unpaid orders at once (16 a day), whoever's
they are. Two people in one office (or one university, or one mobile carrier's shared address) who each
have unpaid orders use each other's places.

**How often.** Ran `r3-caps-and-lists.js` section 2: Ann opens 3 unpaid orders, Bob (another account, the
same address) is accepted twice and refused on his third (`429 unpaid-orders-limit`, 1 of 1). From
another address Bob is accepted. Each is inside their own ceiling of three.

**Cost.** The same as N-01, for a buyer who did nothing. Rare for a shop of this size; listed because
the brief asked whether the ceilings can lock an honest customer out, and they can.

Read, not run: the address is the one Railway's edge reports (`trust proxy` with one hop). A header sent
by the buyer does not change it as long as `TRUST_PROXY_HOPS` matches the real number of proxies; that
setting was there before and I did not find a way round the ceilings by header.

### N-03 (Medium, business; F-03 not closed for a buyer who mis-states the state): the ZIP code is not looked at

**What happens.** "Outside the contiguous United States" is decided from the country and the STATE field
only. The state is a free-text box on the checkout page. A Honolulu address entered with state "CA" and
ZIP 96813 is given the parcel price.

**How often.** Ran `r3-shipping-firm-f06.js` section A: **6 of 6 sold**, each with $12.06 shipping on a
$233.05 order: Honolulu ZIP 96813 under "CA"; Anchorage 99501 under "WA"; San Juan 00901 under "FL";
military ZIP 09012 under "NY"; Guam 96910 under "CA"; and "Hamburg, Germany" typed into the city and
street lines with the country left out and state "DE" (Delaware).

**Cost.** The difference between what the site charged and what a parcel to Hawaii, Alaska, a territory
or a military address costs: tens of dollars for a light box, a few hundred near the 50 lb limit (my
assumption; I called no carrier). The order is paid before the owner sees the address. The owner can
catch it when the label is made (label software rejects a state that does not match the ZIP) and refund,
at the cost of the card fee and the time.

The other direction is a small nuisance, also run: a mainland buyer who types "D.C.", "Washington DC",
"Ill." or "N.Y." in the state box is told "for this address we confirm freight before you order" (4 of
4). "IL", "il", "Illinois", "New York", "DC" are accepted.

**What would close it.** Decide by ZIP code as well (the off-mainland ZIP ranges are short and fixed), or
make the state a list.

### N-04 (Low, business): a long part drawn on the diagonal is inside the 48 in limit

Ran `r3-shipping-firm-f06.js` section C, 1 of 1: a 3 x 62 in strip drawn straight reads 62 in and goes to
a firm quote; the same strip drawn at 45 degrees reads 45.96 in (the upright box) and is sold with $12.47
shipping on a $146.54 order. A 62 in parcel is shippable but carries the carrier's long-package charge.
Geometry up to about 67 in fits this way. Small money; listed because the limit is stated as "longest
side".

### N-05 (Medium, business; was there, and F-03 now sends every large or far order down this path): a firm quote can be accepted to any address in the world at the quoted total

**What happens.** F-03's fix sends an order that is too long, too heavy or going outside the contiguous
states to a firm quote. The request the owner then prices carries no ship-to address (ran: the request
row has no ship-to fields; the request form does not ask). The address is typed when the buyer accepts,
and nothing checks it: the order is made at the quoted total with a shipping line of $0.

**How often.** Ran `r3-shipping-firm-f06.js` section D: a $480 firm quote accepted by card to Honolulu,
to Hamburg (country "DE") and to Anchorage: **3 of 3 accepted**, order $480 each. The firm-quote page has
no country box at all, so an overseas buyer is recorded as "US".

**Cost.** Whatever freight to that address costs beyond what the owner allowed for, on every firm quote
where the owner assumed a mainland address. On a pallet or an oversize sheet that is hundreds of dollars.
The owner sees the address after acceptance (and, by card, after payment).

**What would close it.** Ask for the ship-to address on the request and show it to the owner beside the
price box; or apply the same destination rule at acceptance and send a mismatch back to the owner.
Until then: **the owner must ask every firm-quote buyer where it is going before sending a price.**

What held on the firm-quote and purchase-order path (same script, all ran): accepting with another total
on the page is refused (409); a card accept and a purchase-order accept at the same instant make one
order; the order is at the owner's total whatever the request body says; the price cannot be edited under
an accepted quote; the card page is for the quoted total; a doctored report of $1.00 paid on $480 does
not release the order (flagged); after the owner revises a price the first link is dead (410); a second
acceptance with another PO number or a card is refused; a part on a firm-quote request cannot have its
units changed (409 `part-locked`); an unconfirmed purchase-order order cannot be reordered.

Worth knowing, by design: a purchase-order acceptance needs no login and no card. The link in the email
is the only credential, and the order goes straight into the production queue as "pending PO" with
nothing charged. The owner confirming the PO by hand is the only check.

### N-06 (Low, new): the checkout's final pass prices a quote that was swapped in after its warm-up, in one piece

**What happens (read).** Checkout prices in "warm-up" pieces and then runs a final pass "with everything
priced already in the runner's memo" (`routes/orders.js` `orderStep`, `services/pricingMemo.js`). Before
the final pass the runner checks that no part and no catalogue table changed. It does not check the
quote, which the final pass reads afresh. If the buyer re-prices that same draft into a heavier quote
between the warm-up and the final pass, the final pass finds none of it in the memo and prices it all in
one uninterrupted step, with the write of the order behind it.

**Measured.** Ran `r3-swap-under-checkout.js 20 0` (quiet, new database): one account re-prices its
one-cube draft as 25 different 6,000-segment discs ($2,518.51, the heaviest quote of that kind that can
be ordered online) and presses pay 90 to 260 ms behind it. Re-pricing alone: a new connection waited 186
to 220 ms (4 runs). With the checkout sent 90 to 135 ms behind: 343 to 376 ms (6 of 6); **10 of 20 tries
at or over 250 ms, worst 376 ms**; once the checkout arrives after the re-price has finished the figure
is back to about 200 ms. I did not separate "the final pass priced it in one step" from "two jobs
overlapped" beyond that; the cause is from reading the code.

**Cost.** Small. The step is bounded by the most expensive quote that can still be ordered online, which
on this machine prices in about a quarter of a second. It is not the seconds-long stop F-08 was. It is
listed because the comment in the code says the final pass is "lookups, then the save", and for a swapped
quote it is not. Twelve checkouts per account per 15 minutes still applies.

**What would close it.** Have the runner compare the quote's own revision (or its updated-at) before the
final pass, as it does for parts, and start again when it moved.

### N-07 (Low to Medium, was there): new files from confirmed accounts hold the file store for their first hour, with or without orders

Ran `r3-pressure-collateral.js`, 1 of 1: 12 confirmed accounts (1:10 scale; 14 at full scale) fill the
store to 97 % in 27 seconds with uploads and nothing else: no quote, no order. For the rest of the run
(96 seconds, four tries) a visitor without an account was answered "uploads paused". A signed-in
customer's file is not removed by any clean-up in its first 60 minutes (`CUSTOMER_PART_KEEP_MINUTES`),
so the store stays there until those files are an hour old, and the same accounts can then upload
again. I did not run through the protected time; the earlier reviewer's control run shows the store
clears once it has passed. The earlier review mentioned this in a bracket and did not list it. The fix
for F-12 does not touch it and was not asked to. While it lasts every visitor is told to email the files
or phone. Cost to the attacker: 14 confirmed email addresses and 14 network addresses per hour held.
What would shorten it: a lower `CUSTOMER_PART_KEEP_MINUTES` for parts that are on no quote.

### N-08 (Medium; the silent part was there, the refusal to start is new): on a full disk the site says "saved" when it is not, and after a restart it will not start

Ran `r3-full-disk.js` on a 3 MB disk (1 of 1): one account is made, the disk is filled, then:

| Step | What the site did |
|---|---|
| A second account is registered with the disk full | **Answered 201 "created"**. The log says `SqliteDB run error [users]: ENOSPC`. The account exists in memory only |
| Health check | **200 "ok"** |
| The database file | whole (integrity "ok"), still holds the first account; the second is not in it |
| Server stopped and started again, disk still full | **Does not start: exit 1.** "FATAL: the database file … is there but cannot be used: it could not be opened or brought up to date (ENOSPC: no space left on device, write) … Restore the volume from its backup; do not delete the file" |
| Space freed, started again | Starts, health 200, first account there; the second account is gone |

Two things are wrong here. (1) While the disk is full the site goes on answering "yes" to things it
cannot keep, and the health check stays "ok", so Railway sees a healthy service. A single write that
fails is logged and stepped over (`models/SqliteDB.js`); only the multi-row changes the fixes added
(orders, payments) fail loudly. (2) Every start writes the file once, so with a full disk the new
start-up check reads the failed write as "the database cannot be used" and stops, telling the owner to
restore from backup when the cure is to free space. **The honest statement the brief asked for: if the
volume fills, the site stays down after its next restart until the owner frees space; the database file
itself is not harmed.**

**How likely.** The file store may hold 2,048 MB by default, plus the measurement files beside it, the
database twice over during a save, drawings, and whatever backups are kept on the same volume. If the
Railway volume is not comfortably larger than that, fourteen confirmed accounts uploading to their
allowance (N-07) can fill it. With a volume of 5 GB or more and no backups stored on it, I do not see a
way for a stranger to reach it.

**Cost.** Downtime from the restart until the owner notices and frees space; and anything acknowledged
while the disk was full (accounts, single-row changes) is lost at that restart.

**What would close it.** Make the health check fail after a failed save; make a failed single write an
error to the caller; word the start-up refusal for ENOSPC ("the disk is full") instead of "restore".

### N-09 (Low to Medium; the mechanism was there, the fixes rely on it more): "in pieces" protects visitors who are already connected, not visitors who are arriving

**What happens.** The site's answer to every "this holds the thread" finding (F-08, F-13, and the pricing
runner before them) is to do the work in short pieces and let the server look at the network between
them. That works for a connection that is already open. A NEW connection is not served between pieces:
it is answered when the whole chain of back-to-back pieces is over.

**Shown without any of the site's code.** Ran `r3-loop-experiment.js` three times (a bare Node 20.20.0
HTTP server doing 12 pieces of 80 ms chained with `setImmediate`, the same way the runner chains its
pieces): a request on an open connection waited **87 to 88 ms**; a request on a new connection waited
**930 to 931 ms of the 980 ms**. Three of three.

**On the site.** One 100-line checkout: a new connection waited up to 196 ms quiet and 475 ms loaded
(30 of 30 over 250 ms). Three at once: 504 ms quiet, 1,785 ms loaded (F-08 above). The heavy pricing lane
rests between pieces, which breaks the chain, so pricing is less exposed than checkout; I did not measure
it this way.

**Does it matter in production?** It depends on something I cannot see from here: whether Railway's edge
reaches the app over connections it keeps open (then visitors behave like the "open" rows and the
author's figures are the right ones) or opens a new one per visitor (then the "new" rows are what a
visitor gets). Either way it is fractions of a second to under two seconds, for the length of a burst,
and a checkout is limited to 12 per account per 15 minutes. It is not the seconds-long stop of F-08.

**Cost.** A slower first page for people arriving during a burst of checkouts. No money.

**What would close it.** A real pause (a timer of a millisecond or two, not `setImmediate`) between
pieces once a chain has run for, say, 50 ms; or serving the site behind something that keeps its
connections to the app open. First: measure it on Railway (section 8).

## 5b. The four earlier scripts that had only been read

| Script | Ran | Does it still test what it claims? |
|---|---|---|
| `rereview-availability/encryption.js` | exit 0 | Yes. With a key set: no stored file is unencrypted and the database holds no vertex lists or dense drawing loops; it still holds file names, overall measurements, DFM notes and quote lines in the clear, and says so. With the key removed: the start prints "EXISTING FILES CANNOT BE OPENED" and pricing a part whose detail is in a file answers 409 |
| `rereview-availability/memo-check.js` | exit 0, `problems: []` | Yes. Prices with the memo and by the plain path (through a reorder) are identical to the last digit, line by line |
| `rereview-availability/migration.js` | exit 0 (needs a local `master` branch, which I made in the scratch clone only, as the author did) | Yes for what it covers: a database written by `master` (`255753c`) comes up with no table, column or row lost. **Its fixture has no orders**, so it says nothing about the new start-up order check on the live database; the author's `scripts/dev/upgrade-proof.js` covers that and I have not re-run it |
| `review-uploads/retention-encryption.js` | `retention`: exit 0, 5 of 5 pass. `encryption`: exit 0 with **one line marked FINDING** | Yes, and the finding it prints is not from these fixes (the script and the code it reads are unchanged by them): the database file itself is not encrypted, and for a small drawing its outline coordinates and the customer's file name can be read in it. Anyone who gets a copy of the database or of a backup can read those. The owner should know that a database backup is customer data |

## 6. Changed-tests audit

Not finished. Read so far, each against `git diff dce1e38..28cb39d -- <file>`:

| File | Judgment |
|---|---|
| `server/models/partPayloads.test.js` | Follows a real change (F-09). The new assertions are stricter: the list must carry no lines and be under 4 kB; the single-order route must carry the lines without measurements |
| `server/routes/relaunchIntegration.test.js` | Follows a real change (checkout is a named step run by the pricing runner). Still asserts that every order insert sits after the pricing check and that the handler itself neither prices nor inserts. Counting final passes only is right: a warm-up pass judges nothing |
| `server/services/rowRetention.test.js` | Follows a real change (the 48-hour rule was F-12). New cases added for a card checkout with no page. Note: the code allows 30 minutes after a page lapses, the write-up says ten |
| `server/routes/priceIntegrity.test.js` | One line waits for the deferred re-pricing (F-13). Asks the same question |
| `server/models/taxShippingMigration.test.js` | The fixture's line now names a part that exists. Reasonable: a quote without its part could not be checked out before either |
| `tools/security/review-payments/poc-01-dxf-units-swap.js` | 20 pieces cut to 1. **Still proves what it was written to prove.** Ran: honest price $351.94 for one piece; priced as millimetres $113.45; units set back to inches; checkout made the order at $351.94 (the script sends no confirmed total, so the site charges today's price, and Stripe shows it); the paid order carries the full-size part at the full price. Its finding fires on "paid less than half the honest price for the full-size part", which one piece can still show. The reason given (20 pieces now go to a firm quote for freight) is real |
| `tools/security/review-payments/lib.js`, `poc-09-…` | Ceilings lifted for proofs that make many unpaid orders; order read from the single-order route. Follows real changes |
| `tools/security/review-uploads/preload-stubs.js` (Stripe stand-in) | Ids unique per process; `expire` added, refusing a page that is not open, as Stripe does. Not more forgiving than Stripe in what I read. With `REVIEW_STUB_PAY=1` an open page counts as paid when asked about, which is only set by scripts that need a paid order |
| `tools/geometry-bench/baseline/` (re-recorded price baseline) | **Verified field by field** with `r3-baseline-diff.js`: 197 snapshot files now, 196 compared with their version at `dce1e38`; **113 files differ, 404 priced cases differ, and every differing value is one of `shipping.amount`, `shipping.manual`, `shipping.reason`, `shipping.reasonCode`, `shippingEstimate`, `orderTotal`**, all at quantity 100. 0 values differ anywhere else (geometry, DFM, line prices). The author's "404 cases in 113 files, shipping fields only" is exact. One snapshot file is new and has no older version (`soup-wide-100k.json.gz`, 252 bytes); the write-up does not mention it |
| `tools/security/rereview-availability/vetting-compare.js` | Now prints every kind of difference, not the first three. Sees more, not less. Run by me (F-03 above) |
| `server/services/shipping.test.js` | Three cases removed that asserted "the formula never goes to a firm quote" and "has no destination rule". That WAS F-03. New cases assert the limits in every mode. Follows the change |
| `server/config/seedCarry.test.js` | Rewritten (21 cases). The three old cases asserted what F-10 and F-11 remove. My own `r3-catalogue-odd.js` checks the same behaviour from outside and agrees |
| `server/ops/shutdown.test.js` | A case ADDED: SIGKILL at 12 delays during back-to-back saves of a 12 MB database; it fails unless at least one kill left a temporary file behind, so it cannot pass without landing inside a save. This is the coverage the earlier audit said was missing |
| `server/testSupport/harness.js` | Lifts the four ceilings on unpaid orders unless a suite asks for them. True, and necessary for suites that make dozens of unpaid orders. **Only one suite runs with the real ceilings** (`server/routes/orderList.test.js`); its comment in the harness names a file that does not exist (`routes/orderCaps.test.js`). The live-server helper does NOT lift them, so every script that starts the real server meets the real ceilings unless it lifts them itself |
| `server/testSupport/liveServer.js` | Keeps a folder the caller handed in when a start is refused; skips an outbox file a kill cut short. Neither makes a check easier to pass |
| `scripts/dev/upgrade-proof.js` | Extended for F-10; fixture orders given a recent date. Not re-run by me |
| `tools/security/rereview-availability/reorder-block.js` | Now runs a 100-line order as well as the dense one. Asks more. Not re-run by me |
| `server/routes/unitsRefresh.test.js`, `unitsLock.test.js` | The author's own new tests; two cases reduced to one line per quote because 25 lines of that plate now go to a firm quote. Pass in the full suite |
| `scripts/e2e/hardening-accounts.mjs` | Reads lines from the single-order route. Follows F-09. Not re-run by me |

**No finding was edited away** in the files I read. Every change follows a real change of behaviour, and
three of them ask more than before.

## 7. What I did not cover, and what a sandbox cannot show

**Not covered, or covered thinly, and why.**
- **Reorder as a money path:** three checks only (another customer cannot reorder; a reorder prices the
  stored part at the same figure; an unconfirmed purchase-order order cannot be reordered), plus the
  five checks of the earlier payments proof. I wrote no dedicated attack; the reorder makes an ordinary
  draft quote, which then goes through the checkout that was attacked at length.
- **Loaded runs** of F-01, F-06, F-07 and the catalogue tests: quiet only. They are about order of
  events, which I varied directly, and not about speed.
- **A database near the 16 MB ceiling:** every timing was taken at 11.7 to 12.9 MB. I did not measure at
  15 MB, where the database clean-up also runs.
- **F-13's hold with the denser watcher**, and the author's `units-flip-worst.js`, `checkout-worst.js`,
  `order-list-worst.js`, `storage-pin-orders-full.js`: not re-run. His `paid-mail-kill.js` was replaced
  by a stricter script of mine.
- **The storage clean-up closing an honest order or a phone order:** one construction, one run, nothing
  closed. That the phone order is on the clean-up's list is from reading and is unproven either way.
- **The per-address ceilings on unpaid orders (5 and 16)** are exercised by my script only; no test in
  the suite runs them.
- **Browser runs other than the admin panel** (accounts, order lifecycle, tax and shipping, the journey
  walk, the content-security check) and `scripts/dev/upgrade-proof.js`: not re-run. They passed for the
  author; nothing in my runs contradicts them.
- **Promotion codes switched on, Stripe Tax switched on:** not attacked beyond the earlier reviewer's
  `money-attacks.js`, which I re-ran (66 held).
- **Text that reads like an instruction to a reviewer:** I saw none in the repository files, test
  output or logs I read.

**What no sandbox can show.**
- **Stripe.** That a payment page the site has expired can no longer be paid (F-06 and F-12 rely on it,
  and so does "an order is never paid for after its file has gone"); what Stripe sends when a card is
  charged at the same instant a page is expired; the real order and timing of its events.
- **Resend.** That a message repeated with the same Idempotency-Key is dropped. If it is not, a hard
  kill during a payment sends the confirmation twice more often than not (59 of 98 in my runs).
- **A real out-of-memory kill.** SIGKILL stands in for it. The server did read 1,000 MB after one
  sender's two large files, which on a 1 GB host is where the real thing happens.
- **Railway.** How long the flush of a 12 MB file takes on its network volume (every order and payment
  waits for one); whether its edge keeps connections to the app open (N-09); the volume's size (N-08).
- **Carriers.** What a parcel to Hawaii, a 62 in strip or a pallet really costs. The dollar figures in
  N-03 to N-05 are my assumptions and are stated as such.
- **Loaded figures** are four busy loops on two cores. They show the shape, not Railway's numbers.

## 8. What the owner must test by hand

Before the site is opened (test mode, a few minutes each):
1. **Stripe, expired page.** Choose pickup, reach the Stripe page, go back, choose ship, reach the new
   page. Open the first page again: Stripe must say it has expired. Then try to pay it.
2. **Stripe, the normal order.** One card order: the amount in the Stripe dashboard is the total the
   checkout page showed; you and the buyer each get one email.
3. **Resend, repeats.** In the Stripe dashboard resend the same "checkout.session.completed" event twice:
   the order stays paid and nobody gets a second email. Then ask Resend support, or read their page on
   Idempotency-Key, whether a repeated key is dropped for at least an hour.
4. **Refund and dispute.** Refund a test order in full from the dashboard: the order becomes "refunded"
   and leaves the work queue. Use Stripe's dispute test card: the order is flagged.
5. **The address rule.** Place a test order with city Honolulu, state "CA", ZIP 96813. Today it is
   accepted at about $12 shipping (N-03). Decide whether you will catch that at the label.
6. **A firm quote.** Send yourself a firm quote and accept it with an address in Hawaii. Today it is
   accepted at the quoted total (N-05).
7. **Go back and change the quantity three times** as a customer, reaching the card page each time. The
   fourth is refused for about two hours (N-01). Decide whether three is the right number
   (`ORDERS_UNPAID_PER_ACCOUNT`).
8. **Catalogue.** After the first deploy read Admin → Pricing: the notice lists what the upgrade kept and
   what it could not. Compare with what you had switched off.

Just after going live:
9. **The volume.** Admin → System: the database path is on the volume and its size is not a few hundred
   kB. In Railway: the volume is 5 GB or more and is not also where backups are written.
10. **Speed of a save on Railway.** Place a test order and look at how long the checkout answer takes;
    then, with a second browser that has never opened the site, load the home page while a 20-line test
    checkout is in flight. If the page takes over a second, tell whoever maintains the code (N-09).
11. **A restart.** Restart the service once: the test order is still there, and the start-up log has no
    "Order check" line that closes or flags an order you recognise as good.
12. **Memory.** Upload one 25 MB model yourself and watch Railway's memory graph. If it touches the
    limit, a hard kill is likely the first time a customer does the same.

## 9. Where the fix write-up is wrong or says more than was shown

- **F-08, "longest hold … 184 ms loaded (worst 184); no sample over 250 ms".** True for the watcher he
  used (one request at a time, every 20 ms). A visitor on a new connection waited 285 to 475 ms in 30 of
  30 loaded checkouts, and 1.4 to 1.8 s when three accounts checked out at once. His own worst figure,
  247 ms, was already at the line; mine for the same quantity is 252 ms.
- **F-05, "40 hard kills … 2 told twice" / "4 twice", "5 twice".** Measured with no mail provider, which
  closes the record at once and is not the production path. With the provider on, 59 of 98 kills inside
  the window sent the message a second time (same key). "Nobody untold" holds: 0 of 102.
- **F-12, "Never touched: … a phone order".** The clean-up's own query lists orders whose payment method
  is empty, which is how a phone order is stored. Read, not shown.
- **F-12, "until its payment page closes (plus the ten minutes the expiry sweep allows)".** The code
  allows 30 minutes (`AFTER_SESSION_MS`).
- **F-03, "an address outside the contiguous United States now goes to a firm quote".** By state and
  country, yes. By ZIP code under a mainland state, no (6 of 6 sold). And the firm quote it goes to takes
  any address (3 of 3).
- **F-10, "a material you deleted stays deleted".** Through the upgrade, yes. A table left completely
  empty is seeded again at the following start.
- **`memory-poison.js`, "server memory 463 MB at the highest reading".** I read 1,000 MB after the
  attacker's second file. Customers were not affected in either run.
- **Section 6, the harness.** It names `routes/orderCaps.test.js` as the suite that runs the real
  ceilings; that file does not exist (`orderList.test.js` does it, for the per-account ceilings only).
- **Section 6 does not mention** the new baseline file `soup-wide-100k.json.gz`.
- **Right, and worth saying:** every figure of his that I re-ran with his own or the earlier reviewer's
  scripts reproduced (99 of 99 suites, 22, 66, 25, 3, 6 held, 0 of 79, 74 %, 0 of 200, 58 of 58, the 64
  / 55 / 9 vetting rows, the 404 cases in 113 files). The differences above come from measuring something
  he did not, not from his numbers being off.
