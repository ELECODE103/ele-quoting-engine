# Independent review of the fixes for the review's conditions (2026-11-13)

**Verdict: yes, `1fff088` can go online and take payment, with three conditions** (section 1): keep the
volume from filling and be told if it does; if it fills, make room before any restart; do the hand
tests. Three of the four findings are closed. The full-disk one is partly closed (P-01, P-02).

Reviewer: independent (wrote none of the code under review). Code reviewed: `git diff 0af96f9..1fff088`
(64 files, about 3,700 added lines). Everything was run from a fresh clone of `1fff088` in a scratch
folder, Node 20.20.0 (`/opt/node20/bin/node`), two cores, local stand-ins for Stripe and mail only.
Nothing was pushed, merged or deployed, and no site code, existing test or existing script was edited.
My proof scripts are in `tools/security/review-conditions/` (`r5-*.js`).

How to read the figures: "ran" means a script printed it on this machine during this review. "Read, not
run" means I only read the code. Counts are "n of m".

## 1. Verdict

**Yes, `1fff088` can go online and take payment, with three conditions.** Three of the four findings
this work set out to close are closed (the ZIP code rule, the firm-quote address, the lock-out after
three changes), and so is the phone-order gap. The fourth, the full disk, is **partly** closed: the site
now shows that the disk is full and says so at start-up, but while the disk is full it still tells
Stripe "received" for refunds and disputes it has not kept, and it still keeps some orders in memory
that it has just told the buyer "did not go through". None of that can happen while the volume has room.

The conditions, as things you can do:

1. **Keep the volume from filling, and be told within minutes if it does.** In Railway make the volume
   5 GB or more and never write backups onto it. Point an outside uptime monitor at
   `https://<your site>/api/health` (it now answers 503 "unavailable" as soon as a save fails). Do not
   count on Railway for this: as far as I know it reads that page when a deployment starts and not
   afterwards (not checked from here).
2. **If the disk ever fills: make room first, do NOT restart or redeploy while the log still says
   `DATABASE NOT SAVED`.** Wait for `DATABASE SAVED AGAIN`. A restart while it is full throws away what
   the site was holding in memory, and Stripe will not send refunds or disputes again (finding P-01).
   Find out now, in Railway's own documentation or by trying it on a spare service, whether "make the
   volume larger" restarts the service; the runbook tells you to do that first and does not say.
   Afterwards compare the Stripe dashboard with Admin → Orders for **refunds and disputes** as well as
   payments, and look in Admin → Orders for a purchase-order order nobody emailed you about (P-02).
3. **Do the hand tests in section 7** before opening, as well as the twelve of the earlier review.

I recommend P-01 and P-02 are fixed in the next change (each has a small fix below). They do not stop
the launch, because both need a full disk, and with a 5 GB volume and the 2 GB ceiling on customer
files I found no way for a stranger to fill it.

**No price, shipping price or limit changed** (ran: 300 quotes on each side against `28cb39d`, 52
columns, 0 rows differ; every honest address accepted in my runs was charged exactly the quoted total).

## 2. Each claimed fix

| Claim | State | The author's figure | Mine |
|---|---|---|---|
| **N-03** destination by ZIP code as well as state | **Closed** | 6 of 6 refused; 4 of 4 spellings accepted | 612 of 612 checkouts to an off-mainland address refused (12 ZIP codes written 22 ways, 17 spellings of the state, 20 of the country; mainland ZIP code with an off-mainland state or country; foreign postcodes), by checkout, by checking the same quote out again with another address, and by reorder. 4 of 4 spellings accepted. 21 of 25 honest spellings sent by hand accepted (the four refused cannot be chosen from the pick list). `r5-address-paths.js`: 16 held, 0 findings |
| the state is a pick list | **Closed**, one flaw (P-04) | browser runs pass | Chromium at 390 px and 1360 px: 60 options, required, fits, Tab order right, the two-letter code typed picks the state. **Typing the state's name picks the wrong state for 2 of 9 names** (texas → Tennessee, new york → Nebraska); the ZIP code check then refuses it in words. `r5-state-picklist.js`: 15 held, 2 findings (the same one at both widths) |
| **N-05** a firm quote knows where it is going | **Closed** | 0 of 3 accepted to another address; 14 new cases; 34 held | 10 of 10 changed addresses made no order (street number, suite, city, ZIP code, state, Hawaii, Hawaii under "OH", Germany, Canada, a foreign address in the street line). 9 of 11 re-typings of the same address accepted. Card and purchase order at one moment with different addresses: 0 orders. 5 rounds of "another address": 5 emails to you, 25 further tries on closed links sent none. HTML in address fields is escaped in all three emails; control characters refused 6 of 6 |
| **N-01** a changed quote closes the order it replaces; the buyer can cancel | **Closed** for what the review found; the day's ceiling still bites (section 3, note A) | six changes, six checkouts; 14 new cases; 11 held | `r5-chain-cancel.js`: 26 held, 0 findings. Never closed: another customer's order, an unrelated quote's order, a phone, purchase-order, firm-quote, flagged or paid order (7 of 7). Paid-while-replacing: 4 orderings and a race, section 3 note B. Cancel refused for someone else's (403), signed out (401), cookie without the CSRF token (403), paid, in production, firm quote, phone order. Checkout number 9 in a day is refused |
| **F-12** the clean-up cannot close phone, purchase-order or firm-quote orders | **Closed** | 5 new cases; 4 of 4 runs | 12 of 12 orders with a payment method that is not exactly `card` (NULL, empty, `Card`, `CARD`, padded, `po`, `phone` and others) left alone through 3 file passes and 2 database passes and when asked directly; the `card` control beside them was closed. Flagged, paid and firm-quote card orders left alone. `r5-pressure-honest.js`: 12 held, 0 findings |
| **N-08** a failed save fails the request; health check; start-up message | **Partly closed** (P-01, P-02, P-03) | 8 new cases; 12 held on a real 3 MB disk | Holds: a new account, a sign-in, a checkout, a request, an acceptance and the owner's own change are each answered 503 `save-failed`; health 503, back to 200 by itself (10 of 10 rounds of full/room, never stuck, never wrongly "ok"); start-up says THE DISK IS FULL for ENOSPC and for EDQUOT, on the write and on opening the file (3 of 3), file untouched; a payment taken while full is not acknowledged and is settled when Stripe sends it again (3 of 3 runs). **Does not hold:** 3 of 3 other Stripe events (refund, dispute, lapsed page) answered 200 with nothing saved, and lost at a restart; a purchase-order acceptance answered "accepted" on the second press with nothing on the disk; 2 emails sent for a request that was refused. `r5-full-disk-attacks.js`: 11 held, 8 findings (restart), 11 held, 9 findings (no restart) |
| the earlier rule (an unreadable, empty or truncated database stops the start) is not weakened | **Holds** | tested both ways | the author's `diskFull.test.js` case passes in the suite; not attacked further |
| no price, shipping price or limit changed | **Holds** | 0 rows differ in 52 columns | 0 rows differ in 52 columns (300 quotes each side); `r3-baseline-diff.js`: 0 values differ outside the shipping fields |
| `1fff088` (099 military prefix) | **Holds** | 42,712 of 42,724 | not repeated, as instructed. Read: one row widened (090 to 098 became 090 to 099), one test moved `09999` from "not a ZIP code" to "military". Ran: ZIP code 09901 under state CA is refused at checkout like the other military codes (22 of 22 written forms) |
| checkout is not measurably slower | **Holds**, to within about 20 ms | "cannot rule out 10 to 20 ms" | 120 checkouts on `0af96f9` against 111 on `1fff088`, runs alternated: median answer 208.5 ms against 215 ms (+6.5 ms; the middle 95 % of resampled differences runs from 12 ms faster to 23 ms slower). The new replace path itself costs 41 to 44 ms more per checkout than a first checkout and holds the thread no longer (section 3, note C) |

## 3. New findings

Severity is mine. "Was there" means the behaviour existed at `0af96f9`; "new" means this change opened it.

### P-01 (Medium; was there, and this change says it is closed): while the disk is full, a refund or a dispute from Stripe is answered "received" and is not kept

**What happens.** The new guard that turns an unsaved change into "we could not save that" is put in
front of the site's ordinary routes. The route Stripe calls is mounted before it (`server/index.js`),
so it is not covered. A payment is safe: it is written as one all-or-nothing change, the failed save
raises an error, Stripe is answered 500 and sends it again. A refund, a dispute and a lapsed payment
page are written as single changes, and a single change whose save fails no longer raises anything.
The order is changed in memory, you are emailed, and Stripe is told 200 "received", so it never sends
the event again. If the service is then stopped before a save succeeds, the change is gone.

**Ran** (`r5-full-disk-attacks.js restart`, with "no space" and again with "quota exceeded"; the same
result both times). With the database file unwritable:

| Stripe sends | The site answers | On the disk | After a restart |
|---|---|---|---|
| payment completed (a page opened before the disk filled) | 500, then 503 for the repeat | not paid | Stripe sends it again: paid, one email to the buyer |
| charge refunded in full, $259.24 | **200 "refunded"** | still "paid" | **still "paid"; refunded amount $0** |
| dispute opened | **200 "dispute-opened"** | no flag | **no flag on the order** |
| payment page expired | **200 "order-expired"** | still waiting | still waiting (read, not run: the ten-minute sweep closes it later) |

3 of 3 such events were acknowledged without being saved, in each of 2 runs. You do get the two emails
("Order …: refunded in full", "Order …: payment disputed"); it is Admin that is wrong afterwards.
When room comes back WITHOUT a restart, the three changes do reach the disk (ran, `recover`), but the
three event records do not, so Admin's payment history for those orders has no line for them.

**What you would see.** An order you refunded still listed as paid; a disputed
order with no warning on it.

**Smallest fix.** In `server/routes/stripeWebhook.js`, read `database.saveFailures()` before
`handle(event)` and answer 500 if it has moved (three lines); or mount the guard before the webhook
route. Then Stripe sends the event again, as it does for payments.

### P-02 (Medium; was there, and the new message now says the opposite): an order made of several rows stays in memory after the buyer is told "it has not gone through"

**What happens.** An order and its lines, a firm-quote acceptance and a payment are each written as
one change: committed in memory first, then saved. When the save fails the request is answered 503
"We could not save that just now, so it has not gone through", but the change is not taken back out of
memory (only single new rows are). So for as long as the disk is full the site holds, and shows,
things it has said do not exist. What becomes of them depends on what happens next.

**Ran** (`r5-full-disk-attacks.js`, both modes):

- **A purchase-order acceptance.** First press: 503 `save-failed`, no email. The buyer does what the
  message says and presses again: **200 "accepted"** (the site answers from the order in memory). Your
  order list shows a "pending PO" order. On the disk: no order, request still "quoted".
  - If the service restarts before a save succeeds (ran): the order is gone. The buyer has been told
    "accepted" and you have nothing.
  - If room comes back first (ran): the order is written to the disk as a real purchase-order order,
    and **nobody was ever emailed**: not you (who must confirm the PO), not the buyer. 0 emails in the
    run.
- **An instant checkout.** 503 `save-failed`; the order is in "Your orders" as waiting for payment (1
  of 1). No payment page was opened at Stripe (0 pages in the run). After a restart: gone (correct).
  With room and no restart: the row stays, with no payment page; when the buyer checks out again it is
  the same order, not a second one (1 row). Harmless.
- **A payment.** While the disk is full the buyer's order page and "confirm payment" both say "paid"
  and the order is in your work queue; on the disk it is still waiting. This one heals: Stripe was
  answered 500 and its next delivery settles it, after a restart or without one (3 of 3 runs).

**What you would see.** After a full disk: possibly a purchase-order order in the queue with no email
behind it; or a buyer who says "your site said accepted" about an order you do not have.

**Smallest fix.** Either of two. (a) While the last save has failed, refuse every request that is not a
read before its route runs (one `if` at the top of `saveGuard`, and the same test at the top of the
webhook): then the second press is refused like the first, and no route works on memory that is ahead
of the disk. (b) When the save after a commit fails, load the database again from its file, which is
whole, so memory is what the disk holds. (a) is five lines and also closes P-03 for everything after
the first failure.

### P-03 (Low; the author reported one case of it): emails go out for things that were refused

**Ran.** A firm-quote request sent while the disk is full is answered 503, and **2 emails are sent**: to
you, "RFQ: 07ECB60F — 1 part(s)", and to the buyer, "we have your quote request". The request does not
exist. The author's write-up reports 1 stray email, for a new account; this is the same thing on a
route that also writes to you. No email went out for a refused purchase-order acceptance (0) or a
refused payment (0). Fix: as P-02 (a).

### P-04 (Low, new): typing the state's name into the pick list picks the wrong state

**Ran** (`r5-state-picklist.js`, Chromium, both widths). Each option reads "TX · Texas". A buyer who
tabs to the list and types "texas" lands on **TN · Tennessee**; "new york" lands on **NE · Nebraska**
(2 of 9 names tried; illinois, ohio, california, florida, michigan, washington and hawaii land right,
because their code is how the name starts). Typing the two-letter code is right 3 of 3. No money is at
risk: the ZIP code check refuses the pair and says "ZIP code 75201 is in Texas, and the state chosen is
Tennessee", and the buyer stays on the page with what they typed. It is a lost minute for a buyer in
one of the states where the code is not the start of the name. Fix: show the name first
("Texas (TX)"); the value sent stays the code.

Not shown: the browser's own autofill. I could not drive it headless. A form filler that writes
"Illinois" straight into the list leaves it on "Choose a state" (ran), and the form then cannot be sent
until a state is picked. See hand test 4.

### P-05 (Low; was there, N-07): the clean-up closes an honest buyer's unpaid order even when closing it frees nothing, and closes it again on every pass

The brief asked when this happens. **Ran** (`r5-pressure-honest.js`): the same clean-up on a store
built to order, 32 combinations. The buyer's order was closed in 4 of 32, exactly when all three of
these held (32 of 32 cells agree with the rule):

1. the file store was at 85 % or over, AND
2. the buyer's file was more than 60 minutes old (the buyer uploaded over an hour ago and is still
   unpaid; a payment page stays open for two hours), AND
3. the files filling the store were less than an hour old (a flood of new uploads from signed-in
   accounts: N-07). Ordinary old files do not do it: they are removed first and the order is kept
   (16 of 16 cells).

**Why the reviewer's script came out both ways (2 of 4 for the author, 0 of 1 in the earlier review).**
Ran: a pass that happens to run while the flood is between 80 % and 85 % finds nothing it may remove,
closes nothing, and the clean-up then stands down for 300 seconds; the script watches for 96. A pass
that first runs at 85 % or over closes the orders at once. The author's reading of the code was right.

**What the buyer sees** (ran): one email, "your unpaid order … was closed … Nothing was charged"; the
order reads "Not paid, closed"; the payment page was expired at Stripe first; pressing pay again works
at once (200). A payment that still arrived on the old page was flagged "late payment" for you, and an
order whose page had been paid a moment before the pass was settled, not closed (each 1 of 1).

**What is wrong with it.** In the 4 cells where the order was closed the store was no emptier
afterwards (86 % → 86 %, 97 % → 97 %): the flood's files are protected, so closing the honest order
buys nothing, and the order the buyer then makes by pressing pay again was closed by the next pass too
(ran, 1 of 1). **At launch volumes this needs a deliberate flood**; with a store that is not 85 % full
of hour-old files it does not happen. Fix: do not close orders in a pass where closing all of them
would still leave the store over the line.

### P-06 (Low, new): the owner's phone-order form now needs the state and the ZIP code together

**Ran.** `POST /api/orders` as the owner: IL with 60601, 201; IL with an Ohio ZIP code, refused (the
intended catch); **a state with no ZIP code yet, 400 "That ZIP code is not one we recognise"; a ZIP
code with no state, 400 "Choose the state from the list"**; nothing typed, 201; Honolulu, 201; a
Canadian address, 201. Before this change a phone order could be saved with half an address. If you
take an order by phone and have only the state, leave both empty or the message will puzzle you.

### Notes that are not findings

**A. The day's ceiling (the author kept it on purpose).** Ran: checkout number 9 without a payment in
24 hours is refused, so 7 changes after the first checkout go through. The buyer is told to pay for
the order that is waiting, come back tomorrow or phone. The last version accepted can still be paid
(ran). If the buyer has cancelled that one as well, nothing can be checked out by card until the
oldest of the eight is a day old; paying for any order frees a place at once (ran). Cancel-and-retry in
a loop stops at 8 (ran), accounts behind one address stop at 16 (ran), so neither replace nor cancel
is a way under the ceilings; one account opened 9 payment pages at Stripe before it was stopped.

**B. Paid at the moment the changed quote is checked out.** Ran, four orderings: (a) paid at Stripe,
webhook not yet in: the earlier order is settled, no second payment is started, the buyer is told
(409 `earlier-order-paid`); (b) paid and the webhook already handled: the changed quote is checked out
as a new order with no word about the first (as before this change; the buyer pressed pay twice on two
versions); (c) a payment reported on a page the site had closed: flagged "late payment", you are
emailed; (d) Stripe not answering: the earlier order and page are left as they were. The race, two
runs, 260 rounds in all: 188 ended (a), 49 ended "not paid, replaced", 23 ended (b); **0 of 260 ended
charged-and-closed without a flag, 0 with a closed order whose page was still open, 0 with both pages
open.**
All of this rests on Stripe refusing payment on a page that has been expired (hand test 2).

**C. What the replace path costs.** Ran `r5-replace-timing.js` three times, 12 samples each, 100
lines: a checkout that replaces an order answers 41, 43 and 44 ms later than a first checkout (median
about 151 ms against 108 ms) because the step runs twice with a call to Stripe between; the longest
hold of the thread is 2 to 4 ms longer (45 ms against 43 ms). The reviewer's timing script does not
take this path.

**D. A different part in the same quote.** Ran: a buyer who comes back from the card page, swaps the
part for another and checks out has the first order closed as "replaced"; going back to pay for the
first closes the second. They cannot hold both unpaid at once (paying one first works). No email is
sent for an order closed this way (0 in the run); it shows as "Not paid, closed".

**E. "The same address" on a firm quote.** Ran: 9 of 11 re-typings are taken as the same (capitals,
full stop, comma, extra spaces, ZIP+4, state by name, "USA", another name on the box). Two go back to
you for nothing: nine digits with no hyphen, and "Street" for "St". Too strict costs a round trip, not
money; and the page does not ask for the address again unless the buyer presses "Ship to a different
address".

## 4. Changed-tests audit

I read the diff of every existing test and script the change touched. **No check was weakened, removed
or made to pass by changing what it expects.** Every edit either supplies an input the site now
requires or follows the wording of a real change.

| File | What changed | Judgment |
|---|---|---|
| `server/routes/taxShipping.test.js` | "Illinois" given an Illinois ZIP code; "an address Stripe cannot place" uses 43299 for 00000; the firm-quote helper sends the address; "address still required" runs on a request with none | Supplies new input. 00000 is refused before Stripe now, so the old input could no longer reach the code under test |
| `server/routes/rfqQuote.test.js` | requests send the address; "accept needs a ship-to address" moved to a request without one | Same assertion (400 `address-required`), on the only kind of request where it can still arise |
| `server/routes/orderLifecycle.test.js` | requests send the address; the "punctuation is text" case sends its punctuated street on the request and changes only the name at acceptance | Follows N-05. The street with punctuation is still stored and checked as typed |
| `server/models/orderLifecycleMigration.test.js` | the old-version quote with no address is accepted in two steps | Stricter: it now asserts the 409, the stored address, the closed link and the re-send |
| `server/ops/ownerNotifications.test.js`, `server/ops/system.test.js`, `server/routes/authorization.test.js` | requests send the address; the new cancel route added to the inventory | Supplies input; the inventory is longer |
| `server/models/databaseDurability.test.js` | the pattern that reads `saveToDisk` | Tighter, not looser: it now also requires the failure path to mark the change as waiting |
| `server/routes/relaunchIntegration.test.js` | finds `orderStep(req, quoteId` by its first two arguments | Same assertion |
| `server/routes/orderAtomic.test.js`, `server/routes/shippingLimits.test.js` | cases added only (0 lines removed) | Asks more |
| `server/services/usAddress.test.js` (in `1fff088`) | `09999` moved from "not a ZIP code" to military; `09901` added | Follows the table. The direction is the safe one (firm quote) |
| `server/testSupport/harness.js` | a comment | No effect |
| `scripts/e2e/*.mjs` (4), `tools/security/csp-browser-check.js` | the state is chosen from the list; request forms fill the address; the firm-quote page is driven as it now is; step E2 added | Follows the pages. One check replaced four `fill` lines: "the address the price is for is shown, not asked for again" |
| `tools/security/review-payments/poc-07`, `-09`, `-11`, `-12` | their requests send the address | Supplies input; 0 of 79 show a weakness |

**The two intermediate commits that left a suite failing:** the head does not. Ran `npm test` on
`1fff088`: 104 of 104 suites, 1,267 "ok" lines, 0 failures.

**The three reviewer's scripts that now fail, unedited** (ran each):

- `r3-shipping-firm-f06.js`, exit 2. Three "FINDING" lines. (1) "ordinary mainland addresses are
  accepted": the one refused is state " il " with ZIP code 43215, which is Columbus, Ohio. **Intended**:
  that is the mismatch N-03 exists to refuse. (2) the 62 in strip on the diagonal: N-04, **was there**,
  not in this work. (3) card and purchase order at one moment, "card 409, PO 409, orders 0", then a
  crash on the next line: the script's request carries no address, so the acceptance goes back to the
  owner. **Intended.** The same check on a request with an address makes one order (ran,
  `r4-shipping-firm.js`, 34 held).
- `r3-caps-and-lists.js`, exit 1. (1) "going back to pay for an order that already exists": it expects
  the OLDEST order back, and that order was closed when its quote was changed, so a new order is made
  for that version (200). **Intended.** (2) two buyers behind one address: N-02, **was there**.
- `r3-pressure-collateral.js`: see P-05 and appendix A. **Was there** (N-07), and the phone
  order is no longer closed.
- `r3-catalogue-odd.js`, exit 1: "every finish deleted" is seeded again. **Was there**, reported by the
  earlier review, not in this work.

**`r4-f06-race.js` really is section E of the reviewer's script.** Ran `diff` on the two files from
the "E." marker to the end: one line differs, the comment on the marker itself.

## 5. Where the write-up is wrong or says more than was shown

- **"Nothing is acknowledged to a customer that is not on the disk"** (the guard's own comment; the
  runbook says "nothing is acknowledged that was not saved"). Ran: a second press of Accept is answered
  200 "accepted" with no order on the disk; "confirm payment" answers 200 "paid" for an order that is
  not paid on the disk; three kinds of Stripe event are answered 200 (P-01, P-02).
- **"Every route is covered at once."** The Stripe webhook is mounted before the guard and is not
  covered (read, and ran). Requests that are GET are not looked at; of 40 GET requests tried with the
  disk full, 1 tried to write (the database backup download) and it answered 500, which is honest.
- **"A new row whose write failed is also taken back out of memory, so what was refused does not turn
  up later as if it had been accepted."** True for a single row (an account). Not for an order or an
  acceptance, which are several rows in one change: those stay, and do turn up (P-02).
- **The customer message "it has not gone through."** For an instant checkout and a purchase-order
  acceptance it has gone through in memory, and will be on the disk when room returns.
- **Runbook, "The volume is full", step 5** tells you to check payments. Refunds, disputes and
  purchase-order acceptances are the ones that need checking; payments heal by themselves. Step 2 says
  to make the volume larger and does not say whether that restarts the service, which matters (P-01).
- **Section 6, point 8: "one stray confirmation email."** Also 2 for a refused request, one of them to
  you (P-03).
- **"What counts as the same address … ZIP code (first five digits)".** With a hyphen or a space, yes.
  Nine digits run together count as a different address (ran).
- **"A buyer can go back and change an order seven times in a day and is refused on the ninth unpaid
  checkout."** Right (ran). Worth adding: a buyer who has also cancelled the last one has nothing to
  pay for and is shut out of card checkout until the next day.
- **"From reading `relieveStorage` … I did not test that reading."** Tested here: right (P-05).
- **Right, and worth saying:** every figure of the author's that I re-ran reproduced or came out within
  run-to-run noise (appendix A). The differences above come from attacking what he did not, not from
  his numbers being off.

## 6. What I did not cover, and why

- **A real small disk for my own attack script.** `r5-full-disk-attacks.js` uses the author's stand-in
  (the write of the database's temporary file fails while a flag file exists). The author's and the
  reviewer's scripts were run on a real 3 MB memory disk (appendix A) and show the same error reaching
  the same code. EDQUOT was simulated the same way; no quota-limited volume was available.
- **Whether enlarging a Railway volume restarts the service**, and what Railway does when the health
  check fails on a running service. Not visible from here. Condition 2 depends on it.
- **Stripe itself.** That an expired page cannot be paid; what Stripe sends when a card is charged at
  the instant a page is expired. Every "replace" and "cancel" result rests on the stand-in refusing
  payment on an expired page, as Stripe documents.
- **The browser's own autofill** into the state list (P-04), and any browser but Chromium.
- **"With the two rules put back, 4 of the 5 cases fail".** I did not put two rules back one at a time. I
  ran the new test files against the whole of the old code instead (appendix A): 4 of 5 fail there too.
- **Promotion codes on, Stripe Tax on** with the new paths: not attacked beyond the suites.
- **The admin screens** for the new address box were exercised by the author's browser run (appendix A)
  and read as text by me; I did not drive them by hand.
- **The firm-quote PDF**: it does not carry the ship-to address (the author says so), so there was
  nothing to inject into. The emails and the admin queue were tested.
- **The container restarted once** while the last runs were going. Everything already measured was on
  the disk and is in appendix A. One run was lost and repeated: the paid-while-replacing race, planned
  at 300 rounds, was run again at 200 (260 with the first 60).
- **Text that reads like an instruction to a reviewer:** I saw none in the files, logs or tool output I
  read.

## 7. Hand tests to add to the earlier review's twelve

Only new ones. Tests 5, 6 and 7 of the earlier list now have the results the author's write-up gives.

1. **The health monitor.** Point your uptime monitor at `/api/health` and confirm it alerts you on a
   503 (most have a "test alert" button).
2. **Stripe, a replaced page.** In test mode reach the Stripe page, go back, change a quantity, reach
   the new page. Open the first page again: Stripe must say it has expired. "Your orders" shows the
   first as "Not paid, closed" and the second as waiting.
3. **Cancel.** Reach the Stripe page, go to "Your orders", press Cancel. Open the Stripe page again: it
   must say expired. Check out the same quote again: it works.
4. **The state list on your own phone.** Let the phone fill your saved address into the checkout page.
   The state must end up on your state. Then tab to the list on a computer and type "texas": today it
   lands on Tennessee (P-04).
5. **A firm quote to another address.** Send yourself a firm quote for your shop address, open the
   link, press "Ship to a different address", give another one. You must get the "address changed,
   re-confirm the price" email, see the warning box in Admin → RFQs with both addresses, and the old
   link must say it is being confirmed. Press Send: the new link accepts.
6. **A phone order.** Enter one in Admin with the state and ZIP code, and one with neither (P-06).
7. **Railway.** Read or ask: does making a volume larger restart the service? Write the answer into
   the runbook's "The volume is full" section.

## Appendix A. Regression: the author's figures and mine

Fresh clone of `1fff088` in an empty scratch folder, Node 20.20.0. `npm ci`: exit 0, 0 vulnerabilities.
Each script was run once unless a count is given. The container restarted once during this review;
every figure below was on the disk before it and was read back from the script's own output.

**Suite, build, comparisons**

| What | Author (on `f840893`) | Mine (on `1fff088`) |
|---|---|---|
| `npm test` | 104 of 104 suites, 1,267 "ok", 10 min 26 s | 104 of 104 suites, 1,267 "ok" lines, 0 failures, about 11 min 40 s with other scripts running beside it |
| Production build | exit 0, 22 of 22 pages | exit 0, 22 of 22 routes prerendered |
| Claims check | exit 0; 257 files, 21.4 MB, 1 PDF | exit 0; 257 files, 21.4 MB, 1 PDF; the street address is in none |
| `npm audit --omit=dev` | server 0, client 0 | server 0, client 0 |
| 300-quote vetting comparison against `28cb39d` | 0 rows differ in 52 columns | 300 quotes each side, both "0 fails, 63 warnings", 52 columns, **0 rows differ** |
| Payments proofs (`review-payments/run-all.sh`) | 0 of 79 | 0 of 79 show a weakness (1 + 4 + 4 + 6 + 8 + 15 + 15 + 5 + 5 + 5 + 2 + 9) |
| The new test files run against the OLD code (`0af96f9`) | "each fails on the old code"; "4 of the 5 cases fail" for the clean-up | `ownerOrdersPressure` 4 of 5 fail; `orderCaps` 10 of 14; `firmQuoteShipTo` 12 of 14; `diskFull` 5 of 8; the 5 new cases of `shippingLimits` 5 of 5; the new case of `orderAtomic` 1 of 1. The new tests do test the new behaviour |

**`tools/security/rereview-relaunch/`** (none edited)

| Script | Author | Mine |
|---|---|---|
| `units-race.js` | 2 held, 0 findings | 2 held, 0 findings |
| `order-list-hold.js` | six 200s, 5 to 16 ms, health worst 3 ms | six 200s, 4 to 5 ms, health worst 3 ms |
| `checkout-hold.js 100 0,6,12` | 106 / 170 / 172 ms; health worst 75 / 90 / 93 ms; 0 over 250 ms | 119 / 170 / 267 ms; health worst 56 / 69 / 94 ms; 0 samples over 250 ms |
| `units-flip-hold.js` | six flips 200, health worst 60 ms | six flips 200, health worst 92 ms |
| `catalogue-upgrade.js` | 22 held, 0 findings, 2 info | 22 held, 0 findings, 2 info |
| `money-attacks.js` | 66 held, 0 findings, 12 info | 66 held, 0 findings, 12 info |
| `access-matrix.js` | 25 held, 0 findings, 2 info | 25 held, 0 findings, 2 info |
| `route-inventory.js` | 0 owner routes unchecked | 0 owner routes without the sign-in and owner checks |
| `master-upgrade-access.js` | 3 held, 0 findings, 1 info | 3 held, 0 findings, 1 info |
| `public-surface.js` | 6 held, 0 findings | 6 held, 0 findings |
| `shipping-exposure.js` | exit 0; table the same as on `6336917` | exit 0; its table compared with the one `0af96f9` prints: 0 lines differ |
| `storage-pin-orders.js pin` | 97 % → 74 %, both accepted | 97 % after the flood, 74 % after the clean-up; a visitor and a customer both accepted |
| `memory-poison.js` | exit 0; 990 MB after one hostile file; 16 of 16 honest files, 0.1 to 1.5 s; 0 refused | exit 0; 927 MB after the first hostile 25 MB file (refused at the memory line), one refused as not measurable, the third refused at the memory line (901 MB); 355 MB thirty seconds later; 16 of 16 honest files read in 0.1 to 1.4 s; 0 customers refused |
| `durability-kill.js 50` (ceilings lifted by environment variable) | 11 held; C: 29 none, 21 whole, 0 partial; D: 50 of 50 | 11 held, 0 findings, 3 info. C: 25 no order, 25 a whole order, **0 partial**. D: 50 of 50 paid after the event was sent again, 0 untold. As for the author, none of D's kills landed between "paid on disk" and "emails sent" |

**The earlier reviewer's `r3-*.js`** (none edited)

| Script | Author | Mine |
|---|---|---|
| `r3-shipping-firm-f06.js` | N-03 and N-05 held; three findings, stops in section D (exit 2) | the same: 21 lines held, 3 "FINDING" lines, then a TypeError (exit 2). Each judged in section 4 |
| `r3-caps-and-lists.js` | 10 held, 2 findings, 7 info | 10 held, 2 findings, 7 info (exit 1). Judged in section 4 |
| `r3-full-disk.js` on a real 3 MB memory disk | 503 / 503 / 503; start refused with THE DISK IS FULL; starts with room | new account 503 `save-failed`, sign-in 503, health 503; restart refused, exit 1, "FATAL: THE DISK IS FULL, so the site has NOT started…"; with room it starts. "HOLDS: the database file stayed whole" |
| `r3-pressure-collateral.js` | phone order kept 4 of 4; honest orders closed in 2 of 4 | 2 runs. Phone order kept **2 of 2**. Run 1 (store 97 %): nothing closed. Run 2 (store 100 %): both honest orders closed, each buyer emailed once, the one the script follows checked out again (200). Explained in P-05 |
| `r3-event-orderings.js` | 29 held, 0 findings, 3 info | 29 held, 0 findings, 3 info |
| `r3-units-paths.js` | 9 held, 0 findings | 9 held, 0 findings |
| `r3-catalogue-odd.js` | 25 held, 1 finding, 2 info | 25 held, 1 finding, 2 info (exit 1; the finding was there, section 4) |
| `r3-baseline-diff.js` | 0 values differ outside the shipping fields | 0 values differ outside the shipping block |
| `r3-paid-mail-window.js` | 200 kills (195 in the window), nobody untold; 122 told twice, same key | 200 kills (187 inside the window): every order paid, nobody left untold; told twice 114, all with the same key, 0 with different keys |
| `r3-loop-experiment.js` | new connection 921 ms, open 84 ms | new connection 922 ms, open connection 85 ms |
| `r3-checkout-dist.js` | N-09 stands; medians 183 to 216 ms over six runs | see the timing table below |
| `r3-swap-under-checkout.js 20 0` | N-06 stands; 9 to 20 of 20 at or over 250 ms | `0af96f9`: 7 of 20 (worst 346 ms), 15 of 20 (worst 445 ms). `1fff088`: 11 of 20 (worst 534 ms), 7 of 20 (worst 421 ms). The runs overlap; N-06 stands as it was |

**The author's `r4-*.js`**

| Script | Author | Mine |
|---|---|---|
| `r4-shipping-firm.js` | 34 held, 0 findings | 34 held, 0 findings |
| `r4-caps-and-cancel.js` | 11 held, 0 findings, 1 info | 11 held, 0 findings, 1 info |
| `r4-full-disk.js` on the real 3 MB disk | 12 held, 0 findings; 1 stray email | 12 held, 0 findings; 1 email written for the account that was not saved; health back to "ok" 1,019 ms after room was made (retry every 1 s in that script) |
| `r4-f06-race.js 200` | 0 of 200 flagged, 0 wrong amount; 195 paid, 5 unpaid | 0 of 200 flagged, 0 of 200 with an amount that differs from the charge; 199 paid as pickup, 1 unpaid (nothing charged) |

**Browser runs** (the preinstalled Chromium, against the production build)

| Script | Author | Mine |
|---|---|---|
| `scripts/e2e/hardening-accounts.mjs` | 121 of 121 | 121 of 121 |
| `scripts/e2e/order-lifecycle.mjs` | 72 of 72 | 72 of 72 |
| `scripts/e2e/tax-shipping.mjs` | 57 of 57 | 57 of 57 |
| `scripts/e2e/journey-qa.mjs` at 390 and 1360 px with the accessibility checker (axe-core 4.10.2, fetched into scratch) | 204 screens, 0 / 0 / 0 | 204 screens recorded, 0 scroll sideways, 0 with a serious or critical accessibility fault, 0 problems noted |

**Is checkout slower? `r3-checkout-dist.js`, `0af96f9` against `1fff088`, runs alternated on a quiet
machine** (30 checkouts of 100 lines a run, database 11.8 to 12.6 MB)

| Run | Commit | Median answer | Median wait, new connection | Worst wait | At or over 250 ms |
|---|---|---|---|---|---|
| 1 | `0af96f9` | 267 ms | 254 ms | 355 ms | 17 of 30 |
| 1 | `1fff088` | 278 ms | 262 ms | 407 ms | 17 of 30 |
| 2 | `0af96f9` | 205 ms | 192 ms | 288 ms | 5 of 30 |
| 2 | `1fff088` | 236 ms | 232.5 ms | 3,534 ms | 11 of 30 |
| 3 | `0af96f9` | 203 ms | 197.5 ms | 269 ms | 1 of 30 |
| 3 | `1fff088` | 209.5 ms | 199 ms | 277 ms | 5 of 30 |
| 4 | `0af96f9` | 182 ms | 182.5 ms | 275 ms | 3 of 30 |
| 4 | `1fff088` | 173 ms | 171.5 ms | 267 ms | 2 of 30 |

Run 2 on `1fff088` has nine samples (three batches in a row) in which the machine itself stalled: the
script's own reading with NO checkout in flight was 59 to 337 ms in those batches, where it is 2 to 16
ms everywhere else. Something else on this shared machine was running. I left those nine out, by a
rule applied to both sides (a batch whose quiet reading was over 50 ms, and the batch after it): 120
samples remain for `0af96f9` and 111 for `1fff088`.

| | `0af96f9` (120) | `1fff088` (111) | Difference |
|---|---|---|---|
| Checkout answered, median | 208.5 ms | 215 ms | +6.5 ms (middle 95 % of 5,000 resamples: -12 to +23 ms) |
| New connection's wait, median | 201 ms | 206 ms | +5 ms (-14 to +18.5 ms) |
| Open connection's wait, median | 66 ms | 70 ms | +4 ms (-3 to +10 ms) |
| New connection at or over 250 ms | 26 of 120 | 26 of 111 | |
| Open connection at or over 250 ms | 0 of 120 | 0 of 111 | |

**What I take from it.** The machine drifted more between run 1 and run 4 (267 to 182 ms on the same
commit) than the two commits differ in any one run. With four times the author's samples the answer is
the same as his: no difference shown, a slowdown of up to about 20 ms in the median not ruled out, one
of more than about 25 ms ruled out. N-09 stands as the earlier review wrote it: on both commits about
a fifth of new connections waited 250 ms or more during a 100-line checkout.

**My proof scripts** (`tools/security/review-conditions/`, each as committed; a "finding" line is the
script's own word for a check that did not hold)

| Script | What it attacks | Result |
|---|---|---|
| `r5-full-disk-attacks.js restart` | money while the database file cannot be written, then a restart | 11 held, 8 findings, 8 info (the same with `R5_ERRNO=EDQUOT`) |
| `r5-full-disk-attacks.js recover` | the same, then room without a restart | 11 held, 9 findings, 11 info |
| `r5-full-disk-reads.js` | GET requests that write; the health check through ten rounds of full and room | 6 held, 0 findings |
| `r5-edquot-start.js` (with `r5-edquot-preload.js`) | a start on ENOSPC, on EDQUOT, and when the temporary file cannot be opened | 9 held, 0 findings |
| `r5-address-paths.js` | N-03 and N-05 on every path that takes an address | 16 held, 0 findings, 8 info |
| `r5-state-picklist.js` | the pick list in Chromium at 390 and 1360 px | 15 held, 2 findings, 2 info |
| `r5-chain-cancel.js 60`, then `200` | replace, payment in flight, the ceilings, cancel | 26 held, 0 findings, 11 info, both runs |
| `r5-pressure-honest.js` | when the clean-up closes an honest order; what it never closes | 12 held, 0 findings, 4 info |
| `r5-replace-timing.js 100 12`, three times | what the replace path costs | +41, +43, +44 ms in the answer; +2 to +4 ms in the longest hold |
