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

**IN PROGRESS. No verdict yet. Do not read this file as a clearance.** The container restarted once
during the review; everything listed as "done" below was finished and recorded before or after it, and
anything that was in flight was run again.

| Area | State |
|---|---|
| Reproducing the author's figures on `28cb39d` | Done: `npm ci`, `npm test`, build, claims check, `npm audit`, and 11 of the 16 scripts in `rereview-relaunch/`. Not yet: `durability-kill.js`, `storage-pin-orders.js`, `memory-poison.js` |
| F-07 event order | Done: `r3-event-orderings.js` |
| F-09 lists, single-order route, ceilings on unpaid orders | Done except the browser check: `r3-caps-and-lists.js` (findings N-01, N-02) |
| F-03 shipping limits on every route; firm quote and purchase order | Done: `r3-shipping-firm-f06.js` (findings N-03, N-04, N-05) |
| F-06 two tabs under a race | Done: `r3-shipping-firm-f06.js` section E, 200 rounds |
| F-08 / F-02 checkout hold | Single-checkout distribution done (87 samples, written up). Not yet: kills (F-02), the swap attack, several checkouts at once |
| F-01, F-13, F-12 (storage side), F-10/F-11, F-04, F-05 | Not yet attacked (scripts for F-05 and F-12 are written, not yet run) |
| Reorder money path | Not yet attacked |
| Changed-tests audit, price baseline, vetting comparison | Started (five test files read); not finished |
| Browser check of the admin panel | Not started |

## 2. Verdict

Not yet given.

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
| `durability-kill.js`, `storage-pin-orders.js`, `memory-poison.js` | see the write-up | not yet run |

## 4. Per original finding

(Filled in as each is finished. Findings not listed here have not been judged yet.)

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
The independent 300-quote vetting comparison has not been run yet.

### F-09 (order list, admin panel): server side closed; browser not yet checked

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

The ceilings on unpaid orders that the author added under this finding are findings **N-01** and **N-02**.
The author's statement that the test harness lifts the ceilings by default is true; one suite
(`server/routes/orderList.test.js`) runs with the real ceilings, and the comment in the harness names a
file, `routes/orderCaps.test.js`, that does not exist.

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

Still to run under this finding: several checkouts at once and the kill tests (F-02). The swap attack is finding N-06.

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

## 6. Changed-tests audit

Not finished. Read so far, each against `git diff dce1e38..28cb39d -- <file>`:

| File | Judgment |
|---|---|
| `server/models/partPayloads.test.js` | Follows a real change (F-09). The new assertions are stricter: the list must carry no lines and be under 4 kB; the single-order route must carry the lines without measurements |
| `server/routes/relaunchIntegration.test.js` | Follows a real change (checkout is a named step run by the pricing runner). Still asserts that every order insert sits after the pricing check and that the handler itself neither prices nor inserts. Counting final passes only is right: a warm-up pass judges nothing |
| `server/services/rowRetention.test.js` | Follows a real change (the 48-hour rule was F-12). New cases added for a card checkout with no page. Note: the code allows 30 minutes after a page lapses, the write-up says ten |
| `server/routes/priceIntegrity.test.js` | One line waits for the deferred re-pricing (F-13). Asks the same question |
| `server/models/taxShippingMigration.test.js` | The fixture's line now names a part that exists. Reasonable: a quote without its part could not be checked out before either |
| `tools/security/review-payments/poc-01-dxf-units-swap.js` | 20 pieces cut to 1. Still proves what it was written to prove: its finding fires on "paid less than half the honest price for the full-size part", and at one piece the honest part (40 x 30 in, 3/4 in HDPE, about 35 lb packed) is still orderable online, so the swap can still be attempted. Not yet re-run by me |
| `tools/security/review-payments/lib.js`, `poc-09-…` | Ceilings lifted for proofs that make many unpaid orders; order read from the single-order route. Follows real changes |
| `tools/security/review-uploads/preload-stubs.js` (Stripe stand-in) | Ids unique per process; `expire` added, refusing a page that is not open, as Stripe does. Not more forgiving than Stripe in what I read. With `REVIEW_STUB_PAY=1` an open page counts as paid when asked about, which is only set by scripts that need a paid order |
| the rest of the author's section 6 | not yet read |

## 7. Not covered yet, and what a sandbox cannot show

To be written at the end. Standing items: nothing here called Stripe, Resend, Turnstile, Railway or a
carrier; "loaded" is four busy loops on two cores.

## 8. What the owner must test by hand

To be written at the end.
