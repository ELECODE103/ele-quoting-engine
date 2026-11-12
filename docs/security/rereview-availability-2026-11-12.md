# Independent re-review of the availability fixes, 2026-11-12

Reviewed: `git diff hardening-2026-11-11...availability-fixes` (17 fix commits, head 3aae0c0), on branch
`rereview-availability-2026-11-12`. I wrote this report and the scripts under
`tools/security/rereview-availability/`. No application code was changed.

Every number below was measured in the shared sandbox: **2 CPU cores, load average between 3 and 9 for
the whole session, Node 22.23** (production is Node 20). Timings are therefore slower than a quiet
machine would give; each one is printed with the load average at that moment, and where a result
depends on timing I say how many runs showed it. Counts (requests, addresses, bytes, statuses) do not
depend on load.

Contents: 1 summary, 2 findings table, 3 the caps one by one, 4 findings in detail, 5 claims I
checked and they hold, 6 could not verify, 7 tests and reviewer scripts, 8 the scripts.

## 1. Summary for the owner

1. **Merge it; do not launch on it yet.** The fix branch does what its own tests measure. I found no
   change to a legitimate price (300 of 300 vetting quotes identical), no way to read another
   visitor's part, and nothing that fails open with encryption. Eight problems remain to fix first.
2. **One free account can still close the site for a month** (RR-01): 224 large saved quotes fill
   the database; then nobody can upload or start a quote, and the automatic clean-up, the admin
   button and a restart all remove nothing. The same account can fill the file storage (RR-08).
3. **The site can still be frozen**: "reorder" on an order that was never paid for holds the whole
   server 11 to 15 seconds a click (RR-05); pricing 25 different dense parts from a few addresses
   takes the health check from 5 ms to seconds (RR-13).
4. **A part can be bought far under its price** (RR-10, there before the fixes): price a DXF as
   millimetres, switch it to inches, check out: $149.25 paid for a $3,376.62 job.
5. **Two new protections are switches an attacker can throw**: 30 junk requests from 3 addresses close
   the "send us your files" form for the hour when the robot check is off (RR-03); one address can
   use up the hour's confirmation emails in four minutes, robot check on or off, and new customers
   then cannot confirm their address or check out (RR-04).
6. **Switch the robot check (Turnstile) on before launch.** It makes RR-03 unreachable and RR-02 and
   RR-13 dearer. It does not help with RR-01, RR-04, RR-05, RR-08 or RR-10.
7. **Two settings to change now**: `DB_MAX_MB=16` (a nearly full 64 MB database makes every save
   slow and the clean-up freeze the server 2 to 3 s, RR-11), and `MEMORY_BUDGET_MB` set to the real
   memory of the Railway service (at the 1 GB default a customer can be refused when two upload a
   mid-size STEP together, RR-07).
8. **What can wait**: the Medium and Low rows of the table.

## 2. Findings

Severity is for a single anonymous or free-account attacker. "Kind": NEW = introduced by the fix
code; REMAINING = a finding of the first review that is not fully closed; PRE-EXISTING = there before
and outside what the fixes set out to do.

| Id | Severity | Finding | Kind | Blocks launch |
|---|---|---|---|---|
| RR-01 | High | One address and one confirmed account fill the database to 100 %; uploads and new quotes are then refused for everyone and nothing clears it for 30 days | REMAINING (H3) | Yes |
| RR-05 | High | Reorder prices on the main thread with no gate: 11 to 15 s freeze per request, from an order that was never paid | REMAINING (C2) | Yes |
| RR-13 | High | Pricing 25 different dense parts: health median 93 ms from one address, 3 to 4.5 s from eight; no account needed | REMAINING (C2) | Yes |
| RR-10 | High | A DXF's units can be switched after it is priced and before checkout: $149 paid for a $3,377 job | PRE-EXISTING | Yes |
| RR-04 | High | The site-wide cap on confirmation email is exhausted by one address in 4 minutes; new customers cannot confirm and cannot check out | NEW | Yes |
| RR-03 | High with the bot check off; not reachable with it on | 30 requests from 3 addresses close the request form to everyone without a confirmed account for the hour | NEW | Yes, unless Turnstile is on at launch |
| RR-02 | High with the bot check off; Medium with it on | No account: 25 addresses in an hour (7 over a day) pause every visitor without an account; re-pricing is never checked or limited, so the flood stays fresh while the clean-up deletes real visitors' quotes and parts | REMAINING (H3) | Yes |
| RR-08 | High | The file ceiling can still be filled: files on an open request or on an account's saved quote are never evicted; 5 addresses pause visitors, 6 with one account refuse everyone | REMAINING (H4) | Yes |
| RR-11 | Medium | Above 80 % of the database ceiling every new row sets off a clean-up pass that freezes the server 2 to 3 s; a save costs 130 to 185 ms at 54 to 60 MB; memory reaches 716 MB | NEW (pass), REMAINING (save) | No (set `DB_MAX_MB=16`) |
| RR-07 | Medium | At the default memory budget two customers uploading a 2 MB STEP together: one was refused `parse-memory` in 2 of 4 runs of the reviewer's own script and in 1 of 3 rounds with no attacker at all (loaded machine) | REMAINING (L4, M4) | No (set `MEMORY_BUDGET_MB`) |
| RR-09 | Medium | Measurements that are finite but wrong still price: hidden nested shells turn "send to a person" into open checkout; a counted volume five times the bounding box is accepted | REMAINING (H1) | No |
| RR-06 | Low | A refused upload may send 64 MB that is read and never charged to the sender's budget; a second request on the same connection is executed without an answer | NEW | No |
| RR-12 | Low | The start-up "EXISTING FILES CANNOT BE OPENED" check looks at the 25 newest files per folder, so it goes quiet after about 13 new uploads while every older part is still locked | NEW | No |
| RR-14 | Low | Reorder keeps one configuration per part: the same part ordered in two thicknesses comes back in one | PRE-EXISTING | No |
| RR-15 | Info | Accuracy of the fix write-up and of the tests (five points) | n/a | No |

## 3. The new caps, one by one

Asked for each: what it takes to exhaust it, who is then locked out, for how long, and whether a
signed-in customer with a confirmed email or a visitor who passed the bot check is unaffected.

| Cap | To exhaust it | Who is locked out, how long | Confirmed customer / verified visitor | Safe only with Turnstile on? |
|---|---|---|---|---|
| Requests from unverified senders, 30 an hour, site-wide | 30 requests from 3 addresses (10 each). Measured: 32 sent, 30th accepted | Everyone without a confirmed account, including a signed-in account that has not confirmed: `requests-paused`, Retry-After 1800, until the fixed hour ends. Each address may send 30 a day, so 24 addresses hold it shut all day | Confirmed customer: 201, unaffected. With the check on, a visitor who passes is never counted | **Yes.** With it on, senders who fail are refused before counting and senders who pass are not counted: the cap cannot be reached (measured) |
| Mail to unconfirmed addresses, 60 an hour, site-wide | One address: 10 registrations and 50 "send it again" clicks, 254 s. Or 6 addresses, 60 registrations, 49 s | Every new customer: the confirmation email is not sent, asking again answers `sent: false`, checkout answers 403 `email-unverified`. Until the hour ends | Existing confirmed customers unaffected; password reset still sent (measured) | **No.** With it on the attacker passes the check 10 times; "send it again" asks for no check |
| New-request notices to the shop, 40 an hour | Not measured. From the code: with the check off the 30-an-hour cap above is reached first; with it on, 40 verified requests from 4 addresses | Nobody is refused; the owner stops getting an email per request for the rest of the hour (requests stay in the admin panel) | n/a | n/a |
| New draft quotes, 30 an hour and 120 a day per address | 30 requests from that address | Only that address (an office behind one address shares it) | A signed-in customer has the same per-address count plus 60 an hour per account | No |
| 25 lines without an account | n/a (per request) | Nobody else | Signed-in: 100 lines | No |
| Database "visitors paused" line, 85 % | No account: 736 drafts of 25 different lines: 25 addresses in one hour or 7 over a day (RR-02). One confirmed account: no pause, straight to 100 % (RR-01) | At 85 %: every visitor without a confirmed account: no upload, no new quote, and an idle quote or part is deleted after 5 minutes. At 100 %: everyone. For as long as the rows stay: the flood's rows stay as long as they are re-priced; an account's rows stay 30 days | Confirmed customers unaffected at 85 %, refused at 100 % | Partly: with it on each address needs one passed check an hour; RR-01 is unaffected |
| File "visitors paused" line, 85 %, and ceiling | 5 addresses at the per-address storage cap; 6 with one confirmed account for 100 % (RR-08) | As above, for uploads and request attachments, until the owner deletes the requests by hand (an account's saved quote holds its files 30 days) | Confirmed customers refused at 100 % | No |
| Pricing in flight: 1 per address, 8 site-wide | 8 addresses pricing slow quotes (RR-13) | In my runs nobody was refused, but everyone waited: an innocent re-price took 3.0 to 5.4 s (median) | Not exempt | Partly (one check per address per hour) |
| Parse queue: 2 of 8 places and 180 s an hour per address | Per address | The address itself; others delayed up to 21 s in my run, none refused (section 5) | Not exempt, not needed | No |
| Verified-human token: its own client, 2,000 uses | Per token | Its holder | n/a | n/a |

## 4. Findings in detail

All commands are run from the repository root with the proxy variables unset:

```
R="env -u HTTPS_PROXY -u HTTP_PROXY -u http_proxy -u https_proxy NO_PROXY=localhost,127.0.0.1"
D=tools/security/rereview-availability
```

### RR-01. One account fills the database and nothing clears it (High, REMAINING H3, blocks launch)

**What an attacker does.** Registers one account with an email address they can read, confirms it,
uploads one 684-byte cube, and saves quotes of 100 lines that all differ (quantity 1 to 100). The new
per-address limit lets one address start 30 quotes an hour and 120 a day.

**Reproduce.** `$R node $D/db-ceiling.js account` (ceiling set to 8 MB so it runs in a minute; every
other limit is the default). `$R node $D/db-ceiling.js size` prints what one draft costs.

**Measured** (load 4.2 to 5.6):

| | Result |
|---|---|
| Bytes one draft adds to the database | 25 identical lines (what the fix write-up measured): 4,096. 25 different lines, no account: 77,824. 100 different lines, signed in: 294,912 |
| 8 MB ceiling | 28 drafts in 5 s from one address and one account, then `storage-full` |
| A different customer with a confirmed email, afterwards | upload: 503 `storage-full` |
| A visitor without an account | upload: 503 `storage-full` |
| After the automatic pressure pass | the same; the log has no relief line (nothing it may remove) |
| Admin "Clear old drafts" (`POST /api/admin/drafts/purge`, 0 hours) | `removedDrafts: 0` |
| After a restart | the same |
| At the default 64 MB | 224 drafts. One address may start 30 an hour and 120 a day: two days for one address, four hours for two addresses, one hour for eight |

The same account can be re-priced once a month to renew the 30-day hold, so "30 days" is a floor.
The result is the same with the bot check on, because a confirmed account is never asked for it:
`$R node $D/db-ceiling.js account turnstile` gave the same 28 drafts, the same `storage-full` for
everyone, `removedDrafts: 0` and the same after a restart (load 5.9).

**Root cause.**
- `server/models/quotesStore.js:43`: lines are stored once only when they are byte-for-byte equal;
  lines that differ in quantity are each stored in full (about 3 kB), so the "9 kB a quote" of the
  write-up is the best case, not the bound.
- `server/security/quoteGuards.js:83-99`: the limits count rows, not bytes.
- `server/services/rowRetention.js:102-110`: only a draft with no account is a candidate for the
  clean-up; any draft with a `userId` protects itself and its parts for the whole hold.
  `storagePressure.js:113-120` and `purgeAnonymousDrafts` (143-155) follow that list, so neither the
  pressure pass nor the admin button can touch an account's drafts.
- `server/security/uploadGuards.js:152-156` (`roomFor`): a confirmed account may write into the last
  15 %, which was meant for customers and is equally open to an attacker with a mailbox.

**Smallest fix.** Cap the stored bytes of drafts per account and per address (for example 2 MB),
checked in `saveQuote` for new rows and for re-prices; and let the pressure pass and the admin button
remove an account's drafts that are not on an order or a request, oldest and largest first, once the
database is over its line. Storing a line as its inputs plus its price (not the whole cost build-up)
would cut 3 kB to a few hundred bytes and is the lasting answer.

### RR-02. No account: the pause on visitors is cheap, re-pricing is unchecked, and the clean-up removes the wrong rows (High with the bot check off, REMAINING H3, blocks launch)

**What an attacker does.** (a) From several addresses, saves 30 quotes each of 25 different lines.
(b) Or makes small one-line drafts while the database is under its line and then re-prices each to
the maximum: re-pricing is not counted by the new-draft limit and is never checked against the
ceiling. (c) Re-prices every draft every two minutes, so none is ever "untouched for five minutes".

**Reproduce.**
`$R node $D/db-ceiling.js anon` (addresses to the pause), `$R node $D/db-ceiling.js grow` (growth by
re-pricing), `$R node $D/eviction-collateral.js` (seven minutes: who the clean-up removes).

**Measured.**

| Run | Result |
|---|---|
| `anon`, 8 MB ceiling, load 6.5 | 92 drafts from 4 addresses, 77.5 kB each, then `quotes-paused`. A visitor without an account: upload 503 `uploads-paused`. A confirmed customer: upload and quote 200 |
| the same sum at 64 MB | 736 drafts: 25 addresses in one hour, 7 over a day. The fix write-up's "1,574 quotes from 53 addresses" was at a 16 MB ceiling with 25 identical lines; its "few hundred addresses" at 64 MB becomes 25 |
| `grow`, 8 MB ceiling, one address, one account whose email was never confirmed | 30 one-line drafts = 0.27 MB; each then re-priced to 100 lines: all 30 re-prices 200; database 8.59 MB = **107 % of the ceiling**. A confirmed customer's upload: 503 `storage-full`, before and after the pressure pass |
| `eviction-collateral`, 4 MB ceiling, default ages, 6.5 minutes, load 5.5 | The flood: 46 drafts from 2 addresses, re-priced twice (92 re-prices). All of its first ten drafts still there; database still 86 %. A real visitor's quote priced before the flood: **404**. Their part: "Part not found". A confirmed customer's DXF uploaded and not yet priced (waiting for a thickness to be chosen): **"Part not found"**. The same customer's saved quote: 200 (kept, as designed). Log: "removed 1 uploaded part(s) that nothing refers to and 1 old draft quote(s)" |

So the urgent five-minute rule removes exactly the rows of people who are slower than a script, and
the visitor who lost a quote cannot make a new one (new quotes are paused for them).

With the bot check on (the stand-in), each attacking address passes the check once and the results
are the same: `db-ceiling.js anon turnstile` paused visitors with 92 drafts from 4 addresses, and
`db-ceiling.js grow turnstile` reached 107 % of the ceiling from one address. A real Turnstile makes
each address cost one solved check an hour; it does not change the sums.

**Root cause.** `server/routes/api.js:699-703`: the re-price branch updates the row with no call to
`quoteGuards` and no look at the ceiling. `server/services/storagePressure.js:84-85`: once visitors
are being refused the "untouched" age drops to 5 minutes, judged on `updatedAt` (`rowRetention.js:103`),
which any re-price renews. `storagePressure.js:97-101`: an uploaded part that is not on a quote yet is
judged by its upload time alone, whoever uploaded it.

**Smallest fix.** Treat a re-price that makes the row larger like a new row (ceiling and a byte cap
per address); limit re-prices of one quote per hour to what a person does (hundreds, not unlimited);
under pressure remove by size and by sender (the address that holds the most draft bytes first, as is
already done for parts) instead of by idle time alone; never evict the part of a signed-in customer
inside, say, an hour of its upload.

### RR-03. The request form can be closed by 3 addresses when the bot check is off (High, NEW, blocks launch unless Turnstile is on)

**What an attacker does.** Sends the request form 10 times from each of 3 addresses at the start of
an hour.

**Reproduce.** `$R node $D/site-caps.js rfq off` and `$R node $D/site-caps.js rfq on`.

**Measured.** Off: 32 requests from 3 addresses, 29 accepted after one real visitor's (30 in the
hour), then `requests-paused`. A real visitor without an account: 429 `requests-paused`,
Retry-After 1800. A signed-in account that has not confirmed its email: 429. A signed-in confirmed
customer: 201. On (stand-in): four addresses without a passing token are refused 403 and not
counted; the real visitor (who passes) and the confirmed customer both get 201.

This form is the fallback every other refusal message points to ("send us the files and we'll quote
it by hand"), so with the bot check off the attacker closes the site's last door with 30 requests an
hour. Before the fixes those 30 requests were just 30 junk requests.

**Root cause.** `server/security/botGuard.js:288-299`: one fixed-hour counter for the whole site,
counting every sender when the check is off (`rfq.js:232-239`), with nothing kept back for anyone.

**Smallest fix.** Launch with the bot check on (the cap is then inert). In the code: do not count a
sender who cannot be verified against the site-wide cap until their own address has had its first
few accepted (for example, each address's first 2 requests an hour always pass), so the cap bites on
the addresses that are flooding and not on the next real visitor.

### RR-04. One address can stop every new customer from confirming their email, and so from buying (High, NEW, blocks launch)

**What an attacker does.** Registers 10 accounts from one address (the hourly limit), typing any
addresses, then clicks "send the confirmation again" on each once a minute (5 a day per account).
60 confirmation emails in 254 seconds: the site-wide hourly cap.

**Reproduce.** `$R node $D/site-caps.js mail-one on` (one address, bot check on, 5 minutes),
`$R node $D/site-caps.js mail off` / `mail on` (six addresses, under a minute).

**Measured** (mail provider answered by the repository's stand-in):

| | One address, check on | Six addresses, check off |
|---|---|---|
| Accounts registered / resends / emails caused | 10 / 50 / 60 in 254 s | 60 / 0 / 60 in 49 s |
| A real new customer registers afterwards | 201, `verificationSent: false`, 0 emails in their inbox | the same |
| They ask for the link again | 200, `sent: false` (and it uses up one of their 5 tries for the day) | the same |
| They try to check out | **403 `email-unverified`** | the same |
| Password reset for the same person | sent (not capped, as designed) | sent |
| Owner notices | 1 | 1 |

For the rest of that hour no new customer can buy. An address may register 30 accounts a day, each
good for 6 emails, so one address covers three hours a day and eight addresses cover all of it.

**Root cause.** `server/services/mailCaps.js:31` puts `verifyEmail` under the site-wide cap, and
`admit()` (66-82) drops the message when the cap is reached; nothing is queued for later.
`server/routes/auth.js:90-91, 403-412`: "send it again" is limited per account only, with no limit
per address and no bot check. `server/routes/orders.js:27-33`: checkout needs the confirmed address.

**Smallest fix.** Limit "send it again" per address as well as per account (a handful an hour for
the address), and keep the first confirmation email of a registration that passed the bot check out
of the site-wide cap, or hold capped confirmation emails and send them when the hour turns instead of
dropping them.

### RR-05. Reorder still freezes the server (High, REMAINING C2, blocks launch)

The fix write-up lists this as open, "Medium, signed-in customers only". I confirm it is not covered
by the pricing gate or the memo, and measured it as asked.

**What an attacker does.** One account with a confirmed email uploads the 148 kB perforated DXF
(4,900 holes), prices 100 lines of it (176 ms through the pricing route; the gate leaves checkout
open), starts checkout and abandons the payment page. The order exists as `pending_payment`; no
money moves. Then `POST /api/orders/:id/reorder`, as often as the general limiter allows (200 per
15 minutes).

**Reproduce.** `$R node $D/reorder-block.js`

**Measured** (one run, three sequential reorders then four at once; load 7.3 to 9.2):

| | Result |
|---|---|
| One reorder | 10.8 s, 15.3 s, 12.6 s; each answered 201 |
| Health check, quiet | median 5 ms, worst 11 ms |
| Health check during the sequential reorders | **median 11,649 ms, worst 15,262 ms** |
| Four reorders at once, same account and address | all four accepted (201); 42.3 s in all; health median 41,192 ms |

Nothing is turned away, and the new-draft limit does not help: `saveQuote` prices first and asks
whether a row may be created afterwards (`api.js:677` then `709`), and when that refusal comes the
route prices the whole thing a second time with the standard lead time (`orders.js:514-518`).

**Root cause.** `server/routes/orders.js:486-534`: no `pricingGate.admit()`, no `pricingMemo.run()`;
`orders.js:492` also loads every line's part from its file before pricing starts; `ownedOrder`
(457-462) accepts an order in any state, paid or not.

**Smallest fix.** The two wrappers the fix write-up names (gate as middleware, `await
pricingMemo.run(...)` around the call), and refuse reorder for an order that was never paid.

### RR-13. Pricing still holds the thread when the lines are different parts (High, REMAINING C2, blocks launch)

The memo removes the cost of the *same* part repeated. A quote of 25 *different* dense parts still
has 25 parts to load, check and price, in pieces of tens of milliseconds each, and when several
addresses price at once their pieces run back to back before the server looks at any other request.

**What an attacker does.** Uploads a 90 kB DXF with 3,000 holes 25 times (a part id works from any
address). Then from each attacking address prices one 25-line quote over and over. No account. Every
request is inside the rate limits and every one is answered 200.

**Reproduce.** `$R node $D/pricing-eight.js` (about four minutes).

**Measured** (one server, 25 s per phase, load 6.3 to 7.1; a second run with eight addresses for 40 s
gave a health median of 4,452 ms and worst 8,430 ms at load 8.6):

| Attacking addresses | Health median | Health worst | An innocent visitor re-pricing a one-line cube, median |
|---|---|---|---|
| none | 5 ms | 79 ms | n/a |
| 1 | 93 ms | 1,255 ms | 166 ms |
| 2 | 494 ms | 1,152 ms | 527 ms |
| 4 | 1,106 ms | 3,162 ms | 1,340 ms |
| 8 | 3,065 ms | 6,133 ms | 2,995 ms |

One such quote alone takes 1.3 to 1.5 s here. The reviewer script that the fix was measured with
(`availability.js mainthread`) repeats one part on every line, which the memo makes free; that is why
it reports a median of 2 to 3 ms.

**Root cause.** `server/services/pricingMemo.js:73-89`: a pass may not be interrupted until it has
computed at least one new value, and one value (loading a part: reading and parsing a 1 MB
measurements file; one DFM run; one price) is an indivisible piece of main-thread work.
`pricingMemo.js:225-228`: the yield is `setImmediate`, and Node runs every pending immediate before
it polls for network traffic again, so with eight requests in flight (`pricingGate`, 8 site-wide)
eight pieces run in a row. The budget (3 s of work per request) limits one request, not the site.

**Smallest fix.** Admit one pricing at a time site-wide for visitors without an account (the others
wait their few seconds as they do now) and yield with a real turn of the loop (`setTimeout(0)` or
`setImmediate` after an I/O poll) so the queue is one piece long, not eight; charge pricing time per
address per hour the way parsing time is charged. The lasting answer is pricing in a worker thread.

### RR-10. A DXF's units can be switched after pricing: the stored price is charged for a part 25 times larger (High, PRE-EXISTING, blocks launch)

**What an attacker does.** Uploads a 20 x 15 outline with two holes. Says "millimetres" and prices 10
pieces in 25.4 mm phenolic: $149.25, checkout open. Says "inches" (`POST /api/parts/:id/units`): the
stored part is now 508 x 381 mm. Checks out the stored quote.

**Reproduce.** `$R node $D/geometry-price.js units`

**Measured.** The honest price of the inch-sized plate, same material and quantity: **$3,376.62**
with checkout open. Priced as millimetres: $149.25. After the switch the stored quote still says
$149.25; `POST /api/orders/checkout-session` answers 200 and creates the order at **$149.25**; the
part on that order now measures 508 x 381 mm; a further units change is refused 409 (locked once
ordered), so the shop's traveler shows the large part. Underpriced by $3,227.37. The example file even
declares millimetres in its header; the route lets any DXF be switched.

`assertSaneGeometry` runs where a price is computed (`api.js:567`), and I confirm that covers
`POST /api/quote` and reorder (both go through `priceQuote`); checkout computes no price and checks
nothing about the part.

**Root cause.** `server/security/index.js:54-62` (`partEditGate`) locks a part's units only once it
is on an order or a request, not once it is on a saved quote. `server/routes/api.js:470` replaces the
geometry without touching the quotes that priced it. `server/routes/orders.js:61-241` charges
`quote.orderTotal` as stored.

**Smallest fix.** When a part's units change, mark every draft quote that names it as needing a
re-price (or delete their prices) so checkout refuses with "reopen the quote to get today's price";
or refuse the units change while a priced quote names the part.

### RR-08. The file ceiling can still be filled, and what fills it is never evicted (High, REMAINING H4, blocks launch)

**What an attacker does.** From each address uploads ordinary models up to the per-address storage
cap, puts them on one quote and sends one request for that quote (or, signed in, simply saves the
quote). Files on an open request are never evicted; files on an account's saved quote are kept for
its 30-day hold.

**Reproduce.** `$R node $D/storage-pin.js pin` and, for comparison, `$R node $D/storage-pin.js
control` (the same uploads with no request). Both are scaled 1:10 (200 MB ceiling, 40 MB per address)
and use a 1-minute eviction age so they finish in minutes.

**Measured** (bot check off, load 6.1 to 6.7):

| | `pin` | `control` (no requests) |
|---|---|---|
| Addresses to pause visitors without an account | 5 (at 84 %) | 5 |
| With one confirmed account, to refuse everyone | 6 (at 97 %) | 8 |
| Right after | visitor `uploads-paused`; a confirmed customer's 3.8 MB model `storage-full` | both `storage-full` |
| After the pressure pass | **nothing removed**; both still refused | 24 uploads removed, back to 71 %, both accepted |
| After the owner deletes the 6 requests by hand | back to 71 %; both accepted. The account's own parts stay | n/a |

At the defaults (2,048 MB, 400 MB stored and 500 MB a day per address) that is five addresses and
about 2 GB of uploads. Requests cost nothing; with the bot check off they also come under RR-03's
cap of 30 an hour, which six do not reach.

**Root cause.** `server/services/rowRetention.js:84-87` (parts on an open request are protected) and
`109` (parts on any quote that is not a no-account draft are protected), read by
`storagePressure.js:186-190`. Nothing limits how many bytes one sender may protect this way, and an
order that is never paid protects its parts for ever in the same way (`rowRetention.js:79-82`).

**Smallest fix.** Count protected bytes per address and per account (the 400 MB cap exists; it needs
a much smaller sibling for bytes held by unpaid, unanswered things), and expire `pending_payment`
orders that were never paid after a day.

### RR-11. A full database makes the protection itself the stall (Medium, NEW for the pass, REMAINING for the save)

This is also my answer to "the unexplained stall".

**In the pricing storm of the fix write-up the database save is innocent.** `$R node
$D/stall-probe.js storm` loads a timing probe into the server (`probe-preload.js`). Four runs, load
4.9 to 7.7: health median 2 ms every time; worst 473, 839, 473 and 365 ms; about 4 % of samples
over 100 ms (33 of 826 in the run I counted exactly). The
database was 0.2 MB and its saves took 0 to 1 ms. What the probe did time under those samples:
garbage collection (13 pauses over 20 ms in one run, worst 56 ms; one of 188 ms in another), the
parse of the dense part's 1.4 MB measurements file on every request (18 times, median 28 ms, worst
56 ms), and building the answer (20 to 30 ms). The rest is the process waiting for a CPU on a
machine with 2 cores and a load of 5 to 8. The single 472 ms and 1,212 ms samples of the write-up
are consistent with that: several of those pieces in a row plus a major collection, on a busy
machine. I could not make a quiet machine to confirm the last part.

**Where the save does matter: a large database, which an attacker controls (RR-01, RR-02).**
`$R node $D/stall-probe.js sizes` (load 5.8 to 6.8; five saves at each size):

| Database | Export | Write | One save | A one-line quote request | Health worst | Server memory |
|---|---|---|---|---|---|---|
| 1.3 MB | 1 ms | 0 ms | 2 ms | 28 ms | 50 ms | 198 MB |
| 8.1 MB | 11 ms | 6 ms | 13 ms | 53 ms | 54 ms | 265 MB |
| 16.2 MB | 15 ms | 14 ms | 29 ms | 80 ms | 78 ms | 277 MB |
| 32 MB | 32 ms | 24 ms | 54 ms | 180 ms | 304 ms | 327 MB |
| 48.1 MB | 37 ms | 46 ms | 83 ms | 198 ms | 281 ms | 468 MB |
| 60.2 MB | 67 ms | 78 ms | 155 ms | 315 ms | 361 ms | 487 MB |

`$R node $D/stall-probe.js held` (database held at 54.2 MB, two runs, load 6.0 to 7.0):
- One address re-pricing one one-line quote three times a second, well inside every limit, causes a
  full save every 1.5 s: 16 saves in 30 s of 127 and 184 ms each (median), 7 % and 12 % of the
  thread; 16 and 17 health samples over 100 ms; worst 382 and 1,349 ms.
- **One small upload while the database is above 80 %: the server stops for 2.1 to 3.0 s** (three
  uploads, 22 s apart: health worst 3,032, 2,149 and 2,188 ms; the loop held 2,160 to 2,376 ms). The
  upload adds a row, which sets off the pressure pass, which reads and parses every quote row to
  decide what may go, finds nothing (the rows are a signed-in account's), and so does it again at
  the next row, at most every 20 seconds, and on its five-minute timer.
- Server memory 598 and 716 MB with a 54 MB database. The 1 GB budget keeps 512 MB for parsing.

**Root cause.** `server/models/database.js:392-411` (every save exports and rewrites the whole file
on the one thread). `server/services/storagePressure.js:73-137` with `rowRetention.js:67-116`
(`references()` loads every row, and is called on every pass whether or not anything can go);
`api.js:409, 716` and `uploadGuards.js:318` call `nudge()` on every insert and every refused upload.

**Smallest fix.** Set `DB_MAX_MB` to 16 until the database is replaced (saves stay under 30 ms and
the pass is a quarter of the work). In the code: when a pass removes nothing, do not run another for
several minutes; and have the pass read ids, dates and sizes with one SQL query instead of parsing
every row.

### RR-07. Two customers, one refused: the "run it again alone" rule at the default memory budget (Medium, REMAINING L4 and M4)

**What I tried as an attacker.** One address uploads a 3MF that is small on disk (1.25 MB) and needs
hundreds of MB to read, while a customer uploads the repository's 1.95 MB STEP plate. The watchdog
stops "the largest file" when memory is over its line, so the first time it is the *customer's* parse
that is stopped and run again alone: 42 s instead of 24 s. The attacker's file then runs out of its
own time (17 s), the address is marked, and in rounds 2 and 3 the customer was not disturbed (33 s,
31 s). Three rounds, customer served every time. Two hungry files from two addresses closed the pool
to everyone else for about 24 s: 20 customers with a cube, the longest wait 21 s, none refused. So an
attacker gets a delay per fresh address, not a lockout. (`$R node $D/parse-pool.js steal`,
`... solo`; load 5 to 7.6.)

**What did go wrong, without any attacker.** The reviewer's `availability.js queue` (twelve hostile
DXFs, refused in under a second, then three customers with the 2 MB STEP at once), four runs:

| Run | Load | Customer 1 | Customer 2 | Customer 3 |
|---|---|---|---|---|
| 1 (while another of my scripts was running) | 6.0 to 9.4 | `parse-timeout` 49.6 s | `parse-timeout` 49.6 s | `busy` 30.1 s |
| 2 | 3.8 | **`parse-memory`** 41.1 s | parsed 24.3 s | `busy` 30.1 s |
| 3 | 4.8 | parsed 62.8 s | parsed 38.8 s | `busy` 30.1 s |
| 4 | 6.9 | **`parse-memory`** 56.9 s | parsed 37.5 s | `busy` 30.1 s |

The fix write-up reports 3 of 3 served when quiet and 2 of 3 when loaded. I never saw 3 of 3, and in
two of four runs a customer was told their model "needs more memory than the instant quote allows"
after being stopped once and run again alone. A customer refused that way is also marked for an hour
(kept off the last free worker). I have run this only on the loaded machine; the timeouts in run 1
are the load, the `parse-memory` refusals are not a timing effect in themselves but may be helped by
it (memory of a stopped worker not yet returned when the second attempt is measured; in the `solo`
run the log shows a customer's 684-byte cube stopped "to run it again on its own" at 562 MB added,
straight after the two hungry parses had ended).

`$R node $D/parse-pool.js pair` isolates it: **two customers and no attacker**, each uploading the
same 1.95 MB STEP at the same moment, three rounds. Round 1 (load 8.6): one parsed in 43.4 s, the
other was stopped ("534 MB ... to run it again on its own"), run again alone, stopped again at
514 MB and **refused `parse-memory` after 64.7 s**. Rounds 2 and 3 (load 7.8 and 7.0): both parsed
(38 s and 29 s). So 1 customer of 6 refused in that script, 2 of 12 in the reviewer's, none in the
fix write-up's runs: it happens, not every time, and I cannot say how often on a quiet machine.

**Root cause.** `server/parsers/parsePool.js:455-461`: the watchdog measures growth of the whole
process since the first parse of a busy period started, so memory that a just-stopped worker has not
yet given back, and anything the main thread has allocated since, is charged to whichever parse is
running; `484-494`: a parse stopped while alone is refused and its client marked.

**Smallest fix.** Before judging a parse that runs alone, wait until the stopped worker's memory has
actually gone (re-take the baseline when a solo run starts), and do not mark a client as suspect for
a stop that followed a re-run. Set `MEMORY_BUDGET_MB` to the real figure: at 2 GB two of these files
fit.

### RR-09. Measurements that are finite but wrong still price (Medium, REMAINING H1 class)

**Reproduce.** `$R node $D/geometry-price.js volume` and `... small`.

**Measured** (100 mm cube family; "print" is FDM, "cnc" is milling; first listed material each):

| Model | Counted volume / box | Print, each | CNC, each |
|---|---|---|---|
| Honest 100 mm cube | 1.00 | $153.42, checkout open | $291.90, checkout open |
| Cube plus its inside-out copy (the first review's case) | 0 | refused at upload | refused |
| Cube plus an inside-out cube 0.002 mm smaller (walls of one micrometre) | 0.0001 | **$100.10, checkout open** | $678.91, sent to a person |
| Cube with five cubes nested inside, all facing out | **5.16** | $423.34, checkout open | $465.18, checkout open |
| Thin frame, 4 mm bars in a 100 x 100 x 50 box (honest) | 0.008 | $20.11, checkout open | $414.94, **sent to a person** (`complex-geometry`) |
| The same frame with 60 closed shells hidden inside one bar | 0.186 | $105.86 | **$382.71, checkout open** |
| 100 x 100 x 0.011 mm sheet (11 micrometres thick) | 1.00 | **$19.59, checkout open** | $201.80, sent to a person |

So: the rule "volume not less than a millionth of the box" stops exact cancellation but not near
cancellation; there is no upper bound (a counted volume five times the bounding box is accepted);
and counting hidden shells moves a part across the line that decides whether a person looks at it.
The money at stake here is small (the frame's price moved from $415 to $383); what is lost is the
"send to a person" gate. NaN and Infinity, the 10^30 and 10^-30 cubes, a 0.99 mm cube, a 0.009 mm
sheet and a 1,000 mm sheet 0.011 mm thick are all refused or sent to a person, as claimed.

**Root cause.** `server/parsers/saneGeometry.js:105-107`: one lower bound on volume, nothing else
relating volume, area and box.

**Smallest fix.** Refuse a 3D model whose counted volume exceeds its bounding box (plus rounding),
and send to a person any mesh with more than one closed shell inside another or a wall under the
process minimum (the DFM rules already know the minimum; the gate does not use it for printing).

### RR-06. `lingerThenClose`: the limits hold; two side effects (Low, NEW)

**Reproduce.** `$R node $D/linger.js hold | many | pipeline | free`

**Measured.**
- `hold`: a refused 600 MB upload, four ways of stalling (headers then nothing; 1 byte every 500 ms;
  1 byte every 50 ms; 1 MB every 100 ms). The server finished its half in 5 to 26 ms and closed its
  side of the socket after **5,026 to 5,059 ms** every time. The 5 s limit holds; the 64 MB limit
  closed fast senders in 0.3 to 0.8 s.
- `many`: 400 refused uploads held open at once from 400 addresses, each dripping a byte a second:
  all answered 413, all closed; server memory 129 to 158 MB, open files 22 to 424; health median 2 ms
  (worst 1,261 ms, one sample, at the instant 400 connections opened). An attacker gains nothing over
  holding 400 idle connections, which Node allows anyway.
- `free`: with a 20 MB daily budget, four refused uploads sent 445 MB in all, of which the server
  read and discarded up to 64 MB each; the budget was untouched and a real upload from the same
  address then passed. The write-up says bytes are "counted where they arrive, on every outcome";
  bytes of an upload refused at the door are not. One address may do this 50 times in 15 minutes
  (3.2 GB read and thrown away).
- `pipeline`: after a refused request whose whole body arrives, a second request sent on the same
  connection (`POST /api/quote`) is **executed** (a draft quote was created: 0 before, 1 after) and
  never answered. It passes the ordinary limits, so nothing is bypassed; it is work done for a
  client that cannot be told the result.

Keep-alive: the answer carries `Connection: close`, and no later request on that connection is
answered. Body-size limits: unaffected (the refusal comes first).

**Root cause.** `server/security/uploadGuards.js:299-305` refuses before anything is charged and
`271-291` then reads the rest; the HTTP parser keeps reading requests off a socket whose answer said
close, because `destroySoon` was replaced by a half-close.

**Smallest fix.** Charge the discarded bytes to the sender's daily budget as they arrive (the meter
already exists a few lines below), and pause the socket's parser, or destroy the socket, when the
refused request's own body has ended.

### RR-12. The start-up key check goes quiet too early (Low, NEW)

**Reproduce.** `$R node $D/encryption.js` (keys are random, made at run time, never printed).

**Measured.** With a key set: no plain file in any folder; no vertex list or DXF outline in the
database file. No key: the ERROR is printed ("8 of the 8 newest encrypted files ... (which is not
set)"), every old part answers 409 `part-data-unavailable` (none is priced from the partial row),
previews 409, nothing deleted, new uploads stored plain as the warning says. Wrong key: the same,
"8 of the 10". Rotated with the old key listed as previous: no error, all three parts price to the
cent as before, previews 200. A short key: the server refuses to start. All of that is as claimed.

The gap: with the wrong key still in place, after 30 ordinary new uploads and a restart the ERROR is
**no longer printed**, while both old parts still answer `part-data-unavailable`.

**Root cause.** `server/services/fileCrypto.js:323-338`: the check opens the 25 newest `.enc` files
of each folder; a part writes two or three files, so about 13 new uploads push every old file out of
the sample.

**Smallest fix.** Sample the oldest files as well as the newest (or count the key ids in the file
headers of all of them: it is four bytes each).

### RR-14. Reorder keeps one configuration per part (Low, PRE-EXISTING)

**Reproduce.** `$R node $D/memo-check.js` (see `rows.reorderOfOnePartInTwoThicknesses`).

**Measured.** One part ordered on two lines, in two thicknesses: $111.83 and $121.71 each, total
$246.82. Reorder of that order: both lines at $121.71, total $257.82.

**Root cause.** `server/routes/orders.js:196`: the buyer's inputs are kept in a map keyed by part id,
so the last line of a part overwrites the others; reorder (`orders.js:499`) then lays that one input
over every line of the part.

**Smallest fix.** Keep the input by line position, not by part id.

### RR-15. Accuracy of the write-up and of the tests (Info)

1. "1,574 quotes from 53 addresses to reach 85 %" is at a 16 MB ceiling with 25 identical lines per
   quote (9 kB each). The adapted `availability.js db` kept the script's identical lines, which the
   new storage format happens to make almost free; with lines that differ a draft is 78 kB (RR-01,
   RR-02). The adaptation is fair in form; the number drawn from it is the best case.
2. "The pressure pass runs ... at once when a request is refused": a refused *upload* sets it off
   (`uploadGuards.js:318`); a refused new *quote* does not (`api.js:709` throws before `716`). My
   first eviction run, which knocked with quotes, saw no pass in 6.5 minutes.
3. `server/routes/botCheck.test.js:30` reads the repository's real `data/rfq-drawings` while the
   harness writes to a throwaway folder. On a fresh checkout the suite fails (`ENOENT`); where the
   folder exists, the assertion "the attachment is deleted" looks at a folder the server is not
   using. The same line is on `hardening-2026-11-11`. A suite run also leaves `data/quoting.db` in the
   worktree (ignored by git).
4. `tools/security/review/` does not exist on this branch (only `review-uploads/`,
   `availability-fixes/` and `csp-browser-check.js`), so there were no scripts there to run.
5. The 10 s limit for a DXF: the 4,900-hole sheet failed with `parse-timeout` on its first upload in
   two of my scripts at load 7 (it took 9.2 s once when it passed). The write-up lists this as open;
   I agree, and on a busy 2-core container it will happen to real customers with dense drawings.

No file, page or tool output I read contained text that tried to instruct me.

## 5. Claims I checked and they hold

One row per line of the fix write-up's summary table. "Holds" means my own measurement agrees, for
the case stated; where a finding above limits the claim it is named.

| Claim | My measurement | Verdict |
|---|---|---|
| C1 reopening a quote no longer builds a huge answer | `availability.js session 12 1`: answer under 0.1 MB, 25 ms, memory 322 to 323 MB, health worst 19 ms. `preview-access.js`: previews come by URL | Holds |
| C2 fixed for `POST /api/quote` | `availability.js mainthread` (one part on every line): 359 requests, none priced, 240 rate-limited, health median 3 ms, worst 36 ms. Memo against no memo on the same lines: identical prices (`memo-check.js`) | Holds for one part repeated; **not** for different parts (RR-13) and not for reorder (RR-05) |
| H1 NaN, Infinity, absurd sizes refused | `price-nan.js`: every variant refused at upload. `parser-abuse.js` with the write-up's filter (14 rows here): 13 refused in under 1 s (3.1 s for the 1,000,000-parenthesis STEP), 1 parsed and sent to a person (the DXF with NaN bulges, as the write-up says). `geometry-price.js small`: boundaries as stated | Holds; near-cancelling and over-counted volumes are RR-09 |
| H2 the parse pool is no longer cheap to occupy | `availability.js pool`: 20 hostile DXFs refused in 1 s. `parse-pool.js solo`: 20 customers, longest wait 21 s, none refused. `steal`: customer served 3 of 3 | Holds against an attacker; see RR-07 for two customers at the default memory budget |
| H3 draft quotes no longer fill the database | `availability.js db` reproduces the write-up's numbers exactly (1,574 quotes, 53 addresses, 9,065 bytes each, re-price 200) | Holds only for identical lines: RR-01, RR-02 |
| H4 the file ceiling | Padded files refused (`file-padded`, 0.9 s for 49 MB); `storage-pin.js control`: uploads nothing refers to are cleared by the pass (24 removed, 100 % to 71 %) | Holds for files nothing refers to: RR-08 |
| H5 files kept while the quote can be ordered | `retention-encryption.js retention`: 5 PASS, 0 FINDING: order and request on day 8 have their files; closed request's drawing removed after its 14 days; orphan after a crash removed | Holds |
| M1 the human token is bound to its client | `preview-access.js on`: a token earned at one address is refused (403) for upload, pricing, quote session and preview from another; the next /64 is refused; no token: 403 | Holds |
| M2 requests from many addresses are capped | `abuse-limits.js off`: 10 + 2 + 10 + 8 = 30, then refused | Holds; the cap is RR-03 |
| M3 email to typed addresses is capped | `site-caps.js mail`: 60 sent, then held; owner told once; password reset still sent | Holds; the cap is RR-04 |
| M4 memory defaults | Start-up line: "Memory budget: 1024 MB ... 384 MB heap each, 512 MB for parsing in all; database ceiling 64 MB" | Holds as arithmetic; at that budget see RR-07 and RR-11 (716 MB with a 54 MB database) |
| M5 encryption coverage | `encryption.js`: with a key no plain file and no shape data in the database; fails closed with no key and a wrong key; rotation with the previous key prices to the cent | Holds; the warning is RR-12 |
| L1 bytes counted on every outcome | `availability.js budget`: 2 stored, 4 refused, with and without a length; `refused`: over-size chunked files cut off at the budget | Holds for accepted and cut-off bodies; not for uploads refused at the door (RR-06) |
| L2 leftovers after a crash | `retention-encryption.js`: orphan upload gone at the next start | Holds |
| L3 microscopic parts | 10^-30 cube `geometry-too-small`; 0.99 mm cube refused; 1 mm cube priced (by design) | Holds |
| L4 the watchdog stops the likeliest culprit and re-runs once | `parse-pool.js steal`: observed exactly as described | Holds; RR-07 for the refusal after the re-run |
| L5 counters forgotten at a restart (accepted) | `availability.js keys`: limiter answers 200 after a restart | As stated |
| L6 a small DXF leaves a 6 kB row | `claims.js`: 100 DXFs add 604 kB, 6.0 kB each | Holds |
| I1 file names as UTF-8 | Not measured by me beyond the suite (`siteCaps.test.js` passes) | Suite only |
| I2 an address with a port is one client | `availability.js keys`: five ports, three accepted then 429 at a limit of 3 | Holds |
| I3 the STEP timer that could not fire is gone | A 1.95 MB STEP is stopped at 49.6 s (30 s + 10 s per MB), by the pool | Holds |
| "Nothing changes a price" (300-quote vetting run) | `vetting-compare.js`: the harness run against the server of `hardening-2026-11-11` (e4881d3, taken from git into a throwaway folder) and against this branch: 300 quotes each, 0 fails and 63 warnings each, **0 of 300 rows differ** (quote-id column ignored) | Holds |
| Schema migration is additive | `migration.js`: a database made by master's own server (commit 255753c, taken from git, started in a throwaway folder; not the committed fixture): no table or column lost, 7 columns of this branch added, every master row still there, old quote reads the same, same parts price the same to the cent ($892.9166 then, $892.91 now; totals are whole cents since the hardening branch), dense part's preview served after its move to a file | Holds |
| Migration is idempotent | Second start: every table identical, **database file byte-identical** (same SHA-256), no error in the log | Holds |
| Quote ids are made by the server and unpredictable | Version-4 UUIDs from `crypto.randomUUID` (`SqliteDB.js:338`); a client-chosen id is ignored for a new quote | Holds |
| Nobody reads another visitor's part | 13 attempts (id alone, another part's key, a random key, guest against customer and the reverse, customer against customer, re-pricing another account's quote): all refused, bot check on and off | Holds. By design, a quote made without an account is opened by its id alone and that answer carries its part keys |
| The pricing memo cannot leak or go stale | It is made per request (`pricingMemo.js:200`, inside `run`) and dropped; 20 concurrent pairs from two visitors: 0 wrong prices; quantity, thickness, material and lead time each change the answer; an owner's price change is used by the very next pricing; it cannot grow between requests because nothing is kept | Holds |
| `lingerThenClose` closes after at most 5 s and 64 MB | 5,026 to 5,059 ms in four stalling patterns; 400 at once all closed | Holds; RR-06 for the side effects |

## 6. Could not verify

- **A quiet machine.** Every timing here was taken at a load average of 3 to 9 on 2 cores. Ratios
  (5 ms to 3 s, 2 ms to 155 ms) are sound; absolute figures would be lower on an idle machine, and
  the load-sensitive results (RR-07's refusals, the storm's tail) need one more run there.
- **Railway.** The memory limit and whether a 716 MB server plus a parse is killed at 1 GB (I measured
  memory; there is no limit here to hit); what the edge does with `X-Forwarded-For`, with a body sent
  without a length, with an answer sent while the body is still arriving (`lingerThenClose` may never
  see the client's bytes behind a buffering proxy), and with a second request on a connection.
- **Node 20.** Only Node 22 is installed. Things that could differ: how the HTTP server ends a
  `Connection: close` answer (the linger depends on `socket.destroySoon` being called there), worker
  `resourceLimits` behaviour at the heap ceiling, garbage-collection pauses, and `setImmediate`
  ordering under load. I saw nothing in the diff that needs a newer Node than 20.
- **Cloudflare Turnstile itself, Stripe, the mail provider.** All three were the repository's local
  stand-ins. "Bot check on" in this report means the stand-in, which passes any token beginning
  "pass"; the cost to an attacker of a real passed check is not measured.
- **RR-01 at the full 64 MB over real hours.** Run at 8 MB (28 drafts, 5 s). The 64 MB figure (224
  drafts) is the measured bytes per draft divided into the ceiling; `stall-probe.js sizes` did fill
  60 MB with the same drafts, with the hourly limits lifted.
- **The new-request notice cap (40 an hour).** Read, not run.
- **The browser suites** (`scripts/e2e/hardening-accounts.mjs`, `tools/security/csp-browser-check.js`).
  Not run: nothing I changed or measured touches the pages, and I spent the time on the server.
- **The many-day behaviours** (48-hour lapse of a no-account draft, 30-day hold, 14-day attachment
  rule) beyond what `retention-encryption.js` ages by hand.

## 7. Tests and reviewer scripts

| What | Result | Load average |
|---|---|---|
| `npm test`, fresh worktree, before `npm run build` | 45 of 48 suites. Failed: `headers.test.js` (2 tests, need the built client), `botCheck.test.js` (1 test, RR-15 point 3), `uploads.test.js` (the timing test: slowest health check 337 ms against a 250 ms threshold) | 3.3 at the start, 5.8 at the end |
| The three failing suites again, after `NODE_ENV=production npm run build` (22 of 22 routes) | `headers.test.js`: 0 failures, three runs of three. `botCheck.test.js`: the same 1 failure, three of three (not load: the folder is missing; with it missing the other 20 tests pass). `uploads.test.js`: the same one timing test failed in all three further runs (336, 345 and 358 ms against 250 ms; the other 18 tests pass). That is four failures of four, all at a load of 3.3 or more on 2 cores. The fix write-up says it passes on a quiet machine and fails loaded; I had no quiet machine, so I report it as failing under load and do not call it a regression | 5.0 to 7.7 |
| `node scripts/claims-check.js` | exit 0 | 5.6 |
| Reviewer scripts in `tools/security/review-uploads/`: the commands of section 11 of the fix write-up | All ran except `availability-fixes/measure-pricing.js` as such (my `stall-probe.js storm` is the same storm with a probe attached: 64 to 80 priced, 687 to 765 told to retry, health median 2 ms). Behaviour as the fix write-up states, except `availability.js queue` (RR-07). `availability.js storage` at a 200 MB ceiling answered the 490 MB request `storage-full` at the door (0 MB stored, the customer afterwards served) where the write-up reports `file-padded`: the same outcome by an earlier refusal | 3.8 to 9.4 |
| The three scripts edited by the fix workstream | `abuse-limits.js`: each address now passes its own bot check, because a token is bound to its address; the "token used elsewhere" line is kept. Fair. `availability.js db`: goes on with 25 lines when 100 are refused and reports what a visitor meets; fair, but see RR-15 point 1. `retention-encryption.js`: ages the request's row as well as its file (the rule now counts from the row), and watches the orphan by name with a STEP in place of the DXF that is now refused instantly; no check was turned from a finding into a pass by the edit. Fair | n/a |

The 300-quote vetting comparison (`vetting-compare.js`, load 5.8): base branch 300 quotes, this
branch 300 quotes, 0 rows differ. (The committed `tools/vet-quotes/results.csv` is older than both
branches, with totals not yet in whole cents; it is not a usable baseline, which is why the script
makes its own from the base branch.)

## 8. The scripts

All under `tools/security/rereview-availability/`. Each starts the real server on a throwaway data
folder with throwaway secrets, stops it, and prints one JSON line that ends with the load average.
The first line of each file says what a passing fix would look like.

| Script | Finding | Run time |
|---|---|---|
| `db-ceiling.js size \| account \| grow \| anon [turnstile]` | RR-01, RR-02 | 1 to 2 min each |
| `eviction-collateral.js` | RR-02 | 7 min |
| `site-caps.js rfq off\|on`, `mail off\|on`, `mail-one off\|on` | RR-03, RR-04 | 1 min; `mail-one` 5 min |
| `reorder-block.js` | RR-05 | 2 min |
| `pricing-eight.js` | RR-13 | 4 min |
| `geometry-price.js units \| volume \| small` | RR-10, RR-09 | under 1 min each |
| `storage-pin.js pin \| control` | RR-08 | 5 min each |
| `stall-probe.js sizes \| storm \| held` (with `probe-preload.js`) | RR-11 | 2 to 4 min each |
| `parse-pool.js steal \| solo \| pair` | RR-07 | 2 to 5 min each |
| `linger.js hold \| many \| pipeline \| free` | RR-06 | under 1 min each |
| `encryption.js` | RR-12 and the encryption checks | 1 min |
| `memo-check.js` | RR-14 and the memo checks | 1 min |
| `preview-access.js off\|on` | access checks (no finding) | under 1 min |
| `migration.js` | migration checks (no finding) | 1 min |
| `vetting-compare.js` | the 300-quote comparison | several minutes |
| `common.js` | shared helpers | n/a |
