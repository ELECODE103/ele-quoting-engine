# Fixes for the conditions of the independent review (2026-11-13)

Branch `relaunch-2026-11-12`. This answers `docs/security/rereview-fixes-review-2026-11-13.md`: its
findings N-01, N-03, N-05 and N-08, the phone-order part of its section on F-12, and the corrections
its section 9 asked for. Nothing here has been pushed, merged or deployed. The site stays offline
until you approve.

## Where this work stands (true as of the commit this file is in)

| Item | State | Commit |
|---|---|---|
| 1. Destination decided by ZIP code as well as state (N-03) | fixed, verified | `851fde1` |
| 2. A firm quote knows where it is going (N-05) | fixed, verified | `6336917` |
| 3. A buyer is not locked out by their own changes (N-01); phone orders safe from the clean-up (F-12) | fixed, verified | `62a37ff` (one suite's route list completed in `6336917`; its look-up made lighter in `f840893`) |
| 4. A full disk is visible and says what it is (N-08) | fixed, verified, shown on a real 3 MB disk | `e5efc4e` (one setting listed in `.env.example` in `6336917`) |
| 5. Small corrections the review asked for | done | `851fde1`, `62a37ff` |
| Proof scripts and a browser step added after the fixes (no site code) | done | `9e9db24`, `41cbabe` |
| Final verification from a fresh clone, Node 20.20.0 | done on `f840893`, the last commit that changes code; every figure is in section 3 | this commit (this file only) |

A figure that is not in this file has not been measured. "Ran" means a script printed it on this
machine (2 cores, Node 20.20.0 from `/opt/node20/bin`, local stand-ins for Stripe and mail only).

## 1. Bottom line

The four findings the review said cost money, turn a buyer away or can take the site down are
closed in code, and each has a test in the suite that fails on the old code:

- **Hawaii under "CA" (N-03).** The six addresses the review bought at about $12 shipping are all
  refused now (6 of 6; they were sold 6 of 6). A state that does not match the ZIP code is refused
  with a sentence that says which state the ZIP code is in. "D.C.", "Washington DC", "Ill." and
  "N.Y." are accepted (4 of 4; they were refused 4 of 4). The state is a pick list on the checkout
  page.
- **Firm quotes (N-05).** The request form asks where the parts ship. You see the address beside
  the price box and in the email. A $480 quote priced for Columbus, Ohio is no longer accepted to
  Honolulu, Hamburg or Anchorage at $480 (0 of 3; it was 3 of 3): it comes back to you as "address
  changed, re-confirm the price".
- **Locked out after three changes (N-01).** A buyer who goes back and changes the quantity is not
  refused (six changes in a row, six checkouts; the fourth used to be refused for about two hours),
  and "Your orders" has a Cancel button for an unpaid order. The owner's phone orders, purchase-order
  orders and firm-quote orders cannot be closed by the storage clean-up. A phone order could be: the
  review had read that and not seen it happen. Its own script closes the phone order on the review's
  commit in 2 of 2 runs here, and in 0 of 4 on this work.
- **Full disk (N-08).** With the disk full the site answers "We could not save that just now" where
  it answered "created", the health check answers "unavailable" where it answered "ok", and a
  restart says "THE DISK IS FULL … Free space on the volume … or make the volume larger" where it
  said "Restore the volume from its backup". When there is room again it recovers by itself.

**No part price, no shipping price and no limit was changed.** The 300-quote comparison against
`28cb39d`, run on `f840893`: 300 quotes on each side, 52 columns compared, 0 rows differ.

Three things you should know before reading on (details in sections 6 and 8):

1. The ZIP code table was written from the Postal Service's published three-digit prefix list from
   memory; the sandbox could not reach a live copy to check it against. It is tested with one or
   more known ZIP codes for every state, DC, the territories and the military codes, and every row
   of the table is exercised, but a wrong row would turn away honest buyers in that area ("the state
   and the ZIP code don't match"). **Before launch, try your own ZIP code and three or four of your
   customers' on the checkout page.**
   *Added after this write-up by the session lead (the commit after `230c0bb`):* the table was then
   compared with a public list of 42,724 ZIP codes (`tools/security/review-conditions/zip-table-check.js`).
   It agreed on 42,701. The one row that mattered, military codes starting 099 (11 codes), read as
   "not a ZIP code" and is corrected; after that 42,712 agree and none of the 12 left would turn away
   or mis-price a mainland buyer. The list has one state per ZIP code, so point 2 below still stands.
2. A few dozen rural ZIP codes cross a state line. Four are handled; a buyer at one of the others is
   told the state and ZIP code do not match and to call. That is an order by phone, not a lost one.
3. A firm-quote request that reaches the site WITHOUT an address (only possible by sending the form
   by hand; the page requires it) is still taken, so that no lead is lost. You are told there is no
   address; if you price it anyway the buyer is asked at acceptance and the quote comes back to you
   once.

## 2. What was wrong and what changed, fix by fix

### 1. Destination decided by ZIP code as well as state (N-03)

**What was wrong.** "Outside the contiguous United States" was decided from the country and the
state box, and the state box was free text. Honolulu 96813 typed under "CA" was sold at the mainland
parcel price (6 of 6 such addresses in the review's script). The other way round, a mainland buyer
who typed "D.C." or "Ill." was sent to a firm quote.

**What changed.**

- A new table, `server/services/usAddress.js`, says which state every US ZIP code belongs to (by
  its first three digits) and reads a state the ways people write it. The list of states is one
  file, `shared/us-states.json`, used by the server and by the pick list.
- One function, `shipTo()` in `server/services/checkout.js`, checks every address the site takes:
  instant checkout, a firm-quote request, a firm-quote acceptance and your own phone orders.
  - A ZIP code in Alaska, Hawaii, Puerto Rico, the Virgin Islands, Guam, American Samoa, the Northern
    Marianas or a military post office (APO/FPO/DPO) is "outside the contiguous United States"
    **whatever the state box says**. At instant checkout that means no parcel price online: the
    buyer is sent to a firm quote, exactly as an address with state "HI" already was.
  - A mainland ZIP code with a different mainland state is refused, in words.
  - A ZIP code that is not five digits (or five and four), or whose prefix is not in use, is refused.
  - The state is stored as its two-letter code however it was typed.
- The state on the checkout page is a pick list ("IL · Illinois"). Alaska, Hawaii, the territories
  and the military "states" are on the list on purpose: a buyer there picks the truth and is told
  how freight is priced. For Canada and Mexico the box stays free text and is labelled "State or
  province" (the country list itself is unchanged; that decision is yours and is listed as open).

**What cannot be prevented.** A foreign address typed into the street and city lines with the country
left as "United States" passes if the buyer also picks a state and types a ZIP code that belongs to
that state. The ZIP code and state check is the line. (The review's own example, "Hamburg, Germany"
with state DE and postcode 20095, is refused, because 20095 is a Washington DC ZIP code; a buyer who
invented a matching Delaware ZIP code would not be.) You would see it on the order before making a
label.

**What a customer now reads.**

- State and ZIP code disagree: "The state and the ZIP code don't match: ZIP code 43215 is in Ohio,
  and the state chosen is Illinois. Check the address and try again."
- Not a ZIP code: "That ZIP code is not one we recognise. A ZIP code is five digits (or five and
  four). Check it and try again. Nothing was charged or sent."
- No state chosen (only possible by sending the form by hand): "Choose the state from the list,
  then try again. Nothing was charged or sent."
- A Hawaii ZIP code under any state: unchanged wording, "Our parcel rates cover the contiguous
  United States. For this address we confirm freight before you order. Request a firm quote and we
  will price the freight."

**What I ran** (figures from the final run are in section 3).

- `server/services/usAddress.test.js`, new, 8 cases: a known ZIP code for every state, DC, AK, HI, PR,
  VI, GU, AS, MP and the three military codes (132 ZIP codes); every row of the table hit; 16 things
  that are not ZIP codes; 47 ways of writing a state and 13 things that are not one.
- `server/routes/shippingLimits.test.js`, 5 new cases through the real checkout route.
- My `tools/security/rereview-fixes/r4-shipping-firm.js`, section A.
- The reviewer's `r3-shipping-firm-f06.js`, section A.

### 2. A firm quote knows where it is going (N-05)

**What was wrong.** The firm-quote request carried no ship-to address. You priced blind, and the
buyer typed the address when accepting, where nothing checked it: a $480 quote was accepted to
Honolulu, to Hamburg and to Anchorage at $480 (3 of 3). The firm-quote page had no country box, so
an overseas buyer was recorded as "US".

**What changed.**

- **The request form** (`/rfq`, all three ways into it) asks "Where the finished parts go": name,
  street, city, state (the pick list), ZIP code, country. It is required. When you have switched
  pickup on, the form offers "I will pick them up at your shop" instead. The server checks the
  address the same way checkout does (the state against the ZIP code, one printable line per field)
  and stores it with the request. An address in Hawaii or abroad is NOT refused here: a firm quote
  is where such an order belongs, and you price that freight.
- **You see it** beside the price box in Admin → RFQs ("Ships to: …", marked "Outside the contiguous
  United States" when it is), and in the notification email ("Ship finished parts to: …").
- **The quote email** to the buyer says "Priced for delivery to: …".
- **At acceptance the order ships to that address.** The firm-quote page shows it ("This is the
  address the price is for") and asks only for the name on the box.
- **A different address at acceptance is not accepted at the quoted total.** The buyer can press
  "Ship to a different address" and is told, before pressing the button, what will happen. The server
  then makes no order and charges nothing; it stores the new address on the request together with
  the one the price was for, closes the link the buyer holds (the address is now one of the terms a
  link is good for, like the total and the lead time), and emails you. In Admin → RFQs the request
  shows a warning box with both addresses. You check the total, change it if freight differs, and
  press Send: the buyer gets a new link, good for the new address at the total you confirmed.
- **Collecting at the shop** is accepted at the quoted total whatever the quote was priced for (no
  freight to a new place). A quote priced for pickup that the buyer then wants shipped comes back to
  you like any other address change.
- **A request with no address** (none exist in production; one could arrive from a hand-built
  request) opens as before. The buyer is asked for the address when accepting, and the quote comes
  back to you once, with "the price was sent before any address was known".
- What counts as "the same address": street, city, state, ZIP code (first five digits) and country,
  ignoring capitals, full stops and extra spaces. The name on the box may be changed freely.

**What the buyer reads** when the address is different: "This quote was priced for delivery to a
different address, so nothing was accepted and nothing was charged. We have the new address and are
confirming the price for it. We will email you the quote again: use the link in that email to accept.
Questions: 224-213-6727." When the quote had no address: "This quote was priced before we had a
ship-to address, so nothing was accepted and nothing was charged. We have your address now and are
confirming the price for it. We will email you the quote again: use the link in that email to accept.
Questions: 224-213-6727." The page heading is "We are confirming the price for your address."

**What you read.** Email subject: "Quote 8D0CA396: ship-to address changed at acceptance, re-confirm
the price" (the reference only; nothing the buyer typed is in a subject line). In the queue: "The
buyer gave a different address when accepting (date), so no order was made. The price was for: … .
Check the total for the address above, change it if freight differs, and send the quote again. The
buyer's link stays closed until you do."

**Everything the review listed as holding on this path still holds**, shown again on requests that
carry an address (my `r4-shipping-firm.js`, 10 checks): another total on the page is refused (409); a
card accept and a purchase-order accept at the same instant make one order; the order is at your
total whatever the request body says; the price cannot be edited under an accepted quote; the card
page is for the quoted total; a doctored report of $1.00 paid on $480 does not release the order
(flagged); after you revise a price the first link is dead (410); a second acceptance with another PO
number or a card is refused; a part on a firm-quote request cannot have its units changed (409
`part-locked`); an unconfirmed purchase-order order cannot be reordered.

**What I ran.** `server/routes/firmQuoteShipTo.test.js`, new, 14 cases. `r4-shipping-firm.js`
section D. The existing firm-quote suites with their requests given an address (section 4).

### 3. A buyer is not locked out by their own changes (N-01); phone orders are safe from the clean-up (F-12)

**What was wrong (N-01).** A buyer reaches the card page, goes back, changes a quantity and presses
pay again. A quote that has been to checkout is no longer a draft, so the change makes a new quote
and paying for it makes a new order; the old order stayed "waiting" for two hours. An account may
hold three such orders, so the fourth try was refused, and the buyer had no way to close anything.

**What changed.**

- **(a) The order a changed quote replaces is closed in the same step.** When a quote that has been
  to checkout is changed, the new quote remembers which quote it came from. When the buyer checks the
  new one out, their own unpaid card order of the earlier version is closed in the same database
  change that writes the new order, so it never counts against the three. Its payment page is
  expired at Stripe first. (Finding that earlier order reads two columns of the quotes table, not
  the quotes themselves: `quotesStore.chainRoot`, commit `f840893`, measured in section 3.)
- **(b) A buyer can cancel their own unpaid order.** "Your orders" shows a Cancel button on an order
  that is waiting for a card payment. It expires the payment page at Stripe, then closes the order
  ("Not paid, closed"); the quote is still theirs to order again.
- **Both keep the rule the previous fix set.** If the payment page cannot be confirmed closed (Stripe
  does not answer), the order is left exactly as it was: at checkout the new order is made beside it
  and the old one goes on counting; on Cancel the buyer is told to try again. If the page turns out
  to have been PAID a moment before (another tab), the order is settled as it stood and is not
  closed: at checkout no second payment is started and the buyer is told. A payment that still
  arrives on a closed order's page is flagged for you as "Late payment", as before.
- **The ceilings are unchanged**: 3 unpaid orders at once and 8 started in 24 hours per account, 5
  and 16 per address. Note the second number: every checkout started and not paid for still counts
  in the day's total, replaced or not, so a buyer can go back and change an order seven times in a
  day and is refused on the ninth unpaid checkout, with the "more checkouts started and not paid for
  than we take in one day" message. I kept that on purpose: without it, check-out-and-cancel in a
  loop would be a free way to fill the database.
- Only the buyer's OWN waiting card order of the SAME quote chain is closed. An unpaid order for
  other parts, anybody else's order, a firm-quote order, a purchase-order order, a phone order and
  an order flagged for you are never touched by either (a) or (b).

**What a customer now reads.** On Cancel, a question first: "Cancel order 1A2B3C4D? It has not been
paid for and nothing has been charged. Your quote stays saved, so you can order again." Then: "Order
1A2B3C4D was cancelled. Nothing was charged. Your quote is still saved in the quote tool." If the
page could not be confirmed closed: "We couldn't confirm that the card page for this order is closed,
so the order was left as it is. Nothing was charged. Give it a minute and try again, or call
224-213-6727." If the earlier order had just been paid: "Your earlier order for these parts has just
been paid, so we did not start a second payment. Open that order to see it. If you want this changed
quote as well, come back and check out again. Questions: 224-213-6727." The refusal at three unrelated
unpaid orders now names the new way out: "You have 3 orders waiting for payment, which is the most we
keep open at once. Pay for one of them from Your orders, or cancel one there, then check out again.
(An order nobody pays for closes by itself: a payment page stays open for 2 hours.) To place this
order by phone, call 224-213-6727."

**What was wrong (F-12).** The clean-up that closes abandoned checkouts when the file store or the
database is full built its list from unpaid orders whose payment method was "card" or not set. An
order you take by phone is stored with no payment method. The previous write-up said a phone order
is never touched; the review read the code and said it would be, without running it.

**What changed.** The list and the closing step now take "card" exactly
(`orderLifecycle.isWaitingCardOrder`), and so does the step that clears the lines of orders that
closed unpaid. An order with no payment method (phone), a purchase-order order and a firm-quote order
cannot be on the list and cannot be closed if asked directly.

**What I ran.** `server/services/ownerOrdersPressure.test.js`, new, 5 cases: a phone order, a
purchase-order order and a firm-quote card order are each made through their real route, given the
largest files of anybody, and the clean-up is run three times on a full file store and twice on a
database "at three times its ceiling". An abandoned card checkout beside them is closed each time
(so the pass did reach the closing step); none of the three is. **With the two rules put back as they
were, 4 of the 5 cases fail and the phone order ends "expired"** (1 run): the review's reading was
right. The reviewer's `r3-pressure-collateral.js`, which makes a phone order beside two honest card
orders and floods the file store: on the review's commit `0af96f9` the phone order ended "expired"
in 2 of 2 runs; on this work it stayed "waiting" in 4 of 4, the 2 included in which the clean-up
did close the card orders beside it (section 3). `server/routes/orderCaps.test.js`, new, 14 cases
(also item 5). My `r4-caps-and-cancel.js`.

### 4. A full disk is visible and says what it is (N-08)

**What was wrong.** The database lives in memory and is written to its file after every change. With
the disk full that write fails. The site logged it and carried on: a new account was answered
"created" and existed only in memory; the health check said "ok"; and at the next restart the start-up
check, which writes the file once, read the failed write as "the database cannot be used" and told you
to restore a backup.

**What changed.**

- **A write that fails makes the request it happened under fail.** `server/middleware/saveGuard.js`
  watches a counter of failed writes; a request that sees it move is answered 503 with one sentence,
  whatever its route was about to say. Every route is covered at once, including ones that log an
  error and carry on. A new row whose write failed is also taken back out of memory, so what was
  refused does not turn up later as if it had been accepted.
- **The health check** answers 503 "unavailable" after a failed write and 200 "ok" again after the
  next one that succeeds. The write is tried again every 15 seconds without anybody asking, so the
  site recovers by itself when there is room.
- **The start-up refusal** for "no space left" now reads: "FATAL: THE DISK IS FULL, so the site has
  NOT started. The database file … was read and is whole; it has not been changed and it is not
  damaged. … Free space on the volume (remove backups, exports or logs that were put on it) or make
  the volume larger in Railway, then restart. Do NOT restore from a backup and do NOT delete the
  database file".
- A failed write no longer leaves its half-written temporary copy on the disk holding the last free
  space.
- A payment event Stripe sends a second time is not acknowledged from memory while the file cannot be
  written; Stripe sends it again later.
- **The runbook** (`docs/launch/go-live-runbook.md`) has a section "The volume is full": how you
  would know, what it means, what to do, and two new rows in its tables.

**The previous fix is not weakened.** A zero-length or truncated database still stops the start with
the "cannot be used … Restore the volume from its backup; do not delete the file" message, with the
disk full or not, and is never written over (tested both ways).

**What a customer reads** while the disk is full: "We could not save that just now, so it has not gone
through. That is a fault on our side. Try again in a few minutes, or call 224-213-6727 or email
quotes@straightedgemfg.com." Pages that only read (the site, a quote, an order) still open.

**What is not covered, on purpose.** A change to a draft quote is answered first and written up to
1.5 seconds later (unchanged; the previous write-up lists it). If the disk fills in that moment the
last change to a draft is acknowledged and can be lost at a restart. The health check still turns
"unavailable". The check is also "a write failed while this request was being handled": two requests
that overlap at the moment the disk fills can both be refused when only one of them wrote. That errs
on the safe side.

**What I ran.** `server/models/diskFull.test.js`, new, 8 cases on the real server with a stand-in that
makes writes of the database file fail while a flag file exists (no root needed). A new case in
`server/routes/orderAtomic.test.js`: a checkout with the disk full opens no payment page at Stripe,
and the same button works once there is room (one order, not two). On a **real 3 MB disk** (a memory
disk mounted for the purpose): my `r4-full-disk.js` and the reviewer's `r3-full-disk.js`.

### 5. Small corrections the review asked for

- **The per-address ceilings (5 at once, 16 a day) are now run by a test with the real numbers**:
  `server/routes/orderCaps.test.js`. Before, only the per-account ceilings were.
- **The harness comment** named `routes/orderCaps.test.js` when no such file existed. The file now
  exists and the comment names both suites that run the real ceilings.
- **The previous write-up** (`docs/security/rereview-fixes-2026-11-13.md`) is corrected where it
  stands, each place marked "Corrected", with a note at its top: the 30 minutes (not ten) an unpaid
  order keeps its files after its payment page closes; "a material you deleted stays deleted" (not
  when the whole list is emptied: the next start seeds the default catalogue again); the new baseline
  file `soup-wide-100k.json.gz` (252 bytes: it records that this test model is refused as "not
  measurable", so it has no price); and the repeat-email counts for F-05, which were measured without
  a mail provider and understate repeats (the review's 59 of 98 is the figure to hold). No behaviour
  was changed for these.

## 3. Verification on the final commit

Everything in this section was run on commit `f840893`, the last commit that changes any code, test
or script. The commits after it change this file only. It was run in a clone of the branch made in an
empty folder (cloned at `6336917`, `npm ci` there: exit 0, 0 vulnerabilities; then pulled forward;
`package.json` and the lock files are the same at both commits), on Node 20.20.0, two cores, with
local stand-ins for Stripe and mail. Each script was run once unless a count of runs is given.

**The suite, the build and the comparisons**

| What | Result |
|---|---|
| `npm test` | 104 of 104 suites passed. 1,267 cases printed "ok", none failed. 10 min 26 s |
| Production build (`NODE_ENV=production npm run build`) | exit 0; 22 of 22 pages prerendered |
| Claims check (`scripts/claims-check.js`) | exit 0; 257 built files read (21.4 MB, 1 PDF); the shop's street address is in none |
| `npm audit --omit=dev` | server: 0 vulnerabilities; client: 0 |
| 300-quote vetting comparison against `28cb39d` | 300 quotes on each side; both sides "0 fails, 63 warnings"; 52 columns compared; **rows that differ: 0** |
| Payments proofs (`tools/security/review-payments/run-all.sh`) | 0 of 79 checks show a weakness (1 + 4 + 4 + 6 + 8 + 15 + 15 + 5 + 5 + 5 + 2 + 9) |

The same six were also run on `6336917` with the same results, the same 1,267 "ok" lines included.

**Every script in `tools/security/rereview-relaunch/`** (none edited)

| Script | Result |
|---|---|
| `units-race.js` | 2 held, 0 findings |
| `order-list-hold.js` | six list requests, all 200, 5 to 16 ms each; health page worst 3 ms meanwhile |
| `checkout-hold.js 100 0,6,12` | 100-line checkout on a 0.2 / 6.1 / 12.1 MB database: answered in 106 / 170 / 172 ms; health page worst 75 / 90 / 93 ms; 0 samples over 250 ms |
| `units-flip-hold.js` | six flips, all 200; health page worst 60 ms |
| `catalogue-upgrade.js` | 22 held, 0 findings, 2 info |
| `money-attacks.js` | 66 held, 0 findings, 12 info |
| `access-matrix.js` | 25 held, 0 findings, 2 info |
| `route-inventory.js` | 0 owner routes without the sign-in and owner checks |
| `master-upgrade-access.js` | 3 held, 0 findings, 1 info |
| `public-surface.js` | 6 held, 0 findings |
| `shipping-exposure.js` | exit 0; its table of prices is the same, line for line, as on `6336917` |
| `storage-pin-orders.js pin` | store 97 % after the flood, 74 % after the clean-up; a visitor and a customer both accepted again |
| `memory-poison.js` | exit 0; one hostile 25 MB file refused at the memory line (the server said it was at 990 MB), one refused as not measurable, one answered "busy"; the server at 598 MB afterwards; 16 of 16 honest files read, in 0.1 to 1.5 s; 0 customers refused |
| `durability-kill.js 50` (ceilings lifted by its own settings) | 11 held, 0 findings, 3 info. Section C, 50 kills during the checkout of a 20-line quote: 29 left no order, 21 a whole order, **0 a partial order**. Section D, 50 kills during the "paid" webhook: 50 of 50 paid after Stripe sent the event again, 0 left untold. None of D's kills landed between "paid on disk" and "emails sent"; the review's `r3-paid-mail-window.js` below aims at that moment and hit it 195 times |

**The reviewer's `r3-*.js` scripts** (none edited). "Expected" below means the finding is one the
review listed and this work was told to leave.

| Script | Result |
|---|---|
| `r3-shipping-firm-f06.js` | **N-03 held**: "an off-mainland ZIP code under a mainland state code is refused" (6 of 6 refused; they were sold 6 of 6). **N-05 held**: "a firm quote cannot be accepted to an address outside the contiguous states" (Honolulu, Hamburg, Anchorage: each 409 `address-reconfirm`, no order made; they were accepted 3 of 3). 21 lines held in all. Three findings, then the script stops with an error in its section D and never reaches its section E; each is explained in section 4. One of the three is N-04 (the 62 in strip on the diagonal), expected |
| `r3-caps-and-lists.js` | **N-01 held**: "six changes of quantity, six checkouts: never refused". 10 held, 2 findings, 7 info. One finding is N-02 (two buyers behind one address), expected. The other is the script's own assumption about the oldest order, explained in section 4 |
| `r3-full-disk.js` on a real 3 MB disk | **N-08**: with the disk full, a new account is answered 503 `save-failed` (was 201 "created"), sign-in 503, health check 503 (was 200); the database file is whole and unchanged; a restart is refused, exit 1, with "FATAL: THE DISK IS FULL, so the site has NOT started…" (was "…cannot be used. Restore the volume from its backup"); with room made, it starts and the health check is 200. The script's own verdict line is "HOLDS: the database file stayed whole and kept the first account through a full disk" |
| `r3-pressure-collateral.js` | **F-12, the phone order: not closed, in 4 of 4 runs on this work (1 on `9e9db24`, 3 on `f840893`), the 2 included in which the clean-up did close the card orders beside it. On the review's commit `0af96f9` the same script closed the phone order in 2 of 2 runs.** What happens to the two honest card orders beside it is N-07, expected, and it came out both ways: in 2 of the 4 runs on this work the clean-up closed both honest customers' unpaid card orders and in 2 it closed nothing; on `0af96f9` it closed them in 2 of 2 (the review's own single run closed nothing). See section 6 |
| `r3-event-orderings.js` | 29 held, 0 findings, 3 info |
| `r3-units-paths.js` | 9 held, 0 findings |
| `r3-catalogue-odd.js` | 25 held, 1 finding, 2 info. The finding is "every finish deleted: the next start seeds the defaults again", which the review reported and which item 5 corrected in the previous write-up; not touched |
| `r3-baseline-diff.js` | 0 values differ outside the shipping fields |
| `r3-paid-mail-window.js` | "HOLDS: 200 kills (195 inside the window): every order paid, nobody left untold." Told twice: 122, every one with the same key (so the mail provider drops the repeat); 0 with different keys |
| `r3-loop-experiment.js` | not a test of the site (a timing experiment on Node itself): new connection worst 921 ms, open connection 84 ms |
| `r3-checkout-dist.js` | N-09, expected. 30 checkouts of 100 lines on a 12 MB database: a new connection waited 186 ms (median), 316 ms at worst, 3 of 30 at or over 250 ms; an open connection 60 ms (median), 124 ms at worst. See the comparison below |
| `r3-swap-under-checkout.js 20 0` | N-06, expected. 10 of 20 at or over 250 ms, worst 435 ms. See the comparison below |

**My scripts beside them** (`tools/security/rereview-fixes/`)

| Script | Result |
|---|---|
| `r4-shipping-firm.js` | 34 held, 0 findings |
| `r4-caps-and-cancel.js` | 11 held, 0 findings, 1 info |
| `r4-full-disk.js` on the real 3 MB disk | 12 held, 0 findings. Its one info line: 1 email was written for the account that was then not saved (section 6, point 8) |
| `r4-f06-race.js 200` (the reviewer's section E, copied unchanged) | 2 held, 0 findings: **0 of 200 rounds flagged, 0 of 200 with an amount that differs from what was charged.** 195 ended paid as pickup; 5 ended unpaid because no page was open at the instant the buyer tried (nothing charged). The review measured 0 of 200, 187 and 13 |

**Browser runs** (the preinstalled Chromium, against the production build)

| Script | Result |
|---|---|
| `scripts/e2e/hardening-accounts.mjs` | 121 of 121 checks |
| `scripts/e2e/order-lifecycle.mjs` | 72 of 72 checks (63 before this work, plus the 9 of step E2) |
| `scripts/e2e/tax-shipping.mjs` | 57 of 57 checks |
| `scripts/e2e/journey-qa.mjs` at 390 px and 1360 px, with the accessibility checker | 204 screens (102 at each width): 0 scroll sideways, 0 with a serious or critical accessibility fault, 0 problems noted |

**Did this work slow checkout down? Same machine, the review's commit against this one.** The two
timing scripts were run on `0af96f9` (the commit the review was written on) and on this work, turn
and turn about, because this machine gave slower figures today than the review recorded and the
figures move from run to run.

| `r3-checkout-dist.js`, a new connection's wait, 30 checkouts a run | Median | Worst | At or over 250 ms |
|---|---|---|---|
| `0af96f9`, run 1 | 184 ms | 275 ms | 1 of 30 |
| `0af96f9`, run 2 | 199 ms | 295 ms | 4 of 30 |
| this work (`9e9db24`), run 1, straight after the storage test | 216 ms | 381 ms | 7 of 30 |
| this work (`9e9db24`), run 2 | 183 ms | 250 ms | 1 of 30 |
| this work (`9e9db24`), run 3 | 212 ms | 297 ms | 2 of 30 |
| this work (`f840893`) | 186 ms | 316 ms | 3 of 30 |

| `r3-swap-under-checkout.js 20 0` | At or over 250 ms | Worst |
|---|---|---|
| `0af96f9`, run 1 | 9 of 20 | 382 ms |
| `0af96f9`, run 2 | 12 of 20 | 344 ms |
| this work (`9e9db24`), run 1, straight after the storage test | 20 of 20 | 666 ms |
| this work (`9e9db24`), run 2 | 10 of 20 | 420 ms |
| this work (`9e9db24`), run 3 | 14 of 20 | 441 ms |
| this work (`f840893`) | 10 of 20 | 435 ms |

What I take from this: the runs overlap, and one run of each (the first, made right after a test that
fills the file store) stands apart from the rest. I cannot show from these that this work is slower
and I cannot rule out a difference of 10 to 20 ms in the median. I looked for a cause in what I had
added to checkout and found one: the look-up of the orders a changed quote replaces read each of the
buyer's other waiting quotes in full. Measured by itself, 20 tries: 7.95 ms (median) for two 100-line
quotes, 12.29 ms at worst. `f840893` reads two columns in its place: 0.056 ms (median), 0.319 ms at
worst. Both N-06 and N-09 stand as the review wrote them.

## 4. Existing tests and scripts changed, each with its reason

Nothing in `tools/security/rereview-relaunch/` and none of the reviewer's `r3-*.js` scripts was edited.

| File | What changed | Why |
|---|---|---|
| `server/routes/taxShipping.test.js` | Two addresses: an Illinois address is given an Illinois ZIP code (it had Ohio's); the "address Stripe cannot place" uses ZIP code 43299 where it used 00000. The firm-quote helper sends the ship-to address with the request; the "an address is still required" case uses a request that came with none | A state must match its ZIP code, and 00000 is no longer let through to Stripe at all (item 1). A firm quote is accepted to the address it was priced for (item 2) |
| `server/routes/rfqQuote.test.js` | The request helper and three single requests send the address. The case "accept needs a ship-to address" now makes that check on a request that came with none | Item 2: with an address on the request, accepting without typing it again is right, not an error |
| `server/routes/orderLifecycle.test.js` | Two requests send the address. The "ordinary punctuation is text" case sends its street with punctuation on a request (and checks it is stored as typed) and changes only the name at acceptance | Item 2: a different street at acceptance is now an address change |
| `server/models/orderLifecycleMigration.test.js` | The quoted firm quote in the database made by the earlier version (no address) is accepted in two steps: the first gives the address and goes back to the owner, the owner sends again, the second is accepted | This is exactly "an open request with no address" from item 2; the test now holds the upgrade path |
| `server/ops/ownerNotifications.test.js`, `server/ops/system.test.js`, `server/routes/authorization.test.js` | Their firm-quote requests send the address. `authorization.test.js` also lists the new route `POST /api/orders/:id/cancel` in its inventory of every route and who may call it | Item 2; item 3 (a route that is not in the inventory fails that suite, which is its purpose) |
| `server/models/databaseDurability.test.js` | One assertion that reads the source of `saveToDisk` | The one call that writes the file is now inside a `try` so a failed write is counted (item 4). What the assertion holds is unchanged: one write path, and "saved" is set only after it returned |
| `server/routes/relaunchIntegration.test.js` | One assertion that reads the source of the checkout route | The checkout step takes a third argument (item 3). The assertion finds the call by its first two |
| `server/routes/orderAtomic.test.js` | One case ADDED (checkout with the disk full); nothing existing changed | Item 4 |
| `server/routes/shippingLimits.test.js` | Five cases ADDED (ZIP code against state through the real checkout route); nothing existing changed | Item 1 |
| `server/testSupport/harness.js` | A comment | Item 5 |
| `scripts/e2e/hardening-accounts.mjs`, `journey-qa.mjs`, `order-lifecycle.mjs`, `tax-shipping.mjs`, `tools/security/csp-browser-check.js` | The state is chosen from the list where it was typed. Every send of the request form fills the ship-to address first. The firm-quote page is driven as it now is (the priced-for address is shown; only the name on the box is typed). `order-lifecycle.mjs` gains a step, E2, with 9 checks: Cancel on "Your orders", and a firm quote sent to a different address through to the owner's queue and the re-sent link | Items 1, 2 and 3 change those pages |
| `tools/security/review-payments/poc-07`, `poc-09`, `poc-11`, `poc-12` | Their firm-quote requests send the address they later accept to | Item 2. What each proof tests is unchanged |

**Two of the reviewer's scripts can no longer express a case as written, and a third records the new
behaviour.** All were run unedited; their output is in section 3; my scripts stand beside them.

- `r3-shipping-firm-f06.js`
  - Section A, the finding "ordinary mainland addresses are accepted". Nine of its ten ordinary
    addresses are accepted, "D.C.", "Washington DC", "Ill." and "N.Y." among them. The tenth is the
    state " il " sent with the script's standing ZIP code, 43215, which is Columbus, Ohio. That is
    the mismatch item 1 refuses (400 `address-mismatch`), so this finding is the script's own test
    address.
  - Section C, the finding about the 62 in strip on the diagonal, is N-04: listed by the review,
    not in this work.
  - Section D asks for its firm quotes without a ship-to address, as the form then did. Its first
    check now reports held (acceptance to Honolulu, Hamburg and Anchorage: each 409
    `address-reconfirm`, no order made). Its second holds (another total on the page: 409). Its
    third sends a card acceptance and a purchase-order acceptance at the same moment and expects
    exactly one order. Both are answered 409, because the quote has gone back to the owner for its
    address, so the script prints a finding ("card 409, PO 409, orders 0") and then stops with an
    error on its next line, which reads the total of an order that was never made (exit code 2).
    The rest of section D and the whole of section E are not reached.
  - Beside it: `r4-shipping-firm.js` makes every check of section D on requests that carry an
    address (there the two acceptances at one moment make one order). `r4-f06-race.js` is section
    E, copied unchanged with the set-up lines it needs.
- `r3-caps-and-lists.js`, section 1, takes "the oldest unpaid order" after six changes and expects
  that paying for its quote hands that same order back. That order was closed when the next version
  was checked out, so the answer is 200 with a new order for that first version, and the check counts
  the different order number as a finding. Its information line "can the buyer close one of their
  own unpaid orders?" tries the owner's status route (403) and a DELETE (404); the buyer's route is
  `POST /api/orders/:id/cancel`. Beside it: `r4-caps-and-cancel.js`. Its other finding is N-02.
- `r3-full-disk.js` runs as written and records the new behaviour; its two verdict lines are the
  same as before because they are about the file staying whole. Beside it: `r4-full-disk.js`, which
  checks each step.

## 5. Changed outside the list

Each of these follows from one of the five items; none is a change of price or limit.

- **`.env.example`** lists a new setting, `DB_SAVE_RETRY_MS` (15000): how often a failed write of the
  database file is tried again. You do not need to set it.
- **The owner's phone-order route** (`POST /api/orders`) checks the state against the ZIP code when
  you type either, so a slip is caught when the order is entered. It does not price by destination.
- **`GET /api/public/config`** (what the browser is told before any sign-in) gained one yes/no:
  whether pickup is offered, so the request form knows whether to offer it.
- **The refusal at three unpaid orders** names the Cancel button (wording in section 2, item 3).
- **The firm-quote email to the buyer** has a new line, "Priced for delivery to: …".
- **A phone order you cancelled keeps its lines** under database pressure (the same one-word rule as
  the clean-up; before, they could be cleared, after which it could not be marked paid by hand).
- **Stripe is not told "received" for a repeated payment event while the database file cannot be
  written**; it is asked to send it again.
- **`docs/launch/go-live-runbook.md`**: the section and two table rows for a full volume.
- **Found on the way and fixed, in my own earlier commits of this work:** the commit for item 3
  left `server/routes/authorization.test.js` failing (the new route was not in its inventory) and the
  commit for item 4 left `server/security/envExample.test.js` failing (the new setting was not
  listed). I had run only the suites near each change. Both were found by the next full run and are
  fixed in `6336917`.

## 6. Still open

**Not in scope, left alone as instructed:**

- **N-02**: two buyers behind one office address share five places. The ceiling is a setting
  (`ORDERS_UNPAID_PER_CLIENT`); your decision.
- **N-04**: a long part drawn on the diagonal reads shorter than it is (a 3 x 62 in strip at 45
  degrees reads 45.96 in and is sold with parcel shipping). The review's script still shows it.
- **N-06**: a quote swapped in under a checkout is priced in one piece (about a quarter of a second).
- **N-07**: new files from confirmed accounts hold the file store for their first hour. **One thing
  the review did not see and these runs did:** in the reviewer's `r3-pressure-collateral.js` the
  clean-up closed both honest customers' unpaid card orders in 2 of 4 runs on this work and in 2 of
  2 on the review's commit. The review's one run closed none, and it wrote that it could not
  construct the case. Each buyer was emailed "your unpaid order … was closed", and the one the
  script follows checked out again at once (200) and kept that order through the next passes. From
  reading `relieveStorage`, which way a run goes depends on how full the store is at the moment a
  clean-up pass happens to run during the flood: orders are closed only at 85 % or over, and a pass
  that finds nothing it may remove waits up to five minutes before the next. I did not test that
  reading. This work changes only which orders can be on that list (never a phone, purchase-order
  or firm-quote order).
- **N-09**: a visitor on a NEW connection waits for a whole chain of work during a burst of
  checkouts; to be measured on Railway first.
- **Canada and Mexico in the country list** on the checkout page (choosing one ends in "we confirm
  freight first"). The new request form offers the same three countries.
- **Waste factor, material class and stock forms** on the material form are still not saved.

**Open from this work, for you to know:**

1. **ZIP codes that cross a state line.** Four are handled (Fishers Island NY 06390, Kaskaskia IL /
   St. Mary MO 63673, Texhoma TX 73960, Alta WY 83414). A buyer at another one is told the state and
   ZIP code do not match, and to call. If a customer reports it, the fix is one line in
   `server/services/usAddress.js` (`EXCEPTIONS`).
2. **The day's ceiling still counts replaced and cancelled checkouts** (8 per account in 24 hours).
   A buyer who changes an order eight times in a day is refused on the ninth.
3. **A request without an address is still taken** when sent by hand (the form requires one). The
   safe path handles it; say if you would rather the server refused it.
4. **You cannot edit the ship-to address of a request in Admin.** If a buyer phones with a new
   address before you have priced, price for it and say so in the note; when they accept and type it,
   the quote comes back to you once and you press Send.
5. **The firm-quote PDF does not state the ship-to address** (the email, the page and the admin queue
   do).
6. **A buyer cannot cancel a firm-quote order from "Your orders"** (it is refused in words, with the
   phone number). Only orders from instant checkout can be cancelled there.
7. **A buyer whose earlier order is closed because they changed the quote is not emailed about it.**
   It shows in "Your orders" as "Not paid, closed". It was their own action a moment before.
8. **While the disk is full a route goes on after its failed write** before its answer is replaced:
   for example the confirmation email for an account that was then not kept may still be sent. The
   buyer is told it did not go through, and the link in such an email opens nothing.
9. **The review's hand tests (its section 8) still stand.** Three of them now have a different
   expected result: test 5 (Honolulu under "CA") is refused; test 6 (a firm quote accepted with an
   address in Hawaii) comes back to you as "address changed"; test 7 (go back and change the quantity
   three times) is not refused, and you can also try Cancel in "Your orders".

## 7. Not shown in the sandbox

- **Stripe.** That a payment page the site has expired can no longer be paid. Items 3(a) and 3(b)
  rely on it exactly as the previous fixes did; the stand-in assumes it. If Stripe took a payment on
  an expired page, the order would be flagged "Late payment" for you (shown with the stand-in).
- **The ZIP code table against the Postal Service's own list.** The sandbox could not open a live
  copy (the one attempt, a public encyclopedia page listing the prefixes, was not permitted), so the
  table is from memory, tested as described in item 1. This is the first thing to check by hand.
- **A full disk on Railway's volume.** Shown on a 3 MB memory disk here, where a full disk reports
  "no space left" (ENOSPC). A volume with a quota may report "quota exceeded" (EDQUOT); the code
  treats the two alike, and that second case was not run.
- **Browsers.** The browser runs use the preinstalled Chromium only.
- **Carriers.** What freight to Hawaii or to a changed address costs is yours; the site now stops and
  asks you.
- **Timing figures** are from this two-core machine, which was slower today than when the review
  measured on it. Hold this work's figures against the same-day figures for the review's commit in
  section 3, not against the review's own table. None of them is Railway's number.

## 8. Judgment calls, and where the next reviewer should start

1. **The ZIP code table (item 1).** Written from memory, not checked against a live source. A wrong
   row turns honest buyers away, it does not sell anything wrongly. Start here.
2. **How a failed write fails the request (item 4).** I did not make the database layer throw on a
   failed write, because many routes are `async` with no error handler and an error escaping there
   stops the process on Node 20. Instead a counter is watched and the answer is replaced. The cost:
   it is "a write failed during this request", not "this request's write failed", and the route's
   own code runs on after the failed write (section 6, point 8). A new row is taken back out of
   memory; a changed or deleted row is not, and reaches the disk with the next write that succeeds.
3. **Which earlier order a changed quote replaces (item 3).** Every quote forked from a quote after
   it went to checkout carries the id of the first quote of that chain; checking out any quote of the
   chain closes the buyer's other waiting card orders of the same chain. So a buyer who goes back to
   the FIRST version and pays for that closes the order for the later version too: the last version
   they press pay on is the order. I think that is what a buyer means; it is a choice.
4. **The day's ceiling counts replaced orders (item 3).** Kept, so that check-out-and-cancel cannot
   be looped for free.
5. **A firm quote's "same address" (item 2)** ignores the name on the box, capitals, full stops and
   the last four digits of the ZIP code. A suite or apartment number is part of the street line and
   does count.
6. **A request without an address is taken, not refused (item 2).** See section 6, point 3.
7. **Pickup is always accepted at the quoted total (item 2)**, as it was before.
8. **Whether checkout is slower (item 3).** Checkout now also looks for the orders a changed quote
   replaces and closes them in the same write. The same-day comparison in section 3 does not show a
   difference and cannot rule out one of 10 to 20 ms in the median. The one cost I could measure by
   itself (about 8 ms for a buyer with two other 100-line orders waiting) was removed in `f840893`,
   after the first verification run; everything in section 3 was then run again on that commit.
9. **Off-mainland ZIP code first, mismatch second (item 1).** A Hawaii ZIP code under "CA" is told
   "we confirm freight first" (and a firm quote records it as Hawaii), not "the state and ZIP code
   don't match", because the brief asked for that order. A buyer who simply mistyped a ZIP code into
   a Hawaii one reads the freight message.
